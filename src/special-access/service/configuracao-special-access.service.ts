import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AuditoriaService } from '../../seguranca/service/auditoria.service';

/** `TimeLimitValue` aceito pela Valence: 0 a 9999 minutos. */
export const TEMPO_MAXIMO_DA_VALENCE = 9999;

/** O que vale enquanto ninguem salvou a configuracao. */
export const TEMPO_EXTRA_NIOP_PADRAO = 60;

export interface TempoDaModalidade {
  id: number;
  codigo: string;
  nome: string;
  /** O tamanho da faixa que aceita o formato — so leitura aqui. */
  duracaoMinutos: number;
  /** O tempo do questionario no special access. */
  tempoDeProvaMinutos: number;
}

export interface ConfiguracaoDoSpecialAccess {
  tempoExtraNiopMinutos: number;
  substituiJanelas: boolean;
  modalidades: TempoDaModalidade[];
  atualizadoPor: string | null;
  atualizadoEm: Date | null;
}

export interface ConfiguracaoParaSalvar {
  tempoExtraNiopMinutos: number;
  substituiJanelas: boolean;
  modalidades: { id: number; tempoDeProvaMinutos: number }[];
}

/**
 * O que o admin escolhe do special access: o tempo de prova de cada formato,
 * a hora a mais do NIOP e se o special access SUBSTITUI a troca de datas.
 *
 * No banco, e nao no `.env`, pelo motivo de `ConfiguracaoSenhaQuiz`: muda por
 * semestre, e quem sabe e a administracao, que nao faz deploy.
 *
 * Os valores valem no PROXIMO lote: nada aqui reescreve o que ja foi gravado no
 * Brightspace. Mudar o tempo depois de gravar pede rodar o lote de novo — e ele
 * atualiza so quem mudou.
 */
@Injectable()
export class ConfiguracaoSpecialAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
  ) {}

  async ler(): Promise<ConfiguracaoDoSpecialAccess> {
    const [gravada, modalidades] = await Promise.all([
      this.prisma.configuracaoSpecialAccess.findUnique({ where: { id: 1 } }),
      this.prisma.modalidade.findMany({
        orderBy: { id: 'asc' },
        select: {
          id: true,
          codigo: true,
          nome: true,
          duracaoMinutos: true,
          tempoDeProvaMinutos: true,
        },
      }),
    ]);

    return {
      tempoExtraNiopMinutos:
        gravada?.tempoExtraNiopMinutos ?? TEMPO_EXTRA_NIOP_PADRAO,
      substituiJanelas: gravada?.substituiJanelas ?? false,
      modalidades,
      atualizadoPor: gravada?.atualizadoPor ?? null,
      atualizadoEm: gravada?.atualizadoEm ?? null,
    };
  }

  async salvar(
    dados: ConfiguracaoParaSalvar,
    adminEmail: string,
  ): Promise<ConfiguracaoDoSpecialAccess> {
    const antes = await this.ler();
    const existentes = new Map(antes.modalidades.map((m) => [m.id, m]));
    const vistas = new Set<number>();

    for (const modalidade of dados.modalidades) {
      const atual = existentes.get(modalidade.id);

      if (!atual) {
        throw new BadRequestException(`O formato ${modalidade.id} não existe.`);
      }

      if (vistas.has(modalidade.id)) {
        throw new BadRequestException(
          `O formato ${atual.nome} veio duas vezes.`,
        );
      }
      vistas.add(modalidade.id);

      // A soma e o que vai no special access do NIOP; passar do teto da Valence
      // faria cada PUT desses alunos voltar 400 no meio do lote.
      if (
        modalidade.tempoDeProvaMinutos + dados.tempoExtraNiopMinutos >
        TEMPO_MAXIMO_DA_VALENCE
      ) {
        throw new BadRequestException(
          `${atual.nome}: tempo de prova + tempo extra do NIOP passa de ` +
            `${TEMPO_MAXIMO_DA_VALENCE} minutos, o máximo que o AVA aceita.`,
        );
      }
    }

    await this.prisma.$transaction([
      this.prisma.configuracaoSpecialAccess.upsert({
        where: { id: 1 },
        create: {
          id: 1,
          tempoExtraNiopMinutos: dados.tempoExtraNiopMinutos,
          substituiJanelas: dados.substituiJanelas,
          atualizadoPor: adminEmail,
        },
        update: {
          tempoExtraNiopMinutos: dados.tempoExtraNiopMinutos,
          substituiJanelas: dados.substituiJanelas,
          atualizadoPor: adminEmail,
        },
      }),
      ...dados.modalidades.map((m) =>
        this.prisma.modalidade.update({
          where: { id: m.id },
          data: { tempoDeProvaMinutos: m.tempoDeProvaMinutos },
        }),
      ),
    ]);

    const mudancas = [
      antes.tempoExtraNiopMinutos !== dados.tempoExtraNiopMinutos &&
        `extra NIOP ${antes.tempoExtraNiopMinutos} -> ${dados.tempoExtraNiopMinutos} min`,
      antes.substituiJanelas !== dados.substituiJanelas &&
        `substitui janelas ${antes.substituiJanelas} -> ${dados.substituiJanelas}`,
      ...dados.modalidades.map((m) => {
        const atual = existentes.get(m.id)!;
        return (
          atual.tempoDeProvaMinutos !== m.tempoDeProvaMinutos &&
          `${atual.codigo} ${atual.tempoDeProvaMinutos} -> ${m.tempoDeProvaMinutos} min`
        );
      }),
    ].filter((m): m is string => typeof m === 'string');

    if (mudancas.length > 0) {
      this.auditoria.registrar('SPECIAL_ACCESS_CONFIGURACAO_ALTERADA', {
        ator: adminEmail,
        detalhe: mudancas.join('; '),
      });
    }

    return this.ler();
  }
}
