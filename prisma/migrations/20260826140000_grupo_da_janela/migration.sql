-- TROCAR O GRUPO QUE LIBERA A PROVA, NO MESMO DISPARO QUE MOVE A DATA.
--
-- Ate aqui o lote de DATAS movia StartDate/EndDate do questionario e trocava a
-- senha do turno. Isso impede que o aluno das 15h abra a prova as 19h — mas so
-- pelo RELOGIO. Quem ja entrou na sessao anterior continua elegivel pela
-- condicao de liberacao do questionario, que aponta para o grupo daquela sessao.
--
-- O que o cliente fazia a mao no CLI `../brightspace-change-conditions`, uma vez
-- por turno, passa a acontecer no mesmo tick do cron: a condicao
-- `EnrolledInGroup` do quiz tem o `GroupId` trocado para o grupo da janela.
--
-- TRES DECISOES DO CLIENTE ESTAO CONGELADAS NESTE SCHEMA (26/08/2026):
--
--  1. O nome do grupo e FIXO POR JANELA e reusado nos seis dias de prova
--     ("Prova 1", "Prova 2", "Prova 3"). Por isso ele mora em `janela_de_prova`
--     e nao numa grade dia x janela como as senhas.
--  2. Falha de grupo NAO bloqueia a data. Por isso `resultadoGrupo` e uma coluna
--     SEPARADA de `resultado`, e nao valores novos naquele enum: a mesma linha
--     precisa poder dizer "data DEFINIDA, grupo pendente".
--  3. So se TROCA condicao existente, nunca se CRIA — dai `SEM_CONDICAO_DE_GRUPO`
--     ser um desfecho reportado, e nao um caminho de escrita.
--
-- Aditiva do inicio ao fim: seis ADD COLUMN, nenhum DROP, nenhum MODIFY, nenhum
-- indice tocado. Toda coluna nova e NULL-avel ou tem DEFAULT 0, entao as linhas
-- ja gravadas continuam validas e as execucoes historicas seguem legiveis.
--
-- ⚠️ `nomeGrupo` NASCE NULO EM TODAS AS JANELAS, e e assim que tem de ser. Nulo
-- significa "nao troca grupo nesta janela", entao esta migration sozinha NAO
-- muda o comportamento de nenhum disparo: o recurso so liga quando a secretaria
-- digitar os nomes na tela. Semear um nome plausivel aqui casaria com o grupo
-- errado em silencio — o mesmo argumento que deixou `configuracao_senha_quiz`
-- sem semente para o nome do questionario.

-- O grupo-alvo de cada janela. NOME, nunca GroupId: cada turma tem os seus
-- proprios grupos, com ids proprios, mesmo com nomes identicos. O id e resolvido
-- turma a turma no disparo.
ALTER TABLE `janela_de_prova`
    ADD COLUMN `nomeGrupo` VARCHAR(200) NULL,
    ADD COLUMN `categoriaGrupo` VARCHAR(200) NULL;

-- Os dois contadores da fase nova.
--
-- `gruposPendentes` tem o MESMO peso de `naoEncontradas` e `semModalidade` na
-- tela: cada unidade e uma prova que vai abrir no horario certo para o grupo da
-- sessao ANTERIOR. Uma execucao com 0 falhas e 30 aqui nao e verde.
ALTER TABLE `execucao_senha_quiz`
    ADD COLUMN `gruposTrocados` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `gruposPendentes` INTEGER NOT NULL DEFAULT 0;

-- O desfecho por (turma, quiz), o antes/depois legivel e o backup.
--
-- `condicoesAnteriores` e a UNICA forma de voltar atras: o PUT de
-- `conditionalRelease` substitui a lista inteira de condicoes e a API nao guarda
-- historico. O CLI de origem grava o mesmo JSON em `logs/backup/` antes de
-- qualquer escrita, inclusive no dry-run.
ALTER TABLE `item_senha_quiz`
    ADD COLUMN `resultadoGrupo` ENUM(
        'TROCADO',
        'SIMULADO',
        'JA_ERA_O_GRUPO',
        'SEM_CONDICAO_DE_GRUPO',
        'CONDICAO_POR_CATEGORIA',
        'GRUPO_NAO_ENCONTRADO',
        'GRUPO_AMBIGUO',
        'SEM_CATEGORIA_DE_GRUPO',
        'FALHA_AO_LER_CONDICOES',
        'FALHA_AO_GRAVAR_CONDICOES'
    ) NULL,
    ADD COLUMN `grupoAnterior` VARCHAR(191) NULL,
    ADD COLUMN `grupoAplicado` VARCHAR(191) NULL,
    ADD COLUMN `condicoesAnteriores` TEXT NULL;
