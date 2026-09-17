/**
 * Traduz as mensagens AUTOMATICAS (em ingles, de programador) que o Nest e o
 * class-validator geram, para o texto que aparece na tela do admin e do aluno.
 *
 * Quem le o aviso e a administracao, nao um programador: "poloId must not be less
 * than 1" ou "Cannot GET /api/x" nao dizem o que houve nem o que fazer. As
 * mensagens de negocio escritas a mao (em portugues) nao casam com nenhum
 * padrao daqui e passam intactas.
 *
 * O texto ORIGINAL continua indo para a auditoria (`mensagemDe` no filtro): e
 * ele que ajuda quem for investigar.
 */

/**
 * Nome legivel dos campos mais comuns dos DTOs. O que nao estiver aqui cai em
 * `rotuloDoCampo`, que separa o camelCase — legivel, mas sem acento.
 */
const ROTULOS: Record<string, string> = {
  nome: 'nome',
  cidade: 'cidade',
  fuso: 'fuso',
  ativo: 'ativo',
  email: 'e-mail',
  senha: 'senha',
  senhaAtual: 'senha atual',
  novaSenha: 'nova senha',
  descricao: 'descrição',
  capacidade: 'capacidade',
  vagas: 'vagas',
  matricula: 'matrícula',
  codigo: 'código',
  codigoTurma: 'código da turma',
  rodada: 'rodada',
  turno: 'turno',
  data: 'data',
  dataAbertura: 'data de abertura',
  dataFechamento: 'data de fechamento',
  horaInicio: 'hora de início',
  horaFim: 'hora de término',
  duracaoMinutos: 'duração (minutos)',
  periodoLetivoId: 'período letivo',
  periodoLetivoIds: 'períodos letivos',
  modalidadeId: 'formato',
  modalidade: 'formato',
  pagina: 'página',
  porPagina: 'itens por página',
  motivo: 'motivo',
};

/** `dataDeAbertura` -> "data de abertura"; `poloId` -> "polo"; `faixas.0.horaInicio` -> "hora de início". */
export function rotuloDoCampo(caminho: string): string {
  const campo = caminho.split('.').pop() ?? caminho;

  if (ROTULOS[campo]) return ROTULOS[campo];

  return campo
    .replace(/Ids?$/, (id) => (id === 'Ids' ? 's' : ''))
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();
}

/** Campos que guardam o id de uma escolha feita num select (polo, sala, faixa...). */
const ehIdDeEscolha = (caminho: string) =>
  /Ids?$/.test(caminho.split('.').pop() ?? '');

type Traducao = (campo: string, valor: string, caminho: string) => string;

/**
 * Um padrao por mensagem padrao do class-validator 0.15. `(\S+)` e o caminho do
 * campo (o ValidationPipe prefixa os aninhados: `faixas.0.horaInicio`).
 */
const VALIDACOES: [RegExp, Traducao][] = [
  [
    /^property (\S+) should not exist$/,
    (c) =>
      `O sistema recebeu uma informação que não esperava ("${c}"). Atualize a ` +
      'página e tente de novo; se continuar, avise o suporte.',
  ],
  [/^(\S+) should not be empty$/, (c) => `Preencha o campo "${c}".`],
  [/^(\S+) must be a string$/, (c) => `O campo "${c}" deve ser um texto.`],
  [
    /^(\S+) must be an integer number$/,
    (c, _, caminho) =>
      ehIdDeEscolha(caminho)
        ? `Selecione uma opção válida em "${c}".`
        : `O campo "${c}" deve ser um número inteiro.`,
  ],
  [
    /^(\S+) must be a number conforming to the specified constraints$/,
    (c) => `O campo "${c}" deve ser um número.`,
  ],
  [
    /^(\S+) must be a number string$/,
    (c) => `O campo "${c}" deve conter apenas números.`,
  ],
  [
    /^(\S+) must be a boolean (value|string)$/,
    (c) => `O campo "${c}" deve ser sim ou não.`,
  ],
  [/^(\S+) must be an array$/, (c) => `O campo "${c}" deve ser uma lista.`],
  [
    /^(\S+) must be one of the following values: .*$/s,
    (c) => `Escolha uma das opções válidas em "${c}".`,
  ],
  [
    /^(\S+) must be a valid ISO 8601 date string$/,
    (c) => `Informe uma data válida em "${c}".`,
  ],
  [/^(\S+) must be an email$/, () => 'Informe um e-mail válido.'],
  [
    /^(\S+) must not be less than (\S+)$/,
    (c, v, caminho) =>
      ehIdDeEscolha(caminho)
        ? `Selecione uma opção válida em "${c}".`
        : `O campo "${c}" deve ser no mínimo ${v}.`,
  ],
  [
    /^(\S+) must not be greater than (\S+)$/,
    (c, v) => `O campo "${c}" deve ser no máximo ${v}.`,
  ],
  [
    /^(\S+) must be longer than or equal to (\d+) characters$/,
    (c, v) => `O campo "${c}" deve ter pelo menos ${v} caracteres.`,
  ],
  [
    /^(\S+) must be shorter than or equal to (\d+) characters$/,
    (c, v) => `O campo "${c}" deve ter no máximo ${v} caracteres.`,
  ],
  [
    /^(\S+) must match .* regular expression$/s,
    (c) => `O campo "${c}" está em um formato inválido.`,
  ],
  [
    /^(\S+) must contain at least (\d+) elements$/,
    (c, v) => `Selecione pelo menos ${v} item(ns) em "${c}".`,
  ],
  [
    /^(\S+) must contain no more than (\d+) elements$/,
    (c, v) => `Selecione no máximo ${v} itens em "${c}".`,
  ],
  [/^(\S+) must be a jwt string$/, () => 'Sessão inválida. Entre novamente.'],
  [
    /^nested property (\S+) must be either object or array$/,
    (c) => `O campo "${c}" está em um formato inválido.`,
  ],
];

/** Mensagens padrao do proprio Nest (pipes, roteador, guards, throttler, upload). */
const PADROES_DO_NEST: [RegExp, string][] = [
  [
    /^Cannot (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /,
    'Esta função não foi encontrada no sistema. Atualize a página; se continuar, avise o suporte.',
  ],
  [
    /^ThrottlerException/,
    'Muitas tentativas seguidas. Aguarde um instante e tente de novo.',
  ],
  [/^File is required$/, 'Selecione um arquivo para enviar.'],
  [/^File too large$/i, 'O arquivo é grande demais para ser enviado.'],
  [/^Validation failed \(.*file type/i, 'Tipo de arquivo não aceito.'],
  [
    /^Validation failed \(current file size/i,
    'O arquivo é grande demais para ser enviado.',
  ],
  [
    /^Validation failed/,
    'Um dos valores enviados é inválido. Atualize a página e tente de novo.',
  ],
  [/^Unauthorized$/, 'Sua sessão expirou ou não é válida. Entre novamente.'],
  [/^Forbidden resource$/, 'Você não tem permissão para fazer isso.'],
  [
    /^Not Found$/,
    'Não encontrado. O registro pode ter sido removido; atualize a página.',
  ],
  [
    /^Bad Request$/,
    'Não foi possível concluir. Confira os dados e tente de novo.',
  ],
  [
    /^Conflict$/,
    'Não foi possível concluir por conflito com dados já existentes.',
  ],
  [/^Payload Too Large$/i, 'O conteúdo enviado é grande demais.'],
  [
    /^Unexpected field$/,
    'Não foi possível receber o arquivo. Atualize a página e tente de novo.',
  ],
];

/** Traduz UMA mensagem; o que nao for padrao conhecido volta como veio. */
export function mensagemAmigavel(mensagem: string): string {
  const cadaItem = /^each value in (.+)$/s.exec(mensagem);

  if (cadaItem) {
    const campo = /^(?:nested property )?(\S+)/.exec(cadaItem[1])?.[1] ?? '';
    return `Um dos itens de "${rotuloDoCampo(campo)}" é inválido.`;
  }

  for (const [padrao, traduzir] of VALIDACOES) {
    const casou = padrao.exec(mensagem);
    if (casou) {
      return traduzir(rotuloDoCampo(casou[1]), casou[2] ?? '', casou[1]);
    }
  }

  for (const [padrao, texto] of PADROES_DO_NEST) {
    if (padrao.test(mensagem)) return texto;
  }

  return mensagem;
}

/**
 * Aplica `mensagemAmigavel` ao corpo de uma HttpException, preservando o resto
 * (`statusCode`, `error` e campos extras que o front usa). Array de mensagens do
 * ValidationPipe continua array — o front junta os itens.
 */
export function corpoAmigavel(
  corpo: string | object,
  statusCode: number,
): object {
  if (typeof corpo === 'string') {
    return { statusCode, message: mensagemAmigavel(corpo) };
  }

  const { message } = corpo as { message?: unknown };

  if (typeof message === 'string') {
    return { ...corpo, message: mensagemAmigavel(message) };
  }

  if (Array.isArray(message)) {
    const traduzidas = (message as unknown[]).map((m): unknown =>
      typeof m === 'string' ? mensagemAmigavel(m) : m,
    );
    // Dois campos com a mesma falha viram a mesma frase; repetir so polui o aviso.
    return { ...corpo, message: [...new Set(traduzidas)] };
  }

  return corpo;
}
