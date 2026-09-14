import { Injectable, Logger } from '@nestjs/common';

/**
 * Eventos de seguranca auditaveis (ASVS 5.0 16.3.1–16.3.4).
 *
 * A lista e fechada de proposito: evento novo entra aqui, e nao como string
 * solta espalhada pelos services. Assim da para grepar tudo que e auditado num
 * lugar so, e o log fica consultavel por nome de evento.
 */
export type EventoSeguranca =
  | 'LOGIN_OK'
  | 'LOGIN_FALHOU'
  | 'REFRESH_OK'
  | 'REFRESH_FALHOU'
  | 'SENHA_TROCADA'
  | 'SENHA_TROCA_FALHOU'
  | 'ADMIN_CRIADO'
  | 'ADMIN_SENHA_RESETADA'
  | 'ADMIN_ATIVO_ALTERADO'
  | 'LTI_LAUNCH_OK'
  | 'LTI_LAUNCH_RECUSADO'
  // Troca do codigo do redirect pelo token, feita pelo portal do aluno.
  | 'LTI_SESSAO_OK'
  | 'LTI_SESSAO_RECUSADA'
  | 'AGENDAMENTO_CRIADO'
  | 'AGENDAMENTO_RECUSADO'
  | 'AGENDAMENTO_REMANEJADO'
  | 'AGENDAMENTO_CANCELADO'
  // O lote que agenda por quem nao agendou. Sao tres eventos e nao um porque a
  // pergunta de auditoria e "quem mandou alocar 4 mil pessoas, e deu no que?" —
  // o inicio sozinho nao responde se aquilo chegou ao fim.
  | 'COMPULSORIO_INICIADO'
  | 'COMPULSORIO_CONCLUIDO'
  | 'COMPULSORIO_FALHOU'
  // Duas linhas de aluno viraram uma, e a absorvida deixou de existir. Auditavel
  // por ser IRREVERSIVEL e por mover prova de um vinculo para outro — se algum
  // dia a prova de alguem aparecer no cadastro errado, e aqui que se descobre
  // quem mesclou o que.
  | 'VINCULOS_MESCLADOS'
  // Um periodo de agendamento deixou de existir. Auditavel porque a linha
  // apagada e o que define QUAL semestre o portal do aluno enxerga: apagar o
  // mais recente entrega o portal ao anterior, e a mudanca nao aparece em
  // lugar nenhum alem daqui.
  | 'PERIODO_REMOVIDO'
  // O criterio de nota da janela mudou DEPOIS de ja haver reserva nela. Nao e
  // bloqueado (a nota nao e fotografia do periodo, e mexer nela so muda quem
  // agenda daqui para a frente), mas e a alteracao que faz um aluno elegivel
  // ontem deixar de ser hoje — e a pergunta "quem mudou isso?" vai aparecer.
  | 'PERIODO_FILTRO_DE_NOTA_ALTERADO'
  | 'D2L_AUTORIZACAO_OK'
  | 'D2L_AUTORIZACAO_FALHOU'
  | 'D2L_TOKEN_RENOVADO'
  | 'D2L_TOKEN_RENOVACAO_FALHOU'
  // Senha dos questionarios. NENHUM destes leva a senha em `detalhe` — so a
  // celula (data + turno), contagens e quem disparou. Ver a postura de seguranca
  // no cabecalho de src/senha-quiz/service/senha-quiz.service.ts.
  | 'SENHA_QUIZ_GRADE_ALTERADA'
  | 'SENHA_QUIZ_GRADE_REMOVIDA'
  | 'SENHA_QUIZ_REVELADA'
  // Configuracao do lote. Sao auditaveis porque decidem QUAIS questionarios
  // sao reescritos e QUANDO — e um erro nos dois so aparece no dia da prova.
  | 'SENHA_QUIZ_ALVO_ALTERADO'
  | 'SENHA_QUIZ_HORARIOS_ALTERADOS'
  | 'SENHA_QUIZ_INICIADA'
  | 'SENHA_QUIZ_CONCLUIDA'
  | 'SENHA_QUIZ_FALHOU'
  | 'SENHA_QUIZ_CRON_SEM_GRADE'
  // Cron ligado no servidor e nenhum horario cadastrado na tela: ele nunca
  // dispararia, e sem este aviso ninguem descobriria antes do dia.
  | 'SENHA_QUIZ_CRON_SEM_HORARIO'
  | 'SENHA_QUIZ_CRON_IGNORADO'
  // Datas dos questionarios (25/08/2026). O mesmo lote, outro recorte: uma
  // JANELA (horario de abertura e fechamento) aplicada nas turmas de UMA
  // modalidade. Separados dos de senha de proposito — quem investiga "por que a
  // prova abriu as 16h?" nao quer as trocas de senha no meio, e vice-versa.
  | 'DATA_QUIZ_JANELAS_ALTERADAS'
  // A grade dia x janela dos grupos (14/09/2026). Auditavel pelo mesmo motivo
  // que as janelas: decide PARA QUEM a prova abre naquele dia, e "quem trocou o
  // grupo de terca?" precisa ter resposta.
  | 'DATA_QUIZ_GRADE_GRUPOS_ALTERADA'
  // O lote de datas comecou num dia em que a janela usa a grade de grupos e a
  // celula estava vazia. A data entra; o grupo fica o da sessao anterior.
  | 'DATA_QUIZ_SEM_GRUPO_NO_DIA'
  // O desempate manual de uma turma ambigua (10/09/2026). Auditavel pelo mesmo
  // motivo que as janelas: decide EM QUE HORARIO uma turma inteira abre a
  // prova. E a unica decisao da aba que o sistema se recusa a tomar sozinho,
  // entao ela precisa ter dono — inclusive quando der errado.
  | 'DATA_QUIZ_MODALIDADE_ESCOLHIDA'
  | 'DATA_QUIZ_MODALIDADE_ESCOLHA_REMOVIDA'
  | 'DATA_QUIZ_INICIADA'
  | 'DATA_QUIZ_CONCLUIDA'
  | 'DATA_QUIZ_FALHOU'
  // A janela chegou e nao havia senha na celula daquele turno. O lote de datas
  // PRECISA da senha (o PUT substitui o objeto inteiro e nao pode preservar a
  // lida), entao aqui isto nao e so aviso: a janela nao foi aplicada.
  | 'DATA_QUIZ_CRON_SEM_GRADE'
  | 'DATA_QUIZ_CRON_SEM_JANELA'
  | 'DATA_QUIZ_CRON_IGNORADO'
  // Havia janela no horario e nenhuma precisou disparar (ja aplicada, rodando,
  // ou teto de tentativas). NAO e falha — e o estado normal da maior parte dos
  // ticks da janela de tolerancia. Existe porque um cron que encontra trabalho e
  // nao faz nada, calado, e indistinguivel de um cron quebrado.
  | 'DATA_QUIZ_CRON_NADA_A_FAZER'
  // Outro sistema leu os dados de agendamento de UMA matricula (nome, curso,
  // polo, sala, disciplinas). Toda leitura de dado pessoal por terceiro fica
  // rastreavel: "quem consultou o RA tal, e quando?" precisa ter resposta.
  | 'INTEGRACAO_CONSULTA'
  | 'ACESSO_NEGADO'
  | 'LIMITE_REQUISICOES'
  | 'ROTA_SEM_CONTROLE_DE_ACESSO'
  | 'ERRO_INTERNO';

export interface ContextoEvento {
  /** Quem: e-mail do admin, matricula do aluno, ou undefined se anonimo. */
  ator?: string;
  /** Onde: metodo + rota. */
  rota?: string;
  ip?: string;
  /** O que mais importar para investigar depois. Nunca senha, token ou hash. */
  detalhe?: string;
  /** Correlaciona a linha de log com o id devolvido ao cliente num 500. */
  erroId?: string;
}

/**
 * Campos que NUNCA podem ser passados em `detalhe`. Nao ha checagem automatica
 * — e disciplina de quem chama. Documentado aqui para nao restar duvida:
 * senha, senha provisoria, hash, access token, refresh token, id_token do LTI.
 */
@Injectable()
export class AuditoriaService {
  private readonly logger = new Logger('Seguranca');

  /**
   * Uma linha JSON por evento, com quando/onde/quem/o-que (ASVS 16.2.1).
   *
   * Formato estruturado porque log de seguranca serve para ser consultado, nao
   * lido: `grep LOGIN_FALHOU | jq` responde "quantas tentativas contra este
   * e-mail na ultima hora" sem parsear texto livre.
   */
  registrar(evento: EventoSeguranca, contexto: ContextoEvento = {}): void {
    const linha = JSON.stringify({
      evento,
      quando: new Date().toISOString(),
      ator: limpar(contexto.ator),
      rota: limpar(contexto.rota),
      ip: limpar(contexto.ip),
      detalhe: limpar(contexto.detalhe),
      erroId: contexto.erroId,
    });

    if (EVENTOS_DE_FALHA.has(evento)) {
      this.logger.warn(linha);
      return;
    }

    this.logger.log(linha);
  }
}

const EVENTOS_DE_FALHA = new Set<EventoSeguranca>([
  'LOGIN_FALHOU',
  'REFRESH_FALHOU',
  'SENHA_TROCA_FALHOU',
  'LTI_LAUNCH_RECUSADO',
  'LTI_SESSAO_RECUSADA',
  'AGENDAMENTO_RECUSADO',
  'D2L_AUTORIZACAO_FALHOU',
  'D2L_TOKEN_RENOVACAO_FALHOU',
  'ACESSO_NEGADO',
  'LIMITE_REQUISICOES',
  'ROTA_SEM_CONTROLE_DE_ACESSO',
  'ERRO_INTERNO',
  'SENHA_QUIZ_FALHOU',
  // Nao e erro de sistema, mas e o alerta que evita alunos travados na prova: o
  // cron acordou no horario e nao havia senha cadastrada para aquele turno.
  'SENHA_QUIZ_CRON_SEM_GRADE',
  'SENHA_QUIZ_CRON_SEM_HORARIO',
  'DATA_QUIZ_FALHOU',
  // Mesmo peso que os de senha, e pela mesma razao: a janela chegou e o
  // questionario nao foi aberto. A diferenca e que aqui a prova fica com a data
  // do turno ANTERIOR — ou seja, fechada.
  'DATA_QUIZ_CRON_SEM_GRADE',
  'DATA_QUIZ_CRON_SEM_JANELA',
  // A prova abre no horario certo para o grupo da sessao ANTERIOR — o mesmo
  // peso de `gruposPendentes` na tela.
  'DATA_QUIZ_SEM_GRUPO_NO_DIA',
]);

/**
 * Neutraliza log injection (ASVS 16.4.1). Boa parte do que chega aqui vem do
 * cliente — e-mail do login, rota, User-Agent. Sem isso, um "e-mail" contendo
 * `\n{"evento":"LOGIN_OK"...}` forjaria uma linha de auditoria inteira e
 * envenenaria qualquer investigacao futura.
 *
 * O JSON.stringify ja escaparia as aspas e quebras, mas a limpeza acontece
 * antes de proposito: o dia em que alguem trocar o formato do log por texto
 * simples, a protecao continua de pe.
 */
function limpar(valor?: string): string | undefined {
  if (valor === undefined) return undefined;

  return (
    valor
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .slice(0, 300)
      .trim()
  );
}
