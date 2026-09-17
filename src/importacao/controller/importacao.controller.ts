import {
  BadRequestException,
  Body,
  Controller,
  Get,
  ParseFilePipeBuilder,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AdminJwtPayload } from '../../auth/jwt/jwt.types';
import { AdminLogado, SomenteAdmin } from '../../auth/roles.decorator';
import { TAGS } from '../../config/swagger';
import { LIMITE_UPLOAD } from '../../config/throttler.config';
import { PrismaService } from '../../database/prisma.service';
import {
  ImportacaoCsvDto,
  ResultadoImportacaoAlunosDto,
  ResultadoImportacaoTurmasDto,
} from '../dto/importacao.response.dto';
import {
  ImportarAlunosDto,
  MODALIDADES_UPLOAD,
} from '../dto/importar-alunos.dto';
import { ImportacaoAlunosService } from '../service/importacao-alunos.service';
import { ImportacaoTurmasService } from '../service/importacao-turmas.service';

const LIMITE_ARQUIVO = 15 * 1024 * 1024; // 15 MB — o maior CSV real tem ~400 KB

/** Aceita apenas CSV, checando extensao (o mimetype varia entre navegadores). */
const validarCsv = new ParseFilePipeBuilder()
  .addMaxSizeValidator({ maxSize: LIMITE_ARQUIVO })
  .build({ fileIsRequired: true });

/** O campo do arquivo e comum aos dois uploads. */
const CAMPO_ARQUIVO = {
  type: 'string',
  format: 'binary',
  description:
    'Arquivo .csv (max 15 MB). Encoding ISO-8859-1 ou UTF-8 — detectado automaticamente.',
} as const;

@ApiTags(TAGS.IMPORTACAO)
@Controller('importacao')
@SomenteAdmin()
export class ImportacaoController {
  constructor(
    private readonly alunosService: ImportacaoAlunosService,
    private readonly turmasService: ImportacaoTurmasService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Upload do CSV de alunos. O formato NAO e coluna do arquivo: vem do
   * dropdown do upload, correspondendo a aba de origem (EaD / Semi / Modular).
   * Reenviar o mesmo arquivo atualiza os registros, nunca duplica.
   */
  @Post('alunos')
  @Throttle(LIMITE_UPLOAD)
  @UseInterceptors(
    FileInterceptor('arquivo', { limits: { fileSize: LIMITE_ARQUIVO } }),
  )
  @ApiOperation({
    summary: 'Importa o CSV de alunos',
    description:
      'Colunas esperadas: **RA**, **ALUNO**, **EMAIL INSTITUCIONAL**, **CURSO**, **STATUS CURSO**, ' +
      '**CAMPUS** (CENTRO DE CUSTO e ignorada). Um registro por **vinculo** (RA + curso): um mesmo RA ' +
      'em dois cursos gera duas linhas.\n\n' +
      'Idempotente — upsert por `matricula + curso`. CAMPUS casa com `Polo.nome` por string exata; ' +
      'valores sem correspondencia sao reportados em `polosNaoEncontrados` em vez de derrubar a carga.\n\n' +
      '**Nada e apagado**: quem nao esta no arquivo nao e tocado. Para incluir uma pessoa, ' +
      'basta um CSV com a linha dela.\n\n' +
      '⚠️ O formato vem do dropdown e sobrescreve a de TODAS as linhas do arquivo, e o polo ' +
      'segue a coluna CAMPUS. Quando uma dessas duas muda em quem **ja tem prova marcada**, a ' +
      'reserva continua na sala antiga (outra duracao, ou outro campus) e nada mais reclama — ' +
      'por isso essas linhas saem em `alteracoesComAgendamento`. O upload nao e bloqueado: a ' +
      'planilha pode estar corrigindo um cadastro errado, e quem decide entre remanejar e ' +
      'cancelar e a administracao.\n\n' +
      '⚠️ A mesma lista traz quem **PERDEU a elegibilidade** com prova marcada — o STATUS CURSO ' +
      'saiu de "Ativo" (ex.: "Transf. Interna"). O vinculo **nao e apagado** e a prova **nao e ' +
      'cancelada**: `ativo` vira `false`, o aluno deixa de agendar e de trocar de horario, o ' +
      'compulsorio para de enxerga-lo, e a cadeira dele continua reservada — ele segue na lista ' +
      'de presenca do dia. Sem este aviso a mudanca era completamente silenciosa, porque ' +
      '"Transf. Interna" e um status CONHECIDO e nao entra em `statusDesconhecidos`.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['arquivo', 'modalidade'],
      properties: {
        arquivo: CAMPO_ARQUIVO,
        modalidade: {
          type: 'string',
          enum: [...MODALIDADES_UPLOAD],
          description:
            'Aba de origem da planilha: EaD -> EAD, Semi -> SEMI, Modular -> MODULAR.',
        },
      },
    },
  })
  @ApiCreatedResponse({ type: ResultadoImportacaoAlunosDto })
  @ApiBadRequestResponse({
    description:
      'Arquivo ausente, sem extensao .csv, acima de 15 MB, colunas obrigatorias faltando, ou formato invalido',
  })
  importarAlunos(
    @UploadedFile(validarCsv) arquivo: Express.Multer.File,
    @Body() dto: ImportarAlunosDto,
    @AdminLogado() admin: AdminJwtPayload,
  ) {
    exigirExtensaoCsv(arquivo);

    return this.alunosService.importar(arquivo, dto.modalidade, admin.email);
  }

  /**
   * Upload do CSV de turmas reais (as que terao prova).
   * O mapeamento de colunas esta isolado em
   * src/importacao/service/turma-csv.columns.ts.
   */
  @Post('turmas')
  @Throttle(LIMITE_UPLOAD)
  @UseInterceptors(
    FileInterceptor('arquivo', { limits: { fileSize: LIMITE_ARQUIVO } }),
  )
  @ApiOperation({
    summary: 'Importa o CSV de turmas reais',
    description:
      'As turmas que efetivamente terao prova — o filtro final do que o aluno pode agendar. ' +
      'Idempotente pelo par `[codigoTurma, nomeDisciplina]`: reenviar o mesmo arquivo atualiza, ' +
      'nunca duplica.\n\n' +
      'Formato real (`;` do Excel pt-BR, UTF-8 ou latin1 — detectados):\n\n' +
      '```\nCurso;Código da Turma;Disciplina / Código EAD\n' +
      'NUTRIÇÃO;GSPS0N10259;PRÁTICA PROFISSIONAL E ÉTICA EM NUTRIÇÃO (1-GSPS06EAD003)\n```\n\n' +
      '`Código da Turma` e a unica coluna exigida no cabecalho.\n\n' +
      'A 3ª coluna traz **nome e codigo da DISCIPLINA na mesma celula**, separados na leitura. ' +
      'Esse codigo nao e decoracao: ele e o outro token do `Code` composto do Brightspace ' +
      '(`GSPS02_GSPS02EAD003_GSPS0I10227_2026/1`) e e o que separa disciplinas diferentes ' +
      'rodando sob o MESMO codigo de turma. O prefixo do sistema de origem (`1-`) sai na ' +
      'leitura, porque nao aparece no Brightspace.\n\n' +
      'Uma coluna `Curso`, se existir no arquivo, e **ignorada**: uma turma tem alunos de ' +
      'varios cursos (compartilhada, eletiva, equivalencia), entao rotula-la com um curso ' +
      'so seria falso.\n\n' +
      'Enquanto a tabela estiver vazia com `TURMAS_FILTER_ENABLED=true` (default), **nada e ' +
      'agendavel** — de proposito.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['arquivo'],
      properties: { arquivo: CAMPO_ARQUIVO },
    },
  })
  @ApiCreatedResponse({ type: ResultadoImportacaoTurmasDto })
  @ApiBadRequestResponse({
    description:
      'Arquivo ausente, sem extensao .csv, acima de 15 MB, ou sem a coluna "Código da Turma"',
  })
  importarTurmas(
    @UploadedFile(validarCsv) arquivo: Express.Multer.File,
    @AdminLogado() admin: AdminJwtPayload,
  ) {
    exigirExtensaoCsv(arquivo);

    return this.turmasService.importar(arquivo, admin.email);
  }

  /** Historico de importacoes (auditoria: tipo, arquivo, linhas, quem, quando). */
  @Get()
  @ApiOperation({
    summary: 'Historico de importacoes',
    description:
      'Auditoria de todos os uploads, do mais recente para o mais antigo.',
  })
  @ApiQuery({
    name: 'limite',
    required: false,
    description: 'Quantos registros trazer. Default 20, teto 100.',
    example: 20,
  })
  @ApiOkResponse({ type: [ImportacaoCsvDto] })
  historico(@Query('limite') limite?: string) {
    return this.prisma.importacaoCsv.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(Number(limite) || 20, 100),
    });
  }
}

function exigirExtensaoCsv(arquivo: Express.Multer.File): void {
  if (!/\.csv$/i.test(arquivo.originalname)) {
    throw new BadRequestException('O arquivo enviado precisa ser um .csv');
  }
}
