import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, assetUrl } from '../api';
import Typewriter from '../components/Typewriter';
import { PatientAvatar } from '../components/PatientAvatar';
import '../styles/Play.css';

// Modo Competitivo: mesmos personagens da Simulação, mas cada partida finalizada
// alimenta o MMR (rating competitivo). A dificuldade de cada personagem é aberta
// e exibida no card. O MMR fica oculto até sair da calibração.
// O modo é sinalizado ao chat pela query string ?mode=competitive — o EchoSession
// lê isso e envia mode:'competitive' no saveLog.
export default function Competitive({ user }) {
  const [characters, setCharacters] = useState([]);
  const [mmr, setMmr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    Promise.all([api.getFreeplay(), api.getMyMmr().catch(() => null)])
      .then(([chars, myMmr]) => {
        setCharacters(chars || []);
        setMmr(myMmr);
      })
      .catch((err) => setError(err.message || 'Erro ao carregar personagens'))
      .finally(() => setLoading(false));
  }, [user]);

  const open = (id) => navigate(`/chat/freeplay/${id}?mode=competitive`);

  return (
    <div>
      <div className="page-header">
        <div className="eyebrow">Ranqueado</div>
        <h2><Typewriter text="Compe" /><span className="accent"><Typewriter text="titivo" delayStart={180} /></span></h2>
        <p>
          Os mesmos clientes da Simulação, agora valendo ranking. Cada atendimento finalizado
          atualiza o seu <strong>MMR</strong> — e a <strong>dificuldade</strong> de cada personagem se ajusta ao
          desempenho coletivo. As primeiras partidas são de calibração.
        </p>
        <div className="ornament" />
      </div>

      {mmr && (
        <div className="card tight duel-mmr-card" style={{ marginBottom: 18 }}>
          <span className="section-sub" style={{ margin: 0 }}>Seu MMR</span>
          {mmr.calibrating ? (
            <span style={{ fontWeight: 600, color: 'var(--text-soft)' }}>
              Em calibração — {mmr.matchesRemaining} {mmr.matchesRemaining === 1 ? 'partida restante' : 'partidas restantes'}
            </span>
          ) : (
            <span className="mmr-result-value">{mmr.mmr}</span>
          )}
          <span className="mmr-result-note">
            {mmr.n} {mmr.n === 1 ? 'partida competitiva' : 'partidas competitivas'}
          </span>
        </div>
      )}

      {error && <div className="alert error">{error}</div>}

      {loading ? (
        <div className="card" style={{ textAlign: 'center', padding: '40px 24px' }}>
          <span className="spinner" /> <span style={{ marginLeft: 12, color: 'var(--text-soft)' }}>Carregando personagens…</span>
        </div>
      ) : characters.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--text-soft)' }}>
          Nenhum personagem cadastrado ainda.
        </div>
      ) : (
        <div className="card-grid">
          {characters.map((char) => (
            <div
              key={char.id}
              className="character-card"
              onClick={() => open(char.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') open(char.id); }}
            >
              <div className="character-card-top">
                <PatientAvatar name={char.name} iconUrl={assetUrl(char.photoIcon)} size={72} className="character-card-photo" />
                <div className="character-card-meta">
                  <div className="character-card-header">
                    <h3>{char.name}</h3>
                  </div>
                  {char.age != null && char.age !== '' && <div className="age">{char.age} anos</div>}
                </div>
              </div>
              {char.description && <p>{char.description}</p>}
              <div className="difficulty-tag" title="Dificuldade atual deste cliente (1–100), ajustada pelo desempenho coletivo">
                DIFICULDADE: <strong>{Number.isFinite(char.difficulty) ? char.difficulty : '—'}</strong>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
