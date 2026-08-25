-- A MESMA ABA TROCA SENHA E TROCA DATA.
--
-- O lote de senhas ja acha o questionario pelo nome dentro de cada turma do CSV
-- e faz GET -> altera -> PUT completo. `montarCorpoDoQuiz` reenviava
-- `StartDate`/`EndDate` VERBATIM de proposito ("este lote nao mexe em
-- calendario"). Esta migration abre a segunda metade: o mesmo caminho passa a
-- poder mover a janela do questionario, no horario, sozinho.
--
-- O QUE MUDA DE VERDADE E O RECORTE. A senha e uma celula da grade aplicada em
-- TODAS as turmas do CSV. A data e por MODALIDADE — EaD cabe em 3 sessoes de 3h
-- por dia, Semi/Modular em 6 de 1h30 —, e por isso o lote de datas precisa saber
-- a modalidade de cada turma. Ela NAO existe em `turma_importada` (a coluna
-- `curso` foi removida em 10/08/2026, porque uma turma tem alunos de varios
-- cursos) e nao ha coluna nova aqui: a modalidade e DERIVADA dos agendamentos
-- confirmados, via `agendamento_disciplina.orgUnitId`. Ver
-- `modalidade-da-turma.service.ts`.
--
-- TUDO E ADITIVO OU AFROUXA. Nenhum DROP, nenhuma coluna removida ou renomeada,
-- nenhum indice unico derrubado. Os dois MODIFY tornam colunas NULL-aveis (de
-- NOT NULL para NULL), o que nunca rejeita linha existente. As execucoes ja
-- gravadas recebem `tipo = 'SENHA'` pelo DEFAULT — que e o que elas de fato sao,
-- porque ate aqui so havia troca de senha.

-- ---------------------------------------------------------------------------
-- 1. A JANELA: a que horas o questionario abre e fecha, por modalidade
-- ---------------------------------------------------------------------------
--
-- Uma linha = um DISPARO. `horaDisparo` diz quando o cron aplica; `horaInicio` e
-- `horaFim` sao o que o questionario passa a ter.
--
-- Fica no banco, e nao em constante no codigo, pelo mesmo motivo que os horarios
-- do cron de senhas sairam do .env em 19/08/2026: quem conhece o calendario e a
-- secretaria, e ela nao faz deploy.
--
-- `diaSeguinte` cobre os disparos das 22:01 (EaD) e 21:31 (Semi/Modular), que
-- fecham a noite armando a PRIMEIRA prova do dia seguinte. Sem a coluna, a
-- janela das 09:00 teria de ser aplicada de madrugada — um disparo a mais, num
-- horario em que ninguem esta olhando se ele falhou.
--
-- ⚠️ `turno` NAO e enfeite de relatorio: e o que impede o lote de datas de
-- APAGAR a senha de toda prova da instituicao. O PUT substitui o objeto inteiro,
-- entao ele reenvia `Password` — e o GET pode devolver `Password: null` num
-- questionario QUE TEM SENHA (o QuizReadData so expoe o campo se for "nao nulo E
-- visivel ao contexto do chamador"). Preservar a leitura e exatamente o bug que
-- o comentario de `execucao_senha_quiz.comSenhaLida` ja registrava sobre o CLI
-- de origem. Com o turno aqui, o lote de datas le a senha da GRADE e a define,
-- em vez de confiar no que a API devolveu.
CREATE TABLE `janela_de_prova` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `modalidadeId` INTEGER NOT NULL,
    `ordem` INTEGER NOT NULL,
    `horaDisparo` VARCHAR(5) NOT NULL,
    `horaInicio` VARCHAR(5) NOT NULL,
    `horaFim` VARCHAR(5) NOT NULL,
    `turno` ENUM('MANHA', 'TARDE', 'NOITE') NOT NULL,
    `diaSeguinte` BOOLEAN NOT NULL DEFAULT false,
    `ativo` BOOLEAN NOT NULL DEFAULT true,
    `atualizadoPor` VARCHAR(191) NULL,
    `atualizadoEm` DATETIME(3) NOT NULL,

    INDEX `janela_de_prova_modalidadeId_idx`(`modalidadeId`),
    UNIQUE INDEX `janela_de_prova_modalidadeId_ordem_key`(`modalidadeId`, `ordem`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `janela_de_prova` ADD CONSTRAINT `janela_de_prova_modalidadeId_fkey`
    FOREIGN KEY (`modalidadeId`) REFERENCES `modalidade`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 2. A EXECUCAO PASSA A TER TIPO
-- ---------------------------------------------------------------------------
--
-- Os dois lotes moram na MESMA tabela de proposito, e nao por economia de
-- codigo. Os dois fazem GET -> altera -> PUT no MESMO questionario, e o PUT
-- SUBSTITUI o objeto inteiro. Rodando em paralelo, os dois leriam antes de
-- qualquer um gravar, e o segundo PUT devolveria o campo do outro ao valor
-- antigo — em silencio, sem erro nenhum, descoberto no dia.
--
-- `recusarSeJaRodando()` ja serializa tudo consultando ESTA tabela. Com uma
-- tabela separada ele teria de consultar as duas, e esquecer isso seria
-- exatamente esse bug. Serializados, cada lote faz o proprio GET imediatamente
-- antes do proprio PUT e preserva verbatim o campo do outro: nao ha atualizacao
-- perdida.
ALTER TABLE `execucao_senha_quiz`
    ADD COLUMN `tipo` ENUM('SENHA', 'DATA') NOT NULL DEFAULT 'SENHA',
    ADD COLUMN `janelaDeProvaId` INTEGER NULL,
    ADD COLUMN `horaInicioAplicada` VARCHAR(5) NULL,
    ADD COLUMN `horaFimAplicada` VARCHAR(5) NULL,
    ADD COLUMN `semModalidade` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `modalidadeAmbigua` INTEGER NOT NULL DEFAULT 0;

-- Os dois campos que so a SENHA tem. Afrouxar e seguro nos dois sentidos: linha
-- existente mantem o valor, e o codigo que os le continua recebendo o que
-- recebia. Uma execucao `DATA` nao le celula da grade, entao nao tem turno nem
-- versao de senha para gravar — e inventar um valor (turno 'MANHA', versao 0)
-- faria a consulta de idempotencia do cron de senhas encontrar execucao que nao
-- e dela.
ALTER TABLE `execucao_senha_quiz`
    MODIFY COLUMN `turno` ENUM('MANHA', 'TARDE', 'NOITE') NULL,
    MODIFY COLUMN `versaoAplicada` INTEGER NULL;

ALTER TABLE `execucao_senha_quiz` ADD CONSTRAINT `execucao_senha_quiz_janelaDeProvaId_fkey`
    FOREIGN KEY (`janelaDeProvaId`) REFERENCES `janela_de_prova`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

-- A idempotencia do cron de datas: "esta janela ja foi aplicada NESTE dia?".
-- `data` entra na chave porque a janela se repete todo dia — sem ela, aplicar a
-- janela das 15:00 numa segunda impediria a de terca.
CREATE INDEX `execucao_senha_quiz_janelaDeProvaId_data_simulacao_status_idx`
    ON `execucao_senha_quiz`(`janelaDeProvaId`, `data`, `simulacao`, `status`);

-- `ultima(origem, tipo)` — consultada em laco por toda tela aberta, agora com
-- mais uma dimensao: a tela precisa distinguir o ultimo disparo de datas do
-- ultimo de senhas, senao um esconderia o resultado do outro.
CREATE INDEX `execucao_senha_quiz_tipo_origem_id_idx`
    ON `execucao_senha_quiz`(`tipo`, `origem`, `id`);

-- ---------------------------------------------------------------------------
-- 3. O ITEM GANHA A FOTOGRAFIA DO QUE FOI APLICADO
-- ---------------------------------------------------------------------------
--
-- Fotografia, como `agendamento_disciplina.notaFinal`: a janela pode ser editada
-- na tela depois, e sem estas colunas a unica resposta para "por que a prova
-- abriu as 16h?" seria olhar a configuracao de HOJE. `modalidadeCodigo` e texto
-- e nao FK pelo mesmo motivo de `codigoTurma`: o CSV do relatorio precisa dele
-- sem join.
ALTER TABLE `item_senha_quiz`
    ADD COLUMN `modalidadeCodigo` VARCHAR(191) NULL,
    ADD COLUMN `startDateAplicado` DATETIME(3) NULL,
    ADD COLUMN `endDateAplicado` DATETIME(3) NULL;

-- Dois resultados novos, ambos exclusivos do lote de DATAS.
--
-- Sao o equivalente de `QUIZ_NAO_ENCONTRADO` deste lado: nao sao falha de rede
-- nem erro de ninguem, e cada linha e uma turma inteira que ficaria com a data
-- velha — alunos que nao abrem a prova. Zero falhas com 30 destes e um desastre
-- silencioso, e por isso eles tem contador proprio na execucao.
--
-- `MODALIDADE_AMBIGUA` nao escolhe a maioria de proposito: o questionario tem
-- UMA janela, e a minoria ficaria sem conseguir abrir a prova. Mesma regra de
-- `ORGUNIT_AMBIGUO` — nada e chutado.
ALTER TABLE `item_senha_quiz`
    MODIFY COLUMN `resultado` ENUM(
        'DEFINIDA',
        'SIMULADA',
        'QUIZ_NAO_ENCONTRADO',
        'ORGUNIT_NAO_RESOLVIDO',
        'ORGUNIT_AMBIGUO',
        'SEM_AGENDAMENTO',
        'MODALIDADE_AMBIGUA',
        'FALHA_AO_LISTAR',
        'FALHA_AO_LER',
        'FALHA_AO_GRAVAR'
    ) NOT NULL;
