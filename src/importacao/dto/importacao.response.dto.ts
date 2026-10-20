import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type {
  AlteracaoComAgendamento,
  CandidataRenomeacao,
  CursoRenomeado,
  LinhaRejeitada,
  Mudanca,
  ResultadoImportacaoAlunos,
  ResumoSaidas,
  VinculoForaDaPlanilha,
} from '../service/importacao-alunos.service';
import { SEMELHANCA, type Semelhanca } from '../service/curso-renomeado';
import type { ResultadoImportacaoTurmas } from '../service/importacao-turmas.service';

export class LinhaRejeitadaDto implements LinhaRejeitada {
  @ApiProperty({
    example: 42,
    description: 'Numero da linha no arquivo (1 = primeira apos o cabecalho).',
  })
  linha!: number;

  @ApiProperty({
    example: 'A06103080',
    description: 'RA da linha. Vazio quando o proprio RA foi o motivo.',
  })
  matricula!: string;

  @ApiProperty({
    example: 'MARIA DE SOUZA',
    description:
      'Coluna ALUNO, como veio no arquivo. Serve para achar a linha na planilha.',
  })
  nome!: string;

  @ApiProperty({ example: 'ADMINISTRACAO', description: 'Coluna CURSO.' })
  curso!: string;

  @ApiProperty({ example: 'Campus Ceilandia', description: 'Coluna CAMPUS.' })
  campus!: string;

  @ApiProperty({
    example: 'CAMPUS "Polo Inexistente" nao casou com nenhum polo',
  })
  motivo!: string;
}

export class StatusDesconhecidoDto {
  @ApiProperty({
    example: 'Reintegrado',
    description:
      'Grafia encontrada no arquivo que nao esta em nenhuma das duas listas de src/enums/status-curso.enum.ts.',
  })
  status!: string;

  @ApiProperty({ example: 3 })
  ocorrencias!: number;
}

export class PoloNaoEncontradoDto {
  @ApiProperty({
    example: 'Polo Novo - GO',
    description:
      'Valor de CAMPUS que nao casou com nenhum Polo.nome do seed. Corrija adicionando a linha em prisma/seed-polos.ts.',
  })
  campus!: string;

  @ApiProperty({ example: 17 })
  ocorrencias!: number;
}

export class MudancaDto implements Mudanca {
  @ApiProperty({ example: 'EaD', description: 'Valor anterior.' })
  de!: string;

  @ApiProperty({ example: 'Modular', description: 'Valor gravado agora.' })
  para!: string;
}

/**
 * Um vinculo que JA TINHA PROVA MARCADA e mudou de formato, de polo ou de
 * elegibilidade (STATUS CURSO) nesta importacao.
 *
 * Nos dois primeiros a reserva continua apontando para a sala antiga — prova de
 * outra duracao, ou em outro campus — e o sintoma so aparece dias depois,
 * disfarcado: o remanejo passa a ser recusado com "esta sala nao e do
 * formato do aluno". No terceiro o aluno perde o direito de agendar e mantem
 * a cadeira: nao troca mais de horario, sai do compulsorio, e ainda assim
 * aparece na lista de presenca do dia.
 */
export class AlteracaoComAgendamentoDto implements AlteracaoComAgendamento {
  @ApiProperty({
    example: 128,
    description: 'Numero da linha no arquivo (1 = primeira apos o cabecalho).',
  })
  linha!: number;

  @ApiProperty({ example: 'UC24424289' })
  matricula!: string;

  @ApiProperty({ example: 'MONICA RIBEIRO MARQUES' })
  nome!: string;

  @ApiProperty({ example: 'PEDAGOGIA' })
  curso!: string;

  @ApiPropertyOptional({
    type: MudancaDto,
    description:
      'Presente so quando o formato mudou. A prova marcada passa a ter outra ' +
      'duracao que a da sala em que o aluno esta alocado.',
  })
  modalidade?: MudancaDto;

  @ApiPropertyOptional({
    type: MudancaDto,
    description:
      'Presente so quando o polo mudou. A prova marcada continua no campus anterior.',
  })
  polo?: MudancaDto;

  @ApiPropertyOptional({
    type: MudancaDto,
    description:
      'Presente so quando o vinculo PERDEU a elegibilidade nesta importacao ' +
      '(ex.: "Ativo" -> "Transf. Interna"). Os valores sao os STATUS CURSO ' +
      'brutos da planilha. A prova marcada NAO e cancelada: o aluno deixa de ' +
      'poder agendar e trocar, sai do compulsorio, e continua ocupando a vaga. ' +
      'Ganhar elegibilidade nao aparece aqui, nem troca entre dois status que ' +
      'ja bloqueavam.',
  })
  statusCurso?: MudancaDto;

  @ApiProperty({
    example: 1,
    description:
      'Reservas confirmadas do vinculo. Conta so o semestre vigente quando ha ' +
      'periodo cadastrado — prova de semestre passado ja aconteceu.',
  })
  agendamentosConfirmados!: number;
}

/** Um vinculo antigo que parece ser o mesmo curso escrito de outro jeito. */
export class CandidataRenomeacaoDto implements CandidataRenomeacao {
  @ApiProperty({
    example: 4821,
    description:
      'Id do vinculo ANTIGO — o que sera absorvido na mesclagem, e onde a ' +
      'prova ja marcada esta presa.',
  })
  alunoId!: number;

  @ApiProperty({
    example: 'PSICOLOGIA',
    description: 'A grafia anterior, como esta gravada no banco.',
  })
  curso!: string;

  @ApiProperty({
    enum: Object.values(SEMELHANCA),
    example: SEMELHANCA.TOKENS_CONTIDOS,
    description:
      'Como a semelhanca foi estabelecida. "identico-normalizado" = so mudou ' +
      'acento, caixa ou pontuacao; "tokens-contidos" = um nome e o outro com ' +
      'palavras a mais. Nao ha comparacao por aproximacao.',
  })
  semelhanca!: Semelhanca;

  @ApiProperty({ example: 'EaD' })
  modalidade!: string;

  @ApiProperty({ example: 'Taguatinga' })
  polo!: string;

  @ApiProperty({
    example: 1,
    description:
      'Reservas confirmadas presas neste vinculo, em QUALQUER periodo letivo. ' +
      'Sem recorte de semestre de proposito: a renomeacao chega na planilha do ' +
      'semestre novo, e a prova orfa costuma ser a do anterior.',
  })
  agendamentosConfirmados!: number;
}

/**
 * Uma linha que criou vinculo novo quando o RA ja tinha curso de grafia
 * parecida — e aquela grafia sumiu deste arquivo.
 *
 * Nao bloqueia e nao mescla: dois vinculos no mesmo RA existem de verdade, e
 * fundir cursos distintos misturaria as provas de dois cursos numa pessoa so.
 */
export class CursoRenomeadoDto implements CursoRenomeado {
  @ApiProperty({
    example: 512,
    description: 'Numero da linha no arquivo (1 = primeira apos o cabecalho).',
  })
  linha!: number;

  @ApiProperty({ example: 'UC25426847' })
  matricula!: string;

  @ApiProperty({ example: 'ANA PAULA SOUZA' })
  nome!: string;

  @ApiProperty({
    example: 'Psicologia — Bacharelado',
    description: 'A grafia nova, a que veio no arquivo e criou o vinculo.',
  })
  curso!: string;

  @ApiProperty({
    example: 9134,
    description: 'Id do vinculo recem-criado — o destino da mesclagem.',
  })
  alunoId!: number;

  @ApiProperty({
    type: [CandidataRenomeacaoDto],
    description:
      'Mais de uma candidata significa ambiguidade: a administracao escolhe, o ' +
      'sistema nao chuta.',
  })
  candidatas!: CandidataRenomeacaoDto[];
}

/** Um vinculo que nao veio no CSV completo do formato. */
export class VinculoForaDaPlanilhaDto implements VinculoForaDaPlanilha {
  @ApiProperty({ example: 9134, description: 'Id do vinculo.' })
  alunoId!: number;

  @ApiProperty({ example: 'UC24424289' })
  matricula!: string;

  @ApiProperty({ type: String, nullable: true, example: 'ANA PAULA SOUZA' })
  nome!: string | null;

  @ApiProperty({ example: 'PEDAGOGIA' })
  curso!: string;

  @ApiProperty({ example: 'Câmpus Taguatinga' })
  polo!: string;

  @ApiProperty({
    example: 'Ativo',
    description:
      'O ultimo STATUS CURSO gravado, de quando ele ainda vinha na planilha.',
  })
  statusCurso!: string;

  @ApiProperty({
    example: 1,
    description:
      'Reservas confirmadas no semestre vigente. A prova NAO e cancelada: ' +
      'remanejar, cancelar ou manter e decisao da administracao.',
  })
  agendamentosConfirmados!: number;
}

export class ResumoSaidasDto implements ResumoSaidas {
  @ApiProperty({
    example: false,
    description:
      'true = os vinculos foram marcados. false = simulacao (o padrao), ou ' +
      'recusada pelo limite sem a segunda confirmacao.',
  })
  aplicadas!: boolean;

  @ApiProperty({
    example: false,
    description:
      'Pediu para aplicar, mas o percentual passou do limite e faltou ' +
      '`confirmarAcimaDoLimite`. Nada foi marcado.',
  })
  bloqueadasPeloLimite!: boolean;

  @ApiProperty({ example: 312, description: 'Vinculos fora deste arquivo.' })
  total!: number;

  @ApiProperty({
    example: 4300,
    description:
      'Vinculos do formato dentro da planilha, os deste arquivo inclusive.',
  })
  base!: number;

  @ApiProperty({ example: 7.3, description: '`total / base`, em %.' })
  percentual!: number;

  @ApiProperty({ example: 10 })
  limitePercentual!: number;

  @ApiProperty({
    example: false,
    description:
      'Acima do limite, aplicar exige `confirmarAcimaDoLimite`: e o sinal de ' +
      'arquivo cortado, aba errada ou CSV parcial com a caixa marcada.',
  })
  acimaDoLimite!: boolean;

  @ApiProperty({
    type: [VinculoForaDaPlanilhaDto],
    description: 'Quem tem prova marcada vem primeiro.',
  })
  vinculos!: VinculoForaDaPlanilhaDto[];
}

/**
 * Alem dos numeros, a resposta destaca tudo que precisa de decisao humana:
 * linhas rejeitadas, status nunca vistos, polos que nao casaram, trocas que
 * mexeram em quem ja tem prova marcada e vinculos duplicados por grafia.
 */
export class ResultadoImportacaoAlunosDto implements ResultadoImportacaoAlunos {
  @ApiProperty({ example: 7, description: 'Id do registro de auditoria.' })
  importacaoId!: number;

  @ApiProperty({ example: 'alunos-ead-2026-1.csv' })
  arquivo!: string;

  @ApiProperty({ example: 'EAD' })
  modalidade!: string;

  @ApiProperty({ example: 4312 })
  totalLinhas!: number;

  @ApiProperty({ example: 4102 })
  criados!: number;

  @ApiProperty({
    example: 198,
    description: 'Reenviar o mesmo arquivo atualiza; nunca duplica.',
  })
  atualizados!: number;

  @ApiProperty({
    example: 4008,
    description: 'Vinculos gravados cujo STATUS CURSO permite agendar.',
  })
  podemAgendar!: number;

  @ApiProperty({ example: 292 })
  bloqueados!: number;

  @ApiProperty({ type: [LinhaRejeitadaDto] })
  rejeitadas!: LinhaRejeitadaDto[];

  @ApiProperty({
    type: [StatusDesconhecidoDto],
    description: 'Status fora das listas conhecidas — bloqueiam por seguranca.',
  })
  statusDesconhecidos!: StatusDesconhecidoDto[];

  @ApiProperty({ type: [PoloNaoEncontradoDto] })
  polosNaoEncontrados!: PoloNaoEncontradoDto[];

  @ApiProperty({
    type: [AlteracaoComAgendamentoDto],
    description:
      'Vinculos COM PROVA MARCADA cujo formato, polo ou elegibilidade ' +
      '(STATUS CURSO) mudaram nesta importacao. Nao bloqueia o upload — a ' +
      'planilha e a fonte de verdade e pode estar corrigindo um cadastro ' +
      'errado —, mas cada linha aqui pede decisao: remanejar a reserva, ' +
      'cancela-la, ou manter a vaga de quem perdeu a elegibilidade.',
  })
  alteracoesComAgendamento!: AlteracaoComAgendamentoDto[];

  @ApiProperty({
    type: [CursoRenomeadoDto],
    description:
      'Vinculos que NASCERAM DUPLICADOS porque a grafia do curso mudou na ' +
      'planilha ("PSICOLOGIA" -> "Psicologia — Bacharelado"). A chave do ' +
      'vinculo e [matricula, curso], entao o upsert nao encontrou a linha ' +
      'antiga e criou outra; a prova ja marcada continua presa a antiga. ' +
      'Cada item traz o vinculo novo e as candidatas a mesma pessoa — resolva ' +
      'em POST /alunos/:id/mesclar.',
  })
  cursosRenomeados!: CursoRenomeadoDto[];

  @ApiProperty({
    example: 2,
    description:
      'Vinculos que estavam fora da planilha e vieram neste arquivo (completo ' +
      'ou parcial). A marca sai e eles voltam a agendar, se o status permitir.',
  })
  voltaramParaAPlanilha!: number;

  @ApiProperty({
    example: true,
    description: 'Se o arquivo foi enviado como a lista completa do formato.',
  })
  listaCompleta!: boolean;

  @ApiPropertyOptional({
    type: ResumoSaidasDto,
    nullable: true,
    description:
      'A comparacao com o banco. null quando o arquivo nao e a lista completa.',
  })
  saidas!: ResumoSaidasDto | null;
}

export class TurmaRejeitadaDto {
  @ApiProperty({
    example: 12,
    description: 'Numero da linha no arquivo (1 = primeira apos o cabecalho).',
  })
  linha!: number;

  @ApiProperty({
    example: 'OrgUnitId vazio — sem ele a linha nao identifica turma nenhuma',
  })
  motivo!: string;
}

export class ResultadoImportacaoTurmasDto implements ResultadoImportacaoTurmas {
  @ApiProperty({ example: 8, description: 'Id do registro de auditoria.' })
  importacaoId!: number;

  @ApiProperty({ example: 'turmas-2026-1.csv' })
  arquivo!: string;

  @ApiProperty({ example: 320 })
  totalLinhas!: number;

  @ApiProperty({ example: 318 })
  criadas!: number;

  @ApiProperty({
    example: 0,
    description: 'Reenviar o mesmo arquivo atualiza; nunca duplica.',
  })
  atualizadas!: number;

  @ApiProperty({ type: [TurmaRejeitadaDto] })
  rejeitadas!: TurmaRejeitadaDto[];
}

/** Uma entrada do historico de importacoes. */
export class ImportacaoCsvDto {
  @ApiProperty({ example: 7 })
  id!: number;

  @ApiProperty({ enum: ['ALUNOS', 'SALAS', 'TURMAS'], example: 'ALUNOS' })
  tipo!: string;

  @ApiProperty({ example: 'alunos-ead-2026-1.csv' })
  nomeArquivo!: string;

  @ApiProperty({ example: 4312 })
  totalLinhas!: number;

  @ApiPropertyOptional({
    nullable: true,
    example: 'admin@ucb.br',
    description: 'E-mail do admin que subiu o arquivo.',
  })
  importadoPor!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-07-30T14:11:57.000Z',
  })
  createdAt!: Date;

  @ApiProperty({
    example: false,
    description:
      'So alunos: o arquivo foi enviado como a lista completa do formato.',
  })
  listaCompleta!: boolean;

  @ApiProperty({
    example: 0,
    description: 'Vinculos que esta importacao marcou como fora da planilha.',
  })
  saidasMarcadas!: number;
}
