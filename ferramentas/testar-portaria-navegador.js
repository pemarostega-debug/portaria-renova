/**
 * Teste da portaria num navegador de verdade (Edge/Chrome sem janela), com o
 * backend de PJ rodando no Google simulado (simulador-gas.js) e o de veículos
 * respondido por uma imitação em memória. Nada toca produção.
 *
 *   npm install --no-save puppeteer-core      (uma vez)
 *   node ferramentas/testar-portaria-navegador.js [pasta-para-capturas]
 *
 * Cobre: login com a senha do PJ, mural com cards, entrada/saída com um toque,
 * toque duplo, fila sem internet e reenvio, Desfazer, contagem no topo,
 * equipamento com placa única (sem "Conjunto"), saída de registro antigo de
 * conjunto, rolagem horizontal no celular e erros de JavaScript.
 */
const http = require('http'), fs = require('fs'), path = require('path');
const { criarAmbiente } = require('./simulador-gas');
let puppeteer;
try { puppeteer = require('puppeteer-core'); }
catch (e) {
  try { puppeteer = require(require.resolve('puppeteer-core', { paths: [process.cwd()] })); }
  catch (e2) { console.error('Falta o puppeteer-core. Rode: npm install --no-save puppeteer-core'); process.exit(1); }
}

const RAIZ = path.join(__dirname, '..');
const CAPTURAS = process.argv[2] || '';
const PJ_URL = 'https://script.google.com/macros/s/PJ-TESTE/exec';
const NAVEGADORES = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
                     'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'];

let ok = 0; const falhas = [];
let ultimoT = '';
function t(nome, real, esperado) {
  ultimoT = nome;
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) ok++; else falhas.push(`${nome}\n    veio:     ${a}\n    esperado: ${b}`);
}
const esperar = ms => new Promise(r => setTimeout(r, ms));
// O mural se redesenha quando a resposta do servidor chega: o clique é feito dentro da página, no elemento que existe naquele instante.
const clicar = (page, sel) => page.evaluate(s => document.querySelector(s).click(), sel);

/* ── Backend de PJ simulado ── */
function montarBackend() {
  const amb = criarAmbiente();
  amb.carregar(path.join(RAIZ, 'apps-script', 'ColaboradoresPJ.gs'));
  amb.relogio(Date.now());
  const rh = amb.novaPlanilha('RH');
  const HOR = 'Seg a Sex 07:00 as 19:00 com 1H intervalo e Sab 07:00 as 19:00';   // todo dia com expediente, para o teste valer a qualquer hora
  const pessoas = [['PJ_201', 'Ana Paula Teste', 'Soldadora'], ['PJ_202', 'Bruno Teste Lima', 'Mecânico'], ['PJ_203', 'Carlos das Neves Teste', 'Eletricista'],
                   ['PJ_204', 'Daniela Teste Rocha', 'Assistente administrativo'], ['PJ_205', 'Eduardo Teste Prado', 'Ajudante geral']];
  amb.preencher(rh, 'colaboradores e PJ', [['Status', 'Tipo', 'Codigo RH', 'Colaborador', 'Cargo', 'Horário', 'Departamento', 'Admissão']]
    .concat(pessoas.map(p => ['Ativo', 'PJ', p[0], p[1], p[2], HOR, 'Oficina', '01/01/2026'])));
  const cores = ['#2563eb', '#16a34a', '#d97706', '#db2777'];
  amb.pasta('pasta-fotos-teste-0000000000000', pessoas.slice(0, 4).map((p, i) => ({
    nome: 'FOTO ' + p[1].split(' ')[0].toUpperCase() + '.svg', mime: 'image/svg+xml',
    bytes: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500"><rect width="400" height="500" fill="${cores[i]}"/><circle cx="200" cy="190" r="90" fill="#fff" opacity=".85"/><rect x="80" y="310" width="240" height="190" rx="110" fill="#fff" opacity=".85"/></svg>`)
  })));
  const ctrl = amb.novaPlanilha('Controle');
  amb.ativar(ctrl);
  amb.G.instalar();
  amb.G.pjCfgGravar({ planilha_rh: 'https://docs.google.com/spreadsheets/d/' + rh.getId() + '/edit',
                      pasta_fotos: 'https://drive.google.com/drive/folders/pasta-fotos-teste-0000000000000', senha_portaria: 'teste-1234' });
  return { amb, ctrl };
}

/* ── Backend de veículos imitado ── */
function montarVeiculos() {
  const reg = [
    { rowIndex: 2, ID: 'RT-090', Tipo_Veiculo: 'Conjunto', Placa_Cavalo: 'AAA1A11', Placa_Carreta: 'BBB2B22', Motorista: 'Motorista <b>Antigo</b>', Cliente_Destino: '',
      Obs_Entrada: '', Data_Entrada: new Date(Date.now() - 3600e3).toISOString(), Status_Cavalo: 'No Pátio', Status_Carreta: 'No Pátio' }
  ];
  return {
    reg,
    get(params) {
      if (params.get('action') === 'patio') return { success: true, data: reg.filter(r => r.Status_Cavalo === 'No Pátio' || r.Status_Carreta === 'No Pátio') };
      return { success: true, data: [] };
    },
    post(b) {
      if (b.action === 'entrada') {
        const r = { rowIndex: reg.length + 2, ID: 'RT-' + (100 + reg.length), Tipo_Veiculo: b.Tipo_Veiculo, Placa_Cavalo: b.Placa_Cavalo, Placa_Carreta: b.Placa_Carreta,
                    Motorista: b.Motorista, Cliente_Destino: b.Cliente_Destino, Obs_Entrada: b.Obs_Entrada, Data_Entrada: new Date().toISOString(),
                    Status_Cavalo: b.Tipo_Veiculo === 'Carreta' ? 'N/A' : 'No Pátio', Status_Carreta: b.Tipo_Veiculo === 'Carreta' ? 'No Pátio' : 'N/A' };
        reg.push(r); return { success: true, id: r.ID };
      }
      if (b.action === 'saida') {
        const r = reg.find(x => x.rowIndex === b.rowIndex);
        if (b.tipoSaida === 'cavalo' || b.tipoSaida === 'conjunto') r.Status_Cavalo = 'Saiu';
        if (b.tipoSaida === 'carreta' || b.tipoSaida === 'conjunto') r.Status_Carreta = 'Saiu';
        return { success: true };
      }
      return { success: false, error: 'Ação desconhecida' };
    }
  };
}

function servir() {
  return new Promise(ok => {
    const s = http.createServer((req, res) => {
      const arq = path.join(RAIZ, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
      if (!arq.startsWith(RAIZ)) { res.writeHead(403); return res.end(); }
      fs.readFile(arq, (e, buf) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(buf); });
    }).listen(0, () => ok(s));
  });
}

(async () => {
  const { amb, ctrl } = montarBackend();
  const veic = montarVeiculos();
  const servidor = await servir();
  const porta = servidor.address().port;
  const exe = NAVEGADORES.find(p => fs.existsSync(p));
  if (!exe) { console.error('Não achei Edge nem Chrome.'); process.exit(1); }
  const browser = await puppeteer.launch({ executablePath: exe, headless: 'new' });
  let semInternet = false;
  const erros = [];

  async function abrir(largura) {
    const page = await browser.newPage();
    await page.setViewport({ width: largura, height: 860, isMobile: largura < 700, hasTouch: largura < 700 });
    page.on('pageerror', e => erros.push(`@${largura}px ${e.message}`));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_INTERNET_DISCONNECTED|net::ERR_FAILED/.test(m.text())) erros.push(`@${largura}px console: ${m.text()}`); });
    page.on('dialog', d => d.accept());
    await page.setRequestInterception(true);
    page.on('request', req => {
      const u = req.url();
      const cors = { 'Access-Control-Allow-Origin': '*' };
      if (u.startsWith(PJ_URL)) {
        if (semInternet) return req.abort('internetdisconnected');
        amb.relogio(Date.now());
        const corpo = req.method() === 'POST' ? amb.post(JSON.parse(req.postData())) : amb.get(Object.fromEntries(new URL(u).searchParams));
        return req.respond({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(corpo) });
      }
      if (u.includes('script.google.com')) {
        const corpo = req.method() === 'POST' ? veic.post(JSON.parse(req.postData())) : veic.get(new URL(u).searchParams);
        return req.respond({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(corpo) });
      }
      if (/fonts\.googleapis|cdnjs|gstatic/.test(u)) return req.continue();
      req.continue();
    });
    await page.evaluateOnNewDocument(url => { window.__PJ_URL = url; }, PJ_URL);
    await page.goto(`http://localhost:${porta}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { CONFIG.PJ_API_URL = window.__PJ_URL; });
    return page;
  }

  try {
    /* ── Celular (375 px) ── */
    const page = await abrir(375);
    await page.type('#inp-senha', 'teste-1234');
    await page.click('.btn-entrar');
    await page.waitForFunction(() => document.getElementById('app').style.display === 'flex', { timeout: 8000 });
    t('senha do PJ abre a portaria', true, true);

    await page.click('.modulo-btn[data-modulo="pj"]');
    await page.waitForSelector('.pj-card', { timeout: 8000 });
    t('5 cards no mural', await page.$$eval('.pj-card', c => c.length), 5);
    await esperar(800);
    t('fotos carregadas (4 com foto)', await page.$$eval('.pj-foto img.ok', i => i.length), 4);
    t('placar começa em 0/5', await page.$eval('.pj-placar-num', e => e.textContent.replace(/\s/g, '')), '0/5');

    // Entrada da Ana
    await clicar(page, '.pj-card[data-c="PJ_201"] .pj-btn');
    t('card fica verde na hora', await page.$eval('.pj-card[data-c="PJ_201"]', e => e.classList.contains('dentro')), true);
    t('confirmação com Desfazer aparece', await page.$eval('#pj-snack', e => e.classList.contains('visivel')), true);
    await page.waitForFunction(() => !PJ.fila.length && !PJ.enviando, { timeout: 8000 });
    t('servidor gravou a entrada', ctrl.getSheetByName('Registros').getLastRow(), 2);

    // Toque duplo: o segundo é ignorado
    await clicar(page, '.pj-card[data-c="PJ_202"] .pj-btn');
    await clicar(page, '.pj-card[data-c="PJ_202"] .pj-btn');
    await page.waitForFunction(() => !PJ.fila.length && !PJ.enviando, { timeout: 8000 });
    t('toque duplo não vira entrada+saída', await page.$eval('.pj-card[data-c="PJ_202"]', e => e.classList.contains('dentro')), true);
    t('duas linhas no servidor', ctrl.getSheetByName('Registros').getLastRow(), 3);

    // Desfazer
    await esperar(2600);
    await clicar(page, '.pj-card[data-c="PJ_202"] .pj-btn');     // saída do Bruno...
    await page.click('#pj-snack-desfazer');                     // ...desfeita
    await page.waitForFunction(() => !PJ.fila.length && !PJ.enviando, { timeout: 8000 });
    await esperar(600);
    t('Desfazer devolve o Bruno para dentro', await page.$eval('.pj-card[data-c="PJ_202"]', e => e.classList.contains('dentro')), true);

    // Sem internet
    semInternet = true;
    await clicar(page, '.pj-card[data-c="PJ_203"] .pj-btn');
    await esperar(700);
    t('sem internet: card muda mesmo assim', await page.$eval('.pj-card[data-c="PJ_203"]', e => e.classList.contains('dentro')), true);
    t('sem internet: fila guardada no aparelho', await page.evaluate(() => JSON.parse(localStorage.getItem('portaria_pj_fila')).length), 1);
    t('sem internet: aviso no topo', await page.$eval('#pj-sync', e => e.textContent.trim()), '1 aguardando envio');
    if (CAPTURAS) await page.screenshot({ path: path.join(CAPTURAS, 'portaria-pj-375-offline.png'), fullPage: true });
    semInternet = false;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForFunction(() => !PJ.fila.length && !PJ.enviando, { timeout: 8000 });
    t('internet voltou: fila enviada', ctrl.getSheetByName('Registros').getLastRow(), 5);
    t('placar 3/5', await page.$eval('.pj-placar-num', e => e.textContent.replace(/\s/g, '')), '3/5');

    // Busca e filtro
    await page.type('#pj-busca', 'carl');
    t('busca pelo nome', await page.$$eval('.pj-card', c => c.map(x => x.dataset.c)), ['PJ_203']);
    await page.evaluate(() => { const b = document.getElementById('pj-busca'); b.value = ''; b.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.click('.pj-chip[data-filtro="fora"]');
    t('filtro "Fora"', await page.$$eval('.pj-card', c => c.length), 2);
    await page.click('.pj-chip[data-filtro="todos"]');

    // Socorro: o supervisor lança quem fez e quando; só o servidor calcula a faixa e o valor
    await page.click('#pj-soc summary');
    await page.waitForFunction(() => document.querySelectorAll('#pj-soc-pessoa option').length === 6, { timeout: 8000 });
    t('socorro: lista de quem pode ser escolhido (5 PJ + "escolha")', await page.$$eval('#pj-soc-pessoa option', o => o.length), 6);
    t('socorro: o dia já vem preenchido com hoje', await page.$eval('#pj-soc-data', e => !!e.value), true);
    await page.click('#pj-soc-btn');
    t('socorro: sem escolher a pessoa, avisa', await page.$eval('#pj-soc-erro', e => e.textContent), 'Escolha quem fez o socorro.');
    const hm = d => new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
    const fimHM = hm(new Date(Date.now() - 60e3)), iniHM = hm(new Date(Date.now() - 31 * 60e3));
    await page.select('#pj-soc-pessoa', 'PJ_202');
    await page.evaluate((i, f) => {
      [['pj-soc-ini', i], ['pj-soc-fim', f]].forEach(([id, v]) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); });
      document.getElementById('pj-soc-obs').value = 'Teste: caminhão parado';
    }, iniHM, fimHM);
    t('socorro: prévia mostra início, fim e duração', await page.$eval('#pj-soc-previa', e => e.textContent.includes('30 min')), true);
    await page.click('#pj-soc-btn');
    await page.waitForFunction(() => (PJ.socorros || []).length === 1, { timeout: 8000 });
    t('socorro: gravado na aba Socorros', ctrl.getSheetByName('Socorros').getLastRow(), 2);
    t('socorro: aparece na lista com a faixa e sem valor em dinheiro', await page.$eval('#pj-soc-lista', e => [/Bruno/.test(e.textContent), !!e.querySelector('.pj-soc-faixa'), /R\$/.test(e.textContent)]), [true, true, false]);
    t('socorro: formulário limpo depois de lançar', await page.$eval('#pj-soc-ini', e => e.value), '');
    await page.click('.pj-soc-desfazer');
    await page.waitForFunction(() => (PJ.socorros || []).length === 0, { timeout: 8000 });
    t('socorro: desfazer tira da lista', await page.$eval('#pj-soc-n', e => e.textContent), 'nenhum');
    t('socorro: cancelado na planilha', ctrl.getSheetByName('Socorros').getRange(2, 11).getValue(), 'cancelado');
    if (CAPTURAS) await page.screenshot({ path: path.join(CAPTURAS, 'portaria-pj-socorro-375.png'), fullPage: true });

    t('sem rolagem horizontal no celular (PJ)', await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0);
    if (CAPTURAS) await page.screenshot({ path: path.join(CAPTURAS, 'portaria-pj-375.png'), fullPage: true });

    // Recarregar a página: continua no módulo PJ e sem pedir senha de novo
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { CONFIG.PJ_API_URL = window.__PJ_URL; });
    if (await page.$eval('#tela-login', e => e.offsetParent !== null).catch(() => false)) { await page.type('#inp-senha', 'teste-1234'); await page.click('.btn-entrar'); }
    await page.evaluate(() => { if (document.getElementById('app').style.display === 'flex') trocarModulo('pj'); });   // entrou sozinho, antes do teste ligar o endereço do PJ
    await page.waitForSelector('.pj-card', { timeout: 8000 });
    t('aparelho continua liberado e no módulo PJ', await page.$$eval('.pj-card.dentro', c => c.length), 3);

    /* ── Equipamentos ── */
    await page.click('.modulo-btn[data-modulo="equip"]');
    t('não existe mais a opção Conjunto', await page.$$eval('#sel-tipo option', o => o.map(x => x.value).includes('Conjunto')), false);
    await page.select('#sel-tipo', 'Carreta');
    t('um campo de placa só', await page.$$eval('.form-input.placa', i => i.filter(x => x.offsetParent).length), 1);
    t('rótulo da placa acompanha o tipo', await page.$eval('#rotulo-placa', e => e.textContent), 'Placa da carreta');
    await page.type('#inp-placa', 'ccc3c33');
    await clicar(page, '#btn-registrar');
    for (let i = 0; i < 50 && veic.reg.length < 2; i++) await esperar(100);
    const nova = veic.reg[veic.reg.length - 1];
    t('carreta gravada na coluna da carreta', [nova.Tipo_Veiculo, nova.Placa_Cavalo, nova.Placa_Carreta], ['Carreta', '', 'CCC3C33']);

    await page.click('.nav-aba[data-aba="patio"]');
    await page.waitForSelector('.veiculo-card');
    t('nome com HTML aparece como texto (sem injeção)', await page.$eval('.veiculo-card .veiculo-info', e => e.innerHTML.includes('<b>')), false);
    await clicar(page, '.veiculo-card .btn-saida');
    t('conjunto antigo: escolhe cada placa, sem "conjunto completo"', await page.$$eval('.opcao-saida strong', s => s.map(x => x.textContent)), ['Saída do cavalo', 'Saída da carreta']);
    await clicar(page, '.opcao-saida:nth-child(2)');
    await clicar(page, '#btn-confirmar-saida');
    await esperar(700);
    t('saiu só a carreta', [veic.reg[0].Status_Cavalo, veic.reg[0].Status_Carreta], ['No Pátio', 'Saiu']);
    t('sem rolagem horizontal no celular (equipamentos)', await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0);
    if (CAPTURAS) await page.screenshot({ path: path.join(CAPTURAS, 'portaria-equip-375.png'), fullPage: true });
    await page.close();

    /* ── Tablet/computador (1024 px) ── */
    if (CAPTURAS) {
      const p2 = await abrir(1024);
      await p2.type('#inp-senha', 'teste-1234'); await p2.click('.btn-entrar');
      await p2.evaluate(() => { trocarModulo('pj'); });
      await p2.waitForSelector('.pj-card', { timeout: 8000 });
      await esperar(900);
      await p2.screenshot({ path: path.join(CAPTURAS, 'portaria-pj-1024.png'), fullPage: true });
      await p2.close();
    }
  } catch (e) {
    falhas.push('parou depois de "' + ultimoT + '": ' + String(e.stack || e.message).split('\n').slice(0, 4).join(' / '));
  } finally {
    await browser.close();
    servidor.close();
  }

  erros.forEach(e => falhas.push('erro de JavaScript ' + e));
  if (falhas.length) { console.log('FALHOU:\n  ' + falhas.join('\n  ')); process.exit(1); }
  console.log(`OK — ${ok} verificações no navegador, nenhum erro de JavaScript.`);
})();
