import { D2lEnrollmentsService } from '../../d2l/service/d2l-enrollments.service';
import { PrismaService } from '../../database/prisma.service';
import { ResolucaoOrgUnitService } from './resolucao-orgunit.service';

/** Uma linha do CSV de turmas, como `turma_importada` a guarda. */
const linhaCsv = (
  id: number,
  codigoTurma: string,
  nomeDisciplina: string,
  codigoEad: string | null = null,
  orgUnitId: string | null = null,
) => ({ id, codigoTurma, nomeDisciplina, codigoEad, orgUnitId });

/** Uma oferta como `ofertasDoSemestre` a devolve. */
const oferta = (
  orgUnitId: string,
  codigo: string | null,
  titulo: string | null,
) => ({
  orgUnitId,
  codigo,
  titulo,
});

describe('ResolucaoOrgUnitService', () => {
  let atualizadas: { where: unknown; data: unknown }[];

  const montar = (csv: ReturnType<typeof linhaCsv>[], ofertas: unknown[]) => {
    atualizadas = [];

    const prisma = {
      turmaImportada: {
        findMany: jest.fn().mockResolvedValue(csv),
        updateMany: jest.fn().mockImplementation((args) => {
          atualizadas.push(args);
          // Reproduz o `where: { orgUnitId: null }`: so aprende quem esta vazio.
          const alvo = csv.find((t) => t.id === args.where.id);
          return Promise.resolve({
            count: alvo && alvo.orgUnitId === null ? 1 : 0,
          });
        }),
      },
    } as unknown as PrismaService;

    const enrollments = {
      ofertasDoSemestre: jest.fn().mockResolvedValue(ofertas),
    } as unknown as D2lEnrollmentsService;

    return new ResolucaoOrgUnitService(prisma, enrollments);
  };

  it('casa pelo Code COMPOSTO do Brightspace', async () => {
    const servico = montar(
      [linhaCsv(1, 'GSPS0I10227', 'HISTORIA E CULTURA', 'GSPS02EAD003')],
      [
        oferta(
          '156126',
          'GSPS02_GSPS02EAD003_GSPS0I10227_2026/1',
          'HISTORIA E CULTURA',
        ),
      ],
    );

    const r = await servico.resolver('103');

    expect(r.resolvidas).toEqual([
      {
        turmaId: 1,
        orgUnitId: '156126',
        codigoTurma: 'GSPS0I10227',
        nomeDisciplina: 'HISTORIA E CULTURA',
      },
    ]);
    expect(r.naoResolvidas).toHaveLength(0);
  });

  /**
   * ==========================================================================
   * O TESTE QUE TRAVA O ESCOPO
   * ==========================================================================
   * Percorremos as ofertas do D2L porque e assim que `escolherTurma` foi
   * escrito — mas o conjunto do lote e o das LINHAS DO CSV. Uma oferta do
   * semestre que ninguem importou nao tem prova, e trocar a senha do quiz dela
   * seria mexer numa disciplina que ninguem pediu.
   */
  it('IGNORA oferta do semestre que nao esta no CSV', async () => {
    const servico = montar(
      [linhaCsv(1, 'GSPS0I10227', 'HISTORIA E CULTURA', 'GSPS02EAD003')],
      [
        oferta(
          '156126',
          'GSPS02_GSPS02EAD003_GSPS0I10227_2026/1',
          'HISTORIA E CULTURA',
        ),
        oferta(
          '999999',
          'XXXX01_XXXX01EAD777_XXXX0I90001_2026/1',
          'DISCIPLINA SEM PROVA',
        ),
      ],
    );

    const r = await servico.resolver('103');

    expect(r.resolvidas.map((t) => t.orgUnitId)).toEqual(['156126']);
    expect(r.naoResolvidas).toHaveLength(0);
    expect(r.totalNoCsv).toBe(1);
  });

  /**
   * O recorte por semestre, que dispensa coluna e filtro extra: a importacao faz
   * upsert e NUNCA apaga, entao a tabela acumula. A linha antiga simplesmente
   * nao acha par entre as ofertas do periodo vigente.
   */
  it('deixa de fora a linha do CSV de um semestre passado', async () => {
    const servico = montar(
      [
        linhaCsv(1, 'GSPS0I10227', 'HISTORIA E CULTURA', 'GSPS02EAD003'),
        linhaCsv(2, 'ANTIGA0001', 'DISCIPLINA DE 2025', 'ANT01EAD001'),
      ],
      [
        oferta(
          '156126',
          'GSPS02_GSPS02EAD003_GSPS0I10227_2026/1',
          'HISTORIA E CULTURA',
        ),
      ],
    );

    const r = await servico.resolver('103');

    expect(r.resolvidas.map((t) => t.turmaId)).toEqual([1]);
    expect(r.naoResolvidas.map((t) => t.turmaId)).toEqual([2]);
    expect(r.naoResolvidas[0].ambigua).toBe(false);
  });

  it('duas ofertas casando a MESMA linha nao escolhem nenhuma', async () => {
    const servico = montar(
      [linhaCsv(1, 'GSPS0I10227', 'HISTORIA E CULTURA', 'GSPS02EAD003')],
      [
        oferta(
          '156126',
          'GSPS02_GSPS02EAD003_GSPS0I10227_2026/1',
          'HISTORIA E CULTURA',
        ),
        oferta(
          '156127',
          'GSPS02_GSPS02EAD003_GSPS0I10227_2026/1',
          'HISTORIA E CULTURA',
        ),
      ],
    );

    const r = await servico.resolver('103');

    expect(r.resolvidas).toHaveLength(0);
    expect(r.naoResolvidas).toHaveLength(1);
    expect(r.naoResolvidas[0].ambigua).toBe(true);
    expect(r.naoResolvidas[0].motivo).toContain('156126, 156127');
    expect(atualizadas).toHaveLength(0);
  });

  it('aprende o orgUnitId de quem estava com o campo vazio', async () => {
    const servico = montar(
      [linhaCsv(1, 'GSPS0I10227', 'HISTORIA E CULTURA', 'GSPS02EAD003')],
      [
        oferta(
          '156126',
          'GSPS02_GSPS02EAD003_GSPS0I10227_2026/1',
          'HISTORIA E CULTURA',
        ),
      ],
    );

    const r = await servico.resolver('103');

    expect(r.aprendidos).toBe(1);
    expect(atualizadas).toEqual([
      { where: { id: 1, orgUnitId: null }, data: { orgUnitId: '156126' } },
    ]);
  });

  it('nao sobrescreve orgUnitId ja gravado', async () => {
    const servico = montar(
      [
        linhaCsv(
          1,
          'GSPS0I10227',
          'HISTORIA E CULTURA',
          'GSPS02EAD003',
          '156126',
        ),
      ],
      [
        oferta(
          '156126',
          'GSPS02_GSPS02EAD003_GSPS0I10227_2026/1',
          'HISTORIA E CULTURA',
        ),
      ],
    );

    const r = await servico.resolver('103');

    expect(r.resolvidas.map((t) => t.orgUnitId)).toEqual(['156126']);
    expect(r.aprendidos).toBe(0);
    expect(atualizadas).toHaveLength(0);
  });

  /**
   * O orgUnitId gravado veio de um launch REAL naquela turma — evidencia mais
   * forte que qualquer heuristica de codigo. Sem o atalho, esta linha cairia em
   * DIVERGENTE por causa do `Code` que nao bate, e a prova ficaria sem senha.
   */
  it('usa o orgUnitId ja aprendido mesmo com o Code divergente', async () => {
    const servico = montar(
      [linhaCsv(1, 'CODIGO-QUE-MUDOU', 'NOME QUE MUDOU', null, '156126')],
      [oferta('156126', 'OUTRO_CODE_TOTALMENTE_2026/1', 'OUTRO NOME')],
    );

    const r = await servico.resolver('103');

    expect(r.resolvidas.map((t) => t.turmaId)).toEqual([1]);
  });

  it('sem CSV de turmas nao chama o Brightspace nem falha', async () => {
    const servico = montar([], []);

    const r = await servico.resolver('103');

    expect(r).toEqual({
      totalNoCsv: 0,
      resolvidas: [],
      naoResolvidas: [],
      aprendidos: 0,
    });
  });
});
