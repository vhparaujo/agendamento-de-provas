-- RENOMEAR TURMA: o admin pode trocar o nome da disciplina pela tela. O nome
-- original da planilha fica guardado para a reimportacao reconhecer a turma
-- renomeada em vez de criar outra. Null = nunca renomeada.
ALTER TABLE `turma_importada`
    ADD COLUMN `nomeNaPlanilha` VARCHAR(191) NULL;
