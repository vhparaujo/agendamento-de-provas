import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/**
 * O que o admin muda na PROPRIA conta (21/09/2026). Vale para os tres niveis:
 * o perfil e da pessoa, nao do nivel dela.
 *
 * A senha NAO entra aqui — ela continua em `POST /auth/trocar-senha`, que ja
 * existe, ja e a rota liberada com senha provisoria pendente e ja exige a senha
 * atual. Duplicar a troca de senha num segundo lugar criaria duas
 * implementacoes da mesma regra, e uma delas acabaria sem a conferencia.
 */
export class AtualizarPerfilDto {
  /**
   * ⚠️ Vazio ou so espacos APAGA o nome (vira nulo), em vez de gravar `""`.
   *
   * `Admin.nome` e opcional e a tela mostra `nome || email`: um `""` gravado
   * passaria pela checagem de "tem nome?" e deixaria a saudacao em branco, sem
   * nada no cadastro explicando por que. Mesma regra do `nomeGrupo` da janela.
   */
  @ApiPropertyOptional({
    example: 'Maria da Silva',
    maxLength: 150,
    description:
      'Como voce e chamado nas telas. Enviar vazio apaga o nome, e a tela volta ' +
      'a mostrar o e-mail.',
  })
  @IsOptional()
  @Transform(({ value }): unknown =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(150, { message: 'O nome deve ter no máximo 150 caracteres.' })
  nome?: string;

  @ApiPropertyOptional({
    example: 'maria.silva@ucb.br',
    description:
      'O e-mail de LOGIN. Espacos e caixa sao normalizados, como no cadastro.\n\n' +
      'Trocar o e-mail exige `senhaAtual` — ele e metade da credencial de acesso.',
  })
  @IsOptional()
  @Transform(({ value }): unknown =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail({}, { message: 'E-mail inválido.' })
  email?: string;

  /**
   * Obrigatoria SOMENTE quando o e-mail vem no corpo — e a re-autenticacao da
   * troca de credencial (ASVS 5.0, V6). Quem so corrige o proprio nome nao
   * precisa digitar senha para isso.
   *
   * ⚠️ `@ValidateIf` e o que torna isso uma regra do DTO, e nao so do service:
   * sem ela, `senhaAtual` viria opcional no OpenAPI e o front nao saberia que
   * precisa pedi-la.
   */
  @ApiPropertyOptional({
    maxLength: 72,
    description:
      'Sua senha atual. **Obrigatoria quando `email` e enviado**: trocar o e-mail ' +
      'troca a credencial de acesso, e uma sessao roubada nao pode fazer isso ' +
      'sozinha. Ignorada quando so o nome muda.',
  })
  @ValidateIf((dto: AtualizarPerfilDto) => dto.email !== undefined)
  @IsString({ message: 'Informe a senha atual para trocar o e-mail.' })
  // bcrypt so considera os primeiros 72 bytes; limitar evita payload absurdo
  @MaxLength(72, { message: 'A senha deve ter no máximo 72 caracteres.' })
  senhaAtual?: string;
}
