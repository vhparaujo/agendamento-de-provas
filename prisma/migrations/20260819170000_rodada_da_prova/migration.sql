-- A RODADA: qual prova do semestre e esta.
--
-- O sistema tratava "periodo letivo" como se houvesse UMA prova por semestre. Na
-- pratica ha pelo menos duas — a regular (N2) e a substitutiva (SUB) —, e as duas
-- caem no MESMO `periodoLetivoId` do Brightspace. Consequencias praticas antes
-- desta coluna:
--   - `POST /periodos` recusava com 409 a segunda janela do semestre, porque
--     comparava so o `periodoLetivoId` do vigente;
--   - a trava "uma prova por vinculo no semestre" (`alunoId + periodoLetivoId`)
--     impedia quem agendou a N2 de agendar a SUB.
--
-- A identidade do periodo passa a ser o par `periodoLetivoId + rodada`, e o
-- agendamento guarda a rodada como FOTOGRAFIA — igual a `modalidadeId` e
-- `poloId`: o valor do periodo vigente no instante da reserva, que nao se move
-- se a janela for editada depois.

-- `periodo_agendamento`: as janelas ja cadastradas sao todas da prova regular.
ALTER TABLE `periodo_agendamento`
    ADD COLUMN `rodada` VARCHAR(191) NOT NULL DEFAULT 'N2';

-- `execucao_compulsorio`: mesmo raciocinio — os lotes ja rodados foram da N2.
ALTER TABLE `execucao_compulsorio`
    ADD COLUMN `rodada` VARCHAR(191) NOT NULL DEFAULT 'N2';

-- `agendamento` NAO tem default no schema, de proposito: a rodada sempre vem do
-- periodo vigente, e um default no banco esconderia o dia em que alguem gravasse
-- uma reserva sem passar por ele. Por isso o backfill e explicito — nullable,
-- UPDATE, e so entao NOT NULL, o mesmo caminho da fotografia de modalidade/polo.
ALTER TABLE `agendamento`
    ADD COLUMN `rodada` VARCHAR(191) NULL;

-- Toda prova que existe hoje foi marcada quando so havia a prova regular.
UPDATE `agendamento` SET `rodada` = 'N2' WHERE `rodada` IS NULL;

ALTER TABLE `agendamento`
    MODIFY COLUMN `rodada` VARCHAR(191) NOT NULL;
