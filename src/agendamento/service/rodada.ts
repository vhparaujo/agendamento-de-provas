/**
 * O nome legivel da rodada ("Substitutiva (SUB)"), para quem le fora deste
 * sistema e nao sabe o que "SUB" quer dizer.
 *
 * Espelha `nomeDaRodada` do portal (`PortalView.vue`): as duas rodadas que
 * existem hoje ganham texto por extenso, e qualquer outra — o campo e texto
 * livre no cadastro — sai como a secretaria a escreveu. Mostrar o valor cru e
 * melhor que esconder uma rodada que ninguem previu.
 */
const RODADAS_CONHECIDAS: Record<string, string> = {
  N2: 'Regular (N2)',
  SUB: 'Substitutiva (SUB)',
};

export function descricaoDaRodada(rodada: string): string {
  return RODADAS_CONHECIDAS[rodada.trim().toUpperCase()] ?? rodada;
}
