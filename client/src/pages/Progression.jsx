import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, assetUrl } from '../api';
import Typewriter from '../components/Typewriter';
import { PatientAvatar } from '../components/PatientAvatar';
import ProgressionChat from '../components/ProgressionChat';
import '../styles/Progression.css';

export default function Progression({ user }) {
  const [step, setStep] = useState('patient'); // patient | chat | result
  const [patients, setPatients] = useState([]);
  const [selectedPatient, setSelectedPatient] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    let alive = true;
    async function loadPatients() {
      try {
        const data = await api.getProgressionPatients();
        if (alive) setPatients(data || []);
      } catch (err) {
        if (alive) setError(err.message || 'Erro ao carregar clientes.');
      } finally {
        if (alive) setLoading(false);
      }
    }
    loadPatients();
    return () => { alive = false; };
  }, [user]);

  function selectPatient(patient) {
    setSelectedPatient(patient);
    setStep('chat');
  }

  function handleEvaluationComplete(evaluation) {
    // evaluation contém: { evaluation, score, criteria }
    setSelectedPatient((prev) => ({ ...prev, evaluation }));
    setStep('result');
  }

  function startNewSession() {
    setStep('patient');
    setSelectedPatient(null);
  }

  // ---- Tela de resultado ----
  if (step === 'result' && selectedPatient?.evaluation) {
    const ev = selectedPatient.evaluation;
    return (
      <div className="progression-page">
        <div className="page-header">
          <div className="eyebrow">Progressão · {selectedPatient.name}</div>
          <h2>Análise <span className="accent">concluída</span></h2>
          <div className="ornament" />
        </div>

        <div className="card progression-result">
          <div className="progression-evaluation">
            {ev.evaluation && (
              <div className="progression-text">{ev.evaluation}</div>
            )}
          </div>

          {ev.criteria && (
            <div className="progression-scores">
              <h3>Notas por critério (Atendimento 2)</h3>
              <div className="scores-grid">
                {Object.entries(ev.criteria).map(([criterion, score]) => (
                  <div key={criterion} className="score-item">
                    <span>{criterion}</span>
                    <strong>{score}</strong>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="progression-actions">
            <button className="btn btn-primary" onClick={startNewSession}>
              Avaliar outro cliente
            </button>
            <button className="btn btn-outline" onClick={() => navigate('/inicio')}>
              Voltar ao início
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---- Tela de chat ----
  if (step === 'chat' && selectedPatient) {
    return (
      <ProgressionChat
        patient={selectedPatient}
        user={user}
        onEvaluationComplete={handleEvaluationComplete}
        onCancel={() => {
          setStep('patient');
          setSelectedPatient(null);
        }}
      />
    );
  }

  // ---- Tela de seleção de cliente ----
  return (
    <div className="progression-page">
      <div className="page-header">
        <div className="eyebrow">Progressão</div>
        <h2><Typewriter text="Pro" /><span className="accent"><Typewriter text="gressão" delayStart={140} /></span></h2>
        <p>
          Escolha um cliente que você já atendeu, converse com ele novamente e nós
          comparamos como você evoluiu do primeiro atendimento para o segundo.
        </p>
        <div className="ornament" />
      </div>

      {error && <div className="alert error">{error}<button onClick={() => setError('')} className="close">×</button></div>}

      {loading ? (
        <div className="card" style={{ textAlign: 'center', padding: '40px 24px' }}>
          <span className="spinner" /> <span style={{ marginLeft: 12, color: 'var(--text-soft)' }}>Carregando…</span>
        </div>
      ) : patients.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--text-soft)' }}>
          <p>Você ainda não atendeu nenhum cliente. Comece uma Simulação Livre para criar histórico.</p>
        </div>
      ) : (
        <>
          <h3 style={{ marginBottom: 16 }}>Escolha um cliente para avaliar progresso</h3>
          <div className="card-grid">
            {patients.map((patient) => (
              <div
                key={patient.id}
                className="character-card"
                onClick={() => selectPatient(patient)}
              >
                <div className="character-card-top">
                  <PatientAvatar
                    name={patient.name}
                    iconUrl={patient.photoIcon ? assetUrl(patient.photoIcon) : null}
                    size={52}
                    className="character-card-photo"
                  />
                  <div className="character-card-meta">
                    <div className="character-card-header"><h3>{patient.name}</h3></div>
                    {patient.age != null && <div className="age">{patient.age} anos</div>}
                  </div>
                </div>
                {patient.description && <p>{patient.description}</p>}
                {patient.lastAttendanceAt && (
                  <div className="progression-tag">
                    Último atendimento: {new Date(patient.lastAttendanceAt).toLocaleDateString('pt-BR')}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
