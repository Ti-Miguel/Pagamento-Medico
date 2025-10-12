<?php
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD']==='OPTIONS') { http_response_code(204); exit; }

$cfg = require __DIR__.'/config.php';
try{
  $pdo = new PDO($cfg['dsn'], $cfg['user'], $cfg['pass'], [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
  ]);
}catch(Exception $e){
  http_response_code(500);
  echo json_encode(['error'=>'db_connect','detail'=>$e->getMessage()]); exit;
}

function jread() {
  $raw = file_get_contents('php://input');
  $j = json_decode($raw, true);
  return is_array($j) ? $j : [];
}
function ok($data){ echo json_encode($data); exit; }
function bad($msg, $code=400){ http_response_code($code); echo json_encode(['error'=>$msg]); exit; }

$action = $_GET['action'] ?? $_POST['action'] ?? null;
if (!$action) bad('missing_action');

// --------- DOCTORS ----------
if ($action==='doctors.list'){
  $q = $pdo->query("SELECT id,nome,especialidade FROM doctors ORDER BY nome");
  ok($q->fetchAll());
}
if ($action==='doctors.create'){
  $in = jread();
  if (empty($in['nome']) || empty($in['especialidade'])) bad('missing_fields');
  $st = $pdo->prepare("INSERT INTO doctors (nome,especialidade) VALUES (?,?)");
  $st->execute([$in['nome'],$in['especialidade']]);
  ok(['id'=>$pdo->lastInsertId()]);
}

// --------- PIX ----------
if ($action==='pix.get'){
  $q = $pdo->query("SELECT d.id as doctor_id, d.nome, d.especialidade, IFNULL(p.chave,'') as chave
                    FROM doctors d LEFT JOIN pix_keys p ON p.doctor_id=d.id ORDER BY d.nome");
  ok($q->fetchAll());
}
if ($action==='pix.set'){
  $in = jread();
  if (empty($in['doctor_id'])) bad('missing_doctor');
  $st = $pdo->prepare("INSERT INTO pix_keys (doctor_id,chave) VALUES (?,?)
                       ON DUPLICATE KEY UPDATE chave=VALUES(chave)");
  $st->execute([$in['doctor_id'], $in['chave'] ?? '']);
  ok(['ok'=>true]);
}
if ($action==='pix.clear'){
  $in = jread();
  if (empty($in['doctor_id'])) bad('missing_doctor');
  $st = $pdo->prepare("DELETE FROM pix_keys WHERE doctor_id=?");
  $st->execute([$in['doctor_id']]);
  ok(['ok'=>true]);
}

// --------- CATALOG / ITEMS ----------
if ($action==='catalog.get'){
  // retorna { indicador: [ {item_id, nome}... ] }
  $sql = "SELECT i.id as item_id, i.nome as item, ind.nome as indicador
          FROM items i JOIN indicators ind ON ind.id=i.indicator_id
          ORDER BY ind.nome, i.nome";
  $rows = $pdo->query($sql)->fetchAll();
  $out = [];
  foreach($rows as $r){ $out[$r['indicador']][] = ['id'=>$r['item_id'],'nome'=>$r['item']]; }
  ok($out);
}
if ($action==='catalog.add'){
  $in = jread(); // indicador, item, valor, aplicar("medico"|"todos"), doctor_id
  $indic = trim($in['indicador'] ?? '');
  $item  = trim($in['item'] ?? '');
  $valor = floatval($in['valor'] ?? 0);
  $aplicar = $in['aplicar'] ?? 'medico';
  $doctorId = intval($in['doctor_id'] ?? 0);
  if (!$indic || !$item) bad('missing_fields');

  // cria indicador se não existir
  $st = $pdo->prepare("INSERT IGNORE INTO indicators (nome) VALUES (?)");
  $st->execute([$indic]);
  $indId = $pdo->query("SELECT id FROM indicators WHERE nome=".$pdo->quote($indic))->fetchColumn();

  // cria item se não existir
  $st = $pdo->prepare("INSERT IGNORE INTO items (indicator_id,nome) VALUES (?,?)");
  $st->execute([$indId,$item]);
  $itemId = $pdo->query("SELECT id FROM items WHERE indicator_id=".$indId." AND nome=".$pdo->quote($item))->fetchColumn();

  if ($aplicar==='todos'){
    $ids = $pdo->query("SELECT id FROM doctors")->fetchAll(PDO::FETCH_COLUMN);
    $st = $pdo->prepare("INSERT INTO repasses (doctor_id,item_id,valor) VALUES (?,?,?)
                         ON DUPLICATE KEY UPDATE valor=VALUES(valor)");
    foreach($ids as $d){ $st->execute([$d,$itemId,$valor]); }
  } else {
    if (!$doctorId) bad('missing_doctor');
    $st = $pdo->prepare("INSERT INTO repasses (doctor_id,item_id,valor) VALUES (?,?,?)
                         ON DUPLICATE KEY UPDATE valor=VALUES(valor)");
    $st->execute([$doctorId,$itemId,$valor]);
  }
  ok(['item_id'=>$itemId]);
}
if ($action==='catalog.edit'){
  // renomear indicador/item e atualizar valor padrão por médico
  $in = jread(); // old_indic, old_item, new_indic, new_item, valor
  $oldIndic = trim($in['old_indic'] ?? ''); $oldItem  = trim($in['old_item'] ?? '');
  $newIndic = trim($in['new_indic'] ?? ''); $newItem  = trim($in['new_item'] ?? '');
  $valor = floatval($in['valor'] ?? 0);
  if (!$oldIndic || !$oldItem || !$newIndic || !$newItem) bad('missing_fields');

  // obter ids antigos
  $oldIndId = $pdo->query("SELECT id FROM indicators WHERE nome=".$pdo->quote($oldIndic))->fetchColumn();
  if (!$oldIndId) bad('not_found_indicator',404);
  $oldItemId = $pdo->query("SELECT id FROM items WHERE indicator_id=$oldIndId AND nome=".$pdo->quote($oldItem))->fetchColumn();
  if (!$oldItemId) bad('not_found_item',404);

  // garantir novo indicador
  $pdo->prepare("INSERT IGNORE INTO indicators (nome) VALUES (?)")->execute([$newIndic]);
  $newIndId = $pdo->query("SELECT id FROM indicators WHERE nome=".$pdo->quote($newIndic))->fetchColumn();

  // garantir novo item
  $pdo->prepare("INSERT IGNORE INTO items (indicator_id,nome) VALUES (?,?)")->execute([$newIndId,$newItem]);
  $newItemId = $pdo->query("SELECT id FROM items WHERE indicator_id=$newIndId AND nome=".$pdo->quote($newItem))->fetchColumn();

  // migrar repasses
  $st = $pdo->prepare("INSERT INTO repasses (doctor_id,item_id,valor)
                       SELECT doctor_id, ?, ? FROM repasses WHERE item_id=? 
                       ON DUPLICATE KEY UPDATE valor=VALUES(valor)");
  $st->execute([$newItemId, $valor, $oldItemId]);
  $pdo->prepare("DELETE FROM repasses WHERE item_id=?")->execute([$oldItemId]);

  // remover item antigo
  $pdo->prepare("DELETE FROM items WHERE id=?")->execute([$oldItemId]);

  ok(['new_item_id'=>$newItemId]);
}
if ($action==='catalog.delete'){
  $in = jread(); // indicador, item
  $indic = trim($in['indicador'] ?? ''); $item=trim($in['item'] ?? '');
  if (!$indic || !$item) bad('missing_fields');
  $indId = $pdo->query("SELECT id FROM indicators WHERE nome=".$pdo->quote($indic))->fetchColumn();
  if (!$indId) ok(['ok'=>true]);
  $itemId = $pdo->query("SELECT id FROM items WHERE indicator_id=$indId AND nome=".$pdo->quote($item))->fetchColumn();
  if ($itemId){
    $pdo->prepare("DELETE FROM repasses WHERE item_id=?")->execute([$itemId]);
    $pdo->prepare("DELETE FROM items WHERE id=?")->execute([$itemId]);
  }
  ok(['ok'=>true]);
}

// --------- REPASSES ----------
if ($action==='repasses.byDoctor'){
  $doctor = intval($_GET['doctor_id'] ?? 0);
  if (!$doctor) bad('missing_doctor');
  $sql = "SELECT ind.nome as indicador, it.id as item_id, it.nome as item,
                 IFNULL(r.valor,0) as valor
          FROM items it 
            JOIN indicators ind ON ind.id=it.indicator_id
            LEFT JOIN repasses r ON r.item_id=it.id AND r.doctor_id=?
          ORDER BY ind.nome, it.nome";
  $st = $pdo->prepare($sql); $st->execute([$doctor]);
  ok($st->fetchAll());
}
if ($action==='repasses.set'){
  $in = jread(); // doctor_id, item_id, valor
  if (empty($in['doctor_id']) || empty($in['item_id'])) bad('missing_fields');
  $st = $pdo->prepare("INSERT INTO repasses (doctor_id,item_id,valor) VALUES (?,?,?)
                       ON DUPLICATE KEY UPDATE valor=VALUES(valor)");
  $st->execute([intval($in['doctor_id']), intval($in['item_id']), floatval($in['valor'] ?? 0)]);
  ok(['ok'=>true]);
}

// --------- LANÇAMENTOS ----------
if ($action==='lanc.create'){
  $in = jread(); // doctor_id,data,forma,status,qtd_consultas,obs,itens:[{item_id,repasse,qtd,subtotal}]
  if (empty($in['doctor_id']) || empty($in['data']) || empty($in['forma']) || empty($in['status'])) bad('missing_fields');
  $hora = $in['hora'] ?? date('H:i');
  $itens = $in['itens'] ?? [];
  $valor_total = 0;
  foreach($itens as $it){ $valor_total += floatval($it['subtotal'] ?? ((float)$it['repasse'] * (int)$it['qtd'])); }
  $st = $pdo->prepare("INSERT INTO lancamentos (doctor_id,data,hora,forma,status,qtd_consultas,obs,valor_total)
                       VALUES (?,?,?,?,?,?,?,?)");
  $st->execute([intval($in['doctor_id']), $in['data'], $hora, $in['forma'], $in['status'], intval($in['qtd_consultas'] ?? 0), $in['obs'] ?? null, $valor_total]);
  $lancId = $pdo->lastInsertId();

  $sti = $pdo->prepare("INSERT INTO lancamento_itens (lancamento_id,item_id,repasse,qtd,subtotal) VALUES (?,?,?,?,?)");
  foreach($itens as $it){
    $rep = floatval($it['repasse'] ?? 0);
    $qtd = intval($it['qtd'] ?? 1);
    $sti->execute([$lancId, intval($it['item_id']), $rep, $qtd, $rep*$qtd]);
  }
  ok(['id'=>$lancId,'valor_total'=>$valor_total]);
}
if ($action==='lanc.updateStatus'){
  $in = jread(); // id, status
  if (empty($in['id']) || empty($in['status'])) bad('missing_fields');
  $pdo->prepare("UPDATE lancamentos SET status=? WHERE id=?")->execute([$in['status'], intval($in['id'])]);
  ok(['ok'=>true]);
}
if ($action==='lanc.delete'){
  $in = jread(); // id
  if (empty($in['id'])) bad('missing_id');
  $pdo->prepare("DELETE FROM lancamentos WHERE id=?")->execute([intval($in['id'])]);
  ok(['ok'=>true]);
}
if ($action==='lanc.list'){
  // filtros: de,ate,doctor_id,forma,status,especialidade,indicador
  $de = $_GET['de'] ?? null; $ate = $_GET['ate'] ?? null;
  $doctor = $_GET['doctor_id'] ?? null; $forma=$_GET['forma'] ?? null; $status=$_GET['status'] ?? null;
  $esp = $_GET['especialidade'] ?? null; $indic = $_GET['indicador'] ?? null;

  $where = []; $params = [];
  if ($de){ $where[]="l.data>=?"; $params[]=$de; }
  if ($ate){ $where[]="l.data<=?"; $params[]=$ate; }
  if ($doctor){ $where[]="l.doctor_id=?"; $params[]=$doctor; }
  if ($forma){ $where[]="l.forma=?"; $params[]=$forma; }
  if ($status){ $where[]="l.status=?"; $params[]=$status; }
  if ($esp){ $where[]="d.especialidade=?"; $params[]=$esp; }
  $whereSql = $where ? ("WHERE ".implode(" AND ",$where)) : "";

  $sql = "SELECT l.*, d.nome, d.especialidade
          FROM lancamentos l JOIN doctors d ON d.id=l.doctor_id
          $whereSql
          ORDER BY l.data DESC, l.hora DESC";
  $st = $pdo->prepare($sql); $st->execute($params);
  $lancs = $st->fetchAll();

  // itens por lançamento
  $ids = array_column($lancs,'id');
  $itensMap = [];
  if ($ids){
    $inQ = implode(',', array_fill(0,count($ids),'?'));
    $sti = $pdo->prepare("SELECT li.*, ind.nome as indicador, it.nome as item
                          FROM lancamento_itens li
                          JOIN items it ON it.id=li.item_id
                          JOIN indicators ind ON ind.id=it.indicator_id
                          WHERE li.lancamento_id IN ($inQ)");
    $sti->execute($ids);
    foreach($sti->fetchAll() as $r){ $itensMap[$r['lancamento_id']][] = $r; }
  }
  foreach($lancs as &$l){ $l['itens'] = $itensMap[$l['id']] ?? []; }
  if ($indic){ // filtrar por indicador
    $lancs = array_values(array_filter($lancs, function($l) use ($indic){
      foreach($l['itens'] as $i){ if ($i['indicador']===$indic) return true; }
      return false;
    }));
  }
  ok($lancs);
}

bad('unknown_action',404);
