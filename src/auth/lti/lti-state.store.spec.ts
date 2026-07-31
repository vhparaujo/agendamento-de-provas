import { LtiStateStore } from './lti-state.store';

describe('LtiStateStore', () => {
  let store: LtiStateStore;

  beforeEach(() => {
    store = new LtiStateStore();
  });

  it('devolve o nonce correspondente ao state', () => {
    const { state, nonce } = store.criar();
    expect(store.consumir(state)).toBe(nonce);
  });

  it('gera state e nonce diferentes a cada iniciacao', () => {
    const a = store.criar();
    const b = store.criar();

    expect(a.state).not.toBe(b.state);
    expect(a.nonce).not.toBe(b.nonce);
  });

  it('aceita o mesmo state uma unica vez (protecao contra replay)', () => {
    const { state } = store.criar();

    expect(store.consumir(state)).toBeDefined();
    expect(store.consumir(state)).toBeUndefined();
  });

  it('rejeita state desconhecido', () => {
    expect(store.consumir('state-inventado')).toBeUndefined();
  });

  it('rejeita state expirado', () => {
    const { state } = store.criar();

    // 11 min: passa do TTL de 10 min
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60 * 1000);

    expect(store.consumir(state)).toBeUndefined();

    jest.restoreAllMocks();
  });
});
