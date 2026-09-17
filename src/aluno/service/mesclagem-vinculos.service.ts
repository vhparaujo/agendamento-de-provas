import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { StatusAgendamento } from '../../generated/prisma/client';
import { Transacao } from '../../agendamento/service/lock-de-vagas';
import { PeriodoService } from '../../periodo/service/periodo.service';
import { AuditoriaService } from '../../seguranca/service/auditoria.service';

export interface ResultadoMesclagem {
  /** O vinculo que ficou, com a grafia de curso que veio da planilha nova. */
  destino: { id: number; matricula: string; curso: string };
  /** O que foi absorvido e deixou de existir. */
  absorvido: { id: number; curso: string };
  agendamentosMovidos: number;
  excecoesMovidas: number;
  /**
   * O que a mesclagem deixou inconsistente e ninguem mais vai reclamar.
   * Vazio na esmagadora maioria dos casos — ver `conferirHeranca`.
   */
  avisos: string[];
}

/**
 * ============================================================================
 * MESCLAGEM DE VINCULOS — DESFAZ A DUPLICATA QUE A GRAFIA CRIOU
 * ============================================================================
 * Contraparte de `cursosRenomeados[]` na importacao de alunos. La o sistema
 * DETECTA que "PSICOLOGIA" virou "Psicologia — Bacharelado" e que isso criou uma
 * segunda linha para a mesma pessoa; aqui a administracao RESOLVE, movendo o que
 * estava preso ao vinculo antigo para o novo e apagando o antigo.
 *
 * POR QUE E UMA ACAO HUMANA, e nao algo que a importacao faz sozinha:
 * dois vinculos no mesmo RA existem de verdade (2 em 7519 na base real, um em
 * cada curso, com formatos diferentes). Mesclar por semelhanca de nome
 * fundiria dois cursos numa pessoa so e misturaria as provas dos dois — erro
 * que so apareceria no dia da prova, e irreversivel porque o vinculo absorvido
 * deixa de existir. Por isso a deteccao nunca chuta e esta rota exige os DOIS
 * ids explicitos.
 *
 * E a unica rota de escrita sobre `AlunoImportado`. A regra geral continua de pe
 * — a planilha e a fonte de verdade, e um aluno editado pela API seria
 * sobrescrito no proximo upload. A excecao se justifica porque isto nao edita
 * cadastro: reimportar o CSV NAO desfaz a duplicata (o vinculo antigo nao esta
 * mais no arquivo, e a importacao nunca apaga), entao sem esta rota a linha
 * orfa ficaria no banco para sempre, cobrando prova de quem ja agendou.
 */
@Injectable()
export class MesclagemVinculosService {
  private readonly logger = new Logger(MesclagemVinculosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly periodo: PeriodoService,
  ) {}

  /**
   * Move tudo de `absorverId` para `destinoId` e apaga o absorvido.
   *
   * `destinoId` e o vinculo que FICA — normalmente o recem-criado pela
   * importacao, com a grafia nova. E a mesma direcao do relatorio: o
   * `alunoId` de `cursosRenomeados[]` vai na URL, o da candidata no corpo.
   *
   * Tudo numa transacao: mover metade dos agendamentos e falhar deixaria a
   * pessoa com prova em dois vinculos, que e pior do que a duplicata original.
   */
  async mesclar(
    destinoId: number,
    absorverId: number,
    porAdmin: string,
  ): Promise<ResultadoMesclagem> {
    if (destinoId === absorverId) {
      throw new BadRequestException(
        'destino e absorvido são o mesmo vínculo. Informe os dois ids do relatório de importação.',
      );
    }

    const resultado = await this.prisma.$transaction(async (tx) => {
      const [destino, absorvido] = await Promise.all([
        tx.alunoImportado.findUnique({
          where: { id: destinoId },
          include: { modalidade: true, polo: true },
        }),
        tx.alunoImportado.findUnique({
          where: { id: absorverId },
          include: { modalidade: true, polo: true },
        }),
      ]);

      if (!destino) {
        throw new NotFoundException(`Vínculo ${destinoId} não encontrado`);
      }

      if (!absorvido) {
        throw new NotFoundException(`Vínculo ${absorverId} não encontrado`);
      }

      // A TRAVA QUE IMPORTA. Sem ela, um id trocado na chamada moveria a prova
      // de uma pessoa para outra — e como o vinculo de origem e apagado em
      // seguida, nao haveria como descobrir de quem era. Matricula igual e o
      // unico jeito de afirmar que os dois vinculos sao da MESMA pessoa.
      if (destino.matricula !== absorvido.matricula) {
        throw new BadRequestException(
          `Os vínculos são de matrículas diferentes (${destino.matricula} e ` +
            `${absorvido.matricula}). Mesclar só faz sentido dentro do mesmo RA.`,
        );
      }

      await this.recusarSeAmbosTemProva(tx, destinoId, absorverId);

      const avisos = conferirHeranca(destino, absorvido);

      // `Agendamento.matricula` e desnormalizado, mas nao precisa ser reescrito:
      // a matricula e a mesma nos dois vinculos, garantido pela trava acima.
      const agendamentos = await tx.agendamento.updateMany({
        where: { alunoId: absorverId },
        data: { alunoId: destinoId },
      });

      // Vao junto para que o historico do compulsorio ("ficou sem vaga em
      // agosto") continue apontando para uma pessoa que existe. Sem isto o
      // delete abaixo violaria a FK e a mesclagem falharia inteira.
      const excecoes = await tx.excecaoCompulsorio.updateMany({
        where: { alunoId: absorverId },
        data: { alunoId: destinoId },
      });

      await tx.alunoImportado.delete({ where: { id: absorverId } });

      return {
        destino: {
          id: destino.id,
          matricula: destino.matricula,
          curso: destino.curso,
        },
        absorvido: { id: absorvido.id, curso: absorvido.curso },
        agendamentosMovidos: agendamentos.count,
        excecoesMovidas: excecoes.count,
        avisos,
      };
    });

    /**
     * O rastro fica no log de seguranca, e nao em `HistoricoAgendamento`.
     *
     * Aquela tabela responde "mudaram minha prova de horario?" — e a mesclagem
     * nao muda prova nenhuma: sala, data e horario continuam identicos, e o
     * aluno nao tem como perceber que aconteceu. O que ela muda e uma linha de
     * cadastro, que e assunto de auditoria administrativa.
     */
    this.auditoria.registrar('VINCULOS_MESCLADOS', {
      ator: porAdmin,
      detalhe:
        `RA ${resultado.destino.matricula}: vinculo ${resultado.absorvido.id} ` +
        `("${resultado.absorvido.curso}") absorvido por ${resultado.destino.id} ` +
        `("${resultado.destino.curso}"); ${resultado.agendamentosMovidos} agendamento(s) ` +
        `e ${resultado.excecoesMovidas} exceção(ões) movidas`,
    });

    if (resultado.avisos.length > 0) {
      this.logger.warn(
        `Mesclagem ${resultado.absorvido.id} -> ${resultado.destino.id} ` +
          `(RA ${resultado.destino.matricula}): ${resultado.avisos.join(' ')}`,
      );
    }

    return resultado;
  }

  /**
   * Os dois vinculos com prova confirmada na MESMA prova do semestre.
   *
   * Mesclar ali produziria uma pessoa com dois agendamentos confirmados para a
   * mesma prova — estado que o resto do sistema assume impossivel (a regra e um
   * agendamento por vinculo por rodada). O aluno apareceria em duas listas de
   * sala no mesmo dia e ocuparia duas vagas.
   *
   * A comparacao e do par `periodoLetivoId + rodada`, e nao do semestre sozinho:
   * um vinculo com prova na N2 e o outro com prova na SUB sao duas provas
   * diferentes, cada uma na sua sala e no seu dia. Mescladas, viram duas provas
   * da mesma pessoa — que e exatamente o que se espera de quem faz a regular e
   * depois a substitutiva. Recusar esse caso travaria a mesclagem em todo RA que
   * fez as duas.
   *
   * ⚠️ **Mas os periodos letivos da JANELA VIGENTE contam como UM.** A mesclagem
   * entre formatos e permitida (`conferirHeranca` avisa e nao bloqueia), e
   * desde que as duas grades convivem os dois vinculos de uma mesma pessoa podem
   * ter provas da MESMA janela gravadas sob org units diferentes — o EaD sob o
   * modulo, o Presencial sob o semestre. Comparar o id cru faria a trava deixar
   * passar exatamente o estado que ela existe para impedir: uma pessoa com duas
   * reservas confirmadas para a mesma prova, em duas salas.
   *
   * Os periodos ANTIGOS continuam comparados pelo id, e nao ha como confundi-los
   * com a janela: eles nao estao nela.
   *
   * Recusa em vez de escolher uma: decidir qual prova sobrevive e das duas uma —
   * ou sao a mesma pessoa e uma das reservas precisa ser cancelada (decisao da
   * administracao, que pode ate ser a mais recente), ou sao dois vinculos de
   * verdade e a mesclagem inteira e o erro.
   */
  private async recusarSeAmbosTemProva(
    tx: Transacao,
    destinoId: number,
    absorverId: number,
  ): Promise<void> {
    const confirmados = await tx.agendamento.findMany({
      where: {
        alunoId: { in: [destinoId, absorverId] },
        status: StatusAgendamento.CONFIRMADO,
      },
      select: { alunoId: true, periodoLetivoId: true, rodada: true },
    });

    // Tudo que pertence a janela vigente colapsa numa chave so; o resto
    // continua identificado pelo proprio periodo letivo.
    const janela = await this.periodo.janelaVigente();
    const daJanela = new Set(janela?.periodoLetivoIds ?? []);

    const chave = (a: { periodoLetivoId: string; rodada: string }) =>
      `${daJanela.has(a.periodoLetivoId) ? 'JANELA_VIGENTE' : a.periodoLetivoId}` +
      `\u0000${a.rodada}`;

    const provasDoDestino = new Set(
      confirmados.filter((a) => a.alunoId === destinoId).map(chave),
    );

    const conflito = confirmados.find(
      (a) => a.alunoId === absorverId && provasDoDestino.has(chave(a)),
    );

    if (conflito) {
      throw new ConflictException(
        `Os dois vínculos têm prova CONFIRMADA na mesma janela (período letivo ` +
          `${conflito.periodoLetivoId}, rodada ${conflito.rodada}). Mesclar deixaria ` +
          `a mesma pessoa com duas reservas para a mesma prova, em duas salas. ` +
          `Cancele uma das provas antes de mesclar — ou reveja se estes vínculos ` +
          `são mesmo a mesma coisa.`,
      );
    }
  }
}

/**
 * O que a mesclagem deixa torto e ninguem mais reclama.
 *
 * O vinculo que sobrevive carrega SEU formato e SEU polo, e as provas
 * herdadas continuam nas salas onde foram alocadas. Se os dois vinculos
 * divergiam nesses campos, o resultado e exatamente a inconsistencia que
 * `alteracoesComAgendamento` descreve na importacao: a reserva fica numa sala de
 * outra duracao ou de outro campus, e o sintoma aparece dias depois, disfarcado
 * de "esta sala nao e do formato do aluno" na hora do remanejo.
 *
 * Avisa e nao bloqueia, pelo mesmo motivo de la: o divergente pode ser
 * justamente o cadastro errado que a planilha nova veio corrigir. Quem decide
 * entre remanejar e cancelar e a administração — o que ela nao pode e nao saber.
 */
function conferirHeranca(destino: Vinculo, absorvido: Vinculo): string[] {
  const avisos: string[] = [];

  if (destino.modalidadeId !== absorvido.modalidadeId) {
    avisos.push(
      `O vínculo absorvido era ${absorvido.modalidade.nome} e o que ficou é ` +
        `${destino.modalidade.nome}: as provas herdadas continuam alocadas em salas ` +
        `de outra duração. Confira se precisam ser remanejadas.`,
    );
  }

  if (destino.poloId !== absorvido.poloId) {
    avisos.push(
      `O vínculo absorvido era do polo ${absorvido.polo.nome} e o que ficou é de ` +
        `${destino.polo.nome}: as provas herdadas continuam marcadas no campus anterior. ` +
        `Confira se o aluno sabe para onde ir.`,
    );
  }

  return avisos;
}

interface Vinculo {
  modalidadeId: number;
  modalidade: { nome: string };
  poloId: number;
  polo: { nome: string };
}
