import { useState, useEffect, useMemo } from 'react';
import { api } from '../api';
import Typewriter from '../components/Typewriter';
import ScoreBadge from '../components/ScoreBadge';
import LogActions from '../components/LogActions';
import CriteriaTable from '../components/CriteriaTable';
import { useSkillsContext, skillLabel } from '../utils/skills';
import { makeLogItems, downloadText, criteriaSection } from '../logFiles';
import '../styles/Logs.css';

// Rótulos dos campos novos que os logs ganharam ao portar o backend do All_OS.
// SEM neuro: só exercise|freeplay.
const TYPE_LABELS = { exercise: 'Trilha', freeplay: 'Simulação' };
const MODE_LABELS = { competitive: 'Competitivo', training: 'Treino' };

function TypeBadge({ log }) {
  if (!log.type) return null;
  const label = TYPE_LABELS[log.type] || log.type;
  return <span className={`log-type-badge log-type-${log.type}`}>{label}</span>;
}
function ModeBadge({ log }) {
  // mode só é significativo em freeplay (competitive alimenta o MMR).
  if (log.type !== 'freeplay' || !log.mode) return null;
  const label = MODE_LABELS[log.mode] || log.mode;
  return <span className={`log-mode-badge log-mode-${log.mode}`}>{label}</span>;
}
function DifficultyBadge({ log }) {
  if (!log.difficulty) return null;
  return <span className="log-diff-badge">{log.difficulty}</span>;
}
function SkillBadge({ log }) {
  // Competência treinada. Só exercícios da trilha têm; o servidor resolve o
  // skillId a partir do exercises.json (o cliente não o envia).
  const { names } = useSkillsContext();
  if (!log.skillId) return null;
  return <span className="log-skill-badge">{skillLabel(names, log.skillId)}</span>;
}

function formatDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (isNaN(d)) return '—';
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function sanitizeFilename(name) {
  return (name || 'log').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '_').slice(0, 80);
}
// Data de expiração de um log. Só existe se o servidor a informar (`expiresAt`). Com o TTL
// desligado (decisão de 2026-07-14), o servidor manda `expiresAt: null` e nada expira —
// por isso NÃO há mais fallback local inventando uma data de 30 dias.
function logExpiresAt(log) {
  return log.expiresAt ? new Date(log.expiresAt) : null;
}
function daysUntilExpiry(log) {
  const exp = logExpiresAt(log);
  if (!exp) return null;
  return Math.ceil((exp.getTime() - Date.now()) / 86400000);
}
function ExpiryNote({ log }) {
  const exp = logExpiresAt(log);
  if (!exp) return null;   // TTL desligado ou log sem data → sem selo de expiração
  const days = daysUntilExpiry(log);
  const soon = days != null && days <= 7;
  return (
    <span className={`expiry-note ${soon ? 'soon' : ''}`} title="Após esta data o log é removido automaticamente">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><path d="M12 8v4l3 2" /></svg>
      expira {exp.toLocaleDateString('pt-BR')}{soon && days >= 0 ? ` · ${days}d` : ''}
    </span>
  );
}

function buildLogStrings(log, names = {}) {
  const messages = Array.isArray(log.messages) ? log.messages : [];
  const skillName = skillLabel(names, log.skillId);
  const header = [
    `Terapeuta: ${log.userName || '—'}`,
    `Cliente: ${log.itemTitle || '—'}`,
    skillName ? `Competência: ${skillName}` : null,
    `Sessões: ${log.sessionCount || 1}`,
    `Data: ${formatDate(log.timestamp)}`,
  ].filter(Boolean).join('\n');
  const transcript = messages.filter((m) => !m.isSystem).map((m) => {
    const isUser = m.role === 'user';
    const author = isUser ? (log.userName || 'Terapeuta') : (log.itemTitle || 'Cliente');
    const star = m.highlighted ? ' ★' : '';
    const comment = m.highlighted && m.comment ? `\n   {${m.comment}}` : '';
    return `[${author}${star}]\n${m.content}${comment}`;
  }).join('\n\n---\n\n');
  const scoreLine = log.score != null ? `Nota final: ${log.score}\n\n` : '';
  const evalPart = log.evaluation ? `\n\n===========================\nAVALIAÇÃO\n===========================\n\n${scoreLine}${log.evaluation}` : '';
  // Notas por critério só existem nos downloads de professor/admin — o servidor
  // nem envia `criteriaScores` para o aluno.
  const criteriaPart = criteriaSection(log.criteriaScores);
  return {
    logStr: `${header}\n\n---\n\n${transcript}`,
    evalStr: `${header}${evalPart}${criteriaPart}`,
    bothStr: `${header}\n\n---\n\n${transcript}${evalPart}${criteriaPart}`,
    hasEval: !!evalPart || !!criteriaPart,
  };
}

function downloadLogAsText(log, names) {
  const stamp = (log.timestamp || new Date().toISOString()).slice(0, 10);
  downloadText(
    `log-${sanitizeFilename(log.userName)}-${sanitizeFilename(log.itemTitle)}-${stamp}.txt`,
    buildLogStrings(log, names).bothStr,
  );
}

function logItemsFor(log, names) {
  const base = `${sanitizeFilename(log.userName)}-${sanitizeFilename(log.itemTitle)}`;
  const hasEval = !!(log.evaluation || (log.criteriaScores && Object.keys(log.criteriaScores).length));
  return makeLogItems({
    baseName: base,
    getLog: () => buildLogStrings(log, names).logStr,
    getEval: hasEval ? () => buildLogStrings(log, names).evalStr : null,
    getBoth: hasEval ? () => buildLogStrings(log, names).bothStr : null,
  });
}

// --- Detalhe de um log (transcrição + avaliação) ---
function LogMessages({ log }) {
  const messages = Array.isArray(log.messages) ? log.messages.filter((m) => !m.isSystem) : [];
  if (messages.length === 0) return <p className="muted-italic">Nenhuma mensagem registrada nesta sessão.</p>;
  return (
    <>
      {messages.map((msg, i) => {
        const isUser = msg.role === 'user';
        return (
          <div key={i} className={`msg ${isUser ? 'user' : 'assistant'}`}>
            <strong>{isUser ? (log.userName || 'Terapeuta') : (log.itemTitle || 'Cliente')}{msg.highlighted ? ' ★' : ''}</strong>
            {msg.content}
            {msg.highlighted && msg.comment && <div className="log-comment">{`{${msg.comment}}`}</div>}
          </div>
        );
      })}
    </>
  );
}

// Um log pode ter notas por critério sem texto de avaliação (e vice-versa).
// `criteriaScores` só chega para professor/admin — o servidor o remove do aluno.
function hasCriteria(log) {
  return !!(log.criteriaScores && Object.keys(log.criteriaScores).length);
}

function LogCard({ log, canDelete, onDelete }) {
  const { names } = useSkillsContext();
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState('log');
  const evaluation = (log.evaluation || '').trim();
  const showEval = !!evaluation || hasCriteria(log);
  const messages = Array.isArray(log.messages) ? log.messages : [];
  return (
    <div className={`log-card ${expanded ? 'expanded' : ''}`} onClick={() => setExpanded((v) => !v)}>
      <div className="log-meta">
        <span><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></svg>{formatDate(log.timestamp)}</span>
        {log.userName && <span><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>{log.userName}</span>}
        <span>{log.sessionCount || 1} {(log.sessionCount || 1) === 1 ? 'sessão' : 'sessões'}</span>
        <span>{messages.filter((m) => !m.isSystem).length} mensagens</span>
        <ExpiryNote log={log} />
      </div>
      <div className="log-badges">
        <TypeBadge log={log} />
        <ModeBadge log={log} />
        <DifficultyBadge log={log} />
        <SkillBadge log={log} />
      </div>
      <div className="log-card-head">
        <h4>{log.itemTitle || 'Sessão sem título'}</h4>
        <div className="log-card-head-right">
          <ScoreBadge score={log.score} />
          <span className="expand-hint">{expanded ? 'ocultar' : 'expandir'}</span>
        </div>
      </div>
      {expanded && (
        <div className="log-detail" onClick={(e) => e.stopPropagation()}>
          <div className="log-view-tabs">
            <span className="log-view-label">Visualizar</span>
            <button type="button" className={`btn ${tab === 'log' ? 'btn-primary' : 'btn-ghost'} btn-sm`} onClick={() => setTab('log')}>Log da sessão</button>
            <button type="button" className={`btn ${tab === 'evaluation' ? 'btn-primary' : 'btn-ghost'} btn-sm`} onClick={() => setTab('evaluation')} disabled={!showEval} title={showEval ? 'Ver avaliação' : 'Sem avaliação registrada'}>
              Avaliação {showEval ? '' : '(sem registro)'}
            </button>
          </div>
          <div style={{ margin: '10px 0 14px' }}>
            <LogActions items={logItemsFor(log, names)} inline />
            {canDelete && (
              <button type="button" className="btn btn-danger btn-sm" style={{ marginLeft: 8 }} onClick={() => onDelete(log)}>Excluir log</button>
            )}
          </div>
          {tab === 'log' ? <LogMessages log={log} /> : (
            showEval ? (
              <div>
                <CriteriaTable criteriaScores={log.criteriaScores} />
                {evaluation && <div className="evaluation-body">{evaluation}</div>}
              </div>
            ) : <p className="muted-italic">Esta sessão não tem avaliação registrada.</p>
          )}
        </div>
      )}
    </div>
  );
}

// =====================================================================
// VISÃO DO ALUNO — Clientes → Datas → Detalhe
// =====================================================================
function StudentView({ logs }) {
  const { names } = useSkillsContext();
  const [selectedKey, setSelectedKey] = useState(null);
  const [selectedLogId, setSelectedLogId] = useState(null);
  const [tab, setTab] = useState('log');

  const patients = useMemo(() => {
    const map = new Map();
    for (const log of logs) {
      const key = log.itemId || log.itemTitle || '__sem-cliente';
      if (!map.has(key)) map.set(key, { key, name: log.itemTitle || 'Sem nome', type: log.type, logs: [] });
      map.get(key).logs.push(log);
    }
    const arr = Array.from(map.values()).map((p) => {
      const sorted = p.logs.slice().sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
      return { ...p, logs: sorted, lastTs: new Date(sorted[0]?.timestamp || 0).getTime() };
    });
    arr.sort((a, b) => b.lastTs - a.lastTs);
    return arr;
  }, [logs]);

  const selectedPatient = patients.find((p) => p.key === selectedKey) || null;
  const selectedLog = selectedPatient?.logs.find((l) => l.id === selectedLogId) || null;

  if (selectedLog) {
    const evaluation = (selectedLog.evaluation || '').trim();
    const showEval = !!evaluation || hasCriteria(selectedLog);
    return (
      <div>
        <BackButton onClick={() => { setSelectedLogId(null); setTab('log'); }}>Voltar para sessões de {selectedPatient?.name}</BackButton>
        <div className="detail-head">
          <div className="detail-eyebrow">{selectedPatient?.name}</div>
          <h3>Sessão de {formatDate(selectedLog.timestamp)}</h3>
          <div className="detail-sub">
            <span>{selectedLog.sessionCount || 1} {(selectedLog.sessionCount || 1) === 1 ? 'sessão' : 'sessões'}</span>
            <TypeBadge log={selectedLog} />
            <ModeBadge log={selectedLog} />
            <DifficultyBadge log={selectedLog} />
            <SkillBadge log={selectedLog} />
            <ScoreBadge score={selectedLog.score} />
            <ExpiryNote log={selectedLog} />
          </div>
          <div style={{ marginTop: 12 }}><LogActions items={logItemsFor(selectedLog, names)} inline /></div>
        </div>
        <div className="card tight log-view-tabs-card">
          <div className="log-view-tabs">
            <span className="log-view-label">Visualizar</span>
            <button type="button" className={`btn ${tab === 'log' ? 'btn-primary' : 'btn-ghost'} btn-sm`} onClick={() => setTab('log')}>Log da sessão</button>
            <button type="button" className={`btn ${tab === 'evaluation' ? 'btn-primary' : 'btn-ghost'} btn-sm`} onClick={() => setTab('evaluation')} disabled={!showEval}>Avaliação {showEval ? '' : '(sem registro)'}</button>
          </div>
        </div>
        <div className="card tight">
          {tab === 'log' ? <LogMessages log={selectedLog} /> : (
            showEval ? (
              <div>
                <CriteriaTable criteriaScores={selectedLog.criteriaScores} />
                {evaluation && <div className="evaluation-body">{evaluation}</div>}
              </div>
            ) : <p className="muted-italic">Esta sessão não tem avaliação registrada.</p>
          )}
        </div>
      </div>
    );
  }

  if (selectedPatient) {
    return (
      <div>
        <BackButton onClick={() => setSelectedKey(null)}>Voltar para clientes</BackButton>
        <div className="detail-head">
          <h3>{selectedPatient.name}</h3>
          <p className="muted">{selectedPatient.logs.length} {selectedPatient.logs.length === 1 ? 'sessão registrada' : 'sessões registradas'}. Escolha uma data.</p>
        </div>
        <div className="session-list">
          {selectedPatient.logs.map((log) => {
            const dur = log.durationSeconds || 0;
            const mm = Math.floor(dur / 60).toString().padStart(2, '0');
            const ss = (dur % 60).toString().padStart(2, '0');
            return (
              <div key={log.id} className="card tight session-list-item" onClick={() => { setSelectedLogId(log.id); setTab('log'); }} role="button" tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { setSelectedLogId(log.id); setTab('log'); } }}>
                <div>
                  <div className="session-list-date">{formatDate(log.timestamp)}</div>
                  <div className="session-list-sub">
                    <span>{dur > 0 ? `Duração ${mm}:${ss}` : 'sem duração'} · {log.sessionCount || 1} {(log.sessionCount || 1) === 1 ? 'sessão' : 'sessões'}</span>
                    <TypeBadge log={log} />
                    <ModeBadge log={log} />
                    <ExpiryNote log={log} />
                  </div>
                </div>
                <div className="session-list-right"><ScoreBadge score={log.score} /><span className="expand-hint">abrir →</span></div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  if (patients.length === 0) {
    return <div className="card empty-state">Você ainda não atendeu nenhum cliente.</div>;
  }
  return (
    <div>
      <p className="muted list-count">{patients.length} {patients.length === 1 ? 'cliente atendido' : 'clientes atendidos'}</p>
      <div className="card-grid">
        {patients.map((p) => (
          <div key={p.key} className="character-card" onClick={() => setSelectedKey(p.key)} role="button" tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSelectedKey(p.key); }}>
            <div className="character-card-header">
              <h3>{p.name}</h3>
              {p.type && <span className={`log-type-badge log-type-${p.type}`}>{TYPE_LABELS[p.type] || p.type}</span>}
            </div>
            <p>{p.logs.length} {p.logs.length === 1 ? 'sessão' : 'sessões'}{p.lastTs ? ` · última em ${formatDate(new Date(p.lastTs).toISOString())}` : ''}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function BackButton({ children, onClick }) {
  return (
    <button type="button" className="btn btn-ghost btn-sm back-btn" onClick={onClick}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6" /></svg>
      {children}
    </button>
  );
}

// =====================================================================
// VISÃO PROFESSOR/ADMIN — filtros, ordenação e agrupamento por pessoa
// =====================================================================
function TherapistGroup({ name, logs, canDelete, onDelete }) {
  const { names } = useSkillsContext();
  const [open, setOpen] = useState(true);
  const lastTs = logs.reduce((acc, l) => { const t = new Date(l.timestamp || 0).getTime(); return Number.isFinite(t) && t > acc ? t : acc; }, 0);
  return (
    <div className="therapist-group">
      <div className="therapist-group-head" onClick={() => setOpen((v) => !v)}>
        <div className="therapist-group-title">
          <h3>{name || 'Terapeuta sem nome'}</h3>
          <span className="muted">{logs.length} {logs.length === 1 ? 'sessão' : 'sessões'}{lastTs ? ` · última ${formatDate(new Date(lastTs).toISOString())}` : ''}</span>
        </div>
        <div className="therapist-group-actions">
          <button type="button" className="btn btn-outline btn-sm" onClick={(e) => { e.stopPropagation(); logs.forEach((l) => downloadLogAsText(l, names)); }} title="Baixar todos os logs deste terapeuta">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
            Baixar todos
          </button>
          <span className="expand-hint">{open ? 'ocultar' : 'expandir'}</span>
        </div>
      </div>
      {open && logs.map((log) => <LogCard key={log.id} log={log} canDelete={canDelete} onDelete={onDelete} />)}
    </div>
  );
}

function AllLogsView({ logs, canDelete, onDelete }) {
  const [therapistQuery, setTherapistQuery] = useState('');
  const [patientQuery, setPatientQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('all'); // all | exercise | freeplay
  const [modeFilter, setModeFilter] = useState('all'); // all | competitive | training
  const [sort, setSort] = useState('recent'); // recent | old | therapist | patient
  const [grouped, setGrouped] = useState(true);

  const filtered = useMemo(() => {
    const tq = therapistQuery.trim().toLowerCase();
    const pq = patientQuery.trim().toLowerCase();
    let arr = logs.filter((l) =>
      (!tq || (l.userName || '').toLowerCase().includes(tq)) &&
      (!pq || (l.itemTitle || '').toLowerCase().includes(pq)) &&
      (typeFilter === 'all' || l.type === typeFilter) &&
      (modeFilter === 'all' || l.mode === modeFilter),
    );
    const byDate = (a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0);
    if (sort === 'recent') arr = arr.slice().sort(byDate);
    else if (sort === 'old') arr = arr.slice().sort((a, b) => -byDate(a, b));
    else if (sort === 'therapist') arr = arr.slice().sort((a, b) => (a.userName || '').localeCompare(b.userName || '', 'pt-BR') || byDate(a, b));
    else if (sort === 'patient') arr = arr.slice().sort((a, b) => (a.itemTitle || '').localeCompare(b.itemTitle || '', 'pt-BR') || byDate(a, b));
    return arr;
  }, [logs, therapistQuery, patientQuery, typeFilter, modeFilter, sort]);

  const groups = useMemo(() => {
    if (!grouped) return null;
    const byUser = new Map();
    for (const log of filtered) {
      const key = log.userId || log.userName || '__sem-id';
      if (!byUser.has(key)) byUser.set(key, { name: log.userName || 'Terapeuta sem nome', logs: [] });
      byUser.get(key).logs.push(log);
    }
    const arr = Array.from(byUser.values());
    if (sort === 'therapist') arr.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'pt-BR'));
    else arr.sort((a, b) => {
      const ta = new Date(a.logs[0]?.timestamp || 0).getTime();
      const tb = new Date(b.logs[0]?.timestamp || 0).getTime();
      return sort === 'old' ? ta - tb : tb - ta;
    });
    return arr;
  }, [filtered, grouped, sort]);

  return (
    <div>
      <div className="logs-toolbar">
        <div className="logs-filter">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
          <input type="text" value={therapistQuery} onChange={(e) => setTherapistQuery(e.target.value)} placeholder="Filtrar por terapeuta…" />
        </div>
        <div className="logs-filter">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
          <input type="text" value={patientQuery} onChange={(e) => setPatientQuery(e.target.value)} placeholder="Filtrar por cliente…" />
        </div>
        <select className="logs-sort" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} title="Filtrar por tipo">
          <option value="all">Todos os tipos</option>
          <option value="exercise">Trilha</option>
          <option value="freeplay">Simulação</option>
        </select>
        <select className="logs-sort" value={modeFilter} onChange={(e) => setModeFilter(e.target.value)} title="Filtrar por modo">
          <option value="all">Todos os modos</option>
          <option value="competitive">Competitivo</option>
          <option value="training">Treino</option>
        </select>
        <select className="logs-sort" value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="recent">Mais recentes</option>
          <option value="old">Mais antigos</option>
          <option value="therapist">Terapeuta (A–Z)</option>
          <option value="patient">Cliente (A–Z)</option>
        </select>
        <label className="logs-group-toggle">
          <input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} />
          Agrupar por pessoa
        </label>
      </div>

      <p className="muted list-count">{filtered.length} {filtered.length === 1 ? 'sessão' : 'sessões'}{grouped && groups ? ` · ${groups.length} ${groups.length === 1 ? 'terapeuta' : 'terapeutas'}` : ''}</p>

      {filtered.length === 0 ? (
        <div className="card empty-state">Nenhuma sessão corresponde aos filtros.</div>
      ) : grouped ? (
        groups.map((g, i) => <TherapistGroup key={i} name={g.name} logs={g.logs} canDelete={canDelete} onDelete={onDelete} />)
      ) : (
        filtered.map((log) => <LogCard key={log.id} log={log} canDelete={canDelete} onDelete={onDelete} />)
      )}
    </div>
  );
}

// =====================================================================
export default function Logs({ user, userId }) {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // 0 = TTL desligado (o padrão atual). O useEffect abaixo corrige se o servidor
  // devolver um TTL ligado — daí o aviso de expiração reaparece.
  const [ttlDays, setTtlDays] = useState(0);
  const isAdmin = user.role === 'admin';
  // Modo "meus logs": aluno sempre; ou quando a rota passa userId={user.id}
  // explicitamente (/logs). A rota /supervisor renderiza SEM userId → o
  // professor/admin vê os logs de todos os alunos.
  const isStudent = user.role === 'therapist' || (userId != null && userId === user.id);
  // userId específico a consultar no backend (aluno vê só o dele).
  const queryUserId = user.role === 'therapist' ? user.id : (userId ?? undefined);

  function reload() {
    setLoading(true);
    setError('');
    api.getLogs(queryUserId)
      .then(setLogs)
      .catch((err) => setError(err.message || 'Erro ao carregar logs'))
      .finally(() => setLoading(false));
  }
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [user.id, userId]);
  useEffect(() => { api.getLogsPolicy().then((p) => { if (p && p.ttlDays) setTtlDays(p.ttlDays); }).catch(() => {}); }, []);

  async function handleDelete(log) {
    if (!window.confirm(`Excluir o log de "${log.itemTitle}" (${log.userName})?`)) return;
    try { await api.deleteLog(log.id); setLogs((prev) => prev.filter((l) => l.id !== log.id)); }
    catch (err) { setError(err.message || 'Erro ao excluir log'); }
  }

  const title = isStudent ? 'Meus logs' : 'Todos os logs';
  const subtitle = isStudent
    ? 'Clientes que você atendeu. Clique em um para ver as datas e abrir o log de cada sessão.'
    : 'Histórico de todas as sessões da plataforma. Filtre, ordene, agrupe por pessoa, visualize e baixe.';

  return (
    <div>
      <div className="page-header">
        <div className="eyebrow">Histórico</div>
        <h2><Typewriter text={title} /></h2>
        <p>{subtitle}</p>
        <div className="ornament" />
      </div>

      {error && <div className="alert error">{error}</div>}

      {/* O aviso de expiração só aparece se o TTL estiver LIGADO. Com o TTL desligado
          (o padrão atual), ele mentiria — os logs ficam no volume até serem apagados
          manualmente. `ttlDays` vem do servidor (GET /api/logs/policy). */}
      {ttlDays > 0 && (
        <div className="log-expiry-banner">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
          <span>Os logs expiram automaticamente após <strong>{ttlDays} dias</strong>. Baixe os que quiser guardar antes disso.</span>
        </div>
      )}

      {loading ? (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}><span className="spinner" /> <span style={{ marginLeft: 12 }}>Carregando sessões…</span></div>
      ) : isStudent ? (
        <StudentView logs={logs} />
      ) : logs.length === 0 ? (
        <div className="card empty-state">Nenhuma sessão registrada na plataforma ainda.</div>
      ) : (
        <AllLogsView logs={logs} canDelete={isAdmin} onDelete={handleDelete} />
      )}
    </div>
  );
}
