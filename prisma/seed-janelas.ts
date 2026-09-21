import { Turno, type PrismaClient } from '../src/generated/prisma/client';
import { ehDoDiaSeguinte } from '../src/senha-quiz/service/janela';

/**
 * ============================================================================
 * AS JANELAS DO QUESTIONARIO NO DIA DA PROVA
 * ============================================================================
 *
 * Uma linha = um DISPARO. `horaDisparo` diz quando o cron aplica; `horaInicio` e
 * `horaFim` sao o `StartDate` e o `EndDate` que o questionario passa a ter.
 * O resultado: no dia da prova o questionario fica aberto SO durante a sessao
 * corrente, e a senha da grade continua sendo o segundo fator.
 *
 * POR QUE POR FORMATO: a duracao da prova vem dele (`Modalidade.duracaoMinutos`
 * — EaD 3h, Semi/Modular 1h30), entao EaD cabe em 3 sessoes por dia e
 * Semi/Modular em 6. Nao ha um calendario unico possivel.
 *
 * ⚠️ `ordem` NAO e a ordem do relogio. E a sequencia da janela dentro do
 * formato, e a primeira e sempre a que dispara a noite com `diaSeguinte` —
 * ela arma a prova da manha seguinte. Ordenar pelo relogio poria a janela da
 * madrugada no fim e faria a tela contar a historia ao contrario.
 *
 * ============================================================================
 * A REGRA QUE GERA OS DISPAROS
 * ============================================================================
 *
 *     horaDisparo = fim da janela ANTERIOR + 1 minuto
 *
 * e a primeira janela do dia e armada na noite anterior, um minuto depois do
 * fim da ULTIMA janela (por isso `diaSeguinte`). O ciclo fecha em si mesmo.
 *
 * O minuto de folga nao e estetica: a janela so pode ser movida depois de a
 * sessao anterior ter FECHADO. Disparar no mesmo minuto do fechamento abriria a
 * prova seguinte enquanto alguem ainda estivesse na anterior — que e exatamente
 * o que este recurso existe para impedir.
 *
 * `diaSeguinte` NAO aparece nas listas abaixo: ele e derivado de
 * `horaDisparo > horaInicio` (`ehDoDiaSeguinte`). O ultimo disparo do dia cai
 * depois da abertura da primeira sessao, entao so pode apontar para amanha —
 * nao ha o que declarar.
 *
 * Vale para os tres formatos ja cadastrados, e e o que permite montar o
 * calendario de um formato novo sem perguntar a ninguem: basta a lista de
 * janelas em ordem de relogio.
 *
 * POR QUE ESTE SEED EXISTE, se `ConfiguracaoSenhaQuiz` recusou default: sao
 * riscos opostos. Um NOME de questionario chutado casa com o questionario errado
 * em toda turma de uma vez, em silencio. Um HORARIO errado nao casa com nada: ou
 * o admin o corrige na tela, ou o dry-run o mostra. O custo de nao semear seria
 * pior — um ambiente novo subiria sem janela nenhuma e o cron nunca dispararia.
 */

/** Uma janela, sem o id do formato (resolvido pelo codigo, no seed). */
interface JanelaSemente {
  ordem: number;
  horaDisparo: string;
  horaInicio: string;
  horaFim: string;
  /**
   * O turno em que a sessao acontece. ROTULO desde 21/09/2026 — ate ali ele
   * dizia de qual celula da grade saia a senha. Ver o schema.
   */
  turno: Turno;
}

/**
 * EaD — 3 sessoes de 3h (`duracaoMinutos: 180`).
 *
 * O ciclo: as 22:01 de segunda o questionario e armado para terca 09:00-12:00;
 * as 12:01 de terca ele passa para 15:00-18:00 do mesmo dia; as 18:01 para
 * 19:00-22:00; e as 22:01 recomeca, apontando para quarta.
 */
const JANELAS_EAD: JanelaSemente[] = [
  {
    ordem: 1,
    horaDisparo: '22:01',
    horaInicio: '09:00',
    horaFim: '12:00',
    turno: Turno.MANHA,
  },
  {
    ordem: 2,
    horaDisparo: '12:01',
    horaInicio: '15:00',
    horaFim: '18:00',
    turno: Turno.TARDE,
  },
  {
    ordem: 3,
    horaDisparo: '18:01',
    horaInicio: '19:00',
    horaFim: '22:00',
    turno: Turno.NOITE,
  },
];

/**
 * Semi e Modular — 6 sessoes de 1h30 (`duracaoMinutos: 90`).
 *
 * Sao dois formatos DISTINTOS no banco que hoje compartilham o calendario
 * (`SEMI` = Semipresencial, `MODULAR` = Modular, a aba "Modular" do CSV).
 * Recebem as mesmas seis linhas em vez de uma tabela compartilhada: e o que
 * permite separa-las na tela no dia em que os horarios divergirem, sem migration.
 */
const JANELAS_SEMI_MODULAR: JanelaSemente[] = [
  {
    ordem: 1,
    horaDisparo: '21:31',
    horaInicio: '08:30',
    horaFim: '10:00',
    turno: Turno.MANHA,
  },
  {
    ordem: 2,
    horaDisparo: '10:01',
    horaInicio: '10:30',
    horaFim: '12:00',
    turno: Turno.MANHA,
  },
  {
    ordem: 3,
    horaDisparo: '12:01',
    horaInicio: '14:00',
    horaFim: '15:30',
    turno: Turno.TARDE,
  },
  {
    ordem: 4,
    horaDisparo: '15:31',
    horaInicio: '16:00',
    horaFim: '17:30',
    turno: Turno.TARDE,
  },
  {
    ordem: 5,
    horaDisparo: '17:31',
    horaInicio: '18:00',
    horaFim: '19:30',
    turno: Turno.NOITE,
  },
  {
    ordem: 6,
    horaDisparo: '19:31',
    horaInicio: '20:00',
    horaFim: '21:30',
    turno: Turno.NOITE,
  },
];

// ✅ RESOLVIDO em 21/09/2026, exatamente onde este comentario dizia que seria.
//
// Ate ali as duas janelas de MANHA (e as duas de TARDE, e as duas de NOITE)
// dividiam a MESMA senha da grade — decisao do cliente em 25/08/2026, ao manter
// a grade com tres turnos —, e o aluno das 08:30 podia repassar a senha ao das
// 10:30. O que o segurava era so a JANELA: as 10:30 o questionario da sessao
// anterior ja esta fechado.
//
// A grade passou a ser `data x JANELA`, como este comentario previa, e cada
// sessao troca a sua senha no proprio disparo. Este arquivo nao mudou por causa
// disso: `turno` continua aqui, agora como rotulo.

/**
 * Presencial — 5 sessoes de 2h (`duracaoMinutos: 120`).
 *
 * Horarios informados pelo cliente em 25/08/2026; os disparos saem da regra do
 * cabecalho (fim da janela anterior + 1 min), sem nada inventado:
 *
 *     08:30-10:30  <- 22:01 da noite anterior (fim de 20:00-22:00)
 *     11:00-13:00  <- 10:31 (fim de 08:30-10:30)
 *     15:00-17:00  <- 13:01 (fim de 11:00-13:00)
 *     17:30-19:30  <- 17:01 (fim de 15:00-17:00)
 *     20:00-22:00  <- 19:31 (fim de 17:30-19:30)
 *
 * ⚠️ **Ela so passa a ter efeito quando houver aluno presencial importado.** O
 * formato da turma e DERIVADO dos agendamentos confirmados, e ate hoje nao
 * houve CSV de alunos na aba Presencial — sem aluno, nenhuma turma resolve para
 * PRESENCIAL e o lote roda em zero turma. O cron dispara e conclui limpo; e
 * `GET /senhas-de-prova/turmas` que mostra a contagem real por formato.
 *
 * O calendario existir antes do primeiro aluno e o certo, e nao adiantamento: a
 * alternativa seria descobrir no dia da primeira prova presencial que nao havia
 * horario nenhum cadastrado.
 */
const JANELAS_PRESENCIAL: JanelaSemente[] = [
  {
    ordem: 1,
    horaDisparo: '22:01',
    horaInicio: '08:30',
    horaFim: '10:30',
    turno: Turno.MANHA,
  },
  {
    ordem: 2,
    horaDisparo: '10:31',
    horaInicio: '11:00',
    horaFim: '13:00',
    turno: Turno.MANHA,
  },
  {
    ordem: 3,
    horaDisparo: '13:01',
    horaInicio: '15:00',
    horaFim: '17:00',
    turno: Turno.TARDE,
  },
  {
    ordem: 4,
    horaDisparo: '17:01',
    horaInicio: '17:30',
    horaFim: '19:30',
    // ⚠️ O UNICO turno deste arquivo que e JULGAMENTO, e nao decorrencia.
    // 17:30 cai bem no vao que os outros formatos deixam entre tarde e noite
    // (Semi vai ate 17:30 de tarde e retoma as 18:00 de noite; EaD vai ate 18:00
    // de tarde e retoma as 19:00). Escolhido TARDE porque 17:30 ainda e tarde no
    // relogio, e porque mantem o formato 2/2/1 — o mesmo agrupamento por periodo
    // do dia que Semi/Modular usa. Se a administracao discordar, e um dropdown na
    // tela: nada no codigo depende desta escolha.
    turno: Turno.TARDE,
  },
  {
    ordem: 5,
    horaDisparo: '19:31',
    horaInicio: '20:00',
    horaFim: '22:00',
    turno: Turno.NOITE,
  },
];

export const JANELAS_POR_MODALIDADE: Record<string, JanelaSemente[]> = {
  EAD: JANELAS_EAD,
  SEMI: JANELAS_SEMI_MODULAR,
  MODULAR: JANELAS_SEMI_MODULAR,
  PRESENCIAL: JANELAS_PRESENCIAL,
};

/**
 * Idempotente, como todo seed do projeto — mas com uma diferenca deliberada:
 * ele NAO sobrescreve janela ja cadastrada.
 *
 * `seedModalidades` pode sobrescrever porque duracao de prova e especificacao,
 * nao configuracao. Aqui o admin edita os horarios na tela, e um `npm run seed`
 * de rotina (que o deploy roda para garantir o primeiro admin) devolveria o
 * calendario semeado por cima do que a administracao acabou de ajustar. O seed
 * CRIA o que falta e nao encosta no que existe.
 */
export async function seedJanelas(prisma: PrismaClient): Promise<void> {
  let criadas = 0;
  let mantidas = 0;

  for (const [codigo, janelas] of Object.entries(JANELAS_POR_MODALIDADE)) {
    const modalidade = await prisma.modalidade.findUnique({
      where: { codigo },
      select: { id: true },
    });

    // Nao cria formato: `seedModalidades` roda antes e e a dona daquela
    // tabela. Se ela nao existe aqui, a ordem do orquestrador mudou.
    if (!modalidade) {
      console.warn(`[seed] janelas: formato ${codigo} nao encontrado; pulando`);
      continue;
    }

    for (const janela of janelas) {
      const existente = await prisma.janelaDeProva.findUnique({
        where: {
          modalidadeId_ordem: {
            modalidadeId: modalidade.id,
            ordem: janela.ordem,
          },
        },
        select: { id: true },
      });

      if (existente) {
        mantidas += 1;
        continue;
      }

      await prisma.janelaDeProva.create({
        data: {
          modalidadeId: modalidade.id,
          ordem: janela.ordem,
          horaDisparo: janela.horaDisparo,
          horaInicio: janela.horaInicio,
          horaFim: janela.horaFim,
          turno: janela.turno,
          // DERIVADO, aqui como em `salvarJanelas`: uma regra so, um lugar so.
          diaSeguinte: ehDoDiaSeguinte(janela.horaDisparo, janela.horaInicio),
          atualizadoPor: 'seed',
        },
      });
      criadas += 1;
    }
  }

  console.log(
    `[seed] janelas de prova: ${criadas} criada(s), ${mantidas} mantida(s) como estavam`,
  );
}
