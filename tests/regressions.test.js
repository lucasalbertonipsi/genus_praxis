// Bugs REAIS encontrados na auditoria da suíte (2026-07-14) — todos reproduzidos antes
// de corrigir. Cada `it` aqui existe porque a suíte de 719 testes passava **inteira** com
// o bug presente.
//
// Estão juntos de propósito: o valor deste arquivo é ser a lista do que já nos mordeu.
const {
  app, request, resetData, readData, writeData,
  loginAs, loginVisitorFull, authHeader, makeLog,
} = require('./helpers');

const { toScore, finalScoreFromCriteria } = require('../server/scoring');

beforeEach(() => resetData());

// =====================================================================
// 1. A NOTA — o que corrompia log, MMR e ranking
// =====================================================================
describe('nota: "em branco" não é zero', () => {
  // 🔴 `Number('')` é 0, e 0 é finito. Um critério que a IA deixou EM BRANCO virava um
  // zero legítimo e DERRUBAVA A NOTA PELA METADE. O cliente já tinha a proteção
  // (`isRealScore`); o servidor — que é quem grava a nota — não tinha.
  it('critério vazio é IGNORADO, não vale zero', () => {
    expect(finalScoreFromCriteria({ 1: 8, 2: '' })).toBe(80);   // era 40
    expect(finalScoreFromCriteria({ 1: 8, 2: '   ' })).toBe(80);
    expect(finalScoreFromCriteria({ 1: 8, 2: null })).toBe(80);
  });

  // A distinção que importa: um zero REAL continua valendo zero.
  it('zero legítimo continua contando como zero', () => {
    expect(finalScoreFromCriteria({ 1: 8, 2: 0 })).toBe(40);
    expect(finalScoreFromCriteria({ 1: 8, 2: '0' })).toBe(40);
  });

  it('toScore separa nota de lixo', () => {
    for (const v of ['', '   ', null, undefined, [], {}, 'abc', true]) {
      expect(toScore(v), JSON.stringify(v)).toBeNull();
    }
    expect(toScore('7,5')).toBe(7.5);
    expect(toScore(0)).toBe(0);
  });
});

describe('nota: o parser não inventa critérios a partir da prosa', () => {
  // 🔴 O regex varria TUDO depois do marcador. Uma frase como "o aluno interrompeu 3: 20
  // vezes" virava o critério 3 com nota 20 — inventando um critério e estourando a nota
  // (117/100), que ia direto para o MMR e o ranking.
  it('número solto na prosa NÃO vira critério', async () => {
    const admin = await loginAs('admin');
    const res = await request(app).post('/api/logs').set(authHeader(admin)).send({
      type: 'freeplay', itemId: 'fp-test-1', mode: 'training',
      messages: [{ role: 'user', content: 'oi' }],
      evaluation: 'Bom trabalho.\n\n[notas-supervisor]\n1: 8\n2: 7\n\nObservação: o aluno interrompeu 3: 20 vezes.',
    });

    const log = readData('logs.json')[0];
    expect(log.criteriaScores['3']).toBeUndefined();   // o "3: 20" da prosa não entrou
    expect(log.criteriaScores).toEqual({ 1: 8, 2: 7 });
    expect(log.score).toBe(75);                        // (8+7)/20 → 75, não 117
    expect(res.status).toBe(200);
  });

  it('chaves fora do catálogo (1..10, A1..B6) são descartadas', async () => {
    const admin = await loginAs('admin');
    await request(app).post('/api/logs').set(authHeader(admin)).send({
      type: 'freeplay', itemId: 'fp-test-1', mode: 'training',
      messages: [{ role: 'user', content: 'oi' }],
      evaluation: 'x\n\n[notas-supervisor]\n1: 8\n99: 10\nZ3: 5',
    });
    expect(readData('logs.json')[0].criteriaScores).toEqual({ 1: 8 });
  });
});

describe('nota: o cliente não dita a nota', () => {
  // 🔴 O `score` vem do cliente e alimenta MMR, bestScore e conquistas. Um `999999` via
  // DevTools destruía a média, desbloqueava `high_score` de graça e entrava no ranking.
  it('score fora da faixa é CLAMPADO em 0..100', async () => {
    const aluno = await loginAs('aluno');

    const alto = await request(app).post('/api/logs').set(authHeader(aluno)).send({
      type: 'freeplay', itemId: 'fp-test-1', mode: 'competitive', score: 999999,
      messages: [{ role: 'user', content: 'oi' }],
    });
    expect(alto.status).toBe(200);
    expect(readData('logs.json').find((l) => l.score === 999999)).toBeUndefined();
    expect(readData('logs.json')[0].score).toBe(100);

    const baixo = await request(app).post('/api/logs').set(authHeader(aluno)).send({
      type: 'freeplay', itemId: 'fp-test-2', mode: 'training', score: -50,
      messages: [{ role: 'user', content: 'oi' }],
    });
    expect(baixo.status).toBe(200);
    expect(readData('logs.json').some((l) => l.score < 0)).toBe(false);
  });
});

describe('nota: o marcador [NOTA:X] não vaza para o aluno', () => {
  // 🟡 O `replace` usava regex SEM `/g`: um segundo marcador (o modelo repetindo o
  // formato em prompts longos) ficava no texto que o aluno lê.
  it('marcador REPETIDO é removido inteiro', async () => {
    const admin = await loginAs('admin');
    await request(app).post('/api/logs').set(authHeader(admin)).send({
      type: 'exercise', itemId: 'ex-test-1', mode: 'training',
      messages: [{ role: 'user', content: 'oi' }],
      evaluation: 'Feedback. [NOTA:7] Mais texto. [NOTA:9]',
    });

    const log = readData('logs.json')[0];
    expect(log.evaluation).not.toContain('[NOTA:');
    expect(log.score).toBe(7);   // vale o primeiro
  });
});

// =====================================================================
// 2. COMPETÊNCIAS — perda de dado
// =====================================================================
describe('competências: o reorder não pode destruir a lista', () => {
  // 🔴 `ids: ["1","1","1","1","1"]` passava (comprimento batia, ids existiam) e gravava a
  // MESMA competência 5 vezes — DESTRUINDO as outras 4, sem confirmação e sem aviso de
  // órfãos. Um bug de drag-and-drop no client bastaria.
  it('ids repetidos → 400 (e nada é gravado)', async () => {
    const admin = await loginAs('admin');
    const res = await request(app).post('/api/admin/skills/reorder').set(authHeader(admin))
      .send({ ids: ['1', '1', '1', '1', '1'] });

    expect(res.status).toBe(400);
    const disco = readData('skills.json');
    expect(disco.length).toBe(5);
    expect(new Set(disco.map((s) => s.id)).size).toBe(5);   // as 5 continuam distintas
  });
});

describe('competências: o PUT não pode apagar os critérios', () => {
  // 🔴 O `sanitizeSkill` tratava campo ausente como '', então um PUT parcial (só nome e
  // cor) APAGAVA os critérios. Nada falhava — o prompt do paciente simplesmente passava a
  // ser montado sem eles. É o único campo cuja perda não emite nenhum sinal.
  it('PUT sem `criteria` PRESERVA os critérios (merge, não replace)', async () => {
    const antes = readData('skills.json').find((s) => s.id === 1).criteria;
    expect(antes.length).toBeGreaterThan(0);

    const admin = await loginAs('admin');
    const res = await request(app).put('/api/admin/skills/1').set(authHeader(admin))
      .send({ name: 'Hermenêutica Clínica', color: '#ff6200' });   // sem `criteria`

    expect(res.status).toBe(200);
    const depois = readData('skills.json').find((s) => s.id === 1);
    expect(depois.name).toBe('Hermenêutica Clínica');   // o que veio, mudou
    expect(depois.criteria).toBe(antes);                // o que não veio, sobreviveu
  });

  it('mandar `criteria` explicitamente vazio AINDA limpa (é intenção do admin)', async () => {
    const admin = await loginAs('admin');
    await request(app).put('/api/admin/skills/1').set(authHeader(admin))
      .send({ name: 'X Válido', color: '#ff6200', criteria: '' });
    expect(readData('skills.json').find((s) => s.id === 1).criteria).toBe('');
  });
});

// =====================================================================
// 3. PACIENTE BLOQUEADO (demanda #7) — os furos
// =====================================================================
describe('paciente bloqueado: "false" em texto bloqueia de verdade', () => {
  // 🟠 `allowStudent: "false"` (STRING) é truthy, e o guard era `!== false` → o paciente
  // ficava LIBERADO com o admin achando que o tinha bloqueado. Um form url-encoded, um
  // <select> HTML ou um client que serialize booleanos como texto produz isso.
  it('PUT com "false" (string) é coagido para booleano', async () => {
    const admin = await loginAs('admin');
    await request(app).put('/api/freeplay/fp-test-1').set(authHeader(admin))
      .send({ allowStudent: 'false' });

    // Coerção na ESCRITA: o disco guarda um booleano de verdade.
    expect(readData('freeplay-characters.json').find((c) => c.id === 'fp-test-1').allowStudent).toBe(false);

    // E o bloqueio vale.
    const aluno = await loginAs('aluno');
    const res = await request(app).post('/api/chat').set(authHeader(aluno))
      .send({ messages: [{ role: 'user', content: 'oi' }], context: { type: 'freeplay', itemId: 'fp-test-1' } });
    expect(res.status).toBe(403);
  });

  // Defesa em profundidade: mesmo um "false" que já esteja no disco (base antiga,
  // importação) precisa bloquear.
  it('"false" já gravado no disco também bloqueia', async () => {
    const chars = readData('freeplay-characters.json');
    chars.find((c) => c.id === 'fp-test-1').allowStudent = 'false';
    writeData('freeplay-characters.json', chars);

    const aluno = await loginAs('aluno');
    const res = await request(app).post('/api/chat').set(authHeader(aluno))
      .send({ messages: [{ role: 'user', content: 'oi' }], context: { type: 'freeplay', itemId: 'fp-test-1' } });
    expect(res.status).toBe(403);
  });
});

// =====================================================================
// 4. UNICIDADE DE E-MAIL — a chave que o login de visitante usa
// =====================================================================
describe('e-mail é único em TODAS as rotas de escrita', () => {
  // 🔴 O sistema DEPENDE da unicidade: `/api/login/visitor` recupera a conta do lead por
  // `email + phone`. Mas só ELE validava. Um aluno editando o próprio perfil assumia o
  // e-mail de um visitante, e ficavam dois usuários com a mesma chave.
  it('PUT /api/users/:id não deixa assumir o e-mail de outro', async () => {
    const v = await loginVisitorFull({ email: 'lead@x.com', phone: '11911112222' });
    const aluno = await loginAs('aluno');

    const res = await request(app).put('/api/users/3').set(authHeader(aluno))
      .send({ email: 'lead@x.com' });

    expect(res.status).toBe(409);
    expect(res.body.field).toBe('email');
    expect(readData('users.json').find((u) => u.id === '3').email).not.toBe('lead@x.com');
    expect(v.user.email).toBe('lead@x.com');   // o dono continua dono
  });

  it('POST /api/admin/users não cria e-mail duplicado (case-insensitive)', async () => {
    await loginVisitorFull({ email: 'lead@x.com', phone: '11933334444' });
    const admin = await loginAs('admin');

    const res = await request(app).post('/api/admin/users').set(authHeader(admin))
      .send({ username: 'novo', password: 'senha12345', name: 'Novo', role: 'therapist', email: 'LEAD@X.COM' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/e-mail/i);
  });

  it('salvar o PRÓPRIO e-mail não colide consigo mesmo', async () => {
    const aluno = await loginAs('aluno');
    await request(app).put('/api/users/3').set(authHeader(aluno)).send({ email: 'ana@x.com' });

    const res = await request(app).put('/api/users/3').set(authHeader(aluno))
      .send({ email: 'ana@x.com', name: 'Ana Silva' });
    expect(res.status).toBe(200);
  });

  it('e-mail vazio continua permitido (o campo é opcional)', async () => {
    const aluno = await loginAs('aluno');
    expect((await request(app).put('/api/users/3').set(authHeader(aluno)).send({ email: '' })).status).toBe(200);
  });
});

// =====================================================================
// 5. FUSO HORÁRIO — a streak de quem estuda à noite
// =====================================================================
describe('fuso: o dia do log é o dia LOCAL, não o UTC', () => {
  // 🟠 `dayKey` usava `toISOString()` (UTC) e as conquistas usavam `getHours()` (local) —
  // dois fusos no mesmo módulo. No Brasil (UTC−3), uma sessão às 21h+ caía no dia SEGUINTE
  // em UTC: quem estuda toda noite via a streak "pular" um dia, e a missão diária de hoje
  // só era creditada amanhã.
  it('sessão às 23h30 (BRT) conta no dia em que o aluno a fez', async () => {
    // 2026-07-10 23:30 em São Paulo = 2026-07-11 02:30 UTC.
    const noite = '2026-07-11T02:30:00.000Z';
    writeData('logs.json', [makeLog({ userId: '3', type: 'freeplay' })].map((l) => ({ ...l, timestamp: noite })));

    const aluno = await loginAs('aluno');
    const res = await request(app).get('/api/gamification/3').set(authHeader(aluno));

    // O dia do log é 10, não 11 — é o dia em que o aluno estava na frente do computador.
    expect(res.body.streak.lastActiveDate).toBe('2026-07-10');
  });
});

// =====================================================================
// 6. DUELO — os dois furos que a auditoria achou
// =====================================================================
const CHAR = 'fp-test-1';
const msgsA = [{ role: 'user', content: 'A' }, { role: 'assistant', content: 'r' }];
const msgsB = [{ role: 'user', content: 'B' }, { role: 'assistant', content: 'r' }];

async function waitCompleted(token, duelId, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const r = await request(app).get(`/api/duel/${duelId}`).set(authHeader(token));
    if (r.body && r.body.status === 'completed') return r;
    await new Promise((res) => setTimeout(res, 15));
  }
  return request(app).get(`/api/duel/${duelId}`).set(authHeader(token));
}

/** Duelo competitivo aluno×aluno, ambos fora da calibração, já aceito. */
async function dueloAceito() {
  writeData('mmr.json', {
    players: { 3: { P: 60, n: 10, W: [] }, 5: { P: 60, n: 10, W: [] } },
    characters: {},
  });
  const aluno = await loginAs('aluno');
  const aluno2 = await loginAs('aluno2');
  const create = await request(app).post('/api/duel').set(authHeader(aluno))
    .send({ characterId: CHAR, opponentUserId: '5', inviteMethod: 'system', mode: 'competitive' });
  const duelId = create.body.id;
  await request(app).post(`/api/duel/${duelId}/accept`).set(authHeader(aluno2));
  return { aluno, aluno2, duelId };
}

describe('duelo: paciente bloqueado NÃO pontua (demanda #7)', () => {
  // 🔴 O `POST /api/logs` tinha esse guard — "o que ele não leva é o MMR de um paciente
  // que não deveria estar atendendo" — mas o DUELO não tinha. O admin bloqueava um
  // paciente (material com problema, caso sensível) e os duelos em voo naquele paciente
  // CONTINUAVAM movendo o ranking.
  it('bloquear o paciente no meio do duelo → unranked (o MMR não se move)', async () => {
    const { aluno, aluno2, duelId } = await dueloAceito();

    // O admin bloqueia DEPOIS do aceite, com o duelo em voo.
    const chars = readData('freeplay-characters.json');
    chars.find((c) => c.id === CHAR).allowStudent = false;
    writeData('freeplay-characters.json', chars);

    await request(app).post(`/api/duel/${duelId}/submit`).set(authHeader(aluno)).send({ messages: msgsA });
    await request(app).post(`/api/duel/${duelId}/submit`).set(authHeader(aluno2)).send({ messages: msgsB });

    const done = await waitCompleted(aluno, duelId);
    expect(done.body.status).toBe('completed');          // o duelo termina (não trava)
    expect(done.body.result.mmr.ranked).toBe(false);     // mas não pontua
    expect(done.body.result.mmr.reason).toBe('patient_locked');

    // E o rating dos dois ficou intacto.
    const store = readData('mmr.json');
    expect(store.players['3'].n).toBe(10);
    expect(store.players['5'].n).toBe(10);
  });

  it('paciente liberado → ranqueia normalmente (o guard não quebrou o caminho feliz)', async () => {
    const { aluno, aluno2, duelId } = await dueloAceito();
    await request(app).post(`/api/duel/${duelId}/submit`).set(authHeader(aluno)).send({ messages: msgsA });
    await request(app).post(`/api/duel/${duelId}/submit`).set(authHeader(aluno2)).send({ messages: msgsB });

    const done = await waitCompleted(aluno, duelId);
    expect(done.body.result.mmr.ranked).toBe(true);
    expect(readData('mmr.json').players['3'].n).toBe(11);
  });
});

describe('duelo: a mesma partida não pontua duas vezes', () => {
  // 🔴 O guard só cobria `status: 'completed'`. Entre o 2º submit e o fim do
  // `finalizeDuel` (que roda em background, durante a chamada de IA) o status é
  // 'evaluating' — e um re-submit nessa janela recalculava `bothSubmitted` e disparava o
  // `finalizeDuel` DE NOVO: a mesma partida avaliada duas vezes, MMR aplicado duas vezes.
  // ⚠ Este teste precisa isolar a JANELA `evaluating` — o estado que existe entre o 2º
  // submit e o fim do `finalizeDuel` (que roda em background, durante a chamada de IA).
  //
  // Fazer dois submits pela rota não serve: o guard de `state === 'submitted'` intercepta
  // antes, e o teste passaria mesmo com o guard de `evaluating` REMOVIDO (verifiquei por
  // mutação — era um teste que não provava o que dizia). Por isso montamos o estado no
  // disco: um duelo `evaluating` cujo challenger ainda NÃO está marcado como submitted.
  it('re-submit na janela `evaluating` → 409 (é o guard que impede o MMR dobrado)', async () => {
    const { aluno, duelId } = await dueloAceito();

    const all = readData('duels.json');
    const d = all.find((x) => x.id === duelId);
    d.status = 'evaluating';                 // avaliação em curso…
    d.challenger.state = 'in_progress';      // …e este lado não parece "já enviado"
    d.opponent.state = 'submitted';
    writeData('duels.json', all);

    const re = await request(app).post(`/api/duel/${duelId}/submit`).set(authHeader(aluno)).send({ messages: msgsA });
    expect(re.status).toBe(409);
    expect(re.body.error).toMatch(/avaliad/i);

    // E o MMR não foi tocado por um segundo finalize.
    expect(readData('mmr.json').players['3'].n).toBe(10);
  });

  it('fluxo normal: a partida conta UMA vez (10 → 11, não 12)', async () => {
    const { aluno, aluno2, duelId } = await dueloAceito();
    await request(app).post(`/api/duel/${duelId}/submit`).set(authHeader(aluno)).send({ messages: msgsA });
    await request(app).post(`/api/duel/${duelId}/submit`).set(authHeader(aluno2)).send({ messages: msgsB });

    const done = await waitCompleted(aluno, duelId);
    expect(done.body.status).toBe('completed');
    expect(readData('mmr.json').players['3'].n).toBe(11);
  });

  it('re-submit do próprio lado antes do oponente → 409 (não reabre nada)', async () => {
    const { aluno, duelId } = await dueloAceito();
    const um = await request(app).post(`/api/duel/${duelId}/submit`).set(authHeader(aluno)).send({ messages: msgsA });
    expect(um.status).toBe(200);

    const dois = await request(app).post(`/api/duel/${duelId}/submit`).set(authHeader(aluno)).send({ messages: msgsB });
    expect(dois.status).toBe(409);
  });
});

describe('duelo: arena é validada na FINALIZAÇÃO, não só na entrada', () => {
  // 🔴 A criação e o aceite barram o cruzamento de arenas (D9) — mas um duelo gravado
  // ANTES da D9 (ou seedado à mão) chegava ao `applyDuelMmr` com um aluno de um lado e um
  // visitante do outro, e o `processDuel` ACOPLAVA os dois rankings pelo pool de PvP:
  // exatamente o que a D9 existe para impedir. A defesa precisa estar onde o rating é
  // escrito, não só onde o duelo nasce.
  it('duelo cross-arena legado → unranked (não acopla os rankings)', async () => {
    const v = await loginVisitorFull();
    const aluno = await loginAs('aluno');

    writeData('mmr.json', {
      players: { 3: { P: 60, n: 10, W: [] }, [v.id]: { P: 60, n: 10, W: [] } },
      characters: {},
    });

    // Seed direto no disco: um duelo aluno × visitante, que a D9 nunca deixaria nascer.
    writeData('duels.json', [{
      id: 'duel-legado', token: 'tok-legado', createdAt: new Date().toISOString(),
      mode: 'competitive', status: 'pending', inviteMethod: 'link',
      character: { id: CHAR, name: 'Sofia Test' },
      challenger: { userId: '3', name: 'Aluno A', profilePhoto: '', isVisitor: false, state: 'in_progress', accepted: true, messages: [] },
      opponent: { userId: v.id, name: v.user.name, profilePhoto: '', isVisitor: true, state: 'in_progress', accepted: true, messages: [] },
    }]);

    await request(app).post('/api/duel/duel-legado/submit').set(authHeader(aluno)).send({ messages: msgsA });
    await request(app).post('/api/duel/duel-legado/submit').set(authHeader(v.token)).send({ messages: msgsB });

    const done = await waitCompleted(aluno, 'duel-legado');
    expect(done.body.result.mmr.ranked).toBe(false);
    expect(done.body.result.mmr.reason).toBe('cross_arena');

    // Nenhum dos dois ratings se moveu.
    const store = readData('mmr.json');
    expect(store.players['3'].n).toBe(10);
    expect(store.players[v.id].n).toBe(10);
  });
});

// =====================================================================
// 7. LACUNAS FECHADAS NA AUDITORIA (não eram cobertas por ninguém)
// =====================================================================
describe('sessão ativa de paciente bloqueado some da lista', () => {
  // 🟠 O aluno via o card "sessão em andamento", clicava, e levava 403 no primeiro turno
  // (o `/api/chat` barra) — um beco sem saída. Nenhuma das 4 rotas de active-sessions
  // tinha gate de paciente.
  it('bloquear o paciente tira a sessão da lista, mas o autosave continua', async () => {
    const aluno = await loginAs('aluno');

    await request(app).put('/api/active-sessions/freeplay/fp-test-1').set(authHeader(aluno))
      .send({ messages: [{ role: 'user', content: 'oi' }], elapsedSeconds: 10 });
    expect((await request(app).get('/api/active-sessions').set(authHeader(aluno))).body.length).toBe(1);

    const chars = readData('freeplay-characters.json');
    chars.find((c) => c.id === 'fp-test-1').allowStudent = false;
    writeData('freeplay-characters.json', chars);

    // Some da lista: o aluno não vê mais um card que levaria a um 403.
    expect((await request(app).get('/api/active-sessions').set(authHeader(aluno))).body.length).toBe(0);

    // Mas o autosave NÃO é barrado — se o bloqueio acontece no meio da sessão, o aluno
    // não pode perder o que já escreveu. (Mesma escolha do POST /api/logs.)
    const save = await request(app).put('/api/active-sessions/freeplay/fp-test-1').set(authHeader(aluno))
      .send({ messages: [{ role: 'user', content: 'mais' }], elapsedSeconds: 20 });
    expect(save.status).toBe(200);
  });
});

describe('a feature `avaliacao` contém o custo de IA em TODAS as portas', () => {
  // 🟠 A feature nasce DESLIGADA para o visitante porque "cada avaliação é uma chamada
  // paga" e um lead pode entrar aos montes. Mas a PROGRESSÃO gastava IA sem consultá-la:
  // bastava ligar `progressao` e o gate de custo virava letra morta.
  it('progressão do visitante não gasta IA com `avaliacao` desligada', async () => {
    // `progressao` liberada de propósito: o que este teste protege é o gate de CUSTO
    // (`avaliacao`), e um 403 de cadeado passaria por "não gastou IA" pelo motivo errado.
    writeData('settings.json', {
      evaluatorEnabled: true,
      featureAccess: {
        progressao: { aluno: true, visitante: true },
        avaliacao: { aluno: true, visitante: false },
      },
    });
    const v = await loginVisitorFull();
    const res = await request(app).post('/api/progression/evaluate').set(authHeader(v.token))
      .send({ characterId: CHAR, messages: [{ role: 'user', content: 'oi' }] });

    expect(res.status).toBe(200);
    expect(res.body.disabled).toBe(true);
  });
});

describe('competências não podem ter nome duplicado', () => {
  // 🟡 Duas "Hermenêutica" ficam indistinguíveis no SkillMap e nos logs — o aluno vê dois
  // vértices com o mesmo rótulo e não sabe qual é qual.
  it('POST e PUT recusam um nome que já existe (sem caixa)', async () => {
    const admin = await loginAs('admin');

    const novo = await request(app).post('/api/admin/skills').set(authHeader(admin))
      .send({ name: 'hermenêutica', color: '#123456', criteria: 'x' });
    expect(novo.status).toBe(409);
    expect(novo.body.field).toBe('name');

    const editado = await request(app).put('/api/admin/skills/2').set(authHeader(admin))
      .send({ name: 'Hermenêutica' });
    expect(editado.status).toBe(409);

    // Renomear para o PRÓPRIO nome continua valendo (não colide consigo mesma).
    const mesma = await request(app).put('/api/admin/skills/1').set(authHeader(admin))
      .send({ name: 'Hermenêutica', color: '#ff6200' });
    expect(mesma.status).toBe(200);
  });
});

// =====================================================================
// 8. ESCALA ÚNICA 0–100 (decisão do usuário, 2026-07-14)
// =====================================================================
describe('escala: exercício e freeplay usam a MESMA régua (0–100)', () => {
  // Antes: exercício dava 0–10 (os avaliadores customizados definem "5 eixos, máx. 10") e
  // freeplay dava 0–100. O <ScoreBadge> clampa em 0–100, então **um 10/10 de exercício
  // aparecia em VERMELHO como "Erro"** — a nota máxima pintada como a pior possível. E a
  // conquista `high_score` era inalcançável por exercício.
  //
  // A régua pedagógica do admin (5 eixos de 0–2, faixas "9–10: Excepcional") fica INTACTA:
  // é o raciocínio interno da IA. O wrapper só exige que a nota REPORTADA venha convertida.
  const { wrapCustomEvaluatorPrompt } = require('../server/prompts');

  it('o wrapper pede 0–100 e proíbe mostrar a escala original ao aluno', () => {
    const out = wrapCustomEvaluatorPrompt('Some 5 eixos de 0 a 2 pontos (máx. 10).');
    // A régua do admin sobrevive…
    expect(out).toContain('Some 5 eixos de 0 a 2 pontos (máx. 10).');
    // …mas a saída é padronizada.
    expect(out).toContain('0–100');
    expect(out.toLowerCase()).toContain('converta');
    // Senão o selo diria 70 e o texto "7/10" — dois números para a mesma sessão.
    expect(out.toLowerCase()).toContain('nunca mostre ao aluno a nota na escala original');
  });

  // ⚠ NÃO auto-convertemos. Um `[NOTA:7]` é AMBÍGUO: pode ser um "7/10" não convertido, ou
  // um 7/100 legítimo (sessão péssima). Multiplicar por 10 na dúvida promoveria um aluno
  // que foi mal a um 70 — silenciosamente. Registramos o que veio e avisamos no log.
  it('uma nota baixa é registrada COMO VEIO (não é promovida a ×10)', async () => {
    const admin = await loginAs('admin');
    await request(app).post('/api/logs').set(authHeader(admin)).send({
      type: 'exercise', itemId: 'ex-test-1', mode: 'training',
      messages: [{ role: 'user', content: 'oi' }],
      evaluation: 'Sessão fraca. [NOTA:7]',
    });
    // 7 continua 7. Um aluno que foi mal não vira "70" por heurística.
    expect(readData('logs.json')[0].score).toBe(7);
  });

  it('a nota máxima de um exercício (100) cai na MELHOR faixa do badge, não na pior', async () => {
    const admin = await loginAs('admin');
    await request(app).post('/api/logs').set(authHeader(admin)).send({
      type: 'exercise', itemId: 'ex-test-1', mode: 'training',
      messages: [{ role: 'user', content: 'oi' }],
      evaluation: 'Excelente. [NOTA:100]',
    });
    const score = readData('logs.json')[0].score;
    expect(score).toBe(100);
    // O <ScoreBadge> pinta > 80 como a melhor faixa (f5). Antes, um "10" caía em f1
    // (<= 22) — vermelho, "Erro" — que é exatamente o bug que a padronização fecha.
    expect(score).toBeGreaterThan(80);
  });
});

// =====================================================================
// 9. AVALIAÇÃO POR IA — controle INDEPENDENTE por papel (pedido do usuário)
// =====================================================================
// O admin precisa poder liberar o avaliador só para o VISITANTE e bloquear para o ALUNO —
// e o contrário. O toggle antigo ("Avaliar sessões de visitante") só ligava/desligava o
// visitante; o aluno sempre tinha. Hoje são duas caixas independentes na matriz de acesso.
//
// Há DOIS níveis, e confundi-los é o erro fácil:
//   1. `evaluatorEnabled` — a CHAVE MESTRA (tela de Contas). Desligada, ninguém é avaliado.
//   2. `featureAccess.avaliacao.{aluno,visitante}` — QUEM recebe (tela de Acessos).
describe('avaliação por IA: aluno e visitante são independentes', () => {
  const avaliar = (token) =>
    request(app).post('/api/evaluate').set(authHeader(token))
      .send({ context: { type: 'freeplay', itemId: CHAR }, messages: [{ role: 'user', content: 'x' }] });

  // No harness não há OPENAI_API_KEY, então "liberado" = 503 (a chave falta) e "bloqueado"
  // = 200 com `{disabled:true}`. O que importa é a DISTINÇÃO entre os dois.
  const liberado = (res) => res.body.disabled !== true;

  it('visitante COM avaliador, aluno SEM', async () => {
    writeData('settings.json', {
      evaluatorEnabled: true,
      featureAccess: { avaliacao: { aluno: false, visitante: true } },
    });
    const aluno = await loginAs('aluno');
    const v = await loginVisitorFull();

    expect(liberado(await avaliar(aluno))).toBe(false);
    expect(liberado(await avaliar(v.token))).toBe(true);
  });

  it('aluno COM avaliador, visitante SEM (o inverso)', async () => {
    writeData('settings.json', {
      evaluatorEnabled: true,
      featureAccess: { avaliacao: { aluno: true, visitante: false } },
    });
    const aluno = await loginAs('aluno');
    const v = await loginVisitorFull();

    expect(liberado(await avaliar(aluno))).toBe(true);
    expect(liberado(await avaliar(v.token))).toBe(false);
  });

  // A chave mestra vence a matriz: é ela que protege a conta da OpenAI.
  it('chave mestra DESLIGADA → ninguém é avaliado, marque o que marcar', async () => {
    writeData('settings.json', {
      evaluatorEnabled: false,
      featureAccess: { avaliacao: { aluno: true, visitante: true } },
    });
    const aluno = await loginAs('aluno');
    const v = await loginVisitorFull();

    expect(liberado(await avaliar(aluno))).toBe(false);
    expect(liberado(await avaliar(v.token))).toBe(false);
  });
});

// =====================================================================
// 10. A NOTA NO TEXTO É A NOTA DO SISTEMA (achado ao vivo)
// =====================================================================
describe('a devolutiva não contradiz o selo', () => {
  // 🔴 ACHADO EM PRODUÇÃO. O avaliador global manda a IA abrir a devolutiva com
  // "**Nota: X/100**" — mas quem calcula a nota de verdade é o CÓDIGO, a partir das notas
  // por critério (a IA erra a conta, por isso o design é esse). E ela errou mesmo: numa
  // sessão real os critérios somavam 54 e ela escreveu "67/100".
  //
  // O aluno via 54 no selo e 67 no texto. Dois números para a mesma sessão — exatamente o
  // defeito que a padronização 0–100 existe para eliminar.
  it('a "Nota: X" que a IA escreveu é reescrita com a nota calculada', async () => {
    const admin = await loginAs('admin');
    await request(app).post('/api/logs').set(authHeader(admin)).send({
      type: 'freeplay', itemId: CHAR, mode: 'training',
      messages: [{ role: 'user', content: 'oi' }],
      // A IA chutou 67; os critérios dão (8+7)/20 → 75.
      evaluation: '**Nota: 67/100**\n\nFeedback.\n\n[notas-supervisor]\n1: 8\n2: 7',
    });

    const log = readData('logs.json')[0];
    expect(log.score).toBe(75);
    expect(log.evaluation).toContain('**Nota: 75/100**');
    expect(log.evaluation).not.toContain('67');   // o chute da IA sumiu
  });

  it('sem nota calculada, o texto passa intacto (não apagamos o que a IA escreveu)', async () => {
    const admin = await loginAs('admin');
    await request(app).post('/api/logs').set(authHeader(admin)).send({
      type: 'freeplay', itemId: CHAR, mode: 'training',
      messages: [{ role: 'user', content: 'oi' }],
      evaluation: '**Nota: 67/100**\n\nFeedback sem bloco de critérios.',
    });
    // Melhor manter o número da IA do que deixar a devolutiva sem nota nenhuma.
    expect(readData('logs.json')[0].evaluation).toContain('67');
  });
});
