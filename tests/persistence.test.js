// Persistência do volume e snapshots — a trava do incidente de 2026-08-14.
//
// O QUE ACONTECEU: um cliente construiu pacientes, exercícios e competências. No deploy
// seguinte, tudo voltou ao seed. A causa não foi o seed sobrescrever (ele não sobrescreve)
// nem bug de escrita: `DATA_DIR=/data` estava definido, mas o VOLUME não estava montado
// ali. O Node criava a pasta dentro do container, escrevia nela, e o redeploy destruía
// tudo junto com o container.
//
// O `/api/health` existia para pegar isso e NÃO pegou: ele só perguntava "é gravável?", e
// um diretório efêmero também é gravável. Uma pergunta que todo diretório responde "sim"
// não é uma verificação.
//
// Estes testes travam as duas defesas que nasceram daí: o marcador de persistência e os
// snapshots automáticos.

require('./helpers');

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const snapshots = require('../server/snapshots');

const SERVER = path.join(__dirname, '..', 'server', 'index.js');

/**
 * Sobe o servidor num DATA_DIR próprio, só para ler o log de boot.
 *
 * `require`-ar o index.js não serve: o bootstrap roda uma vez por PROCESSO, e a suíte já o
 * carregou. Só um processo novo exercita o caminho de boot — que é justamente onde a
 * verificação de persistência vive.
 */
function boot(dataDir) {
  // `BOOT_ONLY=1` faz o servidor rodar todo o bootstrap e SAIR, sem abrir porta.
  // Os avisos de persistência saem em `console.warn` (stderr), então juntamos os dois
  // fluxos — checar só o stdout deixaria passar exatamente o alerta que nos importa.
  const r = spawnSync(process.execPath, [SERVER], {
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      JWT_SECRET: 'x'.repeat(48),
      ADMIN_INITIAL_PASSWORD: 'SenhaForte123',
      NODE_ENV: 'test',
      BOOT_ONLY: '1',
    },
    encoding: 'utf-8',
    timeout: 20000,
  });
  return `${r.stdout || ''}${r.stderr || ''}`;
}

function tmpDir(nome) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `persist-${nome}-`));
}

describe('marcador de persistência (o volume é real?)', () => {
  it('primeiro boot: cria o marcador e avisa que o próximo boot confirma', () => {
    const dir = tmpDir('novo');
    const out = boot(dir);

    expect(fs.existsSync(path.join(dir, '.persist-check.json'))).toBe(true);
    expect(out).toMatch(/Primeiro boot/i);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('segundo boot no MESMO diretório: reconhece o disco como persistente', () => {
    const dir = tmpDir('persistente');
    boot(dir);
    const out = boot(dir);

    // Não pode gritar: o marcador sobreviveu, então o disco é real.
    expect(out).not.toMatch(/EFÊMERO/i);
    const marker = JSON.parse(fs.readFileSync(path.join(dir, '.persist-check.json'), 'utf-8'));
    expect(marker.boots).toBeGreaterThanOrEqual(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('🔴 disco EFÊMERO (há dados, mas o marcador sumiu): GRITA no log', () => {
    // Este é o cenário exato do incidente: o container tem dados (semeados no boot) mas
    // nenhuma memória de boots anteriores, porque o disco anterior evaporou.
    const dir = tmpDir('efemero');
    boot(dir);                                          // cria dados + marcador
    fs.rmSync(path.join(dir, '.persist-check.json'));   // o "disco novo" não tem o marcador

    const out = boot(dir);

    expect(out).toMatch(/EFÊMERO/i);
    expect(out).toMatch(/PERDIDO no próximo deploy/i);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('snapshots automáticos (o rollback)', () => {
  it('o boot cria um snapshot com os dados do volume', () => {
    const dir = tmpDir('snap');
    boot(dir);                       // popula o volume
    boot(dir);                       // este já encontra dados para salvar

    const items = snapshots.listSnapshots(dir);
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].files).toContain('users.json');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('preserva os BYTES: o dado restaurado é idêntico ao salvo', () => {
    const dir = tmpDir('bytes');
    fs.writeFileSync(path.join(dir, 'skills.json'), JSON.stringify([{ id: 1, name: 'Empatia' }]));
    fs.writeFileSync(path.join(dir, 'users.json'), '[]');
    snapshots.createSnapshot(dir, 'teste');

    // Destrói, como um bug faria.
    fs.writeFileSync(path.join(dir, 'skills.json'), JSON.stringify([{ id: 1, name: 'DESTRUIDO' }]));

    const snap = snapshots.listSnapshots(dir)[0];
    const recuperado = JSON.parse(snapshots.readFromSnapshot(dir, snap.name, 'skills.json'));
    expect(recuperado[0].name).toBe('Empatia');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('não guarda snapshot de volume vazio (seria ruído)', () => {
    const dir = tmpDir('vazio');
    const r = snapshots.createSnapshot(dir, 'teste');
    expect(r.empty).toBe(true);
    expect(snapshots.listSnapshots(dir)).toHaveLength(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('mantém no máximo KEEP snapshots', () => {
    const dir = tmpDir('prune');
    fs.writeFileSync(path.join(dir, 'users.json'), '[]');
    // Nomes têm resolução de 1 segundo, então geramos direto pelo diretório.
    for (let i = 0; i < snapshots.KEEP + 3; i++) {
      const d = path.join(dir, '_snapshots', `snapshot-2020-01-01T00-00-${String(i).padStart(2, '0')}-boot`);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'users.json'), '[]');
      fs.writeFileSync(path.join(d, '_meta.json'), JSON.stringify({ createdAt: '2020-01-01', files: ['users.json'] }));
    }
    snapshots.createSnapshot(dir, 'novo');
    expect(snapshots.listSnapshots(dir).length).toBeLessThanOrEqual(snapshots.KEEP);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('🔒 readFromSnapshot não permite escapar do diretório (path traversal)', () => {
    const dir = tmpDir('traversal');
    fs.writeFileSync(path.join(dir, 'users.json'), '[]');
    snapshots.createSnapshot(dir, 'teste');
    const snap = snapshots.listSnapshots(dir)[0];

    expect(snapshots.readFromSnapshot(dir, snap.name, '../../../etc/passwd')).toBeNull();
    expect(snapshots.readFromSnapshot(dir, '../../..', 'users.json')).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
