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
