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
const COLS_KANBAN = ['card_id', 'coluna', 'os_atribuidas', 'observacao', 'valor_peca', 'ordem', 'atualizado_em'];

/* ── Roteador GET ───────────────────────────────────────────── */
function doGet(e) {
  const action = ((e && e.parameter && e.parameter.action) || '').toLowerCase();
  try {
    if (action === 'patio')         return json({ success: true, data: lerPatio() });
    if (action === 'historico')     return json({ success: true, data: lerHistorico(e.parameter.data) });
    if (action === 'historico_range') return json({ success: true, data: buscarHistorico(e.parameter) });
    if (action === 'kanban_get')    return json({ success: true, data: lerKanban() });
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

/* ── BUSCA (histórico por intervalo de datas + placa) ───────── */
function buscarHistorico(params) {
  params = params || {};
  const dataInicio = params.dataInicio || '';
  const dataFim     = params.dataFim || dataInicio;
  const placa       = String(params.placa || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const tz = ss().getSpreadsheetTimeZone();

  return lerRegistros().filter(r => {
    if (!r.Data_Entrada) return false;
    const diaEntrada = Utilities.formatDate(new Date(r.Data_Entrada), tz, 'yyyy-MM-dd');
    if (dataInicio && diaEntrada < dataInicio) return false;
    if (dataFim && diaEntrada > dataFim) return false;

    if (placa) {
      const pCavalo  = String(r.Placa_Cavalo  || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const pCarreta = String(r.Placa_Carreta || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (pCavalo.indexOf(placa) === -1 && pCarreta.indexOf(placa) === -1) return false;
    }
    return true;
  }).sort((a, b) => new Date(b.Data_Entrada) - new Date(a.Data_Entrada));
}

/* ── ENTRADA (novo veículo no pátio) ────────────────────────── */
/*
 * Cada placa entra sozinha (desde 11/2026 não existe mais "Conjunto").
 * Se um aparelho com a versão antiga da portaria ainda mandar Conjunto
 * (ex.: fila offline antiga), ele vira DOIS registros: um Cavalo e uma
 * Carreta, cada um saindo quando sair.
 */
function registrarEntrada(body) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { success: false, error: 'Sistema ocupado. Tente de novo em alguns segundos.' };
  try {
    const sh   = getOrCreateSheet(ABA_REGISTROS, COLS_REGISTROS);
    const tipo = String(body.Tipo_Veiculo || '').trim();
    const limpa = p => String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 7);

    const itens = tipo === 'Conjunto'
      ? [{ tipo: 'Cavalo', cavalo: limpa(body.Placa_Cavalo), carreta: '' },
         { tipo: 'Carreta', cavalo: '', carreta: limpa(body.Placa_Carreta) }]
      : [{ tipo: tipo,
           cavalo: tipo === 'Carreta' ? '' : limpa(body.Placa_Cavalo || body.Placa_Carreta),
           carreta: tipo === 'Carreta' ? limpa(body.Placa_Carreta || body.Placa_Cavalo) : '' }];

    // A mesma placa não pode estar duas vezes no pátio.
    const noPatio = {};
    lerPatio().forEach(r => {
      if (r.Status_Cavalo === 'No Pátio' && r.Placa_Cavalo) noPatio[limpa(r.Placa_Cavalo)] = r.ID;
      if (r.Status_Carreta === 'No Pátio' && r.Placa_Carreta) noPatio[limpa(r.Placa_Carreta)] = r.ID;
    });
    for (const it of itens) {
      if (it.tipo !== 'Visitante' && !(it.cavalo || it.carreta)) return { success: false, error: 'Informe a placa.' };
      const placa = it.cavalo || it.carreta;
      if (placa && noPatio[placa]) return { success: false, error: 'A placa ' + placa + ' já está no pátio (' + noPatio[placa] + '). Dê saída nela antes de registrar de novo.' };
    }

    const ids = [];
    itens.forEach(it => {
      const id = proximoId(sh);
      sh.appendRow([
        id, it.tipo, it.cavalo, it.carreta,
        body.Motorista || '', body.Cliente_Destino || '', body.Obs_Entrada || '',
        new Date(),
        it.tipo === 'Carreta' ? 'N/A' : 'No Pátio',
        it.tipo === 'Carreta' ? 'No Pátio' : 'N/A',
        '', ''
      ]);
      ids.push(id);
    });
    return { success: true, id: ids.join(' e '), rowIndex: sh.getLastRow() };
  } finally {
    lock.releaseLock();
  }
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
      c.coluna || 'AGUARDANDO (ORÇAMENTO / VAGA)',
      String(c.os_atribuidas || ''),
      String(c.observacao || ''),
      Number(c.valor_peca) || 0,
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
  } else if (sh.getLastColumn() < cols.length) {
    // Migração: completa o cabeçalho quando novas colunas são adicionadas depois
    const largura = sh.getLastColumn();
    sh.getRange(1, largura + 1, 1, cols.length - largura).setValues([cols.slice(largura)]);
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
