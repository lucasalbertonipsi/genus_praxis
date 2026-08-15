// Configurações do sistema, efeito no /api/evaluate, health e export.
const {
  app, request, resetData, readData, writeData,
  loginAs, loginVisitor, authHeader,
} = require('./helpers');

beforeEach(() => resetData());

const get = (path, token) => request(app).get(path).set(authHeader(token));
const putAdminSettings = (token, body) =>
  request(app).put('/api/admin/settings').set(authHeader(token)).send(body);

const evalReq = (token, extra = {}) =>
  request(app).post('/api/evaluate').set(authHeader(token))
    .send({ messages: [{ role: 'user', content: 'oi' }], ...extra });

// Demanda #4: o `visitorEvaluationEnabled` virou uma célula da matriz
// (`featureAccess.avaliacao.visitante`). Os testes abaixo foram REESCRITOS para o novo
// contrato — o antigo travava um campo que não existe mais.
//
// `settings.json` sem `featureAccess` cai nos defaults do catálogo, e o default de
// `avaliacao.visitante` é FALSE (custo de IA) — vários testes daqui dependem disso.
const featureAccess = (over = {}) => ({ featureAccess: over });

describe('GET /api/settings', () => {
  it('qualquer autenticado lê o catálogo + a matriz + as SUAS features', async () => {
    const aluno = await loginAs('aluno');
    const res = await get('/api/settings', aluno);
    expect(res.status).toBe(200);
    expect(res.body.evaluatorEnabled).toBe(false);
    // O catálogo vem do servidor — o client não inventa chaves.
    expect(res.body.features.map((f) => f.key)).toContain('duelo');
    expect(res.body.featureRoles).toEqual(['aluno', 'visitante']);
    expect(res.body.featureAccess.duelo).toEqual({ aluno: true, visitante: true });
    // `myFeatures` já vem resolvido para quem pediu.
    expect(res.body.myFeatures.duelo).toBe(true);
    expect(typeof res.body.lockedFeatureMessage).toBe('string');
  });

  it('myFeatures é resolvido POR PAPEL: avaliação off p/ visitante, on p/ aluno', async () => {
    // O estado é montado EXPLICITAMENTE, não herdado dos defaults do catálogo: o que se
    // testa aqui é a resolução por papel, não qual é o padrão de fábrica. (A fixture
    // libera tudo para os dois papéis; quem cobre os defaults é `features.test.js`.)
    writeData('settings.json', featureAccess({ avaliacao: { aluno: true, visitante: false } }));
    const aluno = await loginAs('aluno');
    const v = await loginVisitor();
    expect((await get('/api/settings', aluno)).body.myFeatures.avaliacao).toBe(true);
    // O visitante nasce com TUDO bloqueado (decisão do dono do produto). A avaliação é
    // só o caso mais caro: cada uma é uma chamada de IA paga.
    expect((await get('/api/settings', v)).body.myFeatures.avaliacao).toBe(false);
  });

  // Admin e professor não entram na matriz: o acesso deles vem do papel. Se pudessem
  // ser bloqueados, um admin conseguiria se trancar para fora do próprio sistema.
  it('admin/professor têm TODAS as features, mesmo com a matriz toda desligada', async () => {
    writeData('settings.json', featureAccess({
      duelo: { aluno: false, visitante: false },
      ranking: { aluno: false, visitante: false },
    }));
    for (const who of ['admin', 'prof']) {
      const token = await loginAs(who);
      const res = await get('/api/settings', token);
      expect(res.body.myFeatures.duelo, who).toBe(true);
      expect(res.body.myFeatures.ranking, who).toBe(true);
    }
  });

  it('exige autenticação', async () => {
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(401);
  });

  it('reflete os valores do disco', async () => {
    writeData('settings.json', {
      evaluatorEnabled: true,
      lockedFeatureMessage: 'Fale com a secretaria.',
      featureAccess: { duelo: { aluno: false, visitante: true } },
    });
    const aluno = await loginAs('aluno');
    const res = await get('/api/settings', aluno);
    expect(res.body.evaluatorEnabled).toBe(true);
    expect(res.body.lockedFeatureMessage).toBe('Fale com a secretaria.');
    expect(res.body.myFeatures.duelo).toBe(false);
  });

  it('chave desconhecida no disco é DESCARTADA; feature ausente ganha o default', async () => {
    writeData('settings.json', featureAccess({
      naoExiste: { aluno: true },              // lixo → sumiu
      duelo: { aluno: false },                 // só metade → visitante fica no default
    }));
    const aluno = await loginAs('aluno');
    const res = await get('/api/settings', aluno);
    expect(res.body.featureAccess.naoExiste).toBeUndefined();
    expect(res.body.featureAccess.duelo).toEqual({ aluno: false, visitante: false });
    expect(res.body.featureAccess.ranking).toEqual({ aluno: true, visitante: false });
  });
});

describe('PUT /api/admin/settings', () => {
  it('aluno -> 403', async () => {
    const aluno = await loginAs('aluno');
    expect((await putAdminSettings(aluno, { evaluatorEnabled: true })).status).toBe(403);
  });

  it('professor -> 403', async () => {
    const prof = await loginAs('prof');
    expect((await putAdminSettings(prof, { evaluatorEnabled: true })).status).toBe(403);
  });

  it('admin liga o avaliador', async () => {
    const admin = await loginAs('admin');
    const res = await putAdminSettings(admin, { evaluatorEnabled: true });
    expect(res.status).toBe(200);
    expect(res.body.evaluatorEnabled).toBe(true);
    expect(readData('settings.json').evaluatorEnabled).toBe(true);
  });

  // O admin liga UMA célula na tela; o PUT não deve levar as outras junto.
  it('merge por CÉLULA: desligar duelo/visitante não mexe no aluno nem nas outras features', async () => {
    const admin = await loginAs('admin');
    const res = await putAdminSettings(admin, { featureAccess: { duelo: { visitante: false } } });
    expect(res.status).toBe(200);
    expect(res.body.featureAccess.duelo).toEqual({ aluno: true, visitante: false });
    expect(res.body.featureAccess.ranking).toEqual({ aluno: true, visitante: true });
    expect(readData('settings.json').featureAccess.duelo.visitante).toBe(false);
  });

  it('merge: mexer na matriz NÃO zera o evaluatorEnabled (e vice-versa)', async () => {
    writeData('settings.json', { evaluatorEnabled: true });
    const admin = await loginAs('admin');
    const res = await putAdminSettings(admin, { featureAccess: { duelo: { aluno: false } } });
    expect(res.body.evaluatorEnabled).toBe(true);
    expect(res.body.featureAccess.duelo.aluno).toBe(false);
  });

  it('chave de feature desconhecida é IGNORADA (não cria lixo no disco)', async () => {
    const admin = await loginAs('admin');
    const res = await putAdminSettings(admin, { featureAccess: { hackeada: { aluno: true } } });
    expect(res.status).toBe(200);
    expect(res.body.featureAccess.hackeada).toBeUndefined();
    expect(readData('settings.json').featureAccess.hackeada).toBeUndefined();
  });

  it('valores não-booleanos são coeridos com !!', async () => {
    const admin = await loginAs('admin');
    const res = await putAdminSettings(admin, {
      evaluatorEnabled: 'sim',
      featureAccess: { duelo: { aluno: 0, visitante: 'x' } },
    });
    expect(res.body.evaluatorEnabled).toBe(true);
    expect(res.body.featureAccess.duelo).toEqual({ aluno: false, visitante: true });
  });

  it('a mensagem do cadeado é editável e cai no default quando vazia (D6)', async () => {
    const admin = await loginAs('admin');
    const set = await putAdminSettings(admin, { lockedFeatureMessage: '  Fale com a secretaria.  ' });
    expect(set.body.lockedFeatureMessage).toBe('Fale com a secretaria.');

    const limpo = await putAdminSettings(admin, { lockedFeatureMessage: '   ' });
    expect(limpo.body.lockedFeatureMessage).toMatch(/não está liberada/i);
  });
});

// O ponto de verdade da demanda #4: a sidebar é UX, isto aqui é segurança.
describe('requireFeature — enforcement nas rotas', () => {
  const rotas = [
    ['duelo', 'get', '/api/duel/opponents'],
    ['ranking', 'get', '/api/ranking'],
    ['competitivo', 'get', '/api/me/mmr'],
    ['logsSociais', 'get', '/api/duels/social'],
    ['progressao', 'get', '/api/progression/available-patients'],
    ['objetivos', 'get', '/api/gamification/3'],
  ];

  it('feature desligada -> 403 com {locked, feature} (para o client abrir o pop-up)', async () => {
    for (const [feature, method, url] of rotas) {
      writeData('settings.json', featureAccess({ [feature]: { aluno: false, visitante: false } }));
      const aluno = await loginAs('aluno');
      const res = await request(app)[method](url).set(authHeader(aluno));
      expect(res.status, `${feature} ${url}`).toBe(403);
      expect(res.body.locked, feature).toBe(true);
      expect(res.body.feature, feature).toBe(feature);
      expect(typeof res.body.error).toBe('string');
    }
  });

  it('feature ligada -> a rota responde normalmente', async () => {
    for (const [, method, url] of rotas) {
      const aluno = await loginAs('aluno');
      const res = await request(app)[method](url).set(authHeader(aluno));
      expect(res.status, url).not.toBe(403);
    }
  });

  it('desligar para o VISITANTE não afeta o aluno', async () => {
    writeData('settings.json', featureAccess({ duelo: { aluno: true, visitante: false } }));
    const aluno = await loginAs('aluno');
    const v = await loginVisitor();
    expect((await request(app).get('/api/duel/opponents').set(authHeader(aluno))).status).toBe(200);
    expect((await request(app).get('/api/duel/opponents').set(authHeader(v))).status).toBe(403);
  });

  it('admin NÃO é bloqueável pela matriz (não dá para se trancar para fora)', async () => {
    writeData('settings.json', featureAccess({ ranking: { aluno: false, visitante: false } }));
    const admin = await loginAs('admin');
    expect((await request(app).get('/api/ranking').set(authHeader(admin))).status).toBe(200);
  });

  // Um duelo já ACEITO não pode ficar preso porque o admin desligou a feature no meio.
  // Por isso o guard fica na ENTRADA (criar/listar/aceitar), não nas rotas do duelo em
  // andamento (`GET /:id`, `submit`).
  it('duelo em ANDAMENTO sobrevive ao desligamento da feature', async () => {
    const aluno = await loginAs('aluno');
    const aluno2 = await loginAs('aluno2');
    const create = await request(app).post('/api/duel').set(authHeader(aluno))
      .send({ characterId: 'fp-test-1', opponentUserId: '5', inviteMethod: 'system' });
    const duelId = create.body.id;
    await request(app).post(`/api/duel/${duelId}/accept`).set(authHeader(aluno2));

    writeData('settings.json', featureAccess({ duelo: { aluno: false, visitante: false } }));

    // Não consegue criar um novo…
    expect((await request(app).post('/api/duel').set(authHeader(aluno))
      .send({ characterId: 'fp-test-1', inviteMethod: 'link' })).status).toBe(403);
    // …mas o que já estava em jogo continua acessível.
    expect((await request(app).get(`/api/duel/${duelId}`).set(authHeader(aluno))).status).toBe(200);
  });
});

describe('efeito das settings em POST /api/evaluate', () => {
  it('evaluatorEnabled=false -> {content:"", disabled:true} para aluno', async () => {
    const aluno = await loginAs('aluno');
    const res = await evalReq(aluno);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ content: '', disabled: true });
  });

  it('evaluatorEnabled=false -> disabled também para admin', async () => {
    const admin = await loginAs('admin');
    const res = await evalReq(admin);
    expect(res.body.disabled).toBe(true);
  });

  // ⚠ A avaliação NÃO usa `requireFeature`: bloqueada, ela responde `{disabled:true}` com
  // 200, porque o cliente conta com isso para encerrar a sessão com o agradecimento. Um
  // 403 quebraria o fim da sessão — é bloqueio de FEEDBACK, não de acesso à tela.
  it('ligado + visitante + avaliacao.visitante=false -> disabled (200, não 403)', async () => {
    writeData('settings.json', { evaluatorEnabled: true, featureAccess: { avaliacao: { visitante: false } } });
    const v = await loginVisitor();
    const res = await evalReq(v);
    expect(res.status).toBe(200);
    expect(res.body.disabled).toBe(true);
  });

  it('ligado + visitante + avaliacao.visitante=true -> NÃO disabled (503 sem OpenAI key)', async () => {
    // No harness OPENAI_API_KEY='' => getOpenAI() é null => 503, mas NÃO disabled.
    writeData('settings.json', { evaluatorEnabled: true, featureAccess: { avaliacao: { visitante: true } } });
    const v = await loginVisitor();
    const res = await evalReq(v);
    expect(res.body.disabled).toBeUndefined();
    expect(res.status).toBe(503);
  });

  it('avaliacao.aluno=false -> o ALUNO também fica sem devolutiva', async () => {
    writeData('settings.json', { evaluatorEnabled: true, featureAccess: { avaliacao: { aluno: false } } });
    const aluno = await loginAs('aluno');
    const res = await evalReq(aluno);
    expect(res.body.disabled).toBe(true);
  });

  it('ligado + aluno -> passa da barreira de disabled (503 sem OpenAI key)', async () => {
    writeData('settings.json', { evaluatorEnabled: true });
    const aluno = await loginAs('aluno');
    const res = await evalReq(aluno);
    // Comportamento REAL no modo de teste: sem chave da OpenAI, retorna 503.
    expect(res.status).toBe(503);
    expect(res.body.disabled).toBeUndefined();
  });

  it('messages ausente -> 400', async () => {
    const aluno = await loginAs('aluno');
    const res = await request(app).post('/api/evaluate').set(authHeader(aluno)).send({});
    expect(res.status).toBe(400);
  });
});

describe('GET /api/health (público)', () => {
  it('não exige auth e traz as chaves do contrato', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ok');
    expect(res.body).toHaveProperty('uptime');
    expect(res.body).toHaveProperty('dataDir');
    expect(res.body).toHaveProperty('dataWritable');
    expect(res.body).toHaveProperty('openai');
    expect(res.body).toHaveProperty('evaluator');
  });

  it('openai=false no modo de teste; evaluator reflete a config', async () => {
    writeData('settings.json', { evaluatorEnabled: true });
    const res = await request(app).get('/api/health');
    expect(res.body.openai).toBe(false);
    expect(res.body.evaluator).toBe(true);
  });
});

describe('GET /api/admin/export', () => {
  it('só admin -> aluno 403', async () => {
    const aluno = await loginAs('aluno');
    expect((await get('/api/admin/export', aluno)).status).toBe(403);
  });

  it('professor -> 403', async () => {
    const prof = await loginAs('prof');
    expect((await get('/api/admin/export', prof)).status).toBe(403);
  });

  it('admin -> 200 com content-disposition attachment', async () => {
    const admin = await loginAs('admin');
    const res = await get('/api/admin/export', admin);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.body.data).toBeTruthy();
    expect(res.body.data.settings).toBeTruthy();
    // O backup precisa ser COMPLETO — inclui as coleções que as demandas novas criaram.
    for (const chave of ['users', 'skills', 'announcements', 'settings']) {
      expect(res.body.data, chave).toHaveProperty(chave);
    }
  });
});
