import type { AlunoJwtPayload } from '../../auth/jwt/jwt.types';
import { D2lEnrollmentsService } from '../../d2l/service/d2l-enrollments.service';
import { Perfil } from '../../enums/perfil.enum';
import { PeriodoService } from '../../periodo/service/periodo.service';
import type { DisciplinaAgendavel } from '../../turma/service/turma.service';
import { TurmaService } from '../../turma/service/turma.service';
import { DisciplinasDoAlunoService } from './disciplinas-do-aluno.service';

/**
 * O que estes testes protegem:
 *
 * 1. Com a Valence ligada, o aluno ve TODAS as disciplinas do semestre que o
 *    admin cadastrou — nao so a turma de onde clicou.
 * 2. Com ela desligada, nada muda: continua valendo o claim `context` do launch.
 * 3. Quem tem dois cursos nao leva disciplina do outro curso para a prova
 *    errada. As duracoes sao diferentes; misturar poria o aluno numa faixa que
 *    nao cabe a prova dele.
 */
describe('DisciplinasDoAlunoService', () => {
  const HISTORIA = {
    orgUnitId: '6606',
    codigo: 'GSPS0I10227',
    titulo: 'HISTORIA E CULTURA DO CORPO E DO MOVIMENTO',
  };

  const NUTRICAO = {
    orgUnitId: '6610',
    codigo: 'GSPS0I10259',
    titulo: 'PRATICA PROFISSIONAL E ETICA EM NUTRICAO',
  };

  /** O que o cruzamento com o CSV devolveria para cada uma delas. */
  const cruzada = (
    turma: { orgUnitId: string; titulo: string },
    curso: string | null,
  ): DisciplinaAgendavel => ({
    orgUnitId: turma.orgUnitId,
    nomeDisciplina: turma.titulo,
    curso,
  });

  const aluno = (
    cursos: string[],
    contexto: typeof HISTORIA | undefined = HISTORIA,
  ): AlunoJwtPayload => ({
    sub: 'UC18120644',
    perfil: Perfil.ALUNO,
    userIdD2L: '76629',
    contexto,
    vinculos: cursos.map((curso, indice) => ({
      alunoId: indice + 1,
      curso,
      modalidade: 'EAD',
      poloId: 5,
      ativo: true,
    })),
  });

  const montar = (opcoes: {
    habilitado: boolean;
    ofertas?: { orgUnitId: string; codigo: string; titulo: string }[];
    cruzamento: DisciplinaAgendavel[];
    periodoLetivoId?: string | undefined;
  }) => {
    const filtrarAgendaveis = jest
      .fn()
      .mockResolvedValue({ agendaveis: opcoes.cruzamento });

    const turma = {
      filtrarAgendaveis,
      filtroAtivo: () => true,
    } as unknown as TurmaService;

    const ofertasDoPeriodo = jest.fn().mockResolvedValue(opcoes.ofertas ?? []);

    const enrollments = {
      habilitado: () => opcoes.habilitado,
      ofertasDoPeriodo,
    } as unknown as D2lEnrollmentsService;

    const periodo = {
      periodoLetivoVigente: jest
        .fn()
        .mockResolvedValue(
          'periodoLetivoId' in opcoes ? opcoes.periodoLetivoId : '103',
        ),
    } as unknown as PeriodoService;

    return {
      service: new DisciplinasDoAlunoService(turma, enrollments, periodo),
      filtrarAgendaveis,
      ofertasDoPeriodo,
    };
  };

  describe('com a Valence ligada', () => {
    it('cruza TODAS as ofertas do semestre, nao so a turma clicada', async () => {
      const { service, filtrarAgendaveis, ofertasDoPeriodo } = montar({
        habilitado: true,
        ofertas: [HISTORIA, NUTRICAO],
        cruzamento: [
          cruzada(HISTORIA, 'EDUCACAO FISICA'),
          cruzada(NUTRICAO, 'NUTRICAO'),
        ],
      });

      const disciplinas = await service.agendaveis(aluno(['EDUCACAO FISICA']), {
        curso: 'EDUCACAO FISICA',
      });

      expect(ofertasDoPeriodo).toHaveBeenCalledWith('76629', '103');
      expect(filtrarAgendaveis).toHaveBeenCalledWith([HISTORIA, NUTRICAO]);
      expect(disciplinas).toHaveLength(2);
    });

    it('sem periodo letivo cadastrado, nao chama a Valence', async () => {
      const { service, ofertasDoPeriodo } = montar({
        habilitado: true,
        cruzamento: [],
        periodoLetivoId: undefined,
      });

      const r = await service.cruzar(aluno(['EDUCACAO FISICA']), {
        curso: 'EDUCACAO FISICA',
      });

      expect(ofertasDoPeriodo).not.toHaveBeenCalled();
      expect(r.motivo).toMatch(/periodo letivo ainda nao foi configurado/);
    });

    it('aluno sem oferta no semestre recebe o motivo, nao lista vazia sem explicacao', async () => {
      const { service } = montar({
        habilitado: true,
        ofertas: [],
        cruzamento: [],
      });

      const r = await service.cruzar(aluno(['EDUCACAO FISICA']), {
        curso: 'EDUCACAO FISICA',
      });

      expect(r.motivo).toMatch(/Nenhuma disciplina sua aparece/);
    });
  });

  describe('com a Valence desligada', () => {
    it('continua valendo a turma de onde o aluno clicou', async () => {
      const { service, filtrarAgendaveis } = montar({
        habilitado: false,
        cruzamento: [cruzada(HISTORIA, 'EDUCACAO FISICA')],
      });

      await service.agendaveis(aluno(['EDUCACAO FISICA']), {
        curso: 'EDUCACAO FISICA',
      });

      expect(filtrarAgendaveis).toHaveBeenCalledWith([HISTORIA]);
    });

    it('launch sem contexto nao libera nada', async () => {
      const { service, filtrarAgendaveis } = montar({
        habilitado: false,
        cruzamento: [],
      });

      await service.agendaveis(
        { ...aluno(['EDUCACAO FISICA']), contexto: undefined },
        { curso: 'EDUCACAO FISICA' },
      );

      expect(filtrarAgendaveis).toHaveBeenCalledWith([]);
    });
  });

  describe('aluno com dois cursos', () => {
    const DOIS = ['EDUCACAO FISICA', 'NUTRICAO'];

    it('leva para a prova so as disciplinas do curso escolhido', async () => {
      const { service } = montar({
        habilitado: true,
        ofertas: [HISTORIA, NUTRICAO],
        cruzamento: [
          cruzada(HISTORIA, 'EDUCACAO FISICA'),
          cruzada(NUTRICAO, 'NUTRICAO'),
        ],
      });

      const disciplinas = await service.agendaveis(aluno(DOIS), {
        curso: 'NUTRICAO',
      });

      expect(disciplinas.map((d) => d.orgUnitId)).toEqual(['6610']);
    });

    it('ignora acento e caixa ao comparar o curso', async () => {
      // Os dois CSVs vem do mesmo sistema academico, mas a grafia ja divergiu
      // antes; casar exato transformaria isso em "voce nao tem prova".
      const { service } = montar({
        habilitado: true,
        ofertas: [NUTRICAO],
        cruzamento: [cruzada(NUTRICAO, 'NUTRIÇÃO')],
      });

      const disciplinas = await service.agendaveis(aluno(DOIS), {
        curso: 'Nutrição',
      });

      expect(disciplinas).toHaveLength(1);
    });

    it('nada do curso escolhido = motivo que diz o que fazer', async () => {
      const { service } = montar({
        habilitado: true,
        ofertas: [HISTORIA],
        cruzamento: [cruzada(HISTORIA, 'EDUCACAO FISICA')],
      });

      const r = await service.cruzar(aluno(DOIS), { curso: 'NUTRICAO' });

      expect(r.agendaveis).toEqual([]);
      expect(r.motivo).toMatch(/escolha o outro/);
    });

    it('disciplina sem curso no CSV nao entra pelos enrollments', async () => {
      // Ninguem escolheu essa disciplina, e nao ha nada que a ligue a este
      // vinculo — poe-la na prova seria adivinhar de qual curso ela e.
      const { service } = montar({
        habilitado: true,
        ofertas: [HISTORIA, NUTRICAO],
        cruzamento: [cruzada(HISTORIA, null), cruzada(NUTRICAO, 'NUTRICAO')],
      });

      const disciplinas = await service.agendaveis(aluno(DOIS), {
        curso: 'NUTRICAO',
      });

      expect(disciplinas.map((d) => d.orgUnitId)).toEqual(['6610']);
    });

    it('mas entra quando foi ELE quem clicou nela', async () => {
      // Caminho do launch: a escolha e do aluno, nao ha o que atribuir.
      const { service } = montar({
        habilitado: false,
        cruzamento: [cruzada(HISTORIA, null)],
      });

      const disciplinas = await service.agendaveis(aluno(DOIS), {
        curso: 'NUTRICAO',
      });

      expect(disciplinas).toHaveLength(1);
    });
  });

  it('aluno de um curso so nao passa pelo filtro de curso', async () => {
    // Filtrar aqui transformaria qualquer divergencia de grafia entre os dois
    // CSVs em "voce nao tem prova" — e nao ha nada a decidir com um vinculo.
    const { service } = montar({
      habilitado: true,
      ofertas: [HISTORIA],
      cruzamento: [cruzada(HISTORIA, 'OUTRA GRAFIA DO CURSO')],
    });

    const disciplinas = await service.agendaveis(aluno(['EDUCACAO FISICA']), {
      curso: 'EDUCACAO FISICA',
    });

    expect(disciplinas).toHaveLength(1);
  });
});
