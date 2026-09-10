-- O DESEMPATE DA TURMA AMBIGUA: a modalidade que o admin decidiu.
--
-- O lote de datas precisa de UMA modalidade por turma, derivada dos
-- agendamentos confirmados. Turma com alunos de DUAS modalidades nao deriva
-- nada, de proposito: o questionario tem uma janela so, e escolher a maioria
-- trancaria a prova da minoria.
--
-- So que "nada" tranca todo mundo. Em 10/09/2026 uma turma real apareceu na
-- conferencia com EAD (583) e MODULAR (1): a data e o grupo nao seriam
-- aplicados para nenhum dos 584, e a tela nao oferecia saida nenhuma.
--
-- Esta tabela e a saida, e NAO afrouxa a regra "nada e chutado" — o sistema
-- continua sem escolher. Quem escolhe e uma pessoa, e a escolha fica com nome
-- e hora.
--
-- A linha so vale enquanto a turma continuar ambigua: a checagem acontece em
-- toda LEITURA (`modalidade-da-turma.service.ts`), nunca na gravacao. Se a
-- turma voltar a ter uma modalidade so, a derivacao vence; se a modalidade
-- escolhida ficar sem reserva nenhuma ali, a linha e ignorada e a turma volta
-- a aparecer como ambigua na conferencia.
--
-- POR QUE NAO E COLUNA EM `turma_importada`: pelo mesmo motivo que fez a
-- migration `turma_sem_curso` (10/08/2026) REMOVER `curso` de la — uma turma
-- tem alunos de varios cursos, e dizer que ela "e" de um e falso. O que existe
-- aqui e uma decisao operacional de UMA rodada, com autor e data. Alem disso o
-- CSV de turmas e reimportado, e o upsert apagaria a decisao em silencio.
--
-- O recorte e `orgUnitId` + `rodada`. O periodo letivo nao entra porque o
-- `orgUnitId` ja o carrega (outra oferta, outro id); a `rodada` entra porque a
-- N2 e a SUB do mesmo semestre COMPARTILHAM o org unit.

-- CreateTable
CREATE TABLE `modalidade_escolhida_turma` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `orgUnitId` VARCHAR(191) NOT NULL,
    `rodada` VARCHAR(191) NOT NULL,
    `modalidadeId` INTEGER NOT NULL,
    -- Desnormalizado, como em `item_senha_quiz`: a pergunta que se faz sobre
    -- esta tabela e "quem decidiu o que?", e ela precisa de resposta legivel
    -- mesmo que a turma saia do CSV do semestre seguinte.
    `codigoTurma` VARCHAR(191) NULL,
    -- Fotografia do e-mail, como `senha_de_prova.atualizadoPor`. NAO e FK: o
    -- admin pode ser desativado depois, e a decisao continua tendo dono.
    `escolhidaPor` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `modalidade_escolhida_turma_modalidadeId_idx`(`modalidadeId`),
    -- Uma decisao por turma em cada rodada: duas seriam duas janelas para um
    -- questionario que so tem uma. Trocar a escolha e um upsert nesta chave.
    UNIQUE INDEX `modalidade_escolhida_turma_orgUnitId_rodada_key`(`orgUnitId`, `rodada`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
-- RESTRICT, e nao CASCADE: apagar uma modalidade com decisao pendente deve
-- doer. A alternativa silenciosa seria a turma voltar a ser ambigua as vesperas
-- da prova sem ninguem saber por que.
ALTER TABLE `modalidade_escolhida_turma` ADD CONSTRAINT `modalidade_escolhida_turma_modalidadeId_fkey` FOREIGN KEY (`modalidadeId`) REFERENCES `modalidade`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
