-- A GRADE DE GRUPOS: um nome de grupo por DIA e por JANELA.
--
-- REVERTE a decisao 1 de 26/08/2026 (migration `grupo_da_janela`): "o nome do
-- grupo e FIXO POR JANELA e reusado nos seis dias de prova". Na operacao real os
-- grupos de cada dia tem nomes proprios e livres, e a secretaria passou a trocar
-- `janela_de_prova.nomeGrupo` a mao todo dia — o trabalho que o disparo
-- automatico existia para tirar dela, com o risco de esquecer um dia.
--
-- Mesma forma da grade de senhas (dia x turno), com a chave dia x JANELA: em
-- Semi/Modular sao seis janelas e tres turnos, e cada SESSAO tem o seu grupo.
--
-- Aditiva: uma tabela nova, tres colunas NULL-aveis, um valor novo no fim do
-- enum de desfecho. `janela_de_prova.nomeGrupo` CONTINUA valendo como padrao dos
-- dias sem celula, entao esta migration sozinha nao muda nenhum disparo.

-- ---------------------------------------------------------------------------
-- 1. A grade
-- ---------------------------------------------------------------------------
--
-- `data` e o dia da PROVA, ja com o `diaSeguinte` resolvido — a janela das 22:01
-- de segunda le a celula de terca, como a senha.
--
-- ON DELETE CASCADE: `salvarJanelas` remove a sessao que saiu do calendario, e a
-- grade dela nao teria a que se aplicar. As execucoes historicas nao dependem
-- disto (FK SetNull + `nomeGrupoAplicado`, abaixo).
CREATE TABLE `grupo_da_janela` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `data` DATE NOT NULL,
    `janelaDeProvaId` INTEGER NOT NULL,
    `nomeGrupo` VARCHAR(200) NOT NULL,
    `categoriaGrupo` VARCHAR(200) NULL,
    `versao` INTEGER NOT NULL DEFAULT 1,
    `criadoPor` VARCHAR(191) NOT NULL,
    `atualizadoPor` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `grupo_da_janela_janelaDeProvaId_idx`(`janelaDeProvaId`),
    UNIQUE INDEX `grupo_da_janela_data_janelaDeProvaId_key`(`data`, `janelaDeProvaId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `grupo_da_janela` ADD CONSTRAINT `grupo_da_janela_janelaDeProvaId_fkey`
    FOREIGN KEY (`janelaDeProvaId`) REFERENCES `janela_de_prova`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 2. A execucao guarda QUAL celula aplicou, e o nome
-- ---------------------------------------------------------------------------
--
-- `grupoDaJanelaId` + `versaoGrupoAplicada` entram na idempotencia do lote de
-- datas. Sem elas, corrigir o grupo de hoje depois do disparo nao liberaria
-- nada: a janela nao mudou de versao, e a execucao concluida bloquearia o novo
-- disparo em silencio — o bug de 25/08/2026 num campo novo. As execucoes
-- antigas ficam com (NULL, NULL), que e exatamente a chave de um disparo sem
-- celula: a idempotencia delas continua igual.
ALTER TABLE `execucao_senha_quiz`
    ADD COLUMN `grupoDaJanelaId` INTEGER NULL,
    ADD COLUMN `versaoGrupoAplicada` INTEGER NULL,
    ADD COLUMN `nomeGrupoAplicado` VARCHAR(200) NULL;

ALTER TABLE `execucao_senha_quiz` ADD CONSTRAINT `execucao_senha_quiz_grupoDaJanelaId_fkey`
    FOREIGN KEY (`grupoDaJanelaId`) REFERENCES `grupo_da_janela`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Ate aqui a tela lia o nome aplicado da JANELA na hora de exibir. Congelar o
-- que ela mostrava e o que mantem o historico legivel igual ao de ontem. So as
-- execucoes que de fato tentaram trocar grupo: numa janela sem nome os dois
-- contadores sao zero, e a coluna fica nula como a tela esperava.
UPDATE `execucao_senha_quiz` e
    JOIN `janela_de_prova` j ON j.`id` = e.`janelaDeProvaId`
SET e.`nomeGrupoAplicado` = j.`nomeGrupo`
WHERE e.`tipo` = 'DATA'
  AND (e.`gruposTrocados` + e.`gruposPendentes`) > 0;

-- ---------------------------------------------------------------------------
-- 3. O desfecho novo: o dia ficou em branco
-- ---------------------------------------------------------------------------
--
-- A janela ja usou a grade e nao ha celula nem nome fixo para o dia. E
-- PENDENCIA, e nao "nao troca": a condicao continua apontando para o grupo da
-- sessao anterior. MODIFY so acrescenta um valor, nenhuma linha e rejeitada.
ALTER TABLE `item_senha_quiz`
    MODIFY COLUMN `resultadoGrupo` ENUM(
        'TROCADO',
        'SIMULADO',
        'JA_ERA_O_GRUPO',
        'SEM_CONDICAO_DE_GRUPO',
        'CONDICAO_POR_CATEGORIA',
        'GRUPO_NAO_ENCONTRADO',
        'GRUPO_AMBIGUO',
        'SEM_CATEGORIA_DE_GRUPO',
        'SEM_GRUPO_NO_DIA',
        'FALHA_AO_LER_CONDICOES',
        'FALHA_AO_GRAVAR_CONDICOES'
    ) NULL;
