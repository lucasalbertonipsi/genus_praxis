// Helpers de teste compartilhados.
//
// IMPORTANTE: as envs precisam ser setadas ANTES do require de server/index.js,
// porque o servidor valida fail-closed no boot (JWT_SECRET) e resolve DATA_DIR
// uma única vez. Por isso este módulo deve ser o PRIMEIRO require de qualquer
// arquivo de teste.

const path = require('path');
const { defaultSkills } = require('../server/skills');
// As chaves do catálogo de funcionalidades, para a fixture liberar TODAS explicitamente
// (ver o comentário em `settings.json`, abaixo).
const { FEATURES: _FEATURES } = require('../server/features');
const FEATURE_KEYS = _FEATURES.map((f) => f.key);
const fs = require('fs');
const os = require('os');
const bcrypt = require('bcryptjs');

// --- Setup de env (antes do require do app) ---
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'genus-test-'));
process.env.NODE_ENV = 'test';        // desliga os rate limiters (SKIP_RATE_LIMIT)
process.env.JWT_SECRET = 'a'.repeat(48);
process.env.ADMIN_INITIAL_PASSWORD = 'testpass1234';
process.env.DATA_DIR = DATA_DIR;
// Sem chave: o servidor entra em "modo demonstração" e NUNCA chama a OpenAI.
// Setar '' em vez de delete — o dotenv.config() do server re-injetaria do .env real.
process.env.OPENAI_API_KEY = '';
// O Genus é 100% OpenAI; garantimos que nenhum resquício de Anthropic seja lido.
process.env.ANTHROPIC_API_KEY = '';

// O require do app DEVE vir depois das envs acima.
const app = require('../server/index.js');
const request = require('supertest');

const TEST_PASSWORD = 'testpass1234';
const TEST_HASH = bcrypt.hashSync(TEST_PASSWORD, 4); // rounds baixos: acelera a suíte

const DEFAULT_PROFILE = { email: '', profilePhoto: '' };

function defaultUsers() {
  const base = (id, username, name, role, teacherId = null) => ({
    id, username, name, role, teacherId, passwordHash: TEST_HASH, ...DEFAULT_PROFILE,
  });
  return [
    base('1', 'admin', 'Admin', 'admin'),
    base('2', 'prof', 'Professor A', 'supervisor'),
    base('3', 'aluno', 'Aluno A', 'therapist', '2'),   // vinculado ao prof
    base('4', 'prof2', 'Professor B', 'supervisor'),
    base('5', 'aluno2', 'Aluno B', 'therapist', '4'),  // de OUTRO professor
    base('6', 'solo', 'Aluno Sem Prof', 'therapist'),  // sem professor
  ];
}

// Segredos com marcador para os testes de vazamento: se qualquer um destes
// aparecer numa resposta a aluno/visitante, o teste falha.
const SECRETS = {
  exercise: 'PROMPT_SECRETO_EXERCISE_NAO_VAZAR',
  evaluator: 'EVAL_PROMPT_SECRETO_NAO_VAZAR',
  freeplay: 'FP_PROMPT_SECRETO_NAO_VAZAR',
  gabarito: 'GABARITO_SECRETO_NAO_VAZAR',
};

function defaultExercises() {
  return [
    {
      id: 'ex-test-1', title: 'Exercício 1', description: 'Desc pública',
      skillId: 1, difficulty: 'iniciante',
      specificInstruction: SECRETS.exercise,
      evaluatorPrompt: SECRETS.evaluator,
    },
    {
      id: 'ex-test-2', title: 'Exercício 2', description: 'Desc 2',
      skillId: 2, difficulty: 'intermediario',
      specificInstruction: 'OUTRO_PROMPT_SECRETO',
    },
    {
      id: 'ex-test-3', title: 'Exercício 3', description: 'Desc 3',
      skillId: 3, difficulty: 'avancado',
      specificInstruction: 'TERCEIRO_PROMPT_SECRETO',
    },
  ];
}

function defaultFreeplay() {
  return [
    {
      id: 'fp-test-1', name: 'Sofia Test', age: 25, description: 'Desc pública',
      assistantId: '',
      specificInstruction: SECRETS.freeplay,
      evaluationCriteria: SECRETS.gabarito,
    },
    {
      id: 'fp-test-2', name: 'Roberto Test', age: 55, description: 'Desc 2',
      assistantId: '',
      specificInstruction: 'FP2_PROMPT_SECRETO',
      evaluationCriteria: 'GABARITO_2_SECRETO',
    },
  ];
}

/**
 * Zera o DATA_DIR e repopula com fixtures determinísticas.
 * Chame em `beforeEach` para isolar cada teste.
 */
function resetData(overrides = {}) {
  for (const f of fs.readdirSync(DATA_DIR)) {
    const p = path.join(DATA_DIR, f);
    try { if (fs.statSync(p).isFile()) fs.unlinkSync(p); } catch {}
  }
  const writes = {
    'users.json': defaultUsers(),
    // Competências da trilha (demandas #5a/#5b). O resetData APAGA o DATA_DIR inteiro, e o
    // bootstrap do servidor só roda no `require` — sem recriar aqui, todo teste veria ZERO
    // competências e o `skillId` dos exercícios apontaria para o vazio.
    'skills.json': defaultSkills(),
    'exercises.json': defaultExercises(),
    'freeplay-characters.json': defaultFreeplay(),
    'progress.json': {},
    'logs.json': [],
    'achievements.json': {},
    'active-sessions.json': {},
    'mmr.json': { players: {}, characters: {} },
    'duels.json': [],
    'notifications.json': {},
    'announcements.json': [],
    // A matriz de acesso (demanda #4) é EXPLÍCITA na fixture, com tudo liberado.
    //
    // Antes ela ficava ausente e o servidor a completava com os defaults do catálogo — o
    // que acoplava ~24 testes a uma decisão de PRODUTO. Quando o dono do produto pediu
    // "visitante nasce com tudo bloqueado", esses testes quebraram em massa sem nenhum bug
    // de código: eles testavam duelo, ranking e progressão do visitante, e passaram a
    // esbarrar no cadeado.
    //
    // Um teste de duelo deve falhar quando o DUELO quebra, não quando o padrão de acesso
    // muda. Quem testa o padrão em si é `features.test.js`, que lê o catálogo direto.
    'settings.json': {
      evaluatorEnabled: false,
      featureAccess: Object.fromEntries(
        FEATURE_KEYS.map((k) => [k, { aluno: true, visitante: true }]),
      ),
    },
    ...overrides,
  };
  for (const [file, data] of Object.entries(writes)) {
    fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
  }
}

function readData(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf-8'));
}
function writeData(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

async function loginAs(username, password = TEST_PASSWORD) {
  const res = await request(app).post('/api/login').send({ username, password });
  if (res.status !== 200) {
    throw new Error(`Login falhou (${username}): ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

// O visitante agora é um usuário REAL (demanda #1): precisa de nome, e-mail e
// telefone, e os três são únicos. Cada chamada gera um visitante distinto — senão
// a segunda chamada dentro do mesmo teste colidiria (409).
let visitorSeq = 0;
function visitorPayload(over = {}) {
  visitorSeq += 1;
  const n = String(visitorSeq).padStart(4, '0');
  return {
    name: `Visitante ${n}`,
    email: `visitante${n}@teste.com`,
    // 11 dígitos (celular com DDD), único por chamada.
    phone: `1191${n}${n}`.slice(0, 11),
    ...over,
  };
}

async function loginVisitor(over = {}) {
  const res = await request(app).post('/api/login/visitor').send(visitorPayload(over));
  if (res.status !== 200) {
    throw new Error(`Login visitante falhou: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

/**
 * Como `loginVisitor`, mas devolve `{ token, id, user }`.
 *
 * Desde a demanda #1 o visitante é um usuário REAL (tem id em users.json), e desde a #2
 * ele tem ranking e MMR próprios (D3). Testar arena exige o id — daí este helper, em vez
 * de fazer o `loginVisitor` devolver uma string com propriedades penduradas.
 */
async function loginVisitorFull(over = {}) {
  const res = await request(app).post('/api/login/visitor').send(visitorPayload(over));
  if (res.status !== 200) {
    throw new Error(`Login visitante falhou: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { token: res.body.token, id: res.body.user.id, user: res.body.user };
}

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

// O servidor calcula "que dia é este log" no fuso da APLICAÇÃO (APP_TIMEZONE, padrão
// America/Sao_Paulo) — não em UTC. Se o helper usasse `toISOString()` (UTC), como fazia
// antes, ele MENTIRIA para o teste sempre que a suíte rodasse depois das 21h no Brasil:
// `dayKey(0)` devolveria o dia seguinte, e um teste que comparasse a chave contra
// `streak.lastActiveDate` falharia (ou, pior, passaria por engano). Aqui replicamos
// exatamente a conversão do servidor.
const APP_TIMEZONE = process.env.APP_TIMEZONE || 'America/Sao_Paulo';

/** Data YYYY-MM-DD de um timestamp, no fuso da aplicação (igual ao `dayKey` do servidor). */
function dayKeyOf(timestamp) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(timestamp));
}

/** Data no formato YYYY-MM-DD, deslocada `daysAgo` dias (no fuso da aplicação). */
function dayKey(daysAgo = 0) {
  return dayKeyOf(Date.now() - daysAgo * 86400000);
}

/**
 * ISO de um instante que, NO FUSO DA APLICAÇÃO, cai em `hour`:`minute` de `daysAgo` dias atrás.
 *
 * Necessário para testar `early_bird` (< 7h) e `night_owl` (>= 23h): não dá para montar o
 * timestamp com `new Date(...)` local, porque o fuso da MÁQUINA que roda a suíte (CI em UTC,
 * por exemplo) pode não ser o da aplicação. Aqui procuramos, por busca direta, o instante UTC
 * cuja hora local no APP_TIMEZONE é a pedida.
 */
function atLocalHour(hour, daysAgo = 0, minute = 30) {
  const target = dayKey(daysAgo);
  // Varre as 24 horas UTC do dia-alvo (e as vizinhas, por causa do offset): a primeira
  // que bate data+hora local é a que queremos. Offsets reais vão de -12 a +14.
  const base = new Date(`${target}T00:00:00.000Z`).getTime();
  for (let h = -14; h <= 26; h++) {
    const t = new Date(base + h * 3600000 + minute * 60000);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: APP_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', hour12: false,
    }).formatToParts(t);
    const get = (k) => parts.find((p) => p.type === k).value;
    const localDay = `${get('year')}-${get('month')}-${get('day')}`;
    if (localDay === target && Number(get('hour')) % 24 === hour) return t.toISOString();
  }
  throw new Error(`atLocalHour: não achei ${hour}h de ${target} em ${APP_TIMEZONE}`);
}

/** Cria um log direto no disco (bypassa a rota, para montar cenários). */
function makeLog(over = {}) {
  const daysAgo = over.daysAgo || 0;
  const ts = new Date();
  ts.setDate(ts.getDate() - daysAgo);
  delete over.daysAgo;
  return {
    id: 'log-' + Math.random().toString(36).slice(2, 10),
    timestamp: ts.toISOString(),
    type: 'freeplay',
    mode: 'training',
    difficulty: null,
    itemId: 'fp-test-1',
    itemTitle: 'Sofia Test',
    durationSeconds: 600,
    sessionCount: 1,
    score: null,
    criteriaScores: null,
    evaluation: '',
    messages: [{ role: 'user', content: 'oi', highlighted: false, comment: '' }],
    userId: '3',
    userName: 'Aluno A',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Helpers de DUELO
//
// `waitCompleted`, `fullDuel` e `seedMmr` estavam duplicados byte-a-byte entre
// duel.test.js e duel-notification.test.js. Duas cópias do mesmo polling divergem na
// primeira vez que alguém ajusta o timeout de um só lado — e o outro arquivo passa a
// falhar por flakiness, não por bug. Fonte única aqui.
// ---------------------------------------------------------------------------

const DUEL_CHAR = 'fp-test-1';

/** Grava o mmr.json com os jogadores dados (personagens zerados). */
function seedMmr(players) {
  writeData('mmr.json', { players, characters: {} });
}

/**
 * Espera o duelo virar `completed`.
 *
 * `finalizeDuel` roda em BACKGROUND depois que o 2º submit já respondeu — a resposta
 * do submit costuma vir com o status antigo. Daí o polling.
 */
async function waitCompleted(token, duelId, { tries = 40, delay = 15 } = {}) {
  for (let i = 0; i < tries; i++) {
    const r = await request(app).get(`/api/duel/${duelId}`).set(authHeader(token));
    if (r.body && r.body.status === 'completed') return r;
    await new Promise((res) => setTimeout(res, delay));
  }
  return request(app).get(`/api/duel/${duelId}`).set(authHeader(token));
}

// Mensagens com marcador: servem aos testes de sigilo (o lado B não pode ver o texto
// de A antes do fim do duelo).
const DUEL_MSGS_A = [
  { role: 'user', content: 'MENSAGEM_SECRETA_DO_A_1234' },
  { role: 'assistant', content: 'Resposta do paciente para A' },
];
const DUEL_MSGS_B = [
  { role: 'user', content: 'MENSAGEM_SECRETA_DO_B_5678' },
  { role: 'assistant', content: 'Resposta do paciente para B' },
];

/**
 * Duelo completo aluno(3) × aluno2(5): cria → aceita → os dois submetem → espera o fim.
 * Sem OPENAI_API_KEY o avaliador comparativo devolve um empate determinístico 50×50.
 */
async function fullDuel({ mode, characterId = DUEL_CHAR } = {}) {
  const aluno = await loginAs('aluno');
  const aluno2 = await loginAs('aluno2');
  const create = await request(app).post('/api/duel').set(authHeader(aluno))
    .send({ characterId, opponentUserId: '5', inviteMethod: 'system', mode });
  const duelId = create.body.id;
  await request(app).post(`/api/duel/${duelId}/accept`).set(authHeader(aluno2));
  await request(app).post(`/api/duel/${duelId}/submit`).set(authHeader(aluno))
    .send({ messages: DUEL_MSGS_A, durationSeconds: 120 });
  const sub2 = await request(app).post(`/api/duel/${duelId}/submit`).set(authHeader(aluno2))
    .send({ messages: DUEL_MSGS_B, durationSeconds: 90 });
  const done = await waitCompleted(aluno, duelId);
  return { aluno, aluno2, duelId, sub2, duel: done.body };
}

module.exports = {
  app,
  request,
  resetData,
  readData,
  writeData,
  loginAs,
  loginVisitor,
  loginVisitorFull,
  visitorPayload,
  authHeader,
  dayKey,
  dayKeyOf,
  atLocalHour,
  APP_TIMEZONE,
  makeLog,
  SECRETS,
  TEST_PASSWORD,
  DATA_DIR,
  // duelo
  seedMmr,
  waitCompleted,
  fullDuel,
  DUEL_CHAR,
  DUEL_MSGS_A,
  DUEL_MSGS_B,
};
