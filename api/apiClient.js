// cliente simples para public_html/pagmedico/api/index.php
const API_BASE = 'api/index.php';

async function api(action, method='GET', data=null, query={}) {
  const q = new URLSearchParams({ action, ...query }).toString();
  const opts = { method, headers: { 'Content-Type':'application/json' } };
  if (data) opts.body = JSON.stringify(data);
  const res = await fetch(`${API_BASE}?${q}`, opts);
  if (!res.ok) throw new Error(`API ${action}: ${res.status}`);
  return res.json();
}

// Doctors
const apiDoctors = {
  list: () => api('doctors.list'),
  create: (nome, especialidade) => api('doctors.create','POST',{nome,especialidade}),
};

// PIX
const apiPix = {
  all: () => api('pix.get'),
  set: (doctor_id, chave) => api('pix.set','POST',{doctor_id,chave}),
  clear: (doctor_id) => api('pix.clear','POST',{doctor_id}),
};

// Catálogo/Itens e Repasses
const apiCatalog = {
  get: () => api('catalog.get'),
  add: (indicador, item, valor, aplicar, doctor_id) =>
    api('catalog.add','POST',{indicador,item,valor,aplicar,doctor_id}),
  edit: (old_indic,old_item,new_indic,new_item,valor)=>
    api('catalog.edit','POST',{old_indic,old_item,new_indic,new_item,valor}),
  del: (indicador,item)=> api('catalog.delete','POST',{indicador,item}),
};
const apiRepasses = {
  byDoctor: (doctor_id) => api('repasses.byDoctor','GET',null,{doctor_id}),
  set: (doctor_id,item_id,valor) => api('repasses.set','POST',{doctor_id,item_id,valor}),
};

// Lançamentos
const apiLanc = {
  create: (payload) => api('lanc.create','POST',payload),
  updateStatus: (id,status) => api('lanc.updateStatus','POST',{id,status}),
  delete: (id) => api('lanc.delete','POST',{id}),
  list: (filters)=> api('lanc.list','GET',null,filters||{}),
};
