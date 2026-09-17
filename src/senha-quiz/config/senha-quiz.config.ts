import { ConfigService } from '@nestjs/config';

/**
 * ============================================================================
 * COM QUE RITMO O LOTE DE SENHAS RODA, E SE O CRON PODE RODAR
 * ============================================================================
 * O que o ADMIN escolhe nao esta aqui, e nao deve voltar para ca:
 *
 * - a grade dia x turno com as senhas mora em `senha_de_prova` (senha de prova
 *   nao entra em arquivo de configuracao, e o cron precisa dela sem humano);
 * - o questionario-alvo e os HORARIOS de cada turno moram em
 *   `configuracao_senha_quiz` (19/08/2026): mudam por semestre, e quem sabe os
 *   dois e a administracao, que nao faz deploy.
 *
 * O que sobra aqui e infraestrutura: a CHAVE que permite o cron rodar nesta
 * instancia, e a velocidade com que o lote fala com a Valence. Sao decisoes de
 * quem opera o servidor, nao de quem opera a prova.
 */

/** Le uma variavel tratando string VAZIA como ausente — mesmo `ler` do d2l.config. */
function ler(config: ConfigService, nome: string, padrao = ''): string {
  return config.get<string>(nome)?.trim() || padrao;
}

function lerNumero(
  config: ConfigService,
  nome: string,
  padrao: number,
): number {
  const valor = Number(ler(config, nome));
  return Number.isFinite(valor) && valor >= 0 ? valor : padrao;
}

export interface RitmoDoLote {
  /**
   * Turmas em paralelo. Menor que os 6 do compulsorio de proposito: la sao duas
   * LEITURAS por aluno, aqui sao ~3 chamadas com ESCRITA no fim.
   */
  concorrencia: number;
  /**
   * Espera antes de cada chamada. O que importa e a RAZAO com a concorrencia:
   * 4 / 400ms ~= 10 req/s contra um tenant que atende o AVA em uso. Mexer num
   * sem olhar o outro nao diz nada.
   */
  atrasoMs: number;
  /** Maior que os 15s do enrollments: objetos de quiz sao grandes. */
  timeoutMs: number;
  /** Trava do laco de paginacao de `GET quizzes/` — nao e otimizacao. */
  maxPaginas: number;
}

export function carregarRitmo(config: ConfigService): RitmoDoLote {
  return {
    concorrencia: Math.max(1, lerNumero(config, 'SENHA_QUIZ_CONCORRENCIA', 4)),
    atrasoMs: lerNumero(config, 'SENHA_QUIZ_DELAY_MS', 400),
    timeoutMs: Math.max(
      1_000,
      lerNumero(config, 'SENHA_QUIZ_TIMEOUT_MS', 30_000),
    ),
    maxPaginas: Math.max(1, lerNumero(config, 'SENHA_QUIZ_MAX_PAGINAS', 50)),
  };
}

export interface ConfigDoCron {
  /**
   * Opt-in, e separado do `D2L_HABILITADO` de proposito: sao coisas diferentes,
   * e deixar o servidor trocar senha sozinho e irreversivel.
   *
   * Continua no .env, e nao na tela junto com os horarios, porque responde outra
   * pergunta: nao "a que horas a prova comeca", mas "ESTA INSTANCIA pode
   * disparar?". E a chave que se desliga numa replica extra, e quem a opera e
   * quem sobe o container.
   */
  habilitado: boolean;
  /** Janela de recuperacao: e o que faz o cron sobreviver a um restart. */
  toleranciaMin: number;
  /** Teto de tentativas REAIS por celula dentro da janela. */
  maxTentativas: number;
}

export function carregarConfigDoCron(config: ConfigService): ConfigDoCron {
  return {
    habilitado: ler(config, 'SENHA_QUIZ_CRON_HABILITADO') === 'true',
    toleranciaMin: lerNumero(config, 'SENHA_QUIZ_CRON_TOLERANCIA_MIN', 30),
    maxTentativas: Math.max(
      1,
      lerNumero(config, 'SENHA_QUIZ_CRON_MAX_TENTATIVAS', 3),
    ),
  };
}
