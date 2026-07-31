import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class DefinirAtivoDto {
  @ApiProperty({
    example: false,
    description:
      'Um admin nao pode desativar a si mesmo, nem o ultimo admin ativo do sistema.',
  })
  @IsBoolean()
  ativo!: boolean;
}
