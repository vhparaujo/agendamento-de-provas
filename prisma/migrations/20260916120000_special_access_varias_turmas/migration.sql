-- O lote de special access passa a aceitar VARIAS turmas (16/09/2026).
--
-- O motivo e carga: o lote e uma chamada por aluno em cada questionario, e a
-- secretaria precisa decidir quantas turmas o Brightspace recebe de cada vez.
-- A coluna guardava UMA turma; agora guarda a lista escolhida, separada por
-- virgula, no mesmo idioma de `execucao_grupos_d2l.periodoLetivoIds`.
--
-- `CHANGE` preserva o conteudo: execucao antiga com uma turma vira uma lista de
-- um item, que e o que ela sempre foi.
ALTER TABLE `execucao_special_access`
    CHANGE `orgUnitId` `orgUnitIds` VARCHAR(1000) NULL;
