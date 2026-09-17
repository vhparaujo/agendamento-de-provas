import { Injectable, NotFoundException } from '@nestjs/common';
import { janelaDeDatas } from '../../agendamento/service/agendamento-admin.service';
import { PrismaService } from '../../database/prisma.service';
import { Prisma, StatusAgendamento } from '../../generated/prisma/client';
import { PeriodoService } from '../../periodo/service/periodo.service';
import { nomeDaListaDePresenca } from './nome-de-arquivo';
import {
  pdfDeListasDePresenca,
  type ListaDePresenca,
} from './pdf-lista-presenca';
import type { ArquivoGerado, FiltroRelatorio } from './relatorio.service';

/**
 * ============================================================================
 * LISTA DE PRESENCA — UMA PAGINA POR SALA DE APLICACAO
 * ============================================================================
 * O documento que vai impresso para o campus e volta assinado. A pergunta e a
 * mais concreta do sistema: **quem senta nesta sala, neste horario, neste
 * polo** — e por isso o recorte e a `SalaFaixa`, a oferta que ja e exatamente
 * esse trio (a faixa carrega polo, data e hora; a oferta acrescenta a sala).
 *
 * Nao confunda com os outros dois relatorios:
 *
 * | | quem le | recorte | quem entra |
 * |---|---|---|---|
 * | `/agendamentos/exportacao` | administracao, no Excel | um periodo letivo | TODOS os vinculos |
 * | `/relatorios/grupos-d2l` | o Brightspace | faixa **x turma** | confirmados, 1 linha por RA |
 * | **lista de presenca** | o **fiscal**, no papel | **sala x faixa** | confirmados, 1 linha por RA |
 *
 * Tres decisoes que nao sao acidente:
 *
 * 1. **Sala sem ninguem agendado nao vira pagina.** O documento e a relacao de
 *    quem tem lugar ali; sala vazia nao tera aplicacao de prova, e uma folha em
 *    branco no meio da pilha so faz o fiscal procurar o erro. Quem quer ver a
 *    oferta montada, cheia ou vazia, usa `GET /agendamentos/resumo`.
 * 2. **Uma linha por PESSOA, e nao por agendamento.** A folha e assinada a mao:
 *    o mesmo RA duas vezes faria o fiscal chamar a mesma pessoa duas vezes e
 *    ficar com uma linha em branco no fim, parecendo falta de quem estava
 *    presente. A deduplicacao e por `matricula`.
 *
 *    Desde 14/08/2026 isto e quase so uma rede de seguranca: um RA nao consegue
 *    mais marcar duas provas na mesma faixa (`exigirUmaProvaPorFaixa`), entao
 *    duas linhas na mesma sala so existem em dado gravado ANTES da regra. Vale
 *    manter — o relatorio nao pode depender de o historico estar limpo.
 *
 *    ⚠️ Nesses casos antigos `totalAlunos` fica MENOR que `ocupadas` em
 *    `GET /agendamentos/resumo`: a sala tem duas cadeiras tomadas e a folha, uma
 *    linha. A divergencia e o sintoma do dado velho, nao um erro de contagem —
 *    o certo e cancelar o agendamento duplicado, nao voltar a imprimir duas
 *    linhas.
 * 3. **So `CONFIRMADO`, e so o periodo letivo do recorte.** Quem cancelou
 *    devolveu a vaga e nao pode aparecer na folha; sem o recorte de periodo, a
 *    sala da prova do semestre passado entraria na pilha deste.
 *
 * A ordem dentro da pagina e ALFABETICA POR NOME, nao por matricula nem por
 * ordem de agendamento: o fiscal procura pela pessoa que esta na frente dele, e
 * o que ela sabe dizer e o proprio nome.
 */
@Injectable()
export class ListaPresencaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly periodo: PeriodoService,
  ) {}

  /** As salas do recorte que terao aplicacao, com quantos alunos cada. */
  async listar(filtro: FiltroRelatorio): Promise<SalaComLista[]> {
    const listas = await this.montarListas(this.ondeSalaFaixa(filtro), filtro);

    // A tela quer a CONTAGEM, nao os alunos: devolver as listas inteiras
    // mandaria milhares de nomes para o navegador exibir um numero por linha.
    return listas.map(({ linha }) => linha);
  }

  /** O PDF com TODAS as salas do recorte, uma pagina cada. */
  async pdfDoRecorte(filtro: FiltroRelatorio): Promise<ArquivoGerado> {
    const listas = await this.montarListas(this.ondeSalaFaixa(filtro), filtro);

    if (listas.length === 0) {
      throw new NotFoundException(
        'Nenhuma sala com aluno confirmado neste filtro.',
      );
    }

    return {
      nomeArquivo: `Listas de presenca-${carimboDeHora()}.pdf`,
      conteudo: await pdfDeListasDePresenca(listas.map((l) => l.pagina)),
    };
  }

  /** O PDF de UMA sala — a folha avulsa que faltou, ou que foi reimpressa. */
  async pdfDeUmaSala(
    salaFaixaId: number,
    filtro: FiltroRelatorio,
  ): Promise<ArquivoGerado> {
    // Data e polo nao valem aqui de proposito, pelo mesmo motivo do CSV de um
    // grupo: quem pediu ESTA sala ja escolheu o horario, e um `?de=` esquecido
    // na URL devolveria 404 em vez do arquivo. O periodo letivo continua
    // valendo — e ele que separa os semestres.
    const [lista] = await this.montarListas({ id: salaFaixaId }, filtro);

    if (!lista) {
      throw new NotFoundException('Nenhum aluno confirmado nesta sala.');
    }

    return {
      nomeArquivo: lista.linha.nomeArquivo,
      conteudo: await pdfDeListasDePresenca([lista.pagina]),
    };
  }

  /**
   * O calculo inteiro, num lugar so: a tabela da tela, o PDF do recorte e o PDF
   * avulso precisam do mesmo dado. Se a tela contasse de um jeito e o papel
   * saisse de outro, a divergencia so apareceria no dia da prova, com o fiscal
   * conferindo a sala.
   *
   * Sao DUAS consultas e nao uma por sala: com dezenas de horarios e varias
   * salas cada, o N+1 apareceria ja no primeiro semestre. As ofertas vem
   * primeiro porque sao elas que carregam a identidade da pagina (polo, sala,
   * formato da oferta); os agendamentos entram depois, agrupados por oferta.
   */
  private async montarListas(
    ondeSalaFaixa: Prisma.SalaFaixaWhereInput,
    filtro: FiltroRelatorio,
  ): Promise<SalaComPagina[]> {
    const periodoLetivoId = await this.periodosDoRecorte(filtro);

    const agendamentos = await this.prisma.agendamento.findMany({
      where: {
        status: StatusAgendamento.CONFIRMADO,
        periodoLetivoId,
        salaFaixa: ondeSalaFaixa,
      },
      select: {
        matricula: true,
        salaFaixaId: true,
        // O formato do AGENDAMENTO, nao a do vinculo de hoje: e a fotografia
        // do que o aluno era quando reservou, e e ela que combina com a duracao
        // da prova que ele vai fazer nesta sala.
        modalidade: { select: { nome: true } },
        aluno: { select: { nome: true } },
      },
    });

    if (agendamentos.length === 0) return [];

    const ofertas = await this.prisma.salaFaixa.findMany({
      where: {
        id: { in: [...new Set(agendamentos.map((a) => a.salaFaixaId))] },
      },
      select: {
        id: true,
        vagas: true,
        sala: { select: { id: true, nome: true } },
        modalidade: { select: { nome: true } },
        faixa: {
          select: {
            id: true,
            data: true,
            horaInicio: true,
            horaFim: true,
            polo: { select: { id: true, nome: true } },
          },
        },
      },
    });

    // UMA LINHA POR PESSOA: a chave e a matricula, nao o agendamento. Ver o
    // cabecalho do arquivo.
    const porOferta = new Map<number, Map<string, AlunoDaLista>>();

    for (const agendamento of agendamentos) {
      const alunos =
        porOferta.get(agendamento.salaFaixaId) ??
        new Map<string, AlunoDaLista>();

      // `set` so na primeira vez: reescrever daria o mesmo resultado (as duas
      // linhas do mesmo RA tem o mesmo nome), mas deixaria implicito que a
      // ultima vence — e nao ha "ultima" definida, a consulta nao ordena por
      // vinculo.
      if (!alunos.has(agendamento.matricula)) {
        alunos.set(agendamento.matricula, {
          matricula: agendamento.matricula,
          nome: agendamento.aluno.nome,
          modalidade: agendamento.modalidade.nome,
        });
      }

      porOferta.set(agendamento.salaFaixaId, alunos);
    }

    return ofertas
      .map((oferta) => {
        const alunos = [...(porOferta.get(oferta.id)?.values() ?? [])].sort(
          porNome,
        );

        const pagina: ListaDePresenca = {
          polo: oferta.faixa.polo.nome,
          modalidade: oferta.modalidade.nome,
          sala: oferta.sala.nome,
          data: oferta.faixa.data,
          horaInicio: oferta.faixa.horaInicio,
          horaFim: oferta.faixa.horaFim,
          alunos,
        };

        const linha: SalaComLista = {
          salaFaixaId: oferta.id,
          faixaId: oferta.faixa.id,
          poloId: oferta.faixa.polo.id,
          polo: oferta.faixa.polo.nome,
          salaId: oferta.sala.id,
          sala: oferta.sala.nome,
          modalidade: oferta.modalidade.nome,
          data: oferta.faixa.data,
          horaInicio: oferta.faixa.horaInicio,
          horaFim: oferta.faixa.horaFim,
          vagas: oferta.vagas,
          totalAlunos: alunos.length,
          nomeArquivo: nomeDaListaDePresenca(pagina),
        };

        return { linha, pagina };
      })
      .sort((a, b) => ordemDaPilha(a.linha, b.linha));
  }

  private ondeSalaFaixa(filtro: FiltroRelatorio): Prisma.SalaFaixaWhereInput {
    return { faixa: { poloId: filtro.poloId, data: janelaDeDatas(filtro) } };
  }

  /**
   * O recorte por periodo letivo: o da URL, ou a JANELA VIGENTE INTEIRA.
   *
   * Devolve um filtro (`{ in: [...] }`) e nao uma string porque a janela cobre
   * mais de um org unit ao mesmo tempo — a grade modular e a semestral correm em
   * paralelo. Um id so deixaria de fora as provas dos presenciais, e o relatorio
   * sairia com metade da sala.
   *
   * `undefined` = sem recorte (nenhum periodo cadastrado), como antes.
   */
  private async periodosDoRecorte(
    filtro: FiltroRelatorio,
  ): Promise<{ in: string[] } | undefined> {
    if (filtro.periodoLetivoId?.length) return { in: filtro.periodoLetivoId };

    const janela = await this.periodo.janelaVigente();

    return janela ? { in: janela.periodoLetivoIds } : undefined;
  }
}

/** Uma linha da tabela da tela: a sala, e quantos assinam nela. */
export interface SalaComLista {
  /** A oferta (`SalaFaixa`) — sala + horario + polo num id so. */
  salaFaixaId: number;
  faixaId: number;
  poloId: number;
  polo: string;
  salaId: number;
  sala: string;
  /** Da oferta: o formato em que a sala esta travada nesta faixa. */
  modalidade: string;
  data: Date;
  horaInicio: string;
  horaFim: string;
  vagas: number;
  /** Pessoas distintas com prova confirmada — as linhas que a folha tera. */
  totalAlunos: number;
  /** Nome com que a folha avulsa desta sala e baixada. */
  nomeArquivo: string;
}

export interface AlunoDaLista {
  matricula: string;
  nome: string | null;
  modalidade: string;
}

interface SalaComPagina {
  linha: SalaComLista;
  pagina: ListaDePresenca;
}

/**
 * Alfabetica, com `pt-BR` para que "ÁLVARO" caia antes de "AMANDA" e nao no fim
 * da lista, como aconteceria comparando por code point. Quem nao tem nome no
 * CSV desempata pela matricula, e vai para o fim — a folha precisa de uma ordem
 * estavel mesmo quando falta o campo pelo qual se procura.
 */
export function porNome(a: AlunoDaLista, b: AlunoDaLista): number {
  if (!a.nome || !b.nome) {
    return (
      Number(Boolean(b.nome)) - Number(Boolean(a.nome)) ||
      a.matricula.localeCompare(b.matricula)
    );
  }

  return (
    a.nome.localeCompare(b.nome, 'pt-BR') ||
    a.matricula.localeCompare(b.matricula)
  );
}

/**
 * A ordem em que as folhas saem da impressora e a ordem em que sao entregues:
 * dia, horario, polo e sala. Assim a pilha ja sai separavel por campus, sem
 * ninguem reordenar folha a folha.
 *
 * Em memoria porque as paginas nao existem como linha em tabela nenhuma — sao
 * montadas cruzando ofertas com agendamentos.
 */
export function ordemDaPilha(a: SalaComLista, b: SalaComLista): number {
  return (
    a.data.getTime() - b.data.getTime() ||
    a.horaInicio.localeCompare(b.horaInicio) ||
    a.polo.localeCompare(b.polo, 'pt-BR') ||
    a.sala.localeCompare(b.sala, 'pt-BR')
  );
}

/** Dois downloads no mesmo dia nao se confundem na pasta de downloads. */
function carimboDeHora(): string {
  return new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
}
