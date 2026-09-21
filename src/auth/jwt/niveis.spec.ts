import { NivelAdmin } from '../../generated/prisma/client';
import { nivelPermitido, ROTULO_DO_NIVEL, TODOS_OS_NIVEIS } from './niveis';

const { SUPERADMIN, ASSISTENTE_OPERACIONAL, VISUALIZADOR_EXECUTIVO } =
  NivelAdmin;

describe('nivelPermitido', () => {
  describe('o padrao e FECHADO', () => {
    /**
     * A regressao que este bloco existe para impedir: alguem cria um controller
     * novo, esquece o `@NiveisPermitidos` — e a rota nasce aberta para todo
     * admin, entregando a quem so deveria ver os graficos a tela que cancela
     * agendamento. O esquecimento tem de FECHAR, como no AutenticacaoGuard.
     */
    it('rota sem declaracao de nivel so abre para o superadmin', () => {
      expect(nivelPermitido(SUPERADMIN, undefined)).toBe(true);
      expect(nivelPermitido(ASSISTENTE_OPERACIONAL, undefined)).toBe(false);
      expect(nivelPermitido(VISUALIZADOR_EXECUTIVO, undefined)).toBe(false);
    });

    it('lista vazia tambem so abre para o superadmin', () => {
      expect(nivelPermitido(SUPERADMIN, [])).toBe(true);
      expect(nivelPermitido(ASSISTENTE_OPERACIONAL, [])).toBe(false);
    });
  });

  it('o superadmin passa em tudo, sem precisar ser listado', () => {
    expect(nivelPermitido(SUPERADMIN, [VISUALIZADOR_EXECUTIVO])).toBe(true);
  });

  it('abre so para os niveis declarados', () => {
    const so_assistente = [ASSISTENTE_OPERACIONAL];

    expect(nivelPermitido(ASSISTENTE_OPERACIONAL, so_assistente)).toBe(true);
    expect(nivelPermitido(VISUALIZADOR_EXECUTIVO, so_assistente)).toBe(false);
  });

  it('a tela de Inicio abre para os tres', () => {
    const inicio = [ASSISTENTE_OPERACIONAL, VISUALIZADOR_EXECUTIVO];

    for (const nivel of TODOS_OS_NIVEIS) {
      expect(nivelPermitido(nivel, inicio)).toBe(true);
    }
  });

  /**
   * Token emitido antes de a coluna `nivel` existir. Tratar a ausencia como
   * superadmin faria todo access token velho continuar abrindo o sistema
   * inteiro pelos 15 minutos seguintes ao deploy que criou os niveis.
   */
  it('token SEM nivel nao passa em nada — nem no que e aberto a todos', () => {
    expect(nivelPermitido(undefined, undefined)).toBe(false);
    expect(
      nivelPermitido(undefined, [
        ASSISTENTE_OPERACIONAL,
        VISUALIZADOR_EXECUTIVO,
      ]),
    ).toBe(false);
  });
});

describe('ROTULO_DO_NIVEL', () => {
  it('nomeia todos os niveis — nenhum enum cru chega a tela', () => {
    for (const nivel of TODOS_OS_NIVEIS) {
      expect(ROTULO_DO_NIVEL[nivel]).toBeTruthy();
      expect(ROTULO_DO_NIVEL[nivel]).not.toBe(nivel);
    }
  });
});
