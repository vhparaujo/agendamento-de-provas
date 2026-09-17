import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { D2lEnrollmentsService } from '../../d2l/service/d2l-enrollments.service';
import {
  candidatasDe,
  escolherTurma,
  TurmaCandidata,
} from '../../turma/service/turma-match';

/**
 * ============================================================================
 * DE QUE TURMAS O LOTE TROCA A SENHA — e como cada uma vira um orgUnitId
 * ============================================================================
 *
 * O conjunto, dito de uma vez:
 *
 *     TurmaImportada (o CSV)  ∩  ofertas descendentes do periodo letivo vigente
 *
 * TODAS as turmas do CSV, sem olhar se ha agendamento nelas (decisao do cliente,
 * 18/08/2026). O cruzamento com as ofertas do Brightspace serve para DUAS coisas
 * e so elas:
 *
 *   1. descobrir o `orgUnitId` — o CSV nao o traz, e sem ele nao existe chamada
 *      possivel: a URL do quiz e `/{orgUnitId}/quizzes/`;
 *   2. descartar as linhas do CSV de SEMESTRES PASSADOS — a importacao faz
 *      upsert e nunca apaga, entao `turma_importada` acumula semestre a semestre.
 *
 * ⚠️ **Iterar sobre as ofertas do D2L nao e a direcao do ESCOPO.** Percorremos as
 * ofertas porque e assim que `escolherTurma` foi escrito (`TurmaDoLaunch` ->
 * `TurmaCandidata[]`), e reescrever aquele matcher ao contrario jogaria fora os
 * cinco tiers, o `Code` composto e o desempate por nome — todos ja validados
 * contra a instancia real da UCB. Mas o resultado e sempre o conjunto das LINHAS
 * DO CSV que casaram: **oferta do semestre que nao esta no CSV e IGNORADA**, ela
 * nao tem prova. Ha teste so para isso.
 *
 * **Nada e chutado**, a regra do projeto: `AMBIGUA` e `DIVERGENTE` nao gravam e
 * nao entram no lote — viram linha de relatorio. Chutar aqui trocaria a senha da
 * prova errada, e o erro so apareceria no dia.
 */

/** Uma turma do CSV pronta para o lote. */
export interface TurmaResolvida {
  turmaId: number;
  orgUnitId: string;
  codigoTurma: string;
  nomeDisciplina: string;
}

/** Uma turma do CSV que o lote NAO consegue tocar, e por que. */
export interface TurmaNaoResolvida {
  turmaId: number;
  codigoTurma: string;
  nomeDisciplina: string;
  /** `false` = nenhuma oferta casou; `true` = mais de uma casou. */
  ambigua: boolean;
  motivo: string;
}

export interface ResultadoResolucao {
  /** Linhas do CSV consideradas (todas, antes do recorte por semestre). */
  totalNoCsv: number;
  resolvidas: TurmaResolvida[];
  naoResolvidas: TurmaNaoResolvida[];
  /**
   * Quantos `orgUnitId` foram gravados NESTA passada. Metrica, e o sinal de que
   * um CSV novo entrou: em regime, tende a zero.
   */
  aprendidos: number;
}

@Injectable()
export class ResolucaoOrgUnitService {
  private readonly logger = new Logger(ResolucaoOrgUnitService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly enrollments: D2lEnrollmentsService,
  ) {}

  /**
   * Resolve o `orgUnitId` de cada turma do CSV contra as ofertas do semestre.
   *
   * Roda no inicio de cada execucao do lote: e barato (uma chamada por periodo
   * letivo, cacheada 10 min no `D2lEnrollmentsService`) e e o que faz uma turma
   * nova no CSV entrar no lote seguinte sem ninguem precisar fazer nada.
   *
   * Recebe os periodos letivos da JANELA, no plural: o CSV de turmas nao separa
   * formato, e as turmas dos presenciais vivem sob o org unit do semestre
   * enquanto as dos modulares vivem sob o do modulo. Resolver contra um so
   * deixaria metade das turmas em `naoResolvidas` — e elas ficariam de fora do
   * lote de senhas, com a prova trancada no dia.
   */
  async resolver(periodoLetivoIds: string[]): Promise<ResultadoResolucao> {
    const doCsv = await this.turmasDoCsv();

    if (doCsv.length === 0) {
      // Sem CSV de turmas nao ha prova nenhuma cadastrada — o lote nao tem o que
      // fazer, e isso nao e erro: e a importacao que ainda nao aconteceu.
      return {
        totalNoCsv: 0,
        resolvidas: [],
        naoResolvidas: [],
        aprendidos: 0,
      };
    }

    const ofertas = (
      await Promise.all(
        periodoLetivoIds.map((letivo) =>
          this.enrollments.ofertasDoSemestre(letivo),
        ),
      )
    ).flat();

    /** turmaId -> orgUnitIds que casaram com ela. Mais de um = ambigua. */
    const casamentos = new Map<number, Set<string>>();
    /** turmaId -> por que ela nao casou, quando o matcher soube dizer. */
    const motivos = new Map<number, string>();

    const porOrgUnitId = new Map(
      doCsv.filter((t) => t.orgUnitId).map((t) => [t.orgUnitId!, t]),
    );

    for (const oferta of ofertas) {
      // Atalho: o orgUnitId ja gravado veio de um launch REAL naquela turma —
      // e a evidencia mais forte que existe, mais forte que qualquer heuristica
      // de codigo ou nome. Sem este atalho, uma turma cujo `Code` divergisse do
      // CSV seria descartada mesmo tendo o id certo no banco.
      const jaAprendida = porOrgUnitId.get(oferta.orgUnitId);

      if (jaAprendida) {
        this.registrar(casamentos, jaAprendida.id, oferta.orgUnitId);
        continue;
      }

      const candidatas = candidatasDe(oferta, doCsv);
      const escolha = escolherTurma(oferta, candidatas);

      if (escolha.situacao === 'ENCONTRADA') {
        this.registrar(casamentos, escolha.turma.id, oferta.orgUnitId);
        continue;
      }

      // NAO_ENCONTRADA e o caso NORMAL e silencioso: e a oferta do semestre que
      // simplesmente nao esta no CSV, ou seja, nao tem prova. Ignorar e o
      // comportamento correto — nao ha o que relatar sobre ela.
      if (escolha.situacao === 'NAO_ENCONTRADA') continue;

      // AMBIGUA/DIVERGENTE dizem respeito as CANDIDATAS: guardamos o motivo nelas
      // para o relatorio explicar o que houve, em vez de so "nao resolveu".
      for (const candidata of candidatas) {
        if (!motivos.has(candidata.id))
          motivos.set(candidata.id, escolha.motivo);
      }
    }

    return this.montarResultado(doCsv, casamentos, motivos);
  }

  private registrar(
    casamentos: Map<number, Set<string>>,
    turmaId: number,
    orgUnitId: string,
  ): void {
    const atual = casamentos.get(turmaId);
    if (atual) atual.add(orgUnitId);
    else casamentos.set(turmaId, new Set([orgUnitId]));
  }

  private async montarResultado(
    doCsv: TurmaCandidata[],
    casamentos: Map<number, Set<string>>,
    motivos: Map<number, string>,
  ): Promise<ResultadoResolucao> {
    const resolvidas: TurmaResolvida[] = [];
    const naoResolvidas: TurmaNaoResolvida[] = [];
    const aprender: { turmaId: number; orgUnitId: string }[] = [];

    for (const turma of doCsv) {
      const ids = casamentos.get(turma.id);

      if (!ids || ids.size === 0) {
        naoResolvidas.push({
          turmaId: turma.id,
          codigoTurma: turma.codigoTurma,
          nomeDisciplina: turma.nomeDisciplina,
          ambigua: false,
          motivo:
            motivos.get(turma.id) ??
            'Nenhuma oferta do período letivo vigente casou com esta linha do CSV. ' +
              'Ou ela é de um semestre passado, ou o código divergiu no AVA.',
        });
        continue;
      }

      if (ids.size > 1) {
        // Duas ofertas do MESMO semestre casaram a mesma linha. Escolher uma
        // trocaria a senha de uma prova e deixaria a outra de fora, em silencio.
        naoResolvidas.push({
          turmaId: turma.id,
          codigoTurma: turma.codigoTurma,
          nomeDisciplina: turma.nomeDisciplina,
          ambigua: true,
          motivo:
            `${ids.size} ofertas do semestre casaram esta linha do CSV ` +
            `(códigos no AVA: ${[...ids].sort().join(', ')}). Nenhuma foi escolhida.`,
        });
        continue;
      }

      const orgUnitId = [...ids][0];

      resolvidas.push({
        turmaId: turma.id,
        orgUnitId,
        codigoTurma: turma.codigoTurma,
        nomeDisciplina: turma.nomeDisciplina,
      });

      if (turma.orgUnitId !== orgUnitId)
        aprender.push({ turmaId: turma.id, orgUnitId });
    }

    const aprendidos = await this.gravarOrgUnitIds(aprender);

    this.logger.log(
      `Resolucao de turmas: ${resolvidas.length} de ${doCsv.length} do CSV ` +
        `entram no lote; ${naoResolvidas.length} fora; ${aprendidos} orgUnitId aprendido(s).`,
    );

    return {
      totalNoCsv: doCsv.length,
      resolvidas,
      naoResolvidas,
      aprendidos,
    };
  }

  /**
   * Grava o `orgUnitId` recem-descoberto, do mesmo jeito que o launch ja fazia:
   * so em quem esta com o campo VAZIO, nunca sobrescrevendo.
   *
   * A coluna e `@unique`, entao duas linhas do CSV disputando o mesmo id fazem a
   * segunda falhar. Isso e tratado uma a uma e apenas logado: aprender o id e
   * uma otimizacao para a proxima execucao, nunca a razao de o lote parar — a
   * resolucao desta rodada ja esta em memoria e segue valendo.
   */
  private async gravarOrgUnitIds(
    aprender: { turmaId: number; orgUnitId: string }[],
  ): Promise<number> {
    let gravados = 0;

    for (const { turmaId, orgUnitId } of aprender) {
      try {
        const { count } = await this.prisma.turmaImportada.updateMany({
          where: { id: turmaId, orgUnitId: null },
          data: { orgUnitId },
        });
        gravados += count;
      } catch (erro) {
        this.logger.warn(
          `Nao foi possivel gravar o orgUnitId ${orgUnitId} na turma ${turmaId}: ` +
            `${erro instanceof Error ? erro.message : String(erro)}`,
        );
      }
    }

    return gravados;
  }

  /** As linhas do CSV, no formato que `turma-match` espera. */
  private turmasDoCsv(): Promise<TurmaCandidata[]> {
    return this.prisma.turmaImportada.findMany({
      select: {
        id: true,
        codigoTurma: true,
        nomeDisciplina: true,
        codigoEad: true,
        orgUnitId: true,
      },
      orderBy: [{ codigoTurma: 'asc' }, { nomeDisciplina: 'asc' }],
    });
  }
}
