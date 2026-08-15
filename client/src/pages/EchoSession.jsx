import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { api, assetUrl } from '../api';
import { loadActiveSession, saveLocal, clearActiveSession } from '../sessionStore';
import ScoreBadge from '../components/ScoreBadge';
import { PatientAvatarButton } from '../components/PatientAvatar';
import LogActions from '../components/LogActions';
import CriteriaTable from '../components/CriteriaTable';
import { makeLogItems, evalSection as evalSectionTxt, downloadText, hasTranscript } from '../logFiles';
import { nextActiveElapsed, SESSION_LIMIT_SECONDS, SESSION_LIMIT_MINUTES } from '../sessionLimit';
import '../styles/Session.css';

// Sessão de SIMULAÇÃO (freeplay) — personagem livre, multi-sessão (time skip).
// Rota: /chat/freeplay/:id  ·  /chat/freeplay/:id?mode=competitive
// O modo competitivo (query string) alimenta o MMR ao finalizar; treino não.
// NUNCA aceita sessionType='neuro' — todo o código de neuro foi removido do porte.

const SKIP_PROMPT = 'O usuário finalizou a sessão de hoje. Agora passaremos para a próxima sessão. Você (o cliente) acaba de entrar na sessão novamente, na próxima semana. Descreva o que aconteceu na sua semana; você já está na sala novamente com o terapeuta.';
const SKIP_MIN_DELAY_MS = 2200;
const SAVE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Limite de sessões por atendimento (período de teste). Só freeplay.
const MAX_FREEPLAY_SESSIONS = 6;

function buildEvaluationMessage(characterName, transcript) {
  return `[LOG DO ATENDIMENTO]\nPersonagem: ${characterName}\n\n${transcript}`;
}

export default function EchoSession({ user, sessionType = 'freeplay' }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();

  // Modo competitivo via query string (contrato fechado com o Competitivo).
  const isCompetitive = new URLSearchParams(location.search).get('mode') === 'competitive';
  const logMode = isCompetitive ? 'competitive' : 'training';
  const isVisitor = user?.role === 'visitor';
  const canSeeReasoning = user?.role === 'supervisor' || user?.role === 'admin';

  // Avaliação para VISITANTE é controlada pelo admin (default off). Carregado do
  // servidor. Quando off, o visitante encerra a sessão sem avaliação.
  const [visitorEvalEnabled, setVisitorEvalEnabled] = useState(false);
  // Avaliador global ligado? (default off → encerra com agradecimento.)
  const [evaluatorEnabled, setEvaluatorEnabled] = useState(false);
  const skipEvaluator = !evaluatorEnabled || (isVisitor && !visitorEvalEnabled);

  // Chave de autosave separada por modo: senão treino e competitivo do MESMO
  // personagem colidiriam. O itemId real (id) continua indo pro chat e pro log.
  const autoItemId = isCompetitive ? `${id}::comp` : id;

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

  const [sessionNumber, setSessionNumber] = useState(1);
  const [confirmingSkip, setConfirmingSkip] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [showSessionLimit, setShowSessionLimit] = useState(false);

  // Pós-sessão
  const [savingLog, setSavingLog] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [evaluating, setEvaluating] = useState(false);
  const [evalError, setEvalError] = useState('');
  const [evaluationText, setEvaluationText] = useState('');
  const [evalScore, setEvalScore] = useState(null);
  const [criteriaScores, setCriteriaScores] = useState(null); // supervisor/admin
  const [reasoning, setReasoning] = useState('');             // supervisor/admin
  const [mmrResult, setMmrResult] = useState(null);           // pós-partida competitiva

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

  // Config do servidor: avaliador global + toggle de avaliação p/ visitante.
  useEffect(() => {
    let cancelled = false;
    api.getSettings()
      .then((s) => {
        if (cancelled) return;
        setEvaluatorEnabled(!!s.evaluatorEnabled);
        setVisitorEvalEnabled(!!s.visitorEvaluationEnabled);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Carrega personagem + tenta restaurar sessão ativa (F5 / sair e voltar).
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const list = await api.getFreeplay();
        const found = list.find((i) => String(i.id) === String(id));
        if (cancelled) return;
        if (!found) { setError('Personagem não encontrado.'); return; }
        setItem(found);
        if (!restoredRef.current && user?.id) {
          restoredRef.current = true;
          const saved = await loadActiveSession(user.id, sessionType, autoItemId);
          if (cancelled) return;
          if (saved && Array.isArray(saved.messages) && saved.messages.length > 0) {
            setMessages(saved.messages);
            setElapsed(saved.elapsedSeconds || 0);
            if (Number.isFinite(saved.sessionNumber) && saved.sessionNumber >= 1) setSessionNumber(saved.sessionNumber);
            setSessionStarted(true);
          }
        }
      } catch (err) {
        if (!cancelled) setError(err.message || 'Erro ao carregar personagem.');
      }
    }
    load();
    return () => { cancelled = true; };
  }, [id, sessionType, user?.id, autoItemId]);

  // Autosave. Visitantes não persistem.
  useEffect(() => {
    if (!sessionStarted || sessionEnded || !item || !user?.id || finishedRef.current) return;
    const data = { messages, elapsedSeconds: elapsed, itemTitle: item.name, sessionNumber };
    sessionDataRef.current = data;
    saveLocal(user.id, sessionType, autoItemId, data);
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      if (finishedRef.current) return;
      api.saveActiveSession(sessionType, autoItemId, data).catch(() => {});
    }, 1500);
    return () => { if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current); };
  }, [messages, elapsed, sessionStarted, sessionEnded, item, sessionNumber, user?.id, autoItemId, sessionType]);

  // Flush ao trocar de rota / fechar aba / background.
  useEffect(() => {
    if (!sessionStarted || sessionEnded || !user?.id) return;
    function flush() {
      if (finishedRef.current) return;
      const data = sessionDataRef.current;
      if (!data) return;
      saveLocal(user.id, sessionType, autoItemId, data);
      api.saveActiveSession(sessionType, autoItemId, data).catch(() => {});
    }
    function onVis() { if (document.visibilityState === 'hidden') flush(); }
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [sessionStarted, sessionEnded, user?.id, autoItemId, sessionType]);

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
    const data = await api.chat(apiMessages, { type: sessionType, itemId: id });
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

  function handleSkipSession() {
    if (!sessionStarted || sessionEnded || isTyping || skipping || limitReached) return;
    if (sessionNumber >= MAX_FREEPLAY_SESSIONS) { setShowSessionLimit(true); return; }
    setConfirmingSkip(true);
  }

  async function doSkipSession() {
    setConfirmingSkip(false);
    if (!sessionStarted || sessionEnded || isTyping || skipping) return;
    const newNumber = sessionNumber + 1;
    setSessionNumber(newNumber);
    setSkipping(true);
    const breakMarker = { type: 'session-break', sessionNumber: newNumber, stage: 'transitioning' };
    const hiddenSkip = { role: 'user', content: SKIP_PROMPT, isSystem: true, highlighted: false, comment: '' };
    setMessages([...messages, breakMarker, hiddenSkip]);
    setIsTyping(true);
    const minDelay = new Promise((r) => setTimeout(r, SKIP_MIN_DELAY_MS));
    const flip = (m) => (m && m.type === 'session-break' && m.sessionNumber === newNumber ? { ...m, stage: 'arrived' } : m);
    try {
      const [reply] = await Promise.all([sendToAI(SKIP_PROMPT, messages), minDelay]);
      setMessages((prev) => prev.map(flip).concat({ role: 'assistant', content: reply }));
    } catch (err) {
      setMessages((prev) => prev.map(flip).concat({ role: 'assistant', content: `Erro ao retomar a sessão: ${err.message}` }));
    } finally {
      setIsTyping(false);
      setSkipping(false);
      textareaRef.current?.focus();
    }
  }

  function doReset() {
    setConfirmingReset(false);
    finishedRef.current = true;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    if (timerRef.current) clearInterval(timerRef.current);
    sessionDataRef.current = null;
    clearActiveSession(user.id, sessionType, autoItemId);
    setMessages([]); setInput(''); setElapsed(0); setSessionNumber(1); setSessionStarted(false); setError('');
    setTimeout(() => { finishedRef.current = false; }, 0);
  }

  function downloadSave() {
    const save = {
      genusSave: true, version: 1, type: sessionType, itemId: String(id), itemTitle: item?.name || '',
      messages, elapsedSeconds: elapsed, sessionNumber, savedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(save, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `genus-save-simulacao-${(item?.name || 'sessao').replace(/\s+/g, '_')}-${new Date().toISOString().slice(0, 10)}.json`;
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
        if (save.type !== sessionType || String(save.itemId) !== String(id)) throw new Error('Este save é de outro personagem. Abra o personagem correspondente para carregá-lo.');
        const savedAt = new Date(save.savedAt || 0).getTime();
        if (Number.isFinite(savedAt) && savedAt > 0 && Date.now() - savedAt > SAVE_TTL_MS) throw new Error('Este save expirou — saves valem por 30 dias.');
        finishedRef.current = false;
        setMessages(save.messages);
        setElapsed(Number.isFinite(save.elapsedSeconds) ? save.elapsedSeconds : 0);
        if (Number.isFinite(save.sessionNumber) && save.sessionNumber >= 1) setSessionNumber(save.sessionNumber);
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
      `Tipo: ${isCompetitive ? 'Simulação · Competitivo' : 'Simulação'}`,
      `Caso: ${item?.name || '—'}`,
      `Aluno: ${user?.name || '—'}`,
      `Sessões: ${sessionNumber}`,
      `Duração: ${formatTime(elapsed)}`,
      evalScore !== null ? `Nota final: ${evalScore}` : null,
    ].filter(Boolean).join('\n');
  }
  function buildTranscript() {
    return messages.filter((m) => !m.isSystem && !m.type).map((m) => {
      const author = m.role === 'user' ? (user?.name || 'Aluno') : (item?.name || 'Cliente');
      const star = m.highlighted ? ' ★' : '';
      const comment = m.highlighted && m.comment ? `\n   {${m.comment}}` : '';
      return `[${author}${star}]\n${m.content}${comment}`;
    }).join('\n\n---\n\n');
  }
  const logText = () => `${buildLogHeader()}\n\n---\n\n${buildTranscript()}`;
  const evalText = () => `${buildLogHeader()}${evalSectionTxt((evaluationText || '').trim())}`.trimEnd();
  const bothText = () => `${buildLogHeader()}\n\n---\n\n${buildTranscript()}${evalSectionTxt((evaluationText || '').trim())}`;

  // Há conversa de verdade? Fora a de kickoff (`isSystem`) e os marcadores de
  // troca de sessão (`type: 'session-break'`). Ver logFiles.js.
  const showLogButton = hasTranscript(messages);

  // Atalho no cabeçalho: baixa o log sem finalizar a sessão. Durante o atendimento
  // ainda não há avaliação, e `evalSection('')` devolve '' — `bothText()` vira só o log.
  function downloadLog() {
    const base = (item?.name || 'simulacao').replace(/\s+/g, '_');
    downloadText(`simulacao-${base}-${new Date().toISOString().slice(0, 10)}.txt`, bothText());
  }

  function handleFinalize() {
    if (!sessionStarted || sessionEnded) return;
    setConfirmingFinalize(true);
  }

  async function doFinalize() {
    setConfirmingFinalize(false);
    if (!sessionStarted || sessionEnded) return;
    finishedRef.current = true;
    const visibleMessages = messages.filter((m) => !m.isSystem && !m.type);
    if (timerRef.current) clearInterval(timerRef.current);

    if (visibleMessages.length === 0) {
      setSessionEnded(true);
      clearActiveSession(user.id, sessionType, autoItemId);
      return;
    }

    setSessionEnded(true);
    setSavingLog(true);
    if (!skipEvaluator) setEvaluating(true);
    setSaveError('');
    setEvalError('');

    const transcriptText = visibleMessages.map((m) => {
      const author = m.role === 'user' ? user.name : (item?.name || 'Cliente');
      const star = m.highlighted ? ' ★' : '';
      const comment = m.highlighted && m.comment ? `\n   {${m.comment}}` : '';
      return `[${author}${star}]\n${m.content}${comment}`;
    }).join('\n\n---\n\n');

    // 1. Avaliação (não é stream). Pulada quando o avaliador está desligado OU
    //    quando é visitante sem avaliação habilitada pelo admin. O servidor injeta
    //    o gabarito e devolve o texto limpo + score (e criteriaScores/reasoning
    //    só para professor/admin).
    let evalContent = '';
    let totalScore = null;
    let critScores = null;
    if (!skipEvaluator) {
      try {
        const evalMsg = { role: 'user', content: buildEvaluationMessage(item?.name || '—', transcriptText) };
        const reply = await api.evaluate([evalMsg], { type: sessionType, itemId: id, mode: logMode });
        if (reply && !reply.disabled) {
          evalContent = typeof reply === 'string' ? reply : reply.content || '';
          if (reply && Number.isFinite(reply.score)) totalScore = reply.score;
          setEvaluationText(evalContent);
          setEvalScore(totalScore);
          if (reply && reply.criteriaScores) { critScores = reply.criteriaScores; setCriteriaScores(reply.criteriaScores); }
          if (reply && reply.reasoning) setReasoning(reply.reasoning);
        }
      } catch (err) {
        setEvalError(err.message || 'Erro ao avaliar a sessão.');
      } finally {
        setEvaluating(false);
      }
    }

    // 2. Salva o log (sempre, exceto visitante — o backend não persiste visitante).
    //    Em modo competitivo o servidor atualiza o MMR e devolve o resultado.
    try {
      const saved = await api.saveLog({
        userId: user.id,
        userName: user.name,
        type: sessionType,
        mode: logMode,
        itemId: id,
        itemTitle: item.name,
        messages: visibleMessages.map((m) => ({ role: m.role, content: m.content, highlighted: m.highlighted || false, comment: m.comment || '' })),
        durationSeconds: elapsed,
        sessionCount: sessionNumber,
        score: totalScore,
        criteriaScores: critScores,
        evaluation: evalContent,
      });
      if (saved && Number.isFinite(saved.score)) setEvalScore(saved.score);
      if (saved && saved.mmr) setMmrResult(saved.mmr);
    } catch (err) {
      setSaveError(err.message || 'Erro ao salvar o log.');
    } finally {
      setSavingLog(false);
    }

    clearActiveSession(user.id, sessionType, autoItemId);
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

  // -------- TELA DE LOADING (avaliando) --------
  if (sessionEnded && evaluating) {
    return (
      <div className="session-page post-session">
        <div className="page-header">
          <div className="eyebrow">Sessão concluída</div>
          <h2>Avaliando sua <span className="accent">sessão</span></h2>
          <p>A análise do atendimento com {item?.name} pode levar alguns segundos.</p>
          <div className="ornament" />
        </div>
        <div className="card evaluating-card">
          <div className="evaluating-orb"><div className="orb-pulse" /><div className="orb-pulse delay-1" /><div className="orb-pulse delay-2" /><div className="orb-core" /></div>
          <div className="evaluating-status">
            <div className="evaluating-line"><span className="dot active" /> Construindo a transcrição da sessão</div>
            <div className="evaluating-line"><span className="dot active" /> Aplicando os critérios de avaliação</div>
            <div className="evaluating-line"><span className="dot pulse" /> Citando trechos e formulando a análise</div>
            <div className="evaluating-line"><span className="dot" /> Calculando a nota final</div>
          </div>
        </div>
      </div>
    );
  }

  // -------- TELA PÓS-SESSÃO --------
  if (sessionEnded) {
    const visibleMessages = messages.filter((m) => !m.isSystem && !m.type);
    const hasEval = !!(evaluationText || '').trim();
    const teacherName = user?.teacherName;
    let sentMessage;
    if (isVisitor) sentMessage = 'Você está em modo visitante — o log desta sessão não foi salvo.';
    else if (teacherName) sentMessage = `O log completo desta sessão foi enviado para o professor ${teacherName}.`;
    else sentMessage = 'O log completo desta sessão foi registrado no seu histórico.';

    return (
      <div className="session-page post-session">
        <div className="page-header">
          <div className="eyebrow">Sessão concluída</div>
          <h2>{hasEval ? <>Avaliação da sua <span className="accent">sessão</span></> : <>Obrigado por <span className="accent">participar</span></>}</h2>
          <p>Sessão com <strong>{item?.name}</strong> · duração {formatTime(elapsed)} · {sessionNumber} {sessionNumber === 1 ? 'sessão' : 'sessões'}</p>
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
              <p className="thankyou-text">{sentMessage}</p>
            </div>
          )}

          <div className="post-session-stats">
            <div><span className="post-stat-label">Duração</span><span className="post-stat-value">{formatTime(elapsed)}</span></div>
            <div><span className="post-stat-label">Sessões</span><span className="post-stat-value">{sessionNumber}</span></div>
            <div><span className="post-stat-label">Mensagens</span><span className="post-stat-value">{visibleMessages.length}</span></div>
            {evalScore !== null && (
              <div><span className="post-stat-label">Nota final</span><ScoreBadge score={evalScore} size="xl" /></div>
            )}
          </div>

          {isCompetitive && (
            <div className="mmr-result-card">
              {mmrResult ? (
                mmrResult.calibrating ? (
                  <>
                    <span className="post-stat-label">MMR · Em calibração</span>
                    <p className="mmr-result-note">
                      Partida {mmrResult.n} de 5 da calibração — seu MMR aparece após a 5ª.
                      {mmrResult.matchesRemaining > 0 && (
                        <> Faltam <strong>{mmrResult.matchesRemaining}</strong> {mmrResult.matchesRemaining === 1 ? 'partida' : 'partidas'}.</>
                      )}
                    </p>
                  </>
                ) : (
                  <>
                    <span className="post-stat-label">Seu MMR</span>
                    <div className="mmr-result-value">
                      {Math.round(mmrResult.P_after)}
                      {Number.isFinite(mmrResult.delta) && (
                        <span className={`mmr-delta ${mmrResult.delta >= 0 ? 'up' : 'down'}`}>
                          {mmrResult.delta >= 0 ? '▲' : '▼'} {Math.abs(mmrResult.delta).toFixed(1)}
                        </span>
                      )}
                    </div>
                    {Number.isFinite(mmrResult.D_after) && (
                      <p className="mmr-result-note">Dificuldade de {item?.name} agora: <strong>{Math.round(mmrResult.D_after)}</strong></p>
                    )}
                  </>
                )
              ) : (
                <p className="mmr-result-note">O MMR não foi atualizado — a sessão não recebeu uma nota numérica do avaliador.</p>
              )}
            </div>
          )}

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
              <LogActions items={makeLogItems({ baseName: item?.name || 'sessao', getLog: logText, getEval: hasEval ? evalText : null, getBoth: hasEval ? bothText : null })} />
            </div>
          )}

          <div className="post-session-actions">
            <button className="btn btn-primary" onClick={() => navigate(isCompetitive ? '/competitivo' : '/freeplay')}>Voltar à biblioteca</button>
          </div>
        </div>
      </div>
    );
  }

  // -------- TELA DE CHAT --------
  const sessionLabel = isCompetitive ? 'Competitivo' : 'Simulação';
  const emptyHint = isCompetitive
    ? 'Modo competitivo — esta sessão é avaliada e vale ranking (MMR) ao final.'
    : (isVisitor
        ? (skipEvaluator
            ? 'Simulação livre — sessão de demonstração, sem avaliação ao final.'
            : 'Simulação livre — você recebe uma avaliação da IA ao final (demonstração).')
        : 'Simulação livre — atenda o cliente como quiser. Use o botão de destaque (★) para marcar intervenções para revisão.');

  return (
    <div className="session-page chat-container echo-chat">
      <div className="chat-header">
        <button onClick={() => navigate(-1)} className="btn btn-outline btn-sm">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6" /></svg>
          Voltar
        </button>

        {item?.name && <PatientAvatarButton name={item.name} iconUrl={assetUrl(item.photoIcon)} fullUrl={assetUrl(item.photoFull)} size={42} className="chat-header-avatar" />}

        <div className="chat-title">
          <h3>Sessão com {item?.name || '...'}</h3>
          <div className="chat-status">{sessionLabel}{sessionStarted && <> · <strong>Sessão #{sessionNumber}</strong></>}</div>
        </div>

        <div className="chat-header-actions">
          {sessionStarted && (
            <div className={`timer-chip ${limitReached ? 'limit' : ''}`} title={limitReached ? `Limite de ${SESSION_LIMIT_MINUTES} min atingido` : 'Tempo no chat (pausa fora dele)'}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
              <span>{formatTime(elapsed)}</span>
            </div>
          )}
          {/* Baixar o log sem finalizar a sessão. Só com conversa de verdade: a
              mensagem de kickoff é `isSystem` e os marcadores de troca de sessão
              têm `type`. (O All_OS só tem este atalho no ChatSession.) */}
          {showLogButton && (
            <button className="btn btn-outline btn-sm" onClick={downloadLog} title="Baixar o log desta sessão (.txt)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
              Log
            </button>
          )}
          {sessionStarted && (
            <>
              <button className="btn btn-outline btn-sm" onClick={() => setShowSaveLoad(true)} disabled={isTyping || skipping} title="Guardar ou carregar o progresso desta sessão">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" /><polyline points="17 21 17 13 7 13 7 21" /><polyline points="7 3 7 8 15 8" /></svg>
                Save/Load
              </button>
              <button className="btn btn-outline btn-sm btn-warn" onClick={() => setConfirmingReset(true)} disabled={isTyping || skipping} title="Reiniciar a simulação do zero">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.7 3" /><polyline points="3 3 3 8 8 8" /></svg>
                Reiniciar
              </button>
              <button className="btn btn-sm btn-success" onClick={handleSkipSession} disabled={isTyping || skipping} title="Avançar para a próxima sessão (time skip)">
                Próxima sessão →
              </button>
              <button className="btn btn-secondary btn-sm" onClick={handleFinalize}>{skipEvaluator ? 'Encerrar sessão' : 'Finalizar e enviar'}</button>
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="alert error">{error}<button onClick={() => setError('')} className="close">×</button></div>
      )}

      <div className={`chat-messages ${!sessionStarted ? 'locked' : ''}`}>
        {messages.filter((m) => !m.isSystem && !m.type).length === 0 && !sessionStarted && (
          <div className="empty-chat">{emptyHint}</div>
        )}

        {messages.map((msg, i) => {
          if (msg && msg.type === 'session-break') {
            const isTransitioning = msg.stage !== 'arrived';
            return (
              <div key={i} className={`session-break ${isTransitioning ? 'transitioning' : 'arrived'}`}>
                <div className="session-break-line" />
                <div className="session-break-card">
                  <div className="session-break-badge">Sessão #{msg.sessionNumber}</div>
                  {isTransitioning ? (
                    <>
                      <div className="session-break-text">A sessão foi encerrada. Passando a semana…</div>
                      <div className="session-break-loader"><span className="dot" /><span className="dot" /><span className="dot" /></div>
                    </>
                  ) : (
                    <div className="session-break-text">Seu cliente chegou para a sessão da próxima semana. Pode iniciar o atendimento.</div>
                  )}
                </div>
                <div className="session-break-line" />
              </div>
            );
          }
          if (msg.isSystem) return null;
          const isUser = msg.role === 'user';
          const author = isUser ? user.name : (item?.name || 'Cliente');
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
            <div className="chat-message-author">{item?.name || 'Cliente'}</div>
            <div className="chat-message assistant" style={{ fontStyle: 'italic', opacity: 0.7 }}><span className="loading-dots">Pensando</span></div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {!sessionStarted ? (
        <div className="start-session-area">
          <div className="start-session-card">
            <h4>Pronto para começar?</h4>
            <p>Ao iniciar, {item?.name} abrirá a conversa.</p>
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
        const visibleCount = messages.filter((m) => !m.isSystem && !m.type).length;
        return (
          <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setShowSaveLoad(false); }}>
            <div className="modal" style={{ maxWidth: 460 }}>
              <h3>Progresso da sessão</h3>
              <p className="modal-text">Guarde o progresso atual num arquivo (.json) para retomar depois, ou carregue um progresso salvo. Carregar substitui a conversa atual.</p>
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={() => { setShowSaveLoad(false); fileInputRef.current?.click(); }}>Carregar o progresso</button>
                <button type="button" className="btn btn-primary" onClick={() => { setShowSaveLoad(false); downloadSave(); }} disabled={visibleCount === 0} title={visibleCount === 0 ? 'A sessão ainda não tem mensagens' : 'Baixar o save desta sessão'}>Guardar o progresso</button>
              </div>
            </div>
          </div>
        );
      })()}

      {confirmingFinalize && (() => {
        const visibleCount = messages.filter((m) => !m.isSystem && !m.type).length;
        const empty = visibleCount === 0;
        const title = empty ? 'Sessão vazia' : (skipEvaluator ? 'Encerrar sessão' : 'Finalizar e enviar');
        const body = empty
          ? `A sessão ainda não tem mensagens. Deseja ${skipEvaluator ? 'encerrar' : 'enviar'} mesmo assim?`
          : (skipEvaluator
            ? 'Tem certeza que deseja encerrar? Esta sessão não terá avaliação nem nota. O log será salvo no seu histórico.'
            : 'Tem certeza? O log completo será salvo no seu histórico e enviado para análise. Você não poderá continuar este atendimento depois.');
        return (
          <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setConfirmingFinalize(false); }}>
            <div className="modal" style={{ maxWidth: 500 }}>
              <h3>{title}</h3>
              <p className="modal-text">{body}</p>
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={() => setConfirmingFinalize(false)}>Cancelar</button>
                <button type="button" className="btn btn-primary" onClick={doFinalize}>{empty ? (skipEvaluator ? 'Encerrar mesmo assim' : 'Enviar mesmo assim') : title}</button>
              </div>
            </div>
          </div>
        );
      })()}

      {confirmingReset && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setConfirmingReset(false); }}>
          <div className="modal" style={{ maxWidth: 460 }}>
            <h3>Reiniciar simulação</h3>
            <p className="modal-text">Tem certeza? Toda a conversa, o tempo decorrido e o número da sessão serão <strong>perdidos</strong> e você voltará à tela de início. Esta ação não pode ser desfeita.</p>
            <div className="modal-actions">
              <button type="button" className="btn btn-outline" onClick={() => setConfirmingReset(false)}>Cancelar</button>
              <button type="button" className="btn btn-primary btn-warn-solid" onClick={doReset}>Sim, reiniciar</button>
            </div>
          </div>
        </div>
      )}

      {confirmingSkip && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setConfirmingSkip(false); }}>
          <div className="modal" style={{ maxWidth: 480 }}>
            <h3>Avançar para a próxima sessão</h3>
            <p className="modal-text">Tem certeza que deseja ir para a próxima sessão? Lembre-se de fazer um encerramento primeiro com seu cliente — essa função é um <em>time skip</em>.</p>
            <div className="modal-actions">
              <button type="button" className="btn btn-outline" onClick={() => setConfirmingSkip(false)}>Cancelar</button>
              <button type="button" className="btn btn-primary" onClick={doSkipSession}>Passar para a próxima sessão</button>
            </div>
          </div>
        </div>
      )}

      {showSessionLimit && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setShowSessionLimit(false); }}>
          <div className="modal" style={{ maxWidth: 480 }}>
            <h3>Limite de sessões atingido</h3>
            <p className="modal-text">No momento, como estamos em período de teste do aplicativo, você só tem direito a fazer {MAX_FREEPLAY_SESSIONS} sessões. Por favor faça o encerramento em no máximo 3 mensagens e finalize o atendimento.</p>
            <div className="modal-actions">
              <button type="button" className="btn btn-primary" onClick={() => setShowSessionLimit(false)}>Entendi</button>
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
