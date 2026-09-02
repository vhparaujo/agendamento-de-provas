-- DUAS GRADES NO MESMO ANO: o periodo letivo passa a ser um mapa por modalidade.
--
-- A UCB divide o ano de duas formas AO MESMO TEMPO. EaD, Semipresencial e
-- Modular andam por MODULO — quatro por ano, 2026/1 a 2026/4. Presencial anda
-- por SEMESTRE — dois por ano, 2026/1 e 2026/2. Em novembro de 2026 o aluno EaD
-- esta sob o org unit `2026/4` e o presencial sob `2026/2`: dois Periodos
-- Letivos DIFERENTES e vivos ao mesmo tempo no Brightspace.
--
-- Como as disciplinas agendaveis saem dos descendentes desse org unit
-- (`ofertasDoPeriodo`), a janela com um `periodoLetivoId` unico obriga a
-- escolher uma das duas grades — e a outra metade da universidade fica sem
-- disciplina nenhuma. Pior: sem ERRO nenhum. O id que nao bate devolve 200 com
-- lista vazia, e todo aluno daquela modalidade recebe a mesma frase generica
-- ("nenhuma disciplina sua aparece no periodo letivo vigente"), sem nada ligando
-- o sintoma a causa. E o mesmo risco que fez o campo virar dropdown fechado.
--
-- POR QUE UMA TABELA, e nao uma segunda coluna no `periodo_agendamento`: duas
-- colunas embutiriam no schema a suposicao de que existem exatamente duas
-- grades E de que o banco sabe qual modalidade cai em qual. Quem sabe disso e a
-- secretaria, no cadastro. Uma linha por modalidade tambem faz o mapa APARECER
-- na tela do admin — que e o unico jeito de um id errado deixar de ser invisivel.
--
-- A `rodada` NAO entra no mapa, de proposito: as duas rodadas do mesmo periodo
-- cobrem as mesmas materias (e o que ja justifica `disciplinas-do-aluno` filtrar
-- so pelo `periodoLetivoId`). O mapa e da JANELA, nao da prova.

-- CreateTable
CREATE TABLE `periodo_letivo_modalidade` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `periodoAgendamentoId` INTEGER NOT NULL,
    `modalidadeId` INTEGER NOT NULL,
    `periodoLetivoId` VARCHAR(191) NOT NULL,

    INDEX `periodo_letivo_modalidade_modalidadeId_idx`(`modalidadeId`),
    INDEX `periodo_letivo_modalidade_periodoLetivoId_idx`(`periodoLetivoId`),
    -- Uma modalidade nao pode ter dois periodos letivos na mesma janela: seria
    -- impossivel dizer qual das duas arvores vale para o aluno.
    UNIQUE INDEX `periodo_letivo_modalidade_periodoAgendamentoId_modalidadeId_key`(`periodoAgendamentoId`, `modalidadeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
-- ON DELETE CASCADE: o mapa nao tem vida propria fora da janela, e
-- `DELETE /periodos/:id` existe justamente para desfazer um cadastro errado.
ALTER TABLE `periodo_letivo_modalidade` ADD CONSTRAINT `periodo_letivo_modalidade_periodoAgendamentoId_fkey` FOREIGN KEY (`periodoAgendamentoId`) REFERENCES `periodo_agendamento`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `periodo_letivo_modalidade` ADD CONSTRAINT `periodo_letivo_modalidade_modalidadeId_fkey` FOREIGN KEY (`modalidadeId`) REFERENCES `modalidade`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- BACKFILL: toda janela ja cadastrada ganha o mapa COMPLETO apontando para o
-- mesmo id que ela ja tinha.
--
-- E o mesmo cuidado da migration da `rodada`, que deu "N2" a tudo que existia:
-- quem tem um periodo cadastrado hoje continua se comportando EXATAMENTE como
-- antes, sem nenhuma acao manual. O produto cartesiano e o estado correto porque
-- ate agora as quatro modalidades de fato compartilhavam um periodo letivo so —
-- a mudanca e passar a PODER separa-las, nao separa-las retroativamente.
INSERT INTO `periodo_letivo_modalidade` (`periodoAgendamentoId`, `modalidadeId`, `periodoLetivoId`)
SELECT `p`.`id`, `m`.`id`, `p`.`periodoLetivoId`
FROM `periodo_agendamento` `p`
CROSS JOIN `modalidade` `m`;
