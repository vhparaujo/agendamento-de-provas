import { generateKeyPairSync } from 'node:crypto';

/**
 * Gera o par de chaves RSA da ferramenta LTI.
 *   npm run lti:keygen
 *
 * Cole a linha LTI_TOOL_PRIVATE_KEY no .env (o PEM vai em base64 para caber em
 * uma linha). A chave publica correspondente e servida automaticamente em
 * GET /api/lti/jwks — e essa URL que se informa no Brightspace.
 */
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

console.log('--- adicione ao .env -------------------------------------------');
console.log(
  `LTI_TOOL_PRIVATE_KEY=${Buffer.from(privateKey).toString('base64')}`,
);
console.log(
  '\n--- chave publica (referencia; servida em /api/lti/jwks) ------',
);
console.log(publicKey);
