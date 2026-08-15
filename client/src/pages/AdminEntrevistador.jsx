import { useState, useEffect, useRef } from 'react';
import { api } from '../api';
import Typewriter from '../components/Typewriter';
import '../styles/Admin.css';

// Chat com o agente entrevistador (admin-only). Ele conduz a co-construção de um
// personagem-cliente e, ao final, devolve o prompt do cliente estruturado em
// seções "## [I. CONTENÇÃO]" … "## [V. ABERTURA E CONTINUIDADE]".
//
// A extração dos blocos roda NO SERVIDOR (POST /api/entrevistador/extract):
//   Bloco 2 = seção I em diante → specificInstruction (a persona do simulador)
//   Bloco 1 = seções II a V     → evaluationCriteria (o gabarito do avaliador)
export default function AdminEntrevistador({ user }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState('');

  const [showPrompt, setShowPrompt] = useState(false);
  const [promptText, setPromptText] = useState('');

  const [showCharModal, setShowCharModal] = useState(false);
  const [charForm, setCharForm] = useState({ name: '', age: '', description: '', bloco2: '', bloco1: '' });
  const [preparing, setPreparing] = useState(false);
  const [savingChar, setSavingChar] = useState(false);
  const [charSaved, setCharSaved] = useState(null);

  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, isTyping]);

  async function sendMessage(text) {
    const trimmed = text.trim();
    if (!trimmed || isTyping) return;
    const updated = [...messages, { role: 'user', content: trimmed }];
    setMessages(updated);
    setInput('');
    setIsTyping(true);
    setError('');
    try {
      const reply = await api.entrevistadorChat(updated.map((m) => ({ role: m.role, content: m.content })));
      setMessages((prev) => [...prev, { role: 'assistant', content: reply.content || '' }]);
    } catch (err) {
      setError(err.message || 'Erro ao falar com o entrevistador');
      setMessages((prev) => prev.slice(0, -1));
      setInput(trimmed);
    } finally {
      setIsTyping(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(input); }
  }

  async function toggleRecording() {
    if (isTranscribing) return;
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
          try {
            const data = await api.transcribe(reader.result.split(',')[1]);
            const text = data.text || '';
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

  // Pede ao servidor que extraia os blocos da conversa e abre o modal preenchido.
  async function handlePrepareCharacter() {
    setPreparing(true);
    setError('');
    try {
      const r = await api.extractBlocos(messages.map((m) => ({ role: m.role, content: m.content })));
      if (!r.ready) {
        setError('O entrevistador ainda não gerou o prompt do cliente. Conclua a entrevista até ele devolver o prompt formatado (começando em "## [I. CONTENÇÃO]").');
        return;
      }
      setCharForm({
        name: r.meta.name || '',
        age: r.meta.age != null ? String(r.meta.age) : '',
        description: r.meta.description || '',
        bloco2: r.bloco2 || '',
        bloco1: r.bloco1 || '',
      });
      setCharSaved(null);
      setShowCharModal(true);
    } catch (err) {
      setError(err.message || 'Erro ao extrair os blocos da entrevista');
    } finally {
      setPreparing(false);
    }
  }

  async function handleCreateCharacter(e) {
    e.preventDefault();
    if (!charForm.name.trim()) { setError('Defina um nome para o personagem.'); return; }
    setSavingChar(true);
    try {
      const created = await api.createCharacterFromInterview({
        name: charForm.name.trim(),
        age: charForm.age !== '' ? Number(charForm.age) : null,
        description: charForm.description.trim(),
        specificInstruction: charForm.bloco2,
        evaluationCriteria: charForm.bloco1,
      });
      setCharSaved(created);
    } catch (err) {
      setError('Erro ao criar personagem: ' + err.message);
    } finally {
      setSavingChar(false);
    }
  }

  function download(text, filename) {
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadConversation() {
    const header = `Entrevista de construção de personagem · ${new Date().toLocaleString('pt-BR')}\nAdmin: ${user?.name || ''}\n\n---\n\n`;
    const body = messages.map((m) => `[${m.role === 'user' ? (user?.name || 'Você') : 'Entrevistador'}]\n${m.content}`).join('\n\n---\n\n');
    download(header + body, `entrevista-${new Date().toISOString().slice(0, 10)}.md`);
  }

  async function downloadBloco2() {
    try {
      const r = await api.extractBlocos(messages.map((m) => ({ role: m.role, content: m.content })));
      if (!r.ready) { setError('O prompt final do cliente ainda não foi gerado pelo entrevistador.'); return; }
      download(r.bloco2, `prompt-personagem-${new Date().toISOString().slice(0, 10)}.md`);
    } catch (err) {
      setError(err.message || 'Erro ao extrair o prompt');
    }
  }

  function resetConversation() {
    if (messages.length > 0 && !window.confirm('Apagar a conversa atual e começar uma nova entrevista?')) return;
    setMessages([]);
    setInput('');
    setCharSaved(null);
    setError('');
  }

  async function togglePrompt() {
    if (!showPrompt && !promptText) {
      try {
        const data = await api.getEntrevistadorPrompt();
        setPromptText(typeof data === 'string' ? data : data.prompt || '');
      } catch (err) {
        setError(err.message || 'Erro ao carregar o prompt');
        return;
      }
    }
    setShowPrompt((v) => !v);
  }

  return (
    <div className="admin-page">
      <div className="page-header with-action">
        <div>
          <div className="eyebrow">Administração · Construção de personagens</div>
          <h2><Typewriter text="Entre" /><span className="accent"><Typewriter text="vistador" delayStart={180} /></span></h2>
          <p>
            Conduza uma entrevista com o agente entrevistador para co-construir um novo
            personagem-cliente. Ao final ele devolve o prompt pronto: a persona vai para a
            biblioteca de Simulação e o gabarito, para o avaliador.
          </p>
        </div>
        <div className="entrevistador-actions">
          <button className="btn btn-ghost btn-sm" onClick={togglePrompt}>
            {showPrompt ? 'Ocultar prompt' : 'Ver prompt do agente'}
          </button>
          {messages.length > 0 && (
            <>
              <button className="btn btn-ghost btn-sm" onClick={downloadConversation}>Baixar conversa</button>
              <button className="btn btn-ghost btn-sm" onClick={downloadBloco2}>Baixar prompt (.md)</button>
              <button className="btn btn-primary btn-sm" onClick={handlePrepareCharacter} disabled={preparing || isTyping}>
                {preparing ? 'Extraindo…' : 'Criar personagem'}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={resetConversation}>Nova entrevista</button>
            </>
          )}
        </div>
      </div>

      {error && <div className="alert error">{error}</div>}

      {showPrompt && (
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="prompt-view">
            <div className="prompt-view-toolbar">
              <span className="meta">Prompt de sistema do entrevistador (somente leitura)</span>
            </div>
            <pre className="prompt-pre">{promptText || 'Prompt não configurado no servidor.'}</pre>
          </div>
        </div>
      )}

      <div className="chat-container entrevistador-chat">
        <div className="chat-messages">
          {messages.length === 0 && !isTyping && (
            <div className="empty-chat" style={{ marginTop: 80 }}>
              Comece a entrevista — descreva o personagem que você quer construir, ou peça
              que o entrevistador conduza desde o início.
            </div>
          )}

          {messages.map((msg, i) => (
            <div key={i} className={`chat-message-row ${msg.role}`}>
              <div className="chat-message-author">{msg.role === 'user' ? (user?.name || 'Você') : 'Entrevistador'}</div>
              <div className={`chat-message ${msg.role}`}>{msg.content}</div>
            </div>
          ))}

          {isTyping && (
            <div className="chat-message-row assistant">
              <div className="chat-message-author">Entrevistador</div>
              <div className="chat-message assistant" style={{ fontStyle: 'italic', opacity: 0.7 }}>
                <span className="loading-dots">Pensando</span>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {isTranscribing ? (
          <div className="chat-input-area transcribing">
            <div className="transcribing-indicator">
              <span className="spinner" /> <span>Transcrevendo áudio…</span>
            </div>
          </div>
        ) : (
          <div className="chat-input-area">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Sua resposta…  ·  Enter envia · Shift+Enter quebra linha"
              rows={1}
              disabled={isTyping}
            />
            <button
              type="button"
              className={`icon-btn ${isRecording ? 'recording' : ''}`}
              onClick={toggleRecording}
              title={isRecording ? 'Parar gravação' : 'Gravar áudio'}
              disabled={isTyping}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill={isRecording ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8">
                <rect x="9" y="2" width="6" height="12" rx="3" />
                <path d="M5 10a7 7 0 0 0 14 0" />
                <line x1="12" y1="19" x2="12" y2="22" /><line x1="8" y1="22" x2="16" y2="22" />
              </svg>
            </button>
            <button type="button" className="icon-btn primary" onClick={() => sendMessage(input)} disabled={!input.trim() || isTyping} title="Enviar">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          </div>
        )}
      </div>

      {showCharModal && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setShowCharModal(false); }}>
          <div className="modal" style={{ maxWidth: 760 }}>
            <h3>{charSaved ? 'Personagem criado' : 'Criar personagem na Simulação'}</h3>

            {charSaved ? (
              <div>
                <div className="alert success">
                  <strong>{charSaved.name}</strong> foi criado(a) na biblioteca de Simulação.
                </div>
                <p className="muted" style={{ fontSize: 14, marginBottom: 18 }}>
                  A persona virou o prompt do simulador e o Bloco 1 virou o gabarito do avaliador.
                  Você pode editá-lo em <code>Administração · Personagens</code>.
                </p>
                <div className="modal-actions">
                  <button type="button" className="btn btn-primary" onClick={() => setShowCharModal(false)}>Fechar</button>
                </div>
              </div>
            ) : (
              <form className="admin-form" onSubmit={handleCreateCharacter}>
                <div style={{ display: 'flex', gap: 14 }}>
                  <div style={{ flex: 2 }}>
                    <label htmlFor="ent-name">Nome</label>
                    <input id="ent-name" value={charForm.name} onChange={(e) => setCharForm({ ...charForm, name: e.target.value })} required />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label htmlFor="ent-age">Idade</label>
                    <input id="ent-age" type="number" min="1" max="120" value={charForm.age} onChange={(e) => setCharForm({ ...charForm, age: e.target.value })} />
                  </div>
                </div>
                <div>
                  <label htmlFor="ent-desc">Descrição visível</label>
                  <input id="ent-desc" value={charForm.description} onChange={(e) => setCharForm({ ...charForm, description: e.target.value })} placeholder="Apresentação curta para o aluno" />
                </div>
                <div>
                  <label htmlFor="ent-b2">
                    Bloco 2 · prompt do simulador <span className="opt">(a persona que o aluno atende)</span>
                  </label>
                  <textarea id="ent-b2" value={charForm.bloco2} onChange={(e) => setCharForm({ ...charForm, bloco2: e.target.value })} className="mono-area" />
                </div>
                <div>
                  <label htmlFor="ent-b1">
                    Bloco 1 · gabarito do avaliador <span className="opt">(nunca vai para o aluno)</span>
                  </label>
                  <textarea id="ent-b1" value={charForm.bloco1} onChange={(e) => setCharForm({ ...charForm, bloco1: e.target.value })} className="mono-area short" />
                </div>
                <div className="modal-actions">
                  <button type="button" className="btn btn-ghost" onClick={() => setShowCharModal(false)} disabled={savingChar}>Cancelar</button>
                  <button type="submit" className="btn btn-primary" disabled={savingChar}>{savingChar ? 'Criando…' : 'Criar personagem'}</button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
