/**
 * Os dois perfis do sistema. Nao existe hierarquia entre eles nem niveis dentro
 * do admin: um JWT de admin valido da acesso total (especificacao, secao 2.2).
 */
export enum Perfil {
  ADMIN = 'ADMIN',
  ALUNO = 'ALUNO',
}
