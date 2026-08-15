// Catálogo de funcionalidades (server/features.js) + a MIGRAÇÃO do settings.json.
//
// O módulo é puro (sem express, sem disco), então dá para testá-lo direto. A migração,
// que roda no boot, é exercitada num processo NOVO — é a única forma de pegar o
// bootstrap, e é justamente o pedaço mais arriscado da demanda #4: se ela falhar, um
// admin que tinha LIGADO a avaliação de visitante perde a configuração em silêncio e só
// descobre pelo aluno reclamando.
require('./helpers');

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  FEATURES, FEATURE_KEYS, FEATURE_ROLES,
  featureRoleOf, defaultFeatureAccess, normalizeFeatureAccess, canUseFeature,
} = require('../server/features');

describe('catálogo', () => {
  it('toda feature tem key, label, description e defaults nos dois papéis', () => {
    expect(FEATURES.length).toBeGreaterThan(0);
    for (const f of FEATURES) {
      expect(typeof f.key, f.key).toBe('string');
      expect(f.label.length, f.key).toBeGreaterThan(0);
      expect(f.description.length, f.key).toBeGreaterThan(0);
      for (const role of FEATURE_ROLES) {
        expect(typeof f.defaults[role], `${f.key}.${role}`).toBe('boolean');
      }
    }
  });

  it('as chaves são únicas', () => {
    expect(new Set(FEATURE_KEYS).size).toBe(FEATURE_KEYS.length);
  });

  // Custo de IA: um lead pode entrar aos montes. Ligar é decisão consciente do admin.
  it('avaliação nasce DESLIGADA para o visitante e ligada para o aluno', () => {
    const d = defaultFeatureAccess();
    expect(d.avaliacao).toEqual({ aluno: true, visitante: false });
  });

  it('só existem os papéis aluno e visitante', () => {
    expect(FEATURE_ROLES).toEqual(['aluno', 'visitante']);
  });
});

describe('featureRoleOf', () => {
  it('mapeia therapist→aluno e visitor→visitante', () => {
    expect(featureRoleOf({ role: 'therapist' })).toBe('aluno');
    expect(featureRoleOf({ role: 'visitor' })).toBe('visitante');
  });

  // Fora da matriz de propósito: se admin fosse bloqueável, ele poderia se trancar
  // para fora do próprio sistema — sem tela para se desbloquear.
  it('admin e supervisor ficam FORA da matriz (null)', () => {
    expect(featureRoleOf({ role: 'admin' })).toBeNull();
    expect(featureRoleOf({ role: 'supervisor' })).toBeNull();
  });

  it('usuário ausente não quebra', () => {
    expect(featureRoleOf(null)).toBeNull();
    expect(featureRoleOf(undefined)).toBeNull();
  });
});

describe('normalizeFeatureAccess', () => {
  it('lixo total vira os defaults', () => {
    for (const v of [null, undefined, 'x', 42, []]) {
      expect(normalizeFeatureAccess(v), String(v)).toEqual(defaultFeatureAccess());
    }
  });

  it('descarta chave desconhecida', () => {
    const out = normalizeFeatureAccess({ naoExiste: { aluno: true } });
    expect(out.naoExiste).toBeUndefined();
    expect(out).toEqual(defaultFeatureAccess());
  });

  // Uma feature NOVA num deploy: o settings.json antigo não a tem, e ela precisa nascer
  // no default em vez de virar `undefined` (que `!!` transformaria num bloqueio mudo).
  it('feature ausente no disco ganha o default', () => {
    const out = normalizeFeatureAccess({ duelo: { aluno: false, visitante: false } });
    expect(out.duelo).toEqual({ aluno: false, visitante: false });
    expect(out.ranking).toEqual({ aluno: true, visitante: false });
  });

  it('papel ausente na linha ganha o default (não vira undefined)', () => {
    const out = normalizeFeatureAccess({ duelo: { aluno: false } });
    expect(out.duelo).toEqual({ aluno: false, visitante: false });
  });

  it('coage para booleano', () => {
    const out = normalizeFeatureAccess({ duelo: { aluno: 0, visitante: 'sim' } });
    expect(out.duelo).toEqual({ aluno: false, visitante: true });
  });

  it('não muta o objeto de entrada', () => {
    const raw = { duelo: { aluno: false } };
    normalizeFeatureAccess(raw);
    expect(raw).toEqual({ duelo: { aluno: false } });
  });
});

describe('canUseFeature', () => {
  const access = defaultFeatureAccess();

  it('respeita a matriz por papel', () => {
    expect(canUseFeature(access, { role: 'therapist' }, 'avaliacao')).toBe(true);
    expect(canUseFeature(access, { role: 'visitor' }, 'avaliacao')).toBe(false);
  });

  it('admin e professor passam sempre, mesmo com tudo desligado', () => {
    const tudoOff = normalizeFeatureAccess(
      Object.fromEntries(FEATURE_KEYS.map((k) => [k, { aluno: false, visitante: false }])),
    );
    for (const key of FEATURE_KEYS) {
      expect(canUseFeature(tudoOff, { role: 'admin' }, key), key).toBe(true);
      expect(canUseFeature(tudoOff, { role: 'supervisor' }, key), key).toBe(true);
    }
  });

  // Falha ABERTA: uma chave que não existe não bloqueia ninguém. O contrário — negar o
  // desconhecido — trancaria os usuários para fora a cada feature nova mal grafada.
  it('feature desconhecida libera (não bloqueia por engano)', () => {
    expect(canUseFeature(access, { role: 'therapist' }, 'inexistente')).toBe(true);
  });
});

// ---------------------------------------------------------------------
// MIGRAÇÃO — roda no boot, então precisa de um processo novo.
// ---------------------------------------------------------------------
function bootWith(settings, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genus-mig-'));
  if (settings !== undefined) {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
  }
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(content));
  }
  // Só carrega o app (o `require.main` guard impede o listen) e sai.
  bootWith.dir = dir;
  execFileSync(process.execPath, ['-e', "require('./server/index.js')"], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      DATA_DIR: dir,
      JWT_SECRET: 'x'.repeat(32),
      OPENAI_API_KEY: '',
      NODE_ENV: 'test',
    },
    stdio: 'pipe',
  });
  return JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
}

describe('migração do settings.json (boot)', () => {
  it('volume vazio: nasce com a matriz default', () => {
    const s = bootWith(undefined);
    expect(s.featureAccess).toEqual(defaultFeatureAccess());
  });

  // O CASO QUE IMPORTA. Um deploy rodando tem `visitorEvaluationEnabled: true` (o admin
  // ligou de propósito). Sem migração, o default de `avaliacao.visitante` é FALSE e a
  // escolha dele seria descartada em silêncio.
  it('preserva o visitorEvaluationEnabled=true → avaliacao.visitante=true', () => {
    const s = bootWith({ evaluatorEnabled: true, visitorEvaluationEnabled: true });
    // `visitante: true` aqui NÃO é o default (que agora é false) — é a escolha explícita
    // do admin, preservada pela migração. É exatamente isso que este teste protege.
    expect(s.featureAccess.avaliacao).toEqual({ aluno: true, visitante: true });
    expect(s.visitorEvaluationEnabled).toBeUndefined(); // absorvido pela matriz
    expect(s.evaluatorEnabled).toBe(true);              // e o resto sobrevive
  });

  it('preserva o visitorEvaluationEnabled=false → avaliacao.visitante=false', () => {
    const s = bootWith({ evaluatorEnabled: false, visitorEvaluationEnabled: false });
    expect(s.featureAccess.avaliacao).toEqual({ aluno: true, visitante: false });
    expect(s.visitorEvaluationEnabled).toBeUndefined();
  });

  it('não sobrescreve uma matriz que já existe (o boot não é destrutivo)', () => {
    const meu = { ...defaultFeatureAccess(), duelo: { aluno: false, visitante: false } };
    const s = bootWith({ evaluatorEnabled: true, featureAccess: meu });
    expect(s.featureAccess.duelo).toEqual({ aluno: false, visitante: false });
  });
});

// ---------------------------------------------------------------------
// MIGRAÇÃO D7 — pacientes existentes nascem BLOQUEADOS (demanda #7).
// ---------------------------------------------------------------------
function bootPatients(chars) {
  bootWith(undefined, { 'freeplay-characters.json': chars });
  return JSON.parse(fs.readFileSync(path.join(bootWith.dir, 'freeplay-characters.json'), 'utf8'));
}

describe('migração D7 — pacientes existentes nascem bloqueados', () => {
  // A consequência é grande e deliberada: depois deste deploy NINGUÉM pratica até o admin
  // liberar. Nada dá erro — os cards simplesmente somem. Se este teste cair, pacientes
  // estão nascendo liberados e a decisão D7 foi silenciosamente revertida.
  it('paciente antigo (sem os campos) é BLOQUEADO para os dois papéis', () => {
    const out = bootPatients([{ id: 'fp-1', name: 'Antigo' }]);
    expect(out[0].allowStudent).toBe(false);
    expect(out[0].allowVisitor).toBe(false);
  });

  it('NÃO sobrescreve quem já tem o campo (o boot não é destrutivo)', () => {
    const out = bootPatients([
      { id: 'fp-1', name: 'Liberado', allowStudent: true, allowVisitor: true },
      { id: 'fp-2', name: 'Antigo' },
    ]);
    expect(out.find((c) => c.id === 'fp-1')).toMatchObject({ allowStudent: true, allowVisitor: true });
    expect(out.find((c) => c.id === 'fp-2')).toMatchObject({ allowStudent: false, allowVisitor: false });
  });

  it('é idempotente: bootar de novo não muda nada', () => {
    const uma = bootPatients([{ id: 'fp-1', name: 'X', allowStudent: true, allowVisitor: false }]);
    const outra = bootPatients(uma);
    expect(outra).toEqual(uma);
  });
});
