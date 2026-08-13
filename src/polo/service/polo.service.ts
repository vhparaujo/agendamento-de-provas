import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

export interface Polo {
  id: number;
  nome: string;
  cidade: string | null;
  ativo: boolean;
}

export interface PoloComContagens extends Polo {
  totalSalas: number;
  /** Faixas de qualquer data, inclusive passadas — sao elas que sustentam os
   *  agendamentos ja realizados. As tres contagens juntas dizem se o polo pode
   *  ser apagado; a tela usa isso para desabilitar o botao. */
  totalFaixas: number;
  totalAlunos: number;
}

const CONTAGENS = {
  _count: { select: { salas: true, faixas: true, alunos: true } },
} as const;

const SELECAO = {
  id: true,
  nome: true,
  cidade: true,
  ativo: true,
} as const;

@Injectable()
export class PoloService {
  constructor(private readonly prisma: PrismaService) {}

  async listar(apenasAtivos?: boolean): Promise<PoloComContagens[]> {
    const polos = await this.prisma.polo.findMany({
      where: apenasAtivos ? { ativo: true } : undefined,
      orderBy: { nome: 'asc' },
      include: CONTAGENS,
    });

    return polos.map(({ _count, ...polo }) => ({
      ...polo,
      totalSalas: _count.salas,
      totalFaixas: _count.faixas,
      totalAlunos: _count.alunos,
    }));
  }

  async buscar(id: number): Promise<PoloComContagens> {
    const polo = await this.prisma.polo.findUnique({
      where: { id },
      include: CONTAGENS,
    });

    if (!polo) throw new NotFoundException(`Polo ${id} nao encontrado`);

    const { _count, ...dados } = polo;

    return {
      ...dados,
      totalSalas: _count.salas,
      totalFaixas: _count.faixas,
      totalAlunos: _count.alunos,
    };
  }

  /**
   * Cadastro de polo novo. O `nome` precisa ser IDENTICO ao valor da coluna
   * CAMPUS no CSV de alunos — e por essa string que a importacao liga aluno e
   * polo. Um acento ou espaco a mais faz todos os alunos daquele campus serem
   * rejeitados no proximo upload.
   *
   * **Nome de polo INATIVO reativa em vez de conflitar.** O ciclo real e o
   * campus sair de uma oferta e voltar na seguinte; se o cadastro respondesse
   * 409 ("ja existe"), o admin ficaria sem saida — o nome esta ocupado por um
   * polo que ele nao ve na tela, e renomear nao e permitido. Reativar preserva
   * o id, e com ele as salas, as faixas passadas e os alunos ja importados.
   */
  async criar(dados: { nome: string; cidade?: string }): Promise<Polo> {
    const nome = dados.nome.trim();
    const cidade = dados.cidade?.trim() || null;

    const jaExiste = await this.prisma.polo.findUnique({ where: { nome } });

    if (jaExiste?.ativo) {
      throw new ConflictException(`Ja existe um polo chamado "${nome}"`);
    }

    if (jaExiste) {
      return this.prisma.polo.update({
        where: { id: jaExiste.id },
        // cidade so e sobrescrita se veio no corpo: quem esta reativando pode
        // nao saber a cidade e nao deve apaga-la sem querer.
        data: { ativo: true, ...(cidade ? { cidade } : {}) },
        select: SELECAO,
      });
    }

    return this.prisma.polo.create({
      data: { nome, cidade },
      select: SELECAO,
    });
  }

  /**
   * `nome` NAO e alteravel de proposito — nao ha campo para ele no DTO. Renomear
   * um polo quebraria silenciosamente o casamento com o CSV de alunos: o proximo
   * upload nao acharia mais o polo e rejeitaria o campus inteiro. Se o nome
   * estiver errado, o caminho e corrigir na origem (planilha) e criar o polo certo.
   */
  async atualizar(
    id: number,
    dados: { cidade?: string | null; ativo?: boolean },
  ): Promise<Polo> {
    await this.buscar(id);

    return this.prisma.polo.update({
      where: { id },
      data: {
        cidade:
          dados.cidade === undefined ? undefined : dados.cidade?.trim() || null,
        ativo: dados.ativo,
      },
      select: SELECAO,
    });
  }

  /**
   * So apaga polo VIRGEM — sem sala, sem faixa e sem aluno importado. O caso de
   * uso e o cadastro errado (nome com acento trocado, campus digitado duas
   * vezes), que hoje ficaria no banco para sempre porque `nome` nao e editavel.
   *
   * **Campus que sai da oferta NAO se apaga, se desativa.** Ele carrega historico
   * — os alunos importados apontam para ele, e as faixas passadas sustentam os
   * agendamentos ja realizados via SalaFaixa. Apagar exigiria arrastar tudo isso
   * junto, e a prova que o aluno fez sumiria do relatorio. Desativado, o polo
   * some do cadastro de sala e de faixa (nenhuma prova nova nasce ali) e volta
   * inteiro no `POST /polos` quando o campus voltar a ter prova.
   */
  async remover(id: number): Promise<{ mensagem: string }> {
    const polo = await this.buscar(id);
    const { totalSalas, totalFaixas, totalAlunos } = polo;

    if (totalSalas > 0 || totalFaixas > 0 || totalAlunos > 0) {
      const usos = [
        totalSalas > 0 && `${totalSalas} sala(s)`,
        totalFaixas > 0 && `${totalFaixas} faixa(s)`,
        totalAlunos > 0 && `${totalAlunos} vinculo(s) de aluno`,
      ].filter((u): u is string => typeof u === 'string');

      throw new ConflictException(
        `O polo "${polo.nome}" ja tem ${usos.join(', ')} e nao pode ser apagado. ` +
          'Desative-o (PATCH ativo=false) para que ele nao receba salas nem ' +
          'faixas novas sem perder o historico. Se o campus voltar a ter prova, ' +
          'cadastre-o de novo pelo POST /polos com o mesmo nome — ele e reativado.',
      );
    }

    await this.prisma.polo.delete({ where: { id } });

    return { mensagem: `Polo "${polo.nome}" removido` };
  }
}
