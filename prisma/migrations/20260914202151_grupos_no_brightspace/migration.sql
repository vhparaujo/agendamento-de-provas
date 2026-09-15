-- GRUPOS NO BRIGHTSPACE: criar categorias e grupos, e inscrever os alunos,
-- pela Valence — em vez do import manual dos CSVs de /relatorios/grupos-d2l.
--
-- Aditiva: duas tabelas novas, nenhuma coluna existente muda. Os NOMES dos
-- grupos continuam em `grupo_da_janela` (a grade dia x janela que o disparo do
-- quiz ja usa); estas tabelas guardam so as EXECUCOES dos dois botoes e o que
-- cada uma fez em cada turma.
--
-- Uma tabela para os dois tipos (CRIAR_GRUPOS e INSCREVER_ALUNOS) de proposito:
-- "ha lote rodando?" precisa enxergar os dois, e os dois batem no mesmo tenant.

-- CreateTable
CREATE TABLE `execucao_grupos_d2l` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `tipo` ENUM('CRIAR_GRUPOS', 'INSCREVER_ALUNOS') NOT NULL,
    `status` ENUM('EM_ANDAMENTO', 'CONCLUIDA', 'FALHOU') NOT NULL DEFAULT 'EM_ANDAMENTO',
    `simulacao` BOOLEAN NOT NULL DEFAULT true,
    `periodoLetivoIds` VARCHAR(500) NOT NULL,
    `rodada` VARCHAR(191) NOT NULL,
    `de` DATE NOT NULL,
    `ate` DATE NOT NULL,
    `iniciadoPor` VARCHAR(191) NOT NULL,
    `assinatura` VARCHAR(64) NULL,
    `totalTurmas` INTEGER NOT NULL DEFAULT 0,
    `turmasProcessadas` INTEGER NOT NULL DEFAULT 0,
    `categoriasCriadas` INTEGER NOT NULL DEFAULT 0,
    `gruposCriados` INTEGER NOT NULL DEFAULT 0,
    `gruposRenomeados` INTEGER NOT NULL DEFAULT 0,
    `inscricoes` INTEGER NOT NULL DEFAULT 0,
    `remocoes` INTEGER NOT NULL DEFAULT 0,
    `jaInscritos` INTEGER NOT NULL DEFAULT 0,
    `pendencias` INTEGER NOT NULL DEFAULT 0,
    `erro` TEXT NULL,
    `iniciadoEm` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `concluidoEm` DATETIME(3) NULL,
    `atualizadoEm` DATETIME(3) NOT NULL,

    INDEX `execucao_grupos_d2l_status_idx`(`status`),
    INDEX `execucao_grupos_d2l_tipo_status_idx`(`tipo`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `item_grupos_d2l` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `execucaoId` INTEGER NOT NULL,
    `orgUnitId` VARCHAR(191) NOT NULL,
    `codigoTurma` VARCHAR(191) NULL,
    `nomeDisciplina` VARCHAR(191) NULL,
    `nomeGrupo` VARCHAR(200) NULL,
    `matricula` VARCHAR(191) NULL,
    `userIdD2L` VARCHAR(191) NULL,
    `resultado` ENUM('CATEGORIA_CRIADA', 'GRUPO_CRIADO', 'GRUPO_RENOMEADO', 'ALUNO_INSCRITO', 'ALUNO_REMOVIDO', 'GRUPO_SOBRANDO', 'TURMA_AMBIGUA', 'CATEGORIA_AUSENTE', 'CATEGORIA_DUPLICADA', 'CATEGORIA_EM_PROCESSAMENTO', 'GRUPO_NAO_ENCONTRADO', 'HORARIO_SEM_JANELA', 'SEM_GRUPO_NO_DIA', 'ALUNO_DE_OUTRA_MODALIDADE', 'USER_ID_INVALIDO', 'ALUNO_NAO_ENCONTRADO', 'CONFLITO_NO_GRUPO', 'FALHA_NA_API') NOT NULL,
    `detalhe` TEXT NULL,

    INDEX `item_grupos_d2l_execucaoId_resultado_idx`(`execucaoId`, `resultado`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `item_grupos_d2l` ADD CONSTRAINT `item_grupos_d2l_execucaoId_fkey` FOREIGN KEY (`execucaoId`) REFERENCES `execucao_grupos_d2l`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
