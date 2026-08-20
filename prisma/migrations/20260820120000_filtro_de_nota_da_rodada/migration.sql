-- QUEM PODE FAZER A SUBSTITUTIVA: a faixa de nota da rodada.
--
-- A `rodada` (migration anterior) deu ao semestre duas janelas — a regular e a
-- substitutiva —, mas as duas ofereciam ao aluno EXATAMENTE as mesmas
-- disciplinas: o cruzamento de `disciplinas-do-aluno` filtra so pelo
-- `periodoLetivoId`, porque "as duas rodadas cobrem as mesmas materias". Aberta
-- a janela da SUB, a substitutiva ficaria liberada para todo mundo — inclusive
-- para quem ja passou e para quem ja reprovou por nota.
--
-- A regra do cliente e POR DISCIPLINA, nao por aluno: ele agenda a substitutiva
-- das materias em que a nota final esta em [1,5 ; 6,75). Um aluno com tres
-- materias pode ter uma elegivel e duas nao, e a prova dele cobre so a elegivel.
--
-- O gatilho e o PAR de colunas abaixo estar preenchido, e NUNCA `rodada = 'SUB'`:
-- `rodada` e texto livre (quem a nomeia e a secretaria), entao comparar a string
-- faria a regra parar de valer no dia em que alguem cadastrasse "Substitutiva".
-- Nulos = sem filtro, que e o comportamento de hoje e o de toda janela ja
-- cadastrada — por isso as colunas nascem NULL e nenhum periodo muda de
-- comportamento com esta migration.

ALTER TABLE `periodo_agendamento`
    ADD COLUMN `notaMinima` DECIMAL(5, 2) NULL,
    ADD COLUMN `notaMaxima` DECIMAL(5, 2) NULL;

-- A nota que decidiu a reserva, gravada por disciplina.
--
-- FOTOGRAFIA, como `rodada` no agendamento: a nota no Brightspace pode mudar
-- depois (o professor lanca uma pendencia, ajusta a final), e sem esta coluna a
-- unica resposta para "por que ele agendou substitutiva desta materia?" seria
-- consultar a Valence de novo e ver um numero que talvez ja nao seja o que
-- decidiu a reserva. Fica NULA na N2, em que nota nenhuma foi consultada — e por
-- isso nao ha backfill: as reservas que existem hoje sao todas da prova regular.
ALTER TABLE `agendamento_disciplina`
    ADD COLUMN `notaFinal` DECIMAL(5, 2) NULL;

-- Motivo novo no relatorio do compulsorio.
--
-- Separado de `SEM_DISCIPLINA_AGENDAVEL` de proposito: aquele motivo e uma fila
-- de trabalho — manda a secretaria conferir o CSV de turmas. Quem nao entra na
-- substitutiva porque passou de ano nao tem nada para conferir, e misturar os
-- dois encheria a fila de linhas que ninguem deve tratar.
ALTER TABLE `excecao_compulsorio`
    MODIFY COLUMN `motivo` ENUM(
        'SEM_CONTA_D2L',
        'MATRICULA_AMBIGUA',
        'ID_INVALIDO_D2L',
        'SEM_DISCIPLINA_AGENDAVEL',
        'NAO_ELEGIVEL_PELA_NOTA',
        'SEM_FAIXA_NO_POLO',
        'SEM_VAGA',
        'CANCELOU_E_NAO_REMARCOU',
        'FALHA_NA_INTEGRACAO',
        'AVISO_CONTA_INATIVA_D2L'
    ) NOT NULL;
