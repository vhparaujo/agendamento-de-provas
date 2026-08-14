import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/client';
import { createMariaDbAdapter } from '../src/database/mariadb-adapter';

/**
 * DADOS DE TESTE: salas + faixas + ofertas (SalaFaixa) em TODOS os polos ativos.
 *
 * NAO e seed de producao — nao entra em prisma/seed.ts. Existe para que se possa
 * exercitar o portal, a alocacao e os relatorios com uma estrutura completa sem
 * cadastrar polo por polo na tela. Recusa rodar com NODE_ENV=production, mesmo
 * motivo do token:aluno: e dado inventado.
 *
 *   npm run seed:teste
 *
 * IDEMPOTENTE: sala casa por (polo, nome), faixa por (polo, data, hora) e oferta
 * por (sala, faixa) — re-rodar reaproveita o que ja existe em vez de duplicar.
 * A faixa nao tem unique de banco nesses campos (uma faixa repetida e cadastro
 * valido), entao a checagem e feita aqui, na leitura.
 *
 * ------------------------------------------------------------------------
 * POR QUE 6 SALAS POR POLO, E NAO 2
 * ------------------------------------------------------------------------
 * As faixas se sobrepoem no relogio: a de EaD 09h00-12h00 cobre as duas de
 * 1h30 da manha (08h30-10h00 e 10h30-12h00). Uma sala fisica nao pode receber
 * duas provas ao mesmo tempo — e o banco nao impede isso (o unique de SalaFaixa
 * e por faixa, nao por horario). Por isso a distribuicao e por BLOCO:
 *
 *   Salas 1-2  ->  a faixa de EaD do bloco
 *   Salas 3-4  ->  SEMI, nas duas faixas de 1h30 do bloco
 *   Salas 5-6  ->  MODULAR, nas duas faixas de 1h30 do bloco
 *
 * As duas faixas de 1h30 do mesmo bloco NAO se sobrepoem entre si, entao elas
 * reaproveitam as mesmas salas. Seis salas cobrem o dia inteiro sem nenhum
 * choque fisico, e se repetem em todos os dias do periodo.
 *
 * SEMI e MODULAR ganham salas PROPRIAS na mesma faixa porque a modalidade vive
 * na oferta, nao na faixa: uma faixa so com salas SEMI deixaria todo aluno
 * Modular sem onde agendar naquele horario — que e justamente o que se quer
 * testar. Sao 2 salas por modalidade, como pedido, e nao 2 por faixa.
 */

const DATA_INICIO = '2026-08-17';
const DATA_FIM = '2026-08-23';

const CAPACIDADE_MINIMA = 20;
const CAPACIDADE_MAXIMA = 30;

/** Horarios de EaD — 3h, a duracao da modalidade. */
const FAIXAS_EAD = [
  { horaInicio: '09:00', horaFim: '12:00' },
  { horaInicio: '15:00', horaFim: '18:00' },
  { horaInicio: '19:00', horaFim: '22:00' },
] as const;

/**
 * Horarios de SEMI e MODULAR — 1h30 cada, as mesmas faixas para as duas
 * modalidades. Agrupados pelo bloco do dia (manha/tarde/noite) na mesma ordem
 * de FAIXAS_EAD: e o indice do bloco que decide quais salas cada faixa usa.
 */
const FAIXAS_CURTAS_POR_BLOCO = [
  [
    { horaInicio: '08:30', horaFim: '10:00' },
    { horaInicio: '10:30', horaFim: '12:00' },
  ],
  [
    { horaInicio: '14:00', horaFim: '15:30' },
    { horaInicio: '16:00', horaFim: '17:30' },
  ],
  [
    { horaInicio: '18:00', horaFim: '19:30' },
    { horaInicio: '20:00', horaFim: '21:30' },
  ],
] as const;

/** Quais salas (1-based, na ordem de criacao) atendem cada modalidade. */
const SALAS_EAD = [1, 2];
const SALAS_SEMI = [3, 4];
const SALAS_MODULAR = [5, 6];
const TOTAL_DE_SALAS = 6;

interface Horario {
  readonly horaInicio: string;
  readonly horaFim: string;
}

function capacidadeAleatoria(): number {
  const faixa = CAPACIDADE_MAXIMA - CAPACIDADE_MINIMA + 1;
  return CAPACIDADE_MINIMA + Math.floor(Math.random() * faixa);
}

/**
 * As datas do periodo, em UTC. `Faixa.data` e @db.Date: montar com
 * `new Date('2026-08-17')` local jogaria o dia para tras em fuso negativo (o
 * Brasil inteiro), e a prova apareceria um dia antes na tela.
 */
function datasDoPeriodo(inicio: string, fim: string): Date[] {
  const primeira = new Date(`${inicio}T00:00:00.000Z`);
  const ultima = new Date(`${fim}T00:00:00.000Z`);
  const datas: Date[] = [];

  for (let d = primeira; d <= ultima; d = new Date(d.getTime() + 86_400_000)) {
    datas.push(new Date(d));
  }

  return datas;
}

async function garantirSalas(
  prisma: PrismaClient,
  poloId: number,
): Promise<number[]> {
  const ids: number[] = [];

  for (let numero = 1; numero <= TOTAL_DE_SALAS; numero++) {
    const nome = `Sala ${numero}`;
    // update vazio: re-rodar nao sorteia capacidade nova por cima da que o
    // admin possa ter ajustado na tela.
    const sala = await prisma.sala.upsert({
      where: { poloId_nome: { poloId, nome } },
      update: {},
      create: { poloId, nome, capacidade: capacidadeAleatoria() },
    });

    ids.push(sala.id);
  }

  return ids;
}

async function garantirFaixa(
  prisma: PrismaClient,
  poloId: number,
  data: Date,
  horario: Horario,
): Promise<number> {
  const existente = await prisma.faixa.findFirst({
    where: {
      poloId,
      data,
      horaInicio: horario.horaInicio,
      horaFim: horario.horaFim,
    },
  });

  if (existente) return existente.id;

  const criada = await prisma.faixa.create({
    data: {
      poloId,
      data,
      horaInicio: horario.horaInicio,
      horaFim: horario.horaFim,
    },
  });

  return criada.id;
}

async function garantirOferta(
  prisma: PrismaClient,
  salaId: number,
  faixaId: number,
  modalidadeId: number,
  ordem: number,
  vagas: number,
): Promise<void> {
  await prisma.salaFaixa.upsert({
    where: { salaId_faixaId: { salaId, faixaId } },
    update: {},
    create: { salaId, faixaId, modalidadeId, vagas, ordem },
  });
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    console.error('[seed:teste] recusado: NODE_ENV=production');
    process.exit(1);
  }

  const prisma = new PrismaClient({ adapter: createMariaDbAdapter() });

  try {
    const modalidades = await prisma.modalidade.findMany();
    const idPorCodigo = new Map(modalidades.map((m) => [m.codigo, m.id]));
    const ead = idPorCodigo.get('EAD');
    const semi = idPorCodigo.get('SEMI');
    const modular = idPorCodigo.get('MODULAR');

    if (!ead || !semi || !modular) {
      throw new Error('modalidades ausentes — rode `npm run seed` antes');
    }

    const polos = await prisma.polo.findMany({
      where: { ativo: true },
      orderBy: { id: 'asc' },
    });

    if (polos.length === 0) {
      throw new Error('nenhum polo ativo — rode `npm run seed` antes');
    }

    const datas = datasDoPeriodo(DATA_INICIO, DATA_FIM);
    let totalFaixas = 0;
    let totalOfertas = 0;

    for (const polo of polos) {
      const salaIds = await garantirSalas(prisma, polo.id);
      const salas = await prisma.sala.findMany({
        where: { id: { in: salaIds } },
      });
      const vagasPorSala = new Map(salas.map((s) => [s.id, s.capacidade]));
      // salaIds esta na ordem de criacao (Sala 1..6), entao o numero da sala
      // menos 1 e o indice — e o que as constantes SALAS_* referenciam.
      const salaDoNumero = (numero: number): number => salaIds[numero - 1];

      for (const data of datas) {
        for (let bloco = 0; bloco < FAIXAS_EAD.length; bloco++) {
          const faixaEadId = await garantirFaixa(
            prisma,
            polo.id,
            data,
            FAIXAS_EAD[bloco],
          );
          totalFaixas++;

          for (const [indice, numero] of SALAS_EAD.entries()) {
            const salaId = salaDoNumero(numero);
            await garantirOferta(
              prisma,
              salaId,
              faixaEadId,
              ead,
              indice + 1,
              vagasPorSala.get(salaId) ?? CAPACIDADE_MINIMA,
            );
            totalOfertas++;
          }

          for (const horario of FAIXAS_CURTAS_POR_BLOCO[bloco]) {
            const faixaId = await garantirFaixa(prisma, polo.id, data, horario);
            totalFaixas++;

            for (const [modalidadeId, numeros] of [
              [semi, SALAS_SEMI],
              [modular, SALAS_MODULAR],
            ] as const) {
              for (const [indice, numero] of numeros.entries()) {
                const salaId = salaDoNumero(numero);
                await garantirOferta(
                  prisma,
                  salaId,
                  faixaId,
                  modalidadeId,
                  indice + 1,
                  vagasPorSala.get(salaId) ?? CAPACIDADE_MINIMA,
                );
                totalOfertas++;
              }
            }
          }
        }
      }

      console.log(`[seed:teste] ${polo.nome}: ok`);
    }

    console.log(
      `[seed:teste] ${polos.length} polos · ${polos.length * TOTAL_DE_SALAS} salas · ` +
        `${totalFaixas} faixas · ${totalOfertas} ofertas ` +
        `(${DATA_INICIO} a ${DATA_FIM})`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((erro: unknown) => {
  console.error('[seed:teste] falhou:', erro);
  process.exit(1);
});
