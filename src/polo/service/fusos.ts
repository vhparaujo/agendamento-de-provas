/**
 * Os fusos que um polo pode ter — os do Brasil, pelo NOME IANA.
 *
 * Lista fechada de proposito: um fuso digitado errado ("America/Rio Branco")
 * faria o `Intl` lancar na montagem do special access, e a prova daquele polo
 * inteiro ficaria sem acesso. Com a lista, o erro e recusado no cadastro.
 *
 * O rotulo traz o deslocamento de HOJE so para orientar quem escolhe: quem
 * calcula o instante e o ICU, data a data (`instanteUtcDe`).
 */
export const FUSOS_DO_BRASIL = [
  { fuso: 'America/Noronha', rotulo: 'Fernando de Noronha (UTC-2)' },
  {
    fuso: 'America/Sao_Paulo',
    rotulo: 'Brasilia — DF, GO, MG, SP, RJ, ES, Sul (UTC-3)',
  },
  { fuso: 'America/Bahia', rotulo: 'Bahia (UTC-3)' },
  { fuso: 'America/Fortaleza', rotulo: 'CE, RN, PB, PI, MA (UTC-3)' },
  { fuso: 'America/Recife', rotulo: 'Pernambuco (UTC-3)' },
  { fuso: 'America/Maceio', rotulo: 'Alagoas e Sergipe (UTC-3)' },
  { fuso: 'America/Belem', rotulo: 'Para, leste (UTC-3)' },
  { fuso: 'America/Santarem', rotulo: 'Para, oeste (UTC-3)' },
  { fuso: 'America/Araguaina', rotulo: 'Tocantins (UTC-3)' },
  { fuso: 'America/Campo_Grande', rotulo: 'Mato Grosso do Sul (UTC-4)' },
  { fuso: 'America/Cuiaba', rotulo: 'Mato Grosso (UTC-4)' },
  { fuso: 'America/Manaus', rotulo: 'Amazonas, leste (UTC-4)' },
  { fuso: 'America/Porto_Velho', rotulo: 'Rondonia (UTC-4)' },
  { fuso: 'America/Boa_Vista', rotulo: 'Roraima (UTC-4)' },
  { fuso: 'America/Rio_Branco', rotulo: 'Acre — Cruzeiro do Sul (UTC-5)' },
  { fuso: 'America/Eirunepe', rotulo: 'Amazonas, oeste (UTC-5)' },
] as const;

export type FusoDoBrasil = (typeof FUSOS_DO_BRASIL)[number]['fuso'];

export const NOMES_DOS_FUSOS: readonly string[] = FUSOS_DO_BRASIL.map(
  (f) => f.fuso,
);
