import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { hojeUtc } from '../../components/utc.util';
import { PrismaService } from '../../database/prisma.service';
import { D2lEnrollmentsService } from '../../d2l/service/d2l-enrollments.service';
import {
  EventoAgendamento,
  MotivoExcecao,
  StatusAgendamento,
  StatusExecucao,
} from '../../generated/prisma/client';
import { PeriodoService } from '../../periodo/service/periodo.service';
import { AuditoriaService } from '../../seguranca/service/auditoria.service';
import type { DisciplinaAgendavel } from '../../turma/service/turma.service';
import { ocuparVagaSimulada, ordenarPorProximidade } from './alocacao';
import { montarCsv } from './csv-relatorio';
import { DisciplinasDoAlunoService } from './disciplinas-do-aluno.service';
import { AUTOR_ADMIN, descreverOferta, registrarHistorico } from './historico';
import {
  CONFIRMADO,
  escolherOfertaComLock,
  exigirUmaProvaPorFaixa,
  OPCOES_DA_TRANSACAO,
  travarAluno,
} from './lock-de-vagas';

/**
 * Quantas identidades/disciplinas se resolvem ao mesmo tempo na fase 1.
 *
 * O gargalo e rede: cada aluno custa ~1,5s de Valence (achar o UserId, ler as
 * matriculas) e ~5ms de banco. Sequencial, 7 mil alunos levariam ~3h. Seis em
 * paralelo derrubam para ~25 min sem transformar o lote num teste de carga
 * contra o Brightspace — a API e compartilhada com o AVA em uso.
 */
const CONCORRENCIA = 6;

/**
 * Silencio maior que isto significa lote MORTO, nao lote lento.
 *
 * `atualizadoEm` e batido a cada aluno (~1,5s). Cinco minutos parado so
 * acontece se o processo caiu — e sem esta regra um restart deixaria a execucao
 * `EM_ANDAMENTO` para sempre, bloqueando todo lote seguinte com "ja existe um
 * em andamento" e sem ninguem conseguindo destravar pela tela.
 */
const SILENCIO_ATE_MORRER_MS = 5 * 60_000;

/**
 * O que a Valence sabe sobre a PESSOA — identidade e disciplinas.
 *
 * Separado de `Candidato` porque a Valence responde por matricula, nao por
 * vinculo: quem tem dois cursos e uma pessoa so no Brightspace, com uma lista
 * de disciplinas so. Ver "Turma NAO pertence a um curso" no CLAUDE.md.
 */
interface Pessoa {
  userIdD2L: string;
  disciplinas: DisciplinaAgendavel[];
  /** Conta desativada no LMS: aloca, mas nao conseguiria abrir a prova. */
  contaInativa: boolean;
}

/** Um vinculo pronto para entrar na fila de alocacao. */
interface Candidato extends Pessoa {
  vinculoId: number;
  matricula: string;
  curso: string;
  poloId: number;
  modalidadeId: number;
}

/** Uma linha do relatorio de quem NAO entrou (ou entrou com ressalva). */
interface Excecao {
  alunoId: number;
  matricula: string;
  motivo: MotivoExcecao;
  detalhe?: string;
}

/** O motivo antes de saber de qual vinculo ele e — ver `resolverUm`. */
type MotivoDaPessoa = Pick<Excecao, 'motivo' | 'detalhe'>;

/**
 * ============================================================================
 * AGENDAMENTO COMPULSORIO — a secretaria agenda por quem nao agendou
 * ============================================================================
 * Fechado o prazo, quem nao marcou prova nao fica sem prova: o lote aloca todo
 * mundo automaticamente, enchendo a sala de menor `ordem` ate lotar e os dias
 * da data mais proxima para a mais distante.
 *
 * AS DUAS FASES, e por que elas sao separadas:
 *
 *   fase 1 (rede, PARALELA) .... quem e cada aluno no Brightspace e quais
 *                                disciplinas ele tem. Custa ~1,5s por pessoa e
 *                                nao toca no banco.
 *   fase 2 (banco, SEQUENCIAL) . a alocacao propriamente dita. Custa ~5ms por
 *                                pessoa e precisa ser deterministica.
 *
 * Misturar as duas — alocar em paralelo, conforme cada chamada de rede volta —
 * faria a ordem de chegada depender da latencia da Valence. Duas execucoes com
 * os mesmos dados dariam salas diferentes, e a SIMULACAO deixaria de prever a
 * execucao. Como a fase 2 e sequencial e ordenada por (polo, modalidade,
 * matricula), o mesmo lote produz sempre o mesmo resultado.
 *
 * QUEM ENTRA (regra do cliente, 12/08/2026): vinculo `ativo` que nao tem
 * agendamento CONFIRMADO no periodo letivo. Quem cancelou e nao remarcou fica
 * de fora — e sai no relatorio como `CANCELOU_E_NAO_REMARCOU`, porque ficar sem
 * lugar nenhum e uma decisao que a secretaria precisa enxergar, aluno por aluno.
 *
 * SIMULACAO e o padrao. Ela percorre a alocacao inteira contando as vagas em
 * memoria e nao grava nada: e a unica forma honesta de responder "cabe todo
 * mundo?" antes de descobrir no meio da execucao que nao cabia.
 */
@Injectable()
export class CompulsorioService {
  private readonly logger = new Logger(CompulsorioService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly d2l: D2lEnrollmentsService,
    private readonly disciplinas: DisciplinasDoAlunoService,
    private readonly periodo: PeriodoService,
    private readonly auditoria: AuditoriaService,
  ) {}

  /**
   * Dispara o lote e volta na hora com o id — quem acompanha e o `consultar`.
   *
   * Nao espera o fim de proposito: sao dezenas de minutos, e nenhum navegador
   * ou proxy segura a conexao aberta tanto tempo. O `void` na chamada e
   * deliberado, e o `catch` dentro de `executar` e o que garante que uma falha
   * ali vire `FALHOU` na tabela em vez de um unhandled rejection.
   */
  async iniciar(
    opcoes: { simulacao: boolean; poloId?: number },
    adminEmail: string,
  ): Promise<{ id: number; simulacao: boolean; totalElegiveis: number }> {
    if (!this.d2l.habilitado()) {
      // Sem os enrollments nao ha como saber as disciplinas de quem nunca fez
      // login — e o lote alocaria zero pessoas relatando o problema errado.
      throw new BadRequestException(
        'O compulsorio depende da integracao com o Brightspace (D2L_HABILITADO=true): ' +
          'e ela quem sabe as disciplinas de quem nunca entrou pelo link.',
      );
    }

    const emAndamento = await this.emAndamento();

    if (emAndamento) {
      throw new ConflictException(
        `A execucao ${emAndamento.id} ainda esta rodando (${emAndamento.processados} de ` +
          `${emAndamento.totalElegiveis}). Espere terminar antes de comecar outra.`,
      );
    }

    const vigente = await this.periodo.periodoLetivoVigente();

    if (!vigente) {
      throw new BadRequestException(
        'Nenhum periodo letivo cadastrado. Sem ele nao ha como separar a prova ' +
          'deste semestre da do semestre passado.',
      );
    }

    const { periodoLetivoId, rodada } = vigente;

    const elegiveis = await this.elegiveis(
      periodoLetivoId,
      rodada,
      opcoes.poloId,
    );

    const execucao = await this.prisma.execucaoCompulsorio.create({
      data: {
        simulacao: opcoes.simulacao,
        periodoLetivoId,
        rodada,
        iniciadoPor: adminEmail,
        totalElegiveis: elegiveis.length,
      },
      select: { id: true, simulacao: true, totalElegiveis: true },
    });

    this.auditoria.registrar('COMPULSORIO_INICIADO', {
      ator: adminEmail,
      detalhe:
        `execucao ${execucao.id}, ${opcoes.simulacao ? 'SIMULACAO' : 'GRAVANDO'}, ` +
        `${elegiveis.length} elegivel(is), periodo letivo ${periodoLetivoId} ` +
        `rodada ${rodada}` +
        (opcoes.poloId ? `, polo ${opcoes.poloId}` : ''),
    });

    void this.executar(
      execucao.id,
      periodoLetivoId,
      rodada,
      elegiveis,
      opcoes,
      adminEmail,
    );

    return execucao;
  }

  /** O andamento, para a tela perguntar de tempos em tempos. */
  async consultar(id: number) {
    const execucao = await this.prisma.execucaoCompulsorio.findUnique({
      where: { id },
    });

    if (!execucao) {
      throw new NotFoundException(`Execucao ${id} nao encontrada`);
    }

    const porMotivo = await this.prisma.excecaoCompulsorio.groupBy({
      by: ['motivo'],
      where: { execucaoId: id },
      _count: { _all: true },
    });

    return {
      ...execucao,
      // Um lote cujo processo morreu continua `EM_ANDAMENTO` na tabela; a tela
      // precisa mostrar isso como interrompido, nao como "quase la".
      interrompida: this.pareceMorta(execucao),
      excecoes: Object.fromEntries(
        porMotivo.map((linha) => [linha.motivo, linha._count._all]),
      ),
    };
  }

  /**
   * O relatorio de exceções em CSV — a fila de trabalho da secretaria.
   *
   * Formato do Excel pt-BR (`;` + BOM), o mesmo da exportacao de alunos: quem
   * abre este arquivo e pessoa, e sem o BOM os acentos chegam quebrados. Ver
   * "São DOIS CSVs, com formatos OPOSTOS" no CLAUDE.md.
   */
  async relatorioCsv(id: number): Promise<string> {
    const execucao = await this.prisma.execucaoCompulsorio.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!execucao) {
      throw new NotFoundException(`Execucao ${id} nao encontrada`);
    }

    const excecoes = await this.prisma.excecaoCompulsorio.findMany({
      where: { execucaoId: id },
      select: {
        matricula: true,
        motivo: true,
        detalhe: true,
        aluno: {
          select: {
            nome: true,
            email: true,
            curso: true,
            polo: { select: { nome: true } },
            modalidade: { select: { codigo: true } },
          },
        },
      },
      // Agrupado por motivo: cada bloco do arquivo e uma acao diferente da
      // secretaria (abrir sala, abrir chamado no LMS, conferir o CSV).
      orderBy: [{ motivo: 'asc' }, { matricula: 'asc' }],
    });

    return montarCsv(
      [
        'Matricula',
        'Aluno',
        'E-mail',
        'Curso',
        'Modalidade',
        'Polo',
        'Motivo',
        'O que aconteceu',
      ],
      excecoes.map((e) => [
        e.matricula,
        e.aluno.nome,
        e.aluno.email,
        e.aluno.curso,
        e.aluno.modalidade.codigo,
        e.aluno.polo.nome,
        e.motivo,
        e.detalhe,
      ]),
    );
  }

  /** `Compulsorio 12-08-2026 (execucao 3).csv` — ASCII, sem `/` nem `:`. */
  nomeDoArquivo(id: number): string {
    const hoje = new Date()
      .toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
      .replace(/\//g, '-');

    return `Compulsorio ${hoje} (execucao ${id}).csv`;
  }

  /** A execucao viva, se houver. Publica porque a rota tambem pergunta. */
  async emAndamento() {
    const candidata = await this.prisma.execucaoCompulsorio.findFirst({
      where: { status: StatusExecucao.EM_ANDAMENTO },
      orderBy: { id: 'desc' },
    });

    if (!candidata) return null;

    if (this.pareceMorta(candidata)) {
      // Enterra o lote morto em vez de bloquear os proximos para sempre.
      await this.prisma.execucaoCompulsorio.update({
        where: { id: candidata.id },
        data: {
          status: StatusExecucao.FALHOU,
          erro: 'O processo foi interrompido durante a execucao (reinicio do servidor?). O que ja tinha sido gravado permanece.',
          concluidoEm: new Date(),
        },
      });

      this.logger.warn(
        `Execucao ${candidata.id} marcada como FALHOU: sem sinal de vida ha mais de ` +
          `${SILENCIO_ATE_MORRER_MS / 60_000} min.`,
      );

      return null;
    }

    return candidata;
  }

  private pareceMorta(execucao: {
    status: StatusExecucao;
    atualizadoEm: Date;
  }): boolean {
    return (
      execucao.status === StatusExecucao.EM_ANDAMENTO &&
      Date.now() - execucao.atualizadoEm.getTime() > SILENCIO_ATE_MORRER_MS
    );
  }

  /**
   * Os vinculos que o lote vai tentar alocar.
   *
   * `ativo` e a coluna derivada de STATUS CURSO na importacao — a mesma que o
   * portal consulta. Quem esta Trancado ou Cancelado nao entra: alocar sala para
   * quem nao pode fazer prova gastaria vaga de quem pode.
   *
   * O `none` cobre os dois casos de uma vez: quem nunca agendou e quem cancelou.
   * A separacao entre eles acontece na fase 2, porque so o segundo vira linha de
   * relatorio.
   *
   * O recorte e o par `periodoLetivoId + rodada`, e a rodada e o que faz o lote
   * da substitutiva ter alguem para alocar: elegivel para a SUB e quem nao tem
   * prova DA SUB — inclusive, e principalmente, quem fez a N2. Sem a rodada na
   * conta, o lote da segunda prova do semestre acharia zero elegiveis e
   * relataria sucesso.
   */
  private async elegiveis(
    periodoLetivoId: string,
    rodada: string,
    poloId?: number,
  ) {
    return this.prisma.alunoImportado.findMany({
      where: {
        ativo: true,
        ...(poloId ? { poloId } : {}),
        agendamentos: {
          none: {
            periodoLetivoId,
            rodada,
            status: StatusAgendamento.CONFIRMADO,
          },
        },
      },
      select: {
        id: true,
        matricula: true,
        curso: true,
        poloId: true,
        modalidadeId: true,
        agendamentos: {
          where: {
            periodoLetivoId,
            rodada,
            status: StatusAgendamento.CANCELADO,
          },
          select: { id: true },
          take: 1,
        },
      },
      // Deterministico: e esta ordem que a fase 2 preserva, e e o que faz a
      // simulacao valer como previsao da execucao.
      orderBy: [
        { poloId: 'asc' },
        { modalidadeId: 'asc' },
        { matricula: 'asc' },
      ],
    });
  }

  private async executar(
    execucaoId: number,
    periodoLetivoId: string,
    rodada: string,
    elegiveis: Awaited<ReturnType<CompulsorioService['elegiveis']>>,
    opcoes: { simulacao: boolean },
    adminEmail: string,
  ): Promise<void> {
    const excecoes: Excecao[] = [];
    const candidatos: Candidato[] = [];

    try {
      // ---------------------------------------------------------------- fase 1
      const cancelaram = elegiveis.filter((e) => e.agendamentos.length > 0);

      for (const aluno of cancelaram) {
        excecoes.push({
          alunoId: aluno.id,
          matricula: aluno.matricula,
          motivo: MotivoExcecao.CANCELOU_E_NAO_REMARCOU,
          detalhe: `${aluno.curso}: cancelou a prova e nao remarcou; por decisao da secretaria nao entra no compulsorio.`,
        });
      }

      const paraResolver = elegiveis.filter((e) => e.agendamentos.length === 0);

      await this.resolverEmLotes(
        paraResolver,
        periodoLetivoId,
        candidatos,
        excecoes,
        execucaoId,
      );

      // ---------------------------------------------------------------- fase 2
      const alocados = await this.alocarTodos(
        candidatos,
        periodoLetivoId,
        rodada,
        opcoes.simulacao,
        excecoes,
      );

      await this.gravarExcecoes(execucaoId, excecoes);

      await this.prisma.execucaoCompulsorio.update({
        where: { id: execucaoId },
        data: {
          status: StatusExecucao.CONCLUIDA,
          alocados,
          processados: elegiveis.length,
          concluidoEm: new Date(),
        },
      });

      this.auditoria.registrar('COMPULSORIO_CONCLUIDO', {
        ator: adminEmail,
        detalhe:
          `execucao ${execucaoId}: ${alocados} alocado(s), ${excecoes.length} excecao(oes)` +
          (opcoes.simulacao ? ' (SIMULACAO — nada gravado)' : ''),
      });
    } catch (erro) {
      const motivo = erro instanceof Error ? erro.message : String(erro);

      await this.prisma.execucaoCompulsorio
        .update({
          where: { id: execucaoId },
          data: {
            status: StatusExecucao.FALHOU,
            erro: motivo,
            concluidoEm: new Date(),
          },
        })
        .catch(() => undefined);

      this.auditoria.registrar('COMPULSORIO_FALHOU', {
        ator: adminEmail,
        detalhe: `execucao ${execucaoId}: ${motivo}`,
      });

      this.logger.error(`Execucao ${execucaoId} falhou: ${motivo}`);
    }
  }

  /**
   * Fase 1: descobre identidade e disciplinas, `CONCORRENCIA` alunos por vez.
   *
   * A falha de UM aluno vira linha de relatorio, nunca interrompe o lote: uma
   * matricula sem conta no LMS e um estado esperado, e um timeout isolado da
   * Valence nao pode custar as outras 7 mil alocacoes.
   */
  private async resolverEmLotes(
    alunos: Awaited<ReturnType<CompulsorioService['elegiveis']>>,
    periodoLetivoId: string,
    candidatos: Candidato[],
    excecoes: Excecao[],
    execucaoId: number,
  ): Promise<void> {
    /**
     * O mesmo RA com dois cursos so custa uma ida a Valence: identidade e
     * disciplinas vem por PESSOA, nao por vinculo. Sao 2 alunos em 7,5 mil na
     * base real — o cache existe menos pela economia e mais para os dois
     * vinculos receberem exatamente a mesma lista.
     */
    const porMatricula = new Map<string, Promise<Pessoa | MotivoDaPessoa>>();
    let processados = 0;

    for (let i = 0; i < alunos.length; i += CONCORRENCIA) {
      const fatia = alunos.slice(i, i + CONCORRENCIA);

      const resultados = await Promise.all(
        fatia.map(async (aluno): Promise<Candidato | Excecao> => {
          if (!porMatricula.has(aluno.matricula)) {
            porMatricula.set(
              aluno.matricula,
              this.resolverUm(aluno.matricula, periodoLetivoId),
            );
          }

          const pessoa = await porMatricula.get(aluno.matricula)!;

          // O cache guarda o resultado da PESSOA; o vinculo (curso, polo,
          // modalidade) e sempre o da linha atual.
          return 'motivo' in pessoa
            ? { ...pessoa, alunoId: aluno.id, matricula: aluno.matricula }
            : {
                ...pessoa,
                vinculoId: aluno.id,
                matricula: aluno.matricula,
                curso: aluno.curso,
                poloId: aluno.poloId,
                modalidadeId: aluno.modalidadeId,
              };
        }),
      );

      for (const resultado of resultados) {
        if ('motivo' in resultado) excecoes.push(resultado);
        else candidatos.push(resultado);
      }

      processados += fatia.length;

      // O sinal de vida que distingue lote lento de lote morto.
      await this.prisma.execucaoCompulsorio.update({
        where: { id: execucaoId },
        data: { processados },
      });
    }
  }

  /**
   * Identidade + disciplinas de UMA pessoa. **Nunca lanca: classifica.**
   *
   * Todo caminho de saida aqui e um estado previsto do relatorio. Se um aluno
   * sem conta no LMS virasse excecao, o `Promise.all` da fatia rejeitaria e
   * levaria junto os outros cinco que estavam resolvendo ao lado.
   */
  private async resolverUm(
    matricula: string,
    periodoLetivoId: string,
  ): Promise<Pessoa | MotivoDaPessoa> {
    try {
      const identidade = await this.d2l.identidadePorMatricula(matricula);

      if (identidade.situacao === 'SEM_CONTA') {
        return {
          motivo: MotivoExcecao.SEM_CONTA_D2L,
          detalhe:
            'A matricula nao existe no Brightspace. Sem conta no LMS nao ha como ' +
            'saber as disciplinas nem liberar a prova.',
        };
      }

      if (identidade.situacao === 'AMBIGUA') {
        return {
          motivo: MotivoExcecao.MATRICULA_AMBIGUA,
          detalhe: `${identidade.quantos} contas no Brightspace com esta matricula; escolher uma nao e decisao do sistema.`,
        };
      }

      if (identidade.situacao === 'ID_INVALIDO') {
        return {
          motivo: MotivoExcecao.ID_INVALIDO_D2L,
          detalhe: `UserId "${identidade.valor}" nao e numerico e seria recusado pela Valence.`,
        };
      }

      const cruzamento = await this.disciplinas.cruzarPorUserId(
        identidade.userIdD2L,
      );

      if (cruzamento.agendaveis.length === 0) {
        return {
          motivo: MotivoExcecao.SEM_DISCIPLINA_AGENDAVEL,
          detalhe:
            cruzamento.motivo ??
            `Nenhuma disciplina dele no periodo letivo ${periodoLetivoId} cruzou com o CSV de turmas com prova.`,
        };
      }

      return {
        userIdD2L: identidade.userIdD2L,
        disciplinas: cruzamento.agendaveis,
        contaInativa: !identidade.ativoNoD2L,
      };
    } catch (erro) {
      // Rede, timeout, 500 da Valence: e problema DESTE aluno, nao do lote.
      return {
        motivo: MotivoExcecao.FALHA_NA_INTEGRACAO,
        detalhe: erro instanceof Error ? erro.message : String(erro),
      };
    }
  }

  /**
   * Fase 2: aloca na ordem, sequencialmente.
   *
   * Percorre as faixas do polo do aluno da data mais proxima para a mais
   * distante e para na primeira que aceitar. `escolherOfertaComLock` lanca
   * `ConflictException` tanto quando a faixa nao atende a modalidade quanto
   * quando todas as salas lotaram — nos dois casos a resposta e a mesma: tenta
   * a proxima data.
   */
  private async alocarTodos(
    candidatos: Candidato[],
    periodoLetivoId: string,
    rodada: string,
    simulacao: boolean,
    excecoes: Excecao[],
  ): Promise<number> {
    const faixasPorPolo = await this.faixasPorPolo();

    /** Ocupacao virtual da simulacao: sem ela, todos cairiam na mesma sala. */
    const ocupacaoSimulada = simulacao ? await this.ocupacaoAtual() : null;

    /**
     * Em que faixas cada RA ja tem prova — o mesmo que
     * `exigirUmaProvaPorFaixa` confere no banco, aqui em memoria.
     *
     * So a simulacao precisa disto: na execucao real quem responde e a consulta
     * sob lock. E preciso ser por MATRICULA, e nao por vinculo, porque a regra
     * e sobre a pessoa — e a pessoa e justamente quem tem dois vinculos.
     *
     * E, como o lock, NAO recorta por rodada: a prova que a pessoa fez na N2
     * ocupa aquele horario para a SUB tambem. Filtrar aqui faria a simulacao
     * prometer alocacoes que a execucao real recusaria.
     */
    const faixasPorMatricula = ocupacaoSimulada
      ? await this.faixasJaOcupadas(periodoLetivoId)
      : null;

    let alocados = 0;

    for (const candidato of candidatos) {
      const faixas = faixasPorPolo.get(candidato.poloId) ?? [];

      if (faixas.length === 0) {
        excecoes.push({
          alunoId: candidato.vinculoId,
          matricula: candidato.matricula,
          motivo: MotivoExcecao.SEM_FAIXA_NO_POLO,
          detalhe: 'O polo deste aluno nao tem nenhuma faixa cadastrada.',
        });
        continue;
      }

      const coube: boolean | 'JA_AGENDOU' =
        ocupacaoSimulada && faixasPorMatricula
          ? ocuparVagaSimulada(
              faixas,
              candidato.modalidadeId,
              ocupacaoSimulada,
              porMatricula(faixasPorMatricula, candidato.matricula),
            )
          : await this.alocarDeVerdade(
              candidato,
              faixas,
              periodoLetivoId,
              rodada,
            );

      if (coube === 'JA_AGENDOU') {
        // Agendou pelo portal entre a montagem da lista e agora. Nao e excecao
        // nem alocacao do lote: simplesmente nao precisava mais.
        continue;
      }

      if (!coube) {
        excecoes.push({
          alunoId: candidato.vinculoId,
          matricula: candidato.matricula,
          motivo: MotivoExcecao.SEM_VAGA,
          detalhe:
            'Todas as salas da modalidade dele lotaram em todas as datas do polo. ' +
            'E preciso abrir mais uma sala ou mais uma data.',
        });
        continue;
      }

      alocados++;

      if (candidato.contaInativa) {
        excecoes.push({
          alunoId: candidato.vinculoId,
          matricula: candidato.matricula,
          motivo: MotivoExcecao.AVISO_CONTA_INATIVA_D2L,
          detalhe:
            'Alocado normalmente, mas a conta esta DESATIVADA no Brightspace: ' +
            'do jeito que esta, ele nao conseguiria abrir a prova.',
        });
      }
    }

    return alocados;
  }

  /** A alocacao real, uma transacao por aluno — o mesmo portao do portal. */
  private async alocarDeVerdade(
    candidato: Candidato,
    faixas: { id: number }[],
    periodoLetivoId: string,
    rodada: string,
  ): Promise<boolean | 'JA_AGENDOU'> {
    for (const faixa of faixas) {
      try {
        const ja = await this.prisma.$transaction(async (tx) => {
          await travarAluno(tx, candidato.matricula);

          // Reconferido DENTRO da transacao: entre a montagem da lista e agora,
          // o proprio aluno pode ter agendado pelo portal. Sem isto ele sairia
          // com duas provas marcadas para o mesmo curso.
          const existente = await tx.agendamento.findFirst({
            where: {
              alunoId: candidato.vinculoId,
              periodoLetivoId,
              rodada,
              ...CONFIRMADO,
            },
            select: { id: true },
          });

          if (existente) return true;

          // Lanca `ConflictException` quando a MESMA PESSOA ja tem prova nesta
          // faixa pelo outro curso — e o `catch` la embaixo trata igual a faixa
          // cheia: tenta a proxima data. E assim que o lote acomoda os dois
          // vinculos em horarios diferentes, sem tratamento especial.
          await exigirUmaProvaPorFaixa(tx, {
            matricula: candidato.matricula,
            faixaId: faixa.id,
            periodoLetivoId,
          });

          const oferta = await escolherOfertaComLock(
            tx,
            faixa.id,
            candidato.modalidadeId,
          );

          const criado = await tx.agendamento.create({
            data: {
              alunoId: candidato.vinculoId,
              salaFaixaId: oferta.id,
              matricula: candidato.matricula,
              userIdD2L: candidato.userIdD2L,
              periodoLetivoId,
              // Qual prova do semestre este lote esta preenchendo.
              rodada,
              // Fotografia do vinculo na data da reserva — ver o schema.
              modalidadeId: candidato.modalidadeId,
              poloId: candidato.poloId,
              // Foi a secretaria quem escolheu a sala, nao a alocacao a pedido
              // do aluno. Marcar evita que alguem leia o resultado do lote como
              // escolha dele.
              alocadoManual: true,
              disciplinas: {
                create: candidato.disciplinas.map((d) => ({
                  orgUnitId: d.orgUnitId,
                  nomeDisciplina: d.nomeDisciplina,
                })),
              },
              syncs: {
                create: candidato.disciplinas.map((d) => ({
                  orgUnitId: d.orgUnitId,
                })),
              },
            },
            select: { id: true, salaFaixaId: true },
          });

          await registrarHistorico(tx, {
            agendamentoId: criado.id,
            evento: EventoAgendamento.CRIADO,
            // ADMIN, e nao ALUNO: quando ele perguntar no balcao por que tem
            // prova marcada sem ter marcado, esta linha e a resposta.
            autor: AUTOR_ADMIN('compulsorio'),
            para: await descreverOferta(tx, criado.salaFaixaId),
          });

          return false;
        }, OPCOES_DA_TRANSACAO);

        return ja ? 'JA_AGENDOU' : true;
      } catch (erro) {
        // Faixa cheia ou que nao atende a modalidade: tenta a proxima data.
        if (erro instanceof ConflictException) continue;
        throw erro;
      }
    }

    return false;
  }

  /** As faixas de cada polo, ja na ordem de preenchimento (data mais proxima). */
  private async faixasPorPolo() {
    const faixas = await this.prisma.faixa.findMany({
      where: {
        ativo: true,
        // Data passada nao serve: a prova ja aconteceu. Mesmo corte do portal
        // (`hojeUtc`), porque a coluna e @db.Date gravada em meia-noite UTC.
        data: { gte: hojeUtc() },
      },
      select: {
        id: true,
        poloId: true,
        data: true,
        horaInicio: true,
        salaFaixas: {
          select: { id: true, modalidadeId: true },
        },
      },
    });

    const porPolo = new Map<
      number,
      {
        id: number;
        data: Date;
        horaInicio: string;
        ofertas: { id: number; modalidadeId: number }[];
      }[]
    >();

    for (const faixa of faixas) {
      const lista = porPolo.get(faixa.poloId) ?? [];

      lista.push({
        id: faixa.id,
        data: faixa.data,
        horaInicio: faixa.horaInicio,
        ofertas: faixa.salaFaixas,
      });

      porPolo.set(faixa.poloId, lista);
    }

    for (const [poloId, lista] of porPolo) {
      porPolo.set(poloId, ordenarPorProximidade(lista));
    }

    return porPolo;
  }

  /**
   * As faixas em que cada matricula ja tem prova confirmada — o ponto de partida
   * da regra "uma prova por pessoa em cada horario" dentro da simulacao.
   *
   * Uma consulta so, e nao uma por candidato: sao milhares de alunos, e o lote
   * ja gasta ~25 min em rede.
   */
  private async faixasJaOcupadas(
    periodoLetivoId: string,
  ): Promise<Map<string, Set<number>>> {
    const agendamentos = await this.prisma.agendamento.findMany({
      where: { periodoLetivoId, ...CONFIRMADO },
      select: { matricula: true, salaFaixa: { select: { faixaId: true } } },
    });

    const porMatricula = new Map<string, Set<number>>();

    for (const a of agendamentos) {
      const faixas = porMatricula.get(a.matricula) ?? new Set<number>();
      faixas.add(a.salaFaixa.faixaId);
      porMatricula.set(a.matricula, faixas);
    }

    return porMatricula;
  }

  /** Vagas e ocupacao atuais de cada oferta — o ponto de partida da simulacao. */
  private async ocupacaoAtual() {
    const ofertas = await this.prisma.salaFaixa.findMany({
      select: { id: true, vagas: true, ordem: true },
    });

    const contagem = await this.prisma.agendamento.groupBy({
      by: ['salaFaixaId'],
      where: CONFIRMADO,
      _count: { _all: true },
    });

    const ocupadasPor = new Map(
      contagem.map((c) => [c.salaFaixaId, c._count._all]),
    );

    return new Map(
      ofertas.map((o) => [
        o.id,
        {
          vagas: o.vagas,
          ordem: o.ordem,
          ocupadas: ocupadasPor.get(o.id) ?? 0,
        },
      ]),
    );
  }

  /**
   * As excecoes vao para o banco de uma vez, no fim.
   *
   * `createMany` em vez de uma linha por vez: sao milhares na pior hipotese, e
   * o relatorio so e lido depois que o lote termina.
   */
  private async gravarExcecoes(
    execucaoId: number,
    excecoes: Excecao[],
  ): Promise<void> {
    if (excecoes.length === 0) return;

    await this.prisma.excecaoCompulsorio.createMany({
      data: excecoes.map((e) => ({
        execucaoId,
        alunoId: e.alunoId,
        matricula: e.matricula,
        motivo: e.motivo,
        detalhe: e.detalhe ?? null,
      })),
    });
  }
}

/**
 * O conjunto de faixas daquela matricula, criando-o na primeira vez.
 *
 * Tem que ser o MESMO objeto entre as duas passagens do mesmo RA — e ele que
 * `ocuparVagaSimulada` muta ao escolher a faixa, e e assim que o segundo vinculo
 * enxerga o horario que o primeiro acabou de tomar. Devolver uma copia faria os
 * dois caírem no mesmo horario, e a simulacao mentiria sobre o proprio lote.
 */
function porMatricula(
  mapa: Map<string, Set<number>>,
  matricula: string,
): Set<number> {
  const existente = mapa.get(matricula);

  if (existente) return existente;

  const novo = new Set<number>();
  mapa.set(matricula, novo);

  return novo;
}
