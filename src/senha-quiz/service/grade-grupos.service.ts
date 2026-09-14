import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AuditoriaService } from '../../seguranca/service/auditoria.service';
import { escolherGrupoDoDia, GrupoDoDia } from './grupo-do-dia';
import { dataUtcDeIso, isoDeDataUtc } from './relogio';

/**
 * ============================================================================
 * A GRADE DIA x JANELA — qual grupo libera a prova em cada sessao de cada dia
 * ============================================================================
 * Nasceu em 14/09/2026, revertendo a decisao de 26/08/2026 de um nome fixo por
 * janela. Os grupos de cada dia tem nomes livres, e a secretaria trocava o nome
 * da janela a mao todo dia de prova.
 *
 * Diferencas deliberadas em relacao a grade de SENHAS:
 *
 * - **Nao ha segredo.** Nome de grupo aparece em qualquer tela do AVA, entao a
 *   listagem devolve o valor, e nao existe rota de revelar.
 * - **Salva em lote.** A secretaria preenche uma semana inteira de uma vez
 *   (~14 janelas x 6 dias); uma requisicao por celula seria 84 cliques.
 * - **Nome vazio APAGA a celula.** O dia volta a usar o nome fixo da janela, se
 *   houver. Gravar `""` passaria por "tem grupo?" e produziria uma pendencia por
 *   turma sem nada configurado — o mesmo cuidado de `JanelaDeProva.nomeGrupo`.
 */

export interface CelulaDeGrupo {
  id: number;
  /** "AAAA-MM-DD" — o dia da PROVA. */
  data: string;
  janelaDeProvaId: number;
  nomeGrupo: string;
  /** Nulo = usa a categoria da janela. */
  categoriaGrupo: string | null;
  versao: number;
  atualizadoPor: string;
  atualizadoEm: Date;
}

export interface CelulaDeGrupoEntrada {
  data: string;
  janelaDeProvaId: number;
  /** Vazio ou nulo = apaga a celula. */
  nomeGrupo?: string | null;
  categoriaGrupo?: string | null;
}

@Injectable()
export class GradeGruposService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
  ) {}

  /** As celulas cadastradas no intervalo. A tela desenha as vazias. */
  async listar(de: string, ate: string): Promise<CelulaDeGrupo[]> {
    const celulas = await this.prisma.grupoDaJanela.findMany({
      where: { data: { gte: dataUtcDeIso(de), lte: dataUtcDeIso(ate) } },
      orderBy: [{ data: 'asc' }, { janelaDeProvaId: 'asc' }],
    });

    return celulas.map((c) => ({
      id: c.id,
      data: isoDeDataUtc(c.data),
      janelaDeProvaId: c.janelaDeProvaId,
      nomeGrupo: c.nomeGrupo,
      categoriaGrupo: c.categoriaGrupo,
      versao: c.versao,
      atualizadoPor: c.atualizadoPor ?? c.criadoPor,
      atualizadoEm: c.updatedAt,
    }));
  }

  /**
   * Grava um lote de celulas — cria, atualiza ou (nome vazio) apaga.
   *
   * Tudo numa transacao: uma semana meio salva faria o disparo de um dia usar o
   * grupo novo e o do dia seguinte o antigo, e a secretaria so descobriria no dia.
   */
  async salvar(
    entrada: CelulaDeGrupoEntrada[],
    adminEmail: string,
  ): Promise<CelulaDeGrupo[]> {
    if (entrada.length === 0) {
      throw new BadRequestException('Envie ao menos uma celula.');
    }

    const celulas = entrada.map((c) => {
      const nomeGrupo = c.nomeGrupo?.trim() || null;

      return {
        dataIso: c.data,
        data: dataUtcDeIso(c.data),
        janelaDeProvaId: c.janelaDeProvaId,
        nomeGrupo,
        // So faz sentido com o nome — mesma regra de `janelaValidada`.
        categoriaGrupo: nomeGrupo ? c.categoriaGrupo?.trim() || null : null,
      };
    });

    this.exigirSemRepeticao(celulas);

    const janelas = await this.prisma.janelaDeProva.findMany({
      where: {
        id: { in: [...new Set(celulas.map((c) => c.janelaDeProvaId))] },
      },
      select: {
        id: true,
        horaInicio: true,
        horaFim: true,
        modalidade: { select: { codigo: true } },
      },
    });

    const janelaPorId = new Map(janelas.map((j) => [j.id, j]));
    const inexistentes = celulas
      .map((c) => c.janelaDeProvaId)
      .filter((id) => !janelaPorId.has(id));

    if (inexistentes.length > 0) {
      throw new BadRequestException(
        `Janela(s) ${[...new Set(inexistentes)].join(', ')} nao encontrada(s). ` +
          'Recarregue a tela: o calendario pode ter sido alterado.',
      );
    }

    const mudancas: string[] = [];

    await this.prisma.$transaction(async (tx) => {
      for (const celula of celulas) {
        const chave = {
          data_janelaDeProvaId: {
            data: celula.data,
            janelaDeProvaId: celula.janelaDeProvaId,
          },
        };

        const existente = await tx.grupoDaJanela.findUnique({ where: chave });
        const janela = janelaPorId.get(celula.janelaDeProvaId)!;
        const onde = `${celula.dataIso} ${janela.modalidade.codigo} ${janela.horaInicio}-${janela.horaFim}`;

        if (!celula.nomeGrupo) {
          if (existente) {
            await tx.grupoDaJanela.delete({ where: chave });
            mudancas.push(`${onde}: "${existente.nomeGrupo}" removido`);
          }
          continue;
        }

        // ⚠️ A VERSAO SOBE SO QUANDO O QUE E APLICADO MUDA — e e ela que libera
        // um novo disparo HOJE. Salvar a semana inteira de novo, sem mudar nada,
        // nao pode reprocessar a instituicao; corrigir o grupo das 15h depois do
        // disparo das 12:01 precisa. Mesmo remedio de `SenhaDeProva.versao`.
        const mudou =
          !existente ||
          existente.nomeGrupo !== celula.nomeGrupo ||
          existente.categoriaGrupo !== celula.categoriaGrupo;

        if (!mudou) continue;

        await tx.grupoDaJanela.upsert({
          where: chave,
          create: {
            data: celula.data,
            janelaDeProvaId: celula.janelaDeProvaId,
            nomeGrupo: celula.nomeGrupo,
            categoriaGrupo: celula.categoriaGrupo,
            criadoPor: adminEmail,
          },
          update: {
            nomeGrupo: celula.nomeGrupo,
            categoriaGrupo: celula.categoriaGrupo,
            atualizadoPor: adminEmail,
            versao: { increment: 1 },
          },
        });

        mudancas.push(
          existente
            ? `${onde}: "${existente.nomeGrupo}" -> "${celula.nomeGrupo}"`
            : `${onde}: "${celula.nomeGrupo}"`,
        );
      }
    });

    if (mudancas.length > 0) {
      this.auditoria.registrar('DATA_QUIZ_GRADE_GRUPOS_ALTERADA', {
        ator: adminEmail,
        detalhe: mudancas.join('; '),
      });
    }

    const datas = celulas.map((c) => c.dataIso).sort();
    return this.listar(datas[0], datas[datas.length - 1]);
  }

  /**
   * O grupo que a janela aplica no dia. A regra esta em `grupo-do-dia.ts`; aqui
   * so se busca o que ela precisa.
   *
   * Usado pelo lote E pelo cron: os dois precisam da mesma resposta, porque o
   * cron decide a idempotencia com a celula e o lote grava a execucao com ela.
   */
  async doDia(
    janela: {
      id: number;
      nomeGrupo: string | null;
      categoriaGrupo: string | null;
    },
    data: Date,
  ): Promise<GrupoDoDia> {
    const celula = await this.prisma.grupoDaJanela.findUnique({
      where: { data_janelaDeProvaId: { data, janelaDeProvaId: janela.id } },
      select: { id: true, nomeGrupo: true, categoriaGrupo: true, versao: true },
    });

    // A contagem so e necessaria quando nao ha celula nem nome fixo — e o unico
    // caso em que ela decide alguma coisa. Nos disparos normais, uma consulta.
    const janelaUsaGrade =
      !celula && !janela.nomeGrupo?.trim()
        ? (await this.prisma.grupoDaJanela.count({
            where: { janelaDeProvaId: janela.id },
          })) > 0
        : true;

    return escolherGrupoDoDia({ celula, janela, janelaUsaGrade });
  }

  private exigirSemRepeticao(
    celulas: { dataIso: string; janelaDeProvaId: number }[],
  ): void {
    const vistas = new Set<string>();

    for (const { dataIso, janelaDeProvaId } of celulas) {
      const chave = `${dataIso}#${janelaDeProvaId}`;

      // Duas entradas para a mesma celula: a ultima venceria no loop, e qual das
      // duas a secretaria queria nao ha como saber.
      if (vistas.has(chave)) {
        throw new BadRequestException(
          `A celula ${dataIso} da janela ${janelaDeProvaId} veio duas vezes.`,
        );
      }
      vistas.add(chave);
    }
  }
}
