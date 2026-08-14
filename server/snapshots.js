// Snapshots automáticos do DATA_DIR — a rede de segurança do deploy.
//
// POR QUE ISTO EXISTE
// Um deploy nunca deveria apagar o que o cliente construiu, e o volume do Railway garante
// isso. Mas "garantir por design" não é o mesmo que "poder desfazer": basta um bug de
// escrita, um DELETE errado na tela de admin, ou um volume remontado, para o trabalho de
// semanas do administrador sumir sem rollback possível.
//
// A rota `/api/admin/export` já permitia baixar tudo — mas DEPENDE DE ALGUÉM LEMBRAR. Um
// backup que exige disciplina humana não existe no dia em que é preciso. Este módulo tira
// o snapshot sozinho, no boot (ou seja: a cada deploy), e guarda os últimos N no próprio
// volume.
//
// LIMITE HONESTO: o snapshot mora no MESMO volume que ele protege. Isso cobre os casos
// reais (bug de código, exclusão acidental, deploy ruim) mas NÃO cobre a perda do volume
// inteiro. Para isso é preciso um backup externo — ver `docs` na rota de download.

const fs = require('fs');
const path = require('path');

/** Quantos snapshots manter. Os mais antigos são removidos. */
const KEEP = Number(process.env.SNAPSHOT_KEEP || 10) || 10;

/** Os JSONs que valem a pena preservar. `logs.json` entra: é o histórico dos alunos. */
const FILES = [
  'users.json',
  'skills.json',
  'exercises.json',
  'freeplay-characters.json',
  'settings.json',
  'announcements.json',
  'progress.json',
  'achievements.json',
  'mmr.json',
  'duels.json',
  'notifications.json',
  'logs.json',
];

function snapshotsDir(dataDir) {
  return path.join(dataDir, '_snapshots');
}

/**
 * Um snapshot é um diretório `snapshot-<timestamp>-<motivo>` com cópias dos JSONs.
 *
 * Cópia de arquivo, não JSON.parse: se um arquivo estiver corrompido, queremos preservar
 * os BYTES como estão — reserializar poderia "consertar" o arquivo e esconder justamente
 * a evidência de que algo deu errado.
 */
function createSnapshot(dataDir, reason = 'boot') {
  const dir = snapshotsDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeReason = String(reason).replace(/[^a-z0-9_-]/gi, '').slice(0, 24) || 'manual';
  const target = path.join(dir, `snapshot-${stamp}-${safeReason}`);

  // Um segundo snapshot no mesmo segundo (dois boots rápidos) reusaria o nome.
  if (fs.existsSync(target)) return { skipped: true, path: target };

  fs.mkdirSync(target, { recursive: true });

  const copied = [];
  let bytes = 0;
  for (const f of FILES) {
    const src = path.join(dataDir, f);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(target, f);
    fs.copyFileSync(src, dst);
    copied.push(f);
    bytes += fs.statSync(dst).size;
  }

  // Um snapshot vazio (volume novo) é ruído: não guardamos.
  if (copied.length === 0) {
    fs.rmSync(target, { recursive: true, force: true });
    return { empty: true };
  }

  fs.writeFileSync(
    path.join(target, '_meta.json'),
    JSON.stringify({ createdAt: new Date().toISOString(), reason, files: copied, bytes }, null, 2),
  );

  prune(dataDir);
  return { path: target, files: copied, bytes };
}

/** Lista os snapshots, do mais novo para o mais antigo. */
function listSnapshots(dataDir) {
  const dir = snapshotsDir(dataDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('snapshot-'))
    .map((e) => {
      const full = path.join(dir, e.name);
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(full, '_meta.json'), 'utf-8')); } catch { /* sem meta */ }
      return { name: e.name, createdAt: meta.createdAt || null, reason: meta.reason || null, files: meta.files || [], bytes: meta.bytes || 0 };
    })
    .sort((a, b) => (a.name < b.name ? 1 : -1));
}

/** Mantém só os KEEP mais recentes. */
function prune(dataDir) {
  const all = listSnapshots(dataDir);
  for (const old of all.slice(KEEP)) {
    fs.rmSync(path.join(snapshotsDir(dataDir), old.name), { recursive: true, force: true });
  }
}

/** Lê um arquivo de dentro de um snapshot (para restaurar/inspecionar). */
function readFromSnapshot(dataDir, snapshotName, file) {
  // `basename` impede `../` no nome vindo da rota — sem isso, um admin poderia ler
  // qualquer arquivo do disco através desta função.
  const safeName = path.basename(String(snapshotName));
  const safeFile = path.basename(String(file));
  const full = path.join(snapshotsDir(dataDir), safeName, safeFile);
  if (!full.startsWith(snapshotsDir(dataDir))) return null;
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full, 'utf-8');
}

module.exports = { createSnapshot, listSnapshots, readFromSnapshot, snapshotsDir, FILES, KEEP };
