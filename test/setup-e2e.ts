/**
 * Roda antes de CADA arquivo de e2e.
 *
 * O Jest reaproveita processos entre arquivos de teste, entao qualquer
 * `process.env` que uma suite defina pode ser herdado pela proxima que cair no
 * mesmo worker. Isso deixava o e2e de autenticacao intermitente: quando ele
 * rodava depois do teste do limitador, herdava o limite ligado e tomava 429 nos
 * varios logins que faz de proposito.
 *
 * Zerar aqui torna o ponto de partida identico para todo arquivo, independente
 * da ordem. A suite que precisa do limitador LIGADO (test/seguranca.e2e-spec.ts)
 * redefine a variavel no topo do proprio arquivo, que roda depois deste setup.
 */
process.env.THROTTLE_NOS_TESTES = 'false';

/**
 * A integracao D2L fica DESLIGADA no e2e, explicitamente.
 *
 * Ela e opcional e o e2e nao tem tenant para conversar: ligada, cada suite que
 * agenda tentaria falar com a Valence de verdade, cairia no fallback e ficaria
 * lenta e barulhenta sem testar nada a mais.
 *
 * Isto era implicito ate 18/08/2026, quando o default de `D2L_HABILITADO` virou
 * `true` (ver src/d2l/config/d2l.config.ts). Declarar aqui e o que impede que a
 * proxima mudanca de default reescreva o comportamento de suites que nao falam
 * de D2L nenhum. Quem precisa da integracao LIGADA redefine no proprio arquivo,
 * que roda depois deste setup — mesmo padrao do THROTTLE_NOS_TESTES acima.
 */
process.env.D2L_HABILITADO = 'false';

/**
 * A chave de integracao do e2e. Precisa estar aqui, e nao no arquivo da suite:
 * o `ConfigModule` valida e le o ambiente quando o `AppModule` e importado, e o
 * guard le as chaves quando a aplicacao sobe. Definida depois disso, a suite
 * veria a integracao fechada (401 em tudo).
 */
process.env.INTEGRACAO_API_KEYS = `emissor-e2e:${'e2e0integracao0'.repeat(3)}`;

/**
 * ============================================================================
 * POR QUE `maxWorkers: 1` EM test/jest-e2e.json
 * ============================================================================
 * As suites de e2e compartilham UM banco, e parte do estado e singleton por
 * natureza: o periodo de agendamento vigente e "o mais recente que existir".
 * Duas suites criando periodo em paralelo fazem uma enxergar o periodo da outra.
 *
 * Isso ja aconteceu de verdade: o teste "periodo fechado" do portal passou a
 * falhar de forma intermitente no dia em que a suite do relatorio entrou.
 *
 * Rodar em serie custa poucos segundos e elimina a classe inteira de teste
 * intermitente — e teste que falha as vezes e pior que teste que nao existe,
 * porque ensina o time a ignorar vermelho.
 *
 * (A explicacao vive aqui porque JSON nao aceita comentario, e o Jest reclama de
 * chave desconhecida no proprio arquivo de config.)
 */
