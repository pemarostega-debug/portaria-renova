/**
 * Teste de ponta a ponta do backend ColaboradoresPJ.gs, num Google simulado
 * (ferramentas/simulador-gas.js). Nada aqui toca planilha real.
 *
 *   node ferramentas/testar-backend-pj.js
 *
 * Roteiro: instala → porteiro entra → registra entrada/saída (inclusive sem
 * internet e com o relógio do aparelho errado) → reenvio não duplica →
 * desfazer → RH vê o mês, aprova, corrige, ajusta pessoa e regras → acessos
 * negados onde devem ser → nenhum CPF/salário sai do servidor.
 */
const path = require('path');
const { criarAmbiente, sp } = require('./simulador-gas');

let ok = 0, falhas = 0;
function t(nome, real, esperado) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) { ok++; return; }
  falhas++;
  console.log('✗ ' + nome + '\n    veio:     ' + a + '\n    esperado: ' + b);
}
function exigir(nome, resp) {
  if (!resp.success) { falhas++; console.log('✗ ' + nome + ': ' + resp.error); throw new Error('parou em: ' + nome); }
  ok++;
  return resp.data;
}

const amb = criarAmbiente({ sessoesPortal: {
  'tok-admin': { usuario: 'admin', nome: 'Administrador', papel: 'admin' },
  'tok-rh':    { usuario: 'rh.teste', nome: 'RH Teste', papel: 'comum' },
  'tok-comum': { usuario: 'fulano', nome: 'Fulano', papel: 'comum' }
} });
amb.carregar(path.join(__dirname, '..', 'apps-script', 'ColaboradoresPJ.gs'));
amb.relogio(sp('2026-11-16 07:00'));   // segunda-feira

// Planilha do RH, com colunas sensíveis que NUNCA podem sair do servidor.
const CPF = '123.456.789-09', SALARIO = 'R$ 9.876,54';
const rh = amb.novaPlanilha('RH');
const HOR = 'Seg a Qui 08:00 as 18:00 Sex 08:00 as 17:00 com 1H intervalo e Sab 08:00 as 12:00';
amb.preencher(rh, 'colaboradores e PJ', [
  ['Curriculo', 'Status', 'Tipo', 'Codigo RH', 'Matricula interna/CNPJ', 'Admissão', 'Colaborador', 'Cargo', 'Salário', 'Horário ', 'Departamento', 'CPF', 'Telefone '],
  ['não', 'Ativo', 'PJ', 'PJ_101', '00.000.000/0001-00', '01/01/2026', 'Ana Teste Silva', 'Soldador', SALARIO, HOR, 'Oficina', CPF, '12 90000-0000'],
  ['não', 'Ativo', 'PJ', 'PJ_102', 'x', '01/01/2026', 'Bruno Teste Souza', 'Mecânico', SALARIO, 'Seg a Sex 07:00 as 17:00 com 1H de intervalo e Sab 07:00 as 11:00', 'Oficina', CPF, ''],
  ['não', 'Ativo', 'PJ', 'PJ_103', 'x', '01/01/2026', 'Carla Teste Remota', 'Analista', SALARIO, 'Hibrido', 'Administrativo', CPF, ''],
  ['não', 'Demitido', 'PJ', 'PJ_104', 'x', '01/01/2026', 'Davi Teste Saiu', 'Mecânico', SALARIO, HOR, 'Oficina', CPF, ''],
  ['não', 'Ativo', 'CLT', 'CLT_101', 'x', '01/01/2026', 'Eva Teste Clt', 'Porteiro', SALARIO, HOR, 'Portaria', CPF, ''],
  ['não', 'Ativo', 'PJ', 'PRO_101', '', '', 'Fabio Teste Socio', '', '', '', '', '', ''],
  ['não', 'Ativo', 'PJ', 'PJ_105', 'x', '01/01/2026', 'Gil Teste Semhora', 'Soldador', SALARIO, '', 'Oficina', CPF, ''],
  ['', '', 'ajustar na contabilidade', '', '', '', '', '', '', '', '', '', '']
]);
amb.preencher(rh, 'valores automáticos', [['Evento ', 'Valor '], ['Gratificação segunda a sabado/hora', 'R$ 25,00'], ['Gratificação domingos e feriados/hora', 'R$ 35,00']]);
amb.pasta('pasta-fotos-teste-0000000000000', [{ nome: 'FOTO ANA.jpeg' }, { nome: 'FOTO BRUNO OFICINA.jpeg' }, { nome: 'FOTO EVA.jpeg' }]);

/* ── 1. Instalação ── */
const ctrl = amb.novaPlanilha('Controle PJ');
amb.ativar(ctrl);
amb.G.instalar();
amb.G.pjCfgGravar({ planilha_rh: 'https://docs.google.com/spreadsheets/d/' + rh.getId() + '/edit', pasta_fotos: 'https://drive.google.com/drive/folders/pasta-fotos-teste-0000000000000' });
// Os cenários 1 a 9 testam a leitura do horário que vem do RH. A regra "horário da unidade vale para todos"
// tem a sua própria bateria (seção 12); aqui ela fica desligada e sem exclusões por código.
amb.G.pjCfgGravar({ jornada_unidade_prevalece: 'Não', codigos_excluidos: '' });
const diag = amb.G.instalar();   // segunda vez: idempotente, e já com a planilha do RH
t('instalação cria as abas', ctrl.getSheets().map(a => a.getName()).sort(), ['Auditoria', 'Config', 'Feriados', 'HoraExtra', 'Pessoas', 'Registros', 'Socorros']);
t('diagnóstico conta quem vai para a portaria', /3 colaboradores PJ vão para a portaria/.test(diag), true);
t('diagnóstico avisa quem está sem horário', /sem horário reconhecido.*Gil Teste/.test(diag), true);
t('feriados nacionais sugeridos', ctrl.getSheetByName('Feriados').getLastRow() - 1, 22);
const senha = amb.G.pjCfg(true).senha_portaria;
t('senha da portaria gerada', /^RT-[A-Z0-9]{6}$/.test(senha), true);

/* ── 2. Login da portaria ── */
t('senha errada recusada', amb.post({ action: 'login', senha: 'errada' }).codigo, 'SENHA');
const tokP = exigir('login com a senha certa', amb.post({ action: 'login', senha })).token;
t('sem token não entra', amb.get({ action: 'pj_estado' }).codigo, 'SESSAO');
t('token adulterado não entra', amb.get({ action: 'pj_estado', token: tokP.slice(0, -2) + 'xx' }).codigo, 'SESSAO');

let est = exigir('estado da portaria', amb.get({ action: 'pj_estado', token: tokP }));
t('na portaria: PJ ativos e não híbridos, sem CLT, sem pró-labore', est.pessoas.map(p => p.codigo).sort(), ['PJ_101', 'PJ_102', 'PJ_105']);
t('fotos casadas (Bruno com sobrenome de cargo)', est.pessoas.map(p => !!p.foto), [true, true, false]);
t('jornada de hoje', est.pessoas.find(p => p.codigo === 'PJ_102').jornadaHoje, { ini: '07:00', fim: '17:00' });

/* ── 3. Registros ── */
function tocar(codigo, tipo, quandoNoAparelho, enviadoEmNoAparelho, id) {
  return amb.post({ action: 'pj_registrar', token: tokP, enviadoEm: enviadoEmNoAparelho,
                    eventos: [{ id: id || ('ev-' + Math.random().toString(36).slice(2, 12)), codigo, tipo, ts: quandoNoAparelho }] });
}
amb.relogio(sp('2026-11-16 07:58'));
let r = exigir('entrada', tocar('PJ_101', 'ENTRADA', Date.now(), Date.now(), 'ev-ana-1'));
t('entrada gravada na hora do servidor', r.resultados[0].dataHora, '2026-11-16 07:58:00');
t('ela aparece dentro', r.estado.pessoas.find(p => p.codigo === 'PJ_101').estado, 'dentro');

// Aparelho com o relógio 2 horas adiantado: a hora gravada continua certa.
amb.relogio(sp('2026-11-16 07:03'));
const relogioErrado = Date.now() + 2 * 3600000;
r = exigir('entrada com relógio errado', tocar('PJ_102', 'ENTRADA', relogioErrado, relogioErrado));
t('relógio do aparelho errado não importa', r.resultados[0].dataHora, '2026-11-16 07:03:00');

// Reenvio do mesmo toque (a resposta se perdeu no caminho): não duplica.
r = exigir('reenvio', tocar('PJ_101', 'ENTRADA', Date.now(), Date.now(), 'ev-ana-1'));
t('reenvio vira "repetido"', r.resultados[0].repetido, true);
t('uma linha só', ctrl.getSheetByName('Registros').getLastRow(), 3);

// Saída às 19:30, mas o aparelho estava sem internet e só mandou às 21:10.
amb.relogio(sp('2026-11-16 21:10'));
const aparelho = Date.now() + 37000;   // relógio do aparelho 37 s adiantado, de brinde
r = exigir('saída offline', tocar('PJ_101', 'SAIDA', aparelho - 100 * 60000, aparelho));
t('saída offline gravada com a hora do toque', r.resultados[0].dataHora, '2026-11-16 19:30:00');
const linhaSaida = ctrl.getSheetByName('Registros').getRange(4, 1, 1, 12).getValues()[0];
t('registro offline ganha observação', /sem internet/.test(linhaSaida[10]), true);
t('tudo gravado como texto (nada virou data)', linhaSaida.every(v => typeof v === 'string'), true);

amb.relogio(sp('2026-11-16 17:05'));
r = exigir('saída do Bruno', tocar('PJ_102', 'SAIDA', Date.now(), Date.now()));
t('toque duplo na mesma saída é ignorado', exigir('toque duplo', tocar('PJ_102', 'SAIDA', Date.now() + 1000, Date.now() + 1000)).resultados[0].repetido, true);
t('colaborador fora da lista é recusado', exigir('fora da lista', tocar('PJ_103', 'ENTRADA', Date.now(), Date.now())).resultados[0].ok, false);
t('id inválido é recusado', exigir('id inválido', tocar('PJ_101', 'ENTRADA', Date.now(), Date.now(), '<script>')).resultados[0].ok, false);

/* ── 4. Desfazer ── */
amb.relogio(sp('2026-11-16 17:20'));
r = exigir('entrada por engano', tocar('PJ_105', 'ENTRADA', Date.now(), Date.now(), 'ev-gil-engano'));
amb.relogio(sp('2026-11-16 17:25'));
r = exigir('desfazer em 5 min', amb.post({ action: 'pj_desfazer', token: tokP, id: 'ev-gil-engano' }));
t('desfeito: volta para fora', r.estado.pessoas.find(p => p.codigo === 'PJ_105').estado, 'fora');
amb.relogio(sp('2026-11-16 17:30'));
exigir('outra entrada', tocar('PJ_105', 'ENTRADA', Date.now(), Date.now(), 'ev-gil-2'));
amb.relogio(sp('2026-11-16 17:45'));
t('depois de 10 min não desfaz mais na portaria', amb.post({ action: 'pj_desfazer', token: tokP, id: 'ev-gil-2' }).codigo, 'TARDE');

/* ── 5. Acesso ao módulo do RH ── */
t('porteiro não vê o RH', amb.get({ action: 'rh_mes', token: tokP, mes: '2026-11' }).codigo, 'ACESSO');
t('usuário comum não vê o RH', amb.get({ action: 'rh_mes', token: 'tok-comum', mes: '2026-11' }).codigo, 'ACESSO');
t('sessão inválida', amb.get({ action: 'rh_mes', token: 'tok-falso', mes: '2026-11' }).codigo, 'SESSAO');
exigir('admin libera o login do RH', amb.post({ action: 'rh_config_set', token: 'tok-admin', valores: { usuarios_rh: 'rh.teste' } }));
t('RH liberado não muda regra', amb.post({ action: 'rh_config_set', token: 'tok-rh', valores: { valor_hora_seg_sab: 99 } }).codigo, 'ACESSO');

/* ── 6. Mês, aprovação e correção ── */
amb.relogio(sp('2026-11-17 09:00'));
let mes = exigir('mês para o RH', amb.get({ action: 'rh_mes', token: 'tok-rh', mes: '2026-11' }));
let ana = mes.pessoas.find(p => p.codigo === 'PJ_101');
let dAna = ana.dias.find(d => d.dia === '2026-11-16');
t('Ana: 1h30 de extra pendente (R$ 37,50)', [dAna.extraMin, dAna.valor, dAna.efetivo.estado], [90, 37.5, 'PENDENTE']);
t('Ana: total do mês ainda zero (pendente não paga)', [ana.totais.valor, ana.totais.pendentes], [0, 1]);
const gil = mes.pessoas.find(p => p.codigo === 'PJ_105');
t('Gil sem horário: não calcula', gil.dias.find(d => d.dia === '2026-11-16').semJornada, true);

t('aprovar com minutos mexidos exige motivo', exigir('aprovar sem motivo', amb.post({ action: 'rh_decidir', token: 'tok-rh', itens: [{ codigo: 'PJ_101', dia: '2026-11-16', acao: 'APROVAR', minutos: 60 }] })).itens[0].ok, false);
exigir('aprovar', amb.post({ action: 'rh_decidir', token: 'tok-rh', itens: [{ codigo: 'PJ_101', dia: '2026-11-16', acao: 'APROVAR' }] }));
mes = exigir('mês depois de aprovar', amb.get({ action: 'rh_mes', token: 'tok-rh', mes: '2026-11' }));
ana = mes.pessoas.find(p => p.codigo === 'PJ_101');
t('aprovado entra no total', [ana.totais.valor, ana.totais.minSS], [37.5, 90]);

// O RH corrige a saída (na verdade foi 19:00): a aprovação antiga fica marcada como divergente.
const idSaida = ana.dias.find(d => d.dia === '2026-11-16').sessoes[0].s.id;
t('correção sem motivo é recusada', amb.post({ action: 'rh_registro', token: 'tok-rh', acao: 'corrigir', id: idSaida, dataHora: '2026-11-16 19:00', motivo: '' }).codigo, 'PEDIDO');
t('correção para o futuro é recusada', amb.post({ action: 'rh_registro', token: 'tok-rh', acao: 'corrigir', id: idSaida, dataHora: '2026-12-16 19:00', motivo: 'teste' }).codigo, 'PEDIDO');
exigir('corrigir saída', amb.post({ action: 'rh_registro', token: 'tok-rh', acao: 'corrigir', id: idSaida, dataHora: '2026-11-16 19:00', motivo: 'conferido na câmera' }));
mes = exigir('mês depois da correção', amb.get({ action: 'rh_mes', token: 'tok-rh', mes: '2026-11' }));
ana = mes.pessoas.find(p => p.codigo === 'PJ_101');
dAna = ana.dias.find(d => d.dia === '2026-11-16');
t('cálculo novo: 60 min; aprovação antiga sinalizada', [dAna.extraMin, dAna.decisao.diverge, ana.totais.divergentes], [60, true, 1]);
exigir('reaprovar', amb.post({ action: 'rh_decidir', token: 'tok-rh', itens: [{ codigo: 'PJ_101', dia: '2026-11-16', acao: 'APROVAR' }] }));
ana = exigir('mês final', amb.get({ action: 'rh_mes', token: 'tok-rh', mes: '2026-11' })).pessoas.find(p => p.codigo === 'PJ_101');
t('reaprovado: R$ 25,00 e sem divergência', [ana.totais.valor, ana.totais.divergentes], [25, 0]);

// Saída esquecida: o RH lança.
exigir('lançar saída do Gil', amb.post({ action: 'rh_registro', token: 'tok-rh', acao: 'add', codigo: 'PJ_105', tipo: 'SAIDA', dataHora: '2026-11-16 18:00', motivo: 'esqueceu de registrar' }));
est = exigir('estado depois do lançamento', amb.get({ action: 'pj_estado', token: tokP }));
t('Gil não aparece mais como dentro', est.pessoas.find(p => p.codigo === 'PJ_105').estado, 'fora');

/* ── 7. Pessoas e regras ── */
exigir('RH dá horário ao Gil', amb.post({ action: 'rh_pessoa', token: 'tok-rh', codigo: 'PJ_105', horario: 'Seg a Sex 08:00 as 17:00 com 1H intervalo' }));
t('horário que não dá para entender é recusado', amb.post({ action: 'rh_pessoa', token: 'tok-rh', codigo: 'PJ_105', horario: 'de manhã' }).codigo, 'PEDIDO');
const pes = exigir('incluir híbrida à mão', amb.post({ action: 'rh_pessoa', token: 'tok-rh', codigo: 'PJ_103', controle: 'incluir' }));
t('híbrida incluída à mão vai para a portaria', pes.pessoas.find(p => p.codigo === 'PJ_103').naPortaria, true);
t('foto de CLT tem dona: não aparece como sobra', pes.fotosSemDono, []);
mes = exigir('mês com o horário novo do Gil', amb.get({ action: 'rh_mes', token: 'tok-rh', mes: '2026-11' }));
const dGil = mes.pessoas.find(p => p.codigo === 'PJ_105').dias.find(d => d.dia === '2026-11-16');
t('Gil agora calcula: chegou 17:30 e saiu 18:00 — a falta do dia cobre a meia hora', [dGil.semJornada, dGil.depoisMin, dGil.extraMin], [false, 30, 0]);

const cfg = exigir('admin muda o valor da hora', amb.post({ action: 'rh_config_set', token: 'tok-admin', valores: { valor_hora_seg_sab: '30' } }));
t('regra nova vale', cfg.regras.valorSS, 30);
t('regra gravada como texto', typeof ctrl.getSheetByName('Config').getRange(8, 2).getValue(), 'string');
t('auditoria registra tudo', ctrl.getSheetByName('Auditoria').getLastRow() - 1 >= 8, true);

/* ── 8. Fotos ── */
const foto = exigir('foto', amb.get({ action: 'pj_foto', token: tokP, codigo: 'PJ_101' }));
t('foto vem em base64', Buffer.from(foto.base64, 'base64').toString(), 'foto-falsa-FOTO ANA.jpeg');
t('foto de quem não está na portaria não sai', amb.get({ action: 'pj_foto', token: tokP, codigo: 'CLT_101' }).success, false);

/* ── 9. Vazamento ── */
const tudo = JSON.stringify([
  amb.get({ action: 'pj_estado', token: tokP }), amb.get({ action: 'rh_mes', token: 'tok-admin', mes: '2026-11' }),
  amb.get({ action: 'rh_pessoas', token: 'tok-admin' }), amb.get({ action: 'rh_config', token: 'tok-admin' })
]);
t('nenhum CPF, salário, CNPJ ou telefone sai do servidor', [tudo.includes(CPF), tudo.includes('9.876'), tudo.includes('0001-00'), tudo.includes('90000')], [false, false, false, false]);
t('senha da portaria não sai para o portal', tudo.includes(senha), false);

/* ── 12. Socorro, horário da unidade e exclusões ── */
// 12a. Horário da unidade (Jacareí) vale para todos.
amb.relogio(sp('2026-11-19 06:30'));   // quinta-feira
amb.G.pjCfgGravar({ jornada_unidade_prevalece: 'Sim' });
const tokPx = exigir('login (unidade)', amb.post({ action: 'login', senha })).token;
est = exigir('estado com horário da unidade', amb.get({ action: 'pj_estado', token: tokPx }));
t('unidade: Bruno agora 08:00–17:00 (e não o 07:00 do RH)', est.pessoas.find(p => p.codigo === 'PJ_102').jornadaHoje, { ini: '08:00', fim: '17:00' });
t('unidade: Gil sem horário no RH passa a ter horário', est.pessoas.find(p => p.codigo === 'PJ_105').semJornada, false);
t('unidade: origem do horário', exigir('rh_pessoas', amb.get({ action: 'rh_pessoas', token: 'tok-admin' })).pessoas.find(p => p.codigo === 'PJ_102').origemJornada, 'unidade');
const sabU = amb.G.pjParseJornada(amb.G.pjCfg(true).jornada_unidade);
t('unidade: sábado 08–12 sem intervalo; sexta 08–17 com 1h', [sabU.dias[6].fim - sabU.dias[6].ini, sabU.dias[6].intervalo, sabU.dias[5].intervalo], [240, 0, 60]);

// 12b. Exclusão por código (gestão).
amb.G.pjCfgGravar({ codigos_excluidos: 'PJ_105' });
est = exigir('estado com exclusão', amb.get({ action: 'pj_estado', token: tokPx }));
t('exclusão por código: Gil fora da portaria', est.pessoas.some(p => p.codigo === 'PJ_105'), false);
t('exclusão por código: motivo no RH', exigir('rh_pessoas', amb.get({ action: 'rh_pessoas', token: 'tok-admin' })).pessoas.find(p => p.codigo === 'PJ_105').motivo, 'excluido');
amb.G.pjCfgGravar({ codigos_excluidos: '' });

// 12c. Faixas do socorro, pela hora do FIM.
const F = (fim) => amb.G.pjSocorroFaixa(fim, { '2026-11-20': 'Consciência Negra' }, amb.G.pjRegras(amb.G.pjCfg(true)));
t('faixa: quarta 19:30 → dia R$100', [F('2026-11-18 19:30:00').faixa, F('2026-11-18 19:30:00').valor], ['DIA', 100]);
t('faixa: quarta 22:00 em ponto ainda é dia', F('2026-11-18 22:00:00').faixa, 'DIA');
t('faixa: quarta 22:01 → noite R$120', [F('2026-11-18 22:01:00').faixa, F('2026-11-18 22:01:00').valor], ['NOITE', 120]);
t('faixa: começou 21:30 e terminou 23:00 → vale o fim (noite)', F('2026-11-18 23:00:00').faixa, 'NOITE');
t('faixa: madrugada (03:00) → noite', F('2026-11-18 03:00:00').faixa, 'NOITE');
t('faixa: sábado 10:00 → dia', F('2026-11-21 10:00:00').faixa, 'DIA');
t('faixa: domingo → R$120', [F('2026-11-22 10:00:00').faixa, F('2026-11-22 10:00:00').valor], ['DF', 120]);
t('faixa: feriado → R$120', [F('2026-11-20 10:00:00').faixa, F('2026-11-20 10:00:00').valor], ['DF', 120]);

// 12d. Lançar socorro na portaria (horário do RH: Bruno 07:00–17:00).
amb.G.pjCfgGravar({ jornada_unidade_prevalece: 'Não' });
const toque = (id, codigo, tipo) => exigir('toque ' + id, amb.post({ action: 'pj_registrar', token: tokPx, enviadoEm: Date.now(), eventos: [{ id, codigo, tipo, ts: Date.now() }] }));
amb.relogio(sp('2026-11-19 07:00')); toque('ev-bruno-q-ent', 'PJ_102', 'ENTRADA');
amb.relogio(sp('2026-11-19 22:40')); toque('ev-bruno-q-sai', 'PJ_102', 'SAIDA');
const diaBruno = () => exigir('rh_mes', amb.get({ action: 'rh_mes', token: 'tok-admin', mes: '2026-11' })).pessoas.find(p => p.codigo === 'PJ_102');
let b = diaBruno(), dq = b.dias.find(d => d.dia === '2026-11-19');
const vSS = amb.G.pjRegras(amb.G.pjCfg(true)).valorSS, rd = (min) => Math.round(min / 60 * vSS * 100) / 100;
t('sem socorro: 17:00 → 22:40 = 5h40 de extra', [dq.extraMin, dq.valor, dq.socorroAbsorvidoMin], [340, rd(340), 0]);

amb.relogio(sp('2026-11-19 22:45'));
const socBody = (o) => Object.assign({ action: 'pj_socorro', token: tokPx, id: 'soc-bruno-1', codigo: 'PJ_102', inicio: '2026-11-19 19:30', fim: '2026-11-19 22:30', obs: 'Caminhão parado na estrada' }, o || {});
const rs = exigir('lançar socorro', amb.post(socBody()));
t('socorro lançado: faixa noite', rs.resultado.faixa, 'NOITE');
t('portaria vê o socorro, mas SEM valor em dinheiro', [rs.socorros.length, JSON.stringify(rs).includes('"valor"'), rs.socorros[0].faixa], [1, false, 'NOITE']);
t('reenvio do mesmo lançamento não duplica', [exigir('reenvio', amb.post(socBody())).resultado.repetido, exigir('lista', amb.get({ action: 'pj_socorros', token: tokPx })).socorros.length], [true, 1]);
t('socorro em cima de outro do mesmo colaborador é recusado', amb.post(socBody({ id: 'soc-bruno-2', inicio: '2026-11-19 20:00', fim: '2026-11-19 21:00' })).codigo, 'PEDIDO');
t('fim antes do início é recusado', amb.post(socBody({ id: 'soc-bruno-3', inicio: '2026-11-19 12:00', fim: '2026-11-19 11:00' })).codigo, 'PEDIDO');
t('socorro no futuro é recusado', amb.post(socBody({ id: 'soc-bruno-4', inicio: '2026-11-19 22:00', fim: '2026-11-19 23:50' })).codigo, 'PEDIDO');
t('atendimento de mais de 12h é recusado', amb.post(socBody({ id: 'soc-bruno-5', inicio: '2026-11-18 07:00', fim: '2026-11-19 07:30' })).codigo, 'PEDIDO');
t('colaborador fora da lista (CLT) é recusado', amb.post(socBody({ id: 'soc-eva-1', codigo: 'CLT_101', inicio: '2026-11-19 08:00', fim: '2026-11-19 09:00' })).codigo, 'PEDIDO');
t('id inválido é recusado', amb.post(socBody({ id: 'x' })).codigo, 'PEDIDO');
t('sem sessão não lança', amb.post(socBody({ token: '' })).codigo, 'SESSAO');
t('usuário comum do portal (fora do RH) não lança', amb.post(socBody({ token: 'tok-comum', id: 'soc-comum-1' })).codigo, 'ACESSO');

// 12e. Socorro NÃO soma com hora extra: as 3h do atendimento saem da hora extra; 17:00–18:30 continua.
b = diaBruno(); dq = b.dias.find(d => d.dia === '2026-11-19');
t('com socorro: só 2h40 de extra fora do atendimento (17:00–19:30 e 22:30–22:40)', [dq.extraMin, dq.valor, dq.socorroAbsorvidoMin], [160, rd(160), 180]);
t('totais do mês trazem o socorro', [b.totais.socorroQtd, b.totais.socorroValor, b.totais.socorroAbsorvidoMin, b.socorros[0].faixa, b.socorros[0].valor], [1, 120, 180, 'NOITE', 120]);

// 12f. Cancelar: portaria nas primeiras 24h; RH exige motivo; cancelado, a hora extra volta inteira.
t('RH não cancela sem motivo', amb.post({ action: 'rh_socorro_desfazer', token: 'tok-admin', id: 'soc-bruno-1' }).codigo, 'PEDIDO');
t('quem não é RH não cancela pelo caminho do RH', amb.post({ action: 'rh_socorro_desfazer', token: 'tok-comum', id: 'soc-bruno-1', motivo: 'x' }).codigo, 'ACESSO');
t('portaria cancela o próprio lançamento recente', exigir('desfazer', amb.post({ action: 'pj_socorro_desfazer', token: tokPx, id: 'soc-bruno-1' })).socorros.length, 0);
b = diaBruno(); dq = b.dias.find(d => d.dia === '2026-11-19');
t('socorro cancelado: a hora extra volta inteira', [dq.extraMin, dq.socorroAbsorvidoMin, b.totais.socorroQtd], [340, 0, 0]);
exigir('relançar', amb.post(socBody({ id: 'soc-bruno-6' })));
amb.relogio(sp('2026-11-21 09:00'));    // dois dias depois: a portaria já não desfaz
t('portaria não desfaz depois de 24h', amb.post({ action: 'pj_socorro_desfazer', token: tokPx, id: 'soc-bruno-6' }).codigo, 'TARDE');
exigir('RH cancela com motivo', amb.post({ action: 'rh_socorro_desfazer', token: 'tok-admin', id: 'soc-bruno-6', motivo: 'lançado no colaborador errado' }));
const acoesAud = ctrl.getSheetByName('Auditoria').getDataRange().getValues().map(l => l[2]);
t('auditoria guarda lançamento e cancelamentos', ['socorro_lancado', 'socorro_cancelado'].every(a => acoesAud.includes(a)), true);

// 12g. Domingo inteiro em socorro: nada de hora extra, só o socorro (R$120).
amb.relogio(sp('2026-11-22 08:00')); toque('ev-bruno-d-ent', 'PJ_102', 'ENTRADA');
amb.relogio(sp('2026-11-22 13:00')); toque('ev-bruno-d-sai', 'PJ_102', 'SAIDA');
amb.relogio(sp('2026-11-22 13:05'));
exigir('socorro domingo', amb.post(socBody({ id: 'soc-bruno-7', inicio: '2026-11-22 08:00', fim: '2026-11-22 13:00' })));
b = diaBruno(); dq = b.dias.find(d => d.dia === '2026-11-22');
t('domingo inteiro em socorro: sem hora extra, socorro R$120', [dq.extraMin, dq.valor, b.socorros.find(s => s.dia === '2026-11-22').valor], [0, 0, 120]);

/* ── 10. Trocar a senha derruba os aparelhos ── */
amb.G.pjCfgGravar({ senha_portaria: 'nova-senha' });
t('aparelho antigo perde o acesso', amb.get({ action: 'pj_estado', token: tokP }).codigo, 'SESSAO');

/* ── 11. Escala: 30 dias × 40 pessoas na aba Registros ── */
const linhas = [];
for (let d = 1; d <= 30; d++) for (let p = 0; p < 40; p++) {
  const dia = '2026-10-' + String(d).padStart(2, '0');
  linhas.push(['x' + d + '-' + p + 'a', 'PJ_' + (500 + p), 'Teste', 'ENTRADA', dia + ' 08:00:00', dia, 'portaria', 'portaria', dia + ' 08:00:00', 'ok', '', '']);
  linhas.push(['x' + d + '-' + p + 'b', 'PJ_' + (500 + p), 'Teste', 'SAIDA', dia + ' 18:20:00', dia, 'portaria', 'portaria', dia + ' 18:20:00', 'ok', '', '']);
}
const reg = ctrl.getSheetByName('Registros');
const regLinhas = reg.getRange(2, 1, reg.getLastRow() - 1, 12).getValues();
reg.getRange(2, 1, reg.getLastRow() - 1, 12).clearContent();
reg.insertRowsAfter(1000, 3000);
reg.getRange(2, 1, linhas.length, 12).setNumberFormat('@').setValues(linhas);
reg.getRange(2 + linhas.length, 1, regLinhas.length, 12).setNumberFormat('@').setValues(regLinhas);
const t0 = Date.now();
amb.G._pj = {};
const mesNov = exigir('mês com 2.400 registros antigos na aba', amb.get({ action: 'rh_mes', token: 'tok-admin', mes: '2026-11' }));
const ms = Date.now() - t0;
t('mês de novembro ignora outubro (lê só o bloco do mês)', mesNov.pessoas.find(p => p.codigo === 'PJ_101').totais.valor, 25);

console.log((falhas ? '\nFALHOU: ' + falhas + ' de ' + (ok + falhas) : 'OK — ' + ok + ' verificações') + ' · mês com ' + (linhas.length + regLinhas.length) + ' registros na aba em ' + ms + ' ms (simulado)');
process.exit(falhas ? 1 : 0);
