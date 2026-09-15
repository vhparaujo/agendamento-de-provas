import { ConfigService } from '@nestjs/config';
import type { OpcoesDeRitmo } from '../../d2l/service/d2l-quizzes.service';

/**
 * O ritmo das chamadas dos lotes de grupos.
 *
 * Separado do `SENHA_QUIZ_DELAY_MS` de proposito: o lote de senhas roda no
 * horario do cron e nao pode atrasar, enquanto a inscricao roda uma vez, fora de
 * horario de prova, e pode ser mais gentil com o tenant. Sequencial, sem
 * concorrencia: sao milhares de POST pequenos, e paralelizar so trocaria espera
 * por 429.
 */
export function carregarRitmoDosGrupos(config: ConfigService): OpcoesDeRitmo {
  return {
    atrasoMs: lerNumero(config, 'GRUPOS_D2L_DELAY_MS', 400),
    timeoutMs: Math.max(
      1_000,
      lerNumero(config, 'GRUPOS_D2L_TIMEOUT_MS', 30_000),
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
