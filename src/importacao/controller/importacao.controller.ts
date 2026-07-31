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
   * Upload do CSV de alunos. A modalidade NAO e coluna do arquivo: vem do
   * dropdown do upload, correspondendo a aba de origem (EaD / Semi / Hibrido).
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
      'valores sem correspondencia sao reportados em `polosNaoEncontrados` em vez de derrubar a carga.',
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
            'Aba de origem da planilha: EaD -> EAD, Semi -> SEMI, Hibrido -> MODULAR.',
        },
      },
    },
  })
  @ApiCreatedResponse({ type: ResultadoImportacaoAlunosDto })
  @ApiBadRequestResponse({
    description:
      'Arquivo ausente, sem extensao .csv, acima de 15 MB, colunas obrigatorias faltando, ou modalidade invalida',
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
   * O arquivo real ainda nao existe: o mapeamento de colunas esta isolado em
   * src/importacao/service/turma-csv.columns.ts e e o unico ponto a ajustar.
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
      'Idempotente por `orgUnitId`, o unico campo obrigatorio.\n\n' +
      '⚠️ **O arquivo real ainda nao chegou.** Os cabecalhos (`orgUnitId`, `nomeDisciplina`, ' +
      '`codigoTurma`) sao provisorios; quando o arquivo aparecer, o unico ponto a mudar e ' +
      '`src/importacao/service/turma-csv.columns.ts`. Nenhuma regra de negocio muda.\n\n' +
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
      'Arquivo ausente, sem extensao .csv, acima de 15 MB, ou sem a coluna orgUnitId',
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
