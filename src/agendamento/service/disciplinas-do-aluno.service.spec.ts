import type { AlunoJwtPayload } from '../../auth/jwt/jwt.types';
import { D2lEnrollmentsService } from '../../d2l/service/d2l-enrollments.service';
import { D2lGradesService } from '../../d2l/service/d2l-grades.service';
import { Perfil } from '../../enums/perfil.enum';
import { PeriodoService } from '../../periodo/service/periodo.service';
import type { DisciplinaAgendavel } from '../../turma/service/turma.service';
import { TurmaService } from '../../turma/service/turma.service';
import { DisciplinasDoAlunoService } from './disciplinas-do-aluno.service';
import { ElegibilidadeDeNotaService } from './elegibilidade-de-nota.service';

/**
 * O que estes testes protegem:
 *
 * 1. Com a Valence ligada, o aluno ve TODAS as disciplinas do semestre que o
 *    admin cadastrou — nao so a turma de onde clicou.
 * 2. Com ela desligada, nada muda: continua valendo o claim `context` do launch.
 * 3. A lista NAO e separada por vinculo: turma nao pertence a um curso, entao
 *    nao ha como atribuir a disciplina a um dos dois cursos de quem tem duas
 *    matriculas iguais. Ver o teste "aluno com dois vinculos".
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
  const cruzada = (turma: {
    orgUnitId: string;
    titulo: string;
  }): DisciplinaAgendavel => ({
    orgUnitId: turma.orgUnitId,
    nomeDisciplina: turma.titulo,
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
    /** A Valence recusa em vez de responder — token invalido, rede, 502. */
    erroDaValence?: Error;
    /** A faixa de nota da janela. Ausente = a N2, que nao filtra por nota. */
    filtroDeNota?: { minima: number; maxima: number } | null;
    /** Nota por orgUnitId. Ausente = a turma nao lancou nota para o aluno. */
    notas?: Record<string, number>;
    /** A leitura de notas falha — Valence fora, escopo faltando, 502. */
    erroDasNotas?: Error;
  }) => {
    const filtrarAgendaveis = jest
      .fn()
      .mockResolvedValue({ agendaveis: opcoes.cruzamento });

    const turma = {
      filtrarAgendaveis,
      filtroAtivo: () => true,
    } as unknown as TurmaService;

    const ofertasDoPeriodo = opcoes.erroDaValence
      ? jest.fn().mockRejectedValue(opcoes.erroDaValence)
      : jest.fn().mockResolvedValue(opcoes.ofertas ?? []);

    const enrollments = {
      habilitado: () => opcoes.habilitado,
      ofertasDoPeriodo,
    } as unknown as D2lEnrollmentsService;

    const periodo = {
      periodoLetivoVigente: jest.fn().mockResolvedValue(
        // `undefined` continua sendo "nenhum periodo cadastrado"; o resto vira o
        // par que o service passou a devolver.
        (() => {
          const id =
            'periodoLetivoId' in opcoes ? opcoes.periodoLetivoId : '103';
          return id === undefined
            ? undefined
            : {
                periodoLetivoId: id,
                rodada: 'N2',
                filtroDeNota: opcoes.filtroDeNota ?? null,
              };
        })(),
      ),
    } as unknown as PeriodoService;

    // O cliente de notas e mockado no nivel do `D2lGradesService`: assim o
    // proprio `ElegibilidadeDeNotaService` (a regra, e o cache) entra no teste.
    const notaFinal = opcoes.erroDasNotas
      ? jest.fn().mockRejectedValue(opcoes.erroDasNotas)
      : jest.fn().mockImplementation((orgUnitId: string) => {
          const pontos = opcoes.notas?.[orgUnitId];

          return Promise.resolve(
            pontos === undefined
              ? { situacao: 'SEM_NOTA' }
              : {
                  situacao: 'ACHOU',
                  pontos,
                  denominador: 10,
                  origem: 'CALCULADA',
                  exibida: null,
                },
          );
        });

    const elegibilidade = new ElegibilidadeDeNotaService({
      notaFinal,
      notasFinaisDaTurma: jest.fn(),
      habilitado: () => true,
    } as unknown as D2lGradesService);

    return {
      service: new DisciplinasDoAlunoService(
        turma,
        enrollments,
        periodo,
        elegibilidade,
      ),
      filtrarAgendaveis,
      ofertasDoPeriodo,
      notaFinal,
    };
  };

  describe('com a Valence ligada', () => {
    it('cruza TODAS as ofertas do semestre, nao so a turma clicada', async () => {
      const { service, filtrarAgendaveis, ofertasDoPeriodo } = montar({
        habilitado: true,
        ofertas: [HISTORIA, NUTRICAO],
        cruzamento: [cruzada(HISTORIA), cruzada(NUTRICAO)],
      });

      const disciplinas = await service.agendaveis(aluno(['EDUCACAO FISICA']));

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

      const r = await service.cruzar(aluno(['EDUCACAO FISICA']));

      expect(ofertasDoPeriodo).not.toHaveBeenCalled();
      expect(r.motivo).toMatch(/periodo letivo ainda nao foi configurado/);
    });

    it('aluno sem oferta no semestre recebe o motivo, nao lista vazia sem explicacao', async () => {
      const { service } = montar({
        habilitado: true,
        ofertas: [],
        cruzamento: [],
      });

      const r = await service.cruzar(aluno(['EDUCACAO FISICA']));

      expect(r.motivo).toMatch(/Nenhuma disciplina sua aparece/);
    });
  });

  describe('com a Valence desligada', () => {
    it('continua valendo a turma de onde o aluno clicou', async () => {
      const { service, filtrarAgendaveis } = montar({
        habilitado: false,
        cruzamento: [cruzada(HISTORIA)],
      });

      await service.agendaveis(aluno(['EDUCACAO FISICA']));

      expect(filtrarAgendaveis).toHaveBeenCalledWith([HISTORIA]);
    });

    it('launch sem contexto nao libera nada', async () => {
      const { service, filtrarAgendaveis } = montar({
        habilitado: false,
        cruzamento: [],
      });

      await service.agendaveis({
        ...aluno(['EDUCACAO FISICA']),
        contexto: undefined,
      });

      expect(filtrarAgendaveis).toHaveBeenCalledWith([]);
    });
  });

  /**
   * `habilitado()` so olha o .env — ele nao sabe se ha refresh token gravado, se
   * ele ainda vale, nem se o Brightspace esta de pe. Antes deste fallback, os
   * tres viravam 503 na cara do aluno e o portal inteiro parava.
   */
  describe('com a Valence ligada mas FORA', () => {
    const FORA = new Error(
      'O refresh token gravado nao e mais valido (rotacionado, revogado ou expirado).',
    );

    it('cai para a turma do launch em vez de derrubar o agendamento', async () => {
      const { service, filtrarAgendaveis } = montar({
        habilitado: true,
        erroDaValence: FORA,
        cruzamento: [cruzada(HISTORIA)],
      });

      const r = await service.cruzar(aluno(['EDUCACAO FISICA']));

      expect(filtrarAgendaveis).toHaveBeenCalledWith([HISTORIA]);
      expect(r.agendaveis).toHaveLength(1);
      expect(r.motivo).toBeUndefined();
    });

    /**
     * Sem turma clicada nao ha de onde tirar a lista. O que NAO pode acontecer e
     * devolver "nenhuma disciplina sua aparece no periodo letivo vigente": isso
     * manda o aluno a secretaria, e a secretaria procurar defeito no CSV de
     * turmas, por um problema que e da integracao.
     */
    it('sem turma clicada, o motivo diz que foi o Brightspace', async () => {
      const { service } = montar({
        habilitado: true,
        erroDaValence: FORA,
        cruzamento: [],
      });

      const r = await service.cruzar({
        ...aluno(['EDUCACAO FISICA']),
        contexto: undefined,
      });

      expect(r.agendaveis).toEqual([]);
      expect(r.motivo).toMatch(/Brightspace/);
      expect(r.motivo).not.toMatch(/periodo letivo vigente/);
    });

    /**
     * O compulsorio nao tem turma clicada: o fallback seria lista vazia, e o
     * lote registraria SEM_DISCIPLINA_AGENDAVEL — que manda conferir o CSV —
     * quando a causa foi a rede. O erro sobe para virar FALHA_NA_INTEGRACAO.
     */
    it('o compulsorio NAO cai para o launch: deixa o erro subir', async () => {
      const { service } = montar({
        habilitado: true,
        erroDaValence: FORA,
        cruzamento: [],
      });

      await expect(service.cruzarPorUserId('76629')).rejects.toThrow(FORA);
    });
  });

  /**
   * A separacao por curso nao existe: turma tem alunos de varios cursos, entao o
   * CSV nao pode dizer de qual curso cada oferta e.
   *
   * Consequencia aceita conscientemente (2 alunos em 7519 na base real): quem
   * tem dois vinculos na MESMA matricula recebe as disciplinas dos dois cursos
   * juntas pelos enrollments. Pelo LAUNCH nao acontece — a disciplina e a que
   * ele clicou.
   */
  describe('aluno com dois vinculos', () => {
    const DOIS = ['EDUCACAO FISICA', 'NUTRICAO'];

    it('recebe as disciplinas dos dois cursos pelos enrollments', async () => {
      const { service } = montar({
        habilitado: true,
        ofertas: [HISTORIA, NUTRICAO],
        cruzamento: [cruzada(HISTORIA), cruzada(NUTRICAO)],
      });

      const disciplinas = await service.agendaveis(aluno(DOIS));

      expect(disciplinas.map((d) => d.orgUnitId)).toEqual(['6606', '6610']);
    });

    it('pelo launch, recebe so a que clicou', async () => {
      const { service } = montar({
        habilitado: false,
        cruzamento: [cruzada(HISTORIA)],
      });

      const disciplinas = await service.agendaveis(aluno(DOIS));

      expect(disciplinas.map((d) => d.orgUnitId)).toEqual(['6606']);
    });
  });
  /**
   * ==========================================================================
   * A JANELA DA SUBSTITUTIVA — a faixa de nota
   * ==========================================================================
   * O que muda aqui e so o `filtroDeNota` do periodo vigente. Nada de `rodada`:
   * ela e texto livre, e amarrar a regra a string "SUB" faria a substitutiva
   * abrir para todo mundo no dia em que alguem cadastrasse "Substitutiva".
   */
  describe('com faixa de nota na janela', () => {
    const FAIXA = { minima: 1.5, maxima: 6.75 };

    it('devolve so as disciplinas dentro da faixa', async () => {
      const { service } = montar({
        habilitado: true,
        ofertas: [HISTORIA, NUTRICAO],
        cruzamento: [cruzada(HISTORIA), cruzada(NUTRICAO)],
        filtroDeNota: FAIXA,
        notas: { '6606': 4.25, '6610': 8.5 },
      });

      const disciplinas = await service.agendaveis(aluno(['EDUCACAO FISICA']));

      expect(disciplinas).toEqual([{ ...cruzada(HISTORIA), notaFinal: 4.25 }]);
    });

    it('nenhuma na faixa: motivo proprio, que NAO manda conferir o CSV', async () => {
      const { service } = montar({
        habilitado: true,
        ofertas: [HISTORIA],
        cruzamento: [cruzada(HISTORIA)],
        filtroDeNota: FAIXA,
        notas: { '6606': 8.5 },
      });

      const { agendaveis, motivo, causa } = await service.cruzar(
        aluno(['EDUCACAO FISICA']),
      );

      expect(agendaveis).toHaveLength(0);
      expect(causa).toBe('FILTRO_DE_NOTA');
      expect(motivo).toContain('1,50');
      expect(motivo).not.toMatch(/turma|CSV/i);
    });

    /**
     * ⚠️ O teste que mais importa. Sem filtro, a Valence fora degrada para a
     * turma do launch — "agendar uma prova e melhor que agendar nenhuma". Com
     * filtro, degradar liberaria a substitutiva SEM conferir nota nenhuma, que e
     * exatamente o que a regra existe para impedir.
     */
    it('Valence fora NAO cai para o launch: recusa e explica', async () => {
      const { service } = montar({
        habilitado: true,
        cruzamento: [cruzada(HISTORIA)],
        filtroDeNota: FAIXA,
        erroDaValence: new Error('502 no tenant'),
      });

      const { agendaveis, motivo } = await service.cruzar(
        aluno(['EDUCACAO FISICA']),
      );

      expect(agendaveis).toHaveLength(0);
      expect(motivo).toContain('notas');
    });

    it('a leitura da NOTA falhando tambem recusa, sem liberar nada', async () => {
      const { service } = montar({
        habilitado: true,
        ofertas: [HISTORIA],
        cruzamento: [cruzada(HISTORIA)],
        filtroDeNota: FAIXA,
        erroDasNotas: new Error('403 sem escopo'),
      });

      const { agendaveis, motivo } = await service.cruzar(
        aluno(['EDUCACAO FISICA']),
      );

      expect(agendaveis).toHaveLength(0);
      expect(motivo).toContain('notas');
    });

    /**
     * No compulsorio o erro precisa SUBIR: virado texto, ele daria uma linha
     * dizendo "este aluno passou de ano" quando a causa foi a rede — e ninguem
     * reprocessaria. Subindo, vira `FALHA_NA_INTEGRACAO`, que se reprocessa.
     */
    it('no compulsorio, a falha de nota SOBE em vez de virar motivo', async () => {
      const { service } = montar({
        habilitado: true,
        ofertas: [HISTORIA],
        cruzamento: [cruzada(HISTORIA)],
        filtroDeNota: FAIXA,
        erroDasNotas: new Error('403 sem escopo'),
      });

      await expect(service.cruzarPorUserId('76629')).rejects.toThrow(/notas/);
    });

    /** Sem integracao nao ha nota, e sem nota a substitutiva nao pode abrir. */
    it('D2L desligado com faixa de nota recusa, em vez de usar o launch', async () => {
      const { service } = montar({
        habilitado: false,
        cruzamento: [cruzada(HISTORIA)],
        filtroDeNota: FAIXA,
      });

      const { agendaveis, motivo } = await service.cruzar(
        aluno(['EDUCACAO FISICA']),
      );

      expect(agendaveis).toHaveLength(0);
      expect(motivo).toContain('notas');
    });

    it('sem nota lancada nao agenda, e o texto manda a secretaria', async () => {
      const { service } = montar({
        habilitado: true,
        ofertas: [HISTORIA],
        cruzamento: [cruzada(HISTORIA)],
        filtroDeNota: FAIXA,
        notas: {},
      });

      const { agendaveis, motivo } = await service.cruzar(
        aluno(['EDUCACAO FISICA']),
      );

      expect(agendaveis).toHaveLength(0);
      expect(motivo).toContain('secretaria');
    });

    /**
     * O caminho da N2 nao pode ter passado a custar uma consulta de nota por
     * disciplina — e o caminho de quase todo agendamento do sistema.
     */
    it('sem faixa, NENHUMA nota e consultada', async () => {
      const { service, notaFinal } = montar({
        habilitado: true,
        ofertas: [HISTORIA, NUTRICAO],
        cruzamento: [cruzada(HISTORIA), cruzada(NUTRICAO)],
      });

      const disciplinas = await service.agendaveis(aluno(['EDUCACAO FISICA']));

      expect(notaFinal).not.toHaveBeenCalled();
      expect(disciplinas.every((d) => d.notaFinal === null)).toBe(true);
    });
  });
});
