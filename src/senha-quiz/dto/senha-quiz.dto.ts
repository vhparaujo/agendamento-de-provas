import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  Matches,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  ResultadoGrupoQuiz,
  ResultadoSenhaQuiz,
  StatusExecucao,
  TipoExecucaoQuiz,
  TipoMatchQuiz,
  Turno,
} from '../../generated/prisma/client';

export class IniciarSenhaQuizDto {
  @ApiPropertyOptional({
    enum: TipoExecucaoQuiz,
    default: TipoExecucaoQuiz.SENHA,
    description:
      '`SENHA` aplica uma celula da grade em TODAS as turmas do CSV (exige ' +
      '`turno`). `DATA` aplica UMA janela de horario nas turmas de UMA ' +
      'modalidade (exige `janelaId`), e grava junto a senha da celula daquele ' +
      'turno — o PUT do questionario substitui o objeto inteiro e nao pode ' +
      'preservar a senha lida. `PREPARO` deixa o questionario pronto para o ' +
      'special access (sem data, restrito, sem condicao de grupo), com a senha ' +
      'da celula de `data` + `turno`.',
  })
  @IsOptional()
  @IsEnum(TipoExecucaoQuiz)
  tipo?: TipoExecucaoQuiz;

  @ApiProperty({
    example: '2026-09-16',
    description:
      'Em `SENHA`, o dia da celula da grade. Em `DATA`, o dia que o ' +
      'QUESTIONARIO passa a ter — ja com o "dia seguinte" resolvido, se a ' +
      'janela for uma das noturnas.',
  })
  @IsDateString()
  data!: string;

  @ApiPropertyOptional({
    enum: Turno,
    example: Turno.MANHA,
    description:
      'Obrigatorio em `SENHA`. Ignorado em `DATA`, onde o turno vem da janela.',
  })
  @ValidateIf((dto: IniciarSenhaQuizDto) => dto.tipo !== TipoExecucaoQuiz.DATA)
  @IsEnum(Turno)
  turno?: Turno;

  @ApiPropertyOptional({
    example: 10,
    description:
      'Obrigatorio em `DATA`: a janela a aplicar. Ela carrega a modalidade ' +
      '(que recorta as turmas), as horas de abertura e fechamento, e o turno ' +
      'de onde sai a senha.',
  })
  @ValidateIf((dto: IniciarSenhaQuizDto) => dto.tipo === TipoExecucaoQuiz.DATA)
  @IsInt()
  @Min(1)
  janelaId?: number;

  @ApiPropertyOptional({
    type: [String],
    example: ['156979', '156980'],
    description:
      'So em `PREPARO`: prepara so estas turmas. **Vazio ou ausente = todas as ' +
      'turmas do CSV do periodo vigente.** Fatiar evita mandar a instituicao ' +
      'inteira ao Brightspace de uma vez, e permite conferir uma turma antes de ' +
      'trancar a prova de todas.\n\n' +
      'Se alguma nao estiver entre as turmas resolvidas, a execucao inteira e ' +
      'recusada.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @Matches(/^\d+$/, { each: true, message: 'orgUnitIds deve ter so numeros' })
  orgUnitIds?: string[];

  /**
   * `true` e o PADRAO, como no compulsorio: a simulacao percorre tudo e nao
   * emite nenhum PUT. E a unica conferencia possivel antes de mexer na prova de
   * toda a instituicao.
   */
  @ApiPropertyOptional({
    example: true,
    default: true,
    description:
      'true = simula (nenhum PUT sai daqui). false = aplica de verdade. O padrao e simular.',
  })
  @IsOptional()
  @IsBoolean()
  simulacao?: boolean;

  @ApiPropertyOptional({
    example: false,
    default: false,
    description:
      'Aplica de novo uma senha ja aplicada. O PUT e idempotente, entao repetir ' +
      'nao corrompe nada — a trava existe contra repeticao sem querer.',
  })
  @IsOptional()
  @IsBoolean()
  forcar?: boolean;
}

export class ExecucaoSenhaIniciadaDto {
  @ApiProperty({ example: 12, description: 'Id da execucao, para acompanhar.' })
  id!: number;

  @ApiProperty({ enum: TipoExecucaoQuiz, example: TipoExecucaoQuiz.SENHA })
  tipo!: TipoExecucaoQuiz;

  @ApiProperty({ example: true })
  simulacao!: boolean;

  @ApiProperty({ example: 320, description: 'Linhas do CSV de turmas.' })
  turmasNoCsv!: number;

  @ApiProperty({
    example: 312,
    description: 'Turmas que serao tocadas (CSV ∩ periodo letivo vigente).',
  })
  totalTurmas!: number;

  @ApiProperty({
    example: 8,
    description:
      'Turmas do CSV sem orgUnitId resolvido. **Cada uma ficaria sem senha** — ' +
      'saem detalhadas no relatorio.',
  })
  naoResolvidas!: number;

  @ApiProperty({
    example: 4,
    description:
      'So em `DATA`: turmas resolvidas que ficaram de fora porque nenhum ' +
      'agendamento confirmado aponta para elas — nao ha de onde derivar a ' +
      'modalidade, e portanto nao ha janela a aplicar.',
  })
  semModalidade!: number;

  @ApiProperty({
    example: 1,
    description:
      'So em `DATA`: turmas com alunos de DUAS modalidades. O questionario tem ' +
      'uma janela so, entao nenhuma foi escolhida — a turma fica com a data ' +
      'antiga e precisa de decisao humana.',
  })
  modalidadeAmbigua!: number;
}

export class AndamentoDaSenhaQuizDto {
  @ApiProperty({ example: 12 })
  id!: number;

  @ApiProperty({ enum: StatusExecucao, example: StatusExecucao.EM_ANDAMENTO })
  status!: StatusExecucao;

  @ApiProperty({ example: false })
  simulacao!: boolean;

  @ApiProperty({ example: 'MANUAL', description: 'MANUAL ou CRON.' })
  origem!: string;

  @ApiProperty({ example: 'admin@ucb.br' })
  iniciadoPor!: string;

  @ApiProperty({ enum: TipoExecucaoQuiz, example: TipoExecucaoQuiz.SENHA })
  tipo!: TipoExecucaoQuiz;

  @ApiProperty({ example: '2026-09-16' })
  data!: string;

  @ApiProperty({
    enum: Turno,
    example: Turno.MANHA,
    nullable: true,
    description:
      'Nulo nas execucoes `DATA`: turno e a chave da GRADE de senhas, e uma ' +
      'execucao de datas se identifica pela janela, nao pelo turno.',
  })
  turno!: Turno | null;

  @ApiProperty({
    example: '15:00',
    nullable: true,
    description:
      'So em `DATA`: a abertura que foi aplicada. Congelada no inicio — a ' +
      'janela pode ser editada na tela durante a execucao, e o registro precisa ' +
      'dizer o que REALMENTE foi gravado.',
  })
  horaInicioAplicada!: string | null;

  @ApiProperty({ example: '18:00', nullable: true })
  horaFimAplicada!: string | null;

  @ApiProperty({
    example: 'EAD',
    nullable: true,
    description:
      'So em `DATA`: a modalidade da janela aplicada. **Sem ela a tela nao tem ' +
      'como dizer de quem e a execucao** — as 12:01 tres modalidades disparam, ' +
      'e duas delas com a mesma janela.',
  })
  modalidadeCodigo!: string | null;

  @ApiProperty({ example: 'EaD', nullable: true })
  modalidadeNome!: string | null;

  @ApiProperty({ example: 'Prova' })
  nomeQuizAlvo!: string;

  @ApiProperty({ enum: TipoMatchQuiz, example: TipoMatchQuiz.CONTEM })
  matchQuizAlvo!: TipoMatchQuiz;

  @ApiProperty({ example: 320 })
  turmasNoCsv!: number;

  @ApiProperty({ example: 312 })
  turmasResolvidas!: number;

  @ApiProperty({ example: 12 })
  orgUnitsAprendidos!: number;

  @ApiProperty({
    example: 4,
    description:
      'So em `DATA`: turmas sem agendamento confirmado, das quais nao ha como ' +
      'derivar a modalidade. Ficam com a data antiga.',
  })
  semModalidade!: number;

  @ApiProperty({
    example: 1,
    description:
      'So em `DATA`: turmas com alunos de duas modalidades. **Tao importante ' +
      'quanto `naoEncontradas`** e pelo mesmo motivo: nao contam como falha e ' +
      'sao turmas inteiras que nao abririam a prova no horario certo.',
  })
  modalidadeAmbigua!: number;

  @ApiProperty({ example: 200 })
  processadas!: number;

  @ApiProperty({ example: 198 })
  definidas!: number;

  @ApiProperty({
    example: 4,
    description:
      '**O contador que mais dói e o que menos aparece**: sao turmas cujos ' +
      'alunos nao conseguiriam abrir a prova, e nao contam como falha.',
  })
  naoEncontradas!: number;

  @ApiProperty({ example: 2 })
  falhas!: number;

  @ApiProperty({
    example: 190,
    description: 'Quantos questionarios devolveram a senha anterior no GET.',
  })
  comSenhaLida!: number;

  @ApiProperty({
    example: false,
    description:
      'Nenhum questionario devolveu a senha anterior. E DIAGNOSTICO, nao alarme: ' +
      'este lote sempre define uma senha nova, entao nao ha risco de apagar nada. ' +
      'Serve para descobrir que a API esconde o campo antes de alguem confiar nele.',
  })
  avisoSenhaInvisivel!: boolean;

  @ApiProperty({
    example: true,
    description:
      'O processo morreu no meio (reinicio do servidor). O que ja foi gravado ' +
      'permanece; rodar de novo refaz o resto.',
  })
  interrompida!: boolean;

  @ApiProperty({
    example: { DEFINIDA: 198, QUIZ_NAO_ENCONTRADO: 4 },
    description: 'Contagem por resultado.',
    additionalProperties: { type: 'number' },
  })
  itens!: Partial<Record<ResultadoSenhaQuiz, number>>;

  @ApiProperty({
    example: 198,
    description:
      'Questionarios cuja condicao de liberacao passou a apontar para o grupo ' +
      'desta janela (inclui os que ja estavam nele e, na simulacao, os que ' +
      'teriam sido trocados).',
  })
  gruposTrocados!: number;

  @ApiProperty({
    example: 0,
    description:
      '**Tem o MESMO peso de `naoEncontradas` e `semModalidade`.** Cada unidade ' +
      'aqui e uma prova que vai abrir no horario certo para o grupo da sessao ' +
      'ANTERIOR — ou seja, o aluno que ja fez a prova consegue abri-la de novo, ' +
      'que e exatamente o que a troca de grupo existe para impedir. Uma execucao ' +
      'com 0 falhas e 30 aqui NAO e verde.\n\n' +
      'Como toda turma ja tem os grupos de prova criados, zero e o estado ' +
      'normal: qualquer valor acima disso e anomalia de cadastro (nome digitado ' +
      'errado na janela, ou grupo que faltou ser criado numa turma).',
  })
  gruposPendentes!: number;

  @ApiProperty({
    example: 'Prova 2',
    nullable: true,
    description:
      'O nome do grupo que esta execucao aplicou — da grade de grupos do dia, ' +
      'ou o nome padrao da janela. Congelado na execucao. **Nulo = nenhum grupo ' +
      'foi aplicado**: a janela nao troca grupo, ou o dia ficou em branco na ' +
      'grade (neste caso `grupos` traz `SEM_GRUPO_NO_DIA`).',
  })
  nomeGrupoAplicado!: string | null;

  @ApiProperty({
    example: { TROCADO: 196, SEM_CONDICAO_DE_GRUPO: 2 },
    description:
      'Contagem por desfecho da troca de grupo. Vazio quando a janela nao troca ' +
      'grupo. **E independente de `itens`**: a mesma linha pode estar em ' +
      'DEFINIDA aqui e em GRUPO_NAO_ENCONTRADO ali — a data entrou, o grupo nao.',
    additionalProperties: { type: 'number' },
  })
  grupos!: Partial<Record<ResultadoGrupoQuiz, number>>;

  @ApiProperty({ example: null, nullable: true })
  erro!: string | null;

  @ApiProperty({ example: '2026-09-16T10:30:00.000Z' })
  iniciadoEm!: Date;

  @ApiProperty({ example: '2026-09-16T10:36:00.000Z', nullable: true })
  concluidoEm!: Date | null;
  @ApiProperty({
    example: '2026-09-20T13:09:00.000Z',
    description:
      'Sinal de vida, batido a cada fatia de turmas. Distingue lote lento de ' +
      'lote morto, e e dele que a tela tira a duracao enquanto a execucao roda.',
  })
  atualizadoEm!: Date;
}

export class UltimaDataPorModalidadeDto {
  @ApiProperty({ example: 1 })
  modalidadeId!: number;

  @ApiProperty({ example: 'EAD' })
  modalidadeCodigo!: string;

  @ApiProperty({ example: 'EaD' })
  modalidadeNome!: string;

  @ApiProperty({
    type: AndamentoDaSenhaQuizDto,
    nullable: true,
    description:
      'A ultima execucao de datas desta modalidade, ou `null` se ela nunca ' +
      'rodou. **Nulo nao e erro**: e o estado normal de uma modalidade que tem ' +
      'calendario cadastrado mas ainda nao teve prova — o Presencial, enquanto ' +
      'nao houver aluno presencial importado.',
  })
  execucao!: AndamentoDaSenhaQuizDto | null;
}
