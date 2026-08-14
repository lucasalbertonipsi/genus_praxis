import { useState, useRef, useEffect } from 'react';
import { api } from '../api';
import Typewriter from '../components/Typewriter';
import ScoreBadge from '../components/ScoreBadge';
import LogActions from '../components/LogActions';
import CriteriaTable from '../components/CriteriaTable';
import { makeLogItems } from '../logFiles';
import '../styles/Avaliacao.css';

// Avaliação Independente — o professor/admin cola uma transcrição avulsa (ou
// envia um .txt) e recebe a avaliação da IA seguindo os critérios da Allos.
//
// DIFERENÇA vs All_OS: aqui NÃO há streaming. api.evaluate(messages, context)
// devolve a resposta inteira de uma vez → { role, content, score } e, só para
// supervisor/admin, também { criteriaScores, reasoning }. Por isso a UI mostra
// um spinner enquanto aguarda e renderiza o texto completo no fim (sem token a
// token, sem showReasoning). Avaliador desligado → { content: '', disabled }.
export default function Avaliacao({ user }) {
  const [transcript, setTranscript] = useState('');
  const [started, setStarted] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [disabledNotice, setDisabledNotice] = useState(false);
  const [characters, setCharacters] = useState([]);
  const [selectedCharacterId, setSelectedCharacterId] = useState('');
  const messagesEndRef = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // Lista de personagens FreePlay para o dropdown de critério de correção.
  // O gabarito (evaluationCriteria) não vem ao cliente — é resolvido server-side
  // em /api/evaluate a partir do context.itemId. Aqui só precisamos de id + nome.
  useEffect(() => {
    let cancelled = false;
    api.getFreeplay()
      .then((list) => {
        if (cancelled) return;
        const sorted = (Array.isArray(list) ? list : [])
          .map((c) => ({ id: c.id, name: c.name, age: c.age }))
          .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'pt-BR'));
        setCharacters(sorted);
      })
      .catch(() => { /* sem dropdown se falhar; fluxo genérico continua */ });
    return () => { cancelled = true; };
  }, []);

  const evaluateContext = selectedCharacterId
    ? { type: 'freeplay', itemId: selectedCharacterId }
    : undefined;

  function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (!file.name.endsWith('.txt')) {
      setError('Apenas arquivos .txt são aceitos.');
      return;
    }
    const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024; // 2 MB
    if (file.size > MAX_TRANSCRIPT_BYTES) {
      setError(`Arquivo muito grande (${(file.size / 1024 / 1024).toFixed(1)} MB). Máximo: 2 MB.`);
      return;
    }
    setError('');
    const reader = new FileReader();
    reader.onload = (ev) => setTranscript(ev.target.result);
    reader.readAsText(file);
  }

  // Envia a lista de mensagens ao avaliador e devolve a resposta (sem stream).
  // Trata o caso "avaliador desligado" ({ content:'', disabled:true }).
  async function runEvaluate(msgs) {
    const reply = await api.evaluate(
      msgs.map((m) => ({ role: m.role, content: m.content })),
      evaluateContext,
    );
    if (reply && reply.disabled) {
      setDisabledNotice(true);
      return null;
    }
    setDisabledNotice(false);
    return reply;
  }

  async function handleStart() {
    if (!transcript.trim()) {
      setError('Cole ou envie uma transcrição antes de iniciar a avaliação.');
      return;
    }
    setError('');
    setStarted(true);
    setLoading(true);
    setDisabledNotice(false);

    const initialMessage = {
      role: 'user',
      content: `Aqui está a transcrição da sessão para avaliação:\n\n${transcript}`,
    };

    try {
      const reply = await runEvaluate([initialMessage]);
      setMessages(reply ? [initialMessage, reply] : [initialMessage]);
    } catch (err) {
      setError(err.message || 'Erro ao iniciar avaliação');
      setStarted(false);
    } finally {
      setLoading(false);
    }
  }

  async function handleSend() {
    if (!input.trim() || loading) return;
    const userMsg = { role: 'user', content: input.trim() };
    const updated = [...messages, userMsg];
    setMessages(updated);
    setInput('');
    setLoading(true);
    setError('');

    try {
      const reply = await runEvaluate(updated);
      if (reply) setMessages([...updated, reply]);
    } catch (err) {
      setError(err.message || 'Erro ao comunicar com a IA');
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  // Texto da conversa de avaliação (transcrição enviada + diálogo com a IA).
  function buildEvalDialog() {
    return messages
      .map((m, i) => {
        const name = m.role === 'user' ? user?.name || 'Usuário' : 'Genus Praxis · Avaliador';
        if (i === 0) return `[${name}]\n[Transcrição enviada · ${transcript.length} caracteres]`;
        return `[${name}]\n${m.content}`;
      })
      .join('\n\n---\n\n');
  }

  function handleReset() {
    setTranscript('');
    setStarted(false);
    setMessages([]);
    setInput('');
    setError('');
    setLoading(false);
    setDisabledNotice(false);
    setSelectedCharacterId('');
  }

  if (!started) {
    return (
      <div className="avaliacao-page">
        <div className="page-header">
          <div className="eyebrow">Avaliação Independente</div>
          <h2><Typewriter text="Avaliar uma " /><span className="accent"><Typewriter text="Sessão" delayStart={520} /></span></h2>
          <p>
            Envie a transcrição completa de uma sessão terapêutica e receba uma análise densa seguindo
            os critérios da Allos. A análise vem em um único turno; você pode contestar e dialogar com a IA depois.
          </p>
          <div className="ornament" />
        </div>

        <div className="avaliacao-intro card">
          <div className="form-field">
            <label htmlFor="character-select">Critério de correção (personagem FreePlay)</label>
            <select
              id="character-select"
              value={selectedCharacterId}
              onChange={(e) => setSelectedCharacterId(e.target.value)}
              style={{ width: '100%' }}
            >
              <option value="">Sem critério específico — avaliação genérica</option>
              {characters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}{c.age ? `, ${c.age}` : ''}
                </option>
              ))}
            </select>
            <small className="section-sub tight">
              Quando selecionado, o avaliador recebe o gabarito do caso como referência. O aluno não vê esse conteúdo.
            </small>
          </div>

          <div className="form-field">
            <label htmlFor="transcript">Transcrição da sessão</label>
            <textarea
              id="transcript"
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              placeholder="Cole aqui a transcrição completa da sessão terapêutica…"
              style={{ minHeight: 280, width: '100%' }}
            />
          </div>

          <div className="avaliacao-row">
            <span className="avaliacao-divider">ou</span>
            <button type="button" className="btn btn-outline btn-sm" onClick={() => fileInputRef.current?.click()}>
              Enviar arquivo .txt
            </button>
            <input ref={fileInputRef} type="file" accept=".txt" onChange={handleFileUpload} style={{ display: 'none' }} />
            {transcript && (
              <span className="section-sub tight" style={{ margin: 0 }}>
                {transcript.length.toLocaleString('pt-BR')} caracteres carregados
              </span>
            )}
          </div>

          {error && <div className="alert error">{error}</div>}

          <button className="btn btn-primary btn-lg" onClick={handleStart}>
            Iniciar Avaliação
          </button>
        </div>
      </div>
    );
  }

  const sel = characters.find((c) => c.id === selectedCharacterId);

  return (
    <div className="avaliacao-page chat-container">
      <div className="chat-header">
        <div className="chat-title" style={{ textAlign: 'left' }}>
          <h3>Avaliação de Sessão</h3>
          <div className="chat-status">
            {sel ? `conversa com a IA · critério: ${sel.name}` : 'conversa com a IA · diálogo socrático'}
          </div>
        </div>
        <div className="chat-header-actions">
          {messages.length > 0 && (
            <LogActions inline items={makeLogItems({ baseName: 'avaliacao', getLog: buildEvalDialog })} />
          )}
          <button className="btn btn-outline btn-sm" onClick={handleReset}>
            Nova Avaliação
          </button>
        </div>
      </div>

      <div className="chat-messages">
        {messages.map((msg, i) => {
          const isAssistant = msg.role === 'assistant';
          const body = i === 0
            ? `Transcrição enviada · ${transcript.length.toLocaleString('pt-BR')} caracteres`
            : msg.content;
          return (
            <div key={i} className={`chat-message-row ${msg.role}`}>
              <div className="chat-message-author">
                {msg.role === 'user' ? user?.name || 'Usuário' : 'Genus Praxis · Avaliador'}
              </div>

              {/* Raciocínio do avaliador — só chega para supervisor/admin (o
                  backend decide por role; se vier, é bloco colapsável). */}
              {isAssistant && msg.reasoning ? (
                <details className="evaluation-reasoning">
                  <summary>Raciocínio do avaliador (texto bruto)</summary>
                  <div className="evaluation-reasoning-body">{msg.reasoning}</div>
                </details>
              ) : null}

              <div className={`chat-message ${msg.role}`} style={i === 0 ? { fontStyle: 'italic', opacity: 0.85 } : undefined}>
                {body}
                {isAssistant && msg.score != null && (
                  <div className="evaluation-actions"><ScoreBadge score={msg.score} /></div>
                )}
              </div>

              {/* Notas por critério — só existem para supervisor/admin. */}
              {isAssistant && i > 0 && msg.criteriaScores && (
                <div className="evaluation-scores">
                  <CriteriaTable criteriaScores={msg.criteriaScores} />
                </div>
              )}
            </div>
          );
        })}

        {loading && (
          <div className="chat-message-row assistant">
            <div className="chat-message-author">Genus Praxis · Avaliador</div>
            <div className="chat-message assistant" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="spinner spinner-sm" />
              <span className="loading-dots">Analisando a sessão</span>
            </div>
          </div>
        )}

        {disabledNotice && !loading && (
          <div className="chat-message-row assistant">
            <div className="chat-message assistant avaliacao-disabled">
              O avaliador automático está desligado no momento. Fale com um administrador para ativá-lo.
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {error && (
        <div className="alert error">
          {error}
          <button onClick={() => setError('')} className="close">×</button>
        </div>
      )}

      <div className="chat-input-area">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Responda ou questione a avaliação…"
          disabled={loading}
        />
        <button
          type="button"
          className="icon-btn primary"
          onClick={handleSend}
          disabled={loading || !input.trim()}
          title="Enviar"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </div>
    </div>
  );
}
