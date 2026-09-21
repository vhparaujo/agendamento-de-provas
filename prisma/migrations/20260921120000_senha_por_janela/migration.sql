-- A SENHA PASSA A SER POR SESSAO, e nao mais tres por dia.
--
-- Ate aqui a grade de senhas era `dia x TURNO` (manha/tarde/noite) e o cron
-- tinha um calendario proprio, em `configuracao_senha_quiz`. A data e o grupo
-- do questionario ja trocavam por FORMATO, no disparo de cada
-- `janela_de_prova`; a senha nao, e isso custava duas coisas:
--
--   1. em Semi/Modular as duas sessoes do mesmo turno DIVIDIAM a senha — o
--      aluno das 08:30 podia repassa-la ao das 10:30. O comentario do seed de
--      janelas registra essa decisao desde 25/08/2026, e diz onde consertar:
--      "o lugar de mudar e a grade de senhas (para dia x modalidade x janela)";
--   2. eram dois calendarios para manter na tela, e o errado era o que alguem
--      acabaria editando.
--
-- Agora a grade e `dia x JANELA`, igual a de grupos, e os tres calendarios
-- (data, grupo, senha) passaram a ser UM SO.
--
-- NAO E DESTRUTIVA COM O HISTORICO: nenhuma linha de `senha_de_prova` e apagada
-- e nenhuma execucao perde a FK. As linhas antigas ficam com `janelaDeProvaId`
-- nulo e o `turno` preenchido; as novas, o inverso. A grade so devolve as novas.

-- ---------------------------------------------------------------------------
-- 1. A celula ganha a janela, e o turno vira historico
-- ---------------------------------------------------------------------------
--
-- Os dois sao NULL-aveis de proposito: e o que permite as duas geracoes de
-- linhas conviverem na mesma tabela, com a mesma rota de revelar, a mesma
-- auditoria e a mesma FK vinda da execucao. Uma tabela nova exigiria duplicar
-- as quatro coisas, e a rota de revelar e justamente onde duplicar e caro.
ALTER TABLE `senha_de_prova`
    ADD COLUMN `janelaDeProvaId` INTEGER NULL,
    MODIFY COLUMN `turno` ENUM('MANHA', 'TARDE', 'NOITE') NULL;

-- O MySQL nao conflita NULLs num indice unico, entao as duas chaves convivem:
-- toda linha antiga tem janela nula (e nunca esbarra na chave nova), toda linha
-- nova tem turno nulo (e nunca esbarra na antiga). A chave antiga fica para as
-- linhas historicas continuarem protegidas contra duplicata.
CREATE UNIQUE INDEX `senha_de_prova_data_janelaDeProvaId_key`
    ON `senha_de_prova`(`data`, `janelaDeProvaId`);

CREATE INDEX `senha_de_prova_janelaDeProvaId_idx`
    ON `senha_de_prova`(`janelaDeProvaId`);

-- CASCADE, como em `grupo_da_janela`: a sessao removida do calendario nao tem
-- mais senha a que se aplicar. A execucao historica sobrevive pelo outro
-- caminho (FK SetNull + data/turno desnormalizados na propria execucao).
ALTER TABLE `senha_de_prova` ADD CONSTRAINT `senha_de_prova_janelaDeProvaId_fkey`
    FOREIGN KEY (`janelaDeProvaId`) REFERENCES `janela_de_prova`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 2. O cron de senhas perde o calendario proprio
-- ---------------------------------------------------------------------------
--
-- `horaManha`/`horaTarde`/`horaNoite` diziam a que horas o lote de senhas
-- disparava. Quem diz isso agora e `janela_de_prova.horaDisparo`, o mesmo
-- horario da data e do grupo. Dropar em vez de deixar morto e deliberado: duas
-- fontes para "a que horas a senha troca" e uma armadilha, e a tela nao tem
-- mais onde mostrar estas.
ALTER TABLE `configuracao_senha_quiz`
    DROP COLUMN `horaManha`,
    DROP COLUMN `horaTarde`,
    DROP COLUMN `horaNoite`;

-- ---------------------------------------------------------------------------
-- 3. A execucao guarda a versao da SENHA, separada da versao da janela
-- ---------------------------------------------------------------------------
--
-- `versaoAplicada` sempre guardou coisas diferentes nos dois tipos: a versao da
-- CELULA em `SENHA`, a da JANELA em `DATA`. Enquanto so o lote de senhas
-- aplicava senha isso bastava. Agora o lote de datas grava a senha da sessao, e
-- a grade precisa responder "o Brightspace esta com a senha que estou vendo?"
-- olhando para as DUAS execucoes — comparar a versao da celula com a da janela
-- faria a grade dizer "desatualizada" no dia em que os dois contadores se
-- cruzassem.
--
-- A mesma coluna entra na idempotencia do lote de datas: gerar a senha de novo
-- as 12:43, depois do disparo das 12:01, precisa liberar um novo disparo HOJE.
-- E o bug de 25/08/2026 aplicado ao terceiro campo que o disparo grava.
--
-- As execucoes antigas ficam NULL. Elas ja concluiram, e a grade de hoje so
-- mostra celulas chaveadas por janela — que nenhuma delas tocou.
ALTER TABLE `execucao_senha_quiz`
    ADD COLUMN `versaoSenhaAplicada` INTEGER NULL;
