import { useState, useEffect, useRef } from 'react';
import { api } from '../api';
import { downloadText } from '../logFiles';
import '../styles/Progression.css';

export default function ProgressionChat({ patient, user, onEvaluationComplete, onCancel }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [phase, setPhase] = useState('simulation'); // simulation | evaluating | concluded
  const [isTyping, setIsTyping] = useState(false);
  const [error, setError] = useState('');
  const [confirmingFinalize, setConfirmingFinalize] = useState(false);
  const [evaluationText, setEvaluationText] = useState('');
  const [criteria, setCriteria] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [sessionStarted, setSessionStarted] = useState(false);

  const messagesEndRef = useRef(null);
  const timerRef = useRef(null);
  const startedAtRef = useRef(null);
  const finishedRef = useRef(false);
  const initializedRef = useRef(false);
  const textareaRef = useRef(null);

  // Cronômetro
  useEffect(() => {
    startedAtRef.current = Date.now();
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 1000);
    return () => clearInterval(timerRef.current);
  }, []);

  // Kickoff: cliente fala primeiro
  useEffect(() => {
    if (initializedRef.current || sessionStarted) return;
    initializedRef.current = true;

    async function startSession() {
      const kickoffMsg = { role: 'user', content: 'Iniciar', isSystem: true };
      setMessages([kickoffMsg]);
      setIsTyping(true);

      try {
        const apiMessages = [{ role: 'user', content: 'Iniciar' }];
        const response = await api.chat(apiMessages, { type: 'freeplay', itemId: patient.id });
        const assistantContent = typeof response === 'string' ? response : (response.content || response.message || '');

        if (assistantContent) {
          setMessages((prev) => [...prev, { role: 'assistant', content: assistantContent }]);
        }
      } catch (err) {
        setError(err.message || 'Erro ao iniciar conversa.');
      } finally {
        setIsTyping(false);
        setSessionStarted(true);
      }
    }

    startSession();
  }, [patient]);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function sendMessage() {
    if (!input.trim() || isTyping || !sessionStarted || phase !== 'simulation') return;

    const userMessage = { role: 'user', content: input.trim() };
    setInput('');
    setMessages((prev) => [...prev, userMessage]);
    setIsTyping(true);
    setError('');

    try {
      const apiMessages = [...messages, userMessage]
        .filter((m) => m && m.role)
        .map((m) => ({ role: m.role, content: m.content }));

      const response = await api.chat(apiMessages, { type: 'freeplay', itemId: patient.id });
      const assistantContent = typeof response === 'string' ? response : (response.content || response.message || '');

      if (assistantContent) {
        setMessages((prev) => [...prev, { role: 'assistant', content: assistantContent }]);
      }
    } catch (err) {
      setError(err.message || 'Erro ao enviar mensagem.');
      setMessages((prev) => prev.slice(0, -1));
    } finally {
      setIsTyping(false);
    }
  }

  async function submitEvaluation() {
    if (finishedRef.current || phase !== 'evaluating') return;
    finishedRef.current = true;
    setError('');

    // Mensagens sem o kickoff de sistema ("Iniciar")
    const apiMessages = messages
      .filter((m) => !m.isSystem)
      .map((m) => ({ role: m.role, content: m.content }));

    try {
      const result = await api.evaluateProgression({
        characterId: patient.id,
        messages: apiMessages,
      });

      // A avaliação por IA pode estar desligada para este perfil (matriz de acesso,
      // demanda #4 — cada avaliação é uma chamada paga). Nesse caso o servidor responde
      // `{disabled: true}` com 200, e sem esta mensagem a tela de conclusão apareceria
      // simplesmente EM BRANCO, sem o aluno entender o que houve.
      setEvaluationText(
        result.disabled
          ? 'O atendimento foi registrado. A devolutiva automática não está disponível para o seu perfil.'
          : (result.evaluation || ''),
      );
      setCriteria(result.criteria || null);
      setPhase('concluded');

      // Salva o log (saveLog EXIGE type; difficulty é resolvida server-side)
      await api.saveLog({
        type: 'freeplay',
        mode: 'training',
        itemId: patient.id,
        itemTitle: patient.name,
        durationSeconds: elapsed,
        messages: apiMessages,
        evaluation: result.evaluation,
        criteriaScores: result.criteria,
        score: result.score,
      });

      onEvaluationComplete({
        evaluation: result.evaluation,
        score: result.score,
        criteria: result.criteria,
      });
    } catch (err) {
      // 400: não há atendimento anterior. Volta o botão pro estado normal.
      setError(err.message || 'Erro ao executar avaliação.');
      setPhase('simulation');
      finishedRef.current = false;
    }
  }

  function downloadEvaluation() {
    if (!evaluationText) return;
    const text = `AVALIAÇÃO DE PROGRESSÃO
Cliente: ${patient.name}
Data: ${new Date().toLocaleString('pt-BR')}

${evaluationText}`;
    downloadText(`progressao_${patient.name}.txt`, text);
  }

  function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  // ---- Fase de conclusão (resultado) ----
  if (phase === 'concluded') {
    return (
      <div className="progression-page">
        <div className="page-header">
          <div className="eyebrow">Progressão · {patient.name}</div>
          <h2>Avaliação <span className="accent">concluída</span></h2>
          <div className="ornament" />
        </div>

        {error && <div className="alert error">{error}<button onClick={() => setError('')} className="close">×</button></div>}

        <div className="chat-evaluation-display">
          <div className="evaluation-section">
            <div className="evaluation-text">{evaluationText}</div>
          </div>

          {criteria && (
            <div className="evaluation-scores">
              <h3>Notas do Atendimento 2</h3>
              <div className="scores-grid">
                {Object.entries(criteria).map(([criterion, score]) => (
                  <div key={criterion} className="score-item">
                    <span>{criterion}</span>
                    <strong>{score}</strong>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="evaluation-actions">
            <button className="btn btn-outline btn-sm" onClick={downloadEvaluation}>
              Baixar avaliação
            </button>
            <button className="btn btn-primary btn-sm" onClick={onCancel}>
              Voltar
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---- Fase de simulação (chat) ou aguardando avaliação ----
  return (
    <div className="progression-page echo-chat">
      <div className="chat-header">
        <div>
          <h2>{patient.name}</h2>
          <p style={{ fontSize: 13, color: 'var(--text-soft)', margin: 0 }}>Avaliação de progressão</p>
        </div>
        <div className="chat-header-right">
          <div className="elapsed-time">{formatTime(elapsed)}</div>
          <button className="btn btn-ghost btn-sm" onClick={onCancel}>×</button>
        </div>
      </div>

      {error && <div className="alert error" style={{ margin: '0 0 12px' }}>{error}<button onClick={() => setError('')} className="close">×</button></div>}

      <div className="chat-container">
        <div className="chat-messages">
          {messages.map((msg, idx) => (
            <div key={idx} className={`chat-message-row ${msg.role}`}>
              <div className={`chat-message ${msg.role}`}>{msg.content}</div>
            </div>
          ))}
          {isTyping && (
            <div className="chat-message-row assistant">
              <div className="chat-message assistant">
                <span className="spinner-sm" style={{ marginRight: 8 }} />
                {patient.name} está digitando
                <span className="delayed">.</span>
                <span className="delayed delay-1">.</span>
                <span className="delayed delay-2">.</span>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {phase === 'simulation' && (
        <div className="chat-input-area">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
            }}
            placeholder="Sua intervenção…  ·  Enter envia · Shift+Enter quebra linha"
            rows={1}
            disabled={isTyping || !sessionStarted}
          />
          <button
            className="btn btn-primary"
            onClick={sendMessage}
            disabled={isTyping || !input.trim() || !sessionStarted}
          >
            Enviar
          </button>

          <div style={{ marginTop: 8 }}>
            {!confirmingFinalize ? (
              <button
                className="btn btn-outline btn-sm"
                onClick={() => setConfirmingFinalize(true)}
                disabled={isTyping || messages.length <= 1}
              >
                Finalizar e avaliar
              </button>
            ) : (
              <div className="confirm-box">
                <p>Finalizar a sessão e avaliar o progresso?</p>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      setConfirmingFinalize(false);
                      setPhase('evaluating');
                      submitEvaluation();
                    }}
                  >
                    Sim, finalizar
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => setConfirmingFinalize(false)}
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {phase === 'evaluating' && (
        <div className="chat-input-area transcribing">
          <span className="spinner-sm" /> <span>Avaliando progresso…</span>
        </div>
      )}
    </div>
  );
}
