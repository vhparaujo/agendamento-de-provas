-- ID DA TURMA-DISCIPLINA: coluna opcional do CSV de turmas, exposta na API de
-- integracao para o outro sistema identificar a turma. Null = o CSV nao trouxe.
ALTER TABLE `turma_importada`
    ADD COLUMN `idTurmaDisc` VARCHAR(191) NULL;
