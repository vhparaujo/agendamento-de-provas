import {
  CLAIM_CUSTOM,
  CLAIM_LIS,
  lerClaim,
  lerPrimeiroClaim,
} from './lti.config';

describe('leitura de claims do LTI', () => {
  // Formato realista: as chaves sao URLs (contem pontos), por isso o separador
  // de nivel e "::".
  const payload = {
    sub: '76629',
    [CLAIM_CUSTOM]: {
      orgdefinedid: '04085450',
      userid: 76629,
    },
    [CLAIM_LIS]: {
      person_sourcedid: 'UC25426847',
    },
  };

  it('le um claim aninhado por caminho com "::"', () => {
    expect(lerClaim(payload, `${CLAIM_CUSTOM}::orgdefinedid`)).toBe('04085450');
  });

  it('converte claim numerico para string (UserId vem como number)', () => {
    expect(lerClaim(payload, `${CLAIM_CUSTOM}::userid`)).toBe('76629');
  });

  it('devolve undefined quando o caminho nao existe', () => {
    expect(lerClaim(payload, `${CLAIM_CUSTOM}::inexistente`)).toBeUndefined();
    expect(lerClaim(payload, 'nada::disso')).toBeUndefined();
  });

  it('ignora string vazia (claim presente porem em branco)', () => {
    expect(
      lerClaim(
        { [CLAIM_CUSTOM]: { orgdefinedid: '   ' } },
        `${CLAIM_CUSTOM}::orgdefinedid`,
      ),
    ).toBeUndefined();
  });

  it('usa o primeiro candidato preenchido da lista', () => {
    const matricula = lerPrimeiroClaim(payload, [
      `${CLAIM_CUSTOM}::naoexiste`,
      `${CLAIM_CUSTOM}::orgdefinedid`,
      `${CLAIM_LIS}::person_sourcedid`,
    ]);

    expect(matricula).toBe('04085450');
  });

  it('cai para o proximo candidato quando o primeiro falta', () => {
    const semCustom = { [CLAIM_LIS]: { person_sourcedid: 'UC25426847' } };

    const matricula = lerPrimeiroClaim(semCustom, [
      `${CLAIM_CUSTOM}::orgdefinedid`,
      `${CLAIM_LIS}::person_sourcedid`,
    ]);

    expect(matricula).toBe('UC25426847');
  });
});
