<?php
header('Content-Type: application/json; charset=utf-8');
$cfg = require __DIR__.'/config.php';
try{
  $pdo = new PDO($cfg['dsn'], $cfg['user'], $cfg['pass'], [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
  ]);
  $out = [];
  $out['mysql_ok'] = true;
  $out['doctors'] = $pdo->query("SELECT COUNT(*) c FROM doctors")->fetch()['c'];
  $out['lancamentos'] = $pdo->query("SELECT COUNT(*) c FROM lancamentos")->fetch()['c'];
  $out['lancamento_itens'] = $pdo->query("SELECT COUNT(*) c FROM lancamento_itens")->fetch()['c'];
  $out['sample'] = $pdo->query("SELECT id, doctor_id, data, hora, forma, status, valor_total FROM lancamentos ORDER BY id DESC LIMIT 5")->fetchAll();
  echo json_encode($out, JSON_PRETTY_PRINT|JSON_UNESCAPED_UNICODE);
}catch(Exception $e){
  echo json_encode(['mysql_ok'=>false,'error'=>$e->getMessage()]);
}
