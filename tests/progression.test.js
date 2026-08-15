// IMPORTANTE: helpers seta as envs antes de importar o app — manter como 1º require.
const {
  app, request, resetData, writeData,
  loginAs, loginVisitor, authHeader, makeLog,
} = require('./helpers');

// No modo demonstração (OPENAI_API_KEY=''), /api/progression/evaluate devolve um
// texto de demonstração e criteria=null. Testamos os contratos (400/404), a dedup
// de pacientes disponíveis e o gate de criteria (só supervisor/admin).
const msgs = [
  { role: 'user', content: 'Como você está hoje?' },
  { role: 'assistant', content: 'Um pouco melhor.' },
];

describe('progressão', () => {
  beforeEach(() => resetData());

  // -------------------------------------------------------------------
  describe('GET /api/progression/available-patients', () => {
    it('sem atendimentos anteriores → lista vazia', async () => {
      const aluno = await loginAs('aluno');
      const res = await request(app).get('/api/progression/available-patients').set(authHeader(aluno));
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('traz só pacientes com atendimento anterior (messages.length > 0), com o shape esperado', async () => {
      writeData('logs.json', [
        makeLog({ userId: '3', itemId: 'fp-test-1' }),
      ]);
      const aluno = await loginAs('aluno');
      const res = await request(app).get('/api/progression/available-patients').set(authHeader(aluno));
      expect(res.status).toBe(200);
      expect(res.body.length).toBe(1);
      const p = res.body[0];
      expect(p.id).toBe('fp-test-1');
      expect(p.name).toBe('Sofia Test');
      expect(p.age).toBe(25);
      expect(p).toHaveProperty('description');
      expect(p).toHaveProperty('photoIcon');
      expect(p.lastAttendanceAt).toBeTruthy();
    });

    it('log com messages vazio NÃO conta como atendimento', async () => {
      writeData('logs.json', [
        makeLog({ userId: '3', itemId: 'fp-test-1', messages: [] }),
      ]);
      const aluno = await loginAs('aluno');
      const res = await request(app).get('/api/progression/available-patients').set(authHeader(aluno));
      expect(res.body).toEqual([]);
    });

    it('dedup por itemId: o atendimento mais recente vence (lastAttendanceAt)', async () => {
      const older = makeLog({ userId: '3', itemId: 'fp-test-1', daysAgo: 5 });
      const newer = makeLog({ userId: '3', itemId: 'fp-test-1', daysAgo: 1 });
      writeData('logs.json', [older, newer]);
      const aluno = await loginAs('aluno');
      const res = await request(app).get('/api/progression/available-patients').set(authHeader(aluno));
      const entries = res.body.filter((p) => p.id === 'fp-test-1');
      expect(entries.length).toBe(1);
      expect(new Date(entries[0].lastAttendanceAt).getTime()).toBe(new Date(newer.timestamp).getTime());
    });

    it('só mostra os atendimentos do próprio usuário', async () => {
      writeData('logs.json', [
        makeLog({ userId: '5', itemId: 'fp-test-2', itemTitle: 'Roberto Test' }),
      ]);
      const aluno = await loginAs('aluno'); // id 3
      const res = await request(app).get('/api/progression/available-patients').set(authHeader(aluno));
      expect(res.body).toEqual([]);
    });

    it('paciente cujo personagem foi deletado NÃO aparece', async () => {
      writeData('logs.json', [
        makeLog({ userId: '3', itemId: 'fp-DELETADO', itemTitle: 'Fantasma' }),
        makeLog({ userId: '3', itemId: 'fp-test-1' }),
      ]);
      const aluno = await loginAs('aluno');
      const res = await request(app).get('/api/progression/available-patients').set(authHeader(aluno));
      const ids = res.body.map((p) => p.id);
      expect(ids).toContain('fp-test-1');
      expect(ids).not.toContain('fp-DELETADO');
    });
  });

  // -------------------------------------------------------------------
  describe('POST /api/progression/evaluate', () => {
    it('sem atendimento anterior → 400 com mensagem', async () => {
      const aluno = await loginAs('aluno');
      const res = await request(app).post('/api/progression/evaluate').set(authHeader(aluno))
        .send({ characterId: 'fp-test-1', messages: msgs });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/atendimento anterior/i);
    });

    it('characterId inexistente → 404', async () => {
      const aluno = await loginAs('aluno');
      const res = await request(app).post('/api/progression/evaluate').set(authHeader(aluno))
        .send({ characterId: 'nao-existe', messages: msgs });
      expect(res.status).toBe(404);
    });

    it('characterId ausente → 400', async () => {
      const aluno = await loginAs('aluno');
      const res = await request(app).post('/api/progression/evaluate').set(authHeader(aluno))
        .send({ messages: msgs });
      expect(res.status).toBe(400);
    });

    it('messages não-lista → 400', async () => {
      writeData('logs.json', [makeLog({ userId: '3', itemId: 'fp-test-1' })]);
      const aluno = await loginAs('aluno');
      const res = await request(app).post('/api/progression/evaluate').set(authHeader(aluno))
        .send({ characterId: 'fp-test-1', messages: 'não é lista' });
      expect(res.status).toBe(400);
    });

    it('com atendimento anterior → 200; modo demo devolve texto e criteria=null para aluno', async () => {
      writeData('logs.json', [makeLog({ userId: '3', itemId: 'fp-test-1', evaluation: 'feedback anterior' })]);
      const aluno = await loginAs('aluno');
      const res = await request(app).post('/api/progression/evaluate').set(authHeader(aluno))
        .send({ characterId: 'fp-test-1', messages: msgs });
      expect(res.status).toBe(200);
      expect(res.body.evaluation).toMatch(/Modo demonstração/i);
      expect(res.body.criteria).toBe(null);
    });

    it('supervisor também recebe criteria (null no modo demo, mas presente na chave)', async () => {
      // O prof (id 2) precisa ter atendimento anterior próprio para avaliar.
      writeData('logs.json', [makeLog({ userId: '2', userName: 'Professor A', itemId: 'fp-test-1' })]);
      const prof = await loginAs('prof');
      const res = await request(app).post('/api/progression/evaluate').set(authHeader(prof))
        .send({ characterId: 'fp-test-1', messages: msgs });
      expect(res.status).toBe(200);
      // no modo demo criteria é null para todos; o gate de canSeeAllLogs só importa
      // quando há OpenAI — aqui validamos apenas que o supervisor consegue avaliar.
      expect(res.body).toHaveProperty('criteria');
    });

    it('não vaza o gabarito secreto do personagem na resposta', async () => {
      writeData('logs.json', [makeLog({ userId: '3', itemId: 'fp-test-1' })]);
      const aluno = await loginAs('aluno');
      const res = await request(app).post('/api/progression/evaluate').set(authHeader(aluno))
        .send({ characterId: 'fp-test-1', messages: msgs });
      expect(JSON.stringify(res.body)).not.toContain('GABARITO_SECRETO_NAO_VAZAR');
    });

    it('atendimento anterior de OUTRO usuário não habilita a avaliação → 400', async () => {
      // log é do aluno2 (id 5); o aluno (id 3) não tem atendimento anterior
      writeData('logs.json', [makeLog({ userId: '5', itemId: 'fp-test-1' })]);
      const aluno = await loginAs('aluno');
      const res = await request(app).post('/api/progression/evaluate').set(authHeader(aluno))
        .send({ characterId: 'fp-test-1', messages: msgs });
      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------
  describe('visitante', () => {
    it('available-patients: visitante não tem logs → lista vazia', async () => {
      const visitor = await loginVisitor();
      const res = await request(app).get('/api/progression/available-patients').set(authHeader(visitor));
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    // ⚠ CUSTO DE IA. A feature `avaliacao` nasce DESLIGADA para o visitante justamente
    // porque cada avaliação é uma chamada paga e um lead pode entrar aos montes. Mas a
    // progressão gastava IA sem consultá-la — bastava o admin ligar `progressao` e o gate
    // de custo virava letra morta. Agora ela responde `{disabled:true}` antes de gastar.
    //
    // (O nome antigo deste teste falava em "id efêmero": o visitante deixou de ser efêmero
    // na demanda #1, e o teste passou a testar outra coisa sem ninguém notar.)
    it('evaluate: visitante NÃO gasta IA quando `avaliacao` está desligada para ele', async () => {
      // Explícito: `progressao` liberada (senão o 403 do cadeado mascararia o resultado)
      // e `avaliacao` desligada — que é o gate de CUSTO sob teste aqui.
      writeData('settings.json', {
        evaluatorEnabled: true,
        featureAccess: {
          progressao: { aluno: true, visitante: true },
          avaliacao: { aluno: true, visitante: false },
        },
      });
      const visitor = await loginVisitor();
      const res = await request(app).post('/api/progression/evaluate').set(authHeader(visitor))
        .send({ characterId: 'fp-test-1', messages: msgs });

      expect(res.status).toBe(200);
      expect(res.body.disabled).toBe(true);
    });

    it('evaluate: com `avaliacao` LIGADA para o visitante, o fluxo normal volta', async () => {
      writeData('settings.json', {
        evaluatorEnabled: true,
        featureAccess: {
          // `progressao` precisa vir junto: este writeData substitui o settings INTEIRO, e
          // o default dela para visitante agora é bloqueado — sem isto o teste bateria no
          // cadeado (403) antes de chegar ao fluxo que ele quer exercitar.
          progressao: { aluno: true, visitante: true },
          avaliacao: { aluno: true, visitante: true },
        },
      });
      const visitor = await loginVisitor();
      const res = await request(app).post('/api/progression/evaluate').set(authHeader(visitor))
        .send({ characterId: 'fp-test-1', messages: msgs });

      // Sem atendimento anterior → 400 (a regra da progressão), NÃO mais o gate de custo.
      expect(res.body.disabled).toBeUndefined();
      expect(res.status).toBe(400);
    });
  });
});
