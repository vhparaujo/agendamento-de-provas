import { Injectable, NotFoundException } from '@nestjs/common';
import JSZip from 'jszip';
import { janelaDeDatas } from '../../agendamento/service/agendamento-admin.service';
import { PrismaService } from '../../database/prisma.service';
import { Prisma, StatusAgendamento } from '../../generated/prisma/client';
import { PeriodoService } from '../../periodo/service/periodo.service';
import { csvDeGrupos } from './csv-grupos-d2l';
import {
  caminhoNoZip,
  nomeDoArquivo,
  type TurmaDoArquivo,
} from './nome-de-arquivo';

export interface FiltroRelatorio {
  poloId?: number;
  /** Data da prova (AAAA-MM-DD). */
  de?: string;
  ate?: string;
  /**
   * O(s) periodo(s) letivo(s) do recorte. Vazio = a janela vigente inteira.
   *
   * PLURAL porque uma janela cobre mais de um org unit ao mesmo tempo: os
   * modulares sob o periodo do modulo e os presenciais sob o do semestre.
   * Filtrar por um so faria a lista de presenca de uma sala presencial sair
   * VAZIA — e ninguem descobriria antes do dia da prova. A tela manda a janela
   * inteira; um id sozinho continua valendo, e recorta aquela grade.
   */
  periodoLetivoId?: string[];
}

export interface GrupoExportavel {
  /**
   * A MENOR das faixas que compoem a janela — um handle para a rota de
   * download, nao o recorte do grupo.
   *
   * O grupo e a janela (dia + horario), que pode ser servida por varias faixas,
   * uma por polo. Qualquer uma delas identifica a janela, e a de menor id e
   * escolhida so para o valor nao mudar de um carregamento para o outro.
   */
  faixaId: number;
  /** A disciplina no D2L — o `course offering` onde o grupo vai ser criado. */
  orgUnitId: string;
  data: Date;
  horaInicio: string;
  horaFim: string;
  /**
   * Os campi que aplicam esta prova, em ordem alfabetica — informativo, e quase
   * sempre um so. Nao e recorte: o arquivo leva os alunos de todos eles, porque
   * o acesso ao quiz nao depende de onde a pessoa senta.
   */
  polos: string[];
  /** Do CSV de turmas. `null` quando o `orgUnitId` ainda nao foi aprendido. */
  codigoTurma: string | null;
  nomeDisciplina: string | null;
  /** Matriculas distintas com prova confirmada nesta JANELA E nesta turma. */
  totalAlunos: number;
  /** Nome com que o arquivo deste grupo e baixado avulso. */
  nomeArquivo: string;
}

export interface ArquivoGerado {
  nomeArquivo: string;
  conteudo: string | Buffer;
}

/**
 * O grupo com a lista que vai para o arquivo.
 *
 * As matriculas ficam SEPARADAS da linha porque as duas saidas querem coisas
 * diferentes: a tela quer o numero, o arquivo quer os RAs. Num objeto so, a
 * listagem mandaria dezenas de milhares de matriculas para o navegador exibir
 * uma contagem.
 */
interface GrupoComMatriculas {
  linha: GrupoExportavel;
  matriculas: string[];
}

/** Dia + horario da prova. E metade do recorte de um grupo; a turma e a outra. */
interface Janela {
  data: Date;
  horaInicio: string;
  horaFim: string;
}

/**
 * A chave de agrupamento: e o conjunto que define um grupo, nao cada parte.
 *
 * O separador e `|` e nao precisa ser exotico: os tres primeiros campos tem
 * tamanho FIXO (ISO 8601 e `HH:MM`), entao nao ha como um valor "vazar" para o
 * campo seguinte, e so o `orgUnitId` fica livre no fim. A versao anterior usava
 * um byte NUL, que resolvia o mesmo problema e fazia `grep` tratar este arquivo
 * inteiro como binario — buscas por qualquer termo daqui voltavam vazias, sem
 * erro nenhum.
 */
type ChaveDoGrupo = `${string}|${string}|${string}|${string}`;

const chave = (janela: Janela, orgUnitId: string): ChaveDoGrupo =>
  `${janela.data.toISOString()}|${janela.horaInicio}|${janela.horaFim}|${orgUnitId}`;

/**
 * ============================================================================
 * GRUPOS PARA O BRIGHTSPACE — UM ARQUIVO POR HORARIO **E** TURMA
 * ============================================================================
 * A pergunta aqui e outra, e nao se confunda com `GET /agendamentos/exportacao`:
 * aquele responde "com quem a administracao precisa falar" (TODOS os vinculos,
 * agendados ou nao, 12 colunas, formato de Excel). Este responde "quem entra no
 * grupo desta prova no Brightspace" — so quem tem prova marcada, so a matricula,
 * no formato que o *Groups Import* aceita.
 *
 * Quatro regras que nao sao acidente:
 *
 * 1. **O recorte e por JANELA + TURMA.** O grupo existe DENTRO de uma disciplina
 *    do D2L (`orgUnitId`), e e ele que libera o quiz daquela disciplina. Um
 *    arquivo com o horario inteiro levaria para o grupo de HISTORIA tambem quem
 *    so faz NUTRICAO — pessoas que nem cursam a materia recebendo acesso a prova
 *    dela. Por isso o par, e por isso o mesmo aluno aparece em tantos arquivos
 *    quantas forem as disciplinas da prova dele.
 * 2. **Nem a sala nem o POLO entram.** O grupo libera o quiz numa janela de
 *    tempo; onde a pessoa senta — que cadeira, que campus — nao muda o acesso.
 *    Ver "A JANELA, NAO A FAIXA", abaixo.
 * 3. **Uma matricula aparece UMA vez por arquivo.** Um RA com dois vinculos na
 *    mesmo formato pode ter dois agendamentos na mesma janela, e os dois
 *    cobrindo a mesma disciplina. O grupo e por USUARIO, e a linha repetida
 *    faria o import do D2L reclamar ou duplicar.
 * 4. **So `CONFIRMADO`, e so o periodo letivo do recorte.** Quem cancelou nao
 *    pode receber acesso ao quiz; e sem o recorte de periodo, a prova do
 *    semestre passado colocaria gente no grupo deste semestre.
 *
 * ---------------------------------------------------------------------------
 * A JANELA, NAO A FAIXA (17/08/2026)
 * ---------------------------------------------------------------------------
 * Ate esta data o recorte era o par (`faixaId`, `orgUnitId`) — e `Faixa` carrega
 * `poloId`. O polo entrou no recorte DE CARONA, sem ninguem decidir isso: duas
 * faixas do mesmo dia e horario em campi diferentes viravam dois grupos, na
 * mesma disciplina, com exatamente o mesmo special access. A administracao criava
 * dois grupos identicos no Brightspace e importava dois arquivos — e o
 * `caminhoNoZip` ainda precisava de um `#faixaId` para os dois nao se
 * sobrescreverem dentro do zip.
 *
 * O que o D2L precisa saber e QUANDO a prova abre e em QUAL disciplina. Por isso
 * o grupo passou a ser a janela `data + horaInicio + horaFim` cruzada com a
 * turma, e as faixas de todos os polos daquela janela entram no mesmo arquivo.
 *
 * ⚠️ **Por isso o filtro `poloId` estreita a LISTAGEM e nunca o CONTEUDO.**
 * `montarGrupos` usa o filtro so para escolher QUAIS janelas aparecem, e depois
 * relê os alunos daquelas janelas SEM ele (`inscricoesDasJanelas`). Aplicar o
 * polo nas duas pontas produziria um CSV com metade da turma e nome de arquivo
 * de turma inteira — o import passaria sem erro, e quem ficou de fora
 * descobriria no dia, com o quiz trancado. Nao "otimize" as duas consultas numa
 * so: e exatamente essa separacao que o teste `poloId nao trunca o arquivo`
 * protege.
 *
 * ---------------------------------------------------------------------------
 * FAIXA VAZIA NAO APARECE MAIS
 * ---------------------------------------------------------------------------
 * As linhas nascem dos AGENDAMENTOS, nao das faixas: sem ninguem agendado nao ha
 * turma nenhuma para listar — uma faixa nao "tem" disciplinas, sao os alunos que
 * as trazem. Quem quer ver horario com pouca gente olha a ocupacao em
 * `GET /agendamentos/resumo`, que e a tela feita para isso.
 */
@Injectable()
export class RelatorioService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly periodo: PeriodoService,
  ) {}

  /** Os grupos do recorte, com quantas pessoas cada arquivo teria. */
  async listarGrupos(filtro: FiltroRelatorio): Promise<GrupoExportavel[]> {
    const grupos = await this.montarGrupos(this.ondeFaixa(filtro), filtro);

    // A tela quer a CONTAGEM, nao a lista: devolver as matriculas aqui mandaria
    // dezenas de milhares de RAs para o navegador so para ele exibir um numero.
    return grupos.map((grupo) => grupo.linha);
  }

  /**
   * O CSV de um grupo (uma janela, uma turma).
   *
   * O `faixaId` da URL e um HANDLE, nao o recorte: ele diz de que janela se
   * trata, e o arquivo sai com os alunos de todos os polos que aplicam prova
   * naquela janela. Duas faixas irmas (mesmo dia e horario, campi diferentes)
   * devolvem, de proposito, exatamente o mesmo arquivo.
   */
  async csvDoGrupo(
    faixaId: number,
    orgUnitId: string,
    filtro: FiltroRelatorio,
  ): Promise<ArquivoGerado> {
    // O recorte de data e polo nao vale aqui de proposito: quem pediu ESTE
    // grupo ja escolheu a faixa, e um `?de=` esquecido na URL devolveria 404 em
    // vez do arquivo. O periodo letivo continua valendo — e ele que separa os
    // semestres.
    const grupos = await this.montarGrupos({ id: faixaId }, filtro);
    const grupo = grupos.find((g) => g.linha.orgUnitId === orgUnitId);

    if (!grupo) {
      throw new NotFoundException(
        'Nenhum aluno confirmado nesta turma e neste horário.',
      );
    }

    return {
      nomeArquivo: grupo.linha.nomeArquivo,
      conteudo: csvDeGrupos(grupo.matriculas),
    };
  }

  /**
   * Um zip com o CSV de cada grupo do recorte, em **uma pasta por turma**.
   *
   * A pasta acompanha o trabalho real: a pessoa abre a turma no Brightspace e
   * importa, um a um, os horarios daquela turma. Com faixa x turma o zip passa
   * de dezenas para centenas de arquivos, e achar o certo na raiz seria o
   * gargalo.
   */
  async zipDosGrupos(filtro: FiltroRelatorio): Promise<ArquivoGerado> {
    const grupos = await this.montarGrupos(this.ondeFaixa(filtro), filtro);

    const zip = new JSZip();
    const usados = new Set<string>();

    for (const { linha, matriculas } of grupos) {
      zip.file(caminhoNoZip(linha, usados), csvDeGrupos(matriculas));
    }

    return {
      nomeArquivo: `Grupos-${carimboDeHora()}.zip`,
      conteudo: await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
      }),
    };
  }

  /**
   * O calculo inteiro, num lugar so: listagem, arquivo avulso e zip precisam
   * exatamente do mesmo dado. Se a listagem contasse de um jeito e o arquivo
   * saisse de outro, a divergencia so apareceria quando alguem conferisse o
   * numero de linhas — tarde demais.
   *
   * Sao QUATRO consultas, e nao uma por grupo: com dezenas de horarios e dezenas
   * de turmas, o N+1 apareceria ja no primeiro semestre.
   *
   * A primeira existe para separar as duas perguntas que o `selecao` mistura:
   * ele diz QUAIS JANELAS interessam (e ai o `poloId` do filtro vale), e a
   * leitura dos alunos usa so as janelas resultantes (e ai o polo NAO vale, ou o
   * arquivo sairia truncado). Ver o cabecalho deste arquivo.
   */
  private async montarGrupos(
    selecao: Prisma.FaixaWhereInput,
    filtro: FiltroRelatorio,
  ): Promise<GrupoComMatriculas[]> {
    const periodoLetivoId = await this.periodosDoRecorte(filtro);

    // Sao poucas dezenas de linhas — uma faixa por polo, por dia, por horario.
    const janelas = await this.prisma.faixa.findMany({
      where: selecao,
      select: { data: true, horaInicio: true, horaFim: true },
      distinct: ['data', 'horaInicio', 'horaFim'],
    });

    // Sem janela nao ha grupo, e um `OR: []` no Prisma nao filtra NADA — ele
    // devolveria o semestre inteiro em vez de lista vazia.
    if (janelas.length === 0) return [];

    const inscricoes = await this.inscricoesDasJanelas(
      janelas,
      periodoLetivoId,
    );

    const turmas = await this.turmasPorOrgUnit(
      inscricoes.map((i) => i.orgUnitId),
    );

    const porGrupo = new Map<
      ChaveDoGrupo,
      { linha: GrupoExportavel; matriculas: Set<string>; polos: Set<string> }
    >();

    for (const inscricao of inscricoes) {
      const { faixa } = inscricao.agendamento.salaFaixa;
      const id = chave(faixa, inscricao.orgUnitId);

      let grupo = porGrupo.get(id);

      if (!grupo) {
        // O nome do CSV de turmas manda sobre o que veio do launch: e o que a
        // administracao reconhece, e e ele que aparece no resto do sistema.
        const turma: TurmaDoArquivo = {
          orgUnitId: inscricao.orgUnitId,
          codigoTurma: turmas.get(inscricao.orgUnitId)?.codigoTurma ?? null,
          nomeDisciplina:
            turmas.get(inscricao.orgUnitId)?.nomeDisciplina ??
            inscricao.nomeDisciplina,
        };

        grupo = {
          linha: {
            faixaId: faixa.id,
            orgUnitId: inscricao.orgUnitId,
            data: faixa.data,
            horaInicio: faixa.horaInicio,
            horaFim: faixa.horaFim,
            codigoTurma: turma.codigoTurma,
            nomeDisciplina: turma.nomeDisciplina,
            // Os dois preenchidos no fim: so os Sets sabem o que SOBROU depois
            // de descartar as repeticoes.
            polos: [],
            totalAlunos: 0,
            nomeArquivo: nomeDoArquivo(faixa, turma),
          },
          matriculas: new Set<string>(),
          polos: new Set<string>(),
        };

        porGrupo.set(id, grupo);
      }

      // A janela e servida por uma faixa por polo; o handle e sempre a de menor
      // id para o valor nao depender da ordem em que as linhas voltaram.
      grupo.linha.faixaId = Math.min(grupo.linha.faixaId, faixa.id);
      grupo.polos.add(faixa.polo.nome);
      grupo.matriculas.add(inscricao.agendamento.matricula);
    }

    return [...porGrupo.values()]
      .map(({ linha, matriculas, polos }) => ({
        linha: {
          ...linha,
          totalAlunos: matriculas.size,
          polos: [...polos].sort((a, b) => a.localeCompare(b, 'pt-BR')),
        },
        matriculas: [...matriculas].sort(),
      }))
      .sort((a, b) => ordemDaTela(a.linha, b.linha));
  }

  /**
   * Os alunos confirmados nas janelas dadas — **sem filtro de polo**, de
   * proposito. Ver "A JANELA, NAO A FAIXA" no cabecalho: o campus escolhe quais
   * janelas a tela mostra, nunca quem entra no grupo.
   */
  private inscricoesDasJanelas(
    janelas: Janela[],
    periodoLetivoId: { in: string[] } | undefined,
  ) {
    return this.prisma.agendamentoDisciplina.findMany({
      where: {
        agendamento: {
          status: StatusAgendamento.CONFIRMADO,
          periodoLetivoId,
          salaFaixa: { faixa: { OR: janelas } },
        },
      },
      select: {
        orgUnitId: true,
        nomeDisciplina: true,
        agendamento: {
          select: {
            matricula: true,
            salaFaixa: {
              select: {
                faixa: {
                  select: {
                    id: true,
                    data: true,
                    horaInicio: true,
                    horaFim: true,
                    polo: { select: { nome: true } },
                  },
                },
              },
            },
          },
        },
      },
      orderBy: { agendamento: { matricula: 'asc' } },
    });
  }

  /**
   * Codigo e nome da turma, pelo `orgUnitId` que o portal aprendeu no launch.
   *
   * Pode nao achar: o CSV de turmas nao traz o `orgUnitId`, ele e gravado quando
   * o primeiro aluno daquela turma entra pelo LTI. Ate la — e sempre, quando
   * `TURMAS_FILTER_ENABLED=false` libera disciplina sem cruzar com o CSV — o
   * nome do arquivo cai no `orgUnitId`, e nao numa palavra generica que faria
   * duas turmas disputarem o mesmo arquivo.
   */
  private async turmasPorOrgUnit(
    orgUnitIds: string[],
  ): Promise<Map<string, { codigoTurma: string; nomeDisciplina: string }>> {
    const distintos = [...new Set(orgUnitIds)];

    if (distintos.length === 0) return new Map();

    const turmas = await this.prisma.turmaImportada.findMany({
      where: { orgUnitId: { in: distintos } },
      select: { orgUnitId: true, codigoTurma: true, nomeDisciplina: true },
    });

    return new Map(
      turmas.map((t) => [
        t.orgUnitId!,
        { codigoTurma: t.codigoTurma, nomeDisciplina: t.nomeDisciplina },
      ]),
    );
  }

  private ondeFaixa(filtro: FiltroRelatorio): Prisma.FaixaWhereInput {
    return { poloId: filtro.poloId, data: janelaDeDatas(filtro) };
  }

  /**
   * O recorte por periodo letivo: o da URL, ou a JANELA VIGENTE INTEIRA.
   *
   * Devolve um filtro (`{ in: [...] }`) e nao uma string porque a janela cobre
   * mais de um org unit ao mesmo tempo — a grade modular e a semestral correm em
   * paralelo. Um id so deixaria de fora as provas dos presenciais, e o relatorio
   * sairia com metade da sala.
   *
   * `undefined` = sem recorte (nenhum periodo cadastrado), como antes.
   */
  private async periodosDoRecorte(
    filtro: FiltroRelatorio,
  ): Promise<{ in: string[] } | undefined> {
    if (filtro.periodoLetivoId?.length) return { in: filtro.periodoLetivoId };

    const janela = await this.periodo.janelaVigente();

    return janela ? { in: janela.periodoLetivoIds } : undefined;
  }
}

/**
 * Dia, horario e depois turma — a ordem em que a administração pensa a prova.
 *
 * A ordenacao e em memoria porque o agrupamento ja e: os grupos nao existem como
 * linha em tabela nenhuma, sao montados a partir das inscricoes.
 */
function ordemDaTela(a: GrupoExportavel, b: GrupoExportavel): number {
  return (
    a.data.getTime() - b.data.getTime() ||
    a.horaInicio.localeCompare(b.horaInicio) ||
    // O polo saiu do criterio junto com o recorte: duas linhas do mesmo dia,
    // horario e turma nao existem mais, entao ele nunca chegaria a desempatar.
    (a.codigoTurma ?? a.orgUnitId).localeCompare(
      b.codigoTurma ?? b.orgUnitId,
      'pt-BR',
    )
  );
}

/** Dois zips baixados no mesmo dia nao se confundem na pasta de downloads. */
function carimboDeHora(): string {
  return new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
}
