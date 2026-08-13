import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configurarHelmet } from './config/helmet.config';
import { configurarSwagger } from './config/swagger';

/**
 * `trust proxy` do Express, a partir de TRUST_PROXY.
 *
 * Em producao a API fica atras de um reverse proxy (o Nginx que serve o portal
 * e repassa /api). Sem isto, `req.ip` vira o IP do proxy: TODO o trafego passa
 * a parecer vir de um endereco so, e as duas coisas que dependem de IP quebram
 * juntas — a auditoria aponta sempre o mesmo endereco, e o limite de 5/min do
 * login vira um orcamento COMPARTILHADO por todos os usuarios (o primeiro que
 * errar a senha cinco vezes tranca o login da instituicao inteira).
 *
 * Ligar indevidamente e o erro simetrico: sem proxy real na frente, o cliente
 * falsifica o proprio IP mandando X-Forwarded-For e escapa do limite. Por isso
 * o default e DESLIGADO e o valor e o numero de proxies confiaveis, nao um
 * booleano: `1` confia apenas no ultimo salto (o nosso Nginx), que e o que o
 * compose de producao monta. Aceita tambem as formas do Express ('loopback',
 * lista de IPs/CIDRs) para quem tiver um balanceador institucional na frente.
 */
function configurarTrustProxy(app: NestExpressApplication) {
  const valor = process.env.TRUST_PROXY?.trim();

  if (!valor || valor === 'false' || valor === '0') return;

  const saltos = Number(valor);
  app.set('trust proxy', Number.isInteger(saltos) ? saltos : valor);

  new Logger('Bootstrap').log(`trust proxy = ${valor}`);
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  configurarTrustProxy(app);

  const prefixo = process.env.API_PREFIX ?? 'api';
  app.setGlobalPrefix(prefixo);

  // Antes de qualquer rota: cabecalhos valem inclusive para respostas de erro.
  configurarHelmet(app, prefixo);

  // Nenhuma entrada de dados entra sem DTO validado.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Depois do ValidationPipe: o Swagger le os mesmos DTOs que a validacao usa.
  configurarSwagger(app, prefixo);

  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');

  new Logger('Bootstrap').log(`API ouvindo em http://localhost:${port}`);
}

void bootstrap();
