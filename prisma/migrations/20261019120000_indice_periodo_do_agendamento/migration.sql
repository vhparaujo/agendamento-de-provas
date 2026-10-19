-- O RECORTE DA LISTA GERAL DA INTEGRACAO: `GET /integracao/agendamentos` filtra
-- por `periodoLetivoId` (e `rodada`, quando informada), coluna que nao tinha
-- indice — cada pagina leria a tabela inteira. O par segue a identidade do
-- periodo (`periodoLetivoId + rodada`); so o `periodoLetivoId` tambem usa o indice.
CREATE INDEX `agendamento_periodoLetivoId_rodada_idx` ON `agendamento`(`periodoLetivoId`, `rodada`);
