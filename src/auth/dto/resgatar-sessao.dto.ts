import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Corpo do resgate da sessao do aluno.
 *
 * Diferente do launch — que e documentado por `@ApiBody({ schema })` para nao
 * rejeitar campo extra vindo do Brightspace —, aqui quem chama e o NOSSO
 * portal. Nao ha integracao externa para quebrar, entao vale a validacao
 * estrita do ValidationPipe.
 */
export class ResgatarSessaoDto {
  @ApiProperty({
    example: 'd97f1e2c-6b0a-4d5e-9a31-7c8e2b4f0a15',
    maxLength: 64,
    description:
      'O `code` que veio na URL do redirect apos o launch. De uso unico e valido por 2 minutos.',
  })
  @IsString()
  @IsNotEmpty({ message: 'code e obrigatorio' })
  @MaxLength(64)
  code!: string;
}
