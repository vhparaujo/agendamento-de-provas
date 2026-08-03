import 'dotenv/config';
import { SignJWT } from 'jose';
import { createMariaDbAdapter } from '../src/database/mariadb-adapter';
import { PrismaClient } from '../src/generated/prisma/client';

/**
 * ============================================================================
 * TOKEN DE ALUNO PARA TESTE — SOMENTE DESENVOLVIMENTO
 * ============================================================================
 * O aluno nao tem senha: o token dele so nasce de um launch LTI assinado pelo
 * Brightspace, que nao da para reproduzir no Postman. Sem uma saida, o portal
 * inteiro ficaria sem como ser testado ate a integracao estar de pe.
 *
 * Este script monta o MESMO payload que o launch montaria, lendo os vinculos do
 * banco — nao inventa dados, so pula a etapa da assinatura do Brightspace.
 *
 *   npm run token:aluno -- <matricula> [orgUnitId] [titulo da turma]
 *
 * O orgUnitId simula a turma de onde o aluno clicaria. Sem ele, o token sai sem
 * contexto e o agendamento recusa por falta de disciplina — que e o
 * comportamento correto, mas nao e o que se quer testar.
 *
 * RECUSA rodar com NODE_ENV=production: emitir credencial de aluno por linha de
 * comando em producao seria uma porta dos fundos para o sistema inteiro.
 */
async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'token:aluno nao roda em producao. O token de aluno so pode vir de um launch LTI real.',
    );
  }

  const [matricula, orgUnitId, ...titulo] = process.argv.slice(2);

  if (!matricula) {
    throw new Error(
      'Informe a matricula (RA):\n' +
        '  npm run token:aluno -- UC25426847 6606 "Psicologia Geral"',
    );
  }

  const segredo = process.env.JWT_SECRET;
  if (!segredo) throw new Error('JWT_SECRET nao definida (veja o .env)');

  const prisma = new PrismaClient({ adapter: createMariaDbAdapter() });

  try {
    const vinculos = await prisma.alunoImportado.findMany({
      where: { matricula: matricula.trim().toUpperCase() },
      include: { modalidade: true, polo: true },
      orderBy: { curso: 'asc' },
    });

    if (vinculos.length === 0) {
      throw new Error(
        `Matricula ${matricula} nao encontrada. Importe o CSV de alunos primeiro ` +
          '(POST /api/importacao/alunos).',
      );
    }

    const token = await new SignJWT({
      perfil: 'ALUNO',
      // No launch real vem do claim UserId da Valence; aqui e so um marcador
      // legivel, ja que nada e enviado ao D2L nesta etapa.
      userIdD2L: `dev-${vinculos[0].matricula}`,
      vinculos: vinculos.map((v) => ({
        alunoId: v.id,
        curso: v.curso,
        modalidade: v.modalidade.codigo,
        poloId: v.poloId,
        ativo: v.ativo,
      })),
      contexto: orgUnitId
        ? { orgUnitId, titulo: titulo.join(' ') || undefined }
        : undefined,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(vinculos[0].matricula)
      .setIssuedAt()
      .setExpirationTime(process.env.JWT_ALUNO_EXPIRES_IN ?? '2h')
      .sign(new TextEncoder().encode(segredo));

    console.log(`\nAluno:   ${vinculos[0].nome ?? '(sem nome)'}`);
    console.log(`RA:      ${vinculos[0].matricula}`);

    for (const v of vinculos) {
      console.log(
        `  vinculo alunoId=${v.id}  ${v.curso}  ${v.modalidade.codigo}  ` +
          `${v.polo.nome}  ${v.ativo ? 'pode agendar' : `BLOQUEADO (${v.statusCurso})`}`,
      );
    }

    if (!orgUnitId) {
      console.log(
        '\nAVISO: sem orgUnitId o token sai sem contexto de turma, e o ' +
          'agendamento sera recusado por falta de disciplina com prova.',
      );
    }

    console.log(`\nAuthorization: Bearer ${token}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((erro: unknown) => {
  console.error(`\n[token:aluno] ${erro instanceof Error ? erro.message : String(erro)}\n`);
  process.exit(1);
});
