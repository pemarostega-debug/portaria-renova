/**
 * Testes do motor de Colaboradores PJ (apps-script/ColaboradoresPJ.gs).
 *
 *   node ferramentas/testar-motor-pj.js
 *
 * Roda as funções puras do .gs (leitura do horário, sessões, cálculo da hora
 * extra, mês, feriados e casamento de fotos) fora do Google, com nomes
 * fictícios — o repositório é público. Sai com código 1 se algo falhar.
 */
const fs = require('fs'), path = require('path'), vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'ColaboradoresPJ.gs'), 'utf8');
const G = { console, Utilities: {}, Logger: { log() {} } };
vm.createContext(G);
vm.runInContext(src, G);

let ok = 0, falhou = 0;
function t(nome, real, esperado) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) { ok++; return; }
  falhou++;
  console.log('✗ ' + nome + '\n    veio:     ' + a + '\n    esperado: ' + b);
}

/* ── 1. Horário em texto livre ─────────────────────────────── */
const J1 = G.pjParseJornada('Seg a Qui 08:00 as 18:00 Sex 08:00 as 17:00 com 1H intervalo e Sab 08:00 as 12:00');
t('jornada padrão: seg', [J1.ok, J1.dias[1].ini, J1.dias[1].fim, J1.dias[1].intervalo], [true, 480, 1080, 60]);
t('jornada padrão: sex', [J1.dias[5].fim, J1.dias[5].intervalo], [1020, 60]);
t('jornada padrão: sáb sem intervalo', [J1.dias[6].ini, J1.dias[6].fim, J1.dias[6].intervalo], [480, 720, 0]);
t('jornada padrão: domingo livre', J1.dias[0], undefined);

const J2 = G.pjParseJornada('Seg a Sex 07:00 as 17:00 com 1H de intervalo e Sab 07:00 as 11:00');
t('jornada 7h: dias', Object.keys(J2.dias).sort(), ['1', '2', '3', '4', '5', '6']);
t('jornada 7h: qua', [J2.dias[3].ini, J2.dias[3].fim, J2.dias[3].intervalo], [420, 1020, 60]);

t('híbrido fica fora', [G.pjParseJornada('Hibrido').hibrido, G.pjParseJornada('Híbrido').ok], [true, false]);
t('vazio', G.pjParseJornada('').ok, false);

const J3 = G.pjParseJornada('Seg a Sex 08:00 as 12:00 e 13:00 as 17:00');
t('dois períodos viram intervalo', [J3.dias[2].ini, J3.dias[2].fim, J3.dias[2].intervalo], [480, 1020, 60]);

const J4 = G.pjParseJornada('Seg-Sex 8h às 17h, almoço 1h30');
t('formato com h e almoço 1h30', [J4.dias[1].ini, J4.dias[1].fim, J4.dias[1].intervalo], [480, 1020, 90]);

const J5 = G.pjParseJornada('Seg a Sex 08:00 as 17:00 intervalo de 30 min');
t('intervalo em minutos', J5.dias[4].intervalo, 30);

const J6 = G.pjParseJornada('Seg a Sex 22:00 as 06:00');
t('turno da noite', [J6.dias[1].ini, J6.dias[1].fim], [1320, 1800]);

const J7 = G.pjParseJornada('Seg a Sex 08:00 as 17:00');
t('sem intervalo escrito: presume 1h', [J7.dias[1].intervalo, J7.intervaloPresumido], [60, true]);

/* ── 2. Cálculo de um dia ──────────────────────────────────── */
const REGRAS = { valorSS: 25, valorDF: 35, toleranciaMin: 10, blocoMin: 1, contaAntes: false, compensa: true,
                 descontaIntervaloLivre: true, exigeAprovacao: true, maxAbertoMin: 16 * 60 };

let seq = 0;
function ev(dataHora, tipo) { return { id: 'e' + (++seq), tipo, dataHora, abs: G.pjAbs(dataHora), ordem: seq }; }
function dia(d, pares, opt) {
  opt = opt || {};
  const evs = [];
  pares.forEach(p => { if (p[0]) evs.push(ev(p[0], 'ENTRADA')); if (p[1]) evs.push(ev(p[1], 'SAIDA')); });
  const fer = opt.feriados || {};
  const jornada = opt.jornada || J1;
  const r = G.pjCalcularDia({
    dia: d, sessoes: G.pjMontarSessoes(evs, REGRAS.maxAbertoMin),
    jornadaDia: fer[d] ? null : (jornada.dias[G.pjDow(d)] || null), temJornada: jornada.ok, intervaloPadraoMin: 60,
    tipoHoje: G.pjTipoDia(d, fer), tipoAmanha: G.pjTipoDia(G.pjSomaDias(d, 1), fer),
    regras: Object.assign({}, REGRAS, opt.regras || {}), agoraAbs: opt.agora ? G.pjAbs(opt.agora) : null
  });
  return [r.extraMin, r.minSS, r.minDF, r.valor];
}
// 2026-11-16 é segunda; 2026-11-21 sábado; 2026-11-22 domingo.
t('dia normal sem almoço registrado: zero', dia('2026-11-16', [['2026-11-16 08:00', '2026-11-16 18:00']]), [0, 0, 0, 0]);
t('dia normal com almoço registrado: zero', dia('2026-11-16', [['2026-11-16 08:00', '2026-11-16 12:00'], ['2026-11-16 13:00', '2026-11-16 18:00']]), [0, 0, 0, 0]);
t('ficou até 19:30: 1h30 = R$ 37,50', dia('2026-11-16', [['2026-11-16 08:00', '2026-11-16 19:30']]), [90, 90, 0, 37.5]);
t('saiu 18:08: dentro da tolerância', dia('2026-11-16', [['2026-11-16 08:00', '2026-11-16 18:08']]), [0, 0, 0, 0]);
t('saiu 18:11: passou a tolerância, conta tudo', dia('2026-11-16', [['2026-11-16 08:00', '2026-11-16 18:11']]), [11, 11, 0, 4.58]);
t('chegou 30 min atrasado e saiu 30 min depois: zero', dia('2026-11-16', [['2026-11-16 08:30', '2026-11-16 18:30']]), [0, 0, 0, 0]);
t('almoço de 2h e saiu 1h depois: zero', dia('2026-11-16', [['2026-11-16 08:00', '2026-11-16 12:00'], ['2026-11-16 14:00', '2026-11-16 19:00']]), [0, 0, 0, 0]);
t('chegou 1h antes: não conta (regra padrão)', dia('2026-11-16', [['2026-11-16 07:00', '2026-11-16 18:00']]), [0, 0, 0, 0]);
t('chegou 1h antes com a regra ligada', dia('2026-11-16', [['2026-11-16 07:00', '2026-11-16 18:00']], { regras: { contaAntes: true } }), [60, 60, 0, 25]);
t('sem compensação: atraso não abate', dia('2026-11-16', [['2026-11-16 08:30', '2026-11-16 18:30']], { regras: { compensa: false } }), [30, 30, 0, 12.5]);
t('bloco de 15 min arredonda para baixo', dia('2026-11-16', [['2026-11-16 08:00', '2026-11-16 18:50']], { regras: { blocoMin: 15 } }), [45, 45, 0, 18.75]);
t('sábado até 14:00: 2h seg-sáb', dia('2026-11-21', [['2026-11-21 08:00', '2026-11-21 14:00']]), [120, 120, 0, 50]);
t('domingo 4h: tudo extra, tabela de domingo', dia('2026-11-22', [['2026-11-22 08:00', '2026-11-22 12:00']]), [240, 0, 240, 140]);
t('domingo 8h corridas: desconta 1h de almoço', dia('2026-11-22', [['2026-11-22 08:00', '2026-11-22 16:00']]), [420, 0, 420, 245]);
t('sábado + socorro até 2h de domingo', dia('2026-11-21', [['2026-11-21 08:00', '2026-11-21 12:00'], ['2026-11-21 20:00', '2026-11-22 02:00']]), [360, 240, 120, 170]);
t('feriado numa segunda: tabela de feriado', dia('2026-11-16', [['2026-11-16 08:00', '2026-11-16 12:00']], { feriados: { '2026-11-16': 'Teste' } }), [240, 0, 240, 140]);
t('entrada sem saída: não paga até o RH corrigir', dia('2026-11-16', [['2026-11-16 08:00', null]]), [0, 0, 0, 0]);
t('ainda lá dentro: mostra o parcial (o mês não soma)', dia('2026-11-16', [['2026-11-16 08:00', null]], { agora: '2026-11-16 19:00' }), [60, 60, 0, 25]);
t('sem horário cadastrado: não calcula', dia('2026-11-16', [['2026-11-16 08:00', '2026-11-16 20:00']], { jornada: G.pjParseJornada('') }), [0, 0, 0, 0]);

/* ── 3. Sessões ────────────────────────────────────────────── */
const S1 = G.pjMontarSessoes([ev('2026-11-16 08:00', 'ENTRADA'), ev('2026-11-16 09:00', 'ENTRADA'), ev('2026-11-16 18:00', 'SAIDA')], 960);
t('duas entradas seguidas: a primeira fica sem saída', S1.map(s => s.falha || 'ok'), ['sem_saida', 'ok']);
const S2 = G.pjMontarSessoes([ev('2026-11-16 18:00', 'SAIDA')], 960);
t('saída sem entrada', S2[0].falha, 'sem_entrada');
const S3 = G.pjMontarSessoes([ev('2026-11-16 08:00', 'ENTRADA'), ev('2026-11-17 18:00', 'SAIDA')], 960);
t('saída 34h depois não fecha a entrada', S3.map(s => s.falha), ['sem_saida', 'sem_entrada']);

/* ── 4. Mês inteiro com decisões ───────────────────────────── */
const pessoa = { codigo: 'PJ_901', nome: 'Fulano de Teste', curto: 'Fulano de Teste', cargo: 'Mecânico', departamento: 'Oficina',
                 naPortaria: true, jornada: J1, admissao: '2026-01-01', temFoto: false };
const eventos = [
  ev('2026-11-16 08:00', 'ENTRADA'), ev('2026-11-16 19:30', 'SAIDA'),     // 90 min
  ev('2026-11-17 08:00', 'ENTRADA'), ev('2026-11-17 20:00', 'SAIDA'),     // 120 min
  ev('2026-11-22 08:00', 'ENTRADA'), ev('2026-11-22 12:00', 'SAIDA'),     // 240 min domingo
  ev('2026-11-23 08:00', 'ENTRADA')                                          // sem saída
].map(e => Object.assign(e, { codigo: 'PJ_901' }));
const mes = G.pjMontarMes('2026-11', {
  pessoas: [pessoa], eventos, feriados: {}, regras: REGRAS, agora: '2026-11-25 10:00:00', inicioControle: '2026-11-16',
  decisoes: { 'PJ_901|2026-11-16': { status: 'APROVADO', calcSS: 90, calcDF: 0, aprovSS: 90, aprovDF: 0, valorSS: 37.5, valorDF: 0 },
              'PJ_901|2026-11-17': { status: 'RECUSADO', calcSS: 120, calcDF: 0, aprovSS: 0, aprovDF: 0, valorSS: 0, valorDF: 0 } }
})[0];
const T = mes.totais;
t('mês: só o aprovado entra no total', [T.valor, T.minSS, T.minDF], [37.5, 90, 0]);
t('mês: domingo fica pendente de aprovação', [T.pendentes, T.pendenteMin, T.pendenteValor], [1, 240, 140]);
t('mês: um dia incompleto', T.incompletos, 1);
t('mês: segunda 24 sem registro aparece como ausência informativa',
  mes.dias.filter(d => d.semRegistro).map(d => d.dia), ['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-24']);
const mesSemAprov = G.pjMontarMes('2026-11', { pessoas: [pessoa], eventos, feriados: {}, regras: Object.assign({}, REGRAS, { exigeAprovacao: false }),
  agora: '2026-11-25 10:00:00', inicioControle: '2026-11-16', decisoes: {} })[0];
t('sem exigir aprovação: tudo calculado entra', mesSemAprov.totais.valor, 37.5 + 50 + 140);
const divergente = G.pjMontarMes('2026-11', { pessoas: [pessoa], eventos, feriados: {}, regras: REGRAS, agora: '2026-11-25 10:00:00', inicioControle: '2026-11-16',
  decisoes: { 'PJ_901|2026-11-16': { status: 'APROVADO', calcSS: 60, calcDF: 0, aprovSS: 60, aprovDF: 0, valorSS: 25, valorDF: 0 } } })[0];
t('aprovação feita antes de uma correção é sinalizada', divergente.totais.divergentes, 1);
const emCurso = G.pjMontarMes('2026-11', { pessoas: [pessoa], eventos: [Object.assign(ev('2026-11-16 08:00', 'ENTRADA'), { codigo: 'PJ_901' })],
  feriados: {}, regras: Object.assign({}, REGRAS, { exigeAprovacao: false }), agora: '2026-11-16 20:00:00', inicioControle: '2026-11-16', decisoes: {} })[0];
t('quem ainda está lá dentro não entra no total do mês', [emCurso.dias[0].emAndamento, emCurso.totais.valor], [true, 0]);

/* ── 5. Feriados ───────────────────────────────────────────── */
t('Páscoa 2026 e 2027', [G.pjPascoa(2026), G.pjPascoa(2027)], ['2026-04-05', '2027-03-28']);
t('Sexta-feira Santa 2027', G.pjFeriadosSugeridos(2027).find(f => /Santa/.test(f.descricao)).data, '2027-03-26');

/* ── 6. Fotos ──────────────────────────────────────────────── */
const base = [
  { codigo: 'PJ_1', nome: 'Carolina Teste Um', cargo: 'Gerente Comercial', departamento: 'Administrativo', ativo: true },
  { codigo: 'PJ_2', nome: 'Caroline Teste Dois', cargo: 'Analista financeiro', departamento: 'Administrativo', ativo: true },
  { codigo: 'PJ_3', nome: 'Gustavo Silva Tres', cargo: 'Ajudante geral', departamento: 'Oficina', ativo: true },
  { codigo: 'CLT_4', nome: 'Gustavo Souza Quatro', cargo: 'Auxiliar de Funileiro', departamento: 'Oficina', ativo: true },
  { codigo: 'PJ_5', nome: 'Wellington Cinco', cargo: 'Ajudante geral', departamento: 'Oficina', ativo: true },
  { codigo: 'PJ_6', nome: 'Beto Seis', cargo: 'Soldador', departamento: 'Oficina', ativo: true },
  { codigo: 'PJ_7', nome: 'Ana Sete', cargo: 'Assistente', departamento: 'Administrativo', ativo: true }
];
const arquivos = ['FOTO CAROL COMERCIAL.jpeg', 'FOTO CAROL FINANCEIRO FOTO.jpeg', 'FOTO GUSTAVO OFICINA.jpeg',
                  'FOTO GUSTAVO FUNILARIA.jpeg', 'FOTO WELINGTON.jpeg', 'PJ_6 qualquer coisa.png', 'FOTO DESCONHECIDO.jpeg', 'FOTO ANA.jpeg']
  .map((n, i) => ({ id: 'id' + i + 'xxxxxxxxxxxxxxxxxxxxxxx', nome: n, v: '1' }));
const F = G.pjCasarFotos(arquivos, base, {});
const quem = c => F.mapa[c] ? F.mapa[c].nome : null;
t('Carol comercial ≠ Carol financeiro', [quem('PJ_1'), quem('PJ_2')], ['FOTO CAROL COMERCIAL.jpeg', 'FOTO CAROL FINANCEIRO FOTO.jpeg']);
t('Gustavo oficina ≠ Gustavo funilaria', [quem('PJ_3'), quem('CLT_4')], ['FOTO GUSTAVO OFICINA.jpeg', 'FOTO GUSTAVO FUNILARIA.jpeg']);
t('grafia diferente (Wellington/Welington)', quem('PJ_5'), 'FOTO WELINGTON.jpeg');
t('código do RH no nome do arquivo', quem('PJ_6'), 'PJ_6 qualquer coisa.png');
t('foto de quem não está na base sobra', F.sobras.map(a => a.nome), ['FOTO DESCONHECIDO.jpeg']);
const F2 = G.pjCasarFotos(arquivos, base, { PJ_7: 'FOTO DESCONHECIDO.jpeg' });
t('vínculo manual do RH vence o automático', F2.mapa.PJ_7.nome, 'FOTO DESCONHECIDO.jpeg');

/* ── 6b. Socorro: o que ele "engole" da hora extra ─────────── */
const JD = { ini: 480, fim: 1020 };   // 08:00–17:00
t('socorro dentro do expediente não absorve nada', G.pjSocorroAbsorvido([[480, 1020]], [[600, 720]], JD, false), 0);
t('socorro que passa do horário absorve só a parte depois dele', G.pjSocorroAbsorvido([[480, 1200]], [[960, 1140]], JD, false), 120);
t('socorro antes do horário só absorve se a regra conta o "antes"', [G.pjSocorroAbsorvido([[360, 600]], [[360, 480]], JD, false), G.pjSocorroAbsorvido([[360, 600]], [[360, 480]], JD, true)], [0, 120]);
t('dia sem expediente: tudo o que o socorro cobre é absorvido', G.pjSocorroAbsorvido([[480, 780]], [[480, 780]], null, false), 300);
t('socorro sem o colaborador na portaria não absorve nada (não há extra)', G.pjSocorroAbsorvido([], [[480, 780]], null, false), 0);
t('socorros emendados/sobrepostos viram um só (sem contar em dobro)', G.pjUnirIntervalos([[600, 700], [650, 800], [800, 900], [1000, 1100]]), [[600, 900], [1000, 1100]]);
t('sem socorro: nada muda', G.pjSocorroAbsorvido([[480, 1200]], [], JD, false), 0);

/* ── 7. Diversos ───────────────────────────────────────────── */
t('nome curto', [G.pjNomeCurto('Francisco das Chagas de Oliveira Filho'), G.pjNomeCurto('Ana Claudia da Silva'), G.pjNomeCurto('Beto')],
  ['Francisco das Chagas', 'Ana Claudia', 'Beto']);
t('número em formato brasileiro', [G.pjNum('R$ 1.234,56', 0), G.pjNum('25', 0), G.pjNum('', 7)], [1234.56, 25, 7]);
t('ID de link do Google', G.pjExtrairId('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456/edit?usp=sharing'), '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456');

/* ── 8. Escala: 10× a equipe por um mês inteiro ────────────── */
const muitas = [], evs = [];
for (let p = 0; p < 170; p++) {
  muitas.push(Object.assign({}, pessoa, { codigo: 'PJ_' + (1000 + p) }));
  for (let d = 1; d <= 30; d++) {
    const dd = '2026-11-' + String(d).padStart(2, '0');
    evs.push(Object.assign(ev(dd + ' 08:00', 'ENTRADA'), { codigo: 'PJ_' + (1000 + p) }));
    evs.push(Object.assign(ev(dd + ' 18:' + String(d % 60).padStart(2, '0'), 'SAIDA'), { codigo: 'PJ_' + (1000 + p) }));
  }
}
const t0 = Date.now();
G.pjMontarMes('2026-11', { pessoas: muitas, eventos: evs, feriados: {}, regras: REGRAS, agora: '2026-12-01 08:00:00', inicioControle: '2026-11-01', decisoes: {} });
const ms = Date.now() - t0;
t('170 pessoas × 30 dias (' + evs.length + ' registros) em menos de 1 s', ms < 1000, true);

console.log((falhou ? '\nFALHOU: ' + falhou + ' de ' + (ok + falhou) : 'OK — ' + ok + ' testes') + ' · escala: ' + evs.length + ' registros em ' + ms + ' ms');
process.exit(falhou ? 1 : 0);
