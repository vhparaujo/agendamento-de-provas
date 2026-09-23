-- O PERIODO DOS DISPAROS PASSA A SER ESCOLHIDO, e nao mais "o mais recente".
--
-- Ate aqui senhas, datas, grupos e acesso especial recortavam pela janela
-- VIGENTE, que e a cadastrada por ultimo. Cadastrar o proximo periodo com
-- antecedencia (ou por teste) mudava na hora as turmas e os alunos de todos os
-- disparos, inclusive os do cron.
--
-- NULO = continua o vigente, entao nada muda para quem nao escolher.
ALTER TABLE `configuracao_senha_quiz`
    ADD COLUMN `periodoDosDisparosId` INTEGER NULL,
    ADD COLUMN `periodoDosDisparosPor` VARCHAR(191) NULL,
    ADD COLUMN `periodoDosDisparosEm` DATETIME(3) NULL;

CREATE INDEX `configuracao_senha_quiz_periodoDosDisparosId_idx`
    ON `configuracao_senha_quiz`(`periodoDosDisparosId`);

-- RESTRICT: apagar o periodo escolhido nao pode voltar os disparos ao vigente
-- em silencio. A API recusa antes, com mensagem; a FK e a garantia.
ALTER TABLE `configuracao_senha_quiz` ADD CONSTRAINT `configuracao_senha_quiz_periodoDosDisparosId_fkey`
    FOREIGN KEY (`periodoDosDisparosId`) REFERENCES `periodo_agendamento`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;
