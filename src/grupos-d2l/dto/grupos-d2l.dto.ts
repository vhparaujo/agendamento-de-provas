import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  ResultadoGruposD2L,
  StatusExecucao,
  TipoExecucaoGruposD2L,
} from '../../generated/prisma/client';
import { BLOCOS_DE_GRUPOS, type BlocoDeGrupos } from '../service/bloco';
import type {
  AndamentoDosGruposD2L,
  ExecucaoGruposIniciada,
} from '../service/grupos-d2l.service';
import type {
  BlocoDoPainel,
  HorarioDoBloco,
  HorarioQueVale,
  HorarioResolvido,
  JanelaCandidata,
  LinhaDeGrupo,
  PainelDeGrupos,
  PendenciaDeHorario,
} from '../service/nomes-dos-grupos.service';

const PADRAO_DIA = /^\d{4}-\d{2}-\d{2}$/;
const PADRAO_HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

// ------------------------------------------------------------------- entrada

export class LinhaDeGrupoEntradaDto {
  @ApiProperty({
    example: '2026-09-16',
    description: 'O dia da prova (AAAA-MM-DD).',
  })
  @Matches(PADRAO_DIA, { message: 'data deve estar em AAAA-MM-DD' })
  data!: string;

  @ApiProperty({
    example: '09:00',
    description:
      'Abertura de uma janela ATIVA do bloco — e o que liga o grupo a sessao.',
  })
  @Matches(PADRAO_HORA, { message: 'horaInicio deve estar em HH:MM' })
  horaInicio!: string;

  @ApiProperty({ example: '12:00', description: 'Fechamento da mesma janela.' })
  @Matches(PADRAO_HORA, { message: 'horaFim deve estar em HH:MM' })
  horaFim!: string;

  @ApiProperty({
    example: '16/09 - 9h as 12h',
    description:
      'Nome do grupo no Brightspace. E a chave com que o lote e o disparo do quiz ' +
      'o encontram em cada turma. O codigo do grupo e derivado dele.',
  })
  @IsString()
  @MaxLength(200)
  nomeGrupo!: string;
}

export class SalvarNomesDoBlocoDto {
  @ApiProperty({
    enum: BLOCOS_DE_GRUPOS,
    example: 'EAD',
    description:
      '`EAD` (categoria "Provas Presenciais - EAD"), `SEMI_MODULAR` ' +
      '(categoria "Provas Presenciais - Semi e Modular") ou `PRESENCIAL` ' +
      '(categoria "Provas Presenciais - Presencial").',
  })
  @IsIn(BLOCOS_DE_GRUPOS)
  bloco!: BlocoDeGrupos;

  @ApiProperty({
    example: '2026-09-14',
    description: 'Inicio do intervalo substituido.',
  })
  @Matches(PADRAO_DIA, { message: 'de deve estar em AAAA-MM-DD' })
  de!: string;

  @ApiProperty({
    example: '2026-09-19',
    description: 'Fim do intervalo substituido.',
  })
  @Matches(PADRAO_DIA, { message: 'ate deve estar em AAAA-MM-DD' })
  ate!: string;

  @ApiProperty({
    type: [LinhaDeGrupoEntradaDto],
    description:
      'TODAS as linhas do bloco no intervalo. O que nao vier e APAGADO — e assim ' +
      'que se remove uma linha.',
  })
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => LinhaDeGrupoEntradaDto)
  linhas!: LinhaDeGrupoEntradaDto[];
}

export class ResolverHorarioDto {
  @ApiProperty({ example: 2, description: 'O formato da pendencia.' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  modalidadeId!: number;

  @ApiProperty({
    example: '15:00',
    description: 'Abertura das FAIXAS pendentes.',
  })
  @Matches(PADRAO_HORA, { message: 'horaInicio deve estar em HH:MM' })
  horaInicio!: string;

  @ApiProperty({
    example: '18:00',
    description: 'Fechamento das FAIXAS pendentes.',
  })
  @Matches(PADRAO_HORA, { message: 'horaFim deve estar em HH:MM' })
  horaFim!: string;

  @ApiProperty({
    example: 7,
    description: 'A janela que corresponde a estas faixas.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  janelaDeProvaId!: number;

  @ApiProperty({
    enum: ['FAIXA', 'JANELA'],
    example: 'JANELA',
    description:
      '`FAIXA`: a janela passa a ter o horario das faixas. `JANELA`: as faixas ' +
      'do intervalo passam a ter o horario da janela (os agendamentos mudam de ' +
      'horario junto).',
  })
  @IsIn(['FAIXA', 'JANELA'])
  vale!: HorarioQueVale;

  @ApiProperty({
    example: '2026-09-14',
    description: 'Inicio do intervalo das faixas.',
  })
  @Matches(PADRAO_DIA, { message: 'de deve estar em AAAA-MM-DD' })
  de!: string;

  @ApiProperty({
    example: '2026-09-19',
    description: 'Fim do intervalo das faixas.',
  })
  @Matches(PADRAO_DIA, { message: 'ate deve estar em AAAA-MM-DD' })
  ate!: string;
}

export class IniciarExecucaoGruposDto {
  @ApiProperty({
    enum: TipoExecucaoGruposD2L,
    example: TipoExecucaoGruposD2L.CRIAR_GRUPOS,
    description:
      '`CRIAR_GRUPOS`: categoria do bloco e todos os grupos em cada turma. ' +
      '`INSCREVER_ALUNOS`: cada aluno no grupo da sessao dele, e fora do antigo.',
  })
  @IsIn(Object.values(TipoExecucaoGruposD2L))
  tipo!: TipoExecucaoGruposD2L;

  @ApiPropertyOptional({
    example: true,
    default: true,
    description: 'true (padrao) = so leituras no Brightspace; nenhuma escrita.',
  })
  @IsOptional()
  @IsBoolean()
  simulacao?: boolean;

  @ApiProperty({
    example: '2026-09-14',
    description: 'Primeiro dia de prova considerado.',
  })
  @Matches(PADRAO_DIA, { message: 'de deve estar em AAAA-MM-DD' })
  de!: string;

  @ApiProperty({
    example: '2026-09-19',
    description: 'Ultimo dia de prova considerado.',
  })
  @Matches(PADRAO_DIA, { message: 'ate deve estar em AAAA-MM-DD' })
  ate!: string;

  @ApiPropertyOptional({
    example: false,
    default: false,
    description:
      'Confere no Brightspace mesmo que nada tenha mudado desde a ultima execucao ' +
      'real sem pendencia. Para quando alguem mexeu direto no Brightspace.',
  })
  @IsOptional()
  @IsBoolean()
  forcar?: boolean;

  @ApiPropertyOptional({
    example: '156979',
    description:
      'Roda so nesta turma (orgUnitId). Para o primeiro uso real: conferir numa ' +
      'turma o que o lote faz no Brightspace antes de solta-lo em todas.',
  })
  @IsOptional()
  @Matches(/^\d+$/, {
    message: 'orgUnitId deve ser o id numerico da turma no Brightspace',
  })
  orgUnitId?: string;
}

// ------------------------------------------------------------------- resposta

export class HorarioDoBlocoDto implements HorarioDoBloco {
  @ApiProperty({ example: '09:00' })
  horaInicio!: string;

  @ApiProperty({ example: '12:00' })
  horaFim!: string;

  @ApiProperty({
    type: [String],
    example: ['MODULAR', 'SEMI'],
    description: 'Formatos com janela ativa neste horario.',
  })
  modalidades!: string[];
}

export class LinhaDeGrupoDto implements LinhaDeGrupo {
  @ApiProperty({ example: '2026-09-16' })
  data!: string;

  @ApiProperty({ example: '09:00' })
  horaInicio!: string;

  @ApiProperty({ example: '12:00' })
  horaFim!: string;

  @ApiProperty({ example: '16/09 - 9h as 12h' })
  nomeGrupo!: string;

  @ApiProperty({
    type: [String],
    example: ['MODULAR', 'SEMI'],
    description: 'Em quais formatos a celula da grade existe.',
  })
  modalidades!: string[];
}

export class BlocoDoPainelDto implements BlocoDoPainel {
  @ApiProperty({ enum: BLOCOS_DE_GRUPOS, example: 'SEMI_MODULAR' })
  bloco!: BlocoDeGrupos;

  @ApiProperty({ example: 'Semipresencial e Modular' })
  nome!: string;

  @ApiProperty({ example: 'Provas Presenciais - Semi e Modular' })
  categoria!: string;

  @ApiProperty({
    type: [HorarioDoBlocoDto],
    description:
      'Os horarios que uma linha pode escolher — os das janelas ativas.',
  })
  horarios!: HorarioDoBlocoDto[];

  @ApiProperty({
    type: [String],
    example: ['2026-09-16', '2026-09-17'],
    description: 'Dias com faixa ativa dos formatos do bloco, no intervalo.',
  })
  dias!: string[];

  @ApiProperty({
    type: [LinhaDeGrupoDto],
    description: 'Os grupos cadastrados.',
  })
  linhas!: LinhaDeGrupoDto[];
}

export class JanelaCandidataDto implements JanelaCandidata {
  @ApiProperty({ example: 7 })
  id!: number;

  @ApiProperty({ example: '15:30' })
  horaInicio!: string;

  @ApiProperty({ example: '18:00' })
  horaFim!: string;

  @ApiProperty({
    example: '12:01',
    description: 'Quando o cron aplica a janela.',
  })
  horaDisparo!: string;

  @ApiProperty({
    example: 0,
    description:
      'Faixas do intervalo que ja casam com esta janela. Mudar o horario de uma ' +
      'janela com faixas casadas cria pendencia nelas.',
  })
  faixasQueCasam!: number;
}

export class PendenciaDeHorarioDto implements PendenciaDeHorario {
  @ApiProperty({ example: 1 })
  modalidadeId!: number;

  @ApiProperty({ example: 'EAD' })
  modalidadeCodigo!: string;

  @ApiProperty({ example: 'EaD' })
  modalidadeNome!: string;

  @ApiProperty({
    example: '15:00',
    description: 'Abertura das faixas sem janela.',
  })
  horaInicio!: string;

  @ApiProperty({
    example: '18:00',
    description: 'Fechamento das faixas sem janela.',
  })
  horaFim!: string;

  @ApiProperty({
    example: 126,
    description: 'Quantas faixas tem este horario.',
  })
  faixas!: number;

  @ApiProperty({
    type: [String],
    example: ['2026-09-16'],
    description: 'Dias afetados.',
  })
  dias!: string[];

  @ApiProperty({
    example: 431,
    description: 'Agendamentos confirmados nessas faixas.',
  })
  agendamentos!: number;

  @ApiProperty({
    type: [JanelaCandidataDto],
    description:
      'As janelas ativas do formato, para o admin escolher a correspondente.',
  })
  janelas!: JanelaCandidataDto[];

  @ApiProperty({
    example: 7,
    nullable: true,
    type: Number,
    description:
      'A mais provavel: sem faixa casada e com o horario mais proximo.',
  })
  janelaSugeridaId!: number | null;
}

export class PainelDeGruposDto implements PainelDeGrupos {
  @ApiProperty({ example: '2026-09-14' })
  de!: string;

  @ApiProperty({ example: '2026-09-19' })
  ate!: string;

  @ApiProperty({ example: 'N2', nullable: true, type: String })
  rodada!: string | null;

  @ApiProperty({ type: [String], example: ['156000', '156010'] })
  periodoLetivoIds!: string[];

  @ApiProperty({
    example: false,
    description:
      'O prazo de agendamento ainda esta aberto. Grupos montados agora mudam ' +
      'a cada troca de horario de aluno.',
  })
  agendamentoAberto!: boolean;

  @ApiProperty({
    type: [BlocoDoPainelDto],
    description: 'EaD, Semi/Modular e Presencial.',
  })
  blocos!: BlocoDoPainelDto[];

  @ApiProperty({
    type: [PendenciaDeHorarioDto],
    description:
      'Horarios de faixa sem janela identica. Os alunos deles ficam sem grupo.',
  })
  pendenciasDeHorario!: PendenciaDeHorarioDto[];

  @ApiProperty({ example: 4, nullable: true, type: Number })
  ultimaCriacaoId!: number | null;

  @ApiProperty({ example: 5, nullable: true, type: Number })
  ultimaInscricaoId!: number | null;
}

class FaixaRecusadaDto {
  @ApiProperty({ example: 812 })
  faixaId!: number;

  @ApiProperty({ example: '2026-09-16' })
  data!: string;

  @ApiProperty({
    example: 'O novo horario poria a sala M114 em duas provas ao mesmo tempo.',
  })
  motivo!: string;
}

export class HorarioResolvidoDto implements HorarioResolvido {
  @ApiProperty({
    example: '126 faixa(s) de EAD passaram de 15:00-18:00 para 15:30-18:00.',
  })
  mensagem!: string;

  @ApiProperty({ example: 126 })
  faixasAtualizadas!: number;

  @ApiProperty({
    type: [FaixaRecusadaDto],
    description:
      'Faixas que o cadastro recusou mover. As outras foram movidas.',
  })
  recusadas!: FaixaRecusadaDto[];
}

export class ExecucaoGruposIniciadaDto implements ExecucaoGruposIniciada {
  @ApiProperty({
    example: 6,
    nullable: true,
    type: Number,
    description: 'Nulo quando nada mudou e nenhuma execucao foi aberta.',
  })
  id!: number | null;

  @ApiProperty({ example: true })
  simulacao!: boolean;

  @ApiProperty({
    example: 152,
    description: 'Turmas que o lote vai percorrer.',
  })
  totalTurmas!: number;

  @ApiProperty({
    example: false,
    description:
      'true = nada mudou desde a ultima execucao real; nenhuma chamada saiu.',
  })
  nadaAFazer!: boolean;

  @ApiProperty({ example: null, nullable: true, type: String })
  mensagem!: string | null;
}

export class AndamentoDosGruposD2lDto implements AndamentoDosGruposD2L {
  @ApiProperty({ example: 6 })
  id!: number;

  @ApiProperty({
    enum: TipoExecucaoGruposD2L,
    example: TipoExecucaoGruposD2L.INSCREVER_ALUNOS,
  })
  tipo!: TipoExecucaoGruposD2L;

  @ApiProperty({ enum: StatusExecucao, example: StatusExecucao.EM_ANDAMENTO })
  status!: StatusExecucao;

  @ApiProperty({ example: true })
  simulacao!: boolean;

  @ApiProperty({
    example: false,
    description:
      'O processo morreu no meio. Rodar de novo continua: o lote so escreve o que falta.',
  })
  interrompida!: boolean;

  @ApiProperty({ example: '156000,156010' })
  periodoLetivoIds!: string;

  @ApiProperty({ example: 'N2' })
  rodada!: string;

  @ApiProperty({ example: '2026-09-14' })
  de!: string;

  @ApiProperty({ example: '2026-09-19' })
  ate!: string;

  @ApiProperty({ example: 'secretaria@ucb.br' })
  iniciadoPor!: string;

  @ApiProperty({ example: 152 })
  totalTurmas!: number;

  @ApiProperty({ example: 40 })
  turmasProcessadas!: number;

  @ApiProperty({ example: 0 })
  categoriasCriadas!: number;

  @ApiProperty({ example: 0 })
  gruposCriados!: number;

  @ApiProperty({ example: 0 })
  gruposRenomeados!: number;

  @ApiProperty({ example: 1180 })
  inscricoes!: number;

  @ApiProperty({
    example: 12,
    description: 'Alunos tirados do grupo antigo (remanejo).',
  })
  remocoes!: number;

  @ApiProperty({ example: 3400, description: 'Ja estavam no grupo certo.' })
  jaInscritos!: number;

  @ApiProperty({ example: 3 })
  pendencias!: number;

  @ApiProperty({
    example: { ALUNO_INSCRITO: 1180, ALUNO_NAO_ENCONTRADO: 3 },
    description:
      'Contagem por resultado. As chaves sao os valores de ResultadoGruposD2L.',
    additionalProperties: { type: 'number' },
  })
  resultados!: Partial<Record<ResultadoGruposD2L, number>>;

  @ApiProperty({ example: null, nullable: true, type: String })
  erro!: string | null;

  @ApiProperty({ example: '2026-09-20T13:00:00.000Z' })
  iniciadoEm!: Date;

  @ApiProperty({
    example: '2026-09-20T13:09:00.000Z',
    nullable: true,
    type: Date,
  })
  concluidoEm!: Date | null;

  @ApiProperty({
    example: '2026-09-20T13:09:00.000Z',
    description: 'Sinal de vida.',
  })
  atualizadoEm!: Date;
}
