import {
  ordemDaPilha,
  porNome,
  type AlunoDaLista,
  type SalaComLista,
} from './lista-presenca.service';
import { nomeDaListaDePresenca } from './nome-de-arquivo';
import {
  pdfDeListasDePresenca,
  type ListaDePresenca,
} from './pdf-lista-presenca';

const aluno = (nome: string | null, matricula = 'UC1'): AlunoDaLista => ({
  matricula,
  nome,
  modalidade: 'EaD',
});

const ordenar = (alunos: AlunoDaLista[]) =>
  [...alunos].sort(porNome).map((a) => a.nome ?? a.matricula);

describe('ordem dentro da folha', () => {
  it('e alfabetica por nome — e o que o fiscal tem para procurar', () => {
    expect(
      ordenar([
        aluno('VINÍCIUS MENDES'),
        aluno('ERIK MACEDO'),
        aluno('MATEUS'),
      ]),
    ).toEqual(['ERIK MACEDO', 'MATEUS', 'VINÍCIUS MENDES']);
  });

  it('respeita o acento do pt-BR: ÁLVARO vem antes de AMANDA', () => {
    // Por code point "Á" (U+00C1) cairia depois de todo o alfabeto, e o nome
    // sumiria no fim da folha exatamente para quem o procura em ordem.
    expect(ordenar([aluno('AMANDA'), aluno('ÁLVARO')])).toEqual([
      'ÁLVARO',
      'AMANDA',
    ]);
  });

  it('manda quem nao tem nome para o fim, desempatado pela matricula', () => {
    expect(
      ordenar([aluno(null, 'UC9'), aluno('ZULMIRA'), aluno(null, 'UC2')]),
    ).toEqual(['ZULMIRA', 'UC2', 'UC9']);
  });

  it('desempata dois homonimos pela matricula — a ordem tem que ser estavel', () => {
    expect(
      ordenar([aluno('ANA SILVA', 'UC9'), aluno('ANA SILVA', 'UC2')]),
    ).toEqual(['ANA SILVA', 'ANA SILVA']);

    expect(
      [...[aluno('ANA SILVA', 'UC9'), aluno('ANA SILVA', 'UC2')]]
        .sort(porNome)
        .map((a) => a.matricula),
    ).toEqual(['UC2', 'UC9']);
  });
});

describe('ordem da pilha de folhas', () => {
  const sala = (p: Partial<SalaComLista>): SalaComLista => ({
    salaFaixaId: 1,
    faixaId: 1,
    poloId: 1,
    polo: 'Câmpus Asa Sul',
    salaId: 1,
    sala: 'SALA 1',
    modalidade: 'EaD',
    data: new Date('2026-06-11T00:00:00.000Z'),
    horaInicio: '09:00',
    horaFim: '12:00',
    vagas: 40,
    totalAlunos: 3,
    nomeArquivo: 'x.pdf',
    ...p,
  });

  it('sai por dia, horario, polo e sala — a ordem em que as folhas sao entregues', () => {
    const pilha = [
      sala({ sala: 'SALA 2' }),
      sala({ polo: 'Câmpus Taguatinga', sala: 'M114' }),
      sala({ horaInicio: '08:00' }),
      sala({ data: new Date('2026-06-10T00:00:00.000Z') }),
      sala({ sala: 'SALA 1' }),
    ];

    expect(
      pilha
        .sort(ordemDaPilha)
        .map(
          (s) => `${s.data.getUTCDate()} ${s.horaInicio} ${s.polo} ${s.sala}`,
        ),
    ).toEqual([
      '10 09:00 Câmpus Asa Sul SALA 1',
      '11 08:00 Câmpus Asa Sul SALA 1',
      '11 09:00 Câmpus Asa Sul SALA 1',
      '11 09:00 Câmpus Asa Sul SALA 2',
      '11 09:00 Câmpus Taguatinga M114',
    ]);
  });
});

describe('nome do arquivo da folha avulsa', () => {
  it('leva o polo, ao contrario do CSV de grupos — duas salas homonimas em campi diferentes', () => {
    const folha = {
      data: new Date('2026-06-11T00:00:00.000Z'),
      horaInicio: '09:00',
      horaFim: '12:00',
      sala: 'SALA 1 EAD',
    };

    expect(nomeDaListaDePresenca({ ...folha, polo: 'Câmpus Asa Sul' })).toBe(
      'Lista de presenca - 11-06-2026 09h00-12h00 - Campus Asa Sul - SALA 1 EAD.pdf',
    );

    expect(
      nomeDaListaDePresenca({ ...folha, polo: 'Câmpus Taguatinga' }),
    ).not.toBe(nomeDaListaDePresenca({ ...folha, polo: 'Câmpus Asa Sul' }));
  });
});

describe('o PDF', () => {
  const pagina = (alunos: number, p: Partial<ListaDePresenca> = {}) => ({
    polo: 'Câmpus Asa Sul',
    modalidade: 'EaD',
    sala: 'SALA 1 EAD',
    data: new Date('2026-06-11T00:00:00.000Z'),
    horaInicio: '09:00',
    horaFim: '12:00',
    alunos: Array.from({ length: alunos }, (_, i) => ({
      matricula: `UC2642${i}`,
      nome: `ALUNO ${i}`,
      modalidade: 'EaD',
    })),
    ...p,
  });

  /** `/Count` do no raiz de paginas — o que um leitor de PDF mostra. */
  const paginas = (pdf: Buffer) =>
    Number(/\/Count\s+(\d+)/.exec(pdf.toString('latin1'))?.[1]);

  it('da uma pagina por sala, mesmo com pouca gente', async () => {
    // Duas salas nunca dividem folha: elas vao para dois fiscais diferentes.
    expect(paginas(await pdfDeListasDePresenca([pagina(3), pagina(1)]))).toBe(
      2,
    );
  });

  it('continua na pagina seguinte quando a sala nao cabe numa folha', async () => {
    expect(paginas(await pdfDeListasDePresenca([pagina(34)]))).toBe(2);
  });

  it('nao gera pagina em branco quando nao ha sala nenhuma', async () => {
    // `autoFirstPage: false` — sem isso o pdfkit abre uma folha vazia sozinho.
    expect(paginas(await pdfDeListasDePresenca([]))).toBe(0);
  });

  it('sai como PDF de verdade, com o cabecalho de arquivo', async () => {
    const pdf = await pdfDeListasDePresenca([pagina(3)]);

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(0);
  });
});
