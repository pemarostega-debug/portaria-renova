/**
 * ─────────────────────────────────────────────────────────────
 *  BACKEND — Portaria Renova + Kanban Operacional
 * ─────────────────────────────────────────────────────────────
 *  Este é o "motor" que fica DENTRO da planilha (Extensões > Apps Script).
 *  Ele faz a ponte entre:
 *    - o programa da portaria (index.html)  -> entrada / saída / pátio / histórico
 *    - o Kanban do portal de gestão          -> ler e salvar o quadro
 *
 *  COMO PUBLICAR (uma vez):
 *   1. Abra a planilha > menu Extensões > Apps Script.
 *   2. Apague o conteúdo padrão e cole TODO este arquivo.
 *   3. Rode a função `setup` uma vez (autorize quando pedir) para criar
 *      as abas e limpar dados de teste.
 *   4. Implantar > Nova implantação > tipo "App da Web":
 *        - Executar como: Eu (sua conta)
 *        - Quem tem acesso: Qualquer pessoa
 *   5. Copie a URL que termina em /exec e me envie.
 *      (essa URL vai no APPS_SCRIPT_URL do index.html e do portal)
 *
 *  Sempre que alterar este código, use Implantar > Gerenciar implantações >
 *  editar (lápis) > Nova versão, para a URL /exec continuar a mesma.
 * ─────────────────────────────────────────────────────────────
 */

const SHEET_ID      = '1VoMaAybvQMF4zDbF4nxjQpt6txipXW7DH4FYxsr0NqI';
const ABA_REGISTROS = 'Registros';
const ABA_KANBAN    = 'Kanban';

const COLS_REGISTROS = [
  'ID', 'Tipo_Veiculo', 'Placa_Cavalo', 'Placa_Carreta', 'Motorista',
  'Cliente_Destino', 'Obs_Entrada', 'Data_Entrada', 'Status_Cavalo',
  'Status_Carreta', 'Data_Saida_Cavalo', 'Data_Saida_Carreta'
];
const COLS_KANBAN = ['card_id', 'coluna', 'os_atribuidas', 'ordem', 'atualizado_em'];

/* ── Roteador GET ───────────────────────────────────────────── */
function doGet(e) {
  const action = ((e && e.parameter && e.parameter.action) || '').toLowerCase();
  try {
    if (action === 'patio')      return json({ success: true, data: lerPatio() });
    if (action === 'historico')  return json({ success: true, data: lerHistorico(e.parameter.data) });
    if (action === 'kanban_get') return json({ success: true, data: lerKanban() });
    return json({ success: false, error: 'Ação desconhecida: ' + action });
  } catch (err) {
    return json({ success: false, error: String(err) });
  }
}

/* ── Roteador POST ──────────────────────────────────────────── */
function doPost(e) {
  try {
    const body   = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const action = (body.action || '').toLowerCase();
    if (action === 'entrada')    return json(registrarEntrada(body));
    if (action === 'saida')      return json(registrarSaida(body));
    if (action === 'kanban_set') return json(salvarKanban(body));
    return json({ success: false, error: 'Ação desconhecida: ' + action });
  } catch (err) {
    return json({ success: false, error: String(err) });
  }
}

/* ── PÁTIO (veículos que ainda estão no pátio) ──────────────── */
function lerPatio() {
  return lerRegistros().filter(r =>
    r.Status_Cavalo === 'No Pátio' || r.Status_Carreta === 'No Pátio'
  );
}

/* ── HISTÓRICO (registros de uma data de entrada) ───────────── */
function lerHistorico(dataStr) {
  if (!dataStr) return [];
  const tz = ss().getSpreadsheetTimeZone();
  return lerRegistros().filter(r => {
    if (!r.Data_Entrada) return false;
    const d = new Date(r.Data_Entrada);
    return Utilities.formatDate(d, tz, 'yyyy-MM-dd') === dataStr;
  });
}

/* ── ENTRADA (novo veículo no pátio) ────────────────────────── */
function registrarEntrada(body) {
  const sh   = getOrCreateSheet(ABA_REGISTROS, COLS_REGISTROS);
  const tipo = body.Tipo_Veiculo || '';

  // Define status inicial conforme o tipo de equipamento
  let statusCavalo  = 'N/A';
  let statusCarreta = 'N/A';
  if (tipo === 'Conjunto')      { statusCavalo = 'No Pátio'; statusCarreta = 'No Pátio'; }
  else if (tipo === 'Carreta')  { statusCarreta = 'No Pátio'; }
  else                          { statusCavalo = 'No Pátio'; } // Cavalo, Truck, Utilitário, Visitante

  const id   = proximoId(sh);
  const linha = [
    id,
    tipo,
    body.Placa_Cavalo    || '',
    body.Placa_Carreta   || '',
    body.Motorista       || '',
    body.Cliente_Destino || '',
    body.Obs_Entrada     || '',
    new Date(),
    statusCavalo,
    statusCarreta,
    '',
    ''
  ];
  sh.appendRow(linha);
  return { success: true, id: id, rowIndex: sh.getLastRow() };
}

/* ── SAÍDA (cavalo, carreta ou conjunto) ────────────────────── */
function registrarSaida(body) {
  const sh  = getOrCreateSheet(ABA_REGISTROS, COLS_REGISTROS);
  const row = Number(body.rowIndex);
  if (!row || row < 2) return { success: false, error: 'rowIndex inválido' };

  const col = idx => COLS_REGISTROS.indexOf(idx) + 1;
  const agora = new Date();
  const tipoSaida = body.tipoSaida; // 'conjunto' | 'cavalo' | 'carreta'

  if (tipoSaida === 'conjunto' || tipoSaida === 'cavalo') {
    sh.getRange(row, col('Status_Cavalo')).setValue('Saiu');
    sh.getRange(row, col('Data_Saida_Cavalo')).setValue(agora);
  }
  if (tipoSaida === 'conjunto' || tipoSaida === 'carreta') {
    sh.getRange(row, col('Status_Carreta')).setValue('Saiu');
    sh.getRange(row, col('Data_Saida_Carreta')).setValue(agora);
  }
  return { success: true };
}

/* ── KANBAN — ler estado do quadro ──────────────────────────── */
function lerKanban() {
  const sh   = getOrCreateSheet(ABA_KANBAN, COLS_KANBAN);
  const vals = sh.getDataRange().getValues();
  if (vals.length < 2) return [];
  const head = vals[0];
  const out  = [];
  for (let i = 1; i < vals.length; i++) {
    const row = vals[i];
    if (row.every(c => c === '')) continue;
    const o = {};
    head.forEach((h, idx) => o[h] = row[idx]);
    o.card_id       = String(o.card_id);
    o.os_atribuidas = String(o.os_atribuidas || '');
    out.push(o);
  }
  return out;
}

/* ── KANBAN — salvar estado do quadro (substitui tudo) ──────── */
function salvarKanban(body) {
  const sh    = getOrCreateSheet(ABA_KANBAN, COLS_KANBAN);
  const cards = Array.isArray(body.cards) ? body.cards : [];

  // Limpa linhas de dados (mantém cabeçalho)
  if (sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, COLS_KANBAN.length).clearContent();
  }
  if (cards.length) {
    const agora = new Date();
    const linhas = cards.map(c => [
      String(c.card_id || ''),
      c.coluna || 'AGUARDANDO',
      String(c.os_atribuidas || ''),
      Number(c.ordem) || 0,
      agora
    ]);
    sh.getRange(2, 1, linhas.length, COLS_KANBAN.length).setValues(linhas);
  }
  return { success: true, total: cards.length };
}

/* ── Helpers ────────────────────────────────────────────────── */
function ss() { return SpreadsheetApp.openById(SHEET_ID); }

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getOrCreateSheet(nome, cols) {
  const planilha = ss();
  let sh = planilha.getSheetByName(nome);
  if (!sh) sh = planilha.insertSheet(nome);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, cols.length).setValues([cols]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function lerRegistros() {
  const sh   = getOrCreateSheet(ABA_REGISTROS, COLS_REGISTROS);
  const vals = sh.getDataRange().getValues();
  if (vals.length < 2) return [];
  const head = vals[0];
  const out  = [];
  for (let i = 1; i < vals.length; i++) {
    const row = vals[i];
    if (row.every(c => c === '')) continue;
    const o = { rowIndex: i + 1 };
    head.forEach((h, idx) => {
      const v = row[idx];
      o[h] = (v instanceof Date) ? v.toISOString() : v;
    });
    out.push(o);
  }
  return out;
}

function proximoId(sh) {
  const vals = sh.getDataRange().getValues();
  let max = 0;
  for (let i = 1; i < vals.length; i++) {
    const m = String(vals[i][0] || '').match(/RT-(\d+)/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return 'RT-' + String(max + 1).padStart(3, '0');
}

/**
 * Rode UMA VEZ pelo editor (botão ▶) para criar/limpar as abas.
 * Cria "Registros" e "Kanban" com os cabeçalhos e remove dados antigos.
 */
function setup() {
  const reg = getOrCreateSheet(ABA_REGISTROS, COLS_REGISTROS);
  if (reg.getLastRow() > 1) reg.getRange(2, 1, reg.getLastRow() - 1, COLS_REGISTROS.length).clearContent();
  const kb = getOrCreateSheet(ABA_KANBAN, COLS_KANBAN);
  if (kb.getLastRow() > 1) kb.getRange(2, 1, kb.getLastRow() - 1, COLS_KANBAN.length).clearContent();
  return 'Abas Registros e Kanban prontas.';
}
