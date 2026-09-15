import { BadRequestException } from '@nestjs/common';
import { dataUtcDeIso } from '../../senha-quiz/service/relogio';

export const PADRAO_DIA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Teto do intervalo. Um semestre de provas cabe folgado; o teto existe para que
 * um `ate` digitado com o ano errado nao carregue a grade de uma decada.
 */
export const MAXIMO_DE_DIAS = 180;

export interface IntervaloDeDias {
  /** "AAAA-MM-DD" */
  de: string;
  ate: string;
  deData: Date;
  ateData: Date;
}

/** Os DIAS DE PROVA que a tela e o lote consideram. */
export function intervaloDeDias(
  de: string | undefined,
  ate: string | undefined,
): IntervaloDeDias {
  if (!de || !ate || !PADRAO_DIA.test(de) || !PADRAO_DIA.test(ate)) {
    throw new BadRequestException(
      'Informe `de` e `ate` em AAAA-MM-DD: os grupos sao sempre de um intervalo de dias de prova.',
    );
  }

  const deData = dataUtcDeIso(de);
  const ateData = dataUtcDeIso(ate);

  if (Number.isNaN(deData.getTime()) || Number.isNaN(ateData.getTime())) {
    throw new BadRequestException(`Data invalida no intervalo ${de} a ${ate}.`);
  }

  if (ateData < deData) {
    throw new BadRequestException(
      `O fim do intervalo (${ate}) vem antes do inicio (${de}).`,
    );
  }

  const dias = (ateData.getTime() - deData.getTime()) / 86_400_000 + 1;

  if (dias > MAXIMO_DE_DIAS) {
    throw new BadRequestException(
      `O intervalo tem ${dias} dias; o maximo e ${MAXIMO_DE_DIAS}. Confira o ano das datas.`,
    );
  }

  return { de, ate, deData, ateData };
}
