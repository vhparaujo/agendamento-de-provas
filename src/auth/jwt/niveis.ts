import { NivelAdmin } from '../../generated/prisma/client';

/**
 * ============================================================================
 * OS NIVEIS DE ADMIN — E POR QUE ELES NAO SAO UMA HIERARQUIA
 * ============================================================================
 * Ate 21/09/2026 nao havia nivel nenhum: um JWT de admin valido dava acesso a
 * tudo. Agora sao tres, e o que separa um do outro e uma LISTA DE TELAS, nao um
 * numero:
 *
 *   SUPERADMIN             — tudo, inclusive criar admins e escolher o nivel
 *                            deles. E o unico que mexe na tela de Admins;
 *   ASSISTENTE_OPERACIONAL — Inicio, Faixas, Polos e salas, Alunos, Relatorios,
 *                            mais Agendamentos e Senhas em SOMENTE LEITURA;
 *   VISUALIZADOR_EXECUTIVO — so a tela inicial, para acompanhar os numeros.
 *
 * Nao existe `nivel >= X`: o assistente enxerga telas que o executivo nao
 * enxerga, mas nenhum dos dois e "meio superadmin" — o superadmin abre rotas
 * (gestao de admins, disparo de lote no AVA) que nao sao "mais" das mesmas
 * coisas, e sim outras coisas. Comparar numeros aqui seria inventar uma ordem
 * que a especificacao nao tem, e o primeiro nivel novo quebraria a conta.
 *
 * ---------------------------------------------------------------------------
 * COMO UMA ROTA DECLARA QUEM A ABRE
 * ---------------------------------------------------------------------------
 * `@SomenteAdmin()` continua significando "precisa de JWT de admin". O nivel e
 * declarado A PARTE, com `@NiveisPermitidos(...)`:
 *
 *   @SomenteAdmin()                       -> SO superadmin (padrao fechado)
 *   @NiveisPermitidos(ASSISTENTE)         -> superadmin + assistente
 *   @NiveisPermitidos(ASSISTENTE, EXEC)   -> os tres
 *
 * **Rota de admin sem `@NiveisPermitidos` e rota de superadmin.** E a mesma
 * postura do AutenticacaoGuard (`docs`: nega por padrao): o esquecimento fecha
 * a rota em vez de abrir. Quando alguem criar o proximo controller e esquecer o
 * decorator, o assistente toma 403 e reclama — em vez de o sistema entregar,
 * calado, a gestao de administradores a quem nao deveria te-la.
 *
 * O SUPERADMIN nunca precisa ser listado: ele passa em tudo, por definicao.
 */
export const TODOS_OS_NIVEIS: NivelAdmin[] = [
  NivelAdmin.SUPERADMIN,
  NivelAdmin.ASSISTENTE_OPERACIONAL,
  NivelAdmin.VISUALIZADOR_EXECUTIVO,
];

/** Como cada nivel e chamado na tela e nas mensagens de erro. */
export const ROTULO_DO_NIVEL: Record<NivelAdmin, string> = {
  SUPERADMIN: 'Superadministrador',
  ASSISTENTE_OPERACIONAL: 'Administrador Assistente Operacional',
  VISUALIZADOR_EXECUTIVO: 'Administrador Visualizador Executivo',
};

/**
 * O nivel abre a rota?
 *
 * `permitidos` e o que o handler declarou em `@NiveisPermitidos` — `undefined`
 * quando ele nao declarou nada, que e justamente o caso "so superadmin".
 */
export function nivelPermitido(
  nivel: NivelAdmin | undefined,
  permitidos: NivelAdmin[] | undefined,
): boolean {
  // Token emitido antes de a coluna existir. Nao vale como superadmin: quem
  // nao diz o proprio nivel nao passa. Ver JwtAdminStrategy.
  if (!nivel) return false;

  if (nivel === NivelAdmin.SUPERADMIN) return true;

  return permitidos?.includes(nivel) ?? false;
}
