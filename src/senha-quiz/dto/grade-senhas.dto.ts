import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  StatusExecucao,
  TipoMatchQuiz,
  Turno,
} from '../../generated/prisma/client';
import type { SituacaoDaCelula } from '../service/grade-senhas.service';

/**
 * "HH:MM" em 24h, ou VAZIO. O vazio precisa passar pelo validador porque e como
 * a tela desliga um turno — recusa-lo obrigaria o front a mandar `null`, e um
 * `<input type="time">` limpo manda `''`.
 */
const PADRAO_HORA_OU_VAZIO = /^(([01]\d|2[0-3]):([0-5]\d))?$/;

const MSG_HORA = (campo: string) =>
  `${campo} deve estar em HH:MM (24h, com zero a esquerda), ex.: 07:30, ` +
  'ou vazio para nao disparar este turno';

const SITUACOES: SituacaoDaCelula[] = [
  'SALVA',
  'SIMULADA',
  'APLICADA',
  'DESATUALIZADA',
  'EM_ANDAMENTO',
  'FALHOU',
];

export class DefinirSenhaDto {
  @ApiProperty({
    example: '2026-09-16',
    description: 'Dia da prova (AAAA-MM-DD).',
  })
  @IsDateString()
  data!: string;

  @ApiProperty({ enum: Turno, example: Turno.MANHA })
  @IsEnum(Turno)
  turno!: Turno;

  /**
   * Rejeitada quando vem vazia, so com espacos, com espaco nas pontas ou com
   * caractere invisivel — ver `validarSenha`. A do meio e a que mais importa: a
   * API do D2L aceita, e os alunos e que descobririam no dia.
   */
  @ApiProperty({
    example: '897325',
    description:
      'A senha do turno, em texto claro. Nao pode ser vazia, comecar/terminar ' +
      'com espaco nem conter caractere invisivel.',
  })
  @IsString()
  senha!: string;
}

export class ResumoDaExecucaoDto {
  @ApiProperty({ example: 12 })
  id!: number;

  @ApiProperty({ enum: StatusExecucao, example: StatusExecucao.CONCLUIDA })
  status!: StatusExecucao;

  @ApiProperty({
    example: false,
    description: 'true = nada foi gravado no D2L.',
  })
  simulacao!: boolean;

  @ApiProperty({ example: 'MANUAL', description: 'MANUAL ou CRON.' })
  origem!: string;

  @ApiProperty({
    example: 1,
    description:
      'A versao da senha que esta execucao aplicou. Diferente da versao atual ' +
      'da celula significa que a senha foi editada depois — a celula fica DESATUALIZADA.',
  })
  versaoAplicada!: number;

  @ApiProperty({ example: '2026-09-16T10:36:00.000Z', nullable: true })
  concluidoEm!: Date | null;

  @ApiProperty({ example: 312 })
  turmasResolvidas!: number;

  @ApiProperty({ example: 305 })
  definidas!: number;

  @ApiProperty({ example: 4 })
  naoEncontradas!: number;

  @ApiProperty({ example: 3 })
  falhas!: number;
}

export class CelulaDaGradeDto {
  @ApiProperty({ example: 3 })
  id!: number;

  @ApiProperty({ example: '2026-09-16' })
  data!: string;

  @ApiProperty({ enum: Turno, example: Turno.MANHA })
  turno!: Turno;

  @ApiProperty({
    example: true,
    description:
      'Se ha senha cadastrada. **O valor nunca vem aqui** — use ' +
      '`GET /senhas-de-prova/:id/revelar`, que e auditada.',
  })
  temSenha!: boolean;

  @ApiProperty({
    example: 2,
    description: 'Sobe a cada troca do VALOR da senha, nao a cada gravacao.',
  })
  versao!: number;

  @ApiProperty({ example: '2026-09-15T18:02:00.000Z' })
  atualizadoEm!: Date;

  @ApiProperty({ example: 'secretaria@ucb.br', nullable: true })
  atualizadoPor!: string | null;

  @ApiProperty({
    enum: SITUACOES,
    example: 'APLICADA',
    description:
      'Derivado da ultima execucao. `DESATUALIZADA` = aplicada, mas a senha ' +
      'foi editada depois; o Brightspace ainda esta com a anterior.',
  })
  situacao!: SituacaoDaCelula;

  @ApiProperty({ type: ResumoDaExecucaoDto, nullable: true })
  ultimaExecucao!: ResumoDaExecucaoDto | null;
}

export class SenhaReveladaDto {
  @ApiProperty({
    example: '897325',
    description:
      'A senha em texto claro. **Toda chamada desta rota e auditada** ' +
      '(`SENHA_QUIZ_REVELADA`).',
  })
  senha!: string;
}

export class SalvarAlvoDto {
  @ApiProperty({
    example: 'Prova N2 2026/1',
    description: 'Nome do questionario que o lote procura em cada turma.',
  })
  @IsString()
  @IsNotEmpty({ message: 'Informe o nome do questionario que o lote procura.' })
  nomeQuiz!: string;

  @ApiProperty({
    enum: TipoMatchQuiz,
    example: TipoMatchQuiz.CONTEM,
    description:
      'EXATO = nome identico. CONTEM = casa qualquer questionario cujo nome ' +
      'contenha o texto — pode alcancar simulados, entao confira no dry-run.',
  })
  @IsIn([TipoMatchQuiz.EXATO, TipoMatchQuiz.CONTEM])
  matchQuiz!: TipoMatchQuiz;
}

export class AlvoDoQuizDto {
  @ApiProperty({
    example: 'Prova N2 2026/1',
    nullable: true,
    description:
      '**Nulo enquanto ninguem escolheu.** Nao ha valor padrao: um alvo que ja ' +
      'viesse preenchido faria o lote rodar com o nome errado em silencio.',
  })
  nomeQuiz!: string | null;

  @ApiProperty({ enum: TipoMatchQuiz, example: TipoMatchQuiz.CONTEM })
  matchQuiz!: TipoMatchQuiz;

  @ApiProperty({ example: 'secretaria@ucb.br', nullable: true })
  atualizadoPor!: string | null;

  @ApiProperty({ example: '2026-09-01T12:00:00.000Z', nullable: true })
  atualizadoEm!: Date | null;

  @ApiProperty({
    example: true,
    description: 'false = ninguem escolheu ainda, e o lote recusa comecar.',
  })
  configurado!: boolean;
}

export class SalvarHorariosDto {
  @ApiPropertyOptional({
    example: '07:30',
    nullable: true,
    description:
      'Horario (HH:MM, 24h) em que o cron aplica a senha da manha. ' +
      '**Vazio ou nulo = este turno nao dispara** — e assim que sabado a noite, ' +
      'que nao tem prova, fica de fora.',
  })
  @IsOptional()
  @IsString()
  @Matches(PADRAO_HORA_OU_VAZIO, { message: MSG_HORA('horaManha') })
  horaManha?: string | null;

  @ApiPropertyOptional({ example: '12:30', nullable: true })
  @IsOptional()
  @IsString()
  @Matches(PADRAO_HORA_OU_VAZIO, { message: MSG_HORA('horaTarde') })
  horaTarde?: string | null;

  @ApiPropertyOptional({ example: '18:00', nullable: true })
  @IsOptional()
  @IsString()
  @Matches(PADRAO_HORA_OU_VAZIO, { message: MSG_HORA('horaNoite') })
  horaNoite?: string | null;
}

export class HorariosDoCronDto {
  @ApiProperty({ example: '07:30', nullable: true })
  horaManha!: string | null;

  @ApiProperty({ example: '12:30', nullable: true })
  horaTarde!: string | null;

  @ApiProperty({
    example: '18:00',
    nullable: true,
    description: 'Nulo = o cron nao dispara este turno.',
  })
  horaNoite!: string | null;

  @ApiProperty({ example: 'secretaria@ucb.br', nullable: true })
  atualizadoPor!: string | null;

  @ApiProperty({ example: '2026-09-01T12:00:00.000Z', nullable: true })
  atualizadoEm!: Date | null;

  @ApiProperty({
    example: true,
    description:
      'Do `.env` (`SENHA_QUIZ_CRON_HABILITADO`), **so leitura**. `false` ' +
      'significa que esta instancia nao dispara nada, por mais horarios que ' +
      'estejam cadastrados — a tela precisa dizer isso, senao o admin salva ' +
      '07:30 e espera por um cron desligado.',
  })
  cronHabilitado!: boolean;

  @ApiProperty({
    example: 30,
    description:
      'Do `.env`, so leitura. Janela em minutos apos o horario em que um ' +
      'servidor que estava fora ainda aplica o turno.',
  })
  toleranciaMin!: number;
}

export class TurmaDoLoteDto {
  @ApiProperty({ example: 41 })
  turmaId!: number;

  @ApiProperty({ example: '156126' })
  orgUnitId!: string;

  @ApiProperty({ example: 'GSPS0I10227' })
  codigoTurma!: string;

  @ApiProperty({ example: 'HISTORIA E CULTURA DO CORPO' })
  nomeDisciplina!: string;

  @ApiProperty({
    example: 'EAD',
    nullable: true,
    description:
      'A modalidade DERIVADA dos agendamentos confirmados da rodada vigente — ' +
      'e ela que decide qual janela de horario o lote de datas aplica nesta ' +
      'turma. Nula quando nao foi possivel derivar; o motivo vem em ' +
      '`motivoSemModalidade`, e a turma fica de fora do lote de datas.',
  })
  modalidadeCodigo!: string | null;

  @ApiProperty({ example: 'EaD', nullable: true })
  modalidadeNome!: string | null;

  @ApiProperty({
    example:
      'Alunos de 2 modalidades tem prova nesta turma: EAD (9), SEMI (7). ' +
      'O questionario tem uma janela so, entao nenhuma foi escolhida.',
    nullable: true,
    description:
      'Por que a modalidade nao pode ser derivada. **Revise antes do primeiro ' +
      'dia**: cada linha destas e uma turma que ficaria com a data antiga.',
  })
  motivoSemModalidade!: string | null;
}

export class TurmaForaDoLoteDto {
  @ApiProperty({ example: 88 })
  turmaId!: number;

  @ApiProperty({ example: 'ANTIGA0001' })
  codigoTurma!: string;

  @ApiProperty({ example: 'DISCIPLINA DE 2025' })
  nomeDisciplina!: string;

  @ApiProperty({
    example: false,
    description: 'true = mais de uma oferta casou e nenhuma foi escolhida.',
  })
  ambigua!: boolean;

  @ApiProperty({
    example:
      'Nenhuma oferta do periodo letivo vigente casou com esta linha do CSV.',
  })
  motivo!: string;
}

export class TurmasDoLoteDto {
  @ApiProperty({
    example: 320,
    description: 'Linhas do CSV de turmas, antes do recorte por semestre.',
  })
  totalNoCsv!: number;

  @ApiProperty({
    type: [TurmaDoLoteDto],
    description:
      'As que serao tocadas: estao no CSV E no periodo letivo vigente.',
  })
  resolvidas!: TurmaDoLoteDto[];

  @ApiProperty({
    type: [TurmaForaDoLoteDto],
    description:
      '**Revise esta lista antes do primeiro dia de prova**: cada linha e uma ' +
      'turma que ficaria sem senha.',
  })
  naoResolvidas!: TurmaForaDoLoteDto[];

  @ApiProperty({
    example: 12,
    description:
      'Quantos orgUnitId foram descobertos e gravados agora. Em regime, tende a zero.',
  })
  aprendidos!: number;
}

export class FiltroDaGradeDto {
  @ApiPropertyOptional({ example: '2026-09-10' })
  @IsDateString()
  de!: string;

  @ApiPropertyOptional({ example: '2026-09-16' })
  @IsDateString()
  ate!: string;
}

export class IdDaCelulaDto {
  @ApiProperty({ example: 3 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  id!: number;
}

// ---------------------------------------------------------------------------
// JANELAS DO QUESTIONARIO (as datas)
// ---------------------------------------------------------------------------

/**
 * "HH:MM" em 24h, OBRIGATORIO.
 *
 * Diferente de `PADRAO_HORA_OU_VAZIO`: nos turnos o vazio significa "desligado",
 * mas uma janela sem hora nao existe — para desligar uma sessao ha `ativo`, que
 * preserva o horario cadastrado para o semestre seguinte.
 */
const PADRAO_HORA = /^([01]\d|2[0-3]):([0-5]\d)$/;

const MSG_HORA_OBRIGATORIA = (campo: string) =>
  `${campo} deve estar em HH:MM (24h, com zero a esquerda), ex.: 15:00`;

export class JanelaDeProvaDto {
  @ApiProperty({
    example: 2,
    description:
      'Sequencia da sessao dentro da modalidade. NAO e a ordem do relogio: ' +
      'a primeira e a que dispara a noite armando a prova do dia seguinte.',
  })
  @IsInt()
  @Min(1)
  ordem!: number;

  @ApiProperty({
    example: '12:01',
    description:
      'A que horas o cron aplica esta janela (fuso de Brasilia). Duas janelas ' +
      'ativas da mesma modalidade nao podem disparar no mesmo minuto.',
  })
  @Matches(PADRAO_HORA, { message: MSG_HORA_OBRIGATORIA('horaDisparo') })
  horaDisparo!: string;

  @ApiProperty({
    example: '15:00',
    description: 'Vira o StartDate do questionario, convertido para UTC.',
  })
  @Matches(PADRAO_HORA, { message: MSG_HORA_OBRIGATORIA('horaInicio') })
  horaInicio!: string;

  @ApiProperty({
    example: '18:00',
    description:
      'Vira o EndDate. Precisa ser depois de horaInicio — uma prova que fecha ' +
      'antes de abrir nao e aplicavel.',
  })
  @Matches(PADRAO_HORA, { message: MSG_HORA_OBRIGATORIA('horaFim') })
  horaFim!: string;

  @ApiProperty({
    enum: Turno,
    example: Turno.TARDE,
    description:
      'De qual celula da grade sai a senha desta janela. NAO e enfeite: o PUT ' +
      'do questionario substitui o objeto inteiro e precisa reenviar a senha, ' +
      'e a leitura da API pode devolve-la nula num quiz que tem senha — sem ' +
      'este turno, aplicar a janela apagaria a senha da prova.',
  })
  @IsEnum(Turno)
  turno!: Turno;

  @ApiPropertyOptional({
    example: 'Prova 2',
    nullable: true,
    description:
      'O NOME do grupo, no Brightspace, que passa a liberar a prova quando ' +
      'esta janela dispara. **Vazio ou ausente = a troca de grupo nao acontece ' +
      'nesta janela**, e o disparo se comporta como antes (so data e senha).\n\n' +
      'E o NOME, nunca o GroupId: cada turma tem os seus proprios grupos, com ' +
      'ids proprios, mesmo com nomes identicos — "Prova 2" existe em todas as ' +
      'turmas com um id diferente em cada. O id e resolvido turma a turma no ' +
      'momento do disparo.\n\n' +
      'Nao e um grupo unico com os alunos trocados a cada sessao: cada turma ' +
      'tem UM GRUPO POR SESSAO, na quantidade que a modalidade define (3 no ' +
      'EaD, 6 em Semi/Modular, 5 no Presencial), e o disparo troca o grupo ' +
      'APONTADO pela condicao. O nome e fixo por janela e vale para todas as ' +
      'turmas e para todos os dias de prova.\n\n' +
      '⚠️ Alterar este campo SOBE a versao da janela, liberando-a para disparar ' +
      'de novo hoje — e o que faz a correcao de um nome errado valer no mesmo ' +
      'dia, em vez de so no seguinte.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  nomeGrupo?: string | null;

  @ApiPropertyOptional({
    example: 'Separacao de provas por grupos',
    nullable: true,
    description:
      'A categoria de grupo onde procurar, para desempatar homonimos. ' +
      'Opcional; quando informada tambem barateia a resolucao (uma categoria ' +
      'em vez de todas). Sem ela, o mesmo nome em duas categorias e recusado ' +
      'como GRUPO_AMBIGUO — escolher no chute liberaria a prova para o turno ' +
      'errado sem ninguem perceber. Ignorada quando `nomeGrupo` esta vazio.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  categoriaGrupo?: string | null;

  @ApiPropertyOptional({
    example: true,
    default: true,
    description:
      'Sessao desligada nao dispara, mas guarda o horario para o semestre em ' +
      'que ela voltar.',
  })
  @IsOptional()
  @IsBoolean()
  ativo?: boolean;
}

export class SalvarJanelasDto {
  @ApiProperty({
    example: 1,
    description:
      'A modalidade cujo calendario esta sendo salvo. O PUT substitui as ' +
      'janelas DESTA modalidade e nao toca nas outras.',
  })
  @IsInt()
  @Min(1)
  modalidadeId!: number;

  @ApiProperty({
    type: [JanelaDeProvaDto],
    description:
      'O calendario completo da modalidade. Sessao que nao vier aqui e ' +
      'REMOVIDA — e assim que a tela apaga uma janela.',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => JanelaDeProvaDto)
  janelas!: JanelaDeProvaDto[];
}

export class JanelaDeProvaResponseDto extends JanelaDeProvaDto {
  @ApiProperty({ example: 10 })
  id!: number;

  @ApiProperty({
    example: false,
    description:
      'O disparo arma a prova de AMANHA — a janela da noite, que abre o ciclo ' +
      'do dia seguinte.\n\n' +
      '**DERIVADO e so leitura**: vale `horaDisparo > horaInicio`. Nao e ' +
      'configuracao porque nao ha resposta certa que o admin possa dar — se o ' +
      'disparo acontece depois da hora de abertura, ele nao pode ser para hoje ' +
      '(nao da para abrir uma prova as 08:30 quando ja sao 22:01). Enviar este ' +
      'campo num PUT e recusado com 400.',
  })
  diaSeguinte!: boolean;

  @ApiProperty({ example: 1 })
  modalidadeId!: number;

  @ApiProperty({ example: 'EAD' })
  modalidadeCodigo!: string;

  @ApiProperty({ example: 'EaD' })
  modalidadeNome!: string;
}

export class JanelasDeProvaDto {
  @ApiProperty({
    type: [JanelaDeProvaResponseDto],
    description:
      'Todas as janelas, inclusive as inativas — a tela precisa mostrar o ' +
      'horario guardado de uma sessao desligada.',
  })
  janelas!: JanelaDeProvaResponseDto[];

  @ApiProperty({ example: 'secretaria@ucb.br', nullable: true })
  atualizadoPor!: string | null;

  @ApiProperty({ example: '2026-09-01T12:00:00.000Z', nullable: true })
  atualizadoEm!: Date | null;

  @ApiProperty({
    example: true,
    description:
      'Do `.env` (`SENHA_QUIZ_CRON_HABILITADO`), **so leitura**. E a MESMA ' +
      'chave do cron de senhas: uma instancia com ela em `false` nao dispara ' +
      'nem senha nem data.',
  })
  cronHabilitado!: boolean;

  @ApiProperty({
    example: 30,
    description:
      'Do `.env`, so leitura. Janela em minutos apos o disparo em que um ' +
      'servidor que estava fora ainda aplica a sessao.',
  })
  toleranciaMin!: number;
}
