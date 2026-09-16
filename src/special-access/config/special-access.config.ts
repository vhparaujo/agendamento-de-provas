import { ConfigService } from '@nestjs/config';
import type { OpcoesDeRitmo } from '../../d2l/service/d2l-quizzes.service';

/**
 * O ritmo das chamadas do lote de special access.
 *
 * Separado do `GRUPOS_D2L_DELAY_MS` e do `SENHA_QUIZ_DELAY_MS` de proposito: sao
 * milhares de PUT pequenos (um por aluno por questionario), rodados fora do
 * horario de prova, e quem opera o servidor pode querer ser mais gentil com o
 * tenant aqui sem atrasar o cron da senha. Sequencial, sem concorrencia:
 * paralelizar so trocaria espera por 429.
 */
export function carregarRitmoDoSpecialAccess(
  config: ConfigService,
): OpcoesDeRitmo {
  return {
    atrasoMs: lerNumero(config, 'SPECIAL_ACCESS_DELAY_MS', 400),
    timeoutMs: Math.max(
      1_000,
      lerNumero(config, 'SPECIAL_ACCESS_TIMEOUT_MS', 30_000),
    ),
  };
}

function lerNumero(
  config: ConfigService,
  nome: string,
  padrao: number,
): number {
  const texto = config.get<string>(nome)?.trim();
  const valor = Number(texto);
  return texto && Number.isFinite(valor) && valor >= 0 ? valor : padrao;
}
