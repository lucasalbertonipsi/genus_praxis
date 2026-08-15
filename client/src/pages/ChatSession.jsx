import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { loadActiveSession, saveLocal, clearActiveSession } from '../sessionStore';
import ScoreBadge from '../components/ScoreBadge';
import LogActions from '../components/LogActions';
import CriteriaTable from '../components/CriteriaTable';
import { makeLogItems, evalSection as evalSectionTxt, downloadText, hasTranscript } from '../logFiles';
import { nextActiveElapsed, SESSION_LIMIT_SECONDS, SESSION_LIMIT_MINUTES } from '../sessionLimit';
import { useSkillsContext, skillLabel } from '../utils/skills';
import '../styles/Session.css';

// Sessão de EXERCÍCIO da Trilha de Competências (single-session, sem time skip).
// Rota: /chat/exercise/:id. O cliente do exercício abre a conversa; ao finalizar,
// o servidor avalia (avaliador global OU o evaluatorPrompt customizado do exercício,
// escolhido server-side pelo context) e o log é salvo com type:'exercise'.
const SESSION_TYPE = 'exercise';
const SAVE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const DIFFICULTY_LABEL = {
  iniciante: 'Iniciante',
  intermediario: 'Intermediário',
  avancado: 'Avançado',
};

// Mensagem (role: user) enviada ao avaliador com a transcrição.
function buildEvaluationMessage(exerciseTitle, transcript) {
  return `[LOG DO ATENDIMENTO — EXERCÍCIO]\nExercício: ${exerciseTitle}\n\n${transcript}`;
}

export default function ChatSession({ user }) {
  const { skills, names } = useSkillsContext();
  const { id } = useParams();
  const navigate = useNavigate();

  const canSeeReasoning = user?.role === 'supervisor' || user?.role === 'admin';

  const [item, setItem] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sessionStarted, setSessionStarted] = useState(false);
  const [sessionEnded, setSessionEnded] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [isTyping, setIsTyping] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState('');
  const [highlightTarget, setHighlightTarget] = useState(null);
  const [highlightDraft, setHighlightDraft] = useState('');
  const [confirmingFinalize, setConfirmingFinalize] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [showSaveLoad, setShowSaveLoad] = useState(false);

  // Pós-sessão
  const [savingLog, setSavingLog] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [evaluating, setEvaluating] = useState(false);
  const [evalError, setEvalError] = useState('');
  const [evaluationText, setEvaluationText] = useState('');
  const [evalScore, setEvalScore] = useState(null);
  const [criteriaScores, setCriteriaScores] = useState(null); // supervisor/admin
  const [reasoning, setReasoning] = useState('');             // supervisor/admin

  // Avaliador ligado? (por padrão NÃO — encerra com agradecimento.)
  const [evaluatorEnabled, setEvaluatorEnabled] = useState(false);

  const messagesEndRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const textareaRef = useRef(null);
  const timerRef = useRef(null);
  const autosaveTimerRef = useRef(null);
  const restoredRef = useRef(false);
  const finishedRef = useRef(false);
  const sessionDataRef = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    api.getSettings()
      .then((s) => { if (!cancelled) setEvaluatorEnabled(!!s.evaluatorEnabled); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Carrega exercício + tenta restaurar sessão ativa (F5 / sair e voltar).
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const list = await api.getExercises();
        const found = list.find((i) => String(i.id) === String(id));
        if (cancelled) return;
        if (!found) { setError('Exercício não encontrado.'); return; }
        setItem(found);
        if (!restoredRef.current && user?.id) {
          restoredRef.current = true;
          const saved = await loadActiveSession(user.id, SESSION_TYPE, id);
          if (cancelled) return;
          if (saved && Array.isArray(saved.messages) && saved.messages.length > 0) {
            setMessages(saved.messages);
            setElapsed(saved.elapsedSeconds || 0);
            setSessionStarted(true);
          }
        }
      } catch (err) {
        if (!cancelled) setError(err.message || 'Erro ao carregar exercício.');
      }
    }
    load();
    return () => { cancelled = true; };
  }, [id, user?.id]);

  // Autosave: localStorage síncrono + servidor com debounce. Desde a demanda #2 o
  // visitante persiste como qualquer aluno (ele é um usuário real, com id em users.json).
  useEffect(() => {
    if (!sessionStarted || sessionEnded || !item || !user?.id || finishedRef.current) return;
    const data = { messages, elapsedSeconds: elapsed, itemTitle: item.title };
    sessionDataRef.current = data;
    saveLocal(user.id, SESSION_TYPE, id, data);
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      if (finishedRef.current) return;
      api.saveActiveSession(SESSION_TYPE, id, data).catch(() => {});
    }, 1500);
    return () => { if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current); };
  }, [messages, elapsed, sessionStarted, sessionEnded, item, user?.id, id]);

  // Flush ao trocar de rota / fechar aba / background.
  useEffect(() => {
    if (!sessionStarted || sessionEnded || !user?.id) return;
    function flush() {
      if (finishedRef.current) return;
      const data = sessionDataRef.current;
      if (!data) return;
      saveLocal(user.id, SESSION_TYPE, id, data);
      api.saveActiveSession(SESSION_TYPE, id, data).catch(() => {});
    }
    function onVis() { if (document.visibilityState === 'hidden') flush(); }
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [sessionStarted, sessionEnded, user?.id, id]);

  // Cronômetro (só corre com a aba visível e a sessão em andamento).
  useEffect(() => {
    if (sessionStarted && !sessionEnded) {
      timerRef.current = setInterval(() => setElapsed(nextActiveElapsed), 1000);
      return () => clearInterval(timerRef.current);
    }
  }, [sessionStarted, sessionEnded]);

  const limitReached = elapsed >= SESSION_LIMIT_SECONDS;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  function formatTime(secs) {
    const m = Math.floor(secs / 60).toString().padStart(2, '0');
    const s = Math.floor(secs % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  async function sendToAI(text, currentMessages) {
    const apiMessages = [...currentMessages, { role: 'user', content: text }]
      .filter((m) => m && m.role)
      .map((m) => ({ role: m.role, content: m.content }));
    const data = await api.chat(apiMessages, { type: SESSION_TYPE, itemId: id });
    return typeof data === 'string' ? data : data.content || data.message || '';
  }

  async function handleStartSession() {
    if (!item) return;
    setError('');
    setSessionStarted(true);
    const kickoffMsg = { role: 'user', content: 'Iniciar', isSystem: true, highlighted: false, comment: '' };
    setMessages([kickoffMsg]);
    setIsTyping(true);
    try {
      const reply = await sendToAI('Iniciar', []);
      setMessages((prev) => [...prev, { role: 'assistant', content: reply }]);
    } catch (err) {
      setMessages((prev) => [...prev, { role: 'assistant', content: `Erro: ${err.message}` }]);
    } finally {
      setIsTyping(false);
      textareaRef.current?.focus();
    }
  }

  async function sendMessage(text) {
    const trimmed = text.trim();
    if (!trimmed || isTyping || !sessionStarted || sessionEnded || limitReached) return;
    const userMsg = { role: 'user', content: trimmed, highlighted: false, comment: '' };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setIsTyping(true);
    try {
      const reply = await sendToAI(trimmed, messages);
      setMessages((prev) => [...prev, { role: 'assistant', content: reply }]);
    } catch (err) {
      setMessages((prev) => [...prev, { role: 'assistant', content: `Erro: ${err.message}` }]);
    } finally {
      setIsTyping(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(input); }
  }

  function doReset() {
    setConfirmingReset(false);
    finishedRef.current = true;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    if (timerRef.current) clearInterval(timerRef.current);
    sessionDataRef.current = null;
    clearActiveSession(user.id, SESSION_TYPE, id);
    setMessages([]); setInput(''); setElapsed(0); setSessionStarted(false); setError('');
    setTimeout(() => { finishedRef.current = false; }, 0);
  }

  function downloadSave() {
    const save = {
      genusSave: true, version: 1, type: SESSION_TYPE, itemId: String(id), itemTitle: item?.title || '',
      messages, elapsedSeconds: elapsed, savedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(save, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `genus-save-exercicio-${(item?.title || 'sessao').replace(/\s+/g, '_')}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleLoadSaveFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const save = JSON.parse(reader.result);
        if (!save || save.genusSave !== true || !Array.isArray(save.messages)) throw new Error('Arquivo de save inválido.');
        if (save.type !== SESSION_TYPE || String(save.itemId) !== String(id)) throw new Error('Este save é de outro exercício. Abra o exercício correspondente para carregá-lo.');
        const savedAt = new Date(save.savedAt || 0).getTime();
        if (Number.isFinite(savedAt) && savedAt > 0 && Date.now() - savedAt > SAVE_TTL_MS) throw new Error('Este save expirou — saves valem por 30 dias.');
        finishedRef.current = false;
        setMessages(save.messages);
        setElapsed(Number.isFinite(save.elapsedSeconds) ? save.elapsedSeconds : 0);
        setSessionStarted(true);
        setError('');
      } catch (err) {
        setError(err.message || 'Não foi possível carregar o save.');
      }
    };
    reader.readAsText(file);
  }

  // Builders de texto (copiar/baixar).
  function buildLogHeader() {
    return [
      `Trilha · ${skillLabel(names, item?.skillId) || '—'}`,
      `Exercício: ${item?.title || '—'}`,
      `Dificuldade: ${DIFFICULTY_LABEL[item?.difficulty] || '—'}`,
      `Aluno: ${user?.name || '—'}`,
      `Duração: ${formatTime(elapsed)}`,
      evalScore !== null ? `Nota final: ${evalScore}` : null,
    ].filter(Boolean).join('\n');
  }
  function buildTranscript() {
    return messages.filter((m) => !m.isSystem).map((m) => {
      const author = m.role === 'user' ? (user?.name || 'Aluno') : (item?.title || 'Cliente');
      const star = m.highlighted ? ' ★' : '';
      const comment = m.highlighted && m.comment ? `\n   {${m.comment}}` : '';
      return `[${author}${star}]\n${m.content}${comment}`;
    }).join('\n\n---\n\n');
  }
  const logText = () => `${buildLogHeader()}\n\n---\n\n${buildTranscript()}`;
  const evalText = () => `${buildLogHeader()}${evalSectionTxt((evaluationText || '').trim())}`.trimEnd();
  const bothText = () => `${buildLogHeader()}\n\n---\n\n${buildTranscript()}${evalSectionTxt((evaluationText || '').trim())}`;

  // Há conversa de verdade? (a de kickoff é `isSystem`). Ver logFiles.js.
  const showLogButton = hasTranscript(messages);

  // Atalho no cabeçalho: baixa o log sem precisar finalizar a sessão. Durante o
  // atendimento ainda não há avaliação, e `evalSection('')` devolve '' — então
  // `bothText()` vira só o log.
  function downloadLog() {
    const base = (item?.title || 'exercicio').replace(/\s+/g, '_');
    downloadText(`trilha-${base}-${new Date().toISOString().slice(0, 10)}.txt`, bothText());
  }

  function handleFinalize() {
    if (!sessionStarted || sessionEnded) return;
    setConfirmingFinalize(true);
  }

  async function doFinalize() {
    setConfirmingFinalize(false);
    if (!sessionStarted || sessionEnded) return;
    finishedRef.current = true;
    const visibleMessages = messages.filter((m) => !m.isSystem);
    if (timerRef.current) clearInterval(timerRef.current);

    if (visibleMessages.length === 0) {
      setSessionEnded(true);
      clearActiveSession(user.id, SESSION_TYPE, id);
      return;
    }

    setSessionEnded(true);
    setSavingLog(true);
    if (evaluatorEnabled) setEvaluating(true);
    setSaveError('');
    setEvalError('');

    const transcriptText = visibleMessages.map((m) => {
      const author = m.role === 'user' ? user.name : (item?.title || 'Cliente');
      const star = m.highlighted ? ' ★' : '';
      const comment = m.highlighted && m.comment ? `\n   {${m.comment}}` : '';
      return `[${author}${star}]\n${m.content}${comment}`;
    }).join('\n\n---\n\n');

    // 1. Avaliação — só quando o avaliador está LIGADO. O servidor escolhe o
    //    avaliador global OU o evaluatorPrompt customizado do exercício (pelo
    //    context) e injeta o gabarito. Não é stream: recebemos o texto completo.
    let evalContent = '';
    let totalScore = null;
    let critScores = null;
    if (evaluatorEnabled) {
      try {
        const evalMsg = { role: 'user', content: buildEvaluationMessage(item?.title || '—', transcriptText) };
        const reply = await api.evaluate([evalMsg], { type: SESSION_TYPE, itemId: id });
        if (reply && !reply.disabled) {
          evalContent = typeof reply === 'string' ? reply : reply.content || '';
          if (reply && Number.isFinite(reply.score)) totalScore = reply.score;
          setEvaluationText(evalContent);
          setEvalScore(totalScore);
          // criteriaScores / reasoning só chegam para supervisor/admin.
          if (reply && reply.criteriaScores) { critScores = reply.criteriaScores; setCriteriaScores(reply.criteriaScores); }
          if (reply && reply.reasoning) setReasoning(reply.reasoning);
        }
      } catch (err) {
        setEvalError(err.message || 'Erro ao avaliar a sessão.');
      } finally {
        setEvaluating(false);
      }
    }

    // 2. Salva o log no histórico (sempre). O backend recomputa a nota (score)
    //    e, para exercícios, guarda a dificuldade server-side.
    try {
      const saved = await api.saveLog({
        userId: user.id,
        userName: user.name,
        type: SESSION_TYPE,
        itemId: id,
        itemTitle: item.title,
        messages: visibleMessages.map((m) => ({ role: m.role, content: m.content, highlighted: m.highlighted || false, comment: m.comment || '' })),
        durationSeconds: elapsed,
        score: totalScore,
        criteriaScores: critScores,
        evaluation: evalContent,
      });
      if (saved && Number.isFinite(saved.score)) setEvalScore(saved.score);
    } catch (err) {
      setSaveError(err.message || 'Erro ao salvar o log.');
    } finally {
      setSavingLog(false);
    }

    // 3. Progresso da trilha: guarda a melhor nota do exercício.
    if (totalScore !== null) {
      try {
        const current = await api.getProgress(user.id);
        const existing = current?.[id];
        const shouldUpdate = !existing || existing.score == null || totalScore > existing.score;
        if (shouldUpdate) {
          await api.saveProgress(user.id, {
            [id]: {
              score: totalScore,
              skillId: item.skillId,
              difficulty: item.difficulty,
              completedAt: new Date().toISOString(),
            },
          });
        }
      } catch { /* progresso é best-effort */ }
    }

    clearActiveSession(user.id, SESSION_TYPE, id);
  }

  async function toggleRecording() {
    if (!sessionStarted || sessionEnded || isTranscribing) return;
    if (isRecording) { mediaRecorderRef.current?.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setIsRecording(false);
        setIsTranscribing(true);
        const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        const reader = new FileReader();
        reader.onloadend = async () => {
          const base64 = reader.result.split(',')[1];
          try {
            const data = await api.transcribe(base64);
            const text = data.text || data.transcription || '';
            setInput((prev) => (prev ? prev + ' ' + text : text));
            textareaRef.current?.focus();
          } catch (err) {
            setError('Erro ao transcrever: ' + err.message);
          } finally {
            setIsTranscribing(false);
          }
        };
        reader.readAsDataURL(blob);
      };
      recorder.start();
      setIsRecording(true);
    } catch (err) {
      setError('Não foi possível acessar o microfone: ' + err.message);
    }
  }

  function openHighlight(idx) {
    const msg = messages[idx];
    if (!msg || msg.role !== 'user') return;
    setHighlightTarget({ idx });
    setHighlightDraft(msg.comment || '');
  }
  function saveHighlight() {
    if (!highlightTarget) return;
    setMessages((prev) => prev.map((m, i) => (i === highlightTarget.idx ? { ...m, highlighted: true, comment: highlightDraft.trim() } : m)));
    setHighlightTarget(null);
    setHighlightDraft('');
  }
  function removeHighlight(idx) {
    setMessages((prev) => prev.map((m, i) => (i === idx ? { ...m, highlighted: false, comment: '' } : m)));
  }

  // -------- TELA DE LOADING (avaliando — só se avaliador ligado) --------
  if (sessionEnded && evaluating) {
    return (
      <div className="session-page post-session">
        <div className="page-header">
          <div className="eyebrow">Exercício concluído</div>
          <h2>Avaliando seu <span className="accent">atendimento</span></h2>
          <p>A análise do exercício "{item?.title}" pode levar alguns segundos.</p>
          <div className="ornament" />
        </div>
        <div className="card evaluating-card">
          <div className="evaluating-orb"><div className="orb-pulse" /><div className="orb-pulse delay-1" /><div className="orb-pulse delay-2" /><div className="orb-core" /></div>
          <div className="evaluating-status">
            <div className="evaluating-line"><span className="dot active" /> Construindo a transcrição da sessão</div>
            <div className="evaluating-line"><span className="dot pulse" /> Analisando o atendimento</div>
            <div className="evaluating-line"><span className="dot" /> Calculando a nota final</div>
          </div>
        </div>
      </div>
    );
  }

  // -------- TELA PÓS-SESSÃO --------
  if (sessionEnded) {
    const visibleMessages = messages.filter((m) => !m.isSystem);
    const hasEval = !!(evaluationText || '').trim();
    return (
      <div className="session-page post-session">
        <div className="page-header">
          <div className="eyebrow">Exercício concluído</div>
          <h2>{hasEval ? <>Avaliação do seu <span className="accent">atendimento</span></> : <>Obrigado por <span className="accent">participar</span></>}</h2>
          <p>Exercício <strong>{item?.title}</strong> · duração {formatTime(elapsed)}</p>
          <div className="ornament" />
        </div>

        {saveError && <div className="alert error">Falha ao salvar log: {saveError}</div>}
        {evalError && <div className="alert error">Falha na avaliação: {evalError}</div>}

        <div className="card">
          {savingLog ? (
            <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--text-soft)' }}>
              <span className="spinner" /> <span style={{ marginLeft: 12 }}>Salvando log…</span>
            </div>
          ) : (
            <div className="thankyou-block">
              <div className="thankyou-check" aria-hidden="true">
                <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><polyline points="20 6 9 17 4 12" /></svg>
              </div>
              <p className="thankyou-text">
                {hasEval
                  ? 'O log completo deste exercício foi registrado no seu histórico.'
                  : 'Um dos nossos avaliadores recebeu o seu log e fará a análise. Obrigado por participar!'}
              </p>
            </div>
          )}

          <div className="post-session-stats">
            <div><span className="post-stat-label">Duração</span><span className="post-stat-value">{formatTime(elapsed)}</span></div>
            <div><span className="post-stat-label">Mensagens</span><span className="post-stat-value">{visibleMessages.length}</span></div>
            {evalScore !== null && (
              <div><span className="post-stat-label">Nota final</span><ScoreBadge score={evalScore} size="xl" /></div>
            )}
          </div>

          {hasEval && (
            <div className="post-evaluation">
              <h4>Análise</h4>
              <div className="post-evaluation-body">{evaluationText.trim()}</div>
            </div>
          )}

          {/* Notas por critério + raciocínio — só professor/admin. */}
          {canSeeReasoning && criteriaScores && <div style={{ marginTop: 14 }}><CriteriaTable criteriaScores={criteriaScores} /></div>}
          {canSeeReasoning && reasoning && (
            <details className="supervisor-reasoning">
              <summary>Raciocínio do avaliador <span className="section-sub">(só professor/admin)</span></summary>
              <div className="supervisor-reasoning-body">{reasoning}</div>
            </details>
          )}

          {visibleMessages.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <LogActions items={makeLogItems({ baseName: item?.title || 'exercicio', getLog: logText, getEval: hasEval ? evalText : null, getBoth: hasEval ? bothText : null })} />
            </div>
          )}

          <div className="post-session-actions">
            <button className="btn btn-primary" onClick={() => navigate('/skills')}>Voltar à trilha</button>
          </div>
        </div>
      </div>
    );
  }

  // -------- TELA DE CHAT --------
  return (
    <div className="session-page chat-container">
      <div className="chat-header">
        <button onClick={() => navigate(-1)} className="btn btn-outline btn-sm">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6" /></svg>
          Voltar
        </button>

        <div className="chat-title">
          <h3>{item?.title || '...'}</h3>
          <div className="chat-status">
            Trilha · {skillLabel(names, item?.skillId) || '—'}
            {item?.difficulty && <> · <span className="difficulty-tag">{DIFFICULTY_LABEL[item.difficulty] || item.difficulty}</span></>}
          </div>
        </div>

        <div className="chat-header-actions">
          {sessionStarted && (
            <div className={`timer-chip ${limitReached ? 'limit' : ''}`} title={limitReached ? `Limite de ${SESSION_LIMIT_MINUTES} min atingido` : 'Tempo no chat (pausa fora dele)'}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
              <span>{formatTime(elapsed)}</span>
            </div>
          )}
          {/* Baixar o log sem finalizar a sessão. Só faz sentido com conversa de
              verdade — a mensagem de kickoff é `isSystem` e não entra na transcrição. */}
          {showLogButton && (
            <button className="btn btn-outline btn-sm" onClick={downloadLog} title="Baixar o log desta sessão (.txt)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
              Log
            </button>
          )}
          {sessionStarted && (
            <>
              <button className="btn btn-outline btn-sm" onClick={() => setShowSaveLoad(true)} disabled={isTyping} title="Guardar ou carregar o progresso deste exercício">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" /><polyline points="17 21 17 13 7 13 7 21" /><polyline points="7 3 7 8 15 8" /></svg>
                Save/Load
              </button>
              <button className="btn btn-outline btn-sm btn-warn" onClick={() => setConfirmingReset(true)} disabled={isTyping} title="Reiniciar o exercício do zero">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.7 3" /><polyline points="3 3 3 8 8 8" /></svg>
                Reiniciar
              </button>
              <button className="btn btn-secondary btn-sm" onClick={handleFinalize}>Finalizar e enviar</button>
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="alert error">{error}<button onClick={() => setError('')} className="close">×</button></div>
      )}

      <div className={`chat-messages ${!sessionStarted ? 'locked' : ''}`}>
        {messages.filter((m) => !m.isSystem).length === 0 && !sessionStarted && (
          <div className="empty-chat">
            Ao iniciar, o cliente do exercício abre a conversa. Use o botão de destaque (★) para marcar suas próprias intervenções para revisão posterior.
          </div>
        )}

        {messages.map((msg, i) => {
          if (msg.isSystem) return null;
          const isUser = msg.role === 'user';
          const author = isUser ? user.name : (item?.title || 'Cliente');
          return (
            <div key={i}>
              <div className={`chat-message-row ${msg.role} ${msg.highlighted ? 'highlighted' : ''}`}>
                <div className="chat-message-author">{msg.highlighted && <span className="star-inline">★</span>} {author}</div>
                <div className={`chat-message ${msg.role}`}>{msg.content}</div>
                {isUser && (
                  <div className="message-tools">
                    {msg.highlighted ? (
                      <>
                        <button className="tool-btn active" onClick={() => openHighlight(i)} title="Editar destaque">★</button>
                        <button className="tool-btn" onClick={() => removeHighlight(i)} title="Remover destaque">×</button>
                      </>
                    ) : (
                      <button className="tool-btn" onClick={() => openHighlight(i)} title="Destacar mensagem">★</button>
                    )}
                  </div>
                )}
                {isUser && msg.highlighted && msg.comment && <div className="highlight-comment">{`{${msg.comment}}`}</div>}
              </div>
            </div>
          );
        })}

        {isTyping && (
          <div className="chat-message-row assistant">
            <div className="chat-message-author">{item?.title || 'Cliente'}</div>
            <div className="chat-message assistant" style={{ fontStyle: 'italic', opacity: 0.7 }}><span className="loading-dots">Pensando</span></div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {!sessionStarted ? (
        <div className="start-session-area">
          <div className="start-session-card">
            <h4>Pronto para começar?</h4>
            <p>Ao iniciar, o cliente do exercício abrirá a conversa.</p>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
              <button className="btn btn-primary btn-lg" onClick={handleStartSession} disabled={!item}>Iniciar atendimento</button>
              <button className="btn btn-outline btn-lg" onClick={() => fileInputRef.current?.click()} disabled={!item} title="Retomar a partir de um arquivo de save (.json)">Carregar save</button>
            </div>
          </div>
        </div>
      ) : isTranscribing ? (
        <div className="chat-input-area transcribing">
          <div className="transcribing-indicator"><span className="spinner" /><span>Transcrevendo áudio…</span></div>
        </div>
      ) : limitReached ? (
        <div className="chat-input-area session-limit-bar">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
          <span>Limite de {SESSION_LIMIT_MINUTES} min de sessão atingido. Finalize a sessão para concluir.</span>
        </div>
      ) : (
        <div className="chat-input-area">
          <textarea ref={textareaRef} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown}
            placeholder="Sua intervenção…  ·  Enter envia · Shift+Enter quebra linha" rows={1} disabled={isTyping} />
          <button type="button" className={`icon-btn ${isRecording ? 'recording' : ''}`} onClick={toggleRecording} title={isRecording ? 'Parar gravação' : 'Gravar áudio'} disabled={isTyping}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill={isRecording ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8">
              <rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0" /><line x1="12" y1="19" x2="12" y2="22" /><line x1="8" y1="22" x2="16" y2="22" />
            </svg>
          </button>
          <button type="button" className="icon-btn primary" onClick={() => sendMessage(input)} disabled={!input.trim() || isTyping} title="Enviar">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></svg>
          </button>
        </div>
      )}

      <input ref={fileInputRef} type="file" accept="application/json,.json" onChange={handleLoadSaveFile} style={{ display: 'none' }} />

      {showSaveLoad && (() => {
        const visibleCount = messages.filter((m) => !m.isSystem).length;
        return (
          <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setShowSaveLoad(false); }}>
            <div className="modal" style={{ maxWidth: 460 }}>
              <h3>Progresso do exercício</h3>
              <p className="modal-text">Guarde o progresso atual num arquivo (.json) para retomar depois, ou carregue um progresso salvo. Carregar substitui a conversa atual.</p>
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={() => { setShowSaveLoad(false); fileInputRef.current?.click(); }}>Carregar o progresso</button>
                <button type="button" className="btn btn-primary" onClick={() => { setShowSaveLoad(false); downloadSave(); }} disabled={visibleCount === 0} title={visibleCount === 0 ? 'A sessão ainda não tem mensagens' : 'Baixar o save deste exercício'}>Guardar o progresso</button>
              </div>
            </div>
          </div>
        );
      })()}

      {confirmingFinalize && (() => {
        const visibleCount = messages.filter((m) => !m.isSystem).length;
        const empty = visibleCount === 0;
        return (
          <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setConfirmingFinalize(false); }}>
            <div className="modal" style={{ maxWidth: 500 }}>
              <h3>{empty ? 'Exercício vazio' : 'Finalizar e enviar'}</h3>
              <p className="modal-text">
                {empty
                  ? 'O exercício ainda não tem mensagens. Deseja encerrar mesmo assim?'
                  : 'Tem certeza? O log completo será salvo no seu histórico e enviado para análise. Você não poderá continuar este exercício depois.'}
              </p>
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={() => setConfirmingFinalize(false)}>Cancelar</button>
                <button type="button" className="btn btn-primary" onClick={doFinalize}>{empty ? 'Encerrar mesmo assim' : 'Finalizar e enviar'}</button>
              </div>
            </div>
          </div>
        );
      })()}

      {confirmingReset && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setConfirmingReset(false); }}>
          <div className="modal" style={{ maxWidth: 460 }}>
            <h3>Reiniciar exercício</h3>
            <p className="modal-text">Tem certeza? Toda a conversa e o tempo decorrido serão <strong>perdidos</strong> e você voltará à tela de início. Esta ação não pode ser desfeita.</p>
            <div className="modal-actions">
              <button type="button" className="btn btn-outline" onClick={() => setConfirmingReset(false)}>Cancelar</button>
              <button type="button" className="btn btn-primary btn-warn-solid" onClick={doReset}>Sim, reiniciar</button>
            </div>
          </div>
        </div>
      )}

      {highlightTarget && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setHighlightTarget(null); }}>
          <div className="modal" style={{ maxWidth: 520 }}>
            <h3>Destacar mensagem</h3>
            <p className="modal-text">Por que você está destacando essa intervenção? <em>(opcional)</em></p>
            <textarea value={highlightDraft} onChange={(e) => setHighlightDraft(e.target.value)} placeholder="Ex: testei uma reformulação, cliente reagiu emocionalmente…" style={{ minHeight: 120 }} autoFocus />
            <div className="modal-actions">
              <button type="button" className="btn btn-outline" onClick={() => setHighlightTarget(null)}>Cancelar</button>
              <button type="button" className="btn btn-primary" onClick={saveHighlight}>Salvar destaque</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
