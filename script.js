/**********************
 * PagMedico Frontend *
 * Versão API (Hostinger MySQL)
 **********************/

/* ===== Utils ===== */
const BRL = (n=0)=> Number(n||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const parseMoney = (v)=> Number(String(v).replace(/[^\d,.-]/g,'').replace(/\.(?=\d{3}(?:\D|$))/g,'').replace(',','.')) || 0;
const todayISO = ()=> new Date().toISOString().slice(0,10);
const fmtDate = (iso)=> iso?.split('-').reverse().join('/') || '';

/* ===== Indicadores padrão (sempre no painel) ===== */
const DEFAULT_INDICATORS = ['CONSULTA','PROCEDIMENTO','EXAMES','AJUDA DE CUSTO'];

// aceita "YYYY-MM-DD" ou "DD/MM/YYYY"
function parseDateFlex(s){
  if(!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { // ISO
    const [y,m,d] = s.split('-').map(Number);
    return new Date(y, m-1, d);
  }
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) { // BRf
    const [d,m,y] = s.split('/').map(Number);
    return new Date(y, m-1, d);
  }
  return null;
}

function inRange(d, start, end){
  if(!d) return false;
  if(start && d < start) return false;
  if(end   && d > end)   return false;
  return true;
}


/* ===== Caches =====
   - doctors: [{id,nome,especialidade}]
   - catalog: { INDICADOR: [ {id, nome} ] }
   - catKey2Id: { "INDICADOR|Item" : item_id }
   - repassesByDoctor[doctor_id]: { map: { "INDICADOR|Item": valor }, idMap: { "INDICADOR|Item": item_id } }
*/
const CACHE = {
  doctors: [],
  catalog: {},
  catKey2Id: {},
  repassesByDoctor: {}, // doctorId -> { map, idMap }
};

/* ===== Estado de edição ===== */
let EDITING_LANC_ID = null; // != null quando estamos editando um lançamento

/* ===== Boot ===== */
document.addEventListener('DOMContentLoaded', async () => {
  const onApp = !!document.querySelector('.topbar');
  if (!onApp) return;

  setupTabs();
  setupTopbar();

  await preloadDoctors();
  await preloadCatalog();

  setupLancamento();     // usa caches e carrega repasses por médico “on change”
  setupRelatorio();      // faz busca via API
  setupPix();            // usa apiPix
  setupRepasses();       // usa apiDoctors/apiCatalog/apiRepasses
  setupDashboard();      // usa apiLanc
});

/* ===== Preloads ===== */
async function preloadDoctors(){
  CACHE.doctors = await apiDoctors.list();
}
async function preloadCatalog(){
  const cat = await apiCatalog.get();           // { IND: [ {id, nome} ] }
  CACHE.catalog = cat;
  CACHE.catKey2Id = {};
  Object.entries(cat).forEach(([indic, arr])=>{
    arr.forEach(row=>{
      CACHE.catKey2Id[`${indic}|${row.nome}`] = row.id;
    });
  });
}

/* ===== Tabs & Topbar ===== */
function setupTabs(){
  const tabs = document.querySelectorAll('.tab');
  const panes = document.querySelectorAll('.tab-pane');
  tabs.forEach(btn=>{
    btn.addEventListener('click', ()=>{
      tabs.forEach(b=>b.classList.remove('active'));
      panes.forEach(p=>p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab)?.classList.add('active');
      if (btn.dataset.tab==='tab-dashboard') renderDashboard();
    });
  });
}
function setupTopbar(){
  const todayLabel = document.getElementById('todayLabel');
  if (todayLabel){
    const d = new Date();
    const opts = {weekday:'long', day:'2-digit', month:'2-digit', year:'numeric'};
    todayLabel.textContent = d.toLocaleDateString('pt-BR', opts);
  }
  document.getElementById('logoutBtn')?.addEventListener('click', ()=>{
    sessionStorage.removeItem('pagmedico_logado');
    window.location.href='login.html';
  });
}

/* =======================
   Lançamento
======================= */
function doctorById(id){ return CACHE.doctors.find(d=> String(d.id)===String(id)); }

/** Helper para pegar a data hoje/selecionada no topo do lançamento */
function currentLancDateISO(){
  return (document.getElementById('lan_data')?.value) || todayISO();
}

async function setupLancamento(){
  const selMed = document.getElementById('lan_medico');
  const inpEsp = document.getElementById('lan_especialidade');
  const inpPix = document.getElementById('lan_chavepix');
  const inpData = document.getElementById('lan_data');
  const itensTbody = document.querySelector('#itensTable tbody');
  const totalSpan = document.getElementById('totalItens');
  if (!selMed || !inpEsp || !inpPix || !inpData || !itensTbody || !totalSpan) return;

  // preencher médicos
  fillMedicosSelect(selMed, CACHE.doctors);
  inpData.value = todayISO();

  // quando trocar a data no topo → recarrega a lista do dia selecionado
  inpData.addEventListener('change', ()=> renderLancamentosDia(inpData.value));

  // ao trocar médico, carrega repasses desse médico
  selMed.addEventListener('change', async ()=>{
    const d = doctorById(selMed.value);
    inpEsp.value = d?.especialidade || '';

    // carrega chave PIX e repasses do médico
    const allPix = await apiPix.all();
    const found = allPix.find(x=> String(x.doctor_id)===String(selMed.value));
    inpPix.value = found?.chave || '';

    await ensureRepasses(selMed.value);

    // reprocessa linhas já adicionadas (aplica valor configurado)
    Array.from(itensTbody.querySelectorAll('tr')).forEach(tr=> applyRepasseFromConfigOnRow(tr));
    updateTotal();
  });
  selMed.dispatchEvent(new Event('change'));

  document.getElementById('addItemBtn')?.addEventListener('click', ()=> addItemRow(itensTbody));
  document.getElementById('limparFormBtn')?.addEventListener('click', ()=> { itensTbody.innerHTML=''; updateTotal(); });
  document.getElementById('salvarLancamentoBtn')?.addEventListener('click', salvarLancamento);

  // carrega a lista do dia selecionado (inicialmente hoje)
  await renderLancamentosDia(inpData.value);
}

function fillMedicosSelect(selectEl, list){
  if (!selectEl) return;
  selectEl.innerHTML = list.map(d=> `<option value="${d.id}">${d.nome}</option>`).join('');
}

async function ensureRepasses(doctorId){
  if (CACHE.repassesByDoctor[doctorId]) return;
  const rows = await apiRepasses.byDoctor(doctorId);
  const map = {};
  const idMap = {};
  rows.forEach(r=>{
    const key = `${r.indicador}|${r.item}`;
    map[key] = Number(r.valor||0);
    idMap[key] = r.item_id;
  });
  CACHE.repassesByDoctor[doctorId] = { map, idMap };
}

function addItemRow(tbody){
  const indicadores = Object.keys(CACHE.catalog);
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>
      <select class="row_indicador">
        ${indicadores.map(i=>`<option>${i}</option>`).join('')}
      </select>
    </td>
    <td>
      <select class="row_item"></select>
    </td>
    <td><input type="text" class="row_repasse" inputmode="decimal"></td>
    <td><input type="number" class="row_qtd" min="1" value="1"></td>
    <td class="row_subtotal">R$ 0,00</td>
    <td><button class="btn-outline btn-del">Excluir</button></td>
  `;
  tbody.appendChild(tr);

  const selIndic = tr.querySelector('.row_indicador');
  const selItem  = tr.querySelector('.row_item');
  const repInput = tr.querySelector('.row_repasse');
  const qtdInput = tr.querySelector('.row_qtd');

  function loadItems(){
    const itens = CACHE.catalog[selIndic.value] || [];
    selItem.innerHTML = itens.map(i=>`<option>${i.nome}</option>`).join('');
    applyRepasseFromConfigOnRow(tr);
  }

  selIndic.addEventListener('change', loadItems);
  selItem.addEventListener('change', ()=>{ applyRepasseFromConfigOnRow(tr); });
  repInput.addEventListener('input', ()=>{ recomputeRow(tr); updateTotal(); });
  qtdInput.addEventListener('input', ()=>{ recomputeRow(tr); updateTotal(); });
  tr.querySelector('.btn-del').addEventListener('click', ()=>{ tr.remove(); updateTotal(); });

  loadItems();
}

function applyRepasseFromConfigOnRow(tr){
  const repInput = tr.querySelector('.row_repasse');
  const selIndic = tr.querySelector('.row_indicador');
  const selItem  = tr.querySelector('.row_item');
  const medId = (document.getElementById('lan_medico')||{}).value;
  const repData = CACHE.repassesByDoctor[medId] || {map:{}};
  const key = `${selIndic.value}|${selItem.value}`;
  const val = repData.map[key] ?? 0;
  repInput.value = Number(val).toFixed(2).replace('.', ',');
  recomputeRow(tr);
  updateTotal();
}

function recomputeRow(tr){
  const rep = parseMoney(tr.querySelector('.row_repasse').value);
  const qtd = Number(tr.querySelector('.row_qtd').value||0);
  const subtotal = rep*qtd;
  tr.querySelector('.row_subtotal').textContent = BRL(subtotal);
}

function updateTotal(){
  let total=0;
  document.querySelectorAll('#itensTable tbody tr').forEach(tr=>{
    const rep = parseMoney(tr.querySelector('.row_repasse').value);
    const qtd = Number(tr.querySelector('.row_qtd').value||0);
    total += rep*qtd;
  });
  const target = document.getElementById('totalItens');
  if (target) target.textContent = BRL(total);
}

function collectItensFromTableWithIds(){
  const rows = [];
  const medId = (document.getElementById('lan_medico')||{}).value;
  const repData = CACHE.repassesByDoctor[medId] || {idMap:{}};

  document.querySelectorAll('#itensTable tbody tr').forEach(tr=>{
    const indicador = tr.querySelector('.row_indicador').value;
    const item = tr.querySelector('.row_item').value;
    const repasse = parseMoney(tr.querySelector('.row_repasse').value);
    const qtd = Number(tr.querySelector('.row_qtd').value||0);
    if (qtd>0 && repasse>=0) {
      const key = `${indicador}|${item}`;
      let item_id = repData.idMap[key] || CACHE.catKey2Id[key];
      rows.push({indicador,item,repasse,qtd,subtotal:repasse*qtd,item_id});
    }
  });
  return rows;
}

async function salvarLancamento(){
  const medId = (document.getElementById('lan_medico')||{}).value;
  const forma = (document.getElementById('lan_forma')||{}).value;
  const status = (document.getElementById('lan_status')||{}).value;
  const data = (document.getElementById('lan_data')||{}).value || todayISO();
  const qtdConsultas = Number((document.getElementById('lan_qtdconsultas')||{}).value||0);
  const obs = (document.getElementById('lan_obs')||{}).value?.trim() || '';

  const itens = collectItensFromTableWithIds();
  if (!medId) return alert('Selecione o médico.');
  if (itens.length===0) return alert('Adicione ao menos um item.');

  // se algum item não tem id, bloqueia: precisamos cadastrá-lo antes em Repasses/Catálogo
  const missing = itens.find(i=> !i.item_id);
  if (missing){
    return alert(`O item "${missing.indicador} > ${missing.item}" ainda não existe no catálogo.\nCadastre em Repasses > "+ Adicionar Item".`);
  }

  const created = await apiLanc.create({
    doctor_id: medId,
    data, hora: new Date().toTimeString().slice(0,5),
    forma, status, qtd_consultas:qtdConsultas, obs,
    itens: itens.map(i=>({ item_id:i.item_id, repasse:i.repasse, qtd:i.qtd, subtotal:i.subtotal }))
  });

  // limpa formulário
  document.querySelector('#itensTable tbody').innerHTML='';
  updateTotal();
  alert('Lançamento salvo!');

  // se estava editando, apaga o antigo
  await finalizarEdicaoSeNecessario(created?.id);

  // recarrega a lista do dia atualmente escolhido
  await renderLancamentosDia(currentLancDateISO());
}

/** NOVO: render da tabela “Lançamentos do dia” para a data escolhida */
async function renderLancamentosDia(dateISO){
  const tbody = document.querySelector('#lancamentosHojeTable tbody');
  if (!tbody) return;
  const dia = dateISO || currentLancDateISO();
  const arr = await apiLanc.list({ de: dia, ate: dia });

  tbody.innerHTML = arr.map(l=>{
    return `
      <tr>
        <td>${l.hora?.slice(0,5)||''}</td>
        <td>${l.nome}</td>
        <td>${l.especialidade}</td>
        <td>${l.forma}</td>
        <td>
          <select data-id="${l.id}" class="hoje_status">
            ${['NÃO PAGO','LANÇADO','PAGO'].map(s=> `<option ${s===l.status?'selected':''}>${s}</option>`).join('')}
          </select>
        </td>
        <td>${l.qtd_consultas||0}</td>
        <td>${BRL(l.valor_total||0)}</td>
        <td>
          <button class="btn-outline btn-edit"  data-id="${l.id}">Editar</button>
          <button class="btn-outline btn-print" data-id="${l.id}">Recibo</button>
          <button class="btn-outline btn-del"   data-id="${l.id}">Excluir</button>
        </td>
      </tr>
    `;
  }).join('');

  // Ações
  tbody.querySelectorAll('.btn-del').forEach(btn=>{
    btn.onclick = async ()=>{
      await apiLanc.delete(btn.dataset.id);
      await renderLancamentosDia(dia);
    };
  });
  tbody.querySelectorAll('.btn-print').forEach(btn=>{
    btn.onclick = ()=> imprimirRecibo(btn.dataset.id);
  });
  tbody.querySelectorAll('.hoje_status').forEach(sel=>{
    sel.onchange = async ()=>{
      await apiLanc.updateStatus(sel.dataset.id, sel.value);
    };
  });
  tbody.querySelectorAll('.btn-edit').forEach(btn=>{
    btn.onclick = ()=> editarLancamento(btn.dataset.id);
  });
}

async function editarLancamento(id){
  const arr = await apiLanc.list({});
  const l = arr.find(x=> String(x.id)===String(id));
  if (!l) return alert('Lançamento não encontrado.');

  const selMed = document.getElementById('lan_medico');
  const inpEsp = document.getElementById('lan_especialidade');
  const inpPix = document.getElementById('lan_chavepix');
  const inpData = document.getElementById('lan_data');
  const selForma = document.getElementById('lan_forma');
  const selStatus= document.getElementById('lan_status');
  const qtdCons  = document.getElementById('lan_qtdconsultas');
  const tbody    = document.querySelector('#itensTable tbody');

  selMed.value = l.doctor_id;
  selMed.dispatchEvent(new Event('change'));
  inpEsp.value = l.especialidade || '';
  inpData.value = l.data || todayISO();
  selForma.value = l.forma || 'PIX';
  selStatus.value = l.status || 'NÃO PAGO';
  qtdCons.value = l.qtd_consultas || 0;

  tbody.innerHTML = '';
  await ensureRepasses(l.doctor_id);
  (l.itens||[]).forEach(i=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><select class="row_indicador"></select></td>
      <td><select class="row_item"></select></td>
      <td><input type="text" class="row_repasse" inputmode="decimal"></td>
      <td><input type="number" class="row_qtd" min="1" value="${i.qtd||1}"></td>
      <td class="row_subtotal">${BRL(i.subtotal|| (i.repasse||0)*(i.qtd||0))}</td>
      <td><button class="btn-outline btn-del">Excluir</button></td>
    `;
    tbody.appendChild(tr);

    const selIndic = tr.querySelector('.row_indicador');
    const selItem  = tr.querySelector('.row_item');
    const indicadores = Object.keys(CACHE.catalog);
    selIndic.innerHTML = indicadores.map(x=>`<option>${x}</option>`).join('');
    selIndic.value = i.indicador;

    const itens = CACHE.catalog[i.indicador] || [];
    selItem.innerHTML = itens.map(o=>`<option>${o.nome}</option>`).join('');
    selItem.value = i.item;

    tr.querySelector('.row_repasse').value = Number(i.repasse||0).toFixed(2).replace('.',',');

    selIndic.addEventListener('change', ()=>{
      const its = CACHE.catalog[selIndic.value] || [];
      selItem.innerHTML = its.map(o=>`<option>${o.nome}</option>`).join('');
      applyRepasseFromConfigOnRow(tr);
    });
    selItem.addEventListener('change', ()=>{ applyRepasseFromConfigOnRow(tr); });
    tr.querySelector('.row_repasse').addEventListener('input', ()=>{ recomputeRow(tr); updateTotal(); });
    tr.querySelector('.row_qtd').addEventListener('input', ()=>{ recomputeRow(tr); updateTotal(); });
    tr.querySelector('.btn-del').addEventListener('click', ()=>{ tr.remove(); updateTotal(); });
  });

  updateTotal();

  EDITING_LANC_ID = id;
  const saveBtn = document.getElementById('salvarLancamentoBtn');
  if (saveBtn){ saveBtn.textContent = 'Salvar Alterações'; }
}

async function finalizarEdicaoSeNecessario(){
  if (!EDITING_LANC_ID) return;
  try { await apiLanc.delete(EDITING_LANC_ID); } catch(e){}
  EDITING_LANC_ID = null;
  const saveBtn = document.getElementById('salvarLancamentoBtn');
  if (saveBtn) saveBtn.textContent = 'Salvar Lançamento';
  // manter a lista no dia atual escolhido
  await renderLancamentosDia(currentLancDateISO());
}

async function imprimirRecibo(id){
  const arr = await apiLanc.list({});
  const l = arr.find(x=> String(x.id)===String(id));
  if (!l) return;

  const allPix = await apiPix.all();
  const pix = (allPix.find(x=> String(x.doctor_id)===String(l.doctor_id))||{}).chave || '-';

  // Razão social e CNPJ
  const RAZAO = 'AmorSaúde Maringá';
  const CNPJ  = '28.174.682/0001-78';

  const win = window.open('','_blank');
  const itensHTML = (l.itens||[]).map(i=> `
    <tr>
      <td>${i.indicador}</td>
      <td>${i.item}</td>
      <td>${BRL(i.repasse)}</td>
      <td>${i.qtd}</td>
      <td>${BRL(i.subtotal)}</td>
    </tr>`).join('');
  const total = Number(l.valor_total||0);

  win.document.write(`
  <html><head><title>Recibo</title>
  <meta charset="utf-8"/>
  <style>
    body{font-family:Arial, Helvetica, sans-serif; padding:16px; font-size:14px;}
    .hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;}
    .brand{font-size:18px;font-weight:700;}
    .idline{color:#555;}
    h2{margin:8px 0 10px;}
    table{width:100%; border-collapse:collapse; margin-top:10px;}
    th,td{border:1px solid #ccc; padding:8px; text-align:left;}
    th{background:#f5f5f5;}
    .right{text-align:right;}
  </style>
  </head><body>
    <div class="hdr">
      <div class="brand">${RAZAO}</div>
      <div class="idline"><b>CNPJ:</b> ${CNPJ}</div>
    </div>

    <h2>Recibo de Pagamento</h2>
    <p><b>Data:</b> ${fmtDate(l.data)} ${l.hora?.slice(0,5)||''} &nbsp; | &nbsp; <b>Forma:</b> ${l.forma} &nbsp; | &nbsp; <b>Status:</b> ${l.status}</p>
    <p><b>Médico:</b> ${l.nome} &nbsp; | &nbsp; <b>Especialidade:</b> ${l.especialidade} &nbsp; | &nbsp; <b>PIX:</b> ${pix}</p>

    <table>
      <thead><tr><th>Indicador</th><th>Item</th><th>Repasse</th><th>Qtd</th><th>Subtotal</th></tr></thead>
      <tbody>${itensHTML}</tbody>
      <tfoot><tr><th colspan="4" class="right">Total</th><th>${BRL(total)}</th></tr></tfoot>
    </table>

    <p style="margin-top:40px;">Assinatura: ________________________________</p>
    <script>window.print();</script>
  </body></html>
  `);
  win.document.close();
}

/* =======================
   Relatório
======================= */
function setupRelatorio(){
  const de = document.getElementById('rel_de');
  const ate = document.getElementById('rel_ate');

  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 6); // últimos 7 dias
  if (de)  de.value  = start.toISOString().slice(0,10);
  if (ate) ate.value = end.toISOString().slice(0,10);

  const relIndic = document.getElementById('rel_indicador');
  if (relIndic){
    Object.keys(CACHE.catalog).forEach(i=>{
      const opt = document.createElement('option');
      opt.value = i; opt.textContent = i;
      relIndic.appendChild(opt);
    });
  }

  refreshRelatorioOptions();
  document.getElementById('rel_buscar')?.addEventListener('click', renderRelatorio);
  document.getElementById('rel_exportar')?.addEventListener('click', exportarCSV);

  // carrega de cara
  renderRelatorio();
}

function refreshRelatorioOptions(){
  const selMed = document.getElementById('rel_medico');
  const selEsp = document.getElementById('rel_especialidade');
  const docs = CACHE.doctors;
  if (selMed){
    selMed.innerHTML = `<option value="">(todos)</option>` + docs.map(d=> `<option value="${d.id}">${d.nome}</option>`).join('');
  }
  if (selEsp){
    const especs = [...new Set(docs.map(d=> d.especialidade))].sort();
    selEsp.innerHTML = `<option value="">(todas)</option>` + especs.map(e=> `<option>${e}</option>`).join('');
  }
}

async function renderRelatorio(){
  const table = document.getElementById('rel_table');
  if (!table) return;
  const tbody = table.querySelector('tbody');

  const all = await apiLanc.list({});
  const f = readRelFilters();

  const arr = all.filter(l=>{
    const d = parseDateFlex(l.data);
    if (!inRange(d, f.de, f.ate)) return false;
    if (f.doctor_id && String(l.doctor_id) !== String(f.doctor_id)) return false;
    if (f.especialidade && l.especialidade !== f.especialidade) return false;
    if (f.forma && l.forma !== f.forma) return false;
    if (f.status && l.status !== f.status) return false;
    if (f.indicador) {
      const ok = (l.itens||[]).some(i => i.indicador === f.indicador);
      if (!ok) return false;
    }
    return true;
  });

  if (!arr.length){
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:#777;padding:12px">Nenhum lançamento encontrado para os filtros selecionados.</td></tr>`;
    const totalSpan = document.getElementById('rel_total');
    if (totalSpan) totalSpan.textContent = BRL(0);
    const totalConsSpan = document.getElementById('rel_total_consultas');
    if (totalConsSpan) totalConsSpan.textContent = 0;
    return;
  }

  let totalPagamentos = 0;
  let totalConsultas  = 0;

  tbody.innerHTML = arr.map(l=>{
    const linhasHTML = (l.itens||[]).map(i=>{
      const val = BRL(i.subtotal || (i.repasse||0) * (i.qtd||0));
      return `${val} — ${i.indicador}: ${i.item} x${i.qtd}`;
    }).join('<br>');

    // soma com conversão robusta
    totalPagamentos += Number(l.valor_total || 0);
    totalConsultas  += parseInt(String(l.qtd_consultas ?? 0), 10) || 0;

    return `
      <tr>
        <td>${fmtDate(l.data)}</td>
        <td>${l.nome}</td>
        <td>${l.especialidade}</td>
        <td>${l.forma}</td>
        <td>${l.status}</td>
        <td>${l.qtd_consultas ?? 0}</td>
        <td>${linhasHTML}</td>
        <td>${BRL(l.valor_total||0)}</td>
      </tr>
    `;
  }).join('');

  // atualiza os totais do rodapé
  const totalSpan = document.getElementById('rel_total');
  if (totalSpan) totalSpan.textContent = BRL(totalPagamentos);

  const totalConsSpan = document.getElementById('rel_total_consultas');
  if (totalConsSpan) totalConsSpan.textContent = String(totalConsultas);
}



function readRelFilters(){
  const rawDe  = (document.getElementById('rel_de') || {}).value || '';
  const rawAte = (document.getElementById('rel_ate')|| {}).value || '';
  const f = {
    de:  parseDateFlex(rawDe),
    ate: parseDateFlex(rawAte),
    doctor_id: (document.getElementById('rel_medico')||{}).value || '',
    especialidade: (document.getElementById('rel_especialidade')||{}).value || '',
    forma: (document.getElementById('rel_forma')||{}).value || '',
    indicador: (document.getElementById('rel_indicador')||{}).value || '',
    status: (document.getElementById('rel_status')||{}).value || '',
  };
  return f;
}

async function exportarCSV(){
  const all = await apiLanc.list({});
  const f = readRelFilters();

  const arr = all.filter(l=>{
    const d = parseDateFlex(l.data);
    if (!inRange(d, f.de, f.ate)) return false;
    if (f.doctor_id && String(l.doctor_id) !== String(f.doctor_id)) return false;
    if (f.especialidade && l.especialidade !== f.especialidade) return false;
    if (f.forma && l.forma !== f.forma) return false;
    if (f.status && l.status !== f.status) return false;
    if (f.indicador) {
      const ok = (l.itens||[]).some(i => i.indicador === f.indicador);
      if (!ok) return false;
    }
    return true;
  });

  const rows = [[
    'Data','Médico','Especialidade','Forma','Status',
    'Qtd Consultas',                           // ← incluída
    'Indicador','Item','Qtd','Valor Unitário','Subtotal','Valor Total (lançamento)'
  ]];

  arr.forEach(l=>{
    const qtdCons = parseInt(String(l.qtd_consultas ?? 0), 10) || 0; // ← robusto
    (l.itens||[]).forEach(i=>{
      const valUnit = Number(i.repasse||0);
      const subtotal = Number(i.subtotal || (i.repasse||0) * (i.qtd||0));
      rows.push([
        fmtDate(l.data),
        l.nome,
        l.especialidade,
        l.forma,
        l.status,
        qtdCons,                                  // ← vai para o CSV
        i.indicador,
        i.item,
        Number(i.qtd||0),
        valUnit.toFixed(2).replace('.',','),
        subtotal.toFixed(2).replace('.',','),
        Number(l.valor_total||0).toFixed(2).replace('.',',')
      ]);
    });
  });

  const csv = rows.map(r => r.join(';')).join('\r\n');
  const blob = new Blob(['\uFEFF' + csv], {type: 'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `relatorio_pagmedico_${todayISO()}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}



/* =======================
   Chaves PIX
======================= */
function setupPix(){
  refreshPixMedicoSelect();
  renderPixTable();

  document.getElementById('pix_salvar')?.addEventListener('click', async ()=>{
    const med = (document.getElementById('pix_medico')||{}).value;
    const chave = (document.getElementById('pix_chave')||{}).value?.trim() || '';
    await apiPix.set(med, chave);
    await renderPixTable();
    alert('Chave PIX salva!');
  });

  document.getElementById('pix_limpar')?.addEventListener('click', ()=>{
    const inp = document.getElementById('pix_chave'); if (inp) inp.value='';
  });
}

function refreshPixMedicoSelect(){
  const sel = document.getElementById('pix_medico');
  if (!sel) return;
  sel.innerHTML = CACHE.doctors.map(d=> `<option value="${d.id}">${d.nome}</option>`).join('');
}

async function renderPixTable(){
  const table = document.getElementById('pix_table');
  if (!table) return;
  const tbody = table.querySelector('tbody');
  const rows = await apiPix.all();
  tbody.innerHTML = rows.map(d=>`
    <tr>
      <td>${d.nome}</td>
      <td>${d.especialidade}</td>
      <td>${d.chave||''}</td>
      <td><button class="btn-outline" data-id="${d.doctor_id}">Remover Chave</button></td>
    </tr>
  `).join('');
  tbody.querySelectorAll('button').forEach(b=>{
    b.onclick = async ()=>{
      await apiPix.clear(b.dataset.id);
      await renderPixTable();
    };
  });
}

/* =======================
   Repasses / Catálogo
======================= */
function setupRepasses(){
  // adicionar médico
  document.getElementById('dr_adicionar')?.addEventListener('click', async ()=>{
    const nome = (document.getElementById('dr_nome')||{}).value?.trim() || '';
    const esp  = (document.getElementById('dr_especialidade')||{}).value?.trim() || '';
    if (!nome || !esp) return alert('Informe nome e especialidade');
    await apiDoctors.create(nome, esp);
    await preloadDoctors();

    // limpar e atualizar seletores dependentes
    const n = document.getElementById('dr_nome'); if(n) n.value = '';
    const e = document.getElementById('dr_especialidade'); if(e) e.value = '';
    fillMedicosSelect(document.getElementById('lan_medico'), CACHE.doctors);
    refreshRepasseMedicoSelect();
    refreshPixMedicoSelect();

    await renderRepasseTable();
    await renderPixTable();
    alert('Médico adicionado!');
  });

  // sempre que trocar o médico, recarrega a tabela de repasses dele
  document.getElementById('rep_medico_select')?.addEventListener('change', renderRepasseTable);

  // painel novo item (permanece igual – para cadastrar item + valor)
  document.getElementById('rep_toggle_add')?.addEventListener('click', toggleNewItemPanel);
  document.getElementById('new_item_cancelar')?.addEventListener('click', toggleNewItemPanel);
  document.getElementById('new_item_salvar')?.addEventListener('click', saveNewCatalogItem);

  refreshRepasseMedicoSelect();
  renderRepasseTable();
  prepareNewItemIndicators();
}


function refreshRepasseMedicoSelect(){
  const sel = document.getElementById('rep_medico_select');
  if (!sel) return;
  sel.innerHTML = CACHE.doctors
    .map(d=> `<option value="${d.id}">${d.nome} — ${d.especialidade}</option>`)
    .join('');
}


function toggleNewItemPanel(){
  const panel = document.getElementById('rep_new_item_panel');
  if (!panel) return;
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) {
    prepareNewItemIndicators();
    document.getElementById('new_item_nome')?.focus();
  }
}

function prepareNewItemIndicators(){
  const sel = document.getElementById('new_indicador');
  if (!sel) return;

  const existing = Object.keys(CACHE.catalog || {});
  const all = [...DEFAULT_INDICATORS, ...existing]
    .filter((v, i, a)=> v && a.indexOf(v) === i);

  sel.innerHTML =
    all.map(v => `<option value="${v}">${v}</option>`).join('') +
    `<option value="OUTRO">OUTRO...</option>`;

  const c = document.getElementById('new_indicador_custom'); if (c) c.value = '';
  const n = document.getElementById('new_item_nome');        if (n) n.value = '';
  const v = document.getElementById('new_item_valor');       if (v) v.value = '';
  const a = document.getElementById('new_aplicar');          if (a) a.value = 'medico';
}

async function saveNewCatalogItem(){
  const selIndic = (document.getElementById('new_indicador')||{}).value;
  const indic = (selIndic==='OUTRO'
    ? (document.getElementById('new_indicador_custom')||{}).value?.trim().toUpperCase()
    : selIndic);
  const item  = (document.getElementById('new_item_nome')||{}).value?.trim();
  const repV  = parseMoney((document.getElementById('new_item_valor')||{}).value || '');
  const aplicar  = (document.getElementById('new_aplicar')||{}).value || 'medico';
  const doctorId = (document.getElementById('rep_medico_select')||{}).value;

  if (!indic) return alert('Informe o indicador.');
  if (!item)  return alert('Informe o item.');
  if (repV<0) return alert('Informe um repasse válido.');
  if (aplicar==='medico' && !doctorId) return alert('Selecione um médico na lista acima.');

  await apiCatalog.add(indic, item, repV, aplicar, doctorId || null);
  await preloadCatalog(); // atualiza catKey2Id
  if (doctorId) delete CACHE.repassesByDoctor[doctorId]; // força recarregar repasses do médico

  await renderRepasseTable();
  toggleNewItemPanel();
  alert('Item cadastrado com sucesso!');
}

async function renderRepasseTable(){
  const sel   = document.getElementById('rep_medico_select');
  const table = document.getElementById('rep_table');
  if (!sel || !table) return;

  const tbody = table.querySelector('tbody');
  const medId = sel.value;
  if (!medId){
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:#777;padding:12px">Selecione um médico.</td></tr>`;
    return;
  }

  // busca direta do backend, mostrando apenas repasses cadastrados (> 0)
  const rows = await apiRepasses.byDoctor(medId);
  const filtrados = rows.filter(r => Number(r.valor || 0) > 0);

  if (!filtrados.length){
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:#777;padding:12px">Nenhum repasse configurado para este médico.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtrados.map(r => `
    <tr>
      <td>${r.indicador}</td>
      <td>${r.item}</td>
      <td>${BRL(r.valor)}</td>
      <td style="text-align:right;">
        <button class="btn-outline rep_edit" 
          data-indic="${r.indicador}" 
          data-item="${r.item}" 
          data-val="${Number(r.valor)}">Editar</button>
        <button class="btn-outline rep_delete" 
          data-itemid="${r.item_id}" 
          data-indic="${r.indicador}" 
          data-item="${r.item}">Remover</button>
      </td>
    </tr>
  `).join('');

  // botão de remover (zera o valor do repasse)
  tbody.querySelectorAll('.rep_delete').forEach(btn=>{
    btn.onclick = async ()=>{
      const itemId = btn.dataset.itemid;
      if (!itemId) return alert('Item inválido.');
      if (!confirm(`Remover repasse de "${btn.dataset.item}" (${btn.dataset.indic}) deste médico?`)) return;
      await apiRepasses.set(medId, itemId, 0);
      await renderRepasseTable(); // recarrega a tabela
    };
  });

  // botão de editar → abre painel de edição
  tbody.querySelectorAll('.rep_edit').forEach(btn=>{
    btn.onclick = ()=>{
      const panel = document.getElementById('rep_new_item_panel');
      if (!panel) return;
      panel.classList.remove('hidden');
      prepareNewItemIndicators();

      const indSel = document.getElementById('new_indicador');
      if (indSel) {
        const current = btn.dataset.indic || '';
        if (current && !Array.from(indSel.options).some(o=> o.value===current)) {
          const opt = document.createElement('option');
          opt.value = current; opt.textContent = current;
          indSel.insertBefore(opt, indSel.firstChild);
        }
        indSel.value = current || indSel.value;
      }

      document.getElementById('new_indicador_custom').value = '';
      document.getElementById('new_item_nome').value = btn.dataset.item || '';
      const currentVal = Number(btn.dataset.val || 0);
      document.getElementById('new_item_valor').value = currentVal.toFixed(2).replace('.',',');

      const saveBtn = document.getElementById('new_item_salvar');
      const restore = ()=>{
        saveBtn.textContent = 'Salvar Item';
        saveBtn.onclick = saveNewCatalogItem;
      };

      saveBtn.textContent = 'Salvar Alteração';
      saveBtn.onclick = async ()=>{
        const indic = (document.getElementById('new_indicador')||{}).value || '';
        const item  = (document.getElementById('new_item_nome')||{}).value?.trim() || '';
        const valor = parseMoney((document.getElementById('new_item_valor')||{}).value || '');
        if (!indic || !item) return alert('Preencha todos os campos.');

        await apiCatalog.edit(btn.dataset.indic, btn.dataset.item, indic, item, valor);
        await renderRepasseTable();
        panel.classList.add('hidden');
        restore();
      };
    };
  });
}

/* =======================
   Dashboard
======================= */
function setupDashboard(){ renderDashboard(); }

async function renderDashboard(){
  // hoje
  const hoje = todayISO();
  const hojeArr = await apiLanc.list({de:hoje, ate:hoje});

  // 7 dias
  const base = new Date(hoje);
  const labelsISO = [];
  for (let i=6;i>=0;i--){
    const d = new Date(base); d.setDate(d.getDate()-i);
    labelsISO.push(d.toISOString().slice(0,10));
  }
  const weekStart = labelsISO[0], weekEnd = labelsISO[6];
  const semanaArr = await apiLanc.list({de:weekStart, ate:weekEnd});

  const byForma = sumBy(hojeArr, l=> l.forma, l=> Number(l.valor_total||0));
  const byEsp = sumBy(hojeArr, l=> l.especialidade, l=> Number(l.valor_total||0));
  const byMed = sumBy(hojeArr, l=> l.nome, l=> Number(l.valor_total||0));

  const serie = labelsISO.map(d=>{
    return semanaArr.filter(l=> l.data===d).reduce((s,x)=> s+Number(x.valor_total||0), 0);
  });

  renderPie('chartForma', Object.keys(byForma), Object.values(byForma));
  renderBar('chartEspecialidade', Object.keys(byEsp), Object.values(byEsp));
  renderBar('chartMedico', Object.keys(byMed), Object.values(byMed));
  renderLine('chartSemana', labelsISO.map(fmtDate), serie);
}

function sumBy(arr, keyFn, valFn){
  const m = {};
  arr.forEach(x=>{
    const k = keyFn(x);
    m[k] = (m[k]||0) + valFn(x);
  });
  return m;
}

function renderPie(id, labels, data){
  const ctx = document.getElementById(id); if (!ctx) return;
  if (ctx._inst) ctx._inst.destroy();
  ctx._inst = new Chart(ctx, { type:'pie', data:{ labels, datasets:[{ data }] }, options:{ plugins:{ legend:{ position:'bottom' } } } });
}
function renderBar(id, labels, data){
  const ctx = document.getElementById(id); if (!ctx) return;
  if (ctx._inst) ctx._inst.destroy();
  ctx._inst = new Chart(ctx, { type:'bar', data:{ labels, datasets:[{ data }] }, options:{ plugins:{ legend:{ display:false } }, scales:{ y:{ beginAtZero:true } } } });
}
function renderLine(id, labels, data){
  const ctx = document.getElementById(id); if (!ctx) return;
  if (ctx._inst) ctx._inst.destroy();
  ctx._inst = new Chart(ctx, { type:'line', data:{ labels, datasets:[{ data, tension:.3, fill:false }] }, options:{ plugins:{ legend:{ display:false } }, scales:{ y:{ beginAtZero:true } } } });
}
