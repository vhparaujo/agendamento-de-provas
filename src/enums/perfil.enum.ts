/**
 * Os perfis do sistema. Nao existe hierarquia entre eles nem niveis dentro do
 * admin: um JWT de admin valido da acesso total (especificacao, secao 2.2).
 *
 * `INTEGRACAO` nao e uma pessoa: e OUTRO SISTEMA, autenticado por API key (ver
 * `ApiKeyIntegracaoGuard`). Ele so abre as rotas marcadas com
 * `@SomenteIntegracao()` — nao vale como admin nem como aluno.
 */
export enum Perfil {
  ADMIN = 'ADMIN',
  ALUNO = 'ALUNO',
  INTEGRACAO = 'INTEGRACAO',
}
