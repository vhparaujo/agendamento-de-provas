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
