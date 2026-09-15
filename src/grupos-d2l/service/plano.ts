import { normalizarNomeDeGrupo } from '../../senha-quiz/service/grupo';

/**
 * ============================================================================
 * O QUE ESCREVER NO BRIGHTSPACE — a diferenca entre o desejado e o que existe
 * ============================================================================
 * Puro e testado. O lote le a turma (categorias, grupos e inscritos) e pergunta
 * aqui o que falta; so o que sai daqui vira requisicao de escrita. E isso que
 * faz rodar de novo custar so as leituras.
 *
 * Os nomes sao comparados normalizados (acento, caixa, espaco), com a MESMA
 * funcao que a troca de condicao do quiz usa para achar o grupo — se as duas
 * discordassem, o lote criaria "Prova 1" ao lado de um "prova 1" que o disparo
 * ja encontrava.
 */

/** `GroupData` na forma Fetch, ja com ids numericos. */
export interface GrupoLido {
  GroupId: number;
  Name: string;
  /** UserIds inscritos explicitamente. */
  Enrollments: number[];
}

export interface PlanoDeGrupos {
  /** Nomes que precisam de POST. */
  criar: string[];
  /** Grupos vazios fora da lista, reaproveitados para nomes que faltavam. */
  renomear: { GroupId: number; de: string; para: string }[];
  /** Fora da lista e COM alunos: nunca tocados, so relatados. */
  sobrando: GrupoLido[];
}

/**
 * Quais grupos criar numa categoria.
 *
 * ⚠️ **Grupo vazio fora da lista e reaproveitado antes de criar outro.** Cobre
 * dois casos reais com uma regra so:
 *  - a D2L so cria categoria do tipo "numero de grupos" JA com grupos genericos
 *    dentro; renomea-los e o que evita deixar "Grupo 1..6" orfaos na turma;
 *  - o admin corrigiu um nome digitado errado: o grupo antigo, ainda vazio, vira
 *    o novo, em vez de ficar sobrando em 150 turmas.
 *
 * Grupo com aluno NUNCA e renomeado: pode ser o grupo de uma prova que ja
 * aconteceu, com a condicao do quiz apontando para ele.
 */
export function planejarGrupos(
  desejados: readonly string[],
  existentes: readonly GrupoLido[],
): PlanoDeGrupos {
  const jaExistem = new Set(
    existentes.map((g) => normalizarNomeDeGrupo(g.Name)),
  );
  const desejadosNormalizados = new Set<string>();
  const faltando: string[] = [];

  for (const nome of desejados) {
    const chave = normalizarNomeDeGrupo(nome);
    if (!chave || desejadosNormalizados.has(chave)) continue;

    desejadosNormalizados.add(chave);
    if (!jaExistem.has(chave)) faltando.push(nome);
  }

  // Ordem por id: e a ordem em que a D2L criou os genericos, entao "Grupo 1"
  // vira o primeiro nome da lista — o relatorio fica legivel.
  const foraDaLista = existentes
    .filter((g) => !desejadosNormalizados.has(normalizarNomeDeGrupo(g.Name)))
    .sort((a, b) => a.GroupId - b.GroupId);

  const vazios = foraDaLista.filter((g) => g.Enrollments.length === 0);
  const aRenomear = Math.min(vazios.length, faltando.length);

  return {
    renomear: faltando.slice(0, aRenomear).map((para, i) => ({
      GroupId: vazios[i].GroupId,
      de: vazios[i].Name,
      para,
    })),
    criar: faltando.slice(aRenomear),
    sobrando: foraDaLista.filter((g) => g.Enrollments.length > 0),
  };
}

export interface EntradaDeInscricoes {
  /** Os grupos da categoria do bloco, com os inscritos. */
  grupos: readonly GrupoLido[];
  /** UserId -> nomes dos grupos em que ele DEVE estar. */
  desejado: ReadonlyMap<number, ReadonlySet<string>>;
  /**
   * Quem o lote pode TIRAR de um grupo: tem reserva nesta turma e todas elas
   * foram resolvidas para um grupo (ou foram canceladas).
   */
  removiveis: ReadonlySet<number>;
}

export interface MovimentoDeAluno {
  GroupId: number;
  nomeGrupo: string;
  userId: number;
}

export interface PlanoDeInscricoes {
  adicionar: MovimentoDeAluno[];
  remover: MovimentoDeAluno[];
  /** O grupo desejado nao existe na categoria — ou existe duas vezes. */
  semGrupo: { userId: number; nomeGrupo: string; duplicado: boolean }[];
  jaInscritos: number;
}

/**
 * Quem entra e quem sai de cada grupo.
 *
 * As tres travas da remocao, e o que cada uma evita:
 *
 * 1. **So sai quem esta em `removiveis`.** Um usuario que o portal nao conhece
 *    (tutor, aluno que a secretaria colocou a mao) nunca e tocado.
 * 2. **Quem tem pendencia de resolucao nao esta em `removiveis`.** Sem a celula
 *    do dia, o desejado dele sai vazio — e tira-lo do grupo atual trocaria "grupo
 *    possivelmente certo" por "grupo nenhum".
 * 3. **Quem tem grupo desejado que nao existe nao sai de lugar nenhum.** Mesmo
 *    raciocinio: a pendencia `GRUPO_NAO_ENCONTRADO` pede acao, e ate la o grupo
 *    antigo e melhor que nada.
 *
 * Nome duplicado na categoria e tratado como ausente: escolher um no chute
 * poria o aluno num grupo que a condicao do quiz talvez nao aponte.
 */
export function planejarInscricoes({
  grupos,
  desejado,
  removiveis,
}: EntradaDeInscricoes): PlanoDeInscricoes {
  const porNome = new Map<string, GrupoLido[]>();

  for (const grupo of grupos) {
    const chave = normalizarNomeDeGrupo(grupo.Name);
    porNome.set(chave, [...(porNome.get(chave) ?? []), grupo]);
  }

  const plano: PlanoDeInscricoes = {
    adicionar: [],
    remover: [],
    semGrupo: [],
    jaInscritos: 0,
  };

  const alvos = new Map<number, Set<number>>();
  const travados = new Set<number>();

  for (const [userId, nomes] of desejado) {
    const vistos = new Set<string>();

    for (const nome of nomes) {
      const chave = normalizarNomeDeGrupo(nome);
      if (vistos.has(chave)) continue;
      vistos.add(chave);

      const achados = porNome.get(chave) ?? [];

      if (achados.length !== 1) {
        plano.semGrupo.push({
          userId,
          nomeGrupo: nome,
          duplicado: achados.length > 1,
        });
        travados.add(userId);
        continue;
      }

      const [grupo] = achados;
      alvos.set(userId, (alvos.get(userId) ?? new Set()).add(grupo.GroupId));

      if (grupo.Enrollments.includes(userId)) {
        plano.jaInscritos += 1;
      } else {
        plano.adicionar.push({
          GroupId: grupo.GroupId,
          nomeGrupo: grupo.Name,
          userId,
        });
      }
    }
  }

  for (const grupo of grupos) {
    for (const userId of new Set(grupo.Enrollments)) {
      if (!removiveis.has(userId) || travados.has(userId)) continue;
      if (alvos.get(userId)?.has(grupo.GroupId)) continue;

      plano.remover.push({
        GroupId: grupo.GroupId,
        nomeGrupo: grupo.Name,
        userId,
      });
    }
  }

  return plano;
}
