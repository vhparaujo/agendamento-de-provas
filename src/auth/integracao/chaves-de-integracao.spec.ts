import {
  FORMATO_DAS_CHAVES,
  identificarSistema,
  ipPermitido,
  lerChaves,
  lerIps,
} from './chaves-de-integracao';

const CHAVE = 'a1b2c3d4'.repeat(5); // 40 caracteres
const OUTRA = 'f9e8d7c6'.repeat(5);

describe('lerChaves', () => {
  it('vazio ou ausente = nenhuma chave (a integracao fica fechada)', () => {
    expect(lerChaves(undefined)).toEqual([]);
    expect(lerChaves('')).toEqual([]);
    expect(lerChaves('   ')).toEqual([]);
  });

  it('le varias entradas, tolerando espaco em volta', () => {
    const chaves = lerChaves(` emissor:${CHAVE} , outro:${OUTRA} `);

    expect(chaves.map((c) => c.sistema)).toEqual(['emissor', 'outro']);
  });

  /**
   * NUNCA GUARDA A CHAVE CRUA. So o hash fica em memoria — um dump do objeto
   * (log de debug, erro serializado) nao entrega a credencial.
   */
  it('guarda o hash, e nao a chave', () => {
    const [chave] = lerChaves(`emissor:${CHAVE}`);

    expect(JSON.stringify(chave)).not.toContain(CHAVE);
  });

  it('recusa chave curta demais, em vez de aceitar "teste123"', () => {
    expect(() => lerChaves('emissor:teste123')).toThrow(/32 caracteres/);
  });

  it('recusa entrada sem nome de sistema', () => {
    expect(() => lerChaves(CHAVE)).toThrow();
    expect(FORMATO_DAS_CHAVES.test(`:${CHAVE}`)).toBe(false);
  });
});

describe('identificarSistema', () => {
  const chaves = lerChaves(`emissor:${CHAVE},outro:${OUTRA}`);

  it('devolve o nome do dono da chave', () => {
    expect(identificarSistema(CHAVE, chaves)).toBe('emissor');
    expect(identificarSistema(OUTRA, chaves)).toBe('outro');
  });

  it('chave errada, vazia ou ausente nao identifica ninguem', () => {
    expect(identificarSistema('x'.repeat(40), chaves)).toBeUndefined();
    expect(identificarSistema('', chaves)).toBeUndefined();
    expect(identificarSistema(undefined, chaves)).toBeUndefined();
  });

  /**
   * `timingSafeEqual` LANCA com buffers de tamanhos diferentes. E por isso que a
   * comparacao e entre hashes: sem eles, uma chave de tamanho errado viraria 500
   * em vez de 401.
   */
  it('nao quebra com chave de tamanho diferente', () => {
    expect(identificarSistema('curta', chaves)).toBeUndefined();
  });

  /** A rotacao: chave nova e antiga valendo juntas, para o mesmo sistema. */
  it('aceita duas chaves do mesmo sistema', () => {
    const rotacao = lerChaves(`emissor:${CHAVE},emissor:${OUTRA}`);

    expect(identificarSistema(CHAVE, rotacao)).toBe('emissor');
    expect(identificarSistema(OUTRA, rotacao)).toBe('emissor');
  });

  it('sem chave configurada, recusa tudo', () => {
    expect(identificarSistema(CHAVE, [])).toBeUndefined();
  });
});

describe('ipPermitido', () => {
  it('lista vazia libera qualquer origem — so a chave decide', () => {
    expect(ipPermitido('203.0.113.9', lerIps(''))).toBe(true);
  });

  it('com lista, so os IPs exatos passam', () => {
    const permitidos = lerIps('10.0.0.5, 10.0.0.6');

    expect(ipPermitido('10.0.0.5', permitidos)).toBe(true);
    expect(ipPermitido('10.0.0.7', permitidos)).toBe(false);
    expect(ipPermitido(undefined, permitidos)).toBe(false);
  });

  /** O Node entrega IPv4 como IPv6 mapeado quando escuta em dual stack. */
  it('reconhece o IPv4 mapeado em IPv6', () => {
    expect(ipPermitido('::ffff:10.0.0.5', lerIps('10.0.0.5'))).toBe(true);
  });
});
