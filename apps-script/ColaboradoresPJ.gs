/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  BACKEND — Colaboradores PJ (portaria) + Hora Extra PJ (portal de gestão)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Projeto Apps Script SEPARADO do da portaria de veículos e com planilha de
 *  controle PRÓPRIA. A planilha do RH é só lida (lista de PJ ativos); nada é
 *  gravado nela.
 *
 *  Quem conversa com este backend:
 *    - portaria (portaria.renovatruck.com.br)  → mural de cards, entrada/saída
 *    - portal de gestão (módulo Hora Extra PJ)  → espelho, aprovação, fechamento
 *
 *  COMO PUBLICAR: passo a passo em apps-script/LEIA-ME-colaboradores-pj.md.
 *  Resumo: planilha nova → Extensões → Apps Script → colar este arquivo →
 *  recarregar a planilha → menu "Renova PJ" → Instalar → Implantar como
 *  App da Web (Executar como: Eu · Acesso: Qualquer pessoa).
 *
 *  QUANDO ESTE ARQUIVO MUDAR: colar a versão nova e usar Implantar →
 *  Gerenciar implantações → editar (lápis) → Versão: Nova versão.
 *
 *  O QUE ESTE CÓDIGO GARANTE (e os testes em ferramentas/ provam):
 *   1. Nenhum link, senha ou ID fica neste arquivo: o repositório é público.
 *      Tudo isso mora na aba Config da planilha de controle, que é privada.
 *   2. Da planilha do RH só saem nome, cargo, departamento e horário. CPF,
 *      salário e endereço nunca são enviados para tela nenhuma.
 *   3. O horário do registro vale mesmo sem internet e com o relógio do
 *      aparelho errado: o servidor usa o próprio relógio menos a "idade" do
 *      toque medida pelo aparelho (diferença no mesmo relógio não erra).
 *   4. Mandar o mesmo registro duas vezes não duplica (cada toque tem um id).
 *   5. Registros nunca são apagados: correção cancela a linha e cria outra, e
 *      tudo que o RH muda fica na aba Auditoria.
 *   6. Leitura proporcional ao que se pede, não ao histórico: a portaria lê só
 *      o fim da aba Registros; o espelho lê só o bloco do mês.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const PJ_VERSAO = 1;
const PJ_FUSO = 'America/Sao_Paulo';

// Quem emite a sessão do portal é o backend do Manual da Empresa (o mesmo que
// Contas a Pagar/Receber e Ordens de Serviço consultam).
const PJ_API_LOGIN_PORTAL = 'https://script.google.com/macros/s/AKfycbxmdLCRPZwf6u7l8BnbtqbomFRcjplzJOKCeNWSTRNCKq8M9NtO2uWO7DjEP-xN7WBkkg/exec';

const PJ_ABA = { REG: 'Registros', CFG: 'Config', PES: 'Pessoas', HE: 'HoraExtra', FER: 'Feriados', AUD: 'Auditoria', SOC: 'Socorros' };

// A ordem das colunas é contrato com o resto do código: só acrescente no FIM.
const PJ_CAB = {
  REG: ['id', 'codigo', 'nome', 'tipo', 'data_hora', 'dia', 'origem', 'usuario', 'recebido_em', 'status', 'obs', 'ref'],
  CFG: ['chave', 'valor', 'para_que_serve'],
  PES: ['codigo', 'controle', 'horario', 'foto', 'apelido', 'obs', 'atualizado_por', 'atualizado_em'],
  HE:  ['chave', 'codigo', 'nome', 'dia', 'calc_ss', 'calc_df', 'aprov_ss', 'aprov_df', 'valor_ss', 'valor_df', 'status', 'decidido_por', 'decidido_em', 'obs'],
  FER: ['data', 'descricao'],
  AUD: ['quando', 'usuario', 'acao', 'alvo', 'detalhe'],
  // Socorro = atividade extra paga por atendimento. O valor e a faixa ficam GRAVADOS na hora do
  // lançamento: mudar a tabela de preços depois não mexe no que já foi lançado.
  SOC: ['id', 'codigo', 'nome', 'inicio', 'fim', 'dia', 'faixa', 'valor', 'usuario', 'recebido_em', 'status', 'obs', 'ref']
};

// chave, valor inicial, explicação (vai para a coluna C da aba Config).
const PJ_CFG_PADRAO = [
  ['planilha_rh', '', 'Link da planilha do RH que tem a lista de colaboradores. Só é lida, nunca alterada.'],
  ['aba_rh', 'colaboradores e PJ', 'Nome da aba com a lista de colaboradores dentro da planilha do RH.'],
  ['pasta_fotos', '', 'Link da pasta do Google Drive com as fotos dos colaboradores.'],
  ['senha_portaria', '', 'Senha que o porteiro digita para entrar no sistema da portaria. Trocar aqui derruba os aparelhos já logados.'],
  ['usuarios_rh', '', 'Logins do portal de gestão (separados por vírgula) que podem usar o módulo Hora Extra PJ, além dos administradores.'],
  ['prefixos_ignorados', 'PRO_', 'Códigos do RH que começam assim ficam fora do controle (PRO_ = pró-labore dos sócios). Separe por vírgula.'],
  ['valor_hora_seg_sab', 25, 'R$ por hora extra de segunda a sábado.'],
  ['valor_hora_dom_feriado', 35, 'R$ por hora extra em domingo e feriado.'],
  ['tolerancia_min', 10, 'Minutos de tolerância. Até aqui não conta hora extra (nem atraso); passou, conta tudo.'],
  ['bloco_min', 1, 'Arredondamento para baixo, em minutos. 1 = minuto a minuto; 15 = só blocos de 15 min.'],
  ['conta_antes_do_horario', 'Não', 'Sim = chegar antes do horário também conta como hora extra.'],
  ['compensa_falta_no_dia', 'Sim', 'Sim = atraso ou almoço mais longo no mesmo dia são abatidos da hora extra.'],
  ['desconta_intervalo_dia_livre', 'Sim', 'Sim = em dia sem expediente (domingo, feriado), quem fica mais de 6h seguidas tem o intervalo de almoço descontado.'],
  ['exige_aprovacao', 'Sim', 'Sim = a hora extra só entra no fechamento depois de aprovada pelo RH.'],
  ['horas_max_aberto', 16, 'Depois de quantas horas uma entrada sem saída passa a ser tratada como "saída não registrada".'],
  ['evento_seg_sab', 'Gratificação segunda a sabado/hora', 'Nome do evento usado na aba "movimentações" da planilha do RH (segunda a sábado).'],
  ['evento_dom_feriado', 'Gratificação domingos e feriados/hora', 'Nome do evento usado na aba "movimentações" da planilha do RH (domingo e feriado).'],
  ['jornada_padrao', '', 'Horário usado para quem está sem horário na planilha do RH. Ex.: Seg a Sex 08:00 as 17:00 com 1H intervalo'],
  ['jornada_unidade', 'Seg a Sex 08:00 as 17:00 com 1H intervalo e Sab 08:00 as 12:00', 'Horário da unidade da portaria (Jacareí), conforme o comunicado do RH aos PJ. O intervalo de 1h é presumido: o comunicado não o cita.'],
  ['jornada_unidade_prevalece', 'Sim', 'Sim = o horário da unidade vale para todos da portaria, no lugar do horário da planilha do RH. Um horário digitado à mão para a pessoa (aba Pessoas) continua valendo.'],
  ['codigos_excluidos', 'PJ_024,PJ_025', 'Códigos do RH que ficam fora da portaria por decisão da gestão (separe por vírgula). Hoje: um híbrido e uma equipe de Guarulhos. Se a pessoa for marcada "Incluir" na aba Pessoas, volta.'],
  ['valor_socorro_dia', 100, 'R$ por atendimento de socorro de segunda a sábado, quando o atendimento termina até o horário de corte da noite.'],
  ['valor_socorro_noite', 120, 'R$ por atendimento de socorro de segunda a sábado que termina depois do horário de corte da noite.'],
  ['valor_socorro_dom_feriado', 120, 'R$ por atendimento de socorro que termina em domingo ou feriado.'],
  ['socorro_noite_apos', '22:00', 'Horário de corte: socorro que termina DEPOIS dele (segunda a sábado) paga o valor da noite.'],
  ['socorro_madrugada_ate', '06:00', 'Socorro que termina de madrugada, até este horário, também paga o valor da noite (a faixa noturna atravessa a meia-noite). CONFIRMAR com o RH.']
];

// Chaves que o portal pode alterar (as demais só na própria planilha).
const PJ_CFG_EDITAVEL = ['usuarios_rh', 'prefixos_ignorados', 'valor_hora_seg_sab', 'valor_hora_dom_feriado',
  'tolerancia_min', 'bloco_min', 'conta_antes_do_horario', 'compensa_falta_no_dia', 'desconta_intervalo_dia_livre',
  'exige_aprovacao', 'horas_max_aberto', 'evento_seg_sab', 'evento_dom_feriado', 'jornada_padrao',
  'jornada_unidade', 'jornada_unidade_prevalece', 'codigos_excluidos', 'valor_socorro_dia', 'valor_socorro_noite',
  'valor_socorro_dom_feriado', 'socorro_noite_apos', 'socorro_madrugada_ate'];

// Memória da execução atual: evita abrir a mesma planilha/aba mais de uma vez.
let _pj = {};

/* ═════════════════════════════════════════════════════════════════════════════
   1. TEXTO, NÚMERO E DATA
   Horário é tratado como "hora de parede" de São Paulo, em minutos inteiros.
   O Brasil não tem horário de verão desde 2019, então a conta é direta.
   ═════════════════════════════════════════════════════════════════════════════ */

function pjNorm(s) {
  return String(s === null || s === undefined ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}
function pjSim(v) { return /^(sim|s|true|1|x|yes)$/.test(pjNorm(v)); }
function pjEhData(v) { return Object.prototype.toString.call(v) === '[object Date]'; }

/** Aceita 25, "25", "25,50", "R$ 1.234,56". */
function pjNum(v, padrao) {
  if (typeof v === 'number') return isFinite(v) ? v : padrao;
  const s = String(v === null || v === undefined ? '' : v).replace(/[^\d,.\-]/g, '');
  if (!s) return padrao;
  const n = Number(s.indexOf(',') >= 0 ? s.replace(/\./g, '').replace(',', '.') : s);
  return isFinite(n) ? n : padrao;
}
function pjDinheiro(v) { return Math.round((v + 1e-9) * 100) / 100; }
function pj2(n) { return (n < 10 ? '0' : '') + n; }

/** Minutos → "HH:mm" (dá a volta depois da meia-noite). */
function pjHM(min) {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return pj2(Math.floor(m / 60)) + ':' + pj2(m % 60);
}
function pjDuracao(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return h ? (h + 'h' + (m ? pj2(m) : '')) : (m + 'min');
}

/** 'yyyy-MM-dd' → minutos desde 1970 à meia-noite daquele dia. */
function pjAbsDia(dia) {
  const p = String(dia).split('-');
  return Date.UTC(+p[0], +p[1] - 1, +p[2]) / 60000;
}
/** 'yyyy-MM-dd HH:mm[:ss]' → minutos desde 1970 (segundos descartados). */
function pjAbs(dataHora) {
  const m = String(dataHora).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3]) / 60000 + (+m[4]) * 60 + (+m[5]);
}
function pjDiaDeAbs(abs) {
  const d = new Date(Math.floor(abs / 1440) * 1440 * 60000);
  return d.getUTCFullYear() + '-' + pj2(d.getUTCMonth() + 1) + '-' + pj2(d.getUTCDate());
}
function pjSomaDias(dia, n) { return pjDiaDeAbs(pjAbsDia(dia) + n * 1440); }
function pjDow(dia) { return new Date(pjAbsDia(dia) * 60000).getUTCDay(); }
function pjUltimoDiaMes(mes) {
  const p = mes.split('-');
  return mes + '-' + pj2(new Date(Date.UTC(+p[0], +p[1], 0)).getUTCDate());
}

function pjAgoraMs() { return Date.now(); }
function pjLocal(ms) { return Utilities.formatDate(new Date(ms), PJ_FUSO, 'yyyy-MM-dd HH:mm:ss'); }

/** Célula → texto. Se a planilha tiver convertido para data, devolve no padrão do sistema. */
function pjTexto(v) {
  if (pjEhData(v)) return Utilities.formatDate(v, pjFusoPlanilha(), 'yyyy-MM-dd HH:mm:ss');
  return String(v === null || v === undefined ? '' : v).trim();
}
/** Data digitada de qualquer jeito (25/12/2026, 2026-12-25 ou célula de data) → 'yyyy-MM-dd'. */
function pjParseData(v) {
  if (pjEhData(v)) return Utilities.formatDate(v, pjFusoPlanilha(), 'yyyy-MM-dd');
  const s = String(v === null || v === undefined ? '' : v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return m[1] + '-' + pj2(+m[2]) + '-' + pj2(+m[3]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return m[3] + '-' + pj2(+m[2]) + '-' + pj2(+m[1]);
  return '';
}
function pjDiaBR(dia) { const p = String(dia).split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }

/** Tira o ID de um link do Google (planilha, pasta ou arquivo). Aceita o ID puro. */
function pjExtrairId(v) {
  const s = String(v === null || v === undefined ? '' : v).trim();
  const m = s.match(/\/d\/([a-zA-Z0-9_-]{20,})/) || s.match(/\/folders\/([a-zA-Z0-9_-]{20,})/) ||
            s.match(/[?&]id=([a-zA-Z0-9_-]{20,})/) || s.match(/^([a-zA-Z0-9_-]{20,})$/);
  return m ? m[1] : '';
}

/** "Francisco das Chagas de Oliveira Filho" → "Francisco das Chagas". */
function pjNomeCurto(nome) {
  const p = String(nome || '').trim().split(/\s+/).filter(Boolean);
  if (p.length <= 2) return p.join(' ');
  if (/^(da|de|do|das|dos|e)$/i.test(p[1]) && p[2]) return p[0] + ' ' + p[1] + ' ' + p[2];
  return p[0] + ' ' + p[1];
}

function pjErro(cod, msg) { const e = new Error(msg); e.cod = cod; return e; }

/* ═════════════════════════════════════════════════════════════════════════════
   2. JORNADA — lê o horário em texto livre da planilha do RH
   Ex.: "Seg a Qui 08:00 as 18:00 Sex 08:00 as 17:00 com 1H intervalo e Sab 08:00 as 12:00"
   ═════════════════════════════════════════════════════════════════════════════ */

const PJ_DIA_TOKEN = { dom: 0, domingo: 0, seg: 1, segunda: 1, ter: 2, terca: 2, qua: 3, quarta: 3,
                       qui: 4, quinta: 4, sex: 5, sexta: 5, sab: 6, sabado: 6 };

function pjParseJornada(texto) {
  const bruto = String(texto === null || texto === undefined ? '' : texto).trim();
  const out = { texto: bruto, ok: false, hibrido: false, dias: {}, intervaloMin: 0, intervaloPresumido: false, resumo: '' };
  if (!bruto) return out;
  let s = ' ' + pjNorm(bruto).replace(/\s+/g, ' ') + ' ';
  if (/hibrid|home ?office|remot/.test(s)) { out.hibrido = true; out.resumo = 'Híbrido'; return out; }

  // 1) Intervalo: "com 1H intervalo", "1h30 de almoço", "intervalo de 30 min".
  //    Sai do texto antes de ler os horários, para o "1H" não virar 01:00.
  const PAUSA = '(?:intervalo|almoco|descanso|refeicao)';
  const HORA = '(?:horas|hora|hrs|hr|hs|h)';
  const MINU = '(?:minutos|mins|min|m)';
  const padroes = [
    new RegExp(PAUSA + '\\s*(?:de\\s+)?(\\d{1,2})\\s*' + HORA + '\\s*(?:e\\s*)?(\\d{1,2})?\\s*' + MINU + '?\\b'),
    new RegExp(PAUSA + '\\s*(?:de\\s+)?()(\\d{1,3})\\s*' + MINU + '\\b'),
    new RegExp('(\\d{1,2})\\s*' + HORA + '\\s*(?:e\\s*)?(\\d{1,2})?\\s*' + MINU + '?\\s*(?:de\\s+|para\\s+|p/\\s*)?' + PAUSA),
    new RegExp('()(\\d{1,3})\\s*' + MINU + '\\s*(?:de\\s+|para\\s+|p/\\s*)?' + PAUSA)
  ];
  let intervalo = null;
  for (let k = 0; k < padroes.length; k++) {
    const m = s.match(padroes[k]);
    if (!m) continue;
    const v = (m[1] ? +m[1] * 60 : 0) + (m[2] ? +m[2] : 0);
    if (v > 0 && v <= 180) { intervalo = v; s = s.replace(m[0], ' '); }
    break;
  }

  // 2) Quebra em peças: hora, dia da semana, conector.
  const re = /(\d{1,2})\s*(?::|h)\s*(\d{2})|(\d{1,2})\s*h(?:oras|ora|rs|s)?\b|\b(domingo|dom|segunda|seg|terca|ter|quarta|qua|quinta|qui|sexta|sex|sabado|sab)(?:-?feiras?|s)?\b|\b(as|a|ate|e)\b|([-–—,;\/])|\b(\d{1,2})\b/g;
  const toks = [];
  let m;
  while ((m = re.exec(s))) {
    if (m[1] !== undefined) { if (+m[1] <= 24 && +m[2] < 60) toks.push({ k: 'T', v: +m[1] * 60 + (+m[2]) }); }
    else if (m[3] !== undefined) { if (+m[3] <= 24) toks.push({ k: 'T', v: +m[3] * 60 }); }
    else if (m[4] !== undefined) toks.push({ k: 'D', v: PJ_DIA_TOKEN[m[4]] });
    else if (m[5] !== undefined) toks.push({ k: 'C', v: m[5] === 'e' ? 'e' : 'a' });
    else if (m[6] !== undefined) toks.push({ k: 'C', v: /[-–—]/.test(m[6]) ? 'a' : 'e' });
    else if (m[7] !== undefined) { if (+m[7] <= 24) toks.push({ k: 'T', v: +m[7] * 60, solto: true }); }
  }

  // 3) Anda pelas peças: um grupo de dias recebe a faixa de horário que vem depois.
  let pend = [], ultimo = null, i = 0;
  while (i < toks.length) {
    const t = toks[i];
    if (t.k === 'D') {
      const grupo = [t.v];
      let j = i + 1;
      for (;;) {
        const c = toks[j], n = toks[j + 1];
        if (c && c.k === 'C' && n && n.k === 'D') {
          if (c.v === 'a') { let d = grupo[grupo.length - 1], guarda = 0; while (d !== n.v && guarda++ < 7) { d = (d + 1) % 7; grupo.push(d); } }
          else grupo.push(n.v);
          j += 2;
        } else if (c && c.k === 'D') { grupo.push(c.v); j += 1; }
        else break;
      }
      pend = pend.concat(grupo);
      i = j;
      continue;
    }
    if (t.k === 'T') {
      let fimTok = null, salto = 0;
      const c = toks[i + 1], n = toks[i + 2];
      if (c && c.k === 'C' && c.v === 'a' && n && n.k === 'T') { fimTok = n; salto = 3; }
      else if (c && c.k === 'T' && !t.solto && !c.solto) { fimTok = c; salto = 2; }
      if (!fimTok) { i++; continue; }
      const ini = t.v;
      let fim = fimTok.v;
      if (fim <= ini) fim += 1440;                       // turno que vira a noite
      if (fim - ini > 16 * 60) { i += salto; continue; } // faixa absurda: ignora
      if (pend.length) {
        pend.forEach(function (d) { out.dias[d] = { ini: ini, fim: fim }; });
        ultimo = pend; pend = [];
      } else if (ultimo) {
        // Segundo período do mesmo grupo ("08:00 as 12:00 e 13:00 as 17:00"): o vão vira intervalo.
        ultimo.forEach(function (d) {
          const a = out.dias[d];
          if (a && ini >= a.fim) { a.pausa = (a.pausa || 0) + (ini - a.fim); a.fim = fim; }
        });
      } else {
        ultimo = [1, 2, 3, 4, 5];                        // nenhum dia citado: segunda a sexta
        ultimo.forEach(function (d) { out.dias[d] = { ini: ini, fim: fim }; });
      }
      i += salto;
      continue;
    }
    i++;
  }

  const dias = Object.keys(out.dias);
  if (!dias.length) return out;
  dias.forEach(function (d) {
    const j = out.dias[d], vao = j.fim - j.ini;
    if (j.pausa) { j.intervalo = j.pausa; delete j.pausa; }
    else if (vao > 360) { j.intervalo = intervalo !== null ? intervalo : 60; if (intervalo === null) out.intervaloPresumido = true; }
    else j.intervalo = 0;                                // até 6h de expediente não tem intervalo
    if (j.intervalo >= vao) j.intervalo = 0;
  });
  out.intervaloMin = Math.max.apply(null, dias.map(function (d) { return out.dias[d].intervalo; }));
  out.ok = true;
  out.resumo = pjResumoJornada(out);
  return out;
}

function pjResumoJornada(j) {
  const nomes = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'], ordem = [1, 2, 3, 4, 5, 6, 0], partes = [];
  let k = 0;
  while (k < ordem.length) {
    const d = ordem[k], a = j.dias[d];
    if (!a) { k++; continue; }
    let f = k;
    while (f + 1 < ordem.length && j.dias[ordem[f + 1]] && j.dias[ordem[f + 1]].ini === a.ini && j.dias[ordem[f + 1]].fim === a.fim) f++;
    partes.push((f > k ? nomes[d] + '–' + nomes[ordem[f]] : nomes[d]) + ' ' + pjHM(a.ini) + '–' + pjHM(a.fim));
    k = f + 1;
  }
  if (j.intervaloMin) partes.push('intervalo ' + pjDuracao(j.intervaloMin) + (j.intervaloPresumido ? ' (presumido)' : ''));
  return partes.join(' · ');
}

/* ═════════════════════════════════════════════════════════════════════════════
   3. FERIADOS — os nacionais são sugeridos na instalação; a aba Feriados manda
   ═════════════════════════════════════════════════════════════════════════════ */

/** Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher). */
function pjPascoa(ano) {
  const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100, d = Math.floor(b / 4), e = b % 4,
        f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30,
        i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7,
        mm = Math.floor((a + 11 * h + 22 * l) / 451),
        mes = Math.floor((h + l - 7 * mm + 114) / 31), dia = ((h + l - 7 * mm + 114) % 31) + 1;
  return ano + '-' + pj2(mes) + '-' + pj2(dia);
}

/** Feriados nacionais + 9 de julho (estado de SP). Carnaval e Corpus Christi são ponto facultativo: ficam de fora. */
function pjFeriadosSugeridos(ano) {
  const fixo = function (mmdd, nome) { return { data: ano + '-' + mmdd, descricao: nome }; };
  return [
    fixo('01-01', 'Confraternização Universal'),
    { data: pjSomaDias(pjPascoa(ano), -2), descricao: 'Sexta-feira Santa' },
    fixo('04-21', 'Tiradentes'),
    fixo('05-01', 'Dia do Trabalho'),
    fixo('07-09', 'Revolução Constitucionalista (SP)'),
    fixo('09-07', 'Independência do Brasil'),
    fixo('10-12', 'Nossa Senhora Aparecida'),
    fixo('11-02', 'Finados'),
    fixo('11-15', 'Proclamação da República'),
    fixo('11-20', 'Consciência Negra'),
    fixo('12-25', 'Natal')
  ].sort(function (x, y) { return x.data < y.data ? -1 : 1; });
}

/* ═════════════════════════════════════════════════════════════════════════════
   4. MOTOR — sessões (entrada→saída) e cálculo da hora extra de um dia
   Funções puras: não tocam em planilha. São as que os testes mais exercitam.
   ═════════════════════════════════════════════════════════════════════════════ */

function pjSobrepor(a, b, x, y) { return Math.max(0, Math.min(b, y) - Math.max(a, x)); }

/** Junta intervalos [ini, fim] que se tocam ou se sobrepõem. */
function pjUnirIntervalos(lista) {
  const o = lista.filter(function (x) { return x[1] > x[0]; }).sort(function (x, y) { return x[0] - y[0]; }), out = [];
  o.forEach(function (x) {
    const u = out[out.length - 1];
    if (u && x[0] <= u[1]) u[1] = Math.max(u[1], x[1]); else out.push([x[0], x[1]]);
  });
  return out;
}

/**
 * Minutos de hora extra que o socorro "engole". Socorro é atividade extra paga por
 * atendimento: dentro do atendimento a pessoa recebe SÓ o socorro, nunca socorro +
 * hora extra. Só conta o que já seria extra: dentro do expediente nada é absorvido
 * (aquilo não era hora extra). `J` null = dia sem expediente, tudo seria extra.
 */
function pjSocorroAbsorvido(trechos, soc, J, contaAntes) {
  if (!soc.length) return 0;
  let tot = 0;
  trechos.forEach(function (b) {
    const regioes = [];
    if (!J) regioes.push([b[0], b[1]]);
    else {
      if (contaAntes && b[0] < J.ini) regioes.push([b[0], Math.min(b[1], J.ini)]);
      if (b[1] > J.fim) regioes.push([Math.max(b[0], J.fim), b[1]]);
    }
    regioes.forEach(function (g) { soc.forEach(function (s) { tot += pjSobrepor(g[0], g[1], s[0], s[1]); }); });
  });
  return tot;
}

/**
 * Casa entradas com saídas de UMA pessoa. Tolera o que a vida real produz:
 * duas entradas seguidas (saída esquecida), saída sem entrada, saída depois
 * da meia-noite. `maxAbertoMin` é o limite para uma saída ainda fechar a entrada.
 */
function pjMontarSessoes(eventos, maxAbertoMin) {
  const ev = eventos.slice().sort(function (x, y) { return (x.abs - y.abs) || (x.ordem - y.ordem); });
  const out = [];
  let ab = null;
  ev.forEach(function (e) {
    if (e.tipo === 'ENTRADA') {
      if (ab) out.push({ e: ab, s: null, falha: 'sem_saida' });
      ab = e;
    } else if (ab && e.abs - ab.abs <= maxAbertoMin) {
      out.push({ e: ab, s: e });
      ab = null;
    } else {
      if (ab) { out.push({ e: ab, s: null, falha: 'sem_saida' }); ab = null; }
      out.push({ e: null, s: e, falha: 'sem_entrada' });
    }
  });
  if (ab) out.push({ e: ab, s: null, aberta: true });
  return out;
}

/**
 * Hora extra de um dia.
 *
 * Dia COM expediente: extra = tempo depois do horário (+ antes, se a regra
 * mandar) − o que faltou dentro do horário (atraso, almoço mais longo).
 * Quem não registra a saída para o almoço tem o intervalo contratual
 * presumido — por isso ficar o dia inteiro sem bater almoço não gera extra.
 *
 * Dia SEM expediente (domingo, feriado, sábado de quem não trabalha sábado):
 * tudo que foi trabalhado é extra.
 *
 * O valor usa o tipo de cada dia do calendário: quem entra no sábado e sai
 * no domingo de madrugada recebe a parte do domingo pela tabela de domingo.
 */
function pjCalcularDia(p) {
  const base = pjAbsDia(p.dia), R = p.regras;
  const r = { trabalhadoMin: 0, previstoMin: 0, faltaMin: 0, antesMin: 0, depoisMin: 0, intervaloDescontadoMin: 0,
              extraBrutoMin: 0, extraMin: 0, minSS: 0, minDF: 0, valorSS: 0, valorDF: 0, valor: 0,
              socorroAbsorvidoMin: 0, incompleto: false, emAndamento: false, semJornada: false, diaLivre: false };

  let blocos = [];
  p.sessoes.forEach(function (s) {
    if (s.e && s.s) blocos.push([s.e.abs - base, s.s.abs - base]);
    else if (s.e && s.aberta && p.agoraAbs !== null && p.agoraAbs !== undefined && p.agoraAbs - s.e.abs <= R.maxAbertoMin) {
      r.emAndamento = true;
      blocos.push([s.e.abs - base, Math.max(s.e.abs, p.agoraAbs) - base]);
    } else r.incompleto = true;
  });
  blocos = blocos.filter(function (b) { return b[1] > b[0]; }).sort(function (x, y) { return x[0] - y[0]; });
  const trechos = [];
  blocos.forEach(function (b) {
    const u = trechos[trechos.length - 1];
    if (u && b[0] <= u[1]) u[1] = Math.max(u[1], b[1]); else trechos.push([b[0], b[1]]);
  });
  r.trabalhadoMin = trechos.reduce(function (t, b) { return t + (b[1] - b[0]); }, 0);

  if (!p.temJornada) { r.semJornada = true; return r; }

  // Socorro (relativo à meia-noite deste dia), já sem sobreposição entre eles.
  const soc = pjUnirIntervalos((p.socorros || []).map(function (s) { return [s[0] - base, s[1] - base]; }));
  r.socorroAbsorvidoMin = 0;

  const J = p.jornadaDia;   // null = dia sem expediente para esta pessoa (ou feriado)
  let liquido, amanha;
  if (J) {
    let dentro = 0, maior = 0, pausaFeita = 0, fimAnterior = null;
    trechos.forEach(function (b) {
      const a = Math.max(b[0], J.ini), z = Math.min(b[1], J.fim);
      if (z > a) {
        dentro += z - a;
        if (z - a > maior) maior = z - a;
        if (fimAnterior !== null) pausaFeita += a - fimAnterior;
        fimAnterior = z;
      }
      r.antesMin += pjSobrepor(b[0], b[1], -1e9, J.ini);
      r.depoisMin += pjSobrepor(b[0], b[1], J.fim, 1e9);
    });
    // Intervalo presumido: só a parte do almoço que a pessoa NÃO registrou.
    const pausa = (J.intervalo > 0 && maior > 360) ? Math.max(0, J.intervalo - pausaFeita) : 0;
    r.intervaloDescontadoMin = pausa;
    r.previstoMin = (J.fim - J.ini) - (J.intervalo || 0);
    r.faltaMin = Math.max(0, r.previstoMin - Math.min(dentro - pausa, r.previstoMin));
    r.socorroAbsorvidoMin = pjSocorroAbsorvido(trechos, soc, J, R.contaAntes);
    r.extraBrutoMin = Math.max(0, r.depoisMin + (R.contaAntes ? r.antesMin : 0) - r.socorroAbsorvidoMin);
    const abate = (R.compensa && r.faltaMin > R.toleranciaMin) ? r.faltaMin : 0;
    liquido = Math.max(0, r.extraBrutoMin - abate);
    amanha = trechos.reduce(function (t, b) { return t + pjSobrepor(b[0], b[1], Math.max(J.fim, 1440), 1e9); }, 0);
  } else {
    r.diaLivre = true;
    let maior = 0, pausaFeita = 0;
    trechos.forEach(function (b, k) {
      if (b[1] - b[0] > maior) maior = b[1] - b[0];
      if (k) pausaFeita += b[0] - trechos[k - 1][1];
    });
    const pausa = (R.descontaIntervaloLivre && maior > 360) ? Math.max(0, (p.intervaloPadraoMin || 60) - pausaFeita) : 0;
    r.intervaloDescontadoMin = pausa;
    r.socorroAbsorvidoMin = pjSocorroAbsorvido(trechos, soc, null, false);
    r.extraBrutoMin = Math.max(0, r.trabalhadoMin - r.socorroAbsorvidoMin);
    liquido = Math.max(0, r.extraBrutoMin - pausa);
    amanha = trechos.reduce(function (t, b) { return t + pjSobrepor(b[0], b[1], 1440, 1e9); }, 0);
  }

  // Entrada sem saída (ou saída sem entrada): não dá para pagar com segurança. O RH corrige antes.
  if (r.incompleto) return r;

  if (liquido <= R.toleranciaMin) liquido = 0;
  if (R.blocoMin > 1) liquido = Math.floor(liquido / R.blocoMin) * R.blocoMin;

  // O que foi abatido sai do começo do extra; a parte depois da meia-noite é a última a cair.
  const extraAmanha = Math.min(amanha, liquido), extraHoje = liquido - extraAmanha;
  r.extraMin = liquido;
  r.minSS = (p.tipoHoje === 'SS' ? extraHoje : 0) + (p.tipoAmanha === 'SS' ? extraAmanha : 0);
  r.minDF = liquido - r.minSS;
  r.valorSS = pjDinheiro(r.minSS / 60 * R.valorSS);
  r.valorDF = pjDinheiro(r.minDF / 60 * R.valorDF);
  r.valor = pjDinheiro(r.valorSS + r.valorDF);
  return r;
}

function pjTipoDia(dia, feriados) { return (pjDow(dia) === 0 || feriados[dia]) ? 'DF' : 'SS'; }

/**
 * Monta o mês inteiro de todas as pessoas.
 * ctx: { pessoas, eventos (só status ok, do dia anterior ao mês até o dia seguinte),
 *        decisoes {codigo|dia → linha}, feriados {dia → nome}, regras, agora, inicioControle }
 */
function pjMontarMes(mes, ctx) {
  const R = ctx.regras, agoraAbs = pjAbs(ctx.agora), hoje = ctx.agora.slice(0, 10);
  const primeiro = mes + '-01', ultimoDoMes = pjUltimoDiaMes(mes);
  const limite = ultimoDoMes < hoje ? ultimoDoMes : hoje;

  const porCodigo = {};
  ctx.eventos.forEach(function (e) { (porCodigo[e.codigo] = porCodigo[e.codigo] || []).push(e); });

  const socPorCodigo = {};
  (ctx.socorros || []).forEach(function (s) { (socPorCodigo[s.codigo] = socPorCodigo[s.codigo] || []).push(s); });

  const saida = [];
  ctx.pessoas.forEach(function (p) {
    const sess = pjMontarSessoes(porCodigo[p.codigo] || [], R.maxAbertoMin);
    const socsPessoa = socPorCodigo[p.codigo] || [];
    const socIntervalos = socsPessoa.map(function (s) { return [pjAbs(s.inicio), pjAbs(s.fim)]; });
    const socsDoMes = socsPessoa.filter(function (s) { return s.dia.slice(0, 7) === mes; });
    const porDia = {};
    sess.forEach(function (s) {
      const d = pjDiaDeAbs((s.e || s.s).abs);
      (porDia[d] = porDia[d] || []).push(s);
    });

    const dias = [];
    const tot = { trabalhadoMin: 0, extraCalcMin: 0, minSS: 0, minDF: 0, valorSS: 0, valorDF: 0, valor: 0,
                  pendentes: 0, pendenteMin: 0, pendenteValor: 0, incompletos: 0, divergentes: 0, diasComRegistro: 0,
                  socorroAbsorvidoMin: 0, socorroQtd: 0, socorroValor: 0 };
    const desde = [ctx.inicioControle || '', p.admissao || ''].sort().pop();

    for (let d = primeiro; d <= limite; d = pjSomaDias(d, 1)) {
      const S = porDia[d] || [], dec = ctx.decisoes[p.codigo + '|' + d] || null;
      const feriado = ctx.feriados[d] || null, dow = pjDow(d);
      const jd = (p.jornada.ok && !feriado) ? (p.jornada.dias[dow] || null) : null;

      if (!S.length && !(dec && dec.status !== 'PENDENTE')) {
        // Dia de expediente que já passou sem nenhum registro: só informa, não desconta nada.
        if (jd && d < hoje && p.naPortaria && desde && d >= desde) {
          dias.push({ dia: d, dow: dow, tipo: 'SS', feriado: null, jornada: [pjHM(jd.ini), pjHM(jd.fim), jd.intervalo],
                      sessoes: [], semRegistro: true });
        }
        continue;
      }

      const c = pjCalcularDia({
        dia: d, sessoes: S, jornadaDia: jd, temJornada: p.jornada.ok, intervaloPadraoMin: p.jornada.intervaloMin || 60,
        tipoHoje: pjTipoDia(d, ctx.feriados), tipoAmanha: pjTipoDia(pjSomaDias(d, 1), ctx.feriados),
        regras: R, agoraAbs: agoraAbs, socorros: socIntervalos
      });

      // O que vale para o fechamento.
      const ef = { minSS: 0, minDF: 0, valorSS: 0, valorDF: 0, valor: 0, estado: '' };
      let decOut = null;
      if (dec && dec.status !== 'PENDENTE') {
        decOut = { status: dec.status, minSS: dec.aprovSS, minDF: dec.aprovDF, valor: pjDinheiro(dec.valorSS + dec.valorDF),
                   por: dec.por, em: dec.em, obs: dec.obs,
                   diverge: dec.status === 'APROVADO' && !c.incompleto && !c.emAndamento &&
                            (dec.calcSS !== c.minSS || dec.calcDF !== c.minDF) };
        ef.estado = dec.status;
        if (dec.status === 'APROVADO') {
          ef.minSS = dec.aprovSS; ef.minDF = dec.aprovDF; ef.valorSS = dec.valorSS; ef.valorDF = dec.valorDF;
          ef.valor = pjDinheiro(dec.valorSS + dec.valorDF);
        }
        if (decOut.diverge) tot.divergentes++;
      } else if (c.extraMin > 0 && !c.incompleto && !c.emAndamento) {
        if (R.exigeAprovacao) {
          ef.estado = 'PENDENTE';
          tot.pendentes++; tot.pendenteMin += c.extraMin; tot.pendenteValor = pjDinheiro(tot.pendenteValor + c.valor);
        } else {
          ef.estado = 'CALCULADO';
          ef.minSS = c.minSS; ef.minDF = c.minDF; ef.valorSS = c.valorSS; ef.valorDF = c.valorDF; ef.valor = c.valor;
        }
      }

      const fmt = function (e) {
        if (!e) return null;
        const o = { id: e.id, h: e.dataHora.slice(11, 16) };
        if (e.dataHora.slice(0, 10) !== d) o.d = e.dataHora.slice(0, 10);
        if (e.origem === 'rh') o.rh = true;
        if (e.obs) o.obs = e.obs;
        return o;
      };

      dias.push({
        dia: d, dow: dow, tipo: pjTipoDia(d, ctx.feriados), feriado: feriado,
        jornada: jd ? [pjHM(jd.ini), pjHM(jd.fim), jd.intervalo] : null,
        sessoes: S.map(function (s) { const o = { e: fmt(s.e), s: fmt(s.s) }; if (s.falha) o.falha = s.falha; if (s.aberta) o.aberta = true; return o; }),
        trabalhadoMin: c.trabalhadoMin, previstoMin: c.previstoMin, faltaMin: c.faltaMin, antesMin: c.antesMin,
        depoisMin: c.depoisMin, intervaloDescontadoMin: c.intervaloDescontadoMin, extraBrutoMin: c.extraBrutoMin,
        extraMin: c.extraMin, minSS: c.minSS, minDF: c.minDF, valor: c.valor, socorroAbsorvidoMin: c.socorroAbsorvidoMin,
        incompleto: c.incompleto, emAndamento: c.emAndamento, semJornada: c.semJornada, diaLivre: c.diaLivre,
        decisao: decOut, efetivo: ef
      });

      tot.diasComRegistro++;
      tot.trabalhadoMin += c.trabalhadoMin;
      tot.extraCalcMin += c.extraMin;
      tot.socorroAbsorvidoMin += c.socorroAbsorvidoMin;
      if (c.incompleto) tot.incompletos++;
      tot.minSS += ef.minSS; tot.minDF += ef.minDF;
      tot.valorSS = pjDinheiro(tot.valorSS + ef.valorSS); tot.valorDF = pjDinheiro(tot.valorDF + ef.valorDF);
      tot.valor = pjDinheiro(tot.valor + ef.valor);
    }

    // Quem não está mais na portaria só entra no mês se tiver algo a mostrar (ex.: desligado no meio do mês).
    socsDoMes.forEach(function (s) { tot.socorroQtd++; tot.socorroValor = pjDinheiro(tot.socorroValor + s.valor); });
    if (!p.naPortaria && !tot.diasComRegistro && !socsDoMes.length) return;
    saida.push({
      socorros: socsDoMes.map(function (s) {
        return { id: s.id, dia: s.dia, inicio: s.inicio.slice(0, 16), fim: s.fim.slice(0, 16), faixa: s.faixa, valor: s.valor, por: s.usuario, obs: s.obs };
      }),
      codigo: p.codigo, nome: p.nome, curto: p.curto, cargo: p.cargo, departamento: p.departamento,
      naPortaria: p.naPortaria, jornadaOk: p.jornada.ok, jornadaResumo: p.jornada.resumo, temFoto: !!p.temFoto, fotoV: p.fotoV || '',
      dias: dias, totais: tot
    });
  });
  return saida;
}

/* ═════════════════════════════════════════════════════════════════════════════
   5. FOTOS — casa "FOTO CAROL COMERCIAL.jpeg" com a pessoa certa
   ═════════════════════════════════════════════════════════════════════════════ */

function pjPalavras(s) {
  return pjNorm(s).replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean)
    .map(function (t) { return t.replace(/(.)\1+/g, '$1'); });   // "wellington" e "welington" viram a mesma coisa
}
function pjPrefixoComum(a, b) { let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++; return n; }

const PJ_FOTO_RUIDO = { foto: 1, fotos: 1, img: 1, imagem: 1, image: 1, perfil: 1, jpeg: 1, jpg: 1, png: 1, webp: 1, heic: 1, copia: 1, de: 1, da: 1, do: 1 };

/** Pontuação de um arquivo para uma pessoa; null = não é ela. */
function pjPontuarFoto(palavrasArquivo, pessoa) {
  const nome = pjPalavras(pessoa.nome).filter(function (t) { return !/^(da|de|do|das|dos|e)$/.test(t); });
  const cargo = pjPalavras((pessoa.cargo || '') + ' ' + (pessoa.departamento || ''));
  if (!nome.length || !palavrasArquivo.length) return null;
  let pontos = 0, pegouNome = false;
  for (let k = 0; k < palavrasArquivo.length; k++) {
    const t = palavrasArquivo[k];
    const exato = nome.indexOf(t);
    if (exato >= 0) { pontos += 10; if (exato <= 1) pegouNome = true; continue; }
    let achou = false;
    if (t.length >= 3) {
      for (let n = 0; n < nome.length; n++) {
        if (nome[n].indexOf(t) === 0) { pontos += 7; if (n <= 1) pegouNome = true; achou = true; break; }   // "carol" → "carolina"
      }
    }
    if (achou) continue;
    if (cargo.indexOf(t) >= 0) { pontos += 4; continue; }
    if (t.length >= 5 && cargo.some(function (c) { return pjPrefixoComum(c, t) >= 5; })) { pontos += 3; continue; }  // "funilaria" ~ "funileiro"
    return null;   // sobrou uma palavra do arquivo que não tem nada a ver com esta pessoa
  }
  if (!pegouNome) return null;   // precisa bater com o primeiro ou o segundo nome
  return pontos + (pessoa.ativo ? 1 : 0);
}

/**
 * arquivos: [{id, nome, v}] · pessoas: TODAS as linhas da base (PJ e CLT), para desempatar
 * por eliminação · ajustes: { codigo → texto digitado pelo RH (id, link ou nome do arquivo) }.
 * Devolve { mapa: {codigo → arquivo}, sobras: [arquivos sem dono] }.
 */
function pjCasarFotos(arquivos, pessoas, ajustes) {
  const mapa = {}, usado = {};
  const compacto = function (s) { return pjNorm(s).replace(/[^a-z0-9]/g, ''); };

  // 1) Vínculo feito à mão pelo RH.
  Object.keys(ajustes || {}).forEach(function (cod) {
    const alvo = String(ajustes[cod] || '').trim();
    if (!alvo) return;
    const id = pjExtrairId(alvo), nome = compacto(alvo.replace(/\.[a-z0-9]{2,5}$/i, ''));
    const f = arquivos.filter(function (a) { return a.id === id || compacto(a.nome.replace(/\.[a-z0-9]{2,5}$/i, '')) === nome; })[0];
    if (f) { mapa[cod] = f; usado[f.id] = true; }
  });

  // 2) Código do RH no nome do arquivo ("PJ_012 Luis.jpeg"): convenção recomendada para fotos novas.
  arquivos.forEach(function (a) {
    if (usado[a.id]) return;
    // Compara palavra a palavra (e pares vizinhos, para "PJ 012"): "PJ_01" não pode casar com "PJ_012".
    const toks = pjNorm(a.nome.replace(/\.[a-z0-9]{2,5}$/i, '')).split(/[^a-z0-9]+/).filter(Boolean), pecas = {};
    toks.forEach(function (tk, i) { pecas[tk] = true; if (toks[i + 1]) pecas[tk + toks[i + 1]] = true; });
    const p = pessoas.filter(function (x) { return !mapa[x.codigo] && compacto(x.codigo).length >= 3 && pecas[compacto(x.codigo)]; })[0];
    if (p) { mapa[p.codigo] = a; usado[a.id] = true; }
  });

  // 3) Pelo nome, com eliminação: quem só tem um candidato fecha primeiro.
  let fila = arquivos.filter(function (a) { return !usado[a.id]; }).map(function (a) {
    const palavras = pjPalavras(a.nome.replace(/\.[a-z0-9]{2,5}$/i, '')).filter(function (t) { return !PJ_FOTO_RUIDO[t] && !/^\d+$/.test(t); });
    const cand = [];
    pessoas.forEach(function (p) {
      if (mapa[p.codigo]) return;
      const s = pjPontuarFoto(palavras, p);
      if (s !== null) cand.push({ p: p, s: s });
    });
    cand.sort(function (x, y) { return y.s - x.s; });
    return { a: a, cand: cand };
  });
  const pontosDe = {};
  let mudou = true, rodadaForte = true;
  while (mudou || rodadaForte) {
    if (!mudou) rodadaForte = false;    // acabaram os "candidato único": aceita o melhor estrito
    mudou = false;
    fila.forEach(function (item) {
      if (item.fechado) return;
      const vivos = item.cand.filter(function (c) { return !mapa[c.p.codigo] || mapa[c.p.codigo] === item.a; });
      // Outra foto melhor já ficou com todo mundo que esta poderia ser: sobra.
      if (!vivos.length) { item.fechado = true; if (item.cand.length) mudou = true; return; }
      const unico = vivos.length === 1, melhorEstrito = vivos.length > 1 && vivos[0].s > vivos[1].s;
      if (unico || (!rodadaForte && melhorEstrito)) {
        const c = vivos[0];
        mapa[c.p.codigo] = item.a; pontosDe[c.p.codigo] = c.s;
        item.fechado = true; item.dono = c.p.codigo; mudou = true;
      }
    });
    // Duas fotos disputando a mesma pessoa numa mesma rodada: fica a de maior pontuação.
    fila.forEach(function (item) {
      if (item.fechado || !item.cand.length) return;
      const melhor = item.cand[0];
      if (mapa[melhor.p.codigo] && item.cand.length === 1 && melhor.s > (pontosDe[melhor.p.codigo] || 0)) {
        mapa[melhor.p.codigo] = item.a; pontosDe[melhor.p.codigo] = melhor.s; item.fechado = true; item.dono = melhor.p.codigo;
      }
    });
    if (!mudou && !rodadaForte) break;
  }

  const donos = {};
  Object.keys(mapa).forEach(function (cod) { donos[mapa[cod].id] = true; });
  return { mapa: mapa, sobras: arquivos.filter(function (a) { return !donos[a.id]; }) };
}

/* ═════════════════════════════════════════════════════════════════════════════
   6. PLANILHA DE CONTROLE — acesso às abas
   ═════════════════════════════════════════════════════════════════════════════ */

function pjSS() {
  if (_pj.ss) return _pj.ss;
  const id = PropertiesService.getScriptProperties().getProperty('PJ_PLANILHA_ID');
  let ss = null;
  if (id) ss = SpreadsheetApp.openById(id);
  else { try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { ss = null; } }
  if (!ss) throw pjErro('CONFIG', 'O backend ainda não foi instalado. Abra a planilha de controle e use o menu Renova PJ → Instalar.');
  _pj.ss = ss;
  return ss;
}
function pjFusoPlanilha() {
  if (!_pj.fuso) { try { _pj.fuso = pjSS().getSpreadsheetTimeZone() || PJ_FUSO; } catch (e) { _pj.fuso = PJ_FUSO; } }
  return _pj.fuso;
}
function pjAba(k) {
  _pj.abas = _pj.abas || {};
  if (_pj.abas[k]) return _pj.abas[k];
  const sh = pjSS().getSheetByName(PJ_ABA[k]);
  if (!sh) throw pjErro('CONFIG', 'Falta a aba "' + PJ_ABA[k] + '" na planilha de controle. Use o menu Renova PJ → Instalar.');
  _pj.abas[k] = sh;
  return sh;
}

/** Acrescenta linhas no fim da aba, como texto puro (a planilha não converte nada). */
function pjAcrescentar(k, linhas) {
  if (!linhas.length) return 0;
  const sh = pjAba(k), n = PJ_CAB[k].length, ini = sh.getLastRow() + 1;
  const falta = (ini + linhas.length - 1) - sh.getMaxRows();
  if (falta > 0) sh.insertRowsAfter(sh.getMaxRows(), Math.max(falta, 200));
  const rg = sh.getRange(ini, 1, linhas.length, n);
  rg.setNumberFormat('@');
  rg.setValues(linhas);
  return ini;
}

function pjLerTudo(k) {
  const sh = pjAba(k), ult = sh.getLastRow();
  if (ult < 2) return [];
  return sh.getRange(2, 1, ult - 1, PJ_CAB[k].length).getValues();
}

/* ── Config ── */

function pjCfg(forcar) {
  if (_pj.cfg && !forcar) return _pj.cfg;
  const o = {};
  PJ_CFG_PADRAO.forEach(function (l) { o[l[0]] = l[1]; });
  const sh = pjAba('CFG'), ult = sh.getLastRow();
  if (ult >= 2) {
    sh.getRange(2, 1, ult - 1, 2).getValues().forEach(function (l) {
      const k = String(l[0] || '').trim();
      if (k) o[k] = pjEhData(l[1]) ? pjTexto(l[1]) : l[1];
    });
  }
  _pj.cfg = o;
  return o;
}

function pjCfgGravar(valores) {
  const sh = pjAba('CFG'), ult = sh.getLastRow();
  const chaves = ult >= 2 ? sh.getRange(2, 1, ult - 1, 1).getValues().map(function (l) { return String(l[0] || '').trim(); }) : [];
  const novas = [];
  Object.keys(valores).forEach(function (k) {
    const i = chaves.indexOf(k), v = String(valores[k] === null || valores[k] === undefined ? '' : valores[k]);
    if (i >= 0) sh.getRange(i + 2, 2).setNumberFormat('@').setValue(v);
    else { const pad = PJ_CFG_PADRAO.filter(function (l) { return l[0] === k; })[0]; novas.push([k, v, pad ? pad[2] : '']); }
  });
  pjAcrescentar('CFG', novas);
  _pj.cfg = null;
}

function pjRegras(cfg) {
  return {
    valorSS: Math.max(0, pjNum(cfg.valor_hora_seg_sab, 25)),
    valorDF: Math.max(0, pjNum(cfg.valor_hora_dom_feriado, 35)),
    toleranciaMin: Math.max(0, Math.round(pjNum(cfg.tolerancia_min, 10))),
    blocoMin: Math.max(1, Math.round(pjNum(cfg.bloco_min, 1))),
    contaAntes: pjSim(cfg.conta_antes_do_horario),
    compensa: pjSim(cfg.compensa_falta_no_dia),
    descontaIntervaloLivre: pjSim(cfg.desconta_intervalo_dia_livre),
    exigeAprovacao: pjSim(cfg.exige_aprovacao),
    maxAbertoMin: Math.round(Math.min(36, Math.max(6, pjNum(cfg.horas_max_aberto, 16))) * 60),
    socorroDia: Math.max(0, pjNum(cfg.valor_socorro_dia, 100)),
    socorroNoite: Math.max(0, pjNum(cfg.valor_socorro_noite, 120)),
    socorroDF: Math.max(0, pjNum(cfg.valor_socorro_dom_feriado, 120)),
    socorroNoiteApos: pjHoraCfg(cfg.socorro_noite_apos, 22 * 60),
    socorroMadrugadaAte: pjHoraCfg(cfg.socorro_madrugada_ate, 6 * 60)
  };
}

/** "22:00" → 1320. Texto fora do formato cai no padrão. */
function pjHoraCfg(v, padrao) {
  let s = String(v === null || v === undefined ? '' : v).trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)) s = s.slice(11, 16);   // a planilha às vezes devolve a hora como data
  const m = s.match(/^(\d{1,2})\s*[:h]\s*(\d{2})$/);
  if (!m || +m[1] > 23 || +m[2] > 59) return padrao;
  return +m[1] * 60 + +m[2];
}

/* ── Feriados ── */

function pjFeriados() {
  if (_pj.feriados) return _pj.feriados;
  const o = {};
  pjLerTudo('FER').forEach(function (l) {
    const d = pjParseData(l[0]);
    if (d) o[d] = String(l[1] || '').trim() || 'Feriado';
  });
  _pj.feriados = o;
  return o;
}

function pjFeriadosGravar(lista) {
  const limpo = {}, linhas = [];
  (lista || []).forEach(function (f) {
    const d = pjParseData(f.data);
    if (d && !limpo[d]) { limpo[d] = true; linhas.push([d, String(f.descricao || '').trim().slice(0, 80) || 'Feriado']); }
  });
  linhas.sort(function (x, y) { return x[0] < y[0] ? -1 : 1; });
  const sh = pjAba('FER'), ult = sh.getLastRow();
  if (ult >= 2) sh.getRange(2, 1, ult - 1, PJ_CAB.FER.length).clearContent();
  if (linhas.length) {
    const falta = (linhas.length + 1) - sh.getMaxRows();
    if (falta > 0) sh.insertRowsAfter(sh.getMaxRows(), falta);
    sh.getRange(2, 1, linhas.length, 2).setNumberFormat('@').setValues(linhas.map(function (l) { return [pjDiaBR(l[0]), l[1]]; }));
  }
  _pj.feriados = null;
  return linhas.length;
}

/* ── Ajustes por pessoa (aba Pessoas) ── */

function pjAjustes() {
  if (_pj.ajustes) return _pj.ajustes;
  const o = {};
  pjLerTudo('PES').forEach(function (l, i) {
    const cod = String(l[0] || '').trim();
    if (!cod) return;
    const c = pjNorm(l[1]);
    o[cod] = { linha: i + 2, controle: c === 'incluir' ? 'incluir' : (c === 'excluir' ? 'excluir' : 'auto'),
               horario: String(l[2] || '').trim(), foto: String(l[3] || '').trim(), apelido: String(l[4] || '').trim(), obs: String(l[5] || '').trim() };
  });
  _pj.ajustes = o;
  return o;
}

/* ── Auditoria ── */

function pjAuditar(usuario, acao, alvo, detalhe) {
  let d = '';
  try { d = typeof detalhe === 'string' ? detalhe : JSON.stringify(detalhe); } catch (e) { d = String(detalhe); }
  pjAcrescentar('AUD', [[pjLocal(pjAgoraMs()), String(usuario || ''), acao, String(alvo || ''), d.slice(0, 2000)]]);
}

/* ═════════════════════════════════════════════════════════════════════════════
   7. PLANILHA DO RH — só leitura, só as colunas necessárias
   ═════════════════════════════════════════════════════════════════════════════ */

const PJ_CACHE_BASE = 'pj_base_v1', PJ_CACHE_FOTOS = 'pj_fotos_v1', PJ_CACHE_VALORES = 'pj_valores_v1';

function pjAbrirRH(cfg) {
  const id = pjExtrairId(cfg.planilha_rh);
  if (!id) throw pjErro('CONFIG', 'Falta informar o link da planilha do RH na aba Config (linha planilha_rh).');
  try { return SpreadsheetApp.openById(id); }
  catch (e) { throw pjErro('CONFIG', 'Não consegui abrir a planilha do RH. Confira o link na aba Config e se a conta que publicou este script tem acesso a ela.'); }
}

/** Todas as linhas com nome e código (PJ e CLT): o CLT só serve para desempatar foto. */
function pjBaseRH() {
  if (_pj.base) return _pj.base;
  const cache = CacheService.getScriptCache(), emCache = cache.get(PJ_CACHE_BASE);
  if (emCache) { _pj.base = JSON.parse(emCache); return _pj.base; }

  const cfg = pjCfg(), ss = pjAbrirRH(cfg);
  let sh = ss.getSheetByName(String(cfg.aba_rh || '').trim());
  if (!sh) {
    const alvo = pjNorm(cfg.aba_rh);
    sh = ss.getSheets().filter(function (s) { return pjNorm(s.getName()) === alvo || pjNorm(s.getName()).indexOf('colaborador') >= 0; })[0];
  }
  if (!sh) throw pjErro('CONFIG', 'Não achei a aba "' + cfg.aba_rh + '" na planilha do RH. Corrija o nome na aba Config (linha aba_rh).');

  const vals = sh.getDataRange().getDisplayValues();
  if (vals.length < 2) throw pjErro('CONFIG', 'A aba de colaboradores da planilha do RH está vazia.');
  const cab = vals[0].map(pjNorm);
  const col = function (nomes) {
    for (let n = 0; n < nomes.length; n++) { const i = cab.indexOf(nomes[n]); if (i >= 0) return i; }
    for (let n = 0; n < nomes.length; n++) { for (let i = 0; i < cab.length; i++) if (cab[i].indexOf(nomes[n]) === 0) return i; }
    return -1;
  };
  const c = { status: col(['status']), tipo: col(['tipo']), codigo: col(['codigo rh', 'codigo']), nome: col(['colaborador', 'nome']),
              cargo: col(['cargo']), horario: col(['horario']), depto: col(['departamento', 'setor']), admissao: col(['admissao']) };
  ['status', 'tipo', 'codigo', 'nome'].forEach(function (k) {
    if (c[k] < 0) throw pjErro('CONFIG', 'A aba de colaboradores do RH está sem a coluna "' + k + '" no cabeçalho.');
  });
  const pega = function (l, i) { return i >= 0 ? String(l[i] || '').replace(/\s+/g, ' ').trim() : ''; };

  const out = [];
  for (let i = 1; i < vals.length; i++) {
    const l = vals[i], nome = pega(l, c.nome), codigo = pega(l, c.codigo), tipo = pjNorm(pega(l, c.tipo));
    if (!nome || !codigo || !tipo) continue;      // pula a legenda de cores no rodapé da aba
    out.push({ codigo: codigo, nome: nome, tipo: tipo, status: pega(l, c.status), ativo: pjNorm(pega(l, c.status)) === 'ativo',
               cargo: pega(l, c.cargo), departamento: pega(l, c.depto), horario: pega(l, c.horario), admissao: pjParseData(pega(l, c.admissao)) });
  }
  _pj.base = out;
  try { const js = JSON.stringify(out); if (js.length < 95000) cache.put(PJ_CACHE_BASE, js, 600); } catch (e) {}
  return out;
}

/** Valores de hora que o RH usa hoje (aba oculta "valores automáticos"), para avisar se divergirem dos daqui. */
function pjValoresRH() {
  const cache = CacheService.getScriptCache(), emCache = cache.get(PJ_CACHE_VALORES);
  if (emCache) return JSON.parse(emCache);
  const out = { segSab: null, domFeriado: null };
  try {
    const cfg = pjCfg(), ss = pjAbrirRH(cfg);
    const sh = ss.getSheets().filter(function (s) { return pjNorm(s.getName()).indexOf('valores') >= 0; })[0];
    if (sh) {
      const a = pjNorm(cfg.evento_seg_sab), b = pjNorm(cfg.evento_dom_feriado);
      sh.getDataRange().getDisplayValues().forEach(function (l) {
        const rot = pjNorm(l[0]);
        if (rot === a) out.segSab = pjNum(l[1], null);
        if (rot === b) out.domFeriado = pjNum(l[1], null);
      });
    }
  } catch (e) {}
  try { cache.put(PJ_CACHE_VALORES, JSON.stringify(out), 600); } catch (e) {}
  return out;
}

/** Arquivos de imagem da pasta de fotos. Falha de acesso não derruba a portaria: só fica sem foto. */
function pjArquivosFoto() {
  const id = pjExtrairId(pjCfg().pasta_fotos);
  if (!id) return [];
  const out = [];
  try {
    const it = DriveApp.getFolderById(id).getFiles();
    while (it.hasNext()) {
      const f = it.next();
      if (!/^image\//.test(String(f.getMimeType()))) continue;
      out.push({ id: f.getId(), nome: f.getName(), v: String(f.getLastUpdated().getTime()) });
    }
  } catch (e) { return []; }
  return out;
}

function pjFotos() {
  if (_pj.fotos) return _pj.fotos;
  const cache = CacheService.getScriptCache(), emCache = cache.get(PJ_CACHE_FOTOS);
  if (emCache) { _pj.fotos = JSON.parse(emCache); return _pj.fotos; }
  const ajustes = pjAjustes(), manual = {};
  Object.keys(ajustes).forEach(function (cod) { if (ajustes[cod].foto) manual[cod] = ajustes[cod].foto; });
  const arquivos = pjArquivosFoto();
  const r = pjCasarFotos(arquivos, pjBaseRH(), manual);
  const mapa = {};
  Object.keys(r.mapa).forEach(function (cod) { mapa[cod] = { id: r.mapa[cod].id, v: r.mapa[cod].v, nome: r.mapa[cod].nome }; });
  _pj.fotos = { mapa: mapa, sobras: r.sobras.map(function (a) { return a.nome; }), arquivos: arquivos.map(function (a) { return a.nome; }).sort() };
  try { const js = JSON.stringify(_pj.fotos); if (js.length < 95000) cache.put(PJ_CACHE_FOTOS, js, 600); } catch (e) {}
  return _pj.fotos;
}

function pjLimparCaches() {
  try { CacheService.getScriptCache().removeAll([PJ_CACHE_BASE, PJ_CACHE_FOTOS, PJ_CACHE_VALORES]); } catch (e) {}
  _pj.base = null; _pj.fotos = null; _pj.pessoas = null; _pj.ajustes = null;
}

/**
 * Lista de PJ da base do RH já com a regra de quem vai para a portaria:
 * Tipo = PJ, Status = Ativo e horário que não seja híbrido. O RH pode
 * forçar "incluir" ou "excluir" pessoa por pessoa (aba Pessoas).
 */
function pjPessoas() {
  if (_pj.pessoas) return _pj.pessoas;
  const cfg = pjCfg(), ajustes = pjAjustes(), fotos = pjFotos().mapa;
  const prefixos = String(cfg.prefixos_ignorados || '').split(/[,;\s]+/).map(function (s) { return s.trim().toUpperCase(); }).filter(Boolean);
  const padrao = String(cfg.jornada_padrao || '').trim();
  const unidade = pjSim(cfg.jornada_unidade_prevalece) ? pjParseJornada(String(cfg.jornada_unidade || '').trim()) : null;
  const excluidos = String(cfg.codigos_excluidos || '').split(/[,;\s]+/).map(function (s) { return s.trim().toUpperCase(); }).filter(Boolean);

  _pj.pessoas = pjBaseRH().filter(function (b) { return b.tipo === 'pj'; }).map(function (b) {
    const x = ajustes[b.codigo] || { controle: 'auto', horario: '', foto: '', apelido: '' };
    const doRH = pjParseJornada(b.horario);
    let jornada = doRH, origemJornada = 'rh';
    if (x.horario) { jornada = pjParseJornada(x.horario); origemJornada = 'ajuste'; }
    else if (unidade && unidade.ok) { jornada = unidade; origemJornada = 'unidade'; }
    else if (!doRH.ok && padrao) { jornada = pjParseJornada(padrao); origemJornada = 'padrao'; }

    const ignorado = prefixos.some(function (p) { return b.codigo.toUpperCase().indexOf(p) === 0; });
    let naPortaria = true, motivo = '';
    if (!b.ativo) { naPortaria = false; motivo = 'inativo'; }
    else if (x.controle === 'excluir') { naPortaria = false; motivo = 'excluido'; }
    else if (x.controle === 'incluir') naPortaria = true;
    else if (excluidos.indexOf(b.codigo.toUpperCase()) >= 0) { naPortaria = false; motivo = 'excluido'; }
    else if (doRH.hibrido) { naPortaria = false; motivo = 'hibrido'; }
    else if (ignorado) { naPortaria = false; motivo = 'prefixo'; }

    return {
      codigo: b.codigo, nome: b.nome, curto: x.apelido || pjNomeCurto(b.nome), cargo: b.cargo, departamento: b.departamento,
      statusRH: b.status, ativo: b.ativo, hibrido: doRH.hibrido, horarioRH: b.horario, horarioAjuste: x.horario, apelido: x.apelido,
      jornada: jornada, origemJornada: origemJornada, controle: x.controle, naPortaria: naPortaria, motivo: motivo,
      admissao: b.admissao, temFoto: !!fotos[b.codigo], fotoV: fotos[b.codigo] ? fotos[b.codigo].v : '',
      fotoArquivo: fotos[b.codigo] ? fotos[b.codigo].nome : '', fotoAjuste: x.foto
    };
  }).sort(function (a, b) { return a.curto.localeCompare(b.curto, 'pt-BR'); });
  return _pj.pessoas;
}

/* ═════════════════════════════════════════════════════════════════════════════
   8. REGISTROS — leitura enxuta e gravação com trava
   ═════════════════════════════════════════════════════════════════════════════ */

function pjLinhasRegistro(vals, primeiraLinha) {
  const out = [];
  for (let i = 0; i < vals.length; i++) {
    const l = vals[i], id = String(l[0] || '').trim();
    if (!id) continue;
    const dh = pjTexto(l[4]);
    out.push({ linha: primeiraLinha + i, id: id, codigo: String(l[1] || '').trim(), nome: String(l[2] || '').trim(),
               tipo: String(l[3] || '').trim().toUpperCase(), dataHora: dh, dia: dh.slice(0, 10), origem: String(l[6] || '').trim(),
               usuario: String(l[7] || '').trim(), recebidoEm: pjTexto(l[8]), status: String(l[9] || '').trim().toLowerCase() || 'ok',
               obs: String(l[10] || '').trim(), ref: String(l[11] || '').trim() });
  }
  return out;
}

/** Só as últimas N linhas: é o que a portaria precisa para saber quem está dentro. */
function pjRegistrosCauda(n) {
  const sh = pjAba('REG'), ult = sh.getLastRow();
  if (ult < 2) return [];
  const ini = Math.max(2, ult - n + 1);
  return pjLinhasRegistro(sh.getRange(ini, 1, ult - ini + 1, PJ_CAB.REG.length).getValues(), ini);
}

/** Registros de um período: varre só a coluna do dia e lê o bloco que interessa. */
function pjRegistrosPeriodo(diaIni, diaFim) {
  const sh = pjAba('REG'), ult = sh.getLastRow();
  if (ult < 2) return [];
  const dias = sh.getRange(2, PJ_CAB.REG.indexOf('dia') + 1, ult - 1, 1).getValues();
  let a = -1, b = -1;
  for (let i = 0; i < dias.length; i++) {
    const d = pjTexto(dias[i][0]).slice(0, 10);
    if (d >= diaIni && d <= diaFim) { if (a < 0) a = i; b = i; }
  }
  if (a < 0) return [];
  return pjLinhasRegistro(sh.getRange(2 + a, 1, b - a + 1, PJ_CAB.REG.length).getValues(), 2 + a)
    .filter(function (r) { return r.dia >= diaIni && r.dia <= diaFim; });
}

function pjInicioControle() {
  const sh = pjAba('REG');
  if (sh.getLastRow() < 2) return '';
  return pjTexto(sh.getRange(2, PJ_CAB.REG.indexOf('dia') + 1).getValue()).slice(0, 10);
}

function pjEvento(r) {
  return { id: r.id, codigo: r.codigo, nome: r.nome, tipo: r.tipo, dataHora: r.dataHora, abs: pjAbs(r.dataHora),
           origem: r.origem, obs: r.obs, ordem: r.linha };
}

function pjComTrava(fn) {
  const trava = LockService.getScriptLock();
  if (!trava.tryLock(25000)) throw pjErro('OCUPADO', 'O sistema está ocupado agora. Tente de novo em alguns segundos.');
  try { return fn(); } finally { trava.releaseLock(); }
}

/* ═════════════════════════════════════════════════════════════════════════════
   9. PORTARIA — quem está dentro, registrar, desfazer, foto
   ═════════════════════════════════════════════════════════════════════════════ */

function pjEstado() {
  const cfg = pjCfg(), R = pjRegras(cfg), agora = pjLocal(pjAgoraMs()), agoraAbs = pjAbs(agora), hoje = agora.slice(0, 10);
  const feriados = pjFeriados(), todas = pjPessoas();
  const controladas = todas.filter(function (p) { return p.naPortaria; });
  const cauda = pjRegistrosCauda(Math.max(600, controladas.length * 40))
    .filter(function (r) { return r.status === 'ok'; }).map(pjEvento);
  const porCodigo = {};
  cauda.forEach(function (e) { (porCodigo[e.codigo] = porCodigo[e.codigo] || []).push(e); });

  const dow = pjDow(hoje);
  const montar = function (p) {
    const sess = pjMontarSessoes(porCodigo[p.codigo] || [], R.maxAbertoMin);
    const ult = sess[sess.length - 1];
    let estado = 'fora', desde = null, semSaida = null;
    if (ult && ult.aberta) {
      if (agoraAbs - ult.e.abs <= R.maxAbertoMin) { estado = 'dentro'; desde = ult.e.dataHora; }
      else semSaida = { dia: ult.e.dataHora.slice(0, 10), hora: ult.e.dataHora.slice(11, 16) };
    } else if (ult && ult.s) desde = ult.s.dataHora;

    let trabalhado = 0;
    const deHoje = sess.filter(function (s) {
      return (s.e && s.e.dataHora.slice(0, 10) === hoje) || (s.s && s.s.dataHora.slice(0, 10) === hoje) || (s.aberta && estado === 'dentro');
    }).map(function (s) {
      if (s.e) trabalhado += Math.max(0, (s.s ? s.s.abs : (s.aberta && estado === 'dentro' ? agoraAbs : s.e.abs)) - s.e.abs);
      return { e: s.e ? { id: s.e.id, h: s.e.dataHora.slice(11, 16), dh: s.e.dataHora } : null,
               s: s.s ? { id: s.s.id, h: s.s.dataHora.slice(11, 16), dh: s.s.dataHora } : null };
    });

    const jd = (p.jornada.ok && !feriados[hoje]) ? (p.jornada.dias[dow] || null) : null;
    return { codigo: p.codigo, nome: p.nome, curto: p.curto, cargo: p.cargo, departamento: p.departamento,
             foto: p.temFoto ? { v: p.fotoV } : null,
             jornadaHoje: jd ? { ini: pjHM(jd.ini), fim: pjHM(jd.fim) } : null, semJornada: !p.jornada.ok,
             estado: estado, desde: desde, semSaida: semSaida, sessoesHoje: deHoje, trabalhadoHojeMin: trabalhado };
  };

  const pessoas = controladas.map(montar);
  // Alguém que saiu da lista (desligado, excluído) enquanto estava dentro continua com card até dar saída.
  const naLista = {};
  controladas.forEach(function (p) { naLista[p.codigo] = true; });
  Object.keys(porCodigo).forEach(function (cod) {
    if (naLista[cod]) return;
    const p = todas.filter(function (x) { return x.codigo === cod; })[0];
    if (!p) return;
    const card = montar(p);
    if (card.estado === 'dentro') { card.foraDaLista = true; pessoas.push(card); }
  });

  return { agora: agora, dia: hoje, feriado: feriados[hoje] || null,
           regras: { toleranciaMin: R.toleranciaMin, contaAntes: R.contaAntes },
           total: pessoas.length, dentro: pessoas.filter(function (p) { return p.estado === 'dentro'; }).length,
           pessoas: pessoas };
}

/**
 * Recebe um ou vários toques da portaria. `ts` é o relógio do aparelho na hora
 * do toque e `enviadoEm` o relógio do MESMO aparelho na hora do envio: a
 * diferença é a idade do toque, e é ela que entra na conta — não a hora
 * absoluta do aparelho, que pode estar errada.
 */
function pjRegistrar(body, acesso) {
  const agoraMs = pjAgoraMs(), enviado = Number(body.enviadoEm) || agoraMs;
  const lista = (Array.isArray(body.eventos) ? body.eventos : []).slice(0, 300)
    .sort(function (x, y) { return (Number(x.ts) || 0) - (Number(y.ts) || 0); });
  const resultados = [];

  pjComTrava(function () {
    const pessoas = {};
    pjPessoas().forEach(function (p) { pessoas[p.codigo] = p; });
    const cauda = pjRegistrosCauda(Math.max(800, lista.length * 4 + 400));
    const ids = {}, ultimo = {};
    cauda.forEach(function (r) {
      ids[r.id] = r.dataHora;
      if (r.status !== 'ok') return;
      const a = pjAbs(r.dataHora);
      if (!ultimo[r.codigo] || a >= ultimo[r.codigo].abs) ultimo[r.codigo] = { tipo: r.tipo, abs: a };
    });

    const novas = [], recebido = pjLocal(agoraMs);
    lista.forEach(function (ev) {
      const id = String(ev.id || ''), codigo = String(ev.codigo || '').trim(), tipo = String(ev.tipo || '').toUpperCase();
      if (!/^[\w-]{8,64}$/.test(id)) { resultados.push({ id: id, ok: false, erro: 'Registro sem identificação.' }); return; }
      if (ids[id]) { resultados.push({ id: id, ok: true, repetido: true, dataHora: ids[id] }); return; }
      const p = pessoas[codigo];
      if (tipo !== 'ENTRADA' && tipo !== 'SAIDA') { resultados.push({ id: id, ok: false, erro: 'Tipo de registro inválido.' }); return; }
      // Quem saiu da lista (desligado, híbrido, excluído) ainda pode ter a SAÍDA registrada se estava dentro.
      const estavaDentro = ultimo[codigo] && ultimo[codigo].tipo === 'ENTRADA';
      if (!p || (!p.naPortaria && !(tipo === 'SAIDA' && estavaDentro))) {
        resultados.push({ id: id, ok: false, erro: 'Colaborador não está na lista da portaria.' }); return;
      }

      let idade = enviado - (Number(ev.ts) || enviado);
      if (!(idade > 0)) idade = 0;
      if (idade > 30 * 86400000) { resultados.push({ id: id, ok: false, erro: 'Registro com mais de 30 dias: lance pelo RH.' }); return; }
      const dh = pjLocal(agoraMs - idade), abs = pjAbs(dh), u = ultimo[codigo];
      // Toque duplo, ou duas telas registrando a mesma coisa quase juntas.
      if (u && u.tipo === tipo && Math.abs(abs - u.abs) <= 2) { resultados.push({ id: id, ok: true, repetido: true, dataHora: dh }); return; }

      let obs = String(ev.obs || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (idade > 5 * 60000) obs = (obs ? obs + ' · ' : '') + 'registrado sem internet, sincronizado às ' + recebido.slice(11, 16);
      novas.push([id, codigo, p.nome, tipo, dh, dh.slice(0, 10), 'portaria', acesso.usuario, recebido, 'ok', obs, '']);
      ids[id] = dh;
      if (!u || abs >= u.abs) ultimo[codigo] = { tipo: tipo, abs: abs };
      resultados.push({ id: id, ok: true, dataHora: dh });
    });
    pjAcrescentar('REG', novas);
  });

  return { resultados: resultados, estado: pjEstado() };
}

/** O porteiro só desfaz o próprio toque, e só nos 10 minutos seguintes. Depois disso é com o RH. */
function pjDesfazer(body, acesso) {
  const id = String(body.id || '');
  pjComTrava(function () {
    const r = pjRegistrosCauda(1500).filter(function (x) { return x.id === id; })[0];
    if (!r) throw pjErro('NAO_ACHEI', 'Não encontrei esse registro para desfazer.');
    if (r.status !== 'ok') return;
    const agora = pjLocal(pjAgoraMs());
    if (r.origem !== 'portaria' || pjAbs(agora) - pjAbs(r.recebidoEm) > 10) {
      throw pjErro('TARDE', 'Esse registro já não pode ser desfeito na portaria. Avise o RH para corrigir.');
    }
    const sh = pjAba('REG');
    sh.getRange(r.linha, PJ_CAB.REG.indexOf('status') + 1, 1, 3).setNumberFormat('@')
      .setValues([['cancelado', r.obs, 'desfeito na portaria em ' + agora]]);
    pjAuditar(acesso.usuario, 'desfazer', r.codigo + ' ' + r.tipo + ' ' + r.dataHora, { id: id });
  });
  return { estado: pjEstado() };
}

/**
 * Foto de UM colaborador PJ. Nunca serve arquivo fora da pasta configurada,
 * nem foto de CLT. A portaria só recebe a de quem está na lista dela.
 */
function pjFoto(codigo, acesso) {
  codigo = String(codigo || '').trim();
  const p = pjPessoas().filter(function (x) { return x.codigo === codigo; })[0];
  if (!p || (acesso.tipo === 'portaria' && !p.naPortaria)) throw pjErro('SEM_FOTO', 'Sem foto.');
  const f = pjFotos().mapa[codigo];
  if (!f) throw pjErro('SEM_FOTO', 'Sem foto.');
  const arq = DriveApp.getFileById(f.id);
  let blob = arq.getBlob();
  if (blob.getBytes().length > 4 * 1024 * 1024) {       // foto gigante: manda a miniatura do Drive
    const mini = arq.getThumbnail();
    if (mini) blob = mini;
  }
  return { codigo: codigo, v: f.v, mime: blob.getContentType() || 'image/jpeg', base64: Utilities.base64Encode(blob.getBytes()) };
}

/* ═════════════════════════════════════════════════════════════════════════════
   9b. SOCORRO — atividade extra paga por atendimento (não é hora extra)
   O supervisor lança, na portaria, quem atendeu e de que horas a que horas.
   A faixa de preço sai da hora do FIM do atendimento. Dentro do atendimento
   a pessoa recebe só o socorro; hora extra fora dele continua valendo.
   ═════════════════════════════════════════════════════════════════════════════ */

const PJ_SOCORRO_MAX_MIN = 12 * 60;            // um atendimento não passa de 12h
const PJ_SOCORRO_DESFAZER_PORTARIA_MIN = 24 * 60;

/** Faixa e valor pela hora do fim: domingo/feriado · noite (depois do corte ou de madrugada) · dia. */
function pjSocorroFaixa(fim, feriados, R) {
  const dia = fim.slice(0, 10), min = pjAbs(fim) - pjAbsDia(dia);
  if (pjTipoDia(dia, feriados) === 'DF') return { faixa: 'DF', valor: R.socorroDF };
  if (min > R.socorroNoiteApos || min < R.socorroMadrugadaAte) return { faixa: 'NOITE', valor: R.socorroNoite };
  return { faixa: 'DIA', valor: R.socorroDia };
}

function pjSocorrosLer() {
  return pjLerTudo('SOC').map(function (l, i) {
    return { linha: i + 2, id: String(l[0] || '').trim(), codigo: String(l[1] || '').trim(), nome: String(l[2] || '').trim(),
             inicio: pjTexto(l[3]), fim: pjTexto(l[4]), dia: pjTexto(l[5]).slice(0, 10), faixa: String(l[6] || '').trim(),
             valor: pjNum(l[7], 0), usuario: String(l[8] || '').trim(), recebidoEm: pjTexto(l[9]),
             status: String(l[10] || '').trim().toLowerCase() || 'ok', obs: String(l[11] || '').trim() };
  }).filter(function (s) { return s.id; });
}

/** Socorros válidos cujo FIM cai no período (datas 'yyyy-MM-dd', inclusive). */
function pjSocorrosPeriodo(diaIni, diaFim) {
  return pjSocorrosLer().filter(function (s) { return s.status === 'ok' && s.dia >= diaIni && s.dia <= diaFim; });
}

/** Lista para a tela da portaria: sem valores em dinheiro. */
function pjSocorrosPortaria() {
  const hoje = pjLocal(pjAgoraMs()), agoraAbs = pjAbs(hoje), ini = pjSomaDias(hoje.slice(0, 10), -60);
  return {
    agora: hoje,
    socorros: pjSocorrosPeriodo(ini, pjSomaDias(hoje.slice(0, 10), 1)).sort(function (a, b) { return a.fim < b.fim ? 1 : -1; }).slice(0, 80)
      .map(function (s) {
        return { id: s.id, codigo: s.codigo, nome: s.nome, inicio: s.inicio.slice(0, 16), fim: s.fim.slice(0, 16), faixa: s.faixa,
                 por: s.usuario, obs: s.obs, podeDesfazer: agoraAbs - pjAbs(s.recebidoEm) <= PJ_SOCORRO_DESFAZER_PORTARIA_MIN };
      })
  };
}

function pjSocorroRegistrar(body, acesso) {
  const id = String(body.id || '').trim(), codigo = String(body.codigo || '').trim();
  if (!/^[\w-]{8,64}$/.test(id)) throw pjErro('PEDIDO', 'Lançamento sem identificação.');
  const inicio = pjValidarDataHoraRH(body.inicio), fim = pjValidarDataHoraRH(body.fim);
  const dur = pjAbs(fim) - pjAbs(inicio);
  if (dur <= 0) throw pjErro('PEDIDO', 'O fim do atendimento precisa ser depois do início.');
  if (dur > PJ_SOCORRO_MAX_MIN) throw pjErro('PEDIDO', 'Atendimento com mais de 12 horas: confira as datas e horas.');
  if (pjAbs(pjLocal(pjAgoraMs())) - pjAbs(fim) > 30 * 1440) throw pjErro('PEDIDO', 'Socorro com mais de 30 dias: peça ao RH.');
  const obs = String(body.obs || '').replace(/\s+/g, ' ').trim().slice(0, 200);

  let resp = null;
  pjComTrava(function () {
    const p = pjPessoas().filter(function (x) { return x.codigo === codigo && x.naPortaria; })[0];
    if (!p) throw pjErro('PEDIDO', 'Esse colaborador não está na lista da portaria.');
    const todos = pjSocorrosLer();
    const igual = todos.filter(function (s) { return s.id === id; })[0];
    if (igual) { resp = { repetido: true }; return; }            // reenvio do mesmo toque: não duplica
    const a = pjAbs(inicio), b = pjAbs(fim);
    const choque = todos.filter(function (s) { return s.status === 'ok' && s.codigo === codigo && a < pjAbs(s.fim) && b > pjAbs(s.inicio); })[0];
    if (choque) throw pjErro('PEDIDO', 'Já existe um socorro desse colaborador nesse horário (' + choque.inicio.slice(11, 16) + ' às ' + choque.fim.slice(11, 16) + ').');
    const f = pjSocorroFaixa(fim, pjFeriados(), pjRegras(pjCfg()));
    const agora = pjLocal(pjAgoraMs());
    pjAcrescentar('SOC', [[id, codigo, p.nome, inicio, fim, fim.slice(0, 10), f.faixa, String(f.valor), acesso.usuario, agora, 'ok', obs, '']]);
    pjAuditar(acesso.usuario, 'socorro_lancado', codigo + ' ' + inicio + ' a ' + fim, { faixa: f.faixa, valor: f.valor, obs: obs });
    resp = { faixa: f.faixa };
  });
  const out = pjSocorrosPortaria();
  out.resultado = resp;
  return out;
}

/** Portaria: só nas primeiras 24h. RH/administração: a qualquer hora. Sempre fica registrado. */
function pjSocorroDesfazer(body, acesso) {
  const id = String(body.id || '').trim();
  pjComTrava(function () {
    const s = pjSocorrosLer().filter(function (x) { return x.id === id; })[0];
    if (!s) throw pjErro('NAO_ACHEI', 'Não encontrei esse socorro.');
    if (s.status !== 'ok') return;
    const agora = pjLocal(pjAgoraMs());
    if (acesso.tipo === 'portaria' && pjAbs(agora) - pjAbs(s.recebidoEm) > PJ_SOCORRO_DESFAZER_PORTARIA_MIN) {
      throw pjErro('TARDE', 'Esse lançamento já não pode ser desfeito na portaria. Avise o RH.');
    }
    const motivo = String(body.motivo || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (acesso.tipo === 'rh' && !motivo) throw pjErro('PEDIDO', 'Explique o motivo do cancelamento.');
    const c = PJ_CAB.SOC.indexOf('status') + 1;
    pjAba('SOC').getRange(s.linha, c, 1, 3).setNumberFormat('@')
      .setValues([['cancelado', s.obs, 'cancelado por ' + acesso.usuario + ' em ' + agora + (motivo ? ': ' + motivo : '')]]);
    pjAuditar(acesso.usuario, 'socorro_cancelado', s.codigo + ' ' + s.inicio + ' a ' + s.fim, { id: id, motivo: motivo });
  });
  return pjSocorrosPortaria();
}

/* ═════════════════════════════════════════════════════════════════════════════
   10. RH — mês, decisões, correções, pessoas e regras
   ═════════════════════════════════════════════════════════════════════════════ */

function pjDecisoes() {
  const o = {};
  pjLerTudo('HE').forEach(function (l, i) {
    const chave = String(l[0] || '').trim();
    if (!chave) return;
    o[chave] = { linha: i + 2, codigo: String(l[1] || '').trim(), dia: pjTexto(l[3]).slice(0, 10),
                 calcSS: pjNum(l[4], 0), calcDF: pjNum(l[5], 0), aprovSS: pjNum(l[6], 0), aprovDF: pjNum(l[7], 0),
                 valorSS: pjNum(l[8], 0), valorDF: pjNum(l[9], 0), status: String(l[10] || '').trim().toUpperCase(),
                 por: String(l[11] || '').trim(), em: pjTexto(l[12]), obs: String(l[13] || '').trim() };
  });
  return o;
}

function pjDadosMes(mes) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(mes))) throw pjErro('PEDIDO', 'Mês inválido.');
  const cfg = pjCfg(), R = pjRegras(cfg), agora = pjLocal(pjAgoraMs());
  const ini = pjSomaDias(mes + '-01', -1), fim = pjSomaDias(pjUltimoDiaMes(mes), 1);
  const eventos = pjRegistrosPeriodo(ini, fim).filter(function (r) { return r.status === 'ok'; }).map(pjEvento);
  const feriados = pjFeriados();
  const pessoas = pjMontarMes(mes, { pessoas: pjPessoas(), eventos: eventos, decisoes: pjDecisoes(), feriados: feriados,
                                     socorros: pjSocorrosPeriodo(ini, fim), regras: R, agora: agora, inicioControle: pjInicioControle() });
  const feriadosDoMes = [];
  Object.keys(feriados).sort().forEach(function (d) { if (d.slice(0, 7) === mes) feriadosDoMes.push({ data: d, descricao: feriados[d] }); });
  return { mes: mes, agora: agora, regras: R, feriados: feriadosDoMes,
           eventos: { ss: String(cfg.evento_seg_sab || ''), df: String(cfg.evento_dom_feriado || '') }, pessoas: pessoas };
}

/**
 * Aprova, recusa ou reabre a hora extra de pessoa+dia. O número aprovado sai
 * sempre do cálculo do servidor (ou do ajuste digitado) — nunca do que a tela mandou.
 */
function pjDecidir(body, acesso) {
  const itens = (Array.isArray(body.itens) ? body.itens : []).slice(0, 500);
  if (!itens.length) throw pjErro('PEDIDO', 'Nada para decidir.');
  const feitos = [];

  pjComTrava(function () {
    const R = pjRegras(pjCfg()), agora = pjLocal(pjAgoraMs());
    const meses = {};
    itens.forEach(function (it) { const m = String(it.dia || '').slice(0, 7); if (/^\d{4}-\d{2}$/.test(m)) meses[m] = true; });
    const calc = {};
    Object.keys(meses).forEach(function (m) {
      pjDadosMes(m).pessoas.forEach(function (p) { p.dias.forEach(function (d) { calc[p.codigo + '|' + d.dia] = { p: p, d: d }; }); });
    });
    const atuais = pjDecisoes(), sh = pjAba('HE'), novas = [];

    itens.forEach(function (it) {
      const chave = String(it.codigo || '').trim() + '|' + String(it.dia || '').trim(), acao = String(it.acao || '').toUpperCase();
      const c = calc[chave];
      if (!c || c.d.semRegistro) { feitos.push({ chave: chave, ok: false, erro: 'Não há registro nesse dia.' }); return; }
      const d = c.d, obs = String(it.obs || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      let status, ss = 0, df = 0;

      if (acao === 'APROVAR') {
        if (d.incompleto || d.emAndamento) { feitos.push({ chave: chave, ok: false, erro: 'Registro incompleto: corrija a entrada/saída antes de aprovar.' }); return; }
        if (it.minutos === undefined || it.minutos === null || it.minutos === '') { ss = d.minSS; df = d.minDF; }
        else {
          const m = Math.round(pjNum(it.minutos, -1));
          if (m < 0 || m > 24 * 60) { feitos.push({ chave: chave, ok: false, erro: 'Minutos fora do limite (0 a 1440).' }); return; }
          if (m !== d.extraMin && !obs) { feitos.push({ chave: chave, ok: false, erro: 'Explique o ajuste no campo de observação.' }); return; }
          if (d.extraMin > 0 && d.minSS > 0 && d.minDF > 0) { df = Math.round(m * d.minDF / d.extraMin); ss = m - df; }
          else if (d.tipo === 'DF') df = m; else ss = m;
        }
        if (ss + df <= 0) { feitos.push({ chave: chave, ok: false, erro: 'Não há minutos para aprovar. Para não pagar, use Recusar.' }); return; }
        status = 'APROVADO';
      } else if (acao === 'RECUSAR') status = 'RECUSADO';
      else if (acao === 'REABRIR') status = 'PENDENTE';
      else { feitos.push({ chave: chave, ok: false, erro: 'Ação desconhecida.' }); return; }

      const linha = [chave, c.p.codigo, c.p.nome, d.dia, String(d.minSS), String(d.minDF), String(ss), String(df),
                     String(pjDinheiro(ss / 60 * R.valorSS)), String(pjDinheiro(df / 60 * R.valorDF)), status, acesso.usuario, agora, obs];
      const antes = atuais[chave];
      if (antes) sh.getRange(antes.linha, 1, 1, linha.length).setNumberFormat('@').setValues([linha]);
      else { novas.push(linha); atuais[chave] = { linha: -1 }; }
      pjAuditar(acesso.usuario, 'hora_extra_' + status.toLowerCase(), chave,
                { de: antes && antes.status ? antes.status + ' ' + (antes.aprovSS + antes.aprovDF) + 'min' : 'sem decisão',
                  para: status + ' ' + (ss + df) + 'min', calculado: d.extraMin, obs: obs });
      feitos.push({ chave: chave, ok: true, status: status, minutos: ss + df });
    });
    pjAcrescentar('HE', novas);
  });
  return { itens: feitos };
}

function pjAcharLinhaRegistro(id) {
  const sh = pjAba('REG'), ult = sh.getLastRow();
  if (ult < 2) return null;
  const ids = sh.getRange(2, 1, ult - 1, 1).getValues();
  for (let i = ids.length - 1; i >= 0; i--) {
    if (String(ids[i][0]).trim() === id) return pjLinhasRegistro(sh.getRange(i + 2, 1, 1, PJ_CAB.REG.length).getValues(), i + 2)[0];
  }
  return null;
}

function pjValidarDataHoraRH(v) {
  const m = String(v || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m || +m[2] < 1 || +m[2] > 12 || +m[3] < 1 || +m[3] > 31 || +m[4] > 23 || +m[5] > 59) throw pjErro('PEDIDO', 'Data ou hora inválida.');
  const dh = m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5] + ':00';
  if (pjDiaDeAbs(pjAbs(dh)) !== dh.slice(0, 10)) throw pjErro('PEDIDO', 'Essa data não existe no calendário.');
  if (pjAbs(dh) > pjAbs(pjLocal(pjAgoraMs())) + 5) throw pjErro('PEDIDO', 'Não dá para lançar registro no futuro.');
  return dh;
}

/** Lança (acao=add), cancela (acao=cancelar) ou troca o horário (acao=corrigir) de um registro. Sempre com motivo. */
function pjAjustarRegistro(body, acesso) {
  const acao = String(body.acao || ''), motivo = String(body.motivo || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (motivo.length < 3) throw pjErro('PEDIDO', 'Escreva o motivo do ajuste: ele fica guardado na auditoria.');
  let resp = {};

  pjComTrava(function () {
    const agora = pjLocal(pjAgoraMs()), sh = pjAba('REG');
    const cancelar = function (id) {
      const r = pjAcharLinhaRegistro(String(id || ''));
      if (!r) throw pjErro('NAO_ACHEI', 'Não encontrei esse registro.');
      if (r.status === 'ok') {
        sh.getRange(r.linha, PJ_CAB.REG.indexOf('status') + 1, 1, 3).setNumberFormat('@')
          .setValues([['cancelado', r.obs, 'cancelado por ' + acesso.usuario + ' em ' + agora + ': ' + motivo]]);
      }
      return r;
    };
    const lancar = function (codigo, tipo, dataHora, obs) {
      const p = pjPessoas().filter(function (x) { return x.codigo === codigo; })[0];
      if (!p) throw pjErro('PEDIDO', 'Colaborador não encontrado na lista do RH.');
      if (tipo !== 'ENTRADA' && tipo !== 'SAIDA') throw pjErro('PEDIDO', 'Escolha entrada ou saída.');
      const dh = pjValidarDataHoraRH(dataHora), id = 'rh-' + Utilities.getUuid();
      pjAcrescentar('REG', [[id, p.codigo, p.nome, tipo, dh, dh.slice(0, 10), 'rh', acesso.usuario, agora, 'ok', obs, '']]);
      return { id: id, dataHora: dh, codigo: p.codigo };
    };

    if (acao === 'add') {
      const n = lancar(String(body.codigo || '').trim(), String(body.tipo || '').toUpperCase(), body.dataHora, 'lançado pelo RH: ' + motivo);
      pjAuditar(acesso.usuario, 'registro_lancado', n.codigo + ' ' + String(body.tipo).toUpperCase() + ' ' + n.dataHora, { id: n.id, motivo: motivo });
      resp = n;
    } else if (acao === 'cancelar') {
      const r = cancelar(body.id);
      pjAuditar(acesso.usuario, 'registro_cancelado', r.codigo + ' ' + r.tipo + ' ' + r.dataHora, { id: r.id, motivo: motivo });
      resp = { id: r.id };
    } else if (acao === 'corrigir') {
      const dhNova = pjValidarDataHoraRH(body.dataHora);   // valida ANTES de cancelar: ou faz as duas coisas, ou nenhuma
      const r = cancelar(body.id);
      const n = lancar(r.codigo, r.tipo, dhNova, 'corrigido pelo RH (era ' + r.dataHora.slice(0, 16) + '): ' + motivo);
      pjAuditar(acesso.usuario, 'registro_corrigido', r.codigo + ' ' + r.tipo, { de: r.dataHora, para: n.dataHora, motivo: motivo });
      resp = n;
    } else throw pjErro('PEDIDO', 'Ação desconhecida.');
  });
  return resp;
}

/** Tela "Pessoas" do portal: todos os PJ da base, com o porquê de estarem dentro ou fora da portaria. */
function pjListaRH() {
  const fotos = pjFotos();
  return {
    pessoas: pjPessoas().map(function (p) {
      return { codigo: p.codigo, nome: p.nome, curto: p.curto, cargo: p.cargo, departamento: p.departamento, statusRH: p.statusRH,
               horarioRH: p.horarioRH, horarioAjuste: p.horarioAjuste, apelido: p.apelido, jornadaOk: p.jornada.ok,
               jornadaResumo: p.jornada.resumo, origemJornada: p.origemJornada, controle: p.controle, naPortaria: p.naPortaria,
               motivo: p.motivo, temFoto: p.temFoto, fotoV: p.fotoV, fotoArquivo: p.fotoArquivo, fotoAjuste: p.fotoAjuste };
    }),
    arquivosFoto: fotos.arquivos, fotosSemDono: fotos.sobras
  };
}

function pjPessoaGravar(body, acesso) {
  const codigo = String(body.codigo || '').trim();
  const p = pjPessoas().filter(function (x) { return x.codigo === codigo; })[0];
  if (!p) throw pjErro('PEDIDO', 'Colaborador não encontrado na lista do RH.');
  const c = pjNorm(body.controle);
  const controle = c === 'incluir' ? 'Incluir' : (c === 'excluir' ? 'Excluir' : '');
  const horario = String(body.horario || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (horario && !pjParseJornada(horario).ok) {
    throw pjErro('PEDIDO', 'Não entendi esse horário. Escreva como na planilha do RH, ex.: Seg a Sex 08:00 as 17:00 com 1H intervalo e Sab 08:00 as 12:00');
  }
  const linha = [codigo, controle, horario, String(body.foto || '').trim().slice(0, 200), String(body.apelido || '').replace(/\s+/g, ' ').trim().slice(0, 40),
                 String(body.obs || '').replace(/\s+/g, ' ').trim().slice(0, 200), acesso.usuario, pjLocal(pjAgoraMs())];
  pjComTrava(function () {
    const atual = pjAjustes()[codigo];
    if (atual) pjAba('PES').getRange(atual.linha, 1, 1, linha.length).setNumberFormat('@').setValues([linha]);
    else pjAcrescentar('PES', [linha]);
    pjAuditar(acesso.usuario, 'pessoa_ajustada', codigo, { controle: controle || 'auto', horario: horario, apelido: linha[4], foto: linha[3] });
  });
  pjLimparCaches();
  return pjListaRH();
}

function pjConfigRH() {
  const cfg = pjCfg(), o = {};
  PJ_CFG_EDITAVEL.forEach(function (k) { o[k] = cfg[k]; });
  const lista = [], f = pjFeriados();
  Object.keys(f).sort().forEach(function (d) { lista.push({ data: d, descricao: f[d] }); });
  return { config: o, regras: pjRegras(cfg), feriados: lista, valoresRH: pjValoresRH(), versao: PJ_VERSAO,
           ajuda: PJ_CFG_PADRAO.reduce(function (m, l) { m[l[0]] = l[2]; return m; }, {}) };
}

function pjConfigGravar(body, acesso) {
  const v = body.valores || {}, limpo = {};
  PJ_CFG_EDITAVEL.forEach(function (k) {
    if (v[k] === undefined) return;
    let x = v[k];
    if (/^valor_|_min$|^horas_/.test(k)) {
      const n = pjNum(x, NaN);
      if (!isFinite(n) || n < 0 || n > 100000) throw pjErro('PEDIDO', 'Valor inválido em "' + k + '".');
      x = String(n).replace('.', ',');
    } else if (/^(conta_|compensa_|desconta_|exige_|jornada_unidade_prevalece)/.test(k)) x = pjSim(x) ? 'Sim' : 'Não';
    else x = String(x === null ? '' : x).replace(/\s+/g, ' ').trim().slice(0, 200);
    if (k === 'jornada_padrao' && x && !pjParseJornada(x).ok) throw pjErro('PEDIDO', 'Não entendi a jornada padrão. Ex.: Seg a Sex 08:00 as 17:00 com 1H intervalo');
    if (k === 'jornada_unidade' && !pjParseJornada(x).ok) throw pjErro('PEDIDO', 'Não entendi o horário da unidade. Ex.: Seg a Sex 08:00 as 17:00 com 1H intervalo e Sab 08:00 as 12:00');
    if (/^socorro_(noite_apos|madrugada_ate)$/.test(k) && !/^\d{1,2}:\d{2}$/.test(x)) throw pjErro('PEDIDO', 'Horário inválido em "' + k + '". Use o formato 22:00.');
    limpo[k] = x;
  });
  if (!Object.keys(limpo).length) throw pjErro('PEDIDO', 'Nada para gravar.');
  pjComTrava(function () {
    const antes = pjCfg(), mud = {};
    Object.keys(limpo).forEach(function (k) { if (String(antes[k]) !== String(limpo[k])) mud[k] = { de: antes[k], para: limpo[k] }; });
    pjCfgGravar(limpo);
    if (Object.keys(mud).length) pjAuditar(acesso.usuario, 'regras_alteradas', 'Config', mud);
  });
  pjLimparCaches();
  return pjConfigRH();
}

/* ═════════════════════════════════════════════════════════════════════════════
   11. ACESSO — porteiro (senha própria) e portal (sessão do Manual da Empresa)
   ═════════════════════════════════════════════════════════════════════════════ */

const PJ_DIAS_SESSAO_PORTARIA = 30;

function pjAssinar(texto) {
  const segredo = PropertiesService.getScriptProperties().getProperty('PJ_SEGREDO') || '';
  // A senha entra na chave: trocar a senha na aba Config invalida todo aparelho já logado.
  const bytes = Utilities.computeHmacSha256Signature(texto, segredo + '|' + String(pjCfg().senha_portaria));
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function pjLoginPortaria(senha) {
  const cache = CacheService.getScriptCache(), falhas = Number(cache.get('pj_login_falhas') || 0);
  if (falhas >= 8) throw pjErro('BLOQUEADO', 'Muitas tentativas com senha errada. Aguarde 5 minutos.');
  const certa = String(pjCfg().senha_portaria || '');
  if (!certa) throw pjErro('CONFIG', 'A senha da portaria ainda não foi definida na aba Config.');
  if (String(senha || '') !== certa) {
    cache.put('pj_login_falhas', String(falhas + 1), 300);
    throw pjErro('SENHA', 'Senha incorreta.');
  }
  const expira = pjAgoraMs() + PJ_DIAS_SESSAO_PORTARIA * 86400000, corpo = 'p.' + expira;
  return { token: corpo + '.' + pjAssinar(corpo), expira: expira };
}

function pjSessaoPortal(token) {
  const cache = CacheService.getScriptCache(), chave = 'pj_sess_' + token;
  const emCache = cache.get(chave);
  if (emCache) return JSON.parse(emCache);
  let resposta;
  try {
    resposta = UrlFetchApp.fetch(PJ_API_LOGIN_PORTAL, {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify({ action: 'sessao_validar', token: token }),
      muteHttpExceptions: true, followRedirects: true
    });
  } catch (e) { throw pjErro('LOGIN_FORA', 'Não consegui validar seu acesso agora. Tente de novo em instantes.'); }
  let d;
  try { d = JSON.parse(resposta.getContentText()); }
  catch (e) { throw pjErro('LOGIN_FORA', 'Resposta inesperada do serviço de login. Tente novamente.'); }
  if (!d.success) throw pjErro('SESSAO', d.error || 'Sessão expirada. Entre novamente.');
  const s = { usuario: String(d.usuario || ''), nome: String(d.nome || ''), papel: String(d.papel || '') };
  cache.put(chave, JSON.stringify(s), 300);
  return s;
}

/** exige: 'portaria' (porteiro, ou RH olhando) · 'rh' (admin do portal ou login listado em usuarios_rh) · 'admin'. */
function pjAcesso(token, exige) {
  token = String(token || '');
  if (!token) throw pjErro('SESSAO', 'Sessão expirada. Entre novamente.');
  if (token.indexOf('p.') === 0) {
    const partes = token.split('.');
    const valido = partes.length === 3 && Number(partes[1]) > pjAgoraMs() && pjAssinar('p.' + partes[1]) === partes[2];
    if (!valido) throw pjErro('SESSAO', 'Sessão da portaria expirada. Entre novamente.');
    if (exige !== 'portaria') throw pjErro('ACESSO', 'Ação restrita ao RH.');
    return { tipo: 'portaria', usuario: 'portaria', nome: 'Portaria', admin: false };
  }
  const s = pjSessaoPortal(token);
  const liberados = String(pjCfg().usuarios_rh || '').split(/[,;\s]+/).map(pjNorm).filter(Boolean);
  const admin = s.papel === 'admin';
  if (!admin && liberados.indexOf(pjNorm(s.usuario)) < 0) throw pjErro('ACESSO', 'Este módulo é restrito ao RH e à administração.');
  if (exige === 'admin' && !admin) throw pjErro('ACESSO', 'Só administradores podem mudar as regras.');
  return { tipo: 'rh', usuario: s.usuario, nome: s.nome, admin: admin };
}

/* ═════════════════════════════════════════════════════════════════════════════
   12. ROTEADOR HTTP
   ═════════════════════════════════════════════════════════════════════════════ */

function pjJson(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function pjFalha(err) {
  return pjJson({ success: false, error: String(err && err.message ? err.message : err), codigo: (err && err.cod) || 'ERRO' });
}

function doGet(e) {
  _pj = {};
  const q = (e && e.parameter) || {}, action = String(q.action || '');
  try {
    if (action === 'ping') return pjJson({ success: true, versao: PJ_VERSAO });

    if (action === 'pj_estado') { pjAcesso(q.token, 'portaria'); return pjJson({ success: true, data: pjEstado() }); }
    if (action === 'pj_socorros') { pjAcesso(q.token, 'portaria'); return pjJson({ success: true, data: pjSocorrosPortaria() }); }
    if (action === 'pj_foto') {
      // Porteiro ou RH (o portal também mostra as fotos).
      let a;
      try { a = pjAcesso(q.token, 'portaria'); } catch (e) { if (e.cod !== 'ACESSO') throw e; a = pjAcesso(q.token, 'rh'); }
      return pjJson({ success: true, data: pjFoto(q.codigo, a) });
    }

    if (action === 'rh_mes') {
      const a = pjAcesso(q.token, 'rh'), d = pjDadosMes(q.mes);
      d.admin = a.admin; d.usuario = a.nome || a.usuario;
      return pjJson({ success: true, data: d });
    }
    if (action === 'rh_pessoas') { pjAcesso(q.token, 'rh'); return pjJson({ success: true, data: pjListaRH() }); }
    if (action === 'rh_config')  { const a = pjAcesso(q.token, 'rh'), d = pjConfigRH(); d.admin = a.admin; return pjJson({ success: true, data: d }); }

    return pjJson({ success: false, error: 'Ação desconhecida: ' + action, codigo: 'PEDIDO' });
  } catch (err) { return pjFalha(err); }
}

function doPost(e) {
  _pj = {};
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}'), action = String(body.action || '');

    if (action === 'login') return pjJson({ success: true, data: pjLoginPortaria(body.senha) });

    if (action === 'pj_registrar') return pjJson({ success: true, data: pjRegistrar(body, pjAcesso(body.token, 'portaria')) });
    if (action === 'pj_desfazer')  return pjJson({ success: true, data: pjDesfazer(body, pjAcesso(body.token, 'portaria')) });

    if (action === 'pj_socorro')          return pjJson({ success: true, data: pjSocorroRegistrar(body, pjAcesso(body.token, 'portaria')) });
    if (action === 'pj_socorro_desfazer') return pjJson({ success: true, data: pjSocorroDesfazer(body, pjAcesso(body.token, 'portaria')) });
    if (action === 'rh_socorro_desfazer') return pjJson({ success: true, data: pjSocorroDesfazer(body, pjAcesso(body.token, 'rh')) });

    if (action === 'rh_decidir')  return pjJson({ success: true, data: pjDecidir(body, pjAcesso(body.token, 'rh')) });
    if (action === 'rh_registro') return pjJson({ success: true, data: pjAjustarRegistro(body, pjAcesso(body.token, 'rh')) });
    if (action === 'rh_pessoa')   return pjJson({ success: true, data: pjPessoaGravar(body, pjAcesso(body.token, 'rh')) });
    if (action === 'rh_recarregar') { pjAcesso(body.token, 'rh'); pjLimparCaches(); return pjJson({ success: true, data: pjListaRH() }); }

    if (action === 'rh_config_set') return pjJson({ success: true, data: pjConfigGravar(body, pjAcesso(body.token, 'admin')) });
    if (action === 'rh_feriados_set') {
      const a = pjAcesso(body.token, 'admin');
      const n = pjComTrava(function () { const q = pjFeriadosGravar(body.feriados); pjAuditar(a.usuario, 'feriados_alterados', 'Feriados', { total: q }); return q; });
      return pjJson({ success: true, data: { total: n, config: pjConfigRH() } });
    }

    return pjJson({ success: false, error: 'Ação desconhecida: ' + action, codigo: 'PEDIDO' });
  } catch (err) { return pjFalha(err); }
}

/* ═════════════════════════════════════════════════════════════════════════════
   13. INSTALAÇÃO — menu "Renova PJ" dentro da planilha de controle
   ═════════════════════════════════════════════════════════════════════════════ */

function onOpen() {
  try {
    SpreadsheetApp.getUi().createMenu('Renova PJ')
      .addItem('Instalar / verificar', 'instalarComAssistente')
      .addItem('Reler a lista do RH e as fotos agora', 'menuRecarregar')
      .addToUi();
  } catch (e) {}
}

function pjGarantirAba(ss, k) {
  const cab = PJ_CAB[k];
  let sh = ss.getSheetByName(PJ_ABA[k]);
  if (!sh) sh = ss.insertSheet(PJ_ABA[k]);
  const atual = sh.getLastRow() >= 1 ? sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), cab.length)).getValues()[0].map(String) : [];
  if (cab.some(function (c, i) { return atual[i] !== c; })) {
    sh.getRange(1, 1, 1, cab.length).setValues([cab]).setFontWeight('bold').setBackground('#0f2044').setFontColor('#ffffff');
    sh.setFrozenRows(1);
  }
  // Tudo como texto: a planilha não transforma "2026-11-12" em data nem "1,5" em número por conta própria.
  sh.getRange(2, 1, Math.max(1, sh.getMaxRows() - 1), cab.length).setNumberFormat('@');
  return sh;
}

function pjGerarSenha() {
  const letras = '23456789ABCDEFGHJKMNPQRSTUVWXYZ', semente = Utilities.getUuid().replace(/-/g, '');
  let s = '';
  for (let i = 0; i < 6; i++) s += letras[parseInt(semente.substr(i * 2, 2), 16) % letras.length];
  return 'RT-' + s;
}

/**
 * Cria (ou completa) as abas da planilha de controle. Pode rodar quantas vezes
 * quiser: nunca apaga registro nem sobrescreve o que já foi preenchido.
 */
function instalar() {
  let ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { ss = null; }
  const props = PropertiesService.getScriptProperties();
  if (!ss && props.getProperty('PJ_PLANILHA_ID')) ss = SpreadsheetApp.openById(props.getProperty('PJ_PLANILHA_ID'));
  if (!ss) throw new Error('Abra este script a partir da planilha de controle (Extensões → Apps Script) e rode de novo.');

  props.setProperty('PJ_PLANILHA_ID', ss.getId());
  if (!props.getProperty('PJ_SEGREDO')) props.setProperty('PJ_SEGREDO', Utilities.getUuid() + Utilities.getUuid());
  try { ss.setSpreadsheetTimeZone(PJ_FUSO); ss.setSpreadsheetLocale('pt_BR'); } catch (e) {}

  _pj = { ss: ss };
  ['REG', 'CFG', 'PES', 'HE', 'FER', 'AUD', 'SOC'].forEach(function (k) { pjGarantirAba(ss, k); });

  // Config: só acrescenta as chaves que faltam.
  const shCfg = pjAba('CFG'), ult = shCfg.getLastRow();
  const tem = ult >= 2 ? shCfg.getRange(2, 1, ult - 1, 1).getValues().map(function (l) { return String(l[0] || '').trim(); }) : [];
  const faltam = PJ_CFG_PADRAO.filter(function (l) { return tem.indexOf(l[0]) < 0; })
    .map(function (l) { return [l[0], String(l[1]).replace('.', ','), l[2]]; });
  pjAcrescentar('CFG', faltam);
  try { shCfg.setColumnWidth(1, 210); shCfg.setColumnWidth(2, 330); shCfg.setColumnWidth(3, 640); } catch (e) {}

  if (!String(pjCfg(true).senha_portaria || '').trim()) pjCfgGravar({ senha_portaria: pjGerarSenha() });

  // Feriados: sugere os nacionais do ano atual e do próximo se a aba estiver vazia.
  if (pjAba('FER').getLastRow() < 2) {
    const ano = Number(pjLocal(pjAgoraMs()).slice(0, 4));
    pjFeriadosGravar(pjFeriadosSugeridos(ano).concat(pjFeriadosSugeridos(ano + 1)));
  }

  // A aba vazia que toda planilha nova traz ("Página1") só atrapalha.
  try {
    ss.getSheets().forEach(function (sh) {
      const nome = sh.getName();
      if (/^(p[aá]gina ?1|sheet ?1|planilha ?1)$/i.test(nome) && sh.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(sh);
    });
  } catch (e) {}

  pjLimparCaches();
  const resumo = pjDiagnostico();
  Logger.log(resumo);
  return resumo;
}

/** Texto com o estado da instalação: o que está pronto e o que falta. */
function pjDiagnostico() {
  _pj.cfg = null;
  const cfg = pjCfg(), linhas = ['Planilha de controle pronta (abas criadas).'];
  let ok = true;

  if (!pjExtrairId(cfg.planilha_rh)) { ok = false; linhas.push('FALTA: colar o link da planilha do RH na aba Config (linha planilha_rh).'); }
  else {
    try {
      pjLimparCaches();
      const todas = pjPessoas(), dentro = todas.filter(function (p) { return p.naPortaria; });
      const conta = function (m) { return todas.filter(function (p) { return p.motivo === m; }).length; };
      linhas.push('Planilha do RH lida: ' + dentro.length + ' colaboradores PJ vão para a portaria.');
      linhas.push('  Ficaram de fora: ' + conta('hibrido') + ' híbridos, ' + conta('inativo') + ' inativos, ' + conta('prefixo') + ' pró-labore, ' + conta('excluido') + ' excluídos à mão.');
      const semJornada = dentro.filter(function (p) { return !p.jornada.ok; });
      if (semJornada.length) linhas.push('  ATENÇÃO: sem horário reconhecido (não calcula hora extra): ' + semJornada.map(function (p) { return p.curto; }).join(', ') + '.');
      if (!pjExtrairId(cfg.pasta_fotos)) linhas.push('FALTA (opcional): colar o link da pasta de fotos na aba Config (linha pasta_fotos).');
      else {
        const semFoto = dentro.filter(function (p) { return !p.temFoto; });
        linhas.push('Fotos: ' + (dentro.length - semFoto.length) + ' de ' + dentro.length + ' com foto.' +
                    (semFoto.length ? ' Sem foto: ' + semFoto.map(function (p) { return p.curto; }).join(', ') + '.' : ''));
      }
      const v = pjValoresRH(), R = pjRegras(cfg);
      if (v.segSab !== null && (v.segSab !== R.valorSS || v.domFeriado !== R.valorDF)) {
        linhas.push('ATENÇÃO: os valores de hora daqui (R$ ' + R.valorSS + ' / R$ ' + R.valorDF + ') estão diferentes dos da planilha do RH (R$ ' + v.segSab + ' / R$ ' + v.domFeriado + ').');
      }
    } catch (e) { ok = false; linhas.push('ERRO ao ler a planilha do RH: ' + (e && e.message ? e.message : e)); }
  }

  linhas.push('');
  linhas.push('Senha da portaria: ' + cfg.senha_portaria + '   (para trocar, edite a aba Config)');
  linhas.push('');
  linhas.push(ok ? 'Próximo passo: Extensões → Apps Script → Implantar → Nova implantação → App da Web (Executar como: Eu · Quem tem acesso: Qualquer pessoa) e copiar a URL que termina em /exec.'
                 : 'Depois de corrigir o que falta, use de novo o menu Renova PJ → Instalar / verificar.');
  return linhas.join('\n');
}

/** Instalação guiada: pergunta os dois links e mostra o resultado numa janela. */
function instalarComAssistente() {
  const ui = SpreadsheetApp.getUi();
  instalar();
  const pedir = function (chave, titulo, texto) {
    if (pjExtrairId(pjCfg(true)[chave])) return true;
    const r = ui.prompt(titulo, texto, ui.ButtonSet.OK_CANCEL);
    if (r.getSelectedButton() !== ui.Button.OK) return false;
    const link = String(r.getResponseText() || '').trim();
    if (!pjExtrairId(link)) { ui.alert('Não reconheci esse link. Copie o endereço inteiro da barra do navegador e tente de novo.'); return false; }
    pjCfgGravar({ [chave]: link });
    return true;
  };
  if (!pedir('planilha_rh', 'Planilha do RH', 'Cole o link da planilha do RH (a que tem a aba "colaboradores e PJ").\nEla só será lida, nunca alterada.')) return;
  pedir('pasta_fotos', 'Pasta de fotos', 'Cole o link da pasta do Google Drive com as fotos dos colaboradores.\n(Pode cancelar e preencher depois na aba Config.)');
  ui.alert('Renova PJ', instalar(), ui.ButtonSet.OK);
}

function menuRecarregar() {
  pjLimparCaches();
  const texto = pjDiagnostico();
  try { SpreadsheetApp.getUi().alert('Renova PJ', texto, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) { Logger.log(texto); }
}
