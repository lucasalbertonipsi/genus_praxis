import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, assetUrl } from '../api';
import Typewriter from '../components/Typewriter';
import ScoreBadge from '../components/ScoreBadge';
import { PatientAvatar } from '../components/PatientAvatar';
import '../styles/Play.css';

export default function FreePlay({ user }) {
  const [characters, setCharacters] = useState([]);
  const [bestScores, setBestScores] = useState({});
  const [attended, setAttended] = useState(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    // A fonte de verdade da "melhor nota com este cliente" é o log — o EchoSession
    // (freeplay) não grava em progress.json, só em logs.json.
    Promise.all([
      api.getFreeplay(),
      user?.id ? api.getLogs(user.id) : Promise.resolve([]),
    ])
      .then(([chars, logs]) => {
        setCharacters(chars || []);
        const max = {};
        const seen = new Set();
        for (const l of logs || []) {
          if (l.type !== 'freeplay') continue;
          if (!l.itemId) continue;
          seen.add(String(l.itemId));
          if (!Number.isFinite(l.score)) continue;
          if (max[l.itemId] === undefined || l.score > max[l.itemId]) {
            max[l.itemId] = l.score;
          }
        }
        setBestScores(max);
        setAttended(seen);
      })
      .catch((err) => setError(err.message || 'Erro ao carregar personagens'))
      .finally(() => setLoading(false));
  }, [user]);

  const open = (id) => navigate(`/chat/freeplay/${id}`);

  return (
    <div>
      <div className="page-header">
        <div className="eyebrow">Prática</div>
        <h2><Typewriter text="Simu" /><span className="accent"><Typewriter text="lação" delayStart={180} /></span></h2>
        <p>
          Atenda clientes simulados para praticar escuta, manejo relacional e tempo de sessão.
          Ao finalizar, o log é salvo no seu histórico e enviado para análise.
        </p>
        <div className="ornament" />
      </div>

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
          {characters.map((char) => {
            const charBest = bestScores[char.id];
            const isReturn = attended.has(String(char.id));
            return (
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
                      {Number.isFinite(charBest) && (
                        <span title="Sua maior nota com este cliente"><ScoreBadge score={charBest} /></span>
                      )}
                    </div>
                    {char.age != null && char.age !== '' && <div className="age">{char.age} anos</div>}
                  </div>
                </div>
                {char.description && <p>{char.description}</p>}
                {Number.isFinite(char.difficulty) && (
                  <div className="difficulty-tag" title="Dificuldade atual deste cliente (1–100), ajustada pelo desempenho coletivo no modo competitivo">
                    DIFICULDADE: <strong>{char.difficulty}</strong>
                  </div>
                )}
                {isReturn && (
                  <div className="progression-tag" title="Você já atendeu este cliente">↩ Reatendimento</div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
