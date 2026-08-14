require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { buildExercisePrompt, buildFreeplayPrompt, wrapCustomEvaluatorPrompt } = require('./prompts');
const { toScore, finalScoreFromCriteria, comparativeScores } = require('./scoring');
const mmrEngine = require('./mmr');
const {
  FEATURES, FEATURE_ROLES, featureRoleOf,
  defaultFeatureAccess, normalizeFeatureAccess, canUseFeature,
} = require('./features');
const { defaultSkills, nextSkillId, sanitizeSkill } = require('./skills');
const snapshots = require('./snapshots');
const { extractBlocos } = require('./entrevistador/blocos');

const app = express();
app.set('trust proxy', 1);

// --- CORS: em produção o mesmo servidor serve o front; em dev libera o Vite. ---
const CORS_ALLOWLIST = (process.env.CORS_ALLOWLIST || 'http://localhost:5173')
  .split(',').map((s) => s.trim()).filter(Boolean);

function isLocalViteDevOrigin(origin) {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' || u.port !== '5173') return false;
    const h = u.hostname;
    if (h === 'localhost' || h === '127.0.0.1') return true;
    if (/^10\./.test(h)) return true;
    if (/^192\.168\./.test(h)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
    return false;
  } catch { return false; }
}

app.use(cors((req, cb) => {
  const origin = req.headers.origin;
  if (!origin) return cb(null, { origin: true });
  if (CORS_ALLOWLIST.includes(origin)) return cb(null, { origin: true });
  try {
    const originHost = new URL(origin).host;
    if (originHost && originHost === req.headers.host) return cb(null, { origin: true });
  } catch {}
  if (isLocalViteDevOrigin(origin)) return cb(null, { origin: true });
  return cb(new Error('Origin não permitida pelo CORS: ' + origin));
}));

app.use(express.json({ limit: '12mb' }));

// --- Persistência (JSON em arquivo) ---
const SEED_DATA_DIR = path.join(__dirname, 'data');
// Conteúdo versionado (pacientes e exercícios). `server/data/*.json` está no
// .gitignore por conter hashes de senha e dados de usuário, então o conteúdo que
// PRECISA existir num deploy limpo (Railway) mora aqui e é copiado no primeiro boot.
const SEED_CONTENT_DIR = path.join(__dirname, 'seed');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : SEED_DATA_DIR;

// ---------------------------------------------------------------------
// ⚠ O INCIDENTE QUE ESTE BLOCO EXISTE PARA IMPEDIR
//
// Um cliente construiu pacientes, exercícios e competências durante dias. No deploy
// seguinte, tudo voltou ao seed: o trabalho dele foi perdido.
//
// A causa: `DATA_DIR=/data` estava definido, mas o VOLUME não estava montado ali. O Node
// então CRIAVA a pasta dentro do container (o `mkdirSync` abaixo), escrevia nela, e tudo
// funcionava — até o redeploy destruir o container com os dados dentro.
//
// O healthcheck não pegava porque só perguntava "é gravável?". Um diretório efêmero também
// é gravável. Uma pergunta que qualquer diretório responde "sim" não é uma verificação.
//
// Agora o boot exige PROVA DE PERSISTÊNCIA: um marcador gravado num boot anterior. Se o
// diretório estiver vazio E for a primeira vez, seguimos (é um deploy legítimo novo, e o
// marcador nasce agora). Se o marcador SUMIU entre boots, o disco é efêmero — e aí é
// melhor falhar ruidosamente do que aceitar dados que vão evaporar.
// ---------------------------------------------------------------------
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const PERSIST_MARKER = path.join(DATA_DIR, '.persist-check.json');
/** Estado da persistência, exposto no /api/health e gritado no log de boot. */
const persistence = { verified: false, firstBoot: false, reason: '' };
try {
  if (fs.existsSync(PERSIST_MARKER)) {
    // O marcador sobreviveu a um boot anterior: o disco é REAL.
    const prev = JSON.parse(fs.readFileSync(PERSIST_MARKER, 'utf-8'));
    persistence.verified = true;
    persistence.reason = `marcador de ${prev.createdAt} sobreviveu a ${(prev.boots || 0) + 1} boots`;
    fs.writeFileSync(PERSIST_MARKER, JSON.stringify({ ...prev, boots: (prev.boots || 0) + 1, lastBoot: new Date().toISOString() }, null, 2));
  } else {
    // Sem marcador. Pode ser o primeiro boot legítimo... ou um disco efêmero que já
    // apagou tudo. A diferença: se HÁ dados de usuário sem marcador, algo está errado.
    const temDados = fs.existsSync(path.join(DATA_DIR, 'users.json'));
    persistence.firstBoot = !temDados;
    persistence.verified = false;
    persistence.reason = temDados
      ? 'HÁ DADOS mas o marcador de persistência sumiu — disco provavelmente EFÊMERO'
      : 'primeiro boot neste diretório (marcador criado agora)';
    fs.writeFileSync(PERSIST_MARKER, JSON.stringify({ createdAt: new Date().toISOString(), boots: 1, dataDir: DATA_DIR }, null, 2));
  }
} catch (e) {
  persistence.reason = `falha ao verificar persistência: ${e.message}`;
}

if (!persistence.verified) {
  const grito = persistence.firstBoot
    ? `[persistência] Primeiro boot em ${DATA_DIR}. O marcador foi criado; o PRÓXIMO boot confirma se o disco é persistente.`
    : `[persistência] ⚠⚠ ATENÇÃO: ${persistence.reason}. Se DATA_DIR não apontar para um VOLUME MONTADO, todo dado criado aqui será PERDIDO no próximo deploy.`;
  console.warn(grito);
}

// Copia um seed para o DATA_DIR apenas se o destino ainda não existir — assim um
// redeploy nunca sobrescreve os dados do volume.
//
// Semeamos SÓ o conteúdo versionado (server/seed/). O `server/data/` local NUNCA
// é copiado para um volume: ele carrega o users.json de desenvolvimento, e sua
// mera presença no destino faria o bootstrap abaixo pular o ADMIN_INITIAL_PASSWORD
// — o deploy subiria com as contas de demonstração (admin/admin123).
if (fs.existsSync(SEED_CONTENT_DIR) && path.resolve(SEED_CONTENT_DIR) !== path.resolve(DATA_DIR)) {
  for (const f of fs.readdirSync(SEED_CONTENT_DIR)) {
    const src = path.join(SEED_CONTENT_DIR, f);
    if (!fs.statSync(src).isFile()) continue;
    const dst = path.join(DATA_DIR, f);
    if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
  }
}

// Fotos de paciente (enviadas pelo admin) — ficam no volume persistente.
const PATIENT_PHOTOS_DIR = path.join(DATA_DIR, 'patient-photos');
if (!fs.existsSync(PATIENT_PHOTOS_DIR)) fs.mkdirSync(PATIENT_PHOTOS_DIR, { recursive: true });
app.use('/patient-photos', express.static(PATIENT_PHOTOS_DIR, { maxAge: '7d' }));
// Avatares prontos de perfil (listados por GET /api/profile-photos).
const PROFILE_ICONS_DIR = path.join(__dirname, '..', 'profiles_icon');
if (fs.existsSync(PROFILE_ICONS_DIR)) app.use('/profiles_icon', express.static(PROFILE_ICONS_DIR, { maxAge: '7d' }));

// --- JWT ---
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('[FATAL] JWT_SECRET ausente ou curto demais (mínimo 32 chars).');
  console.error('        Gere com: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
  process.exit(1);
}
const TOKEN_TTL = '7d';
const BCRYPT_ROUNDS = 10;

// --- Rate limiting (no-op em testes) ---
const SKIP_RATE_LIMIT = process.env.NODE_ENV === 'test';
const noopLimiter = (req, res, next) => next();
// Login: dois limites em série, com chaves diferentes.
//
// A chave NÃO pode ser só o IP: uma turma inteira atrás do NAT da escola compartilha
// um IP, e o 21º aluno a logar levava 429. Medido: de 30 logins simultâneos, 10 eram
// barrados. Por isso o limite que importa (força bruta de senha) é POR CONTA.
//
//  1. loginAccountLimiter — 10 tentativas ERRADAS / 15 min por username. É o limite
//     de força bruta: mesmo com IPs rotativos, uma conta só aceita 10 chutes.
//     `skipSuccessfulRequests` faz o login certo não consumir cota.
//  2. loginIpLimiter — teto largo por IP, contra enumeração em massa de contas.
//     200/15min cabe uma turma grande (com erros de digitação) e ainda corta um script.
const loginAccountLimiter = SKIP_RATE_LIMIT ? noopLimiter : rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `acct:${String((req.body && req.body.username) || '').trim().toLowerCase() || req.ip}`,
  message: { error: 'Muitas tentativas para este usuário. Tente novamente em alguns minutos.' },
});
const loginIpLimiter = SKIP_RATE_LIMIT ? noopLimiter : rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas deste endereço. Tente novamente em alguns minutos.' },
});
const loginLimiter = [loginIpLimiter, loginAccountLimiter];

function userKey(req) { return (req.user && req.user.id) ? `u:${req.user.id}` : `ip:${req.ip}`; }
const aiLimiter = SKIP_RATE_LIMIT ? noopLimiter : rateLimit({
  windowMs: 60 * 60 * 1000, max: 400, standardHeaders: true, legacyHeaders: false,
  keyGenerator: userKey, message: { error: 'Limite de uso da IA atingido. Tente novamente em uma hora.' },
});
const writeLimiter = SKIP_RATE_LIMIT ? noopLimiter : rateLimit({
  windowMs: 60 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false,
  keyGenerator: userKey, message: { error: 'Limite de operações atingido. Tente novamente mais tarde.' },
});
// Sessão de visitante é anônima e gratuita — limita por IP para evitar abuso.
const visitorLimiter = SKIP_RATE_LIMIT ? noopLimiter : rateLimit({
  windowMs: 60 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Muitas sessões de visitante. Tente novamente mais tarde.' },
});

function readJSON(file, fallback = []) {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return fallback; }
}
function writeJSON(file, data) {
  const dest = path.join(DATA_DIR, file);
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, dest);
}

// Mutex em memória por arquivo — serializa read-modify-write concorrente.
const fileLocks = new Map();
async function withFileLock(file, fn) {
  const prev = fileLocks.get(file) || Promise.resolve();
  let release;
  const next = new Promise((r) => (release = r));
  fileLocks.set(file, prev.then(() => next));
  await prev;
  try { return await fn(); }
  finally {
    release();
    if (fileLocks.get(file) === next) fileLocks.delete(file);
  }
}

// --- Papéis. `visitor` NÃO entra em VALID_ROLES: ele não pode ser criado pelo
// admin em /api/admin/users, só pelo cadastro em /api/login/visitor. ---
const VALID_ROLES = ['therapist', 'supervisor', 'admin'];
const DEFAULT_PROFILE = { email: '', profilePhoto: '' };

function hashSync(plain) { return bcrypt.hashSync(String(plain), BCRYPT_ROUNDS); }

// =====================================================================
// CADASTRO DO VISITANTE (demanda #1)
// =====================================================================
// O visitante deixou de ser efêmero: agora é um usuário de verdade em users.json,
// com nome, e-mail e telefone — os três obrigatórios e únicos.
//
// ⚠ Ele NÃO tem senha (decisão D1). Informar nome+e-mail+telefone JÁ é o login:
// quem digitar os dados de um visitante existente entra na conta dele. É captura
// de lead, não autenticação. Não coloque nada sensível atrás do papel `visitor`.

/**
 * Telefone BR no formato mais permissivo possível (decisão D2): o que importa é o
 * lead conseguir entrar, não a validação perfeita.
 * Guarda só os dígitos; aceita com/sem máscara, com/sem +55.
 * Retorna null se não parecer um telefone brasileiro (10 ou 11 dígitos).
 */
function normalizePhone(v) {
  const digits = String(v == null ? '' : v).replace(/\D/g, '');
  // +55 11 91234-5678 → 12 ou 13 dígitos: descarta o código do país.
  const local = (digits.length === 12 || digits.length === 13) && digits.startsWith('55')
    ? digits.slice(2)
    : digits;
  // 10 = fixo com DDD; 11 = celular com o 9.
  return (local.length === 10 || local.length === 11) ? local : null;
}

/** E-mail: checagem deliberadamente frouxa — algo@algo.algo. */
function normalizeEmail(v) {
  const email = String(v == null ? '' : v).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : null;
}

// Seed inicial (só na primeira execução, quando users.json ainda não existe).
//
// PRODUÇÃO: defina ADMIN_INITIAL_PASSWORD (e, opcionalmente, ADMIN_INITIAL_USERNAME).
//   O app cria APENAS o admin, com essa senha. Você loga com ele e cria as demais
//   contas na tela "Contas". A senha nunca é versionada — vive só na env do servidor.
//
// DESENVOLVIMENTO LOCAL (sem ADMIN_INITIAL_PASSWORD): cria as três contas de
//   DEMONSTRAÇÃO (admin/admin123 · supervisor/supervisor123 · aluno/aluno123).
//   NÃO use essas contas em produção.
if (!fs.existsSync(path.join(DATA_DIR, 'users.json'))) {
  const adminUsername = (process.env.ADMIN_INITIAL_USERNAME || 'admin').trim();
  const adminPassword = process.env.ADMIN_INITIAL_PASSWORD;
  if (adminPassword) {
    if (String(adminPassword).length < 8) {
      console.error('[FATAL] ADMIN_INITIAL_PASSWORD curta demais (mínimo 8 caracteres).');
      process.exit(1);
    }
    writeJSON('users.json', [
      { id: '1', username: adminUsername, passwordHash: hashSync(adminPassword), name: 'Administrador', role: 'admin', teacherId: null, ...DEFAULT_PROFILE },
    ]);
    console.log(`[seed] Admin criado a partir de ADMIN_INITIAL_PASSWORD. Usuário: ${adminUsername}`);
  } else {
    writeJSON('users.json', [
      { id: '1', username: 'admin', passwordHash: hashSync('admin123'), name: 'Administrador', role: 'admin', teacherId: null, ...DEFAULT_PROFILE },
      { id: '2', username: 'supervisor', passwordHash: hashSync('supervisor123'), name: 'Supervisor', role: 'supervisor', teacherId: null, ...DEFAULT_PROFILE },
      { id: '3', username: 'aluno', passwordHash: hashSync('aluno123'), name: 'Aluno', role: 'therapist', teacherId: '2', ...DEFAULT_PROFILE },
    ]);
    console.warn('[seed] Contas de DEMONSTRAÇÃO criadas (admin/admin123 · supervisor/supervisor123 · aluno/aluno123).');
    console.warn('[seed] Em produção defina ADMIN_INITIAL_PASSWORD para criar apenas um admin seguro.');
  }
}

// Personagens: dois tipos, herdados do All_OS.
//   exercises.json          → Trilha de Competências (skillId 1..5, difficulty)
//   freeplay-characters.json→ Simulação Livre / Competitivo (paciente completo)
// Os arquivos de seed acompanham o repositório em server/data/. Estes guards só
// entram em ação quando DATA_DIR aponta para um volume novo/vazio.
if (!fs.existsSync(path.join(DATA_DIR, 'exercises.json'))) writeJSON('exercises.json', []);
if (!fs.existsSync(path.join(DATA_DIR, 'freeplay-characters.json'))) writeJSON('freeplay-characters.json', []);

if (!fs.existsSync(path.join(DATA_DIR, 'logs.json'))) writeJSON('logs.json', []);
if (!fs.existsSync(path.join(DATA_DIR, 'active-sessions.json'))) writeJSON('active-sessions.json', {});
if (!fs.existsSync(path.join(DATA_DIR, 'progress.json'))) writeJSON('progress.json', {});
if (!fs.existsSync(path.join(DATA_DIR, 'achievements.json'))) writeJSON('achievements.json', {});
if (!fs.existsSync(path.join(DATA_DIR, 'mmr.json'))) writeJSON('mmr.json', { players: {}, characters: {} });
// ---------------------------------------------------------------------
// SNAPSHOT DE BOOT — a rede de segurança do deploy.
//
// Roda ANTES de qualquer bootstrap/migração abaixo, de propósito: o que queremos preservar
// é o estado EXATO de antes deste deploy. Se uma migração tiver um bug, o snapshot já
// guardou o "antes" e o rollback existe.
//
// Um backup que depende de alguém lembrar de exportar não existe no dia em que é preciso.
// ---------------------------------------------------------------------
try {
  const snap = snapshots.createSnapshot(DATA_DIR, 'boot');
  if (snap && snap.path) {
    console.log(`[snapshot] ${snap.files.length} arquivo(s), ${(snap.bytes / 1024).toFixed(0)} KB → ${path.basename(snap.path)} (mantendo os ${snapshots.KEEP} mais recentes)`);
  }
} catch (e) {
  // Um erro aqui NÃO pode derrubar o boot: ficar sem backup é ruim, ficar sem sistema é pior.
  console.error('[snapshot] Falhou ao criar o snapshot de boot:', e.message);
}

if (!fs.existsSync(path.join(DATA_DIR, 'duels.json'))) writeJSON('duels.json', []);
if (!fs.existsSync(path.join(DATA_DIR, 'notifications.json'))) writeJSON('notifications.json', {});
// Anúncios do admin (demanda #9): avisos globais que viram pop-up no primeiro login de
// cada usuário depois de publicados, e depois ficam na lista de notificações.
if (!fs.existsSync(path.join(DATA_DIR, 'announcements.json'))) writeJSON('announcements.json', []);
// Competências da trilha (demandas #5a/#5b). Nasce com as 5 originais.
if (!fs.existsSync(path.join(DATA_DIR, 'skills.json'))) writeJSON('skills.json', defaultSkills());

if (!fs.existsSync(path.join(DATA_DIR, 'settings.json'))) {
  writeJSON('settings.json', {
    evaluatorEnabled: process.env.EVALUATOR_ENABLED === 'true',
    featureAccess: defaultFeatureAccess(),
  });
} else {
  // MIGRAÇÃO (demanda #4). Um settings.json que já existe — de um deploy rodando — não
  // tem `featureAccess`. Sem isto, o `visitorEvaluationEnabled` que o admin tinha LIGADO
  // seria descartado em silêncio (o default de `avaliacao.visitante` é false), e ele
  // descobriria pelo aluno reclamando que a avaliação sumiu.
  const s = readJSON('settings.json', {});
  if (!s.featureAccess) {
    s.featureAccess = defaultFeatureAccess();
    if ('visitorEvaluationEnabled' in s) {
      s.featureAccess.avaliacao.visitante = !!s.visitorEvaluationEnabled;
      delete s.visitorEvaluationEnabled; // absorvido pela matriz
    }
    writeJSON('settings.json', s);
    console.log('[migração] settings.json ganhou featureAccess (demanda #4).');
  }
}

// MIGRAÇÃO (demanda #7, decisão D7). Pacientes que já existem nascem BLOQUEADOS para
// aluno e visitante — o admin decide quem libera, conscientemente.
//
// ⚠ CONSEQUÊNCIA DIRETA, e ela é grande: depois deste deploy **ninguém consegue praticar**
// até o admin entrar em /admin/freeplay e liberar. O sistema "quebra" sem quebrar — nada
// dá erro, os cards simplesmente somem. Por isso o aviso no log é gritado, e por isso isto
// está no checklist de deploy.
//
// Um paciente NOVO (criado pelo admin depois disto) nasce LIBERADO: `canUsePatient` trata
// campo ausente como liberado, e seria absurdo o admin criar um paciente e ele "não
// aparecer". A D7 fala dos EXISTENTES, não do comportamento futuro.
{
  const chars = readJSON('freeplay-characters.json', []);
  const semCampo = chars.filter((c) => c.allowStudent === undefined && c.allowVisitor === undefined);
  if (semCampo.length) {
    for (const c of chars) {
      if (c.allowStudent === undefined) c.allowStudent = false;
      if (c.allowVisitor === undefined) c.allowVisitor = false;
    }
    writeJSON('freeplay-characters.json', chars);
    console.log(
      `[migração] ${semCampo.length} paciente(s) BLOQUEADO(S) para aluno e visitante (demanda #7/D7).\n`
      + '           ⚠ NINGUÉM consegue praticar até um admin liberar em Admin → Personagens.',
    );
  }
}

// --- Diagnóstico de startup ---
function envDiag(name) {
  const v = process.env[name];
  if (v === undefined) return 'NOT SET';
  if (v === '') return 'EMPTY';
  return `set (${v.length} chars)`;
}
console.log('[startup] JWT_SECRET     =', envDiag('JWT_SECRET'));
console.log('[startup] OPENAI_API_KEY =', envDiag('OPENAI_API_KEY'), '(Simulação + Whisper)');
console.log('[startup] EVALUATOR_ENABLED =', process.env.EVALUATOR_ENABLED === 'true' ? 'true' : 'false');
console.log('[startup] DATA_DIR       =', DATA_DIR);

// --- Auth helpers ---
function publicUser(u) {
  if (!u) return null;
  // `seenAnnouncements` é controle interno (quais anúncios o usuário já fechou); não
  // interessa ao client e cresce com o tempo — fica de fora.
  const { password, passwordHash, seenAnnouncements, ...safe } = u;
  if (safe.role === 'therapist' && safe.teacherId) {
    try {
      const teacher = readJSON('users.json').find((t) => t.id === safe.teacherId);
      if (teacher && teacher.name) safe.teacherName = teacher.name;
    } catch {}
  }
  return safe;
}
function signToken(user) {
  // O visitante agora é um usuário de verdade em users.json (demanda #1), então o
  // token não precisa mais carregar a identidade dele — o `sub` basta, como para
  // qualquer outro papel.
  const payload = { sub: user.id, role: user.role, username: user.username };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL });
}
function getTokenFromReq(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}
function requireAuth(req, res, next) {
  const token = getTokenFromReq(req);
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // Todo mundo — inclusive o visitante — é lido do users.json a cada request.
    // Isso é o que permite barrar um visitante expirado (demanda #8) mesmo com o JWT
    // ainda válido: quem manda é o disco, não o token.
    const user = readJSON('users.json').find((u) => u.id === payload.sub);
    if (!user) return res.status(401).json({ error: 'Sessão inválida' });

    // Demanda #8. O JWT vale 7 dias (TOKEN_TTL), mas o acesso do visitante pode durar
    // 1 hora — então NÃO dá para confiar no token. A checagem é a cada request, contra
    // o disco. É 403 (não 401) de propósito: 401 dispara o `onSessionExpired` do client,
    // que faz logout e joga na tela de login; aqui queremos a tela de "acesso expirado".
    if (isVisitor(user) && visitorAccessExpired(user)) {
      return res.status(403).json({
        error: 'Seu acesso de visitante expirou. Fale com a administração para renovar.',
        code: 'VISITOR_EXPIRED',
        visitorExpired: true,
      });
    }

    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Sessão expirada' });
  }
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Não autenticado' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Acesso negado' });
    next();
  };
}
function isAdmin(user) { return !!(user && user.role === 'admin'); }
// Visitante: usuário REAL em users.json (demanda #1), com as mesmas permissões de
// aluno (demanda #2). O que ele NÃO compartilha com o aluno é a arena: ranking, MMR
// e duelo são segmentados por papel (D3/D9) — ver `peerRole`.
function isVisitor(user) { return !!(user && (user.role === 'visitor' || user.isVisitor)); }

// A "arena" de um jogador: com quem ele compete e em que ranking aparece.
// Aluno joga com aluno; visitante joga com visitante (D3/D9). É a chave única de
// segmentação — ranking, lista de oponentes e aceite de duelo passam todos por aqui,
// para não haver duas noções divergentes de "meu par".
function peerRole(user) { return isVisitor(user) ? 'visitor' : 'therapist'; }
function samePeerGroup(a, b) { return !!a && !!b && peerRole(a) === peerRole(b); }

// =====================================================================
// ACESSO A FUNCIONALIDADES (demanda #4) — a matriz funcionalidade × papel
// =====================================================================
// Duas camadas de enforcement, e SÓ A SEGUNDA é segurança:
//   1. a sidebar desenha o cadeado (UX, demanda #3);
//   2. `requireFeature` devolve 403 — quem digitar a URL na mão bate aqui.
// O catálogo canônico vive em `server/features.js`; o client não inventa chaves.

const LOCKED_MESSAGE_DEFAULT =
  'Esta funcionalidade não está liberada para o seu perfil. Fale com o seu professor '
  + 'ou com a administração para liberar o acesso.';

function readFeatureAccess() {
  return normalizeFeatureAccess(readJSON('settings.json', {}).featureAccess);
}

// A mensagem do cadeado é UMA SÓ para todas as funcionalidades (D6).
function lockedFeatureMessage() {
  const s = readJSON('settings.json', {});
  const msg = typeof s.lockedFeatureMessage === 'string' ? s.lockedFeatureMessage.trim() : '';
  return msg || LOCKED_MESSAGE_DEFAULT;
}

/** `{ duelo: true, ranking: false, ... }` para o usuário logado. */
function myFeatureMap(user) {
  const access = readFeatureAccess();
  const out = {};
  for (const f of FEATURES) out[f.key] = canUseFeature(access, user, f.key);
  return out;
}

/**
 * Middleware. Admin e professor passam sempre (`featureRoleOf` devolve null): o acesso
 * deles vem do papel, não da matriz — e bloquear o admin seria se trancar para fora.
 *
 * O 403 leva `feature` + `lockedMessage` para o client abrir o mesmo pop-up do cadeado
 * quando o usuário chega pela URL direta.
 */
function requireFeature(key) {
  return (req, res, next) => {
    if (canUseFeature(readFeatureAccess(), req.user, key)) return next();
    return res.status(403).json({
      error: lockedFeatureMessage(),
      feature: key,
      locked: true,
    });
  };
}

// =====================================================================
// COMPETÊNCIAS DA TRILHA (demandas #5a e #5b)
// =====================================================================
// `skills.json` é a fonte única: nome, cor e CRITÉRIOS de cada competência. Os critérios
// não são decoração — eles entram no system prompt do paciente (`buildExercisePrompt`) e
// definem como o aluno é avaliado naquela competência.

function readSkills() {
  const list = readJSON('skills.json', []);
  return Array.isArray(list) ? list : [];
}

/** O nome já pertence a OUTRA competência? (comparação sem caixa e sem espaços) */
function skillNameTaken(skills, name, selfId = null) {
  const alvo = String(name || '').trim().toLowerCase();
  if (!alvo) return false;
  return skills.some((s) => s.id !== selfId && String(s.name || '').trim().toLowerCase() === alvo);
}

/** O texto de critérios de uma competência. Vazio se ela não existe mais (órfão, D4). */
function skillCriteriaFor(skillId) {
  const s = readSkills().find((x) => String(x.id) === String(skillId));
  return s ? (s.criteria || '') : '';
}

/**
 * Marca d'água dos ids de competência já emitidos.
 *
 * Exercícios e logs "lembram" os ids que usaram — mas se ninguém referenciava a
 * competência apagada, essa memória não existe, e o id seria reciclado. Esta marca
 * persiste o maior id já emitido, e nunca regride.
 */
function skillIdFloor() {
  const s = readJSON('settings.json', {});
  return Number(s.skillIdFloor) || 0;
}
async function bumpSkillIdFloor(id) {
  const n = Number(id) || 0;
  if (n <= skillIdFloor()) return;
  await withFileLock('settings.json', () => {
    const s = readJSON('settings.json', {});
    if ((Number(s.skillIdFloor) || 0) < n) {
      s.skillIdFloor = n;
      writeJSON('settings.json', s);
    }
  });
}

/** Quantos exercícios apontam para cada competência (e quantos ficaram órfãos). */
function exerciseCountBySkill() {
  const skills = readSkills();
  const ids = new Set(skills.map((s) => String(s.id)));
  const counts = {};
  let orphans = 0;
  for (const ex of readJSON('exercises.json', [])) {
    const sid = String(ex.skillId);
    if (ids.has(sid)) counts[sid] = (counts[sid] || 0) + 1;
    else orphans += 1;   // skillId nulo, vazio ou de uma competência apagada
  }
  return { counts, orphans };
}

// =====================================================================
// VALIDADE DO ACESSO DO VISITANTE (demanda #8)
// =====================================================================
// O visitante é um lead: ele entra sem senha (D1) e o acesso tem prazo. Passado o prazo,
// ele é barrado até um admin renovar.
//
// ⚠ O JWT vale 7 dias, mas o acesso pode durar 1 hora — por isso a checagem lê o
// `users.json` a cada request (em `requireAuth`), em vez de confiar no token.

// Catálogo das durações oferecidas. O client escolhe daqui — não inventa valores.
const VISITOR_DURATIONS = [
  { key: '1h', label: '1 hora', ms: 60 * 60 * 1000 },
  { key: '1d', label: '1 dia', ms: 24 * 60 * 60 * 1000 },
  { key: '3d', label: '3 dias', ms: 3 * 24 * 60 * 60 * 1000 },
  { key: '1w', label: '1 semana', ms: 7 * 24 * 60 * 60 * 1000 },
  { key: '1m', label: '1 mês', ms: 30 * 24 * 60 * 60 * 1000 },
  // Escape hatch: uma turma em visita, um evento. Sem isto, o admin acabaria
  // desbloqueando na mão toda hora.
  { key: 'unlimited', label: 'Sem prazo', ms: null },
];
const VISITOR_DURATION_DEFAULT = '3d';

function visitorDuration(key) {
  return VISITOR_DURATIONS.find((d) => d.key === key) || null;
}

/** A duração padrão VIGENTE, definida pelo admin. */
function defaultVisitorDurationKey() {
  const s = readJSON('settings.json', {});
  return visitorDuration(s.visitorAccessDuration) ? s.visitorAccessDuration : VISITOR_DURATION_DEFAULT;
}

/**
 * A data em que expira um acesso que começa AGORA, com a duração padrão vigente.
 * `null` = sem prazo.
 */
function newVisitorExpiry() {
  const d = visitorDuration(defaultVisitorDurationKey());
  return d && d.ms ? new Date(Date.now() + d.ms).toISOString() : null;
}

/**
 * O acesso deste visitante venceu?
 *
 * Sem `accessExpiresAt` → NÃO expirado. É o caso do visitante que já existia antes desta
 * demanda: ele não é retroativamente barrado (o admin define o prazo dos próximos, ou
 * bloqueia este na mão). Falhar aberto aqui é a escolha segura — o contrário derrubaria
 * leads antigos sem ninguém entender por quê.
 */
function visitorAccessExpired(user) {
  if (!user) return false;
  if (user.blocked) return true;                       // bloqueio manual do admin
  if (!user.accessExpiresAt) return false;             // sem prazo
  const t = Date.parse(user.accessExpiresAt);
  if (!Number.isFinite(t)) return false;               // data corrompida: não tranca ninguém
  return t <= Date.now();
}

// =====================================================================
// ACESSO A PACIENTES (demanda #7) — quem pode atender cada personagem
// =====================================================================
// `allowStudent` / `allowVisitor` no personagem de Simulação. Admin e professor veem
// todos (precisam revisar o material).
//
// ⚠ Esconder o card em `GET /api/freeplay` NÃO é bloqueio: sem o guard nas rotas que
// recebem um `itemId`, dava para conversar com um paciente bloqueado direto pela API —
// o card some, o acesso continua. Todo caminho que resolve um paciente passa por
// `canUsePatient`.

/** Um paciente sem os campos (base antiga, antes da migração) é tratado como LIBERADO. */
function canUsePatient(user, character) {
  if (!character) return false;
  if (isAdmin(user) || (user && user.role === 'supervisor')) return true;
  const key = isVisitor(user) ? 'allowVisitor' : 'allowStudent';

  // ⚠ Não basta `!== false`: um `"false"` (STRING) é truthy, e o paciente ficava LIBERADO
  // com o admin achando que o tinha bloqueado. Era um bug real — bastava um form
  // url-encoded, um <select> HTML ou um client que serialize booleanos como texto.
  // A escrita já coage (ver `coerceBool` no pickFields), e aqui fechamos por dentro.
  const v = character[key];
  if (v === false || v === 'false') return false;
  return true;   // ausente (base antiga) ou qualquer coisa truthy = liberado
}

function patientBlockedResponse(res) {
  return res.status(403).json({
    error: 'Este paciente não está liberado para o seu perfil.',
    patientLocked: true,
  });
}
// Aluno vê o próprio; professor e admin veem todos (aba "Todos os logs").
function canSeeAllLogs(user) { return !!(user && (user.role === 'admin' || user.role === 'supervisor')); }

// =====================================================================
// AUTH
// =====================================================================
app.post('/api/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Usuário e senha são obrigatórios' });
  const user = readJSON('users.json').find((u) => u.username === username);
  const ok = user && user.passwordHash ? await bcrypt.compare(String(password), user.passwordHash) : false;
  if (!ok) return res.status(401).json({ error: 'Credenciais inválidas' });
  res.json({ token: signToken(user), user: publicUser(user) });
});

// Cadastro/entrada do visitante (demanda #1).
//
// O visitante é um usuário REAL em users.json (role: 'visitor'), com nome, e-mail e
// telefone — os três obrigatórios e únicos.
//
// ⚠ NÃO tem senha (D1): informar os dados JÁ é o login. Quem repetir e-mail + telefone
// de um visitante existente ENTRA NA CONTA DELE (não cria duplicata). É captura de
// lead, não autenticação.
app.post('/api/login/visitor', visitorLimiter, async (req, res) => {
  const body = req.body || {};
  const name = String(body.name == null ? '' : body.name).trim();
  const email = normalizeEmail(body.email);
  const phone = normalizePhone(body.phone);

  const errors = [];
  if (name.length < 2) errors.push({ field: 'name', error: 'Informe seu nome.' });
  if (!email) errors.push({ field: 'email', error: 'E-mail inválido.' });
  if (!phone) errors.push({ field: 'phone', error: 'Telefone inválido. Use DDD + número.' });
  if (errors.length) return res.status(400).json({ error: errors[0].error, fields: errors });

  const result = await withFileLock('users.json', () => {
    const users = readJSON('users.json');

    // Já se cadastrou antes? Volta para a MESMA conta (não duplica).
    const existing = users.find((u) => u.role === 'visitor' && u.email === email && u.phone === phone);
    if (existing) {
      // ⚠ FURO ÓBVIO se não checarmos aqui: um visitante EXPIRADO refaria o cadastro com
      // os mesmos dados, cairia neste ramo e receberia um token novo — burlando o prazo
      // sem esforço nenhum. Quem renova é o admin (demanda #8), não o próprio lead.
      if (visitorAccessExpired(existing)) {
        return {
          status: 403,
          code: 'VISITOR_EXPIRED',
          error: 'Seu acesso de visitante expirou. Fale com a administração para renovar.',
        };
      }
      return { user: existing };
    }

    // Os três campos são únicos — e a colisão é checada contra TODOS os papéis:
    // um visitante não pode "assumir" o e-mail de um aluno.
    if (users.some((u) => u.email && u.email.toLowerCase() === email)) {
      return { status: 409, field: 'email', error: 'Este e-mail já está cadastrado.' };
    }
    if (users.some((u) => u.phone && u.phone === phone)) {
      return { status: 409, field: 'phone', error: 'Este telefone já está cadastrado.' };
    }
    if (users.some((u) => u.name && u.name.trim().toLowerCase() === name.toLowerCase())) {
      return { status: 409, field: 'name', error: 'Este nome já está cadastrado.' };
    }

    const id = nextUserId(users);
    const user = {
      id,
      username: `visitor-${id}`,
      name,
      email,
      phone,
      role: 'visitor',
      teacherId: null,
      profilePhoto: '',
      createdAt: new Date().toISOString(),
      // Demanda #8: o prazo é carimbado no cadastro, com a duração padrão VIGENTE.
      // Mudar o padrão depois NÃO recalcula quem já entrou (D8).
      accessExpiresAt: newVisitorExpiry(),
      blocked: false,
    };
    users.push(user);
    writeJSON('users.json', users);
    return { user };
  });

  if (result.error) {
    const body = { error: result.error };
    if (result.field) body.field = result.field;
    if (result.code) { body.code = result.code; body.visitorExpired = true; }
    return res.status(result.status).json(body);
  }
  res.json({ token: signToken(result.user), user: publicUser(result.user) });
});

app.get('/api/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

app.post('/api/me/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Senha atual e nova são obrigatórias' });
  if (String(newPassword).length < 6) return res.status(400).json({ error: 'Nova senha deve ter ao menos 6 caracteres' });
  const ok = await bcrypt.compare(String(currentPassword), req.user.passwordHash || '');
  if (!ok) return res.status(401).json({ error: 'Senha atual incorreta' });
  await withFileLock('users.json', () => {
    const users = readJSON('users.json');
    const idx = users.findIndex((u) => u.id === req.user.id);
    if (idx === -1) return;
    users[idx].passwordHash = bcrypt.hashSync(String(newPassword), BCRYPT_ROUNDS);
    writeJSON('users.json', users);
  });
  res.json({ ok: true });
});

// =====================================================================
// PERFIL
// =====================================================================
function canAccessUser(actor, targetId) {
  if (!actor) return false;
  if (actor.role === 'admin') return true;
  if (actor.id === targetId) return true;
  // Professor só acessa o perfil dos alunos vinculados a ele.
  if (actor.role === 'supervisor') {
    const target = readJSON('users.json').find((u) => u.id === targetId);
    return !!(target && target.teacherId === actor.id);
  }
  return false;
}

app.get('/api/users/:id', requireAuth, (req, res) => {
  if (!canAccessUser(req.user, req.params.id)) return res.status(403).json({ error: 'Acesso negado' });
  const user = readJSON('users.json').find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  res.json(publicUser(user));
});

app.put('/api/users/:id', requireAuth, async (req, res) => {
  if (req.user.id !== req.params.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Acesso negado' });
  const result = await withFileLock('users.json', () => {
    const users = readJSON('users.json');
    const idx = users.findIndex((u) => u.id === req.params.id);
    if (idx === -1) return { status: 404, error: 'Usuário não encontrado' };
    const allowed = ['name', 'email', 'profilePhoto'];
    const patch = {};
    for (const k of allowed) if (k in req.body) patch[k] = req.body[k];

    // Unicidade do e-mail. Esta rota é a que o próprio usuário chama ao editar o perfil —
    // e era por aqui que um aluno assumia o e-mail de um visitante, furando a chave que o
    // `/api/login/visitor` usa para recuperar contas.
    if (patch.email !== undefined && String(patch.email || '').trim()) {
      const dono = emailTakenBy(users, patch.email, req.params.id);
      if (dono) return { status: 409, field: 'email', error: 'Este e-mail já está cadastrado.' };
    }

    users[idx] = { ...users[idx], ...patch };
    writeJSON('users.json', users);
    return { user: publicUser(users[idx]) };
  });
  if (result.error) {
    const body = { error: result.error };
    if (result.field) body.field = result.field;   // o form destaca o campo que colidiu
    return res.status(result.status).json(body);
  }
  res.json(result.user);
});

// =====================================================================
// ADMIN · CONTAS
// =====================================================================
const usernameRegex = /^[a-zA-Z0-9._-]{3,32}$/;
function nextUserId(users) {
  const max = users.reduce((m, u) => {
    const n = Number(u.id);
    return Number.isFinite(n) && n > m ? n : m;
  }, 0);
  return String(max + 1);
}
/**
 * O e-mail já pertence a OUTRO usuário?
 *
 * ⚠ O sistema DEPENDE dessa unicidade: `POST /api/login/visitor` recupera a conta de um
 * lead por `email + phone`, e recusa (409) um e-mail que já exista. Mas até aqui a
 * checagem só existia lá — o `POST /api/admin/users` e o `PUT /api/users/:id` gravavam
 * e-mail duplicado sem reclamar. Um aluno editando o próprio perfil podia **assumir o
 * e-mail de um visitante** (reproduzido), deixando dois usuários com a mesma chave.
 *
 * Comparação case-insensitive, igual à do cadastro de visitante (`:636`).
 */
function emailTakenBy(users, email, selfId = null) {
  const alvo = String(email || '').trim().toLowerCase();
  if (!alvo) return null;   // e-mail vazio é permitido (o campo é opcional)
  return users.find((u) => u.id !== selfId && u.email && String(u.email).toLowerCase() === alvo) || null;
}

function validateUserPayload(body, users, { isUpdate = false, currentUser = null } = {}) {
  const errors = [];
  const username = (body.username || '').trim();
  const role = body.role;
  const teacherId = body.teacherId || null;
  if (!isUpdate || body.username !== undefined) {
    if (!usernameRegex.test(username)) errors.push('Usuário inválido (3-32 caracteres: letras, números, . _ -)');
    const dup = users.find((u) => u.username === username && (!currentUser || u.id !== currentUser.id));
    if (dup) errors.push('Usuário já existe');
  }
  if (body.email !== undefined && String(body.email || '').trim()) {
    if (emailTakenBy(users, body.email, currentUser ? currentUser.id : null)) {
      errors.push('Este e-mail já está cadastrado');
    }
  }
  if (!isUpdate && (!body.password || String(body.password).length < 6)) errors.push('Senha deve ter ao menos 6 caracteres');
  if (body.password !== undefined && body.password !== '' && String(body.password).length < 6) errors.push('Senha deve ter ao menos 6 caracteres');
  if (!isUpdate && !VALID_ROLES.includes(role)) errors.push('Função inválida');
  if (teacherId) {
    const t = users.find((u) => u.id === teacherId);
    if (!t || t.role !== 'supervisor') errors.push('Professor inválido');
  }
  return errors;
}

app.get('/api/admin/users', requireAuth, requireRole('admin'), (req, res) => {
  res.json(readJSON('users.json').map(publicUser));
});

app.post('/api/admin/users', requireAuth, requireRole('admin'), async (req, res) => {
  const result = await withFileLock('users.json', () => {
    const users = readJSON('users.json');
    const errors = validateUserPayload(req.body, users);
    if (errors.length) return { status: 400, error: errors.join('; ') };
    const role = req.body.role;
    const newUser = {
      id: nextUserId(users),
      username: req.body.username.trim(),
      name: (req.body.name || req.body.username).trim(),
      role,
      teacherId: role === 'therapist' ? (req.body.teacherId || null) : null,
      passwordHash: bcrypt.hashSync(String(req.body.password), BCRYPT_ROUNDS),
      ...DEFAULT_PROFILE,
      email: req.body.email || '',
    };
    users.push(newUser);
    writeJSON('users.json', users);
    return { user: publicUser(newUser) };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.user);
});

app.put('/api/admin/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const result = await withFileLock('users.json', () => {
    const users = readJSON('users.json');
    const idx = users.findIndex((u) => u.id === req.params.id);
    if (idx === -1) return { status: 404, error: 'Usuário não encontrado' };
    const current = users[idx];
    if (current.id === req.user.id && req.body.role && req.body.role !== current.role) {
      return { status: 400, error: 'Você não pode alterar a sua própria função.' };
    }
    const merged = {
      ...current,
      ...(req.body.username !== undefined ? { username: String(req.body.username).trim() } : {}),
      ...(req.body.name !== undefined ? { name: String(req.body.name).trim() } : {}),
      ...(req.body.role !== undefined ? { role: req.body.role } : {}),
      ...(req.body.email !== undefined ? { email: req.body.email } : {}),
    };
    merged.teacherId = merged.role === 'therapist'
      ? (req.body.teacherId !== undefined ? (req.body.teacherId || null) : current.teacherId)
      : null;

    // `visitor` não está em VALID_ROLES: ninguém é PROMOVIDO a visitante (só o cadastro
    // da #1 cria um). Mas o admin precisa poder EDITAR um visitante que já existe — sem
    // esta exceção, salvar a linha dele devolvia "Função inválida" (demanda #6).
    const rolesPermitidos = current.role === 'visitor' ? [...VALID_ROLES, 'visitor'] : VALID_ROLES;
    if (!rolesPermitidos.includes(merged.role)) return { status: 400, error: 'Função inválida' };

    // Converter um lead em aluno/professor/admin EXIGE definir uma senha.
    //
    // O visitante entra sem senha (D1), então ele não tem `passwordHash`. Promovê-lo sem
    // senha criava uma CONTA MORTA: o login por senha exige o hash, e o login de visitante
    // só recupera quem tem `role: 'visitor'` — a pessoa perdia as duas portas de entrada,
    // em silêncio, e o admin achava que tinha feito a coisa certa.
    if (current.role === 'visitor' && merged.role !== 'visitor' && !req.body.password && !current.passwordHash) {
      return {
        status: 400,
        field: 'password',
        error: 'Defina uma senha para converter este visitante em uma conta com login.',
      };
    }

    const errors = validateUserPayload(merged, users, { isUpdate: true, currentUser: current });
    if (errors.length) return { status: 400, error: errors.join('; ') };
    if (req.body.password) {
      if (String(req.body.password).length < 6) return { status: 400, error: 'Senha deve ter ao menos 6 caracteres' };
      merged.passwordHash = bcrypt.hashSync(String(req.body.password), BCRYPT_ROUNDS);
    }
    // Professor rebaixado → desvincula alunos.
    if (current.role === 'supervisor' && merged.role !== 'supervisor') {
      for (const u of users) if (u.teacherId === current.id) u.teacherId = null;
    }
    users[idx] = merged;
    writeJSON('users.json', users);
    return { user: publicUser(merged) };
  });
  if (result.error) {
    // `field` (quando presente) diz ao formulário QUAL campo destacar.
    const body = { error: result.error };
    if (result.field) body.field = result.field;
    return res.status(result.status).json(body);
  }
  res.json(result.user);
});

app.delete('/api/admin/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Você não pode excluir a própria conta.' });
  const result = await withFileLock('users.json', () => {
    const users = readJSON('users.json');
    const idx = users.findIndex((u) => u.id === req.params.id);
    if (idx === -1) return { status: 404, error: 'Usuário não encontrado' };
    const target = users[idx];
    if (target.role === 'supervisor') {
      const linked = users.filter((u) => u.teacherId === target.id);
      if (linked.length > 0) return { status: 400, error: `Este professor tem ${linked.length} aluno(s) vinculado(s). Reatribua-os antes de excluir.` };
    }
    users.splice(idx, 1);
    writeJSON('users.json', users);
    return { ok: true };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/reset-password', requireAuth, requireRole('admin'), async (req, res) => {
  const newPassword = req.body && req.body.newPassword;
  if (!newPassword || String(newPassword).length < 6) return res.status(400).json({ error: 'Senha deve ter ao menos 6 caracteres' });
  const result = await withFileLock('users.json', () => {
    const users = readJSON('users.json');
    const idx = users.findIndex((u) => u.id === req.params.id);
    if (idx === -1) return { status: 404, error: 'Usuário não encontrado' };
    users[idx].passwordHash = bcrypt.hashSync(String(newPassword), BCRYPT_ROUNDS);
    writeJSON('users.json', users);
    return { ok: true };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json({ ok: true });
});

// Backup completo (admin) — baixa um JSON com todos os dados.
// =====================================================================
// SNAPSHOTS — backup automático do volume (ver server/snapshots.js)
// =====================================================================

// Lista os snapshots disponíveis, do mais novo para o mais antigo.
app.get('/api/admin/snapshots', requireAuth, requireRole('admin'), (req, res) => {
  res.json({ keep: snapshots.KEEP, items: snapshots.listSnapshots(DATA_DIR) });
});

// Cria um snapshot sob demanda ("vou mexer em algo arriscado, salva antes").
app.post('/api/admin/snapshots', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const snap = snapshots.createSnapshot(DATA_DIR, 'manual');
    if (!snap || snap.empty) return res.status(400).json({ error: 'Nada para salvar: o volume está vazio.' });
    res.json({ ok: true, name: path.basename(snap.path), files: snap.files, bytes: snap.bytes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Baixa UM arquivo de dentro de um snapshot — é assim que se recupera, por exemplo, o
// `skills.json` de antes de um deploy sem restaurar o volume inteiro.
app.get('/api/admin/snapshots/:name/:file', requireAuth, requireRole('admin'), (req, res) => {
  const content = snapshots.readFromSnapshot(DATA_DIR, req.params.name, req.params.file);
  if (content == null) return res.status(404).json({ error: 'Snapshot ou arquivo não encontrado.' });
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(content);
});

/**
 * RESTAURA um arquivo a partir de um snapshot. Destrutivo — por isso:
 *  - exige `confirm: true` no corpo (não se restaura por engano num clique);
 *  - só aceita arquivos da allowlist (`snapshots.FILES`), senão daria para escrever
 *    qualquer caminho dentro do DATA_DIR;
 *  - tira um snapshot ANTES de sobrescrever, para que a própria restauração seja
 *    reversível — quem restaura o arquivo errado precisa poder voltar atrás;
 *  - passa por `withFileLock`, como toda escrita do projeto.
 */
app.post('/api/admin/snapshots/:name/restore', requireAuth, requireRole('admin'), async (req, res) => {
  const { file, confirm } = req.body || {};
  if (confirm !== true) return res.status(400).json({ error: 'Envie confirm:true — restaurar sobrescreve os dados atuais.' });
  if (!snapshots.FILES.includes(file)) return res.status(400).json({ error: 'Arquivo não permitido.', allowed: snapshots.FILES });

  const content = snapshots.readFromSnapshot(DATA_DIR, req.params.name, file);
  if (content == null) return res.status(404).json({ error: 'Snapshot ou arquivo não encontrado.' });

  let parsed;
  try { parsed = JSON.parse(content); } catch { return res.status(422).json({ error: 'O arquivo do snapshot está corrompido (JSON inválido).' }); }

  snapshots.createSnapshot(DATA_DIR, 'prerestore');
  await withFileLock(file, () => { writeJSON(file, parsed); });

  console.warn(`[snapshot] RESTAURADO ${file} de ${req.params.name} por ${req.user.username}`);
  res.json({ ok: true, file, from: req.params.name });
});

app.get('/api/admin/export', requireAuth, requireRole('admin'), (req, res) => {
  const payload = {
    exportedAt: new Date().toISOString(),
    exportedBy: req.user.username,
    data: {
      users: readJSON('users.json'),
      skills: readSkills(),
      exercises: readJSON('exercises.json'),
      freeplayCharacters: readJSON('freeplay-characters.json'),
      progress: readJSON('progress.json', {}),
      logs: readJSON('logs.json'),
      achievements: readJSON('achievements.json', {}),
      activeSessions: readJSON('active-sessions.json', {}),
      mmr: readJSON('mmr.json', { players: {}, characters: {} }),
      duels: readJSON('duels.json', []),
      notifications: readJSON('notifications.json', {}),
      announcements: readAnnouncements(),
      settings: readJSON('settings.json', {}),
    },
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="genus-praxis-export-${stamp}.json"`);
  res.send(JSON.stringify(payload, null, 2));
});

// =====================================================================
// PROFESSOR / SUPERVISOR
// =====================================================================
// Lista de alunos: admin vê todos; supervisor, só os vinculados a ele.
app.get('/api/teacher/students', requireAuth, requireRole('supervisor', 'admin'), (req, res) => {
  const users = readJSON('users.json');
  const list = isAdmin(req.user)
    ? users.filter((u) => u.role === 'therapist')
    : users.filter((u) => u.role === 'therapist' && u.teacherId === req.user.id);
  res.json(list.map(publicUser));
});

// =====================================================================
// GAMIFICAÇÃO — constância, objetivos diários, conquistas e títulos
// =====================================================================
// Não há XP nem níveis: a progressão é expressa por streak + conquistas +
// título selecionável. Tudo é derivado dos logs; só a data de desbloqueio das
// conquistas é persistida (achievements.json).
const ACHIEVEMENT_DEFS = [
  { id: 'first_session',      icon: '◐', title: 'Primeira sessão',       description: 'Concluiu sua primeira sessão na plataforma.',                                   tier: 'bronze' },
  { id: 'simulacao_complete', icon: '◇', title: 'Repertório clínico',    description: 'Concluiu todos os personagens da Simulação.',                                   tier: 'gold' },
  { id: 'trilha_skill_1',     icon: '▲', title: 'Hermenêutica plena',    description: 'Concluiu todos os exercícios da competência Hermenêutica.',                     tier: 'silver' },
  { id: 'trilha_skill_2',     icon: '▲', title: 'Estrutura consolidada', description: 'Concluiu todos os exercícios da competência Estrutura.',                        tier: 'silver' },
  { id: 'trilha_skill_3',     icon: '▲', title: 'Empatia consolidada',   description: 'Concluiu todos os exercícios da competência Empatia.',                          tier: 'silver' },
  { id: 'trilha_skill_4',     icon: '▲', title: 'Olho clínico',          description: 'Concluiu todos os exercícios da competência Especificidade do caso.',           tier: 'silver' },
  { id: 'trilha_skill_5',     icon: '▲', title: 'Autoconhecimento',      description: 'Concluiu todos os exercícios da competência Eu.',                               tier: 'silver' },
  { id: 'trilha_master',      icon: '◆', title: 'Programa concluído',    description: 'Concluiu todos os exercícios das 5 competências.',                              tier: 'platinum' },
  { id: 'high_score',         icon: '★', title: 'Excelência técnica',    description: 'Atingiu pontuação ≥ 85 em uma única sessão.',                                   tier: 'gold' },
  { id: 'speed_demon',        icon: '↗', title: 'Eficiência',            description: 'Concluiu uma sessão em menos de 5 min com pontuação positiva.',                 tier: 'silver' },
  { id: 'early_bird',         icon: '◔', title: 'Madrugador',            description: 'Realizou uma sessão antes das 7h.',                                             tier: 'bronze' },
  { id: 'night_owl',          icon: '◑', title: 'Sessão noturna',        description: 'Realizou uma sessão depois das 23h.',                                           tier: 'bronze' },
  { id: 'centena',            icon: '∞', title: 'Centena',               description: '100 sessões concluídas.',                                                       tier: 'platinum' },
  { id: 'polivalente',        icon: '◉', title: 'Versatilidade',         description: 'Concluiu uma sessão de trilha e uma de simulação no mesmo dia.',                tier: 'gold' },
  { id: 'streak_7_ever',      icon: '●', title: 'Constância',            description: 'Manteve constância de 7 dias ao menos uma vez.',                                tier: 'silver' },
  { id: 'streak_30_ever',     icon: '●', title: 'Persistência',          description: 'Manteve constância de 30 dias ao menos uma vez.',                               tier: 'platinum' },
  { id: 'highlights_10',      icon: '◎', title: 'Curador',               description: 'Marcou 10 mensagens como destaque em sessões.',                                 tier: 'silver' },
  { id: 'all_difficulties',   icon: '⊟', title: 'Calibragem',            description: 'Concluiu exercícios das 3 dificuldades (iniciante, intermediário, avançado).',  tier: 'silver' },
  { id: 'lua_cheia',          icon: '◐', title: 'Amplitude',             description: 'Realizou sessões antes das 7h e depois das 23h em dias diferentes.',            tier: 'gold' },
];

// ⚠ BUG REAL de fuso horário. `dayKey` usava `toISOString()` (UTC) enquanto as conquistas
// `early_bird`/`night_owl` usavam `getHours()` (hora LOCAL) — dois fusos no mesmo módulo.
// No Brasil (UTC−3), uma sessão às 21h30 cai no dia SEGUINTE em UTC: o aluno que estuda
// toda noite via a streak "pular" um dia, e a missão diária de hoje só era creditada
// amanhã. Agora todo o cálculo de "que dia é este log" passa por aqui, num fuso único.
//
// `APP_TIMEZONE` permite mudar (uma turma em outro país); o padrão é o de casa.
const APP_TIMEZONE = process.env.APP_TIMEZONE || 'America/Sao_Paulo';

/** Partes de data/hora de um timestamp, no fuso da aplicação. */
function localParts(timestamp) {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return null;
  // `en-CA` dá YYYY-MM-DD, que é exatamente o formato de chave que queremos.
  const [date, time] = new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d).split(', ');
  return { date, hour: Number(time.slice(0, 2)) };
}

function dayKey(timestamp) {
  const p = localParts(timestamp);
  return p ? p.date : new Date(timestamp).toISOString().slice(0, 10);
}

/** A hora (0–23) do log, no MESMO fuso do `dayKey`. */
function localHour(timestamp) {
  const p = localParts(timestamp);
  return p ? p.hour : new Date(timestamp).getHours();
}

function computeStreak(userLogs) {
  if (!userLogs.length) {
    return { current: 0, longest: 0, isAlive: false, lastActiveDate: null, status: 'none', daysToWeekly: 7, daysToMonthly: 30 };
  }
  const days = new Set(userLogs.map((l) => dayKey(l.timestamp || Date.now())));
  const today = dayKey(Date.now());
  const yesterday = dayKey(Date.now() - 86400000);

  let cursor = days.has(today) ? today : (days.has(yesterday) ? yesterday : null);
  let current = 0;
  if (cursor) {
    const d = new Date(cursor + 'T00:00:00Z');
    while (days.has(d.toISOString().slice(0, 10))) {
      current++;
      d.setUTCDate(d.getUTCDate() - 1);
    }
  }

  const sorted = [...days].sort();
  let longest = 0;
  let run = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (i === 0) { run = 1; longest = 1; continue; }
    const prev = new Date(sorted[i - 1] + 'T00:00:00Z');
    const cur = new Date(sorted[i] + 'T00:00:00Z');
    const diff = Math.round((cur - prev) / 86400000);
    run = diff === 1 ? run + 1 : 1;
    if (run > longest) longest = run;
  }

  const status = current >= 30 ? 'monthly' : (current >= 7 ? 'weekly' : (current > 0 ? 'active' : 'none'));
  return {
    current,
    longest,
    isAlive: days.has(today) || days.has(yesterday),
    lastActiveDate: sorted[sorted.length - 1] || null,
    status,
    daysToWeekly: Math.max(0, 7 - current),
    daysToMonthly: Math.max(0, 30 - current),
  };
}

function computeDailyMissions(userLogs) {
  const today = dayKey(Date.now());
  const todayLogs = userLogs.filter((l) => dayKey(l.timestamp) === today);
  const totalToday = todayLogs.length;
  const exerciseToday = todayLogs.filter((l) => l.type === 'exercise').length;
  const fastGood = todayLogs.some((l) => l.type === 'freeplay' && (l.durationSeconds || 9999) <= 600 && (l.score || 0) >= 8);

  return [
    { id: 'daily_1exercise', icon: '◯', title: 'Sessão diária',  description: 'Conclua 1 exercício hoje (qualquer tipo)',                target: 1, progress: Math.min(totalToday, 1),    completed: totalToday >= 1 },
    { id: 'daily_2trilha',   icon: '◎', title: 'Foco na trilha', description: 'Conclua 2 exercícios da trilha hoje',                     target: 2, progress: Math.min(exerciseToday, 2), completed: exerciseToday >= 2 },
    { id: 'daily_efficiency',icon: '↗', title: 'Aclamação',      description: 'Conclua uma Simulação em até 10 min com pontuação ≥ 8',  target: 1, progress: fastGood ? 1 : 0,           completed: fastGood },
  ];
}

function computeEarnedAchievements(userLogs, streak, exercises, freeplay) {
  const exerciseIds = new Set(userLogs.filter((l) => l.type === 'exercise' && l.itemId).map((l) => String(l.itemId)));
  const freeplayIds = new Set(userLogs.filter((l) => l.type === 'freeplay' && l.itemId).map((l) => String(l.itemId)));
  const earned = new Set();

  if (userLogs.length >= 1) earned.add('first_session');
  if (freeplay.length > 0 && freeplay.every((c) => freeplayIds.has(String(c.id)))) earned.add('simulacao_complete');

  for (let s = 1; s <= 5; s++) {
    const phases = exercises.filter((e) => Number(e.skillId) === s);
    if (phases.length > 0 && phases.every((p) => exerciseIds.has(String(p.id)))) earned.add(`trilha_skill_${s}`);
  }
  if ([1, 2, 3, 4, 5].every((s) => earned.has(`trilha_skill_${s}`))) earned.add('trilha_master');

  // ⚠ O limiar era 25 — herdado do All_OS, onde a trilha usava a escala −9..+9. Numa escala
  // 0–100 unificada, 25 é uma nota FRACA, e "Excelência técnica" (tier ouro) era concedida
  // a quase qualquer sessão avaliada. 85 corresponde ao que o nome promete.
  if (userLogs.some((l) => Number.isFinite(l.score) && l.score >= 85)) earned.add('high_score');
  if (userLogs.some((l) => (l.durationSeconds || 9999) < 300 && Number.isFinite(l.score) && l.score > 0)) earned.add('speed_demon');

  // A descrição de `lua_cheia` promete "em dias DIFERENTES", mas o código só exigia que as
  // duas sessões existissem — uma vigília única das 23h às 6h da mesma madrugada
  // desbloqueava uma conquista de OURO. O aluno lia uma regra e o sistema aplicava outra.
  // Alinhado ao texto, que é o contrato com o usuário.
  const diasEarly = new Set();
  const diasLate = new Set();
  for (const l of userLogs) {
    const h = localHour(l.timestamp);   // mesmo fuso do dayKey (ver APP_TIMEZONE)
    const dia = dayKey(l.timestamp);
    if (h < 7) { earned.add('early_bird'); diasEarly.add(dia); }
    if (h >= 23) { earned.add('night_owl'); diasLate.add(dia); }
  }
  if ([...diasEarly].some((d) => [...diasLate].some((o) => o !== d))) earned.add('lua_cheia');

  if (userLogs.length >= 100) earned.add('centena');

  // Versatilidade: trilha + simulação no MESMO dia (sem neuro).
  const byDay = {};
  for (const l of userLogs) {
    const k = dayKey(l.timestamp);
    if (!byDay[k]) byDay[k] = new Set();
    byDay[k].add(l.type);
  }
  if (Object.values(byDay).some((s) => s.has('exercise') && s.has('freeplay'))) earned.add('polivalente');

  if (streak.longest >= 7) earned.add('streak_7_ever');
  if (streak.longest >= 30) earned.add('streak_30_ever');

  let highlights = 0;
  for (const l of userLogs) {
    if (Array.isArray(l.messages)) highlights += l.messages.filter((m) => m && m.highlighted).length;
  }
  if (highlights >= 10) earned.add('highlights_10');

  const difficultiesDone = new Set(userLogs.filter((l) => l.type === 'exercise' && l.difficulty).map((l) => l.difficulty));
  if (['iniciante', 'intermediario', 'avancado'].every((d) => difficultiesDone.has(d))) earned.add('all_difficulties');

  return earned;
}

app.get('/api/gamification/:userId', requireAuth, requireFeature('objetivos'), async (req, res) => {
  if (!canAccessUser(req.user, req.params.userId)) return res.status(403).json({ error: 'Acesso negado' });
  const userId = req.params.userId;
  const userLogs = readJSON('logs.json').filter((l) => l.userId === userId);
  const exercises = readJSON('exercises.json');
  const freeplay = readJSON('freeplay-characters.json');

  const streak = computeStreak(userLogs);
  const dailyMissions = computeDailyMissions(userLogs);
  const earnedSet = computeEarnedAchievements(userLogs, streak, exercises, freeplay);

  // Persiste a data de desbloqueio das conquistas novas.
  const ach = await withFileLock('achievements.json', () => {
    const all = readJSON('achievements.json', {});
    if (!all[userId]) all[userId] = {};
    let dirty = false;
    for (const id of earnedSet) {
      if (!all[userId][id]) { all[userId][id] = new Date().toISOString(); dirty = true; }
    }
    if (dirty) writeJSON('achievements.json', all);
    return all;
  });

  const achievements = ACHIEVEMENT_DEFS.map((def) => ({
    ...def,
    earned: earnedSet.has(def.id),
    earnedAt: (ach[userId] && ach[userId][def.id]) || null,
  }));

  const validScores = userLogs.map((l) => l.score).filter((s) => Number.isFinite(s));
  const stats = {
    totalSessions: userLogs.length,
    totalExercise: userLogs.filter((l) => l.type === 'exercise').length,
    totalFreeplay: userLogs.filter((l) => l.type === 'freeplay').length,
    averageScore: validScores.length ? Math.round(validScores.reduce((a, b) => a + b, 0) / validScores.length) : null,
    bestScore: validScores.length ? Math.max(...validScores) : null,
  };

  res.json({ streak, dailyMissions, achievements, stats });
});

// Título exibido no perfil/ranking. Revalida a posse server-side: o cliente
// nunca decide qual título possui.
app.post('/api/me/title', requireAuth, requireFeature('objetivos'), async (req, res) => {
  const titleId = req.body && req.body.titleId ? String(req.body.titleId) : '';

  if (titleId) {
    const userLogs = readJSON('logs.json').filter((l) => l.userId === req.user.id);
    const streak = computeStreak(userLogs);
    const earned = computeEarnedAchievements(userLogs, streak, readJSON('exercises.json'), readJSON('freeplay-characters.json'));
    if (!earned.has(titleId)) return res.status(403).json({ error: 'Você ainda não desbloqueou esse título.' });
  }

  const updated = await withFileLock('users.json', () => {
    const users = readJSON('users.json');
    const idx = users.findIndex((u) => u.id === req.user.id);
    if (idx === -1) return null;
    if (titleId) users[idx].activeTitle = titleId;
    else delete users[idx].activeTitle;
    writeJSON('users.json', users);
    return users[idx];
  });
  if (!updated) return res.status(404).json({ error: 'Usuário não encontrado' });
  res.json(publicUser(updated));
});

// =====================================================================
// RANKING + MMR
// =====================================================================
function readMmr() { return readJSON('mmr.json', { players: {}, characters: {} }); }
function titleOf(user) {
  if (!user || !user.activeTitle) return null;
  const def = ACHIEVEMENT_DEFS.find((a) => a.id === user.activeTitle);
  return def ? { id: def.id, title: def.title, tier: def.tier } : null;
}

// Ranking da arena do requisitante (D3): aluno vê alunos, visitante vê visitantes.
// Os dois lados leem o MESMO `mmr.json` (chaveado por userId) — o que separa as duas
// tabelas é só este filtro por papel. Admin/professor não competem, então enxergam o
// ranking dos alunos (é o que eles supervisionam).
app.get('/api/ranking', requireAuth, requireFeature('ranking'), (req, res) => {
  const arena = peerRole(req.user);
  const store = readMmr();
  const users = readJSON('users.json');

  const rows = users
    .filter((u) => u.role === arena && store.players[u.id] && store.players[u.id].n > 0)
    .map((u) => {
      const view = mmrEngine.playerView(store.players[u.id]);
      return {
        userId: u.id,
        name: u.name,
        role: u.role,
        profilePhoto: u.profilePhoto || '',
        title: titleOf(u),
        mmr: view.mmr,
        calibrating: view.calibrating,
        matchesRemaining: view.matchesRemaining,
        matches: view.n,
      };
    })
    .sort((a, b) => {
      if (a.calibrating !== b.calibrating) return a.calibrating ? 1 : -1; // calibrando vai pro fim
      return (b.mmr ?? -1) - (a.mmr ?? -1);
    });

  res.json(rows);
});

app.get('/api/me/mmr', requireAuth, requireFeature('competitivo'), (req, res) => {
  const store = readMmr();
  res.json(mmrEngine.playerView(store.players[req.user.id]));
});

// Reset do ranking (admin): zera as notas dos logs e o progresso da trilha, mas
// PRESERVA os logs e o mmr.json — o rating competitivo sobrevive ao reset.
app.post('/api/admin/ranking/reset', requireAuth, requireRole('admin'), async (req, res) => {
  await withFileLock('logs.json', () => {
    const logs = readJSON('logs.json').map((l) => ({ ...l, score: null, criteriaScores: null }));
    writeJSON('logs.json', logs);
  });
  await withFileLock('progress.json', () => writeJSON('progress.json', {}));
  res.json({ ok: true });
});

// =====================================================================
// NOTIFICAÇÕES (in-app: convite e resultado de duelo)
// =====================================================================
const NOTIF_MAX_PER_USER = 100;

function pushNotification(userId, notif) {
  // O visitante agora recebe notificações como qualquer aluno (demanda #2). O guard
  // antigo (`startsWith('visitor-')`) virou letra morta quando o id passou a ser
  // numérico — removido em vez de "consertado", porque o bloqueio não é mais desejado.
  if (!userId) return;
  return withFileLock('notifications.json', () => {
    const all = readJSON('notifications.json', {});
    const list = all[userId] || [];
    list.unshift({
      id: 'n' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'),
      createdAt: new Date().toISOString(),
      read: false,
      ...notif,
    });
    all[userId] = list.slice(0, NOTIF_MAX_PER_USER);
    writeJSON('notifications.json', all);
  });
}

app.get('/api/notifications', requireAuth, (req, res) => {
  const all = readJSON('notifications.json', {});
  const items = all[req.user.id] || [];
  res.json({ items, unread: items.filter((n) => !n.read).length });
});

app.post('/api/notifications/:id/read', requireAuth, async (req, res) => {
  await withFileLock('notifications.json', () => {
    const all = readJSON('notifications.json', {});
    const list = all[req.user.id] || [];
    const n = list.find((x) => x.id === req.params.id);
    if (n) { n.read = true; all[req.user.id] = list; writeJSON('notifications.json', all); }
  });
  res.json({ ok: true });
});

app.post('/api/notifications/read-all', requireAuth, async (req, res) => {
  await withFileLock('notifications.json', () => {
    const all = readJSON('notifications.json', {});
    all[req.user.id] = (all[req.user.id] || []).map((n) => ({ ...n, read: true }));
    writeJSON('notifications.json', all);
  });
  res.json({ ok: true });
});

// =====================================================================
// ANÚNCIOS DO ADMIN (demanda #9)
// =====================================================================
// Avisos GLOBAIS que o admin publica. Cada anúncio publicado que o usuário ainda não
// confirmou (e cujo público inclua o papel dele) aparece como POP-UP no próximo login;
// ao fechar, o usuário o "vê" e ele para de aparecer como pop-up — mas continua na lista
// de notificações do sino.
//
// Decisões (2026-07-14): público POR PAPEL ao publicar; o visitante VÊ; cada anúncio novo
// reabre para quem já viu o anterior (cada anúncio é um evento próprio); e é RETROATIVO —
// quem se cadastrar depois também vê, enquanto o anúncio estiver ativo.
//
// Modelo de "quem já viu": cada usuário guarda `seenAnnouncements: [ids]` em users.json.
// O visitante é um usuário real (demanda #1), então isso vale para ele igual.

const ANNOUNCEMENT_ROLES = ['therapist', 'visitor', 'supervisor', 'admin'];
// Tipo do anúncio (demanda #12): depois do pop-up, uma NOTIFICAÇÃO fica no sino e uma
// ATUALIZAÇÃO fica no botão de "atualizações do sistema". O padrão é notificação.
const ANNOUNCEMENT_TYPES = ['notification', 'update'];
const announcementType = (t) => (ANNOUNCEMENT_TYPES.includes(t) ? t : 'notification');

function readAnnouncements() {
  const list = readJSON('announcements.json', []);
  return Array.isArray(list) ? list : [];
}

/** O anúncio atinge este papel? `roles` vazio/ausente = todos (retrocompatível). */
function announcementTargetsRole(ann, role) {
  if (!Array.isArray(ann.roles) || ann.roles.length === 0) return true;
  return ann.roles.includes(role);
}

/** Anúncios ATIVOS que o usuário ainda não confirmou e que atingem o papel dele. */
function pendingAnnouncementsFor(user) {
  if (!user) return [];
  const seen = new Set(Array.isArray(user.seenAnnouncements) ? user.seenAnnouncements : []);
  return readAnnouncements()
    .filter((a) => a.active !== false)
    .filter((a) => announcementTargetsRole(a, user.role))
    .filter((a) => !seen.has(a.id))
    .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
}

/** Anúncios ATIVOS que atingem o papel do usuário — o histórico dele (visto ou não). */
function announcementsFor(user) {
  if (!user) return [];
  return readAnnouncements()
    .filter((a) => a.active !== false)
    .filter((a) => announcementTargetsRole(a, user.role))
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));   // recente primeiro
}

const publicAnnouncement = (a) => ({
  id: a.id, title: a.title, body: a.body, type: announcementType(a.type), createdAt: a.createdAt,
});

// O usuário vê os pop-ups pendentes (o client abre um de cada vez).
app.get('/api/announcements/pending', requireAuth, (req, res) => {
  res.json(pendingAnnouncementsFor(req.user).map(publicAnnouncement));
});

// Histórico do usuário, separado por tipo: o sino lê `notifications`, o botão de
// atualizações lê `updates`. Depois do pop-up, o anúncio "mora" no lugar do seu tipo.
app.get('/api/announcements/history', requireAuth, (req, res) => {
  const mine = announcementsFor(req.user).map(publicAnnouncement);
  res.json({
    notifications: mine.filter((a) => a.type === 'notification'),
    updates: mine.filter((a) => a.type === 'update'),
  });
});

// Confirmar que viu (fecha o pop-up). Marca no próprio usuário — não apaga o anúncio.
app.post('/api/announcements/:id/seen', requireAuth, async (req, res) => {
  await withFileLock('users.json', () => {
    const users = readJSON('users.json');
    const idx = users.findIndex((u) => u.id === req.user.id);
    if (idx === -1) return;
    const seen = new Set(Array.isArray(users[idx].seenAnnouncements) ? users[idx].seenAnnouncements : []);
    seen.add(req.params.id);
    users[idx].seenAnnouncements = [...seen];
    writeJSON('users.json', users);
  });
  res.json({ ok: true });
});

// --- Admin: CRUD dos anúncios ---
app.get('/api/admin/announcements', requireAuth, requireRole('admin'), (req, res) => {
  res.json(readAnnouncements());
});

app.post('/api/admin/announcements', requireAuth, requireRole('admin'), async (req, res) => {
  const title = clampStr(req.body && req.body.title, 200).trim();
  const body = clampStr(req.body && req.body.body, 4000).trim();
  if (!title) return res.status(400).json({ error: 'O título é obrigatório.', field: 'title' });
  if (!body) return res.status(400).json({ error: 'O texto é obrigatório.', field: 'body' });

  // Público: só papéis conhecidos; lista vazia = todos.
  const roles = Array.isArray(req.body.roles)
    ? req.body.roles.filter((r) => ANNOUNCEMENT_ROLES.includes(r))
    : [];

  const ann = {
    id: 'ann' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'),
    title, body, roles,
    type: announcementType(req.body && req.body.type),   // notification | update (demanda #12)
    active: true,
    createdAt: new Date().toISOString(),
    createdBy: req.user.username,
  };
  await withFileLock('announcements.json', () => {
    const all = readAnnouncements();
    all.push(ann);
    writeJSON('announcements.json', all);
  });
  res.json(ann);
});

// Despublicar / republicar (não apaga o histórico de quem já viu).
app.put('/api/admin/announcements/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const result = await withFileLock('announcements.json', () => {
    const all = readAnnouncements();
    const idx = all.findIndex((a) => a.id === req.params.id);
    if (idx === -1) return { status: 404, error: 'Anúncio não encontrado.' };
    if ('active' in (req.body || {})) all[idx].active = !!req.body.active;
    if ('title' in (req.body || {})) all[idx].title = clampStr(req.body.title, 200).trim() || all[idx].title;
    if ('body' in (req.body || {})) all[idx].body = clampStr(req.body.body, 4000).trim() || all[idx].body;
    if (Array.isArray(req.body.roles)) all[idx].roles = req.body.roles.filter((r) => ANNOUNCEMENT_ROLES.includes(r));
    if ('type' in (req.body || {})) all[idx].type = announcementType(req.body.type);
    writeJSON('announcements.json', all);
    return { ann: all[idx] };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.ann);
});

app.delete('/api/admin/announcements/:id', requireAuth, requireRole('admin'), async (req, res) => {
  await withFileLock('announcements.json', () => {
    writeJSON('announcements.json', readAnnouncements().filter((a) => a.id !== req.params.id));
  });
  res.json({ ok: true });
});

// =====================================================================
// PERSONAGENS — dois tipos: exercícios (trilha) e freeplay (simulação)
// =====================================================================
// O cliente (não-admin) recebe só metadados de exibição; specificInstruction,
// evaluationCriteria e evaluatorPrompt (gabaritos) NUNCA vão pro cliente — são
// resolvidos server-side em /api/chat e /api/evaluate.
function publicCharacter(c) {
  const { specificInstruction, evaluationCriteria, evaluatorPrompt, ...safe } = c;
  return safe;
}
// `allowStudent` / `allowVisitor`: quem pode atender este paciente (demanda #7).
const FREEPLAY_FIELDS = ['name', 'age', 'description', 'assistantId', 'specificInstruction', 'evaluationCriteria', 'allowStudent', 'allowVisitor'];
const EXERCISE_FIELDS = ['skillId', 'title', 'description', 'difficulty', 'specificInstruction', 'evaluatorPrompt'];
// Campos que são booleanos de verdade e precisam ser coeridos na ENTRADA — senão um
// `"false"` em texto entra cru no JSON e passa a valer `true` em qualquer checagem
// (foi exatamente o bug do bloqueio de paciente).
const BOOL_FIELDS = new Set(['allowStudent', 'allowVisitor']);
const coerceBool = (v) => !(v === false || v === 'false' || v === 0 || v === '0' || v === '' || v == null);

function pickFields(body, fields) {
  const out = {};
  for (const f of fields) {
    if (!body || !Object.prototype.hasOwnProperty.call(body, f)) continue;
    out[f] = BOOL_FIELDS.has(f) ? coerceBool(body[f]) : body[f];
  }
  return out;
}

// Fábrica de CRUD: os dois tipos têm exatamente a mesma forma de rota, mudando
// só o arquivo, o prefixo de id e os campos aceitos.
//
// `visibleTo(user, char)` (opcional) esconde da LISTAGEM o que o usuário não pode usar.
// É só UX: quem barra de verdade são os guards nas rotas que recebem um `itemId`.
function mountCharacterCrud(routePath, file, idPrefix, fields, decorate, visibleTo) {
  app.get(routePath, requireAuth, (req, res) => {
    const list = readJSON(file);
    // O admin vê tudo, inclusive o que está bloqueado — é ele quem libera.
    const visible = (visibleTo && !isAdmin(req.user))
      ? list.filter((c) => visibleTo(req.user, c))
      : list;
    const shaped = visible.map((c) => (isAdmin(req.user) ? c : publicCharacter(c)));
    res.json(decorate ? decorate(shaped) : shaped);
  });

  app.post(routePath, requireAuth, requireRole('admin'), async (req, res) => {
    const created = await withFileLock(file, () => {
      const chars = readJSON(file);
      const c = { id: idPrefix + Date.now() + '-' + crypto.randomBytes(3).toString('hex'), ...pickFields(req.body, fields) };
      chars.push(c);
      writeJSON(file, chars);
      return c;
    });
    res.json(created);
  });

  app.put(`${routePath}/:id`, requireAuth, requireRole('admin'), async (req, res) => {
    const result = await withFileLock(file, () => {
      const chars = readJSON(file);
      const idx = chars.findIndex((c) => c.id === req.params.id);
      if (idx === -1) return { status: 404, error: 'Personagem não encontrado' };
      chars[idx] = { ...chars[idx], ...pickFields(req.body, fields) };
      writeJSON(file, chars);
      return { char: chars[idx] };
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.char);
  });

  app.delete(`${routePath}/:id`, requireAuth, requireRole('admin'), async (req, res) => {
    await withFileLock(file, () => {
      writeJSON(file, readJSON(file).filter((c) => c.id !== req.params.id));
    });
    removePatientPhotoFiles(req.params.id);
    res.json({ ok: true });
  });
}

// Freeplay expõe, além dos metadados, a dificuldade dinâmica vinda do MMR.
function decorateFreeplayWithMmr(list) {
  const mmr = readJSON('mmr.json', { players: {}, characters: {} });
  return list.map((c) => {
    const ch = mmr.characters && mmr.characters[c.id];
    return {
      ...c,
      difficulty: mmrEngine.characterDifficulty(ch),
      competitiveMatches: (ch && Number.isFinite(ch.n)) ? ch.n : 0,
    };
  });
}

mountCharacterCrud('/api/freeplay', 'freeplay-characters.json', 'fp', FREEPLAY_FIELDS, decorateFreeplayWithMmr, canUsePatient);
mountCharacterCrud('/api/exercises', 'exercises.json', 'ex', EXERCISE_FIELDS, null);

// =====================================================================
// CRUD DE COMPETÊNCIAS (demandas #5a e #5b)
// =====================================================================

// Todo mundo lê: o SkillMap desenha o polígono a partir daqui (o número de lados vem do
// tamanho desta lista — não há mais pentágono hardcoded).
app.get('/api/skills', requireAuth, (req, res) => {
  const skills = readSkills();
  if (!isAdmin(req.user)) {
    // O aluno não precisa dos `criteria` — é material de avaliação, e vazá-lo entrega o
    // que a IA procura. Nome, cor e ordem bastam para desenhar a trilha.
    return res.json(skills.map(({ id, name, color }) => ({ id, name, color })));
  }
  const { counts, orphans } = exerciseCountBySkill();
  res.json(skills.map((sk) => ({ ...sk, exerciseCount: counts[String(sk.id)] || 0, orphans })));
});

app.post('/api/admin/skills', requireAuth, requireRole('admin'), async (req, res) => {
  // Os ids já USADOS por exercícios e logs entram na conta do próximo id: sem isso, apagar
  // uma competência e criar outra a faria nascer com o MESMO id, herdando os exercícios
  // órfãos da apagada — que voltariam à trilha ligados à competência errada.
  const usedIds = [
    ...readJSON('exercises.json', []).map((e) => e.skillId),
    ...readJSON('logs.json', []).map((l) => l.skillId),
  ].filter((v) => v != null);

  const result = await withFileLock('skills.json', () => {
    const skills = readSkills();
    const { skill, errors } = sanitizeSkill(req.body, {
      id: nextSkillId(skills, usedIds, skillIdFloor()),
    });
    if (errors.length) return { status: 400, error: errors[0].error, fields: errors };
    // Duas competências com o mesmo nome são indistinguíveis no SkillMap e nos logs — o
    // aluno vê dois vértices "Hermenêutica" e não sabe qual é qual.
    if (skillNameTaken(skills, skill.name)) {
      return { status: 409, field: 'name', error: 'Já existe uma competência com esse nome.' };
    }
    skills.push(skill);
    writeJSON('skills.json', skills);
    return { skill };
  });
  if (result.error) return res.status(result.status).json({ error: result.error, field: result.field, fields: result.fields });
  await bumpSkillIdFloor(result.skill.id);
  res.json(result.skill);
});

app.put('/api/admin/skills/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const result = await withFileLock('skills.json', () => {
    const skills = readSkills();
    const idx = skills.findIndex((s) => String(s.id) === String(req.params.id));
    if (idx === -1) return { status: 404, error: 'Competência não encontrada.' };

    // ⚠ MERGE, não replace — e isto corrige um BUG REAL de perda silenciosa de dado.
    // O `sanitizeSkill` trata campo ausente como `''`, então um PUT parcial (só nome e
    // cor, sem `criteria`) APAGAVA os critérios da competência. Nada falhava: o exercício
    // continuava rodando, o aluno continuava sendo avaliado — só que com o prompt do
    // paciente montado SEM os critérios. É o único campo do sistema cuja perda não emite
    // nenhum sinal.
    const base = { ...skills[idx], ...req.body };
    // O id é imutável: os exercícios e os logs apontam para ele.
    const { skill, errors } = sanitizeSkill(base, { id: skills[idx].id });
    if (errors.length) return { status: 400, error: errors[0].error, fields: errors };
    if (skillNameTaken(skills, skill.name, skill.id)) {
      return { status: 409, field: 'name', error: 'Já existe uma competência com esse nome.' };
    }
    skills[idx] = skill;
    writeJSON('skills.json', skills);
    return { skill };
  });
  if (result.error) return res.status(result.status).json({ error: result.error, field: result.field, fields: result.fields });
  res.json(result.skill);
});

// Reordenar: a ordem da lista é a ordem dos vértices no polígono do SkillMap.
app.post('/api/admin/skills/reorder', requireAuth, requireRole('admin'), async (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(String) : null;
  if (!ids) return res.status(400).json({ error: 'ids deve ser uma lista.' });

  // ⚠ BUG REAL corrigido aqui: sem a checagem de UNICIDADE, um `ids` como
  // ["1","1","1","1","1"] passava (o comprimento batia, e todos os ids existiam) e o
  // `writeJSON` gravava a MESMA competência cinco vezes — DESTRUINDO as outras quatro.
  // Todos os exercícios delas viravam órfãos, sem confirmação e sem aviso. Um bug no
  // drag-and-drop do client bastaria para disparar isso.
  if (new Set(ids).size !== ids.length) {
    return res.status(400).json({ error: 'A lista tem ids repetidos.' });
  }

  const result = await withFileLock('skills.json', () => {
    const skills = readSkills();
    if (ids.length !== skills.length) return { status: 400, error: 'A lista precisa conter todas as competências.' };
    const byId = new Map(skills.map((s) => [String(s.id), s]));
    const ordered = ids.map((id) => byId.get(id));
    if (ordered.some((s) => !s)) return { status: 400, error: 'Id desconhecido na lista.' };
    writeJSON('skills.json', ordered);
    return { skills: ordered };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.skills);
});

// DELETE — deixa os exercícios ÓRFÃOS (decisão D4: não bloqueia, não realoca).
//
// ⚠ Órfão NÃO é neutro, e é por isso que a rota informa quantos serão afetados:
//   • o exercício some da trilha (o SkillMap só desenha o que tem competência);
//   • o system prompt do paciente monta SEM os critérios daquela competência;
//   • os logs antigos continuam com o skillId apagado gravado.
// O client mostra isso na confirmação. `?confirm=1` é obrigatório — sem ele, a rota
// responde 409 com a contagem, para o admin não apagar às cegas.
app.delete('/api/admin/skills/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const skills = readSkills();
  const alvo = skills.find((s) => String(s.id) === String(req.params.id));
  if (!alvo) return res.status(404).json({ error: 'Competência não encontrada.' });

  const afetados = readJSON('exercises.json', []).filter((e) => String(e.skillId) === String(alvo.id));
  if (req.query.confirm !== '1') {
    return res.status(409).json({
      error: 'Confirmação necessária.',
      needsConfirm: true,
      skillName: alvo.name,
      orphanCount: afetados.length,
    });
  }

  // Antes de apagar, registra o id na marca d'água — é ESTE o momento em que ele corre o
  // risco de ser reciclado: some da lista viva e, se nenhum exercício o referenciava,
  // ninguém mais lembraria que ele existiu.
  await bumpSkillIdFloor(alvo.id);

  await withFileLock('skills.json', () => {
    writeJSON('skills.json', readSkills().filter((s) => String(s.id) !== String(req.params.id)));
  });
  res.json({ ok: true, orphanCount: afetados.length });
});

// Exercícios órfãos: apontam para uma competência que não existe mais (ou para nenhuma).
// Ficam invisíveis na trilha — esta rota é o que permite ao admin encontrá-los e
// reatribuí-los, em vez de eles sumirem em silêncio.
app.get('/api/admin/skills/orphans', requireAuth, requireRole('admin'), (req, res) => {
  const ids = new Set(readSkills().map((s) => String(s.id)));
  const orfaos = readJSON('exercises.json', [])
    .filter((e) => !ids.has(String(e.skillId)))
    .map((e) => ({ id: e.id, title: e.title, skillId: e.skillId ?? null }));
  res.json(orfaos);
});

// Progresso da trilha (exercícios concluídos por usuário).
app.get('/api/progress/:userId', requireAuth, (req, res) => {
  if (!canAccessUser(req.user, req.params.userId)) return res.status(403).json({ error: 'Acesso negado' });
  const all = readJSON('progress.json', {});
  res.json(all[req.params.userId] || {});
});
app.post('/api/progress/:userId', requireAuth, async (req, res) => {
  if (!canAccessUser(req.user, req.params.userId)) return res.status(403).json({ error: 'Acesso negado' });
  const saved = await withFileLock('progress.json', () => {
    const all = readJSON('progress.json', {});
    all[req.params.userId] = { ...(all[req.params.userId] || {}), ...(req.body || {}) };
    writeJSON('progress.json', all);
    return all[req.params.userId];
  });
  res.json(saved);
});

// IDs de personagem são gerados no servidor (ch<ts>-<hex>), mas validamos antes
// de qualquer operação de arquivo para blindar contra path traversal.
function isSafeId(id) { return typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id); }
function removePatientPhotoFiles(id) {
  if (!isSafeId(id)) return;
  for (const suf of ['-icon.jpg', '-full.jpg']) {
    try {
      const p = path.join(PATIENT_PHOTOS_DIR, id + suf);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {}
  }
}

// data:image/jpeg;base64,XXXX → Buffer (só imagem).
function decodeImageDataUrl(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return null;
  try { return Buffer.from(m[1], 'base64'); } catch { return null; }
}

// Foto do paciente. Só freeplay tem foto (exercícios são cenários, não pessoas).
app.put('/api/freeplay/:id/photo', requireAuth, requireRole('admin'), writeLimiter, async (req, res) => {
  // ⚠ O `isSafeId` vinha DEPOIS do `findIndex` e do parse da imagem — ou seja, só era
  // alcançável por um id que já casasse um personagem existente. Como os ids são gerados
  // pelo servidor, ele era inalcançável na prática, e o teste que "provava" a proteção
  // passava mesmo com o guard deletado (falsa confiança). Agora é a PRIMEIRA coisa: o id
  // vira nome de arquivo em `PATIENT_PHOTOS_DIR`, e um `../` ali escreve fora do diretório.
  if (!isSafeId(req.params.id)) return res.status(400).json({ error: 'ID inválido.' });

  const file = 'freeplay-characters.json';
  const result = await withFileLock(file, () => {
    const chars = readJSON(file);
    const idx = chars.findIndex((c) => c.id === req.params.id);
    if (idx === -1) return { status: 404, error: 'Personagem não encontrado' };

    if (req.body && req.body.clear) {
      removePatientPhotoFiles(req.params.id);
      delete chars[idx].photoIcon;
      delete chars[idx].photoFull;
      writeJSON(file, chars);
      return { char: chars[idx] };
    }
    const icon = decodeImageDataUrl(req.body && req.body.icon);
    const full = decodeImageDataUrl(req.body && req.body.full);
    if (!icon || !full) return { status: 400, error: 'Envie a foto (icon e full) como data URL de imagem.' };
    const MAX = 6 * 1024 * 1024;
    if (icon.length > MAX || full.length > MAX) return { status: 413, error: 'Imagem muito grande.' };
    try {
      fs.writeFileSync(path.join(PATIENT_PHOTOS_DIR, `${req.params.id}-icon.jpg`), icon);
      fs.writeFileSync(path.join(PATIENT_PHOTOS_DIR, `${req.params.id}-full.jpg`), full);
    } catch (err) {
      return { status: 500, error: 'Erro ao gravar a foto: ' + err.message };
    }
    const v = Date.now();
    chars[idx].photoIcon = `/patient-photos/${req.params.id}-icon.jpg?v=${v}`;
    chars[idx].photoFull = `/patient-photos/${req.params.id}-full.jpg?v=${v}`;
    writeJSON(file, chars);
    return { char: chars[idx] };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.char);
});

// =====================================================================
// LOGS
// =====================================================================
// TTL dos logs. DECISÃO DO USUÁRIO (2026-07-14): os logs NÃO expiram mais — ficam no
// volume (/data) até o admin apagar na mão. `0` (o padrão) = nunca expira; a infraestrutura
// do prune fica viva atrás da env `LOG_TTL_DAYS`, então dá para religar sem redeploy de
// código se um dia a decisão mudar.
//
// ⚠ Consequência aceita: sem TTL, o logs.json cresce para sempre. O arquivo é lido e
// reescrito INTEIRO a cada log salvo — ~147 ms de event loop bloqueado com 14 MB. O próximo
// teto de escala do projeto passa a ser este arquivo (a saída definitiva é migrar para
// SQLite). Apagar no /data alivia, não resolve.
const LOG_TTL_DAYS = (() => {
  const raw = process.env.LOG_TTL_DAYS;
  if (raw === undefined || raw === '') return 0;   // padrão: desligado
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
})();
const LOG_TTL_MS = LOG_TTL_DAYS * 24 * 60 * 60 * 1000;
const LOG_MAX_MESSAGES = 500;
const LOG_MAX_MESSAGE_LEN = 20000;
const LOG_MAX_EVAL_LEN = 50000;
const LOG_MAX_TITLE = 200;
// Tipos de sessão registráveis. (Neuro do All_OS NÃO é portado.)
const LOG_VALID_TYPES = ['exercise', 'freeplay'];

function clampStr(v, max) { return v == null ? '' : String(v).slice(0, max); }

// Competência (1..5) do exercício. `Number(null)`, `Number('')` e `Number([])`
// valem 0 — um `Number.isFinite(Number(v))` ingênuo gravaria a competência 0, que
// não existe. Aceita número ou string numérica; qualquer outra coisa vira null.
function normalizeSkillId(v) {
  if (typeof v === 'string' && v.trim() === '') return null;
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function logExpiresAt(log) {
  if (LOG_TTL_DAYS === 0) return null;   // TTL desligado: o log não tem data de expiração
  const t = new Date(log.timestamp || 0).getTime();
  if (!Number.isFinite(t) || t === 0) return null;
  return new Date(t + LOG_TTL_MS).toISOString();
}
function pruneExpiredLogs() {
  if (LOG_TTL_DAYS === 0) return 0;      // TTL desligado: nada é apagado automaticamente
  let logs;
  try { logs = readJSON('logs.json'); } catch { return 0; }
  if (!Array.isArray(logs) || logs.length === 0) return 0;
  const cutoff = Date.now() - LOG_TTL_MS;
  const kept = logs.filter((l) => {
    const t = new Date(l.timestamp || 0).getTime();
    if (!Number.isFinite(t) || t === 0) return true;
    return t >= cutoff;
  });
  if (kept.length === logs.length) return 0;
  writeJSON('logs.json', kept);
  return logs.length - kept.length;
}
function decorateLogs(arr) { return arr.map((l) => ({ ...l, expiresAt: logExpiresAt(l) })); }

app.get('/api/logs', requireAuth, (req, res) => {
  pruneExpiredLogs();
  const logs = readJSON('logs.json');
  // criteriaScores é só para professor/admin (o aluno não recebe o gabarito de notas).
  const serve = (arr) => {
    const decorated = decorateLogs(arr);
    if (canSeeAllLogs(req.user)) return decorated;
    return decorated.map(({ criteriaScores, ...rest }) => rest);
  };
  // Deny-by-default: quem não é professor/admin só enxerga os próprios logs.
  // (Aluno e visitante caem aqui — antes o visitante escapava do filtro de
  // 'therapist' e recebia os logs de todo mundo.)
  if (!canSeeAllLogs(req.user)) {
    return res.json(serve(logs.filter((l) => l.userId === req.user.id)));
  }
  // Filtro por userId específico (admin/professor abrindo um aluno). O professor
  // só alcança alunos vinculados a ele — mesma regra de canAccessUser.
  if (req.query.userId) {
    if (!canAccessUser(req.user, req.query.userId)) return res.status(403).json({ error: 'Acesso negado' });
    return res.json(serve(logs.filter((l) => l.userId === req.query.userId)));
  }
  // Admin vê tudo; professor, só os logs dos seus alunos (e os próprios).
  if (isAdmin(req.user)) return res.json(serve(logs));
  const mine = new Set(
    readJSON('users.json')
      .filter((u) => u.teacherId === req.user.id)
      .map((u) => u.id),
  );
  mine.add(req.user.id);
  res.json(serve(logs.filter((l) => mine.has(l.userId))));
});

app.get('/api/logs/policy', requireAuth, (req, res) => res.json({ ttlDays: LOG_TTL_DAYS }));

app.post('/api/logs', requireAuth, writeLimiter, async (req, res) => {
  const body = req.body || {};
  if (!LOG_VALID_TYPES.includes(body.type)) {
    return res.status(400).json({ error: 'type inválido (exercise|freeplay)' });
  }
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  if (rawMessages.length > LOG_MAX_MESSAGES) return res.status(400).json({ error: `messages excede limite de ${LOG_MAX_MESSAGES}` });
  const cleanMessages = rawMessages.map((m) => ({
    role: m && (m.role === 'user' || m.role === 'assistant') ? m.role : 'user',
    content: clampStr(m && m.content, LOG_MAX_MESSAGE_LEN),
    highlighted: !!(m && m.highlighted),
    comment: clampStr(m && m.comment, 2000),
  }));

  // Rede de segurança: se o cliente mandar a avaliação com o bloco
  // `[notas-supervisor]` ainda colado no texto, ele é separado AQUI. Sem isso o
  // gabarito de notas ficaria salvo em texto puro no log e voltaria para o
  // próprio aluno em GET /api/logs (que só remove o campo `criteriaScores`).
  const { clean: noNotes, criteria: supervisorCriteria } = extractSupervisorNotes(body.evaluation);
  // Idem para o `[NOTA:X]` dos avaliadores customizados: se sobrar no texto, some
  // daqui e, na falta de `score` no body, vira a nota do log.
  const { clean: cleanEvaluation, score: inlineScore } = extractFinalScore(noNotes);

  const explicitCriteria = (body.criteriaScores && typeof body.criteriaScores === 'object') ? body.criteriaScores : null;

  // ⚠ O `score` VEM DO CLIENTE e alimenta o MMR, o `bestScore` e as conquistas. Sem
  // limite, um `{score: 999999}` via DevTools destruía a média do aluno, desbloqueava
  // `high_score` de graça e entrava no ranking. O `mmr.js` clampa internamente, mas a
  // gamificação não clampava nada. A faixa do sistema é 0–100 (freeplay); exercício usa
  // 0–10, que cabe dentro. Um score fora da faixa é o próprio cliente mentindo.
  const clampScore = (v) => (Number.isFinite(v) ? Math.min(100, Math.max(0, Number(v))) : null);
  let finalScore = clampScore(body.score);
  // Nota derivada das notas por critério (a IA não faz a conta; ver scoring.js).
  // `criteriaScores` explícito no body tem prioridade sobre o bloco extraído.
  if (finalScore === null) {
    // Também clampado: um critério com nota absurda (a IA escorregando, ou o parser
    // pescando um número da prosa) produzia notas como 117/100, que iam para o ranking.
    const computed = clampScore(finalScoreFromCriteria(explicitCriteria || supervisorCriteria));
    if (computed !== null) finalScore = computed;
    else if (inlineScore !== null) finalScore = clampScore(inlineScore);
  }

  // mode só é significativo para freeplay: 'competitive' alimenta o MMR.
  const mode = body.mode === 'competitive' ? 'competitive' : 'training';

  // Dificuldade e competência do exercício, resolvidas server-side a partir do
  // `exercises.json` — o cliente não decide nenhuma das duas. `difficulty`
  // alimenta a conquista 'all_difficulties'; `skillId` diz qual competência a
  // sessão treinou (relatórios por competência).
  // (O All_OS confia no `body.skillId` enviado pelo cliente; aqui não.)
  let difficulty = null;
  let skillId = null;
  if (body.type === 'exercise' && body.itemId) {
    const ex = readJSON('exercises.json').find((e) => String(e.id) === String(body.itemId));
    if (ex) {
      if (ex.difficulty) difficulty = String(ex.difficulty);
      skillId = normalizeSkillId(ex.skillId);
    }
  }

  const log = {
    id: 'log' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'),
    timestamp: new Date().toISOString(),
    type: body.type,
    mode,
    difficulty,
    skillId,
    itemId: clampStr(body.itemId, 200),
    itemTitle: clampStr(body.itemTitle, LOG_MAX_TITLE),
    durationSeconds: Number.isFinite(body.durationSeconds) ? Math.max(0, Math.floor(body.durationSeconds)) : 0,
    sessionCount: Number.isFinite(body.sessionCount) ? Math.max(1, Math.floor(body.sessionCount)) : 1,
    score: finalScore,
    criteriaScores: explicitCriteria || supervisorCriteria || null,
    // Rede de segurança: se o texto salvo trouxer uma "Nota: X" divergente do `score` que o
    // código calculou, ela é reescrita aqui também. Senão o log ficaria com a contradição
    // gravada para sempre — o selo mostrando um número e a devolutiva, outro.
    evaluation: clampStr(syncDisplayedScore(cleanEvaluation, finalScore), LOG_MAX_EVAL_LEN),
    messages: cleanMessages,
    userId: req.user.id,
    userName: req.user.name,
  };
  await withFileLock('logs.json', () => {
    const logs = readJSON('logs.json');
    logs.push(log);
    writeJSON('logs.json', logs);
  });

  // Partida ranqueada: só freeplay competitivo, com nota numérica. O visitante
  // TAMBÉM pontua (demanda #2) — o que o separa do aluno é o ranking em que ele
  // aparece (D3), não o direito de pontuar. O resultado volta no corpo da resposta
  // (`mmr`) para a sessão exibir o card de pós-partida; se o cálculo falhar, o log
  // já está salvo e `mmr` fica ausente.
  //
  // Paciente bloqueado (demanda #7) NÃO pontua. Repare que o log em si **é salvo**: se o
  // admin bloquear no meio de uma sessão já em andamento, o aluno não pode perder o
  // trabalho que já fez. O que ele não leva é o MMR de um paciente que não deveria estar
  // atendendo. (O `/api/chat` já barra o início de qualquer sessão nova.)
  const patientOk = log.type !== 'freeplay' || canUsePatient(
    req.user,
    readJSON('freeplay-characters.json').find((c) => String(c.id) === String(log.itemId)),
  );

  let mmrResult = null;
  if (mode === 'competitive' && log.type === 'freeplay' && Number.isFinite(finalScore) && patientOk) {
    try {
      mmrResult = await withFileLock('mmr.json', () => {
        const store = readJSON('mmr.json', { players: {}, characters: {} });
        const player = store.players[req.user.id] || mmrEngine.newPlayer();
        const character = store.characters[log.itemId] || mmrEngine.newCharacter();
        const out = mmrEngine.updateMatch(player, character, finalScore);
        store.players[req.user.id] = out.player;
        store.characters[log.itemId] = out.character;
        writeJSON('mmr.json', store);
        // Durante a calibração o MMR fica oculto (playerView devolve mmr: null),
        // então o delta também não é exibível.
        return {
          ...mmrEngine.playerView(out.player),
          delta: out.result.calibrating ? null : Math.round(out.result.delta),
          characterDifficulty: mmrEngine.characterDifficulty(out.character),
        };
      });
    } catch (err) {
      console.error('Erro ao atualizar MMR:', err.message);
    }
  }

  res.json({ ...log, expiresAt: logExpiresAt(log), ...(mmrResult ? { mmr: mmrResult } : {}) });
});

app.delete('/api/logs/:id', requireAuth, requireRole('admin'), async (req, res) => {
  await withFileLock('logs.json', () => {
    const logs = readJSON('logs.json').filter((l) => l.id !== req.params.id);
    writeJSON('logs.json', logs);
  });
  res.json({ ok: true });
});

// =====================================================================
// SESSÕES ATIVAS (persistência de sessão não finalizada)
// =====================================================================
const VALID_SESSION_TYPES = ['exercise', 'freeplay'];
function activeSessionKey(userId, type, itemId) { return `${userId}__${type}__${itemId}`; }
function readActiveSessions() { return readJSON('active-sessions.json', {}); }

app.get('/api/active-sessions', requireAuth, (req, res) => {
  const all = readActiveSessions();
  const freeplay = readJSON('freeplay-characters.json');

  // Demanda #7: uma sessão em andamento de um paciente que o admin BLOQUEOU não aparece
  // mais na lista. Sem isto, o aluno via o card "sessão em andamento", clicava, e levava
  // 403 no primeiro turno (o `/api/chat` barra) — um beco sem saída.
  //
  // ⚠ O autosave (PUT) continua permitido de propósito: se o bloqueio acontecer no meio de
  // uma sessão, o aluno não pode perder o que já escreveu. É a mesma escolha do
  // `POST /api/logs`, que salva o log mas não pontua.
  const visivel = (s) => {
    if (s.type !== 'freeplay') return true;
    const c = freeplay.find((x) => String(x.id) === String(s.itemId));
    return canUsePatient(req.user, c);
  };

  res.json(Object.values(all).filter((s) => s.userId === req.user.id && visivel(s)));
});
app.get('/api/active-sessions/:type/:itemId', requireAuth, (req, res) => {
  const { type, itemId } = req.params;
  if (!VALID_SESSION_TYPES.includes(type)) return res.status(400).json({ error: 'Tipo de sessão inválido' });
  const all = readActiveSessions();
  res.json(all[activeSessionKey(req.user.id, type, itemId)] || null);
});
app.put('/api/active-sessions/:type/:itemId', requireAuth, async (req, res) => {
  const { type, itemId } = req.params;
  if (!VALID_SESSION_TYPES.includes(type)) return res.status(400).json({ error: 'Tipo de sessão inválido' });
  const body = req.body || {};
  const saved = await withFileLock('active-sessions.json', () => {
    const all = readActiveSessions();
    const key = activeSessionKey(req.user.id, type, itemId);
    all[key] = {
      userId: req.user.id, type, itemId,
      messages: Array.isArray(body.messages) ? body.messages : [],
      elapsedSeconds: Number.isFinite(body.elapsedSeconds) ? Math.max(0, Math.floor(body.elapsedSeconds)) : 0,
      itemTitle: body.itemTitle || '',
      sessionNumber: Number.isFinite(body.sessionNumber) ? body.sessionNumber : 1,
      lastSavedAt: new Date().toISOString(),
    };
    writeJSON('active-sessions.json', all);
    return all[key];
  });
  res.json(saved);
});
app.delete('/api/active-sessions/:type/:itemId', requireAuth, async (req, res) => {
  const { type, itemId } = req.params;
  if (!VALID_SESSION_TYPES.includes(type)) return res.status(400).json({ error: 'Tipo de sessão inválido' });
  await withFileLock('active-sessions.json', () => {
    const all = readActiveSessions();
    const key = activeSessionKey(req.user.id, type, itemId);
    if (key in all) { delete all[key]; writeJSON('active-sessions.json', all); }
  });
  res.json({ ok: true });
});

// =====================================================================
// IA — SIMULAÇÃO (paciente), AVALIAÇÃO (estrutura pronta) e WHISPER
// =====================================================================
const PATIENT_MODEL = process.env.OPENAI_PATIENT_MODEL || 'gpt-4o-mini';
const PATIENT_EFFORT = process.env.OPENAI_PATIENT_EFFORT || 'none';
const EVAL_MODEL = process.env.OPENAI_EVAL_MODEL || 'gpt-4o';
const WHISPER_MODEL = process.env.OPENAI_WHISPER_MODEL || 'whisper-1';
// O entrevistador gera o prompt do paciente: tarefa longa e nuançada, pede um
// modelo mais forte e um teto de saída bem maior que o do paciente.
const ENTREVISTADOR_MODEL = process.env.OPENAI_ENTREVISTADOR_MODEL || EVAL_MODEL;
const ENTREVISTADOR_EFFORT = process.env.OPENAI_ENTREVISTADOR_EFFORT || 'medium';
const ENTREVISTADOR_MAX_TOKENS = 16000;

function getOpenAI() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const OpenAI = require('openai').OpenAI || require('openai').default || require('openai');
  return new OpenAI({ apiKey });
}
// Modelos de reasoning (o-series / gpt-5.x) usam max_completion_tokens e não
// aceitam temperature; os demais (gpt-4o etc.) usam max_tokens. Detecta pelo nome.
function isReasoningModel(model) {
  return /^(o\d|gpt-5)/i.test(String(model || ''));
}
async function openaiChat({ openai, model, systemPrompt, messages, maxTokens, effort }) {
  const turns = (messages || [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : String(m.content || '') }))
    .filter((m) => m.content);
  const params = { model, messages: [{ role: 'system', content: systemPrompt }, ...turns] };
  if (isReasoningModel(model)) {
    params.max_completion_tokens = maxTokens;
    if (effort && effort !== 'none') params.reasoning_effort = effort;
  } else {
    params.max_tokens = maxTokens;
    params.temperature = 0.8;
  }
  const resp = await openai.chat.completions.create(params);
  return resp.choices?.[0]?.message?.content || '';
}

// Prompt do entrevistador (construção de personagem). IP da Allos: só admin lê.
const ENTREVISTADOR_DIR = path.join(__dirname, 'entrevistador');
function loadEntrevistadorPrompt() {
  const p = path.join(ENTREVISTADOR_DIR, 'promptentrevistador.md');
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf-8');
}

// Resolve o system prompt do paciente server-side (nunca confia no cliente).
// Dois tipos: 'exercise' usa o prompt da trilha (com skillId); 'freeplay' usa o
// prompt de simulação livre.
// `user` serve ao gate da demanda #7: é AQUI que o bloqueio de paciente vale de verdade.
// Esconder o card na listagem não impede um POST /api/chat com o itemId na mão.
function resolveChatPrompt(type, itemId, user) {
  if (type === 'exercise') {
    const e = readJSON('exercises.json').find((x) => String(x.id) === String(itemId));
    if (!e) return { status: 404, error: 'Exercício não encontrado' };
    return { systemPrompt: buildExercisePrompt(skillCriteriaFor(e.skillId), e.specificInstruction), character: e };
  }
  const c = readJSON('freeplay-characters.json').find((x) => String(x.id) === String(itemId));
  if (!c) return { status: 404, error: 'Personagem não encontrado' };
  if (!canUsePatient(user, c)) return { status: 403, patientLocked: true, error: 'Este paciente não está liberado para o seu perfil.' };
  return { systemPrompt: buildFreeplayPrompt(c.specificInstruction), character: c };
}

app.post('/api/chat', requireAuth, aiLimiter, async (req, res) => {
  const { messages, context, mode } = req.body || {};

  // O system prompt é SEMPRE resolvido no servidor. Rejeita explicitamente para
  // que um cliente antigo que ainda mande o campo falhe alto, e não silenciosamente.
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'systemPrompt')) {
    return res.status(400).json({ error: 'systemPrompt não é aceito no body. Use context: { type, itemId } ou mode.' });
  }
  if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages deve ser uma lista' });

  const isEntrevistador = mode === 'entrevistador';

  // Entrevistador: prompt próprio, admin-only. Não usa context.
  let systemPrompt;
  if (isEntrevistador) {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Acesso negado' });
    systemPrompt = loadEntrevistadorPrompt();
    if (!systemPrompt) return res.status(500).json({ error: 'Prompt do entrevistador não configurado.' });
  } else {
    if (!context || typeof context !== 'object' || !context.itemId) {
      return res.status(400).json({ error: 'context é obrigatório (type + itemId)' });
    }
    const resolved = resolveChatPrompt(context.type, context.itemId, req.user);
    if (resolved.error) {
      const body = { error: resolved.error };
      if (resolved.patientLocked) body.patientLocked = true;
      return res.status(resolved.status).json(body);
    }
    systemPrompt = resolved.systemPrompt;
  }

  const openai = getOpenAI();
  if (!openai) {
    return res.json({
      role: 'assistant',
      content: isEntrevistador
        ? '[Modo demonstração — OPENAI_API_KEY não configurada] Não é possível conduzir a entrevista sem a chave da OpenAI.'
        : '[Modo demonstração — OPENAI_API_KEY não configurada] Olá, obrigado por me receber. Podemos começar quando você quiser.',
    });
  }
  const validTurns = (messages || []).filter((m) => m && (m.role === 'user' || m.role === 'assistant') && (typeof m.content === 'string' ? m.content : String(m.content || '')));
  if (!validTurns.length) return res.status(400).json({ error: 'messages não contém turnos válidos (user/assistant)' });

  try {
    const content = await openaiChat({
      openai,
      model: isEntrevistador ? ENTREVISTADOR_MODEL : PATIENT_MODEL,
      systemPrompt,
      messages,
      maxTokens: isEntrevistador ? ENTREVISTADOR_MAX_TOKENS : 1200,
      effort: isEntrevistador ? ENTREVISTADOR_EFFORT : PATIENT_EFFORT,
    });
    res.json({ role: 'assistant', content });
  } catch (err) {
    console.error(`OpenAI ${isEntrevistador ? 'entrevistador' : 'paciente'} error:`, err.message);
    res.status(500).json({ error: 'Erro ao comunicar com a IA: ' + err.message });
  }
});

// --- AVALIAÇÃO (DESLIGADA por padrão) ---
// Para ligar: EVALUATOR_ENABLED=true no primeiro boot (semeia settings.json) ou
// o toggle na tela de Contas. O modelo vem de OPENAI_EVAL_MODEL.
// O fluxo de log (POST /api/logs) e o contexto do gabarito (evaluationCriteria,
// injetado server-side) já estão prontos — nada mais precisa mudar no cliente.
const AVALIACAO_DIR = path.join(__dirname, 'avaliacao');
// Prompt do avaliador de sessão. `avaliador.md` é um override opcional; o padrão
// é o mesmo arquivo versionado que o All_OS usa (avaliador-v16-2.md).
const EVALUATOR_PROMPT_FILES = ['avaliador.md', 'avaliador-v16-2.md'];
function loadEvaluatorPrompt() {
  for (const name of EVALUATOR_PROMPT_FILES) {
    const content = loadPromptFile(name);
    if (content) return content;
  }
  return null;
}
function evaluatorEnabled() {
  const s = readJSON('settings.json', {});
  return !!s.evaluatorEnabled;
}
// Gabarito do caso (freeplay): critério de correção injetado na mensagem do
// avaliador, server-side. Nunca vai ao cliente.
//
// Exercício NÃO tem gabarito: o `evaluatorPrompt` dele é um AVALIADOR próprio
// (ver resolveEvaluatorPrompt), não um critério de correção.
function resolveEvaluationCriteria(type, itemId) {
  if (type === 'exercise') return '';
  const c = readJSON('freeplay-characters.json').find((x) => String(x.id) === String(itemId));
  return c && c.evaluationCriteria && String(c.evaluationCriteria).trim() ? String(c.evaluationCriteria).trim() : '';
}

/**
 * System prompt da avaliação. Um exercício da trilha pode ter avaliador próprio
 * (`evaluatorPrompt`); os demais casos usam o avaliador global.
 * Retorna `{ systemPrompt, custom }` ou `{ error }` se nenhum prompt resolver.
 */
function resolveEvaluatorPrompt(context) {
  if (context && context.type === 'exercise' && context.itemId) {
    const e = readJSON('exercises.json').find((x) => String(x.id) === String(context.itemId));
    if (e && e.evaluatorPrompt && String(e.evaluatorPrompt).trim()) {
      return { systemPrompt: wrapCustomEvaluatorPrompt(e.evaluatorPrompt), custom: true };
    }
  }
  const global = loadEvaluatorPrompt();
  if (!global) {
    return { error: `Avaliação ligada mas o prompt do avaliador não foi encontrado (server/avaliacao/${EVALUATOR_PROMPT_FILES.join(' ou ')}).` };
  }
  return { systemPrompt: global, custom: false };
}

app.post('/api/evaluate', requireAuth, aiLimiter, async (req, res) => {
  const { messages, context } = req.body || {};
  if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages deve ser uma lista' });
  if (!evaluatorEnabled()) {
    // Estrutura pronta, avaliador desligado — o cliente encerra com o
    // agradecimento e o log é salvo para análise humana.
    return res.json({ role: 'assistant', content: '', disabled: true });
  }
  // A avaliação virou uma feature da matriz (demanda #4) — o antigo
  // `visitorEvaluationEnabled` é hoje `featureAccess.avaliacao.visitante`.
  //
  // ⚠ Aqui NÃO usamos `requireFeature`: a avaliação desligada responde `{disabled:true}`
  // com 200, e o cliente conta com isso para encerrar a sessão com o agradecimento. Um
  // 403 quebraria o fim da sessão — o bloqueio é de FEEDBACK, não de acesso à tela.
  if (!canUseFeature(readFeatureAccess(), req.user, 'avaliacao')) {
    return res.json({ role: 'assistant', content: '', disabled: true });
  }
  const openai = getOpenAI();
  if (!openai) return res.status(503).json({ error: 'Avaliação indisponível: OPENAI_API_KEY não configurada.' });
  // Exercício com avaliador próprio usa o dele; o resto, o avaliador global.
  const resolved = resolveEvaluatorPrompt(context);
  if (resolved.error) return res.status(500).json({ error: resolved.error });
  const systemPrompt = resolved.systemPrompt;

  // Injeta o gabarito (evaluationCriteria) ANTES do log, server-side.
  let finalMessages = messages;
  if (context && context.itemId) {
    const gabarito = resolveEvaluationCriteria(context.type, context.itemId);
    if (gabarito) {
      const idx = messages.findIndex((m) => m && m.role === 'user');
      if (idx !== -1) {
        const prefix = `[GABARITO DO CASO] (critério de correção — não revelar ao aluno)\n${gabarito}\n\n---\n\n`;
        finalMessages = [...messages.slice(0, idx), { ...messages[idx], content: prefix + (messages[idx].content || '') }, ...messages.slice(idx + 1)];
      }
    }
  }
  try {
    const raw = await openaiChat({ openai, model: EVAL_MODEL, systemPrompt, messages: finalMessages, maxTokens: 4000, effort: process.env.OPENAI_EVAL_EFFORT || 'medium' });

    // Duas famílias de avaliador, dois formatos de nota — mas UMA escala: 0–100.
    //  - customizado (exercício): emite `[NOTA:X]`, já convertido para 0–100 pelo wrapper.
    //  - global: emite o bloco `[notas-supervisor]` e a nota sai do scoring.js (0–100).
    // Em ambos os casos o marcador é removido do texto que o aluno recebe.
    let payload;
    if (resolved.custom) {
      const { clean, score } = extractFinalScore(raw);

      // ⚠ NÃO auto-convertemos uma nota baixa para 0–100, por mais tentador que seja.
      // Um `[NOTA:7]` é ambíguo: pode ser um "7/10" que a IA esqueceu de converter, ou um
      // 7/100 legítimo (sessão péssima). Multiplicar por 10 na dúvida transformaria a nota
      // de um aluno que foi mal num 70 — silenciosamente, e a favor dele. Preferimos
      // registrar o que veio e GRITAR no log: um avaliador mal-comportado se detecta pelo
      // aviso, não por notas erradas em produção.
      if (score !== null && score > 0 && score <= 10) {
        console.warn(
          `[avaliador] ${context && context.itemId}: [NOTA:${score}] parece estar na escala 0–10, `
          + 'não em 0–100. A nota foi registrada como veio. Se isso se repetir, revise o prompt '
          + 'do avaliador deste exercício (ele deve converter a nota final para 0–100).',
        );
      }

      payload = { role: 'assistant', content: clean, score };
    } else {
      const { clean, criteria } = extractSupervisorNotes(raw);
      const score = finalScoreFromCriteria(criteria);

      // ⚠ O avaliador global pede à IA que escreva "**Nota: X/100**" como primeira linha da
      // devolutiva. Mas quem calcula a nota de verdade é o CÓDIGO, a partir das notas por
      // critério (`scoring.js`) — de propósito, porque a IA erra a conta. E erra mesmo:
      // numa sessão real, os critérios somavam 54 e ela escreveu "67/100" no texto.
      //
      // Resultado: o selo mostrava 54 e a devolutiva dizia 67 — dois números para a mesma
      // sessão, o mesmo defeito que a padronização 0–100 existe para eliminar. Aqui a linha
      // que a IA escreveu é REESCRITA com a nota real. Ela continua ditando o formato; a
      // aritmética é nossa.
      payload = { role: 'assistant', content: syncDisplayedScore(clean, score), score };
      if (canSeeAllLogs(req.user)) payload.criteriaScores = criteria;
    }
    if (canSeeAllLogs(req.user)) payload.reasoning = raw;
    res.json(payload);
  } catch (err) {
    console.error('OpenAI avaliador error:', err.message);
    res.status(500).json({ error: 'Erro ao avaliar a sessão: ' + err.message });
  }
});

// --- WHISPER (transcrição de áudio) ---
app.post('/api/transcribe', requireAuth, aiLimiter, async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.json({ text: '[Transcrição indisponível sem OPENAI_API_KEY]' });
  const tmpFile = path.join(DATA_DIR, `tmp_audio_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.webm`);
  try {
    const OpenAI = require('openai').OpenAI || require('openai').default || require('openai');
    const openai = new OpenAI({ apiKey });
    const buffer = Buffer.from(req.body.audio || '', 'base64');
    fs.writeFileSync(tmpFile, buffer);
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpFile),
      model: WHISPER_MODEL,
      language: 'pt',
    });
    res.json({ text: transcription.text });
  } catch (err) {
    console.error('Transcription error:', err.message);
    res.status(500).json({ error: 'Erro na transcrição' });
  } finally {
    try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch {}
  }
});

// =====================================================================
// CONFIGURAÇÕES
// =====================================================================
// O client monta a sidebar (e o cadeado da demanda #3) a partir daqui. Mandamos o
// CATÁLOGO junto com a matriz para ele não precisar hardcodar as chaves nem os rótulos.
app.get('/api/settings', requireAuth, (req, res) => {
  const s = readJSON('settings.json', {});
  res.json({
    evaluatorEnabled: !!s.evaluatorEnabled,
    lockedFeatureMessage: lockedFeatureMessage(),
    featureAccess: readFeatureAccess(),
    features: FEATURES.map(({ key, label, description }) => ({ key, label, description })),
    featureRoles: FEATURE_ROLES,
    // Demanda #8: o catálogo de durações + o padrão vigente (o client escolhe daqui).
    visitorDurations: VISITOR_DURATIONS.map(({ key, label }) => ({ key, label })),
    visitorAccessDuration: defaultVisitorDurationKey(),
    // A feature do usuário LOGADO, já resolvida: o client não recalcula a regra.
    myFeatures: myFeatureMap(req.user),
  });
});

app.put('/api/admin/settings', requireAuth, requireRole('admin'), async (req, res) => {
  const saved = await withFileLock('settings.json', () => {
    const s = readJSON('settings.json', {});
    if ('evaluatorEnabled' in (req.body || {})) s.evaluatorEnabled = !!req.body.evaluatorEnabled;
    if ('lockedFeatureMessage' in (req.body || {})) {
      s.lockedFeatureMessage = clampStr(req.body.lockedFeatureMessage, 600);
    }
    // Demanda #8 / D8: mudar o padrão afeta só os visitantes NOVOS. Ninguém que já tem
    // `accessExpiresAt` é recalculado — o prazo dele foi combinado no cadastro.
    if ('visitorAccessDuration' in (req.body || {}) && visitorDuration(req.body.visitorAccessDuration)) {
      s.visitorAccessDuration = req.body.visitorAccessDuration;
    }
    // Merge por chave: mandar só `{featureAccess:{duelo:{visitante:false}}}` não zera o resto.
    if (req.body && typeof req.body.featureAccess === 'object' && req.body.featureAccess) {
      const cur = normalizeFeatureAccess(s.featureAccess);
      for (const [key, row] of Object.entries(req.body.featureAccess)) {
        if (!cur[key] || !row || typeof row !== 'object') continue;   // chave desconhecida: ignora
        for (const role of FEATURE_ROLES) {
          if (role in row) cur[key][role] = !!row[role];
        }
      }
      s.featureAccess = cur;
    }
    writeJSON('settings.json', s);
    return s;
  });
  res.json({
    evaluatorEnabled: !!saved.evaluatorEnabled,
    lockedFeatureMessage: lockedFeatureMessage(),
    featureAccess: normalizeFeatureAccess(saved.featureAccess),
    visitorAccessDuration: defaultVisitorDurationKey(),
  });
});

// --- Acesso do visitante: bloquear / renovar (demanda #8) ---
//
// D8: ao RENOVAR, o visitante recebe a duração padrão VIGENTE — não a que valia quando ele
// se cadastrou. Ele "renasce" com a regra atual.
app.post('/api/admin/users/:id/visitor-access', requireAuth, requireRole('admin'), async (req, res) => {
  const action = req.body && req.body.action;
  if (!['renew', 'block'].includes(action)) {
    return res.status(400).json({ error: 'action deve ser "renew" ou "block".' });
  }

  const result = await withFileLock('users.json', () => {
    const users = readJSON('users.json');
    const idx = users.findIndex((u) => u.id === req.params.id);
    if (idx === -1) return { status: 404, error: 'Usuário não encontrado' };
    if (users[idx].role !== 'visitor') {
      return { status: 400, error: 'Só o acesso de visitante tem prazo.' };
    }

    if (action === 'block') {
      users[idx].blocked = true;
    } else {
      users[idx].blocked = false;
      users[idx].accessExpiresAt = newVisitorExpiry();  // duração padrão VIGENTE (D8)
    }
    writeJSON('users.json', users);
    return { user: users[idx] };
  });

  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(publicUser(result.user));
});

// =====================================================================
// HELPERS DE AVALIAÇÃO (usados por duelo e progressão)
// =====================================================================
// Os avaliadores emitem, ao fim do texto, um bloco [notas-supervisor] com as
// notas por critério. O texto limpo vai ao aluno; as notas ficam server-side.
/**
 * É uma chave de critério legítima?
 *   - `1`..`10`  → avaliador de sessão (10 critérios)
 *   - `A1`..`A6` / `B1`..`B6` → avaliador comparativo do duelo (6 critérios por lado)
 *
 * Sem essa allowlist, qualquer "palavra: número" na prosa do modelo virava critério.
 */
function isCriterionKey(k) {
  const s = String(k).trim().toUpperCase();
  if (/^([1-9]|10)$/.test(s)) return true;         // 1..10
  if (/^[AB][1-6]$/.test(s)) return true;          // A1..B6
  return false;
}

function parseSupervisorPayload(payload) {
  if (!payload) return null;
  try {
    const obj = JSON.parse(payload);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        if (!isCriterionKey(k)) continue;
        const n = toScore(v);
        if (n !== null) out[String(k).toUpperCase()] = n;
      }
      if (Object.keys(out).length) return out;
    }
  } catch {}
  let text = payload;
  if (!payload.includes(':') && /^[A-Za-z0-9+/=\s]+$/.test(payload)) {
    try { text = Buffer.from(payload, 'base64').toString('utf-8'); } catch {}
  }

  // ⚠ DOIS bugs reais moram aqui, e eles se contradizem — daí o cuidado.
  //
  // 1. O regex NÃO pode ser ancorado por linha (`^...$`): o avaliador comparativo emite os
  //    seis pares numa linha só ("A1: 4  A2: 4  A3: 4 …"), e ancorar perdia todos — o
  //    duelo travava em `pending` para sempre.
  // 2. Mas varrer o texto INTEIRO fazia o parser pescar números da PROSA que o modelo
  //    escreve depois das notas: "o aluno interrompeu 3: 20 vezes" virava o critério 3
  //    com nota 20, estourando a nota para 117/100 — direto no MMR e no ranking.
  //
  // A saída: varrer **linha a linha**, mas parar na primeira linha que não seja de notas.
  // Dentro de uma linha de notas, os pares podem estar em qualquer posição (resolve 1);
  // a prosa que vem depois nunca é alcançada (resolve 2).
  const out = {};
  const pair = /\b([A-Za-z]?\d+)\s*:\s*([-+]?\d+(?:[.,]\d+)?)/g;

  let comecou = false;
  for (const linha of text.split(/\r?\n/)) {
    const limpa = linha.trim();

    // Linha em branco: antes das notas, tolera (o modelo às vezes pula uma linha depois do
    // marcador). DEPOIS que as notas começaram, ela ENCERRA o bloco — é justamente a
    // linha em branco que separa as notas da prosa, e era por ali que o parser vazava
    // para dentro do texto corrido.
    if (!limpa) {
      if (comecou) break;
      continue;
    }
    if (/^[`\-*_]+$/.test(limpa)) continue;      // cerca ``` ou separador ---: tolera

    pair.lastIndex = 0;
    const daLinha = {};
    let m;
    while ((m = pair.exec(limpa)) !== null) {
      if (!isCriterionKey(m[1])) continue;
      const n = toScore(m[2]);
      if (n !== null) daLinha[m[1].toUpperCase()] = n;
    }

    // Nenhum par válido nesta linha → o bloco de notas acabou. O que vem depois é prosa.
    if (!Object.keys(daLinha).length) break;
    comecou = true;
    Object.assign(out, daLinha);
  }

  return Object.keys(out).length ? out : null;
}

/**
 * Reescreve a nota que a IA imprimiu no texto com a nota REAL, calculada em código.
 *
 * O avaliador global manda a IA abrir a devolutiva com `**Nota: X/100**`. Mas a nota
 * verdadeira sai do `scoring.js` (média das notas por critério) — a IA só chuta. Numa
 * sessão real ela escreveu 67 enquanto os critérios davam 54: o selo e o texto se
 * contradiziam.
 *
 * Casos tratados:
 *   - sem `score` (a IA não emitiu critérios): o texto passa intacto — melhor manter o que
 *     ela escreveu do que apagar a nota e deixar a devolutiva sem número nenhum;
 *   - a IA esqueceu a linha: também passa intacto (o selo continua mostrando a nota certa);
 *   - a linha existe: o número é trocado, o formato é preservado.
 */
function syncDisplayedScore(text, score) {
  if (typeof text !== 'string' || !Number.isFinite(score)) return text;
  // Aceita as variações que o modelo produz: **Nota: 67/100**, "Nota: 67 / 100", "NOTA: 67".
  return text.replace(
    /(\*{0,2}\s*nota\s*:\s*)(\d+(?:[.,]\d+)?)(\s*\/\s*100)?(\s*\*{0,2})/i,
    (m, pre, _num, barra, pos) => `${pre}${score}${barra || '/100'}${pos}`,
  );
}

function extractSupervisorNotes(evaluation) {
  const text = typeof evaluation === 'string' ? evaluation : '';
  // A cerca ``` pode abrir ANTES do marcador (o modelo às vezes envolve o bloco
  // inteiro), e nesse caso ela sobraria pendurada no fim do texto do aluno.
  const m = text.match(/\n*(?:```[a-z]*[^\S\n]*\r?\n)?(?:-{3,}[^\S\n]*\r?\n+)?\[notas-supervisor\][^\S\n]*\r?\n?([\s\S]*)$/i);
  if (!m) return { clean: text, criteria: null };
  const clean = text.slice(0, m.index).replace(/\s+$/, '');
  let payload = (m[1] || '').trim();
  payload = payload.replace(/^```[a-z]*[ \t]*\r?\n?/i, '').replace(/\r?\n?```\s*$/i, '').trim();
  return { clean, criteria: parseSupervisorPayload(payload) };
}

/**
 * Nota final emitida por um avaliador CUSTOMIZADO no formato `[NOTA:X]`.
 * Cada avaliador de exercício traz a própria escala (ex.: 5 eixos de 0 a 2), então
 * a nota vem pronta da IA — diferente do avaliador global, cuja nota é calculada
 * em código a partir do bloco `[notas-supervisor]`.
 * Remove a linha do texto para que o aluno não a veja duplicada.
 */
function extractFinalScore(evaluation) {
  const text = typeof evaluation === 'string' ? evaluation : '';
  const re = /\[NOTA:\s*([-+]?\d+(?:[.,]\d+)?)\s*\]/i;
  const m = text.match(re);
  if (!m) return { clean: text, score: null };
  const score = toScore(m[1]);
  // ⚠ `replace` com regex SEM `/g` troca só a primeira ocorrência. Se o modelo emitisse o
  // marcador duas vezes (acontece em prompts longos), o SEGUNDO ficava no texto que o
  // aluno lê. A nota continua sendo a primeira; o que muda é que agora nenhum marcador
  // sobra. O `\s*` em volta evita deixar espaço duplo quando ele está no meio da frase.
  const clean = text
    .replace(/[ \t]*\[NOTA:\s*[-+]?\d+(?:[.,]\d+)?\s*\][ \t]*/gi, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { clean, score };
}

function transcriptFromMessages(messages, authorName, characterName) {
  return (messages || [])
    .map((m) => {
      const author = m.role === 'user' ? authorName : characterName;
      const star = m.highlighted ? ' ★' : '';
      const comment = m.highlighted && m.comment ? `\n   {${m.comment}}` : '';
      return `[${author}${star}]\n${m.content}${comment}`;
    })
    .join('\n\n---\n\n');
}

function loadPromptFile(name) {
  const p = path.join(AVALIACAO_DIR, name);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null;
}

// =====================================================================
// DUELO
// =====================================================================
const DUEL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DUEL_MAX_MESSAGES = 500;
const DUEL_MAX_MESSAGE_LEN = 20000;

function readDuels() { return readJSON('duels.json', []); }

function pruneExpiredDuels() {
  let duels;
  try { duels = readDuels(); } catch { return 0; }
  if (!Array.isArray(duels) || !duels.length) return 0;
  const cutoff = Date.now() - DUEL_TTL_MS;
  const kept = duels.filter((d) => {
    const t = new Date(d.createdAt || 0).getTime();
    return !Number.isFinite(t) || t === 0 || t >= cutoff;
  });
  if (kept.length === duels.length) return 0;
  writeJSON('duels.json', kept);
  return duels.length - kept.length;
}

function sanitizeDuelMessages(messages) {
  const raw = Array.isArray(messages) ? messages.slice(0, DUEL_MAX_MESSAGES) : [];
  return raw.map((m) => ({
    role: m && m.role === 'assistant' ? 'assistant' : 'user',
    content: clampStr(m && m.content, DUEL_MAX_MESSAGE_LEN),
    highlighted: !!(m && m.highlighted),
    comment: clampStr(m && m.comment, 2000),
  }));
}

function duelIdentity(user) {
  return { userId: user.id, name: user.name, profilePhoto: user.profilePhoto || '', isVisitor: isVisitor(user) };
}
function duelSideFor(duel, user) {
  if (duel.challenger && duel.challenger.userId === user.id) return 'challenger';
  if (duel.opponent && duel.opponent.userId === user.id) return 'opponent';
  return null;
}
function isDuelParticipant(duel, user) { return !!duelSideFor(duel, user) || isAdmin(user); }

// O cliente nunca recebe as mensagens do adversário antes do fim.
function publicDuel(duel, user) {
  const side = duelSideFor(duel, user);
  const done = duel.status === 'completed';
  const strip = (s) => (s ? { userId: s.userId, name: s.name, profilePhoto: s.profilePhoto, state: s.state, accepted: !!s.accepted, submittedAt: s.submittedAt || null } : null);
  const out = {
    id: duel.id, token: duel.token, mode: duel.mode, status: duel.status,
    createdAt: duel.createdAt, inviteMethod: duel.inviteMethod,
    character: duel.character ? { id: duel.character.id, name: duel.character.name } : null,
    challenger: strip(duel.challenger),
    opponent: strip(duel.opponent),
    side,
    result: done ? duel.result : null,
  };
  // Cada lado vê só as próprias mensagens (até o duelo terminar).
  if (side && duel[side]) out.myMessages = duel[side].messages || [];
  if (done || isAdmin(user)) {
    out.challengerMessages = duel.challenger && duel.challenger.messages;
    out.opponentMessages = duel.opponent && duel.opponent.messages;
  }
  return out;
}

// --- Avaliação comparativa (OpenAI) ---
async function runComparativeEvaluation(duel) {
  const openai = getOpenAI();
  const nameA = (duel.challenger && duel.challenger.name) || 'Aluno A';
  const nameB = (duel.opponent && duel.opponent.name) || 'Aluno B';
  const charName = (duel.character && duel.character.name) || 'Paciente';
  const logA = transcriptFromMessages(duel.challenger.messages, nameA, charName);
  const logB = transcriptFromMessages(duel.opponent.messages, nameB, charName);

  if (!openai) {
    const criteria = { A1: 5, A2: 5, A3: 5, A4: 5, A5: 5, A6: 5, B1: 5, B2: 5, B3: 5, B4: 5, B5: 5, B6: 5 };
    return {
      evaluationClean: '[Modo demonstração — OPENAI_API_KEY não configurada] Avaliação comparativa indisponível.',
      comp: comparativeScores(criteria),
    };
  }

  const systemPrompt = loadPromptFile('avaliador-comparativo-v2.md');
  if (!systemPrompt) throw new Error('Prompt do avaliador comparativo ausente (server/avaliacao/avaliador-comparativo-v2.md).');

  const gabarito = resolveEvaluationCriteria('freeplay', duel.character.id);
  const userContent =
    (gabarito ? `[GABARITO DO CASO] (referência interna do avaliador — não revelar)\n${gabarito}\n\n---\n\n` : '') +
    `[LOG DO ALUNO A — ${nameA}]\n${logA || '(sem mensagens)'}\n\n---\n\n` +
    `[LOG DO ALUNO B — ${nameB}]\n${logB || '(sem mensagens)'}`;

  const text = await openaiChat({
    openai, model: EVAL_MODEL, systemPrompt,
    messages: [{ role: 'user', content: userContent }],
    maxTokens: 8000, effort: process.env.OPENAI_EVAL_EFFORT || 'medium',
  });
  const { clean, criteria } = extractSupervisorNotes(text);
  return { evaluationClean: clean, comp: comparativeScores(criteria) };
}

// --- MMR do duelo (PvP) ---
function applyDuelMmr(duel, comp) {
  // Só duelo competitivo é ranqueado. Duelo de visitante TAMBÉM ranqueia (demanda #2):
  // como visitante só duela com visitante (D9), o rating dele nunca contamina o dos
  // alunos — as duas arenas moram no mesmo `mmr.json`, separadas na leitura.
  if (duel.mode !== 'competitive') return { ranked: false, reason: 'training' };

  // ⚠ D9 na FINALIZAÇÃO, não só na entrada. A criação e o aceite barram o cruzamento de
  // arenas — mas um duelo gravado ANTES da D9 (ou seedado à mão) chegaria aqui com um
  // aluno de um lado e um visitante do outro, e o `processDuel` acoplaria os dois
  // rankings pelo pool de PvP: exatamente o que a D9 existe para impedir. A defesa tem
  // que estar onde o rating é escrito.
  const arenaA = duel.challenger.isVisitor ? 'visitor' : 'therapist';
  const arenaB = duel.opponent && duel.opponent.isVisitor ? 'visitor' : 'therapist';
  if (!duel.opponent || arenaA !== arenaB) return { ranked: false, reason: 'cross_arena' };

  // ⚠ Demanda #7: paciente bloqueado NÃO pontua. O `POST /api/logs` já tinha esse guard,
  // com o comentário "o que ele não leva é o MMR de um paciente que não deveria estar
  // atendendo" — mas o DUELO não tinha, e o caminho de escrita ficava totalmente aberto.
  // Cenário real: o admin bloqueia um paciente (material com problema, caso sensível) e
  // os duelos em voo naquele paciente continuam movendo o ranking.
  const character = readJSON('freeplay-characters.json').find((c) => String(c.id) === String(duel.character.id));
  const arenaUser = { role: arenaA === 'visitor' ? 'visitor' : 'therapist' };
  if (!canUsePatient(arenaUser, character)) return { ranked: false, reason: 'patient_locked' };

  const store = readMmr();
  const pA = store.players[duel.challenger.userId] || mmrEngine.newPlayer();
  const pB = store.players[duel.opponent.userId] || mmrEngine.newPlayer();
  const ch = store.characters[duel.character.id] || mmrEngine.newCharacter();

  const out = mmrEngine.processDuel(pA, pB, ch, comp.scoreA, comp.scoreB);
  if (!out || out.ranked === false) return { ranked: false, reason: (out && out.reason) || 'unranked' };

  store.players[duel.challenger.userId] = out.playerA;
  store.players[duel.opponent.userId] = out.playerB;
  store.characters[duel.character.id] = out.character;
  writeJSON('mmr.json', store);

  // Devolve só o resumo exibível. Espalhar `out` gravaria o estado interno do
  // engine (janela `W` do jogador, `history`/alpha/beta do personagem) dentro de
  // duels.json, inflando o arquivo e sem entregar o delta pronto para o front.
  const round1 = (x) => Math.round(x * 10) / 10;
  return {
    ranked: true,
    challenger: {
      before: Math.round(out.resultA.P_before),
      after: Math.round(out.playerA.P),
      delta: round1(out.resultA.delta),
      pvpDelta: round1(out.pvp.deltaA),
    },
    opponent: {
      before: Math.round(out.resultB.P_before),
      after: Math.round(out.playerB.P),
      delta: round1(out.resultB.delta),
      pvpDelta: round1(out.pvp.deltaB),
    },
    characterDifficulty: mmrEngine.characterDifficulty(out.character),
  };
}

async function finalizeDuel(duelId) {
  const duels = readDuels();
  const duel = duels.find((d) => d.id === duelId);
  if (!duel) return;

  let comp = null, evaluationClean = '';
  try {
    const r = await runComparativeEvaluation(duel);
    comp = r.comp;
    evaluationClean = r.evaluationClean;
  } catch (err) {
    console.error('Erro na avaliação comparativa:', err.message);
  }

  await withFileLock('duels.json', () => {
    const all = readDuels();
    const d = all.find((x) => x.id === duelId);
    if (!d) return;
    if (!comp) { d.status = 'pending'; writeJSON('duels.json', all); return; } // permite retry
    const winner = comp.winner === 'A' ? 'challenger' : (comp.winner === 'B' ? 'opponent' : 'draw');
    d.status = 'completed';
    d.result = {
      winner, evaluation: evaluationClean,
      scoreChallenger: comp.scoreA, scoreOpponent: comp.scoreB,
      criteriaChallenger: comp.criteriaA, criteriaOpponent: comp.criteriaB,
      completedAt: new Date().toISOString(),
    };
    writeJSON('duels.json', all);
  });

  if (!comp) return;

  // MMR (fora do lock de duels para não aninhar locks).
  const fresh = readDuels().find((d) => d.id === duelId);
  let mmrInfo = { ranked: false };
  try {
    mmrInfo = await withFileLock('mmr.json', () => applyDuelMmr(fresh, comp));
  } catch (err) { console.error('Erro no MMR do duelo:', err.message); }

  await withFileLock('duels.json', () => {
    const all = readDuels();
    const d = all.find((x) => x.id === duelId);
    if (d && d.result) { d.result.mmr = mmrInfo; writeJSON('duels.json', all); }
  });

  // Notifica os dois lados (visitantes são ignorados dentro de pushNotification).
  // `mmrDelta` só existe em duelo ranqueado (competitivo, entre dois usuários reais
  // fora da calibração). É o mesmo `delta` que o card pós-duelo mostra — solo + PvP —
  // senão o sino e a tela exibiriam números diferentes para a mesma partida.
  const w = fresh.result ? fresh.result.winner : null;
  const rankedMmr = mmrInfo && mmrInfo.ranked ? mmrInfo : null;
  for (const side of ['challenger', 'opponent']) {
    const me = fresh[side];
    if (!me) continue;
    const outcome = w === 'draw' ? 'draw' : (w === side ? 'win' : 'loss');
    await pushNotification(me.userId, {
      type: 'duel_result', duelId,
      title: outcome === 'win' ? 'Você venceu o duelo' : (outcome === 'draw' ? 'Duelo empatado' : 'Você perdeu o duelo'),
      outcome,
      scoreMine: side === 'challenger' ? comp.scoreA : comp.scoreB,
      scoreTheirs: side === 'challenger' ? comp.scoreB : comp.scoreA,
      mmrDelta: rankedMmr ? rankedMmr[side].delta : null,
    });
  }
}

// Oponentes disponíveis: os pares da MESMA arena (D9). Aluno vê alunos, visitante vê
// visitantes. Admin/professor não duelam entre si — caem na arena dos alunos.
app.get('/api/duel/opponents', requireAuth, requireFeature('duelo'), (req, res) => {
  const arena = peerRole(req.user);
  const users = readJSON('users.json').filter((u) => u.role === arena && u.id !== req.user.id);
  res.json(users.map((u) => ({ userId: u.id, name: u.name, profilePhoto: u.profilePhoto || '' })));
});

// Criar duelo.
app.post('/api/duel', requireAuth, requireFeature('duelo'), writeLimiter, async (req, res) => {
  const { characterId, opponentUserId, inviteMethod, mode } = req.body || {};
  const character = readJSON('freeplay-characters.json').find((c) => String(c.id) === String(characterId));
  if (!character) return res.status(404).json({ error: 'Personagem de simulação não encontrado.' });
  // Demanda #7: não dá para duelar num paciente que você não pode atender.
  if (!canUsePatient(req.user, character)) return patientBlockedResponse(res);

  const method = inviteMethod === 'system' ? 'system' : 'link';
  let opponent = null;
  if (method === 'system') {
    const target = readJSON('users.json').find((u) => u.id === opponentUserId);
    if (!target) return res.status(404).json({ error: 'Oponente não encontrado.' });
    if (target.id === req.user.id) return res.status(400).json({ error: 'Não é possível duelar consigo mesmo.' });
    // D9: visitante duela só com visitante. Sem isso, um duelo entre arenas alimentaria
    // os dois rankings ao mesmo tempo — e o `GET /api/duel/opponents` nem lista o outro
    // lado, então chegar aqui significa id forjado no corpo do request.
    if (!samePeerGroup(req.user, target)) return res.status(403).json({ error: 'Você só pode duelar com jogadores do mesmo grupo.' });
    opponent = { ...duelIdentity(target), state: 'invited', accepted: false, messages: [] };
  }

  const duel = {
    id: 'duel' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'),
    token: crypto.randomBytes(12).toString('hex'),
    createdAt: new Date().toISOString(),
    mode: mode === 'competitive' ? 'competitive' : 'training',
    status: 'pending',
    inviteMethod: method,
    character: { id: character.id, name: character.name },
    challenger: { ...duelIdentity(req.user), state: 'in_progress', accepted: true, messages: [] },
    opponent,
  };

  await withFileLock('duels.json', () => {
    const all = readDuels();
    all.push(duel);
    writeJSON('duels.json', all);
  });

  if (opponent) {
    await pushNotification(opponent.userId, {
      type: 'duel_invite', duelId: duel.id,
      title: `${req.user.name} desafiou você para um duelo`,
      characterName: character.name,
    });
  }
  res.json(publicDuel(duel, req.user));
});

// Resumo por token (tela de aceite via link).
app.get('/api/duel/by-token/:token', requireAuth, (req, res) => {
  const duel = readDuels().find((d) => d.token === req.params.token);
  if (!duel) return res.status(404).json({ error: 'Duelo não encontrado.' });
  res.json({
    id: duel.id, token: duel.token, status: duel.status, mode: duel.mode,
    character: duel.character,
    challengerName: duel.challenger.name,
    taken: !!(duel.opponent && duel.opponent.accepted),
    side: duelSideFor(duel, req.user),
  });
});

function acceptDuel(duel, user) {
  if (duel.status === 'completed') return { status: 400, error: 'Duelo já finalizado.' };
  if (duel.challenger.userId === user.id) return { status: 400, error: 'Você criou este duelo.' };
  if (duel.opponent && duel.opponent.accepted) {
    if (duel.opponent.userId === user.id) return { ok: true }; // já aceitou
    return { status: 409, error: 'Este duelo já foi aceito por outra pessoa.' };
  }
  if (duel.inviteMethod === 'system' && duel.opponent && duel.opponent.userId !== user.id) {
    return { status: 403, error: 'Este convite é de outro usuário.' };
  }
  // D9, no ponto que importa: o convite por LINK não escolhe o oponente — quem abre o
  // link se auto-adiciona. É aqui que um visitante entraria num duelo de aluno (e
  // vice-versa), alimentando os dois rankings de uma vez. O papel do desafiante já
  // veio gravado em `duelIdentity`, então basta comparar as arenas.
  const challengerArena = duel.challenger.isVisitor ? 'visitor' : 'therapist';
  if (challengerArena !== peerRole(user)) {
    return { status: 403, error: 'Você só pode duelar com jogadores do mesmo grupo.' };
  }
  duel.opponent = { ...duelIdentity(user), state: 'in_progress', accepted: true, messages: [] };
  return { ok: true };
}

app.post('/api/duel/:id/accept', requireAuth, requireFeature('duelo'), async (req, res) => {
  const out = await withFileLock('duels.json', () => {
    const all = readDuels();
    const duel = all.find((d) => d.id === req.params.id);
    if (!duel) return { status: 404, error: 'Duelo não encontrado.' };
    const r = acceptDuel(duel, req.user);
    if (r.error) return r;
    writeJSON('duels.json', all);
    return { duel };
  });
  if (out.error) return res.status(out.status).json({ error: out.error });
  res.json(publicDuel(out.duel, req.user));
});

app.post('/api/duel/by-token/:token/accept', requireAuth, requireFeature('duelo'), async (req, res) => {
  const out = await withFileLock('duels.json', () => {
    const all = readDuels();
    const duel = all.find((d) => d.token === req.params.token);
    if (!duel) return { status: 404, error: 'Duelo não encontrado.' };
    const r = acceptDuel(duel, req.user);
    if (r.error) return r;
    writeJSON('duels.json', all);
    return { duel };
  });
  if (out.error) return res.status(out.status).json({ error: out.error });
  res.json(publicDuel(out.duel, req.user));
});

app.get('/api/duel/:id', requireAuth, (req, res) => {
  const duel = readDuels().find((d) => d.id === req.params.id);
  if (!duel) return res.status(404).json({ error: 'Duelo não encontrado.' });
  if (!isDuelParticipant(duel, req.user)) return res.status(403).json({ error: 'Acesso negado.' });
  res.json(publicDuel(duel, req.user));
});

// Cancelar: só o desafiante, e só enquanto ninguém aceitou.
app.delete('/api/duel/:id', requireAuth, async (req, res) => {
  const out = await withFileLock('duels.json', () => {
    const all = readDuels();
    const duel = all.find((d) => d.id === req.params.id);
    if (!duel) return { status: 404, error: 'Duelo não encontrado.' };
    if (duel.challenger.userId !== req.user.id && !isAdmin(req.user)) return { status: 403, error: 'Acesso negado.' };
    if (duel.status !== 'pending' || (duel.opponent && duel.opponent.accepted)) {
      return { status: 400, error: 'Duelo já aceito ou finalizado — não pode ser cancelado.' };
    }
    writeJSON('duels.json', all.filter((d) => d.id !== duel.id));
    return { ok: true };
  });
  if (out.error) return res.status(out.status).json({ error: out.error });
  res.json({ ok: true });
});

// Submeter a própria sessão. Quando os dois submeterem, dispara a avaliação.
app.post('/api/duel/:id/submit', requireAuth, aiLimiter, async (req, res) => {
  const messages = sanitizeDuelMessages(req.body && req.body.messages);
  const durationSeconds = Number.isFinite(req.body && req.body.durationSeconds) ? Math.max(0, Math.floor(req.body.durationSeconds)) : 0;

  const out = await withFileLock('duels.json', () => {
    const all = readDuels();
    const duel = all.find((d) => d.id === req.params.id);
    if (!duel) return { status: 404, error: 'Duelo não encontrado.' };
    const side = duelSideFor(duel, req.user);
    if (!side) return { status: 403, error: 'Você não participa deste duelo.' };
    if (duel.status === 'completed') return { status: 400, error: 'Duelo já finalizado.' };
    // ⚠ BUG REAL: sem este guard, um re-submit enquanto a avaliação está EM CURSO
    // (`status: 'evaluating'`, que dura o tempo da chamada de IA) recalculava
    // `bothSubmitted = true` e disparava `finalizeDuel` UMA SEGUNDA VEZ — a mesma partida
    // era avaliada duas vezes e o MMR aplicado duas vezes. O guard de `completed` não
    // pegava isso: existe uma janela real entre o 2º submit e o fim do `finalizeDuel`.
    if (duel.status === 'evaluating') return { status: 409, error: 'Este duelo já está sendo avaliado.' };
    // Re-submeter o próprio lado depois de já ter submetido não reabre nada.
    if (duel[side] && duel[side].state === 'submitted') {
      return { status: 409, error: 'Você já enviou este duelo.' };
    }

    duel[side].messages = messages;
    duel[side].durationSeconds = durationSeconds;
    duel[side].state = 'submitted';
    duel[side].submittedAt = new Date().toISOString();

    const bothSubmitted = duel.challenger.state === 'submitted' && duel.opponent && duel.opponent.state === 'submitted';
    if (bothSubmitted) duel.status = 'evaluating';
    writeJSON('duels.json', all);
    return { duel, bothSubmitted };
  });
  if (out.error) return res.status(out.status).json({ error: out.error });

  res.json(publicDuel(out.duel, req.user));
  // Avaliação roda depois da resposta (pode demorar).
  if (out.bothSubmitted) finalizeDuel(out.duel.id).catch((e) => console.error('finalizeDuel:', e.message));
});

// Export em texto (participantes/admin, só depois de completo).
app.get('/api/duel/:id/export', requireAuth, (req, res) => {
  pruneExpiredDuels();
  const duel = readDuels().find((d) => d.id === req.params.id);
  if (!duel) return res.status(404).json({ error: 'Duelo não encontrado.' });
  if (!isDuelParticipant(duel, req.user)) return res.status(403).json({ error: 'Acesso negado.' });
  if (duel.status !== 'completed') return res.status(400).json({ error: 'Duelo ainda não finalizado.' });

  const r = duel.result || {};
  const body = [
    `DUELO — ${duel.character.name}`,
    `Data: ${duel.createdAt}`,
    `Modo: ${duel.mode}`,
    '',
    '=== AVALIAÇÃO COMPARATIVA ===',
    r.evaluation || '(sem avaliação)',
    '',
    `Nota ${duel.challenger.name}: ${r.scoreChallenger}`,
    `Nota ${duel.opponent.name}: ${r.scoreOpponent}`,
    `Vencedor: ${r.winner}`,
    '',
    `=== LOG — ${duel.challenger.name} ===`,
    transcriptFromMessages(duel.challenger.messages, duel.challenger.name, duel.character.name),
    '',
    `=== LOG — ${duel.opponent.name} ===`,
    transcriptFromMessages(duel.opponent.messages, duel.opponent.name, duel.character.name),
  ].join('\n');

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="duelo-${duel.id}.txt"`);
  res.send(body);
});

// Feed social: duelos agrupados por oponente.
app.get('/api/duels/social', requireAuth, requireFeature('logsSociais'), (req, res) => {
  pruneExpiredDuels();
  const mine = readDuels().filter((d) => duelSideFor(d, req.user));
  const byOpponent = new Map();

  for (const d of mine) {
    const side = duelSideFor(d, req.user);
    const other = side === 'challenger' ? d.opponent : d.challenger;
    if (!other) continue;
    const key = other.userId;
    if (!byOpponent.has(key)) {
      byOpponent.set(key, { userId: other.userId, name: other.name, profilePhoto: other.profilePhoto || '', wins: 0, losses: 0, draws: 0, duels: [] });
    }
    const entry = byOpponent.get(key);
    let outcome = null;
    if (d.status === 'completed' && d.result) {
      if (d.result.winner === 'draw') { entry.draws++; outcome = 'draw'; }
      else if (d.result.winner === side) { entry.wins++; outcome = 'win'; }
      else { entry.losses++; outcome = 'loss'; }
    }
    entry.duels.push({
      id: d.id, status: d.status, mode: d.mode, createdAt: d.createdAt,
      characterName: d.character.name, outcome,
      scoreMine: d.result ? (side === 'challenger' ? d.result.scoreChallenger : d.result.scoreOpponent) : null,
      scoreTheirs: d.result ? (side === 'challenger' ? d.result.scoreOpponent : d.result.scoreChallenger) : null,
      canCancel: d.status === 'pending' && d.challenger.userId === req.user.id && !(d.opponent && d.opponent.accepted),
      canExport: d.status === 'completed',
    });
  }

  const list = [...byOpponent.values()].sort((a, b) => (b.duels.length - a.duels.length) || a.name.localeCompare(b.name));
  res.json(list);
});

// =====================================================================
// PROGRESSÃO (compara atendimento #1 vs #2 do mesmo paciente)
// =====================================================================
app.get('/api/progression/available-patients', requireAuth, requireFeature('progressao'), (req, res) => {
  const logs = readJSON('logs.json').filter((l) => l.userId === req.user.id && l.itemId && Array.isArray(l.messages) && l.messages.length > 0);
  const byItem = new Map();
  for (const l of logs) {
    const prev = byItem.get(l.itemId);
    if (!prev || new Date(l.timestamp) > new Date(prev.timestamp)) byItem.set(l.itemId, l);
  }
  const freeplay = readJSON('freeplay-characters.json');
  const out = [...byItem.values()].map((l) => {
    const c = freeplay.find((x) => String(x.id) === String(l.itemId));
    // Paciente bloqueado sai da lista mesmo que a pessoa já o tenha atendido antes: uma
    // nova avaliação de progressão é uma chamada de IA sobre material que o admin fechou.
    // (Os logs antigos continuam em /logs — aquilo é o trabalho dela, e não some.)
    if (!c || !canUsePatient(req.user, c)) return null;
    return { id: c.id, name: c.name, age: c.age, description: c.description, photoIcon: c.photoIcon || null, lastAttendanceAt: l.timestamp };
  }).filter(Boolean);
  res.json(out);
});

app.post('/api/progression/evaluate', requireAuth, requireFeature('progressao'), aiLimiter, async (req, res) => {
  // ⚠ CUSTO DE IA. A feature `avaliacao` existe para conter gasto — ela nasce DESLIGADA
  // para o visitante justamente porque "cada sessão avaliada é uma chamada paga" e um lead
  // pode entrar aos montes. Mas a progressão gastava IA sem consultá-la: bastava o admin
  // ligar `progressao` para o visitante e o gate de custo virava letra morta.
  //
  // Responde `{disabled:true}` com 200 (não 403) pelo mesmo motivo do `/api/evaluate`: o
  // cliente conta com isso para encerrar o fluxo com uma mensagem, em vez de um erro.
  if (!canUseFeature(readFeatureAccess(), req.user, 'avaliacao')) {
    return res.json({ role: 'assistant', content: '', disabled: true });
  }

  const { characterId, messages } = req.body || {};
  if (!characterId || typeof characterId !== 'string') return res.status(400).json({ error: 'characterId é obrigatório.' });
  if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages deve ser uma lista.' });

  const character = readJSON('freeplay-characters.json').find((c) => String(c.id) === String(characterId));
  if (!character) return res.status(404).json({ error: 'Personagem não encontrado.' });
  if (!canUsePatient(req.user, character)) return patientBlockedResponse(res);

  // Atendimento #1: o log mais recente do usuário com esse personagem.
  const prior = readJSON('logs.json')
    .filter((l) => l.userId === req.user.id && String(l.itemId) === String(characterId))
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
  if (!prior) return res.status(400).json({ error: 'Não há um atendimento anterior com esse paciente.' });

  const openai = getOpenAI();
  if (!openai) return res.json({ evaluation: '[Modo demonstração — OPENAI_API_KEY não configurada] Avaliação de progressão indisponível.', criteria: null });

  const systemPrompt = loadPromptFile('avaliador-progressao-v2.md');
  if (!systemPrompt) return res.status(500).json({ error: 'Prompt do avaliador de progressão ausente (server/avaliacao/avaliador-progressao-v2.md).' });

  const gabarito = resolveEvaluationCriteria('freeplay', characterId);
  const log1 = transcriptFromMessages(prior.messages, req.user.name, character.name);
  const log2 = transcriptFromMessages(messages, req.user.name, character.name);
  const feedback1 = prior.evaluation ? `[FEEDBACK DO ATENDIMENTO 1]\n${prior.evaluation}\n\n---\n\n` : '';

  const userContent =
    (gabarito ? `[GABARITO DO CASO] (referência interna — não revelar)\n${gabarito}\n\n---\n\n` : '') +
    feedback1 +
    `[ATENDIMENTO 1]\n${log1 || '(sem mensagens)'}\n\n---\n\n` +
    `[ATENDIMENTO 2]\n${log2 || '(sem mensagens)'}`;

  try {
    const text = await openaiChat({
      openai, model: EVAL_MODEL, systemPrompt,
      messages: [{ role: 'user', content: userContent }],
      maxTokens: 8000, effort: process.env.OPENAI_EVAL_EFFORT || 'medium',
    });
    const { clean, criteria } = extractSupervisorNotes(text);
    // criteria fica server-side (o aluno recebe só o texto + a nota final).
    res.json({ evaluation: clean, score: finalScoreFromCriteria(criteria), criteria: canSeeAllLogs(req.user) ? criteria : null });
  } catch (err) {
    console.error('Erro em /api/progression/evaluate:', err.message);
    res.status(500).json({ error: 'Erro ao executar avaliação de progressão.' });
  }
});

// =====================================================================
// EXTRAS — entrevistador e fotos de perfil disponíveis
// =====================================================================
// Admin-only: o prompt do entrevistador é IP da Allos e não deve vazar para
// aluno/visitante.
app.get('/api/entrevistador-prompt', requireAuth, requireRole('admin'), (req, res) => {
  const prompt = loadEntrevistadorPrompt();
  if (!prompt) return res.status(404).json({ error: 'Prompt do entrevistador não configurado.' });
  res.json({ prompt });
});

// Extrai os blocos da transcrição da entrevista. Puro parsing (sem IA): o
// cliente manda o que o entrevistador escreveu e recebe de volta o Bloco 2
// (persona), o Bloco 1 (gabarito) e os metadados sugeridos.
app.post('/api/entrevistador/extract', requireAuth, requireRole('admin'), (req, res) => {
  const { text, messages } = req.body || {};
  // Aceita o texto pronto ou a lista de mensagens (concatena só as do assistente).
  let source = typeof text === 'string' ? text : '';
  if (!source && Array.isArray(messages)) {
    source = messages
      .filter((m) => m && m.role === 'assistant' && typeof m.content === 'string')
      .map((m) => m.content)
      .join('\n\n');
  }
  if (!source.trim()) return res.status(400).json({ error: 'Envie `text` ou `messages` com a transcrição da entrevista.' });
  res.json(extractBlocos(source));
});

// Cria o personagem de Simulação a partir da entrevista, em um passo só.
// O admin pode sobrescrever qualquer campo sugerido (name/age/description) e,
// se quiser, mandar os blocos já editados à mão.
app.post('/api/entrevistador/character', requireAuth, requireRole('admin'), async (req, res) => {
  const body = req.body || {};
  let bloco2 = typeof body.specificInstruction === 'string' ? body.specificInstruction.trim() : '';
  let bloco1 = typeof body.evaluationCriteria === 'string' ? body.evaluationCriteria.trim() : '';
  let meta = {};

  // Sem os blocos prontos, extrai da transcrição.
  if (!bloco2) {
    const source = typeof body.text === 'string'
      ? body.text
      : (Array.isArray(body.messages)
        ? body.messages.filter((m) => m && m.role === 'assistant' && typeof m.content === 'string').map((m) => m.content).join('\n\n')
        : '');
    if (!source.trim()) return res.status(400).json({ error: 'Envie `specificInstruction` ou a transcrição (`text`/`messages`).' });
    const ex = extractBlocos(source);
    if (!ex.ready) {
      return res.status(422).json({ error: 'O entrevistador ainda não gerou o prompt do paciente (seção "## [I. CONTENÇÃO]").' });
    }
    bloco2 = ex.bloco2;
    if (!bloco1) bloco1 = ex.bloco1;
    meta = ex.meta;
  }

  const name = String(body.name != null ? body.name : meta.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name é obrigatório' });

  const rawAge = body.age != null && body.age !== '' ? Number(body.age) : meta.age;
  const age = Number.isFinite(rawAge) && rawAge > 0 && rawAge <= 120 ? Math.floor(rawAge) : null;
  const description = String(body.description != null ? body.description : meta.description || '').trim();

  const created = await withFileLock('freeplay-characters.json', () => {
    const chars = readJSON('freeplay-characters.json');
    const c = {
      id: 'fp' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'),
      name,
      age,
      description,
      assistantId: '',
      specificInstruction: bloco2,
      evaluationCriteria: bloco1,  // Bloco 1 vira o gabarito do avaliador.
    };
    chars.push(c);
    writeJSON('freeplay-characters.json', chars);
    return c;
  });
  res.json(created);
});

app.get('/api/profile-photos', requireAuth, (req, res) => {
  const dir = path.join(__dirname, '..', 'profiles_icon');
  if (!fs.existsSync(dir)) return res.json([]);
  const files = fs.readdirSync(dir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f));
  res.json(files.map((f) => `/profiles_icon/${f}`));
});

// Healthcheck do Railway (sem auth). Confirma que o processo está de pé e que o
// volume de dados está montado e gravável — um deploy com volume errado falha aqui
// em vez de servir a aplicação com um DATA_DIR efêmero.
app.get('/api/health', (req, res) => {
  let dataWritable = false;
  try {
    fs.accessSync(DATA_DIR, fs.constants.W_OK);
    dataWritable = true;
  } catch {}
  // ⚠ `dataWritable` NÃO basta — foi essa a lição do incidente em que um cliente perdeu
  // dias de trabalho. Um diretório efêmero dentro do container também é gravável, então
  // esta checagem passava com o volume DESMONTADO e o sistema servia dados condenados.
  //
  // `persisted` é a verificação de verdade: um marcador que sobreviveu a um boot anterior.
  // Não derrubamos o healthcheck por causa dele (no primeiro boot legítimo ele é falso, e
  // falhar aí impediria qualquer deploy novo de subir) — mas ele fica VISÍVEL aqui e
  // gritado no log, para um volume desmontado ser detectável em segundos.
  const ok = dataWritable;
  res.status(ok ? 200 : 503).json({
    ok,
    uptime: Math.floor(process.uptime()),
    dataDir: DATA_DIR,
    dataWritable,
    dataDirFromEnv: !!process.env.DATA_DIR,
    persisted: persistence.verified,
    persistenceNote: persistence.reason,
    snapshots: (() => { try { return snapshots.listSnapshots(DATA_DIR).length; } catch { return null; } })(),
    openai: !!process.env.OPENAI_API_KEY,
    evaluator: evaluatorEnabled(),
  });
});

// =====================================================================
// SERVIR O FRONT (build do React) + fallback SPA
// =====================================================================
const clientDist = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Rota não encontrada' });
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

if (require.main === module) {
  const removed = pruneExpiredLogs();
  if (removed > 0) console.log(`[logs] ${removed} log(s) expirado(s) removido(s) no boot.`);
  const duelsRemoved = pruneExpiredDuels();
  if (duelsRemoved > 0) console.log(`[duels] ${duelsRemoved} duelo(s) expirado(s) removido(s) no boot.`);
  // BOOT_ONLY: roda todo o bootstrap (seed, migrações, snapshot, verificação de
  // persistência) e SAI, sem abrir porta. É como `tests/persistence.test.js` exercita o
  // caminho de boot — que só existe uma vez por processo e por isso não dá para testar
  // com `require()`. Sem isto, cada boot do teste ficava preso até o timeout: 8 testes
  // levavam 140s.
  if (process.env.BOOT_ONLY === '1') {
    console.log('[boot-only] Bootstrap concluído; encerrando sem abrir porta.');
    process.exit(0);
  }
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`Servidor Genus Praxis rodando na porta ${PORT}`));
}

module.exports = app;
