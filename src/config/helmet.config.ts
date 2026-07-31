import type { INestApplication } from '@nestjs/common';
import helmet from 'helmet';
import type { NextFunction, Request, Response } from 'express';

/**
 * ============================================================================
 * CABECALHOS DE SEGURANCA (OWASP A02 — Security Misconfiguration)
 * ============================================================================
 * Duas politicas, escolhidas por rota:
 *
 * - **API** (tudo): `default-src 'none'`. Uma resposta JSON nao carrega script,
 *   estilo, imagem nem frame — entao a CSP mais segura possivel e proibir tudo.
 *   Se um dia uma resposta nossa for interpretada como HTML pelo navegador, a
 *   CSP impede que qualquer coisa dentro dela execute.
 *
 * - **Swagger UI** (`{prefixo}/docs`): a unica pagina HTML do projeto. O
 *   swagger-ui injeta script e estilo inline, entao precisa de 'unsafe-inline'.
 *   Isolar essa excecao na rota da doc evita afrouxar a CSP da API inteira —
 *   que e o que acontece quando se aplica uma politica unica para os dois casos.
 *
 * Sobre `X-XSS-Protection`: o helmet 8 o envia como `0` (desligado), e isso esta
 * CORRETO. O auditor de XSS foi removido do Chrome e chegou a ser vetor de
 * vulnerabilidade; recomendacao de ligar com `1; mode=block` e conselho antigo.
 */

const CSP_API = {
  useDefaults: false,
  directives: {
    defaultSrc: ["'none'"],
    frameAncestors: ["'none'"],
    baseUri: ["'none'"],
    formAction: ["'none'"],
  },
};

const CSP_SWAGGER = {
  useDefaults: false,
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "'unsafe-inline'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:'],
    connectSrc: ["'self'"],
    fontSrc: ["'self'", 'data:'],
    frameAncestors: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
  },
};

/**
 * `frameAncestors: 'none'` vale para os dois: nada neste backend precisa ser
 * embutido em iframe. Atencao se algum dia o PORTAL DO ALUNO for servido dentro
 * do Brightspace via iframe — isso e responsabilidade do front, que tera a
 * propria politica; esta aqui cobre apenas a API e a doc.
 */
export function configurarHelmet(app: INestApplication, prefixo: string): void {
  const daApi = helmet({ contentSecurityPolicy: CSP_API });
  const daDoc = helmet({ contentSecurityPolicy: CSP_SWAGGER });
  const caminhoDoc = `/${prefixo}/docs`;

  app.use((req: Request, res: Response, next: NextFunction) => {
    const middleware = req.path.startsWith(caminhoDoc) ? daDoc : daApi;

    return middleware(req, res, next);
  });
}
