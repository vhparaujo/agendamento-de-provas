import { AgendamentoAdminController } from '../../agendamento/controller/agendamento-admin.controller';
import { AdminController } from '../../admin/controller/admin.controller';
import { AlunoAdminController } from '../../aluno/controller/aluno-admin.controller';
import { AuthController } from '../controller/auth.controller';
import { FaixaController } from '../../faixa/controller/faixa.controller';
import { NivelAdmin } from '../../generated/prisma/client';
import { PeriodoController } from '../../periodo/controller/periodo.controller';
import { PoloController } from '../../polo/controller/polo.controller';
import { RelatorioController } from '../../relatorio/controller/relatorio.controller';
import { GradeSenhasController } from '../../senha-quiz/controller/grade-senhas.controller';
import { SenhaQuizController } from '../../senha-quiz/controller/senha-quiz.controller';
import { NIVEIS_KEY } from '../roles.decorator';
import { nivelPermitido } from './niveis';

/**
 * ============================================================================
 * A MATRIZ DE ACESSO, COMO TESTE
 * ============================================================================
 * `niveis.spec.ts` prova a REGRA (o padrao fecha, o superadmin passa em tudo).
 * Este arquivo prova a APLICACAO dela: que cada rota real esta declarada para
 * quem a especificacao disse, e — o que mais importa — que as rotas de ESCRITA
 * de Agendamentos e Senhas continuam fechadas.
 *
 * Ele le a metadata dos handlers direto das classes, sem subir a aplicacao nem
 * banco: e o mesmo `NIVEIS_KEY` que o `JwtAdminGuard` consulta em produção.
 *
 * O que ele NAO cobre: uma rota NOVA que nasca aberta por engano. Isso nao tem
 * como quebrar aqui, porque o padrao ja e fechado — uma rota esquecida nega o
 * assistente, e alguem reclama no mesmo dia.
 */
function niveisDeclarados(
  controller: new (...args: never[]) => unknown,
  metodo: string,
): NivelAdmin[] | undefined {
  const handler = (controller.prototype as Record<string, unknown>)[metodo];

  expect(typeof handler).toBe('function');

  return Reflect.getMetadata(NIVEIS_KEY, handler as object) as
    NivelAdmin[] | undefined;
}

function abrePara(
  nivel: NivelAdmin,
  controller: new (...args: never[]) => unknown,
  metodo: string,
): boolean {
  return nivelPermitido(nivel, niveisDeclarados(controller, metodo));
}

const ASSISTENTE = NivelAdmin.ASSISTENTE_OPERACIONAL;
const EXECUTIVO = NivelAdmin.VISUALIZADOR_EXECUTIVO;

describe('Matriz de niveis: Administrador Assistente Operacional', () => {
  it.each([
    ['ve a lista de agendamentos', AgendamentoAdminController, 'listar'],
    ['ve a ocupacao por sala', AgendamentoAdminController, 'resumo'],
    ['ve o detalhe de um agendamento', AgendamentoAdminController, 'buscar'],
    ['ve o historico', AgendamentoAdminController, 'historico'],
    ['baixa o CSV da cobranca', AgendamentoAdminController, 'exportar'],
    ['ve as listas de presenca', RelatorioController, 'listarSalas'],
    ['baixa a lista de presenca', RelatorioController, 'pdfDasListas'],
    ['ve os alunos', AlunoAdminController, 'listar'],
    ['marca o NIOP', AlunoAdminController, 'marcarNiop'],
    ['monta faixas', FaixaController, 'criar'],
    ['cadastra polo', PoloController, 'criar'],
    ['ve a grade de senhas', GradeSenhasController, 'listar'],
    ['revela as senhas do periodo', GradeSenhasController, 'revelarIntervalo'],
    ['ve o calendario das sessoes', GradeSenhasController, 'lerJanelas'],
  ])('%s', (_caso, controller, metodo) => {
    expect(abrePara(ASSISTENTE, controller, metodo)).toBe(true);
  });

  /**
   * ⚠️ O nucleo da especificacao. Em Agendamentos ele SO VE; em Senhas, idem.
   * Se alguma destas virar `true`, a tela pode ate esconder o botao — a rota
   * estaria aberta para quem nao pode mexer na prova de ninguem.
   */
  it.each([
    ['NAO agenda aluno', AgendamentoAdminController, 'agendar'],
    ['NAO remaneja', AgendamentoAdminController, 'remanejar'],
    ['NAO cancela', AgendamentoAdminController, 'cancelar'],
    ['NAO sorteia senha', GradeSenhasController, 'gerar'],
    ['NAO escreve senha a mao', GradeSenhasController, 'definir'],
    ['NAO apaga senha', GradeSenhasController, 'remover'],
    [
      'NAO muda o calendario das sessoes',
      GradeSenhasController,
      'salvarJanelas',
    ],
    ['NAO troca o questionario-alvo', GradeSenhasController, 'salvarAlvo'],
    ['NAO dispara lote no AVA', SenhaQuizController, 'iniciar'],
    ['NAO abre ou fecha periodo', PeriodoController, 'criar'],
    ['NAO gere administradores', AdminController, 'listar'],
    ['NAO cria administrador', AdminController, 'criar'],
    ['NAO concede nivel', AdminController, 'definirNivel'],
  ])('%s', (_caso, controller, metodo) => {
    expect(abrePara(ASSISTENTE, controller, metodo)).toBe(false);
  });
});

describe('Matriz de niveis: Administrador Visualizador Executivo', () => {
  it.each([
    [
      've os numeros da tela inicial',
      AgendamentoAdminController,
      'estatisticas',
    ],
    ['ve os polos do filtro', PoloController, 'listar'],
    ['ve os periodos do filtro', PeriodoController, 'listar'],
  ])('%s', (_caso, controller, metodo) => {
    expect(abrePara(EXECUTIVO, controller, metodo)).toBe(true);
  });

  it.each([
    ['NAO ve a lista de agendamentos', AgendamentoAdminController, 'listar'],
    ['NAO baixa o CSV da cobranca', AgendamentoAdminController, 'exportar'],
    ['NAO ve os alunos', AlunoAdminController, 'listar'],
    ['NAO ve as faixas', FaixaController, 'listar'],
    ['NAO ve as listas de presenca', RelatorioController, 'listarSalas'],
    ['NAO ve a grade de senhas', GradeSenhasController, 'listar'],
    ['NAO revela senha nenhuma', GradeSenhasController, 'revelarIntervalo'],
    ['NAO cadastra polo', PoloController, 'criar'],
  ])('%s', (_caso, controller, metodo) => {
    expect(abrePara(EXECUTIVO, controller, metodo)).toBe(false);
  });
});

describe('Matriz de niveis: o que TODO admin faz sobre a propria conta', () => {
  /**
   * Sem estas duas, o assistente e o visualizador ficariam presos na tela de
   * senha provisoria: 403 na unica rota que os tiraria de la, e 403 tambem em
   * `/auth/me`, de onde a tela descobre o nivel para montar o menu.
   */
  it.each([ASSISTENTE, EXECUTIVO])('%s troca a propria senha', (nivel) => {
    expect(abrePara(nivel, AuthController, 'trocarSenha')).toBe(true);
  });

  it.each([ASSISTENTE, EXECUTIVO])('%s le os proprios dados', (nivel) => {
    expect(abrePara(nivel, AuthController, 'me')).toBe(true);
  });

  /**
   * O perfil e da PESSOA, nao do nivel dela: os tres editam o proprio nome e
   * e-mail. Fechar isto por engano deixaria o assistente e o visualizador sem
   * como corrigir o proprio cadastro — e sem ninguem para pedir, porque a tela
   * de Administradores nao edita nome nem e-mail de terceiros.
   */
  it.each([ASSISTENTE, EXECUTIVO])('%s edita o proprio perfil', (nivel) => {
    expect(abrePara(nivel, AuthController, 'atualizarPerfil')).toBe(true);
  });
});
