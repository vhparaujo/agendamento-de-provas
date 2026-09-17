import { ValidationPipe } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  corpoAmigavel,
  mensagemAmigavel,
  rotuloDoCampo,
} from './mensagens-amigaveis';

class Faixa {
  @Matches(/^\d{2}:\d{2}$/)
  horaInicio!: string;
}

class Exemplo {
  @IsString()
  @IsNotEmpty()
  @MaxLength(5)
  nome!: string;

  @IsInt()
  @Min(1)
  poloId!: number;

  @IsInt()
  @Min(10)
  capacidade!: number;

  @IsBoolean()
  ativo!: boolean;

  @IsIn(['FAIXA', 'JANELA'])
  modo!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => Faixa)
  faixas!: Faixa[];

  @IsString()
  @IsNotEmpty({ message: 'Informe o nome do polo.' })
  personalizado!: string;
}

/** As mensagens reais que o ValidationPipe devolve para `corpo`. */
async function mensagensDaValidacao(corpo: object): Promise<string[]> {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
  });

  try {
    await pipe.transform(corpo, { type: 'body', metatype: Exemplo });
  } catch (erro) {
    const resposta = (
      erro as { getResponse(): { message: string[] } }
    ).getResponse();
    return resposta.message;
  }

  throw new Error('a validacao deveria ter falhado');
}

describe('mensagens-amigaveis', () => {
  describe('rotuloDoCampo', () => {
    it.each([
      ['nome', 'nome'],
      ['dataAbertura', 'data de abertura'],
      ['poloId', 'polo'],
      ['salaIds', 'salas'],
      ['faixas.0.horaInicio', 'hora de início'],
      ['tempoExtraNiop', 'tempo extra niop'],
    ])('%s -> %s', (campo, esperado) => {
      expect(rotuloDoCampo(campo)).toBe(esperado);
    });
  });

  it('traduz as mensagens REAIS do class-validator, sem sobrar ingles', async () => {
    const mensagens = await mensagensDaValidacao({
      nome: 'longo demais',
      poloId: 0,
      capacidade: 3,
      ativo: 'talvez',
      modo: 'OUTRO',
      faixas: [{ horaInicio: '8h' }],
      personalizado: '',
      extra: 1,
    });

    const traduzidas = mensagens.map(mensagemAmigavel);

    expect(traduzidas).toEqual(
      expect.arrayContaining([
        'O campo "nome" deve ter no máximo 5 caracteres.',
        'Selecione uma opção válida em "polo".',
        'O campo "capacidade" deve ser no mínimo 10.',
        'O campo "ativo" deve ser sim ou não.',
        'Escolha uma das opções válidas em "modo".',
        'O campo "hora de início" está em um formato inválido.',
        'Informe o nome do polo.',
        expect.stringContaining('informação que não esperava ("extra")'),
      ]),
    );

    for (const texto of traduzidas) {
      expect(texto).not.toMatch(/\b(must|should|property)\b/);
    }
  });

  it.each([
    ['Cannot GET /api/nada', 'Esta função não foi encontrada no sistema'],
    [
      'Validation failed (numeric string is expected)',
      'Um dos valores enviados é inválido',
    ],
    ['ThrottlerException: Too Many Requests', 'Muitas tentativas seguidas'],
    ['Unauthorized', 'Sua sessão expirou'],
    ['Forbidden resource', 'Você não tem permissão'],
    [
      'Validation failed (current file size is 20000000, expected size is less than 15000000)',
      'O arquivo é grande demais',
    ],
  ])('traduz a mensagem padrao do Nest "%s"', (original, trecho) => {
    expect(mensagemAmigavel(original)).toContain(trecho);
  });

  it('nao mexe em mensagem de negocio escrita em portugues', () => {
    const negocio = 'Já existe um polo chamado "Polo Formosa"';

    expect(mensagemAmigavel(negocio)).toBe(negocio);
  });

  it('preserva o resto do corpo e remove frases repetidas', () => {
    expect(
      corpoAmigavel(
        {
          statusCode: 400,
          error: 'Bad Request',
          message: ['a must be a string', 'a must be a string', 'Outra coisa'],
        },
        400,
      ),
    ).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      message: ['O campo "a" deve ser um texto.', 'Outra coisa'],
    });
  });

  it('embrulha corpo em string no formato que o front le', () => {
    expect(corpoAmigavel('Unauthorized', 401)).toEqual({
      statusCode: 401,
      message: 'Sua sessão expirou ou não é válida. Entre novamente.',
    });
  });
});
