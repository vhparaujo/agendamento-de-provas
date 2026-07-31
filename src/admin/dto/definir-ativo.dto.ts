import { IsBoolean } from 'class-validator';

export class DefinirAtivoDto {
  @IsBoolean()
  ativo!: boolean;
}
