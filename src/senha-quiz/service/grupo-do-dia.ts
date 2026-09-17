/**
 * ============================================================================
 * QUAL GRUPO UMA JANELA APLICA NUM DIA
 * ============================================================================
 * Desde 14/09/2026 o grupo tem duas fontes: a GRADE DE GRUPOS (dia x janela) e
 * o nome fixo da propria janela, que ficou como padrao. A decisao entre elas
 * mora aqui, e so aqui — o lote e o cron a consultam pelo mesmo caminho
 * (`GradeGruposService.doDia`), senao a tela, o disparo manual e o automatico
 * poderiam discordar sobre o grupo de um mesmo dia.
 *
 *   | celula do dia | nome fixo | janela ja usou a grade | resultado        |
 *   |---------------|-----------|------------------------|------------------|
 *   | sim           | —         | —                      | GRADE            |
 *   | nao           | sim       | —                      | JANELA           |
 *   | nao           | nao       | sim                    | SEM_GRUPO_NO_DIA |
 *   | nao           | nao       | nao                    | NAO_TROCA        |
 *
 * ⚠️ A terceira linha e a razao deste arquivo ter teste. Um dia esquecido na
 * grade NAO pode virar "esta janela nao troca grupo": a condicao continuaria
 * apontando para o grupo da sessao anterior, e a execucao sairia verde. Por isso
 * ela vira pendencia em cada questionario — o mesmo peso de GRUPO_NAO_ENCONTRADO.
 *
 * A quarta linha preserva o opt-in de 26/08/2026: formato que nunca cadastrou
 * grupo (o Presencial, hoje) continua sem efeito colateral nenhum.
 */

export type OrigemDoGrupo =
  'GRADE' | 'JANELA' | 'SEM_GRUPO_NO_DIA' | 'NAO_TROCA';

export interface GrupoDoDia {
  origem: OrigemDoGrupo;
  /** Nulo em `SEM_GRUPO_NO_DIA` e `NAO_TROCA`: nao ha nome a procurar. */
  nome: string | null;
  categoria: string | null;
  /**
   * A celula e a versao dela — so em `GRADE`. Entram na idempotencia: sao o que
   * libera um novo disparo HOJE quando o grupo do dia e corrigido.
   */
  celulaId: number | null;
  versao: number | null;
}

export function escolherGrupoDoDia(entrada: {
  celula: {
    id: number;
    nomeGrupo: string;
    categoriaGrupo: string | null;
    versao: number;
  } | null;
  janela: { nomeGrupo: string | null; categoriaGrupo: string | null };
  janelaUsaGrade: boolean;
}): GrupoDoDia {
  const { celula, janela, janelaUsaGrade } = entrada;

  // O `trim` e defesa, nao regra: o servico nunca grava nome vazio. Mas um
  // UPDATE manual no banco com "  " faria a resolucao procurar um grupo sem
  // nome em cada turma — melhor cair no padrao.
  const daCelula = celula?.nomeGrupo.trim();
  const fixo = janela.nomeGrupo?.trim();
  const categoriaDaJanela = janela.categoriaGrupo?.trim() || null;

  if (celula && daCelula) {
    return {
      origem: 'GRADE',
      nome: daCelula,
      // Celula sem categoria usa a da janela: a categoria quase nunca muda de
      // um dia para o outro, e obrigar a digita-la em toda celula so criaria
      // chance de erro de digitacao.
      categoria: celula.categoriaGrupo?.trim() || categoriaDaJanela,
      celulaId: celula.id,
      versao: celula.versao,
    };
  }

  if (fixo) {
    return {
      origem: 'JANELA',
      nome: fixo,
      categoria: categoriaDaJanela,
      celulaId: null,
      versao: null,
    };
  }

  return {
    origem: janelaUsaGrade ? 'SEM_GRUPO_NO_DIA' : 'NAO_TROCA',
    nome: null,
    categoria: null,
    celulaId: null,
    versao: null,
  };
}
