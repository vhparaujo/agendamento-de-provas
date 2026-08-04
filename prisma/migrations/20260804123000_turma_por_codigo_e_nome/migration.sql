-- DropIndex
DROP INDEX `turma_importada_orgUnitId_idx` ON `turma_importada`;

-- AlterTable
ALTER TABLE `turma_importada` ADD COLUMN `codigoEad` VARCHAR(191) NULL,
    ADD COLUMN `curso` VARCHAR(191) NULL,
    MODIFY `orgUnitId` VARCHAR(191) NULL,
    MODIFY `nomeDisciplina` VARCHAR(191) NOT NULL,
    MODIFY `codigoTurma` VARCHAR(191) NOT NULL;

-- CreateIndex
CREATE INDEX `turma_importada_codigoTurma_idx` ON `turma_importada`(`codigoTurma`);

-- CreateIndex
CREATE UNIQUE INDEX `turma_importada_codigoTurma_nomeDisciplina_key` ON `turma_importada`(`codigoTurma`, `nomeDisciplina`);

