// Catálogo de funcionalidades e quem pode usá-las (demanda #4).
//
// FONTE ÚNICA. O client lê esta lista via GET /api/settings para montar a sidebar
// (e desenhar o cadeado da demanda #3) — ele NÃO inventa chaves. O servidor usa a
// mesma lista no middleware `requireFeature`, que é o ponto de verdade: a sidebar é
// UX, e um usuário que digitar a URL na mão tem que levar 403 do mesmo jeito.
//
// ⚠ Só existem DOIS papéis configuráveis: aluno e visitante. Admin e professor não
// entram na matriz — eles não são "liberáveis", têm acesso pelo próprio papel (e
// bloquear o admin seria um jeito de se trancar para fora do sistema).

/**
 * As funcionalidades que o admin liga/desliga. `defaults` é o estado de um sistema
 * novo: **aluno com tudo, visitante com NADA**.
 *
 * O visitante nasce com tudo bloqueado por decisão do dono do produto: ele é um lead que
 * entra sem senha e pode entrar aos montes. O admin abre o que quiser, quando quiser, em
 * *Admin → Acessos* — e cada liberação passa a ser uma escolha consciente, não um padrão
 * herdado que ninguém revisou.
 *
 * O aluno segue com todas ligadas, inclusive `avaliacao` (o antigo
 * `visitorEvaluationEnabled`). Para o visitante essa é especialmente cara: cada avaliação
 * é uma chamada de IA paga.
 */
const FEATURES = [
  {
    key: 'competitivo',
    label: 'Competitivo',
    description: 'Partidas valendo MMR e posição no ranking.',
    defaults: { aluno: true, visitante: false },
  },
  {
    key: 'duelo',
    label: 'Duelo',
    description: 'Desafiar outro jogador no mesmo paciente. Visitante duela só com visitante.',
    defaults: { aluno: true, visitante: false },
  },
  {
    key: 'progressao',
    label: 'Progressão',
    description: 'Comparar dois atendimentos do mesmo paciente e medir a evolução.',
    defaults: { aluno: true, visitante: false },
  },
  {
    key: 'objetivos',
    label: 'Objetivos',
    description: 'Missões diárias, conquistas e constância (streak).',
    defaults: { aluno: true, visitante: false },
  },
  {
    key: 'logsSociais',
    label: 'Logs sociais',
    description: 'Histórico de duelos agrupado por oponente.',
    defaults: { aluno: true, visitante: false },
  },
  {
    key: 'ranking',
    label: 'Ranking',
    description: 'Tabela de posições. Aluno e visitante têm rankings SEPARADOS.',
    defaults: { aluno: true, visitante: false },
  },
  {
    key: 'avaliacao',
    label: 'Avaliação por IA',
    description: 'Feedback automático ao fim da sessão, por papel. CUSTA uma chamada de IA por avaliação. Depende da "Avaliação automática" (a chave mestra, em Contas) estar ligada.',
    defaults: { aluno: true, visitante: false },
  },
];

const FEATURE_KEYS = FEATURES.map((f) => f.key);
/** Os papéis que a matriz configura. Admin e professor ficam de fora de propósito. */
const FEATURE_ROLES = ['aluno', 'visitante'];

/** Papel do usuário → coluna da matriz. `null` = fora da matriz (admin/professor). */
function featureRoleOf(user) {
  if (!user) return null;
  if (user.role === 'visitor') return 'visitante';
  if (user.role === 'therapist') return 'aluno';
  return null; // admin e supervisor não são governados pela matriz
}

/** A matriz default de um sistema novo. */
function defaultFeatureAccess() {
  const out = {};
  for (const f of FEATURES) out[f.key] = { ...f.defaults };
  return out;
}

/**
 * Normaliza o que veio do disco (ou do admin) contra o catálogo:
 * descarta chave desconhecida, completa a que faltar com o default e força booleano.
 * Assim um `settings.json` antigo — ou uma feature nova adicionada num deploy — nunca
 * deixa o sistema num estado indefinido.
 */
function normalizeFeatureAccess(raw) {
  const out = defaultFeatureAccess();
  if (!raw || typeof raw !== 'object') return out;
  for (const f of FEATURES) {
    const row = raw[f.key];
    if (!row || typeof row !== 'object') continue;
    for (const role of FEATURE_ROLES) {
      if (role in row) out[f.key][role] = !!row[role];
    }
  }
  return out;
}

/**
 * O usuário pode usar a funcionalidade?
 * Quem está fora da matriz (admin, professor) pode sempre — o acesso deles vem do papel.
 */
function canUseFeature(access, user, key) {
  const role = featureRoleOf(user);
  if (role === null) return true;
  const row = normalizeFeatureAccess(access)[key];
  return row ? !!row[role] : true;
}

module.exports = {
  FEATURES,
  FEATURE_KEYS,
  FEATURE_ROLES,
  featureRoleOf,
  defaultFeatureAccess,
  normalizeFeatureAccess,
  canUseFeature,
};
