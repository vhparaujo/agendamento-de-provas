import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createMariaDbAdapter } from '../src/database/mariadb-adapter';
import { PrismaService } from '../src/database/prisma.service';
import { D2lGradesService } from '../src/d2l/service/d2l-grades.service';
import { D2lHttpService } from '../src/d2l/service/d2l-http.service';
import { D2lOauthService } from '../src/d2l/service/d2l-oauth.service';
import { PrismaClient } from '../src/generated/prisma/client';
import { AuditoriaService } from '../src/seguranca/service/auditoria.service';

/**
 * ============================================================================
 * A NOTA FINAL DE UM ALUNO NUMA TURMA — SOMENTE DESENVOLVIMENTO
 * ============================================================================
 *   npm run d2l:notas -- <orgUnitId> [userId]
 *
 * Sem o `userId`, le a TURMA INTEIRA (o caminho que o compulsorio usa) e imprime
 * um resumo em vez da lista — que numa turma real tem centenas de linhas.
 *
 * POR QUE ELE EXISTE: a faixa de nota da rodada decide quem faz a substitutiva,
 * e a decisao e tomada sobre campos que so o tenant sabe responder — se
 * `PointsDenominator` vem 10 (a nota ja fechou) ou menos (o semestre ainda esta
 * correndo), e se a rota devolve a nota AJUSTADA quando o professor a lancou ou
 * sempre a calculada. Conferir isso com um aluno de nota conhecida, antes de
 * abrir a janela, e o que separa "a regra esta certa" de "a regra parece certa".
 *
 * O JSON CRU tambem e impresso: e nele que se ve o `GradeObjectName`, o unico
 * campo que diz de qual nota final o valor veio.
 *
 * Escopo: **`grades:gradevalues:read`**. Ele vive no CONSENTIMENTO, e nao no
 * `.env` — acrescenta-lo a `D2L_SCOPES` sem refazer `npm run d2l:autorizar`
 * deixa este script respondendo 403.
 *
 * As dependencias sao montadas A MAO, sem subir o Nest, pelo mesmo motivo do
 * `d2l:token`: o `tsx` compila com esbuild, que nao emite
 * `emitDecoratorMetadata`, e a injecao por tipo chegaria `undefined`.
 *
 * RECUSA rodar com NODE_ENV=production: nota de aluno e dado pessoal, e a
 * producao nao imprime isso num terminal.
 */
async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'd2l:notas nao roda em producao: nota de aluno e dado pessoal, e o lugar ' +
        'de consulta-la e o Brightspace.',
    );
  }

  const [orgUnitId, userId] = process.argv.slice(2);

  if (!orgUnitId) {
    throw new Error(
      'Uso: npm run d2l:notas -- <orgUnitId> [userId]\n' +
        '  <orgUnitId>  a turma (course offering) no Brightspace\n' +
        '  [userId]     o UserId numerico do aluno; sem ele, le a turma inteira',
    );
  }

  const prisma = new PrismaClient({ adapter: createMariaDbAdapter() });
  const config = new ConfigService(process.env as Record<string, unknown>);

  const oauth = new D2lOauthService(
    config,
    prisma as unknown as PrismaService,
    new AuditoriaService(),
  );

  const grades = new D2lGradesService(config, new D2lHttpService(config, oauth));

  try {
    console.log(`\nAPI LE ${grades.versaoDaApi()} · turma ${orgUnitId}\n`);

    if (userId) {
      await umAluno(grades, orgUnitId, userId);
    } else {
      await aTurmaInteira(grades, orgUnitId);
    }
  } finally {
    await prisma.$disconnect();
  }
}

async function umAluno(
  grades: D2lGradesService,
  orgUnitId: string,
  userId: string,
): Promise<void> {
  const nota = await grades.notaFinal(orgUnitId, userId);

  console.log(`Normalizado: ${JSON.stringify(nota, null, 2)}\n`);

  if (nota.situacao === 'SEM_NOTA') {
    console.log(
      'SEM_NOTA: 404 do tenant, ou nota final sem numerador. Pode ser a turma ' +
        'que ainda nao fechou notas, ou o aluno que ja nao esta nela.\n' +
        'Na substitutiva, SEM_NOTA significa NAO PODE AGENDAR.\n',
    );
    return;
  }

  console.log(`Pontos (o que a faixa compara): ${nota.pontos}`);
  console.log(`Denominador: ${nota.denominador ?? '(nao informado)'}`);
  console.log(`Origem da nota: ${nota.origem}`);
  console.log(`Como o aluno ve: ${nota.exibida ?? '(vazio)'}\n`);

  if (nota.denominador !== null && nota.denominador !== 10) {
    console.log(
      `⚠️  A nota final desta turma vale no maximo ${nota.denominador}, e nao 10. ` +
        'A faixa da rodada compara PONTOS: com o semestre ainda correndo, a ' +
        'turma inteira parece estar abaixo da media.\n',
    );
  }

  if (nota.origem !== 'AJUSTADA') {
    console.log(
      'A rota devolveu a nota ' +
        (nota.origem === 'CALCULADA' ? 'CALCULADA' : 'de origem DESCONHECIDA') +
        '. Se este aluno TEM nota ajustada lancada no Brightspace e ela nao ' +
        'apareceu aqui, a leitura precisa passar a buscar o grade object ' +
        'ajustado (`grades/(gradeObjectId)/values/(userId)`), que exige tambem ' +
        'o escopo grades:gradeobjects:read.\n',
    );
  }
}

async function aTurmaInteira(
  grades: D2lGradesService,
  orgUnitId: string,
): Promise<void> {
  const notas = await grades.notasFinaisDaTurma(orgUnitId, { atrasoMs: 200 });

  const comNota = [...notas.values()].filter((n) => n.situacao === 'ACHOU');
  const semNota = notas.size - comNota.length;

  console.log(`${notas.size} aluno(s) na turma`);
  console.log(`  com nota final: ${comNota.length}`);
  console.log(`  sem nota final: ${semNota}\n`);

  const denominadores = new Set(
    comNota.map((n) => (n.situacao === 'ACHOU' ? n.denominador : null)),
  );

  const origens = new Set(
    comNota.map((n) => (n.situacao === 'ACHOU' ? n.origem : null)),
  );

  console.log(`Denominadores encontrados: ${[...denominadores].join(', ')}`);
  console.log(`Origens encontradas: ${[...origens].join(', ')}\n`);

  // As tres primeiras bastam para ver o formato; a turma inteira seriam
  // centenas de linhas de dado pessoal rolando no terminal.
  console.log('Amostra (3 primeiras):');
  for (const [userId, nota] of [...notas].slice(0, 3)) {
    console.log(`  ${userId}: ${JSON.stringify(nota)}`);
  }
  console.log('');
}

main().catch((erro: unknown) => {
  new Logger('d2l:notas').error(
    erro instanceof Error ? erro.message : String(erro),
  );
  process.exit(1);
});
