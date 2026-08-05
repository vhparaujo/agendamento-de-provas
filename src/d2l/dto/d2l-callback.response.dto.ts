import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { ResultadoAutorizacao } from '../service/d2l-oauth.service';

/**
 * `implements` de proposito: se a interface do service mudar, o build quebra
 * aqui — a doc nao fica mentindo em silencio.
 */
export class D2lCallbackResponseDto implements ResultadoAutorizacao {
  @ApiProperty({
    example: 3600,
    description:
      'Validade do access token em segundos, como o Brightspace informou.',
  })
  expiraEmSegundos!: number;

  @ApiProperty({
    example: 'enrollment:orgunit:read orgunits:orgunit:read',
    description:
      'Escopos que o token realmente recebeu. Compare com o que voce pediu: o ' +
      'Brightspace concede o que o app tem registrado, e pode conceder menos.',
  })
  escopos!: string;

  @ApiProperty({
    example: true,
    description:
      'true = o refresh token foi gravado em `integracao_d2l` e sobrevive a restart. ' +
      'false = o Brightspace nao devolveu refresh token (esperado no fluxo de ' +
      'client credentials); o acesso vale so enquanto o access token durar.',
  })
  refreshTokenGravado!: boolean;

  @ApiPropertyOptional({
    example: 'eyJhbGciOiJSUzI1NiIsInR5cCI6...',
    description:
      'Access token de curta duracao, para conferir os endpoints da Valence por ' +
      'curl/Postman. Devolvido APENAS fora de producao — em producao o campo vem ' +
      'ausente, porque quem usa o token e o servidor, nao quem abriu a pagina.',
  })
  accessToken?: string;
}
