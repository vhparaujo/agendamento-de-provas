import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPublicKey } from 'node:crypto';
import { exportJWK, importPKCS8, JWK, KeyObject } from 'jose';
import { carregarLtiConfig } from './lti.config';

/**
 * Par de chaves da FERRAMENTA (nosso lado). A privada assina o client_assertion
 * usado para falar com o Brightspace; a publica e publicada em /lti/jwks para
 * que o Brightspace valide essa assinatura.
 *
 * Se LTI_TOOL_PRIVATE_KEY nao estiver configurada, a aplicacao NAO quebra: o
 * JWKS responde vazio e loga um aviso. As credenciais reais so chegam quando a
 * ferramenta for registrada no Brightspace.
 */
@Injectable()
export class LtiKeysService {
  private readonly logger = new Logger(LtiKeysService.name);
  private jwksCache?: { keys: JWK[] };

  constructor(private readonly config: ConfigService) {}

  async chavePrivada(): Promise<KeyObject | CryptoKey> {
    const pem = this.pemPrivado();

    if (!pem) {
      throw new ServiceUnavailableException(
        'LTI_TOOL_PRIVATE_KEY nao configurada',
      );
    }

    return importPKCS8(pem, 'RS256');
  }

  async jwks(): Promise<{ keys: JWK[] }> {
    if (this.jwksCache) return this.jwksCache;

    const pem = this.pemPrivado();

    if (!pem) {
      this.logger.warn(
        'LTI_TOOL_PRIVATE_KEY nao configurada — /lti/jwks respondera vazio. ' +
          'Gere um par com: npm run lti:keygen',
      );
      return { keys: [] };
    }

    const { toolKeyId } = carregarLtiConfig(this.config);
    const publica = createPublicKey(pem);
    const jwk = await exportJWK(publica);

    this.jwksCache = {
      keys: [{ ...jwk, kid: toolKeyId, alg: 'RS256', use: 'sig' }],
    };

    return this.jwksCache;
  }

  /**
   * A chave PEM tem quebras de linha, que atrapalham num .env. Aceitamos as duas
   * formas: PEM cru (com \n literais) ou o PEM inteiro em base64.
   */
  private pemPrivado(): string | undefined {
    const bruto = this.config.get<string>('LTI_TOOL_PRIVATE_KEY')?.trim();

    if (!bruto) return undefined;

    if (bruto.includes('BEGIN')) return bruto.replace(/\\n/g, '\n');

    return Buffer.from(bruto, 'base64').toString('utf8');
  }
}
