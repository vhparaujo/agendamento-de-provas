import { Injectable, NotFoundException } from '@nestjs/common';
import JSZip from 'jszip';
import { janelaDeDatas } from '../../agendamento/service/agendamento-admin.service';
import { dataDaProva } from '../../agendamento/service/csv-relatorio';
import { PrismaService } from '../../database/prisma.service';
import { Prisma, StatusAgendamento } from '../../generated/prisma/client';
import { PeriodoService } from '../../periodo/service/periodo.service';
import { csvDeGrupos } from './csv-grupos-d2l';

export interface FiltroRelatorio {
  poloId?: number;
  /** Data da prova (AAAA-MM-DD). */
  de?: string;
  ate?: string;
  periodoLetivoId?: string;
}

export interface FaixaExportavel {
  faixaId: number;
  poloId: number;
  polo: string;
  data: Date;
  horaInicio: string;
  horaFim: string;
  /** Matriculas distintas com prova confirmada nesta faixa. */
  totalAlunos: number;
  /** Nome com que o arquivo desta faixa e baixado. */
  nomeArquivo: string;
}

export interface ArquivoGerado {
  nomeArquivo: string;
  conteudo: string | Buffer;
}

/**
 * ============================================================================
 * GRUPOS PARA O BRIGHTSPACE — UM ARQUIVO POR FAIXA
 * ============================================================================
 * A pergunta aqui e outra, e nao se confunda com `GET /agendamentos/exportacao`:
 * aquele responde "com quem a secretaria precisa falar" (TODOS os vinculos,
 * agendados ou nao, 12 colunas, formato de Excel). Este responde "quem entra no
 * grupo desta prova no Brightspace" — so quem tem prova marcada, so a matricula,
 * no formato que o *Groups Import* aceita.
 *
 * Tres regras que nao sao acidente:
 *
 * 1. **O recorte e por FAIXA, nao por sala.** O grupo no D2L existe para liberar
 *    o quiz num horario; em qual sala fisica a pessoa vai sentar nao muda o
 *    acesso. Por isso as salas da faixa entram na mesma lista.
 * 2. **Uma matricula aparece UMA vez.** Um RA com dois vinculos na mesma
 *    modalidade pode ter dois agendamentos na mesma faixa. O grupo e por
 *    USUARIO, e a linha repetida faria o import do D2L reclamar ou duplicar.
 * 3. **So `CONFIRMADO`, e so o periodo letivo do recorte.** Quem cancelou nao
 *    pode receber acesso ao quiz; e sem o recorte de periodo, a prova do
 *    semestre passado colocaria gente no grupo deste semestre.
 */
@Injectable()
export class RelatorioService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly periodo: PeriodoService,
  ) {}

  /** As faixas do recorte, com quantas pessoas cada arquivo teria. */
  async listarFaixas(filtro: FiltroRelatorio): Promise<FaixaExportavel[]> {
    const periodoLetivoId = await this.periodoDoRecorte(filtro);
    const ondeFaixa = this.ondeFaixa(filtro);

    const [faixas, matriculas] = await Promise.all([
      this.prisma.faixa.findMany({
        where: ondeFaixa,
        include: { polo: { select: { id: true, nome: true } } },
        orderBy: [{ data: 'asc' }, { horaInicio: 'asc' }, { id: 'asc' }],
      }),
      this.matriculasPorFaixa(ondeFaixa, periodoLetivoId),
    ]);

    return faixas.map((faixa) => ({
      faixaId: faixa.id,
      poloId: faixa.polo.id,
      polo: faixa.polo.nome,
      data: faixa.data,
      horaInicio: faixa.horaInicio,
      horaFim: faixa.horaFim,
      totalAlunos: matriculas.get(faixa.id)?.length ?? 0,
      nomeArquivo: nomeDoArquivo(faixa),
    }));
  }

  /** O CSV de uma faixa. Faixa sem ninguem sai so com o cabecalho. */
  async csvDaFaixa(
    faixaId: number,
    filtro: FiltroRelatorio,
  ): Promise<ArquivoGerado> {
    const faixa = await this.prisma.faixa.findUnique({
      where: { id: faixaId },
    });

    if (!faixa) {
      throw new NotFoundException('Faixa nao encontrada');
    }

    const periodoLetivoId = await this.periodoDoRecorte(filtro);
    const porFaixa = await this.matriculasPorFaixa(
      { id: faixaId },
      periodoLetivoId,
    );

    return {
      nomeArquivo: nomeDoArquivo(faixa),
      conteudo: csvDeGrupos(porFaixa.get(faixaId) ?? []),
    };
  }

  /**
   * Um zip com o CSV de cada faixa do recorte.
   *
   * Faixa **sem ninguem fica de fora**: um arquivo so de cabecalho nao tem o que
   * importar, e o zip e para levar direto ao Brightspace. Na tela a faixa vazia
   * continua aparecendo, com `totalAlunos: 0` — la a informacao e util.
   */
  async zipDasFaixas(filtro: FiltroRelatorio): Promise<ArquivoGerado> {
    const faixas = await this.listarFaixas(filtro);
    const periodoLetivoId = await this.periodoDoRecorte(filtro);
    const porFaixa = await this.matriculasPorFaixa(
      this.ondeFaixa(filtro),
      periodoLetivoId,
    );

    const zip = new JSZip();
    const usados = new Set<string>();

    for (const faixa of faixas) {
      const matriculas = porFaixa.get(faixa.faixaId) ?? [];

      if (matriculas.length === 0) continue;

      zip.file(
        nomeSemColisao(faixa.nomeArquivo, faixa.faixaId, usados),
        csvDeGrupos(matriculas),
      );
    }

    return {
      nomeArquivo: `Grupos D2L-${carimboDeHora()}.zip`,
      conteudo: await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
      }),
    };
  }

  /**
   * Matriculas DISTINTAS por faixa.
   *
   * Uma consulta so para todas as faixas do recorte, e nao uma por faixa: a
   * listagem e o zip precisam exatamente do mesmo dado, e o N+1 apareceria logo
   * no primeiro semestre com muitos horarios abertos.
   */
  private async matriculasPorFaixa(
    ondeFaixa: Prisma.FaixaWhereInput,
    periodoLetivoId: string | undefined,
  ): Promise<Map<number, string[]>> {
    const agendamentos = await this.prisma.agendamento.findMany({
      where: {
        status: StatusAgendamento.CONFIRMADO,
        periodoLetivoId,
        salaFaixa: { faixa: ondeFaixa },
      },
      select: { matricula: true, salaFaixa: { select: { faixaId: true } } },
      orderBy: { matricula: 'asc' },
    });

    const porFaixa = new Map<number, Set<string>>();

    for (const { matricula, salaFaixa } of agendamentos) {
      const conjunto = porFaixa.get(salaFaixa.faixaId) ?? new Set<string>();

      conjunto.add(matricula);
      porFaixa.set(salaFaixa.faixaId, conjunto);
    }

    return new Map(
      [...porFaixa].map(([faixaId, conjunto]) => [faixaId, [...conjunto]]),
    );
  }

  private ondeFaixa(filtro: FiltroRelatorio): Prisma.FaixaWhereInput {
    return { poloId: filtro.poloId, data: janelaDeDatas(filtro) };
  }

  private periodoDoRecorte(
    filtro: FiltroRelatorio,
  ): Promise<string | undefined> | string {
    return filtro.periodoLetivoId ?? this.periodo.periodoLetivoVigente();
  }
}

/**
 * `20-07-2026 08h30-11h30.csv`
 *
 * Sem polo e sem sala por decisao do cliente: o que identifica o grupo la no
 * Brightspace e o horario da prova. E o formato so usa digito, espaco, `-` e
 * `h` — `/` e `:` sao invalidos em nome de arquivo (`:` quebra no Windows), e
 * ficar em ASCII puro dispensa o `filename*=UTF-8''` do RFC 5987 no
 * Content-Disposition.
 */
function nomeDoArquivo(faixa: {
  data: Date;
  horaInicio: string;
  horaFim: string;
}): string {
  const dia = dataDaProva(faixa.data).replace(/\//g, '-');
  const inicio = faixa.horaInicio.replace(':', 'h');
  const fim = faixa.horaFim.replace(':', 'h');

  return `${dia} ${inicio}-${fim}.csv`;
}

/**
 * Sem o polo no nome, duas faixas do MESMO dia e horario em polos diferentes
 * geram o mesmo nome — e isso e o caso normal de operacao, nao a excecao. Dentro
 * de um zip o segundo arquivo sobrescreveria o primeiro em silencio, entao a
 * partir do segundo o id da faixa entra como desempate.
 */
function nomeSemColisao(
  nome: string,
  faixaId: number,
  usados: Set<string>,
): string {
  if (!usados.has(nome)) {
    usados.add(nome);
    return nome;
  }

  return nome.replace(/\.csv$/, ` #${faixaId}.csv`);
}

/** Dois zips baixados no mesmo dia nao se confundem na pasta de downloads. */
function carimboDeHora(): string {
  return new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
}
