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
 * AS NOTAS DE UM ALUNO NUMA TURMA — SOMENTE DESENVOLVIMENTO
 * ============================================================================
 *   npm run d2l:notas -- <orgUnitId> [userId]
 *
 * Sem o `userId`, le a TURMA INTEIRA (o caminho que o compulsorio usa) e imprime
 * um resumo em vez da lista — que numa turma real tem centenas de linhas.
 *
 * POR QUE ELE EXISTE: os criterios de nota da rodada decidem quem faz a
 * substitutiva, e a decisao e tomada sobre coisas que so o tenant sabe
 * responder — se `PointsDenominator` vem 10 (a nota ja fechou) ou menos (o
 * semestre ainda corre), se a rota devolve a AJUSTADA quando o professor a
 * lancou, e **se a turma tem mesmo uma categoria chamada "N1"**. Conferir isso
 * com um aluno de nota conhecida, antes de abrir a janela, e o que separa "a
 * regra esta certa" de "a regra parece certa".
 *
 * ⚠️ **A pendencia que este script existe para achar hoje e a categoria N1.** A
 * turma que chamou a categoria de "Nota 1" recusa TODOS os seus alunos, e o
 * unico sinal em producao e uma linha de WARN no log — descoberta quando o aluno
 * ligar dizendo que a prova nao aparece.
 *
 * O JSON CRU tambem e impresso: e nele que se ve o `GradeObjectName`, o unico
 * campo que diz de qual nota final o valor veio.
 *
 * Escopos: **`grades:gradevalues:read`** e **`grades:gradecategories:read`**.
 * Eles vivem no CONSENTIMENTO, e nao no `.env` — acrescenta-los a `D2L_SCOPES`
 * sem refazer `npm run d2l:autorizar` deixa este script respondendo 403.
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

  const grades = new D2lGradesService(
    config,
    new D2lHttpService(config, oauth),
  );

  try {
    console.log(`\nAPI LE ${grades.versaoDaApi()} · turma ${orgUnitId}\n`);

    const categoriaN1 = await aCategoriaN1(grades, orgUnitId);

    if (userId) {
      await umAluno(grades, orgUnitId, userId, categoriaN1);
    } else {
      await aTurmaInteira(grades, orgUnitId, categoriaN1);
    }
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Resolve — e explica — a categoria de notas que vale como N1.
 *
 * Roda ANTES da leitura das notas de proposito: sem ela, nenhum aluno da turma
 * agenda, e saber isso primeiro poupa a leitura da turma inteira.
 */
async function aCategoriaN1(
  grades: D2lGradesService,
  orgUnitId: string,
): Promise<string | null> {
  const nome = grades.nomeDaCategoriaN1();
  const id = await grades.categoriaPorNome(orgUnitId, nome);

  if (id === null) {
    console.log(
      `❌ Esta turma NAO tem categoria de notas chamada "${nome}".\n` +
        '   Na substitutiva isso recusa TODOS os alunos dela (motivo ' +
        'SEM_CATEGORIA_N1).\n' +
        '   Conserto: renomear a categoria no Brightspace, ou ajustar ' +
        'D2L_CATEGORIA_N1 no .env.\n' +
        '   (O log da aplicacao lista os nomes que a turma tem.)\n',
    );
    return null;
  }

  console.log(`Categoria "${nome}": CategoryId ${id}`);
  console.log(
    '  (o id muda de turma para turma — por isso a busca e pelo NOME)\n',
  );

  return id;
}

async function umAluno(
  grades: D2lGradesService,
  orgUnitId: string,
  userId: string,
  categoriaN1: string | null,
): Promise<void> {
  const nota = await grades.notaFinal(orgUnitId, userId);

  console.log(`Nota final normalizada: ${JSON.stringify(nota, null, 2)}\n`);

  if (categoriaN1 !== null) {
    const n1 = await grades.notaDeGradeObject(orgUnitId, categoriaN1, userId);

    console.log(`N1 normalizada: ${JSON.stringify(n1, null, 2)}\n`);

    if (n1.situacao === 'SEM_NOTA') {
      console.log(
        'SEM_NOTA na N1: a categoria existe, mas este aluno nao tem valor ' +
          'nela. Na substitutiva isso e NAO PODE AGENDAR (SEM_NOTA_N1) — ' +
          'mesmo com a nota final dentro do teto.\n',
      );
    } else {
      console.log(`Pontos da N1 (o piso compara isto): ${n1.pontos}`);
      console.log(
        `Denominador da N1: ${n1.denominador ?? '(nao informado)'}\n`,
      );
    }
  }

  if (nota.situacao === 'SEM_NOTA') {
    console.log(
      'SEM_NOTA: 404 do tenant, ou nota final sem numerador. Pode ser a turma ' +
        'que ainda nao fechou notas, ou o aluno que ja nao esta nela.\n' +
        'Na substitutiva, SEM_NOTA significa NAO PODE AGENDAR.\n',
    );
    return;
  }

  console.log(`Pontos da final (o teto compara isto): ${nota.pontos}`);
  console.log(`Denominador: ${nota.denominador ?? '(nao informado)'}`);
  console.log(`Origem da nota: ${nota.origem}`);
  console.log(`Como o aluno ve: ${nota.exibida ?? '(vazio)'}\n`);

  if (nota.denominador !== null && nota.denominador !== 10) {
    console.log(
      `⚠️  A nota final desta turma vale no maximo ${nota.denominador}, e nao 10. ` +
        'A regra da rodada compara PONTOS: com o semestre ainda correndo, a ' +
        'turma inteira parece estar abaixo da media — e o teto da final ' +
        'deixaria passar quem ja passou.\n',
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
  categoriaN1: string | null,
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

  // Quantos tem N1 importa tanto quanto quantos tem nota final: os dois
  // criterios sao obrigatorios, e quem falta em um nao agenda.
  if (categoriaN1 !== null) {
    const n1 = await grades.notasDeGradeObjectDaTurma(orgUnitId, categoriaN1, {
      atrasoMs: 200,
    });

    const comN1 = [...n1.values()].filter((n) => n.situacao === 'ACHOU').length;

    console.log(`N1 (categoria ${categoriaN1}):`);
    console.log(`  com nota na N1: ${comN1}`);
    console.log(`  sem nota na N1: ${n1.size - comN1}`);
    console.log(
      '  (sem N1 lancada o aluno NAO agenda, mesmo com a final na faixa)\n',
    );
  }

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
