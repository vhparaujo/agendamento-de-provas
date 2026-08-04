import { ConfigService } from '@nestjs/config';
import {
  CLAIM_BRIGHTSPACE,
  CLAIM_CUSTOM,
  CLAIM_LIS,
  carregarLtiConfig,
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

/**
 * Formato REAL de um launch do `catolicatest.brightspace.com`, observado pelo
 * spike de LTI 1.3. O que importa aqui e que matricula e UserId vem no claim
 * PROPRIETARIO do Brightspace — nao como parametros customizados.
 */
const LAUNCH_REAL = {
  // Opaco: <guid>_<userId>. NAO serve para a Valence API.
  sub: '257d7905-218f-4513-986e-0458c3ba5854_76629',
  [CLAIM_BRIGHTSPACE]: {
    user_id: 76629,
    org_defined_id: 'UC25426847',
    username: 'UC25426847',
    tenant_id: 'abc',
  },
  [CLAIM_LIS]: { person_sourcedid: 'UC25426847' },
};

describe('padroes de claim contra um launch real', () => {
  const config = new ConfigService({});
  const lti = carregarLtiConfig(config);

  it('acha a matricula no claim proprietario do Brightspace', () => {
    expect(lerPrimeiroClaim(LAUNCH_REAL, lti.claimsMatricula)).toBe(
      'UC25426847',
    );
  });

  it('acha o UserId numerico do D2L', () => {
    expect(lerPrimeiroClaim(LAUNCH_REAL, lti.claimsUserId)).toBe('76629');
  });

  it('NUNCA usa o `sub` como UserId — a Valence API o rejeita', () => {
    // Esta e a regressao que o teste existe para impedir: com `sub` na lista, um
    // tenant sem o claim proprietario faria um launch "bem-sucedido" gravando um
    // userIdD2L invalido, e a falha so apareceria ao liberar a prova.
    expect(lti.claimsUserId).not.toContain('sub');

    const semClaimProprietario = { sub: LAUNCH_REAL.sub };

    expect(
      lerPrimeiroClaim(semClaimProprietario, lti.claimsUserId),
    ).toBeUndefined();
  });

  it('ainda acha a matricula se o claim proprietario faltar', () => {
    const soLis = { [CLAIM_LIS]: { person_sourcedid: 'A06103080' } };

    expect(lerPrimeiroClaim(soLis, lti.claimsMatricula)).toBe('A06103080');
  });
});

/**
 * Regressao de um launch REAL que falhou em 04/08/2026: o id_token trazia a
 * matricula em `custom.lis_person_sourcedid`, mas o .env tinha
 * `LTI_CLAIM_MATRICULA=` (declarada e VAZIA, como o .env.example instrui). A
 * variavel chegava como "" — nao undefined —, o `??` nao caia no padrao e a
 * lista de candidatos ficava vazia: nenhum caminho era tentado e o launch
 * respondia "matricula NAO ENCONTRADA" com o claim ali, presente no token.
 */
describe('variavel de claim declarada porem vazia usa os padroes', () => {
  const LAUNCH_UCB = {
    sub: '882a6f23-8182-4d4f-85f5-7928265c3fe6_171131',
    [CLAIM_CUSTOM]: { lis_person_sourcedid: 'UC26423089' },
    [CLAIM_BRIGHTSPACE]: { user_id: 171131 },
  };

  it.each([
    ['string vazia', ''],
    ['so espaco', '   '],
    ['so separadores', ', ,'],
  ])('%s: cai nos padroes em vez de zerar a lista', (_caso, valor) => {
    const lti = carregarLtiConfig(
      new ConfigService({
        LTI_CLAIM_MATRICULA: valor,
        LTI_CLAIM_USER_ID: valor,
      }),
    );

    expect(lti.claimsMatricula.length).toBeGreaterThan(0);
    expect(lerPrimeiroClaim(LAUNCH_UCB, lti.claimsMatricula)).toBe(
      'UC26423089',
    );
    expect(lerPrimeiroClaim(LAUNCH_UCB, lti.claimsUserId)).toBe('171131');
  });

  it('um valor de verdade continua sobrepondo os padroes', () => {
    const lti = carregarLtiConfig(
      new ConfigService({
        LTI_CLAIM_MATRICULA: `${CLAIM_LIS}::person_sourcedid`,
      }),
    );

    expect(lti.claimsMatricula).toEqual([`${CLAIM_LIS}::person_sourcedid`]);
    // O caminho configurado nao existe neste launch — e o padrao NAO volta a
    // valer por baixo: quem configura, manda.
    expect(lerPrimeiroClaim(LAUNCH_UCB, lti.claimsMatricula)).toBeUndefined();
  });
});
