import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { writeFileSync } from 'node:fs';
import { DisciplinasDoAlunoService } from '../src/agendamento/service/disciplinas-do-aluno.service';
import { ElegibilidadeDeNotaService } from '../src/agendamento/service/elegibilidade-de-nota.service';
import { createMariaDbAdapter } from '../src/database/mariadb-adapter';
import { PrismaService } from '../src/database/prisma.service';
import { D2lEnrollmentsService } from '../src/d2l/service/d2l-enrollments.service';
import { D2lGradesService } from '../src/d2l/service/d2l-grades.service';
import { D2lHttpService } from '../src/d2l/service/d2l-http.service';
import { D2lOauthService } from '../src/d2l/service/d2l-oauth.service';
import { PrismaClient } from '../src/generated/prisma/client';
import { PeriodoService } from '../src/periodo/service/periodo.service';
import { AuditoriaService } from '../src/seguranca/service/auditoria.service';
import { TurmaService } from '../src/turma/service/turma.service';

/**
 * ============================================================================
 * QUEM AGENDOU COM DISCIPLINA DE MENOS — SOMENTE LEITURA
 * ============================================================================
 *   npm run agendamentos:incompletos
 *   npm run agendamentos:incompletos -- --csv incompletos.csv
 *   npm run agendamentos:incompletos -- --delay 300 --limite 50
 *
 * POR QUE ELE EXISTE. Em 26/08/2026 o refresh token da Valence ficou invalido
 * no meio da janela. O portal NAO caiu: `cairParaOLaunch` degradou a lista para
 * a turma de onde o aluno clicou, e cada aluno agendou cobrindo UMA disciplina
 * em vez de todas as dele. O sintoma no log era `AGENDAMENTO_CRIADO ... 1
 * disciplina(s)` repetido, e nenhum aluno recebeu erro nenhum.
 *
 * O QUE ELE FAZ. Para cada agendamento CONFIRMADO da janela vigente, refaz o
 * cruzamento AGORA (com a Valence de pe) e compara com o que ficou gravado em
 * `agendamento_disciplina`. Quem tiver menos disciplinas gravadas do que o
 * cruzamento devolve hoje entra no relatorio, com a lista do que faltou.
 *
 * ---------------------------------------------------------------------------
 * POR QUE NAO BASTA `HAVING COUNT(*) = 1`
 * ---------------------------------------------------------------------------
 * Porque UMA disciplina e o estado CORRETO de muita gente: aluno que cursa uma
 * materia so, ou que na substitutiva ficou elegivel em uma so. Uma lista feita
 * por contagem misturaria esses com as vitimas do fallback, e a secretaria
 * remanejaria prova de quem estava certo. A unica pergunta que separa os dois e
 * "quantas ele teria HOJE?", e e essa que este script faz.
 *
 * ---------------------------------------------------------------------------
 * POR QUE ELE NAO USA A JANELA DE TEMPO DO INCIDENTE
 * ---------------------------------------------------------------------------
 * Seria o caminho obvio — `WHERE createdAt BETWEEN ...` — e ele nao esta
 * disponivel: os logs do container morreram no `docker rm`, e a reautorizacao
 * sobrescreveu o `integracao_d2l.atualizadoEm`, que era a outra pista de quando
 * a queda comecou. Comparar o estado atual nao depende de nenhum dos dois, e
 * ainda pega agendamento incompleto por qualquer outra causa (matricula que
 * entrou depois, turma acrescentada ao CSV mais tarde).
 *
 * ---------------------------------------------------------------------------
 * NAO ESCREVE NADA. NUNCA.
 * ---------------------------------------------------------------------------
 * A correcao — acrescentar as disciplinas que faltam a um agendamento ja
 * confirmado — muda prova de aluno e e decisao da secretaria, nao de um script
 * de diagnostico. Aqui so sai a lista.
 *
 * RODA EM PRODUCAO de proposito, ao contrario de `d2l:notas`: e la que estao os
 * agendamentos, e a saida e uma lista de matriculas e disciplinas (o mesmo que
 * a secretaria ja ve na tela), nao nota de aluno.
 *
 * RITMO: uma chamada a Valence por aluno, em serie, com `--delay` entre elas
 * (default 200ms). A arvore do periodo letivo e baixada UMA vez e fica em cache
 * dentro do `D2lEnrollmentsService`, entao o custo por aluno e so a leitura das
 * matriculas dele. Numa janela de substitutiva ha ainda uma leitura de nota por
 * disciplina — por isso o default e conservador.
 *
 * As dependencias sao montadas A MAO, sem subir o Nest, pelo mesmo motivo do
 * `d2l:notas`: o `tsx` compila com esbuild, que nao emite
 * `emitDecoratorMetadata`, e a injecao por tipo chegaria `undefined`.
 */

interface Opcoes {
  csv?: string;
  delayMs: number;
  limite?: number;
}

interface Achado {
  agendamentoId: number;
  matricula: string;
  nome: string | null;
  curso: string;
  gravadas: string[];
  esperadas: string[];
  faltando: string[];
}

/** Erro do aluno que nao derruba o lote — vira linha no rodape. */
interface Falha {
  agendamentoId: number;
  matricula: string;
  causa: string;
}

function lerOpcoes(argv: string[]): Opcoes {
  const opcoes: Opcoes = { delayMs: 200 };

  for (let i = 0; i < argv.length; i++) {
    const valor = argv[i + 1];

    if (argv[i] === '--csv') opcoes.csv = valor;
    if (argv[i] === '--delay') opcoes.delayMs = Number(valor);
    if (argv[i] === '--limite') opcoes.limite = Number(valor);
  }

  if (!Number.isFinite(opcoes.delayMs) || opcoes.delayMs < 0) {
    throw new Error('--delay precisa ser um numero de milissegundos >= 0.');
  }

  return opcoes;
}

const dormir = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const opcoes = lerOpcoes(process.argv.slice(2));

  const prisma = new PrismaClient({ adapter: createMariaDbAdapter() });
  const config = new ConfigService(process.env as Record<string, unknown>);
  const auditoria = new AuditoriaService();
  const comoPrisma = prisma as unknown as PrismaService;

  const oauth = new D2lOauthService(config, comoPrisma, auditoria);
  const http = new D2lHttpService(config, oauth);
  const enrollments = new D2lEnrollmentsService(config, http);
  const periodo = new PeriodoService(comoPrisma, auditoria);
  const turmas = new TurmaService(comoPrisma, config);
  const elegibilidade = new ElegibilidadeDeNotaService(
    new D2lGradesService(config, http),
  );

  const disciplinas = new DisciplinasDoAlunoService(
    turmas,
    enrollments,
    periodo,
    elegibilidade,
  );

  try {
    // Sem a integracao de pe, TODO aluno pareceria incompleto (o cruzamento
    // devolveria vazio) e o relatorio mandaria a secretaria remanejar a
    // instituicao inteira. Melhor recusar do que produzir essa lista.
    if (!enrollments.habilitado()) {
      throw new Error(
        'D2L_HABILITADO esta desligado: sem a Valence nao ha com o que comparar ' +
          'o que foi gravado. Ligue a integracao e rode de novo.',
      );
    }

    const vigente = await periodo.janelaVigente();

    if (!vigente) {
      throw new Error(
        'Nenhum periodo de agendamento cadastrado — nao ha janela para conferir.',
      );
    }

    console.log(
      `\nJanela: periodos letivos ${vigente.periodoLetivoIds.join(', ')}, ` +
        `rodada ${vigente.rodada}` +
        (vigente.filtroDeNota
          ? ` (faixa de nota [${vigente.filtroDeNota.minima}; ${vigente.filtroDeNota.maxima}))`
          : ' (sem filtro de nota)'),
    );

    // A janela inteira: as reservas dos presenciais estao sob o outro org unit,
    // e conferir so uma grade daria um relatorio pela metade sem dizer que era.
    const agendamentos = await prisma.agendamento.findMany({
      where: {
        status: 'CONFIRMADO',
        periodoLetivoId: { in: vigente.periodoLetivoIds },
        rodada: vigente.rodada,
      },
      orderBy: { id: 'asc' },
      ...(opcoes.limite ? { take: opcoes.limite } : {}),
      select: {
        id: true,
        matricula: true,
        userIdD2L: true,
        // A modalidade do AGENDAMENTO (fotografia): e ela que diz de qual grade
        // as disciplinas daquela reserva sairam, e reconferir pela modalidade
        // de hoje compararia a lista contra a arvore errada.
        modalidade: { select: { codigo: true } },
        aluno: { select: { nome: true, curso: true } },
        disciplinas: { select: { orgUnitId: true, nomeDisciplina: true } },
      },
    });

    console.log(
      `Agendamentos confirmados a conferir: ${agendamentos.length}\n`,
    );

    const achados: Achado[] = [];
    const falhas: Falha[] = [];
    let conferidos = 0;

    for (const ag of agendamentos) {
      conferidos++;

      if (conferidos % 25 === 0) {
        console.log(`  ... ${conferidos}/${agendamentos.length}`);
      }

      try {
        const { agendaveis } = await disciplinas.cruzarPorUserId(
          ag.userIdD2L,
          ag.modalidade.codigo,
        );

        const gravadas = new Set(ag.disciplinas.map((d) => d.orgUnitId));

        const faltando = agendaveis.filter((d) => !gravadas.has(d.orgUnitId));

        if (faltando.length > 0) {
          achados.push({
            agendamentoId: ag.id,
            matricula: ag.matricula,
            nome: ag.aluno.nome,
            curso: ag.aluno.curso,
            gravadas: ag.disciplinas.map(
              (d) => d.nomeDisciplina ?? d.orgUnitId,
            ),
            esperadas: agendaveis.map((d) => d.nomeDisciplina ?? d.orgUnitId),
            faltando: faltando.map((d) => d.nomeDisciplina ?? d.orgUnitId),
          });
        }
      } catch (erro) {
        // Uma falha de rede num aluno nao pode derrubar o levantamento inteiro:
        // ele vai para o rodape e e reconferido rodando de novo.
        falhas.push({
          agendamentoId: ag.id,
          matricula: ag.matricula,
          causa: erro instanceof Error ? erro.message : String(erro),
        });
      }

      if (opcoes.delayMs > 0) await dormir(opcoes.delayMs);
    }

    relatar(achados, falhas, agendamentos.length - falhas.length);

    if (opcoes.csv) {
      writeFileSync(opcoes.csv, montarCsv(achados), 'utf8');
      console.log(`\nCSV gravado em ${opcoes.csv}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * `total` e quantos foram REALMENTE conferidos, nao quantos foram tentados.
 *
 * A diferenca importa: com a Valence fora, todos falham e "nenhum incompleto
 * entre os 300 conferidos" seria lido como "esta tudo certo" quando nada foi
 * verificado. E o mesmo erro que este script existe para nao repetir.
 */
function relatar(achados: Achado[], falhas: Falha[], total: number): void {
  if (total === 0) {
    console.log(
      'NENHUM agendamento pode ser conferido — ver as falhas abaixo. ' +
        'Isto NAO significa que esta tudo certo.',
    );
  } else if (achados.length === 0) {
    console.log(
      `Nenhum agendamento incompleto entre os ${total} conferidos. ` +
        'Todo mundo tem gravadas as disciplinas que o cruzamento devolve hoje.',
    );
  } else {
    console.log(
      `\n${achados.length} de ${total} agendamento(s) com disciplina faltando:\n`,
    );

    for (const a of achados) {
      console.log(
        `  #${a.agendamentoId}  ${a.matricula}  ${a.nome ?? '(sem nome)'}  [${a.curso}]`,
      );
      console.log(`     gravadas: ${a.gravadas.join(' | ') || '(nenhuma)'}`);
      console.log(`     faltando: ${a.faltando.join(' | ')}`);
    }
  }

  if (falhas.length > 0) {
    console.log(
      `\n⚠️  ${falhas.length} aluno(s) NAO puderam ser conferidos — rode de novo ` +
        'para reprocessar so eles:\n',
    );

    for (const f of falhas) {
      console.log(`  #${f.agendamentoId}  ${f.matricula}: ${f.causa}`);
    }
  }
}

/** Aspas duplicadas e campo entre aspas: nome de disciplina tem virgula. */
function campo(valor: string): string {
  return `"${valor.replace(/"/g, '""')}"`;
}

function montarCsv(achados: Achado[]): string {
  const linhas = [
    'agendamentoId,matricula,nome,curso,qtdGravadas,qtdEsperadas,gravadas,faltando',
  ];

  for (const a of achados) {
    linhas.push(
      [
        a.agendamentoId,
        campo(a.matricula),
        campo(a.nome ?? ''),
        campo(a.curso),
        a.gravadas.length,
        a.esperadas.length,
        campo(a.gravadas.join(' | ')),
        campo(a.faltando.join(' | ')),
      ].join(','),
    );
  }

  return linhas.join('\n') + '\n';
}

main().catch((erro: unknown) => {
  console.error(erro instanceof Error ? erro.message : erro);
  process.exit(1);
});
