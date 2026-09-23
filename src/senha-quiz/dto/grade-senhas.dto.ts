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
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  StatusExecucao,
  TipoMatchQuiz,
  Turno,
} from '../../generated/prisma/client';
import type { SituacaoDaCelula } from '../service/grade-senhas.service';
import type { PeriodoDosDisparos } from '../../periodo/service/periodo.service';

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

  @ApiProperty({
    example: 7,
    description:
      'A SESSAO a que a senha pertence — uma janela do questionario. Substituiu ' +
      'o `turno` em 21/09/2026: em Semi/Modular sao seis sessoes e tres turnos, ' +
      'e duas sessoes seguidas dividiam a mesma senha.',
  })
  @IsInt()
  @Min(1)
  janelaDeProvaId!: number;

  /**
   * Rejeitada quando vem vazia, so com espacos, com espaco nas pontas ou com
   * caractere invisivel — ver `validarSenha`. A do meio e a que mais importa: a
   * API do D2L aceita, e os alunos e que descobririam no dia.
   */
  @ApiProperty({
    example: '897325',
    description:
      'A senha da sessao, em texto claro. Nao pode ser vazia, comecar/terminar ' +
      'com espaco nem conter caractere invisivel.\n\n' +
      'Este e o caminho de EMERGENCIA: o normal e `POST /senhas-de-prova/gerar`, ' +
      'que sorteia. Aceita qualquer valor que o AVA aceite (e nao so seis ' +
      'digitos) de propósito — a regra do sorteio e sobre o que o sistema ' +
      'PRODUZ, e impo-la aqui impediria repor uma senha ja anunciada na sala.',
  })
  @IsString()
  senha!: string;
}

export class GerarSenhasDto {
  @ApiProperty({
    example: '2026-09-21',
    description: 'Primeiro dia (AAAA-MM-DD).',
  })
  @IsDateString()
  de!: string;

  @ApiProperty({
    example: '2026-09-26',
    description: 'Ultimo dia (AAAA-MM-DD).',
  })
  @IsDateString()
  ate!: string;

  @ApiPropertyOptional({
    example: false,
    default: false,
    description:
      'true = TROCA tambem as celulas que ja tem senha.\n\n' +
      'O padrao e `false`, e a diferenca importa: regerar um dia cuja folha ja ' +
      'esta na mao dos fiscais troca a senha da prova sem ninguem na sala saber. ' +
      'Tem de ser um pedido explicito, e nao o efeito de clicar duas vezes.',
  })
  @IsOptional()
  @IsBoolean()
  substituir?: boolean;
}

export class SenhasGeradasDto {
  @ApiProperty({ example: 120, description: 'Celulas que nasceram agora.' })
  criadas!: number;

  @ApiProperty({
    example: 0,
    description: 'Celulas que ja existiam e receberam uma senha nova.',
  })
  substituidas!: number;

  @ApiProperty({
    example: 20,
    description: 'Celulas que ja tinham senha e foram preservadas.',
  })
  preservadas!: number;

  @ApiProperty({
    type: () => [CelulaDaGradeDto],
    description: 'A grade do intervalo, ja com o que foi gerado.',
  })
  celulas!: CelulaDaGradeDto[];
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

  @ApiProperty({
    example: 7,
    description: 'A sessao. A janela carrega o formato, as horas e o disparo.',
  })
  janelaDeProvaId!: number;

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

  @ApiProperty({ example: 'admin@ucb.br', nullable: true })
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

export class SenhasReveladasDto {
  @ApiProperty({
    example: { 3: '897325', 4: '104507' },
    description:
      'Id da celula -> senha em claro, para todo o intervalo pedido.\n\n' +
      'Uma linha de auditoria para o intervalo INTEIRO, e nao uma por celula: ' +
      'com ~20 sessoes por dia, auditar celula a celula produziria mais de cem ' +
      'linhas identicas por semana e afogaria o log de seguranca.',
    additionalProperties: { type: 'string' },
    type: 'object',
  })
  senhas!: Record<number, string>;
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
  @IsNotEmpty({ message: 'Informe o nome do questionário que o lote procura.' })
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

  @ApiProperty({ example: 'admin@ucb.br', nullable: true })
  atualizadoPor!: string | null;

  @ApiProperty({ example: '2026-09-01T12:00:00.000Z', nullable: true })
  atualizadoEm!: Date | null;

  @ApiProperty({
    example: true,
    description: 'false = ninguem escolheu ainda, e o lote recusa comecar.',
  })
  configurado!: boolean;
}

export class DefinirPeriodoDosDisparosDto {
  @ApiProperty({
    example: 7,
    nullable: true,
    type: Number,
    description:
      'O periodo de agendamento cujas turmas e alunos os disparos usam. ' +
      '`null` = sem periodo fixo: segue o vigente (o cadastrado por ultimo). ' +
      'Obrigatorio no corpo, inclusive quando nulo — omitir nao pode ser lido ' +
      'como "voltar ao vigente" por engano.',
  })
  @ValidateIf((o: { periodoId?: unknown }) => o.periodoId !== null)
  @IsInt({ message: 'Escolha um período de agendamento da lista.' })
  @Min(1, { message: 'Escolha um período de agendamento da lista.' })
  periodoId!: number | null;
}

export class PeriodoEmUsoDto {
  @ApiProperty({ example: 7, description: 'Id do periodo de agendamento.' })
  id!: number;

  @ApiProperty({ example: '6606', description: 'Periodo letivo principal.' })
  periodoLetivoId!: string;

  @ApiProperty({ example: 'SUB', description: 'Qual prova do semestre.' })
  rodada!: string;

  @ApiProperty({
    example: '2026/3 - Substitutiva',
    nullable: true,
    type: String,
  })
  descricao!: string | null;

  @ApiProperty({
    example: false,
    description: 'true = e o vigente (o cadastrado por ultimo).',
  })
  vigente!: boolean;
}

export class PeriodoDosDisparosDto implements PeriodoDosDisparos {
  @ApiProperty({
    example: 7,
    nullable: true,
    type: Number,
    description: '`null` = sem periodo fixo: os disparos seguem o vigente.',
  })
  periodoId!: number | null;

  @ApiProperty({
    type: PeriodoEmUsoDto,
    nullable: true,
    description:
      'O periodo que os disparos usam AGORA — o escolhido, ou o vigente. ' +
      'Nulo so quando nao ha periodo cadastrado.',
  })
  emUso!: PeriodoEmUsoDto | null;

  @ApiProperty({ example: 'admin@ucb.br', nullable: true, type: String })
  atualizadoPor!: string | null;

  @ApiProperty({
    example: '2026-09-23T12:00:00.000Z',
    nullable: true,
    type: Date,
  })
  atualizadoEm!: Date | null;
}

export class CandidataDeModalidadeDto {
  @ApiProperty({ example: 3, description: 'Id do formato, para o PUT.' })
  modalidadeId!: number;

  @ApiProperty({ example: 'EAD' })
  codigo!: string;

  @ApiProperty({ example: 'EaD' })
  nome!: string;

  @ApiProperty({
    example: 583,
    description:
      'Quantos alunos deste formato tem prova confirmada na turma. E o ' +
      'numero que a administração olha para decidir — 583 contra 1 e uma decisao ' +
      'diferente de 12 contra 9.',
  })
  reservas!: number;
}

export class EscolherModalidadeDaTurmaDto {
  @ApiProperty({
    example: 3,
    description:
      'O formato que passa a valer para esta turma. Precisa estar entre as ' +
      '`candidatas` — o servidor recusa qualquer outro, inclusive um ' +
      'formato real que simplesmente nao tenha aluno com prova ali.',
  })
  @IsInt()
  @Min(1)
  modalidadeId!: number;
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
      'O formato DERIVADO dos agendamentos confirmados da rodada vigente — ' +
      'e ela que decide qual janela de horario o lote de datas aplica nesta ' +
      'turma. Nula quando nao foi possivel derivar; o motivo vem em ' +
      '`motivoSemModalidade`, e a turma fica de fora do lote de datas.',
  })
  modalidadeCodigo!: string | null;

  @ApiProperty({ example: 'EaD', nullable: true })
  modalidadeNome!: string | null;

  @ApiProperty({
    example:
      'Alunos de 2 formatos tem prova nesta turma: EAD (9), SEMI (7). ' +
      'O questionario tem uma janela so, entao nenhuma foi escolhida.',
    nullable: true,
    description:
      'Por que o formato nao pode ser derivado. **Revise antes do primeiro ' +
      'dia**: cada linha destas e uma turma que ficaria com a data antiga.',
  })
  motivoSemModalidade!: string | null;

  @ApiProperty({
    type: [CandidataDeModalidadeDto],
    description:
      'Os formatos que tem prova nesta turma, quando ha mais de um — ' +
      'ordenadas por reservas. **Vazio significa que nao ha o que escolher**: ' +
      'ou a derivacao foi unanime, ou ninguem agendou ali. E este array que ' +
      'habilita `PUT /senhas-de-prova/turmas/:turmaId/modalidade`, e a mesma ' +
      'condicao e reconferida no servidor a cada gravacao.',
  })
  candidatas!: CandidataDeModalidadeDto[];

  @ApiProperty({
    example: 'admin@ucb.br',
    nullable: true,
    description:
      'Quem decidiu o formato desta turma, quando ele veio de uma escolha ' +
      'manual. **Nulo na derivacao normal** — a tela precisa distinguir "a ' +
      'turma so tem EaD" de "alguem decidiu que ela vale como EaD".',
  })
  modalidadeEscolhidaPor!: string | null;

  @ApiProperty({
    example: '2026-09-10T13:45:00.000Z',
    nullable: true,
    description: 'Quando a escolha manual foi feita ou trocada.',
  })
  modalidadeEscolhidaEm!: string | null;
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
 * Uma janela sem hora nao existe — para desligar uma sessao ha `ativo`, que
 * preserva o horario cadastrado para o semestre seguinte.
 */
const PADRAO_HORA = /^([01]\d|2[0-3]):([0-5]\d)$/;

const MSG_HORA_OBRIGATORIA = (campo: string) =>
  `${campo} deve estar em HH:MM (24h, com zero a esquerda), ex.: 15:00`;

export class JanelaDeProvaDto {
  @ApiProperty({
    example: 2,
    description:
      'Sequencia da sessao dentro do formato. NAO e a ordem do relogio: ' +
      'a primeira e a que dispara a noite armando a prova do dia seguinte.',
  })
  @IsInt()
  @Min(1)
  ordem!: number;

  @ApiProperty({
    example: '12:01',
    description:
      'A que horas o cron aplica esta janela (fuso de Brasilia). Duas janelas ' +
      'ativas do mesmo formato nao podem disparar no mesmo minuto.',
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
      'tem UM GRUPO POR SESSAO, na quantidade que o formato define (3 no ' +
      'EaD, 6 em Semi/Modular, 5 no Presencial), e o disparo troca o grupo ' +
      'APONTADO pela condicao.\n\n' +
      '**Desde 14/09/2026 e o nome PADRAO.** O grupo de cada dia vem da grade ' +
      '`/senhas-de-prova/grupos` (dia x janela); este campo so vale nos dias ' +
      'sem celula ali.\n\n' +
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
      'O formato cujo calendario esta sendo salvo. O PUT substitui as ' +
      'janelas DESTE formato e nao toca nos outros.',
  })
  @IsInt()
  @Min(1)
  modalidadeId!: number;

  @ApiProperty({
    type: [JanelaDeProvaDto],
    description:
      'O calendario completo do formato. Sessao que nao vier aqui e ' +
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

  @ApiProperty({ example: 'admin@ucb.br', nullable: true })
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
