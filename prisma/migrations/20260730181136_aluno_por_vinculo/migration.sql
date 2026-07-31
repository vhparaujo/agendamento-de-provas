-- DropIndex
DROP INDEX `aluno_importado_matricula_key` ON `aluno_importado`;

-- AlterTable
ALTER TABLE `aluno_importado` MODIFY `curso` VARCHAR(191) NOT NULL;

-- CreateIndex
CREATE INDEX `aluno_importado_matricula_idx` ON `aluno_importado`(`matricula`);

-- CreateIndex
CREATE UNIQUE INDEX `aluno_importado_matricula_curso_key` ON `aluno_importado`(`matricula`, `curso`);

