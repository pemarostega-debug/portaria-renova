/**
 * Simulador do Google Apps Script para testes locais.
 *
 * Carrega um arquivo .gs num contexto isolado com versões em memória de
 * SpreadsheetApp, DriveApp, CacheService, PropertiesService, LockService,
 * UrlFetchApp, ContentService e Utilities — o suficiente para rodar doGet e
 * doPost de ponta a ponta sem tocar em planilha real.
 *
 * Imita de propósito o comportamento perigoso do Google Sheets: texto com
 * cara de data ou de número escrito numa célula SEM formato de texto ('@')
 * vira Date/Number, como na planilha de verdade. Se o código esquecer o
 * setNumberFormat('@'), os testes pegam.
 */
const fs = require('fs'), vm = require('vm'), crypto = require('crypto');

function criarAmbiente(opcoes) {
  opcoes = opcoes || {};
  const planilhas = {}, pastas = {}, arquivos = {}, props = {}, cache = {};
  const sessoesPortal = opcoes.sessoesPortal || {};   // token → {usuario, nome, papel}
  let ativa = null, agora = opcoes.agora || Date.now();

  /* ── Planilhas ── */
  function Celula() { this.v = ''; this.f = ''; }
  function converter(valor, formato) {
    if (formato === '@' || typeof valor !== 'string') return valor;
    const s = valor.trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
    if (/^-?\d+([.,]\d+)?$/.test(s)) return Number(s.replace(',', '.'));
    return valor;
  }
  function exibir(v) {
    if (v instanceof Date) return v.toLocaleDateString('pt-BR');
    return v === null || v === undefined ? '' : String(v);
  }

  function Aba(nome) { this.nome = nome; this.linhas = []; this.maxRows = 1000; }
  Aba.prototype = {
    getName() { return this.nome; },
    setName(n) { this.nome = n; return this; },
    cel(r, c) {
      while (this.linhas.length < r) this.linhas.push([]);
      const l = this.linhas[r - 1];
      while (l.length < c) l.push(new Celula());
      return l[c - 1];
    },
    getLastRow() {
      for (let r = this.linhas.length; r >= 1; r--) if (this.linhas[r - 1].some(c => c.v !== '' && c.v !== null)) return r;
      return 0;
    },
    getLastColumn() {
      let m = 0;
      this.linhas.forEach(l => { for (let c = l.length; c >= 1; c--) if (l[c - 1].v !== '') { m = Math.max(m, c); break; } });
      return m;
    },
    getMaxRows() { return Math.max(this.maxRows, this.linhas.length); },
    insertRowsAfter(_, n) { this.maxRows += n; return this; },
    getRange(r, c, nr, nc) { return new Intervalo(this, r, c, nr || 1, nc || 1); },
    getDataRange() { return new Intervalo(this, 1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); },
    appendRow(vals) { const r = this.getLastRow() + 1; vals.forEach((v, i) => { const c = this.cel(r, i + 1); c.v = converter(v, c.f); }); return this; },
    setFrozenRows() { return this; }, setColumnWidth() { return this; }
  };

  function Intervalo(aba, r, c, nr, nc) { Object.assign(this, { aba, r, c, nr, nc }); }
  Intervalo.prototype = {
    cada(fn) { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) fn(this.aba.cel(this.r + i, this.c + j), i, j); return this; },
    getValues() { const o = []; for (let i = 0; i < this.nr; i++) { const l = []; for (let j = 0; j < this.nc; j++) l.push(this.aba.cel(this.r + i, this.c + j).v); o.push(l); } return o; },
    getDisplayValues() { return this.getValues().map(l => l.map(exibir)); },
    getValue() { return this.aba.cel(this.r, this.c).v; },
    setValues(m) {
      if (m.length !== this.nr || m.some(l => l.length !== this.nc)) throw new Error('setValues: dimensões erradas (' + m.length + 'x' + (m[0] || []).length + ' em ' + this.nr + 'x' + this.nc + ')');
      if (this.r + this.nr - 1 > this.aba.getMaxRows()) throw new Error('setValues: passou do fim da aba (linha ' + (this.r + this.nr - 1) + ' de ' + this.aba.getMaxRows() + ')');
      return this.cada((cel, i, j) => { cel.v = converter(m[i][j], cel.f); });
    },
    setValue(v) { return this.cada(cel => { cel.v = converter(v, cel.f); }); },
    clearContent() { return this.cada(cel => { cel.v = ''; }); },
    setNumberFormat(f) { return this.cada(cel => { cel.f = f; }); },
    setFontWeight() { return this; }, setBackground() { return this; }, setFontColor() { return this; }
  };

  function Planilha(id, nome) { this.id = id; this.nome = nome; this.abas = [new Aba('Página1')]; this.fuso = 'America/Sao_Paulo'; }
  Planilha.prototype = {
    getId() { return this.id; },
    getSheetByName(n) { return this.abas.find(a => a.nome === n) || null; },
    getSheets() { return this.abas.slice(); },
    insertSheet(n) { const a = new Aba(n); this.abas.push(a); return a; },
    deleteSheet(a) { this.abas = this.abas.filter(x => x !== a); },
    getSpreadsheetTimeZone() { return this.fuso; },
    setSpreadsheetTimeZone(f) { this.fuso = f; }, setSpreadsheetLocale() {}
  };

  /* ── Formatação de data no fuso ── */
  function formatDate(d, fuso, fmt) {
    const p = {};
    new Intl.DateTimeFormat('en-GB', { timeZone: fuso || 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(d).forEach(x => { p[x.type] = x.value; });
    return fmt.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day).replace('HH', p.hour).replace('mm', p.minute).replace('ss', p.second);
  }

  const G = {
    console,
    Logger: { log() {} },
    SpreadsheetApp: {
      openById(id) { if (!planilhas[id]) throw new Error('Planilha não encontrada: ' + id); return planilhas[id]; },
      getActiveSpreadsheet() { return ativa; },
      create(nome) { const id = 'ss' + crypto.randomBytes(12).toString('hex'); planilhas[id] = new Planilha(id, nome); return planilhas[id]; },
      getUi() { throw new Error('Sem interface no simulador'); }
    },
    DriveApp: {
      getFolderById(id) {
        const lista = pastas[id];
        if (!lista) throw new Error('Pasta não encontrada');
        let i = 0;
        return { getFiles: () => ({ hasNext: () => i < lista.length, next: () => arquivos[lista[i++]] }) };
      },
      getFileById(id) { if (!arquivos[id]) throw new Error('Arquivo não encontrado'); return arquivos[id]; }
    },
    CacheService: { getScriptCache: () => ({
      get: k => (k in cache ? cache[k] : null),
      put: (k, v) => { if (String(v).length > 100000) throw new Error('Argumento grande demais para o cache'); cache[k] = String(v); },
      remove: k => { delete cache[k]; },
      removeAll: ks => ks.forEach(k => delete cache[k])
    }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in props ? props[k] : null),
      setProperty: (k, v) => { props[k] = String(v); },
      deleteProperty: k => { delete props[k]; }
    }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    UrlFetchApp: {
      fetch(url, o) {
        const body = JSON.parse(o.payload || '{}');
        const s = body.action === 'sessao_validar' ? sessoesPortal[body.token] : null;
        const resp = s ? Object.assign({ success: true }, s) : { success: false, error: 'Sessão inválida ou expirada.' };
        return { getContentText: () => JSON.stringify(resp) };
      }
    },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput(texto) { return { texto, setMimeType() { return this; }, getContent() { return texto; } }; }
    },
    Utilities: {
      formatDate,
      getUuid: () => crypto.randomUUID(),
      computeHmacSha256Signature: (valor, chave) => [...crypto.createHmac('sha256', chave).update(valor).digest()].map(b => (b > 127 ? b - 256 : b)),
      base64EncodeWebSafe: bytes => Buffer.from(bytes.map(b => (b < 0 ? b + 256 : b))).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      base64Encode: bytes => Buffer.from(bytes.map(b => (b < 0 ? b + 256 : b))).toString('base64')
    }
  };
  // Relógio controlado pelo teste.
  G.Date = class extends Date {
    constructor(...a) { if (a.length) super(...a); else super(agora); }
    static now() { return agora; }
  };

  vm.createContext(G);

  return {
    G,
    carregar(arquivo) { vm.runInContext(fs.readFileSync(arquivo, 'utf8'), G, { filename: arquivo }); return this; },
    novaPlanilha(nome) { return G.SpreadsheetApp.create(nome); },
    ativar(ss) { ativa = ss; },
    planilhas,
    /** Monta uma aba a partir de uma matriz (linha 0 = cabeçalho). Valores como a planilha mostraria. */
    preencher(ss, nomeAba, matriz) {
      const aba = ss.getSheetByName(nomeAba) || ss.insertSheet(nomeAba);
      matriz.forEach((l, i) => l.forEach((v, j) => { aba.cel(i + 1, j + 1).v = v; }));
      return aba;
    },
    pasta(id, lista) {
      pastas[id] = lista.map(a => {
        const fid = a.id || ('f' + crypto.randomBytes(14).toString('hex'));
        const bytes = [...(a.bytes || Buffer.from('foto-falsa-' + a.nome))];
        arquivos[fid] = {
          getId: () => fid, getName: () => a.nome, getMimeType: () => a.mime || 'image/jpeg',
          getLastUpdated: () => new Date(a.atualizado || 1700000000000),
          getBlob: () => ({ getBytes: () => bytes, getContentType: () => a.mime || 'image/jpeg' }),
          getThumbnail: () => null
        };
        return fid;
      });
    },
    relogio(ms) { if (ms !== undefined) agora = ms; return agora; },
    /** Chama doGet/doPost como o Apps Script chamaria e devolve o JSON já lido. */
    get(params) { return JSON.parse(G.doGet({ parameter: params }).getContent()); },
    post(corpo) { return JSON.parse(G.doPost({ postData: { contents: JSON.stringify(corpo) } }).getContent()); }
  };
}

/** Hora de parede de São Paulo → instante (o Brasil não tem horário de verão desde 2019: UTC−3). */
function sp(texto) {
  const m = texto.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] + 3, +m[5], +(m[6] || 0));
}

module.exports = { criarAmbiente, sp };
