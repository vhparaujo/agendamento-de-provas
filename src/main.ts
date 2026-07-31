import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configurarHelmet } from './config/helmet.config';
import { configurarSwagger } from './config/swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

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
