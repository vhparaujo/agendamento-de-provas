import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../database/prisma.service';
import { TurmaService } from './turma.service';

/**
 * O cruzamento disciplinas ∩ turmas reais ∩ periodo — escrito e testavel antes
 * do CSV real de turmas existir. Quando o arquivo chegar, nada aqui muda: so o
 * mapeamento de colunas em turma-csv.columns.ts.
 */
describe('TurmaService — disciplinas agendaveis', () => {
  let service: TurmaService;
  let turmaImportada: { findMany: jest.Mock; count: jest.Mock };
  let config: Record<string, string>;

  const criar = async () => {
    const modulo: TestingModule = await Test.createTestingModule({
      providers: [
        TurmaService,
        { provide: PrismaService, useValue: { turmaImportada } },
        { provide: ConfigService, useValue: { get: (k: string) => config[k] } },
      ],
    }).compile();

    service = modulo.get(TurmaService);
  };

  beforeEach(async () => {
    turmaImportada = { findMany: jest.fn(), count: jest.fn() };
    config = { PERIODO_LETIVO_ID: '103', TURMAS_FILTER_ENABLED: 'true' };
    await criar();
  });

  // Mesmas 3 linhas da fixture test/fixtures/turmas-exemplo.csv
  const TURMAS_MOCK = [
    { orgUnitId: '900001', nomeDisciplina: 'ALGORITMOS E PROGRAMACAO' },
    { orgUnitId: '900002', nomeDisciplina: 'CALCULO I' },
    { orgUnitId: '900003', nomeDisciplina: 'PSICOLOGIA DO DESENVOLVIMENTO' },
  ];

  describe('com o filtro de turmas ligado (default seguro)', () => {
    beforeEach(() => {
      turmaImportada.count.mockResolvedValue(TURMAS_MOCK.length);
    });

    it('deixa passar so as disciplinas que estao nas turmas reais', async () => {
      turmaImportada.findMany.mockResolvedValue([
        TURMAS_MOCK[0],
        TURMAS_MOCK[1],
      ]);

      const agendaveis = await service.filtrarAgendaveis([
        { orgUnitId: '900001', periodoLetivoId: '103' },
        { orgUnitId: '900002', periodoLetivoId: '103' },
        { orgUnitId: '999999', periodoLetivoId: '103' }, // sem prova
      ]);

      expect(agendaveis.map((d) => d.orgUnitId)).toEqual(['900001', '900002']);
    });

    it('descarta disciplina de outro periodo letivo', async () => {
      turmaImportada.findMany.mockResolvedValue([TURMAS_MOCK[0]]);

      const agendaveis = await service.filtrarAgendaveis([
        { orgUnitId: '900001', periodoLetivoId: '103' },
        { orgUnitId: '900002', periodoLetivoId: '102' }, // semestre passado
      ]);

      expect(agendaveis.map((d) => d.orgUnitId)).toEqual(['900001']);
    });

    it('usa o nome da turma importada, nao o da Valence', async () => {
      turmaImportada.findMany.mockResolvedValue([TURMAS_MOCK[0]]);

      const [disciplina] = await service.filtrarAgendaveis([
        { orgUnitId: '900001', nome: 'nome vindo da valence' },
      ]);

      expect(disciplina.nomeDisciplina).toBe('ALGORITMOS E PROGRAMACAO');
    });

    it('com a tabela de turmas VAZIA, nada e agendavel', async () => {
      turmaImportada.count.mockResolvedValue(0);
      turmaImportada.findMany.mockResolvedValue([]);

      const agendaveis = await service.filtrarAgendaveis([
        { orgUnitId: '900001', periodoLetivoId: '103' },
        { orgUnitId: '900002', periodoLetivoId: '103' },
      ]);

      // comportamento seguro: melhor ninguem agendar do que liberar
      // prova para a disciplina errada
      expect(agendaveis).toEqual([]);
    });

    it('aluno sem nenhuma disciplina devolve lista vazia', async () => {
      await expect(service.filtrarAgendaveis([])).resolves.toEqual([]);
    });
  });

  describe('com TURMAS_FILTER_ENABLED=false', () => {
    beforeEach(async () => {
      config.TURMAS_FILTER_ENABLED = 'false';
      await criar();
    });

    it('nao restringe: toda disciplina do periodo e agendavel', async () => {
      const agendaveis = await service.filtrarAgendaveis([
        { orgUnitId: '900001', periodoLetivoId: '103' },
        { orgUnitId: '999999', periodoLetivoId: '103' },
      ]);

      expect(agendaveis.map((d) => d.orgUnitId)).toEqual(['900001', '999999']);
      expect(turmaImportada.findMany).not.toHaveBeenCalled();
    });

    it('continua respeitando o periodo letivo', async () => {
      const agendaveis = await service.filtrarAgendaveis([
        { orgUnitId: '900001', periodoLetivoId: '102' },
      ]);

      expect(agendaveis).toEqual([]);
    });
  });
});
