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
import type { AdminJwtPayload } from '../../auth/jwt/jwt.types';
import { AdminLogado, SomenteAdmin } from '../../auth/roles.decorator';
import { PrismaService } from '../../database/prisma.service';
import { ImportarAlunosDto } from '../dto/importar-alunos.dto';
import { ImportacaoAlunosService } from '../service/importacao-alunos.service';
import { ImportacaoTurmasService } from '../service/importacao-turmas.service';

const LIMITE_ARQUIVO = 15 * 1024 * 1024; // 15 MB — o maior CSV real tem ~400 KB

/** Aceita apenas CSV, checando extensao (o mimetype varia entre navegadores). */
const validarCsv = new ParseFilePipeBuilder()
  .addMaxSizeValidator({ maxSize: LIMITE_ARQUIVO })
  .build({ fileIsRequired: true });

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
  @UseInterceptors(
    FileInterceptor('arquivo', { limits: { fileSize: LIMITE_ARQUIVO } }),
  )
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
  @UseInterceptors(
    FileInterceptor('arquivo', { limits: { fileSize: LIMITE_ARQUIVO } }),
  )
  importarTurmas(
    @UploadedFile(validarCsv) arquivo: Express.Multer.File,
    @AdminLogado() admin: AdminJwtPayload,
  ) {
    exigirExtensaoCsv(arquivo);

    return this.turmasService.importar(arquivo, admin.email);
  }

  /** Historico de importacoes (auditoria: tipo, arquivo, linhas, quem, quando). */
  @Get()
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
