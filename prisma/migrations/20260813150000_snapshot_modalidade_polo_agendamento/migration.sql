-- Fotografia da modalidade e do polo DO ALUNO no momento da reserva.
--
-- `aluno_importado` e tabela de estado atual: cada importacao de CSV sobrescreve
-- modalidade e polo do vinculo, e nao existe versao anterior. A exportacao lia
-- essas duas colunas de la, entao um semestre passado saia com a modalidade de
-- HOJE ao lado da data e da sala corretas.
--
-- O backfill NAO e aproximado. A modalidade e o polo da reserva podem ser
-- reconstruidos exatamente a partir da oferta em que o aluno foi alocado:
--   - `sala_faixa.modalidadeId` — a alocacao so aceita oferta da modalidade do
--     aluno, e o remanejo recusa trocar de modalidade;
--   - `faixa.poloId` — o portal recusa faixa de outro polo, e o remanejo recusa
--     trocar de campus.
-- Ou seja: os dois valores JA ESTAVAM gravados na reserva, so que indiretamente.
-- Esta migration apenas os materializa.

-- Nullable primeiro: a tabela tem linhas, e NOT NULL sem default as recusaria.
ALTER TABLE `agendamento`
    ADD COLUMN `modalidadeId` INTEGER NULL,
    ADD COLUMN `poloId` INTEGER NULL;

UPDATE `agendamento` `a`
    JOIN `sala_faixa` `sf` ON `sf`.`id` = `a`.`salaFaixaId`
    JOIN `faixa` `f` ON `f`.`id` = `sf`.`faixaId`
SET `a`.`modalidadeId` = `sf`.`modalidadeId`,
    `a`.`poloId` = `f`.`poloId`;

-- Se algum agendamento ficasse sem valor aqui, o ALTER abaixo falharia e a
-- migration inteira seria revertida — que e o comportamento desejado: preencher
-- com um valor inventado silenciaria justamente o dado que a coluna existe para
-- preservar.
ALTER TABLE `agendamento`
    MODIFY COLUMN `modalidadeId` INTEGER NOT NULL,
    MODIFY COLUMN `poloId` INTEGER NOT NULL;

CREATE INDEX `agendamento_modalidadeId_idx` ON `agendamento`(`modalidadeId`);
CREATE INDEX `agendamento_poloId_idx` ON `agendamento`(`poloId`);

ALTER TABLE `agendamento`
    ADD CONSTRAINT `agendamento_modalidadeId_fkey`
    FOREIGN KEY (`modalidadeId`) REFERENCES `modalidade`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `agendamento`
    ADD CONSTRAINT `agendamento_poloId_fkey`
    FOREIGN KEY (`poloId`) REFERENCES `polo`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;
