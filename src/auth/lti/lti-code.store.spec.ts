import { LtiCodeStore } from './lti-code.store';
import type { ResultadoLaunch } from './lti.service';

/**
 * O codigo e a credencial que atravessa o redirect ate o portal. As garantias
 * que importam sao as mesmas do `state`: uso unico e vida curta — sem elas, a
 * URL que fica no historico do navegador viraria uma chave reutilizavel para a
 * sessao do aluno.
 */
describe('LtiCodeStore', () => {
  let store: LtiCodeStore;

  const resultado = (matricula = 'UC25426847'): ResultadoLaunch => ({
    accessToken: 'jwt-do-aluno',
    expiraEm: '2h',
    matricula,
    nome: 'JOAO DA SILVA',
    precisaEscolherCurso: false,
    vinculos: [],
  });

  beforeEach(() => {
    store = new LtiCodeStore();
  });

  it('devolve o resultado do launch guardado sob o codigo', () => {
    const codigo = store.criar(resultado());

    expect(store.consumir(codigo)?.matricula).toBe('UC25426847');
  });

  it('gera um codigo diferente a cada launch', () => {
    expect(store.criar(resultado())).not.toBe(store.criar(resultado()));
  });

  it('aceita o mesmo codigo uma unica vez (protecao contra replay)', () => {
    const codigo = store.criar(resultado());

    expect(store.consumir(codigo)).toBeDefined();
    expect(store.consumir(codigo)).toBeUndefined();
  });

  it('rejeita codigo desconhecido', () => {
    expect(store.consumir('codigo-inventado')).toBeUndefined();
  });

  it('rejeita codigo expirado', () => {
    const codigo = store.criar(resultado());

    // 3 min: passa do TTL de 2 min
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 3 * 60 * 1000);

    expect(store.consumir(codigo)).toBeUndefined();

    jest.restoreAllMocks();
  });

  it('nao mistura as sessoes de dois alunos', () => {
    const doJoao = store.criar(resultado('UC0000001'));
    const daMaria = store.criar(resultado('UC0000002'));

    expect(store.consumir(daMaria)?.matricula).toBe('UC0000002');
    expect(store.consumir(doJoao)?.matricula).toBe('UC0000001');
  });
});
