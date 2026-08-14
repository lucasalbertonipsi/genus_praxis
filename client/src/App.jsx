import { useState, useEffect } from 'react';
import { Routes, Route, Navigate, Link, useLocation, useNavigate } from 'react-router-dom';
import Login from './pages/Login';
import Home from './pages/Home';
import FreePlay from './pages/FreePlay';
import Competitive from './pages/Competitive';
import SkillMap from './pages/SkillMap';
import ChatSession from './pages/ChatSession';
import EchoSession from './pages/EchoSession';
import Duelo from './pages/Duelo';
import DuelSession from './pages/DuelSession';
import DuelAccept from './pages/DuelAccept';
import LogsSociais from './pages/LogsSociais';
import Progression from './pages/Progression';
import Missoes from './pages/Missoes';
import Ranking from './pages/Ranking';
import Avaliacao from './pages/Avaliacao';
import Logs from './pages/Logs';
import Profile from './pages/Profile';
import AdminFreeplay from './pages/AdminFreeplay';
import AdminExercises from './pages/AdminExercises';
import AdminEntrevistador from './pages/AdminEntrevistador';
import AdminUsers from './pages/AdminUsers';
import AdminFeatures from './pages/AdminFeatures';
import AdminSkills from './pages/AdminSkills';
import AdminAnnouncements from './pages/AdminAnnouncements';
import NotificationBell from './components/NotificationBell';
import SystemUpdates from './components/SystemUpdates';
import LockedModal from './components/LockedModal';
import AnnouncementPopup from './components/AnnouncementPopup';
import ErrorBoundary from './components/ErrorBoundary';
import { FeaturesProvider, useFeatures } from './features';
import { SkillsProvider } from './utils/skills';
import { api, getToken, clearAuth, onSessionExpired, onVisitorExpired, DEMO } from './api';
import { ICONS } from './icons';

const USER_KEY = 'gp_user';

function AppShell({ onUserChange }) {
  const [user, setUser] = useState(() => {
    if (!getToken()) return null;
    const saved = localStorage.getItem(USER_KEY);
    return saved ? JSON.parse(saved) : null;
  });
  const [authChecked, setAuthChecked] = useState(!getToken());
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [streak, setStreak] = useState(null);
  const [title, setTitle] = useState(null);
  // Barra lateral recolhível (só desktop) — estado lembrado entre sessões.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem('gp_sidebar_collapsed') === '1'; } catch { return false; }
  });
  function toggleSidebar() {
    setSidebarCollapsed((v) => {
      const next = !v;
      try { localStorage.setItem('gp_sidebar_collapsed', next ? '1' : '0'); } catch {}
      return next;
    });
  }

  useEffect(() => { setMobileNavOpen(false); }, [location.pathname]);

  // Trava o scroll do body enquanto o drawer está aberto — senão a página
  // rola por trás do menu no celular.
  useEffect(() => {
    if (!mobileNavOpen) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [mobileNavOpen]);

  // Revalida token no boot.
  useEffect(() => {
    if (!getToken()) { setAuthChecked(true); return; }
    let cancelled = false;
    api.me()
      .then((data) => {
        if (cancelled) return;
        if (data && data.user) {
          setUser(data.user);
          localStorage.setItem(USER_KEY, JSON.stringify(data.user));
        }
      })
      .catch(() => { if (!cancelled) { clearAuth(); setUser(null); } })
      .finally(() => { if (!cancelled) setAuthChecked(true); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => onSessionExpired(() => { setUser(null); navigate('/'); }), [navigate]);

  // Visitante com o prazo vencido (demanda #8). NÃO é logout: o token dele continua
  // válido, o que venceu é o direito de acesso. Mostramos a tela explicando, em vez de
  // jogá-lo no login — onde ele tentaria se cadastrar de novo e levaria o mesmo 403.
  const [visitorExpired, setVisitorExpired] = useState(false);
  useEffect(() => onVisitorExpired(() => setVisitorExpired(true)), []);

  // Recarrega a matriz de acesso ao entrar/sair/trocar de conta.
  useEffect(() => { onUserChange(user?.id || null); }, [user?.id, onUserChange]);

  // Acesso a funcionalidades (demandas #3 e #4). `can()` é UX — o servidor barra de novo.
  const { can, lockedMessage } = useFeatures();
  // A funcionalidade cujo cadeado está aberto no pop-up (null = fechado).
  const [lockedFeature, setLockedFeature] = useState(null);

  // Constância (streak) e título ativo, exibidos junto ao avatar.
  // O usuário guarda só o id do título (`activeTitle`); o rótulo e o tier vêm da
  // lista de conquistas — a mesma chamada que já traz o streak. O visitante entra
  // aqui como qualquer aluno (demanda #2): ele pontua, tem título e tem streak.
  useEffect(() => {
    if (!user?.id) { setStreak(null); setTitle(null); return; }
    let cancelled = false;
    api.getGamification(user.id)
      .then((data) => {
        if (cancelled) return;
        setStreak(data?.streak || null);
        const def = user.activeTitle && (data?.achievements || []).find((a) => a.id === user.activeTitle && a.earned);
        setTitle(def ? { title: def.title, tier: def.tier } : null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [user?.id, user?.role, user?.activeTitle, location.pathname]);

  const handleLogin = (u) => { setUser(u); localStorage.setItem(USER_KEY, JSON.stringify(u)); };
  const handleUpdateUser = (u) => { setUser(u); localStorage.setItem(USER_KEY, JSON.stringify(u)); };
  const handleLogout = () => { clearAuth(); setUser(null); navigate('/'); };

  if (!authChecked) return null;
  if (!user) return <Login onLogin={handleLogin} />;
  if (visitorExpired) return <VisitorExpired onLogout={handleLogout} />;

  const isActive = (path) => location.pathname === path || location.pathname.startsWith(path + '/');
  const isTherapist = user.role === 'therapist';
  const isSupervisor = user.role === 'supervisor';
  const isAdmin = user.role === 'admin';
  const isVisitor = user.role === 'visitor';
  const roleLabel = isVisitor ? 'Visitante'
    : isTherapist ? 'Aluno'
    : isSupervisor ? 'Professor'
    : 'Administrador';
  // Quem pratica: aluno, admin e visitante. Professor só supervisiona/avalia.
  // Desde a demanda #2 o visitante tem as MESMAS permissões do aluno — o que muda é a
  // arena (ranking/duelo só entre visitantes, D3/D9), e isso é resolvido no servidor.
  // Por isso o menu não o trata mais como caso especial.
  const canPractice = isTherapist || isAdmin || isVisitor;

  /**
   * Item de menu de uma funcionalidade governada pela matriz (demandas #3 e #4).
   * Liberada → <Link> normal. Bloqueada → o item CONTINUA VISÍVEL (é o pedido da #3),
   * ganha um cadeado e, ao ser clicado, abre o pop-up em vez de navegar.
   *
   * Não navegar é só metade: a rota também barra o acesso por URL direta — e o servidor
   * responde 403 de qualquer jeito, então o cadeado nunca é a única defesa.
   */
  const navFeature = (feature, to, label, icon) => {
    if (can(feature)) {
      return (
        <Link to={to} title={label} className={isActive(to) ? 'active' : ''}>
          {icon}<span>{label}</span>
        </Link>
      );
    }
    return (
      <a
        href={to}
        title={`${label} — bloqueado`}
        className="nav-locked"
        aria-disabled="true"
        onClick={(e) => { e.preventDefault(); setLockedFeature(label); }}
      >
        {icon}<span>{label}</span>
        <span className="nav-lock-icon" aria-hidden="true">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="4" y="11" width="16" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
        </span>
      </a>
    );
  };

  /**
   * Gate de ROTA. O cadeado na sidebar impede o clique, mas não a URL digitada na mão —
   * sem isto ele seria decorativo. (A defesa real continua sendo o 403 do servidor: esta
   * tela só evita que o usuário veja uma página quebrada, cheia de chamadas negadas.)
   */
  const featureRoute = (feature, label, element) => (
    can(feature) ? element : <LockedPage label={label} message={lockedMessage} />
  );

  return (
    <div className={`app-layout ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <div className="topbar-actions">
        <SystemUpdates userId={user.id} />
        <NotificationBell user={user} />
      </div>

      <header className="mobile-topbar">
        <button className="hamburger-btn" onClick={() => setMobileNavOpen((v) => !v)} aria-label="Abrir menu" aria-expanded={mobileNavOpen}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <div className="mobile-topbar-logo">
          <img src={`${import.meta.env.BASE_URL}logo.png`} alt="" className="brand-mark-sm" />
          <span>Genus <span className="accent">Praxis</span></span>
        </div>
        <Link to="/perfil" className="mobile-topbar-avatar" aria-label="Perfil">
          {user.profilePhoto ? <img src={user.profilePhoto} alt={user.name} /> : ICONS.user}
        </Link>
      </header>

      <div className={`mobile-nav-backdrop ${mobileNavOpen ? 'open' : ''}`} onClick={() => setMobileNavOpen(false)} aria-hidden="true" />

      <aside className={`sidebar ${mobileNavOpen ? 'open' : ''}`}>
        <button
          className="sidebar-toggle"
          onClick={toggleSidebar}
          aria-label={sidebarCollapsed ? 'Expandir menu' : 'Recolher menu'}
          title={sidebarCollapsed ? 'Expandir menu' : 'Recolher menu'}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <polyline points={sidebarCollapsed ? '9 18 15 12 9 6' : '15 18 9 12 15 6'} />
          </svg>
        </button>
        <div className="sidebar-logo">
          <img src={`${import.meta.env.BASE_URL}logo.png`} alt="Genus Praxis" className="brand-mark" />
          <h1>Genus <span className="accent">Praxis</span></h1>
          <p>Simulação Clínica</p>
          {DEMO && <span className="sidebar-demo">Demonstração</span>}
        </div>

        <nav className="sidebar-nav">
          <div className="nav-section">Prática</div>
          <Link to="/inicio" title="Início" className={isActive('/inicio') ? 'active' : ''}>{ICONS.home}<span>Início</span></Link>
          {canPractice && (
            <>
              <Link to="/freeplay" title="Simulação" className={isActive('/freeplay') ? 'active' : ''}>{ICONS.simulation}<span>Simulação</span></Link>
              <Link to="/skills" title="Trilha de Competências" className={isActive('/skills') ? 'active' : ''}>{ICONS.skill}<span>Trilha de Competências</span></Link>
              {navFeature('competitivo', '/competitivo', 'Competitivo', ICONS.trophy)}
              {navFeature('duelo', '/duelo', 'Duelo', ICONS.duel)}
              {navFeature('progressao', '/progression', 'Progressão', ICONS.progression)}
              {navFeature('objetivos', '/missoes', 'Objetivos', ICONS.flame)}
            </>
          )}

          <div className="nav-section">Histórico</div>
          {(isTherapist || isVisitor || isAdmin) && (
            <Link to="/logs" title="Minhas sessões" className={isActive('/logs') ? 'active' : ''}>
              {ICONS.log}<span>Minhas sessões</span>
            </Link>
          )}
          {!isSupervisor && navFeature('logsSociais', '/duelo/logs', 'Logs sociais', ICONS.social)}
          {(isSupervisor || isAdmin) && (
            <Link to="/supervisor" title="Logs dos alunos" className={isActive('/supervisor') ? 'active' : ''}>
              {ICONS.supervisor}<span>Logs dos alunos</span>
            </Link>
          )}

          {/* Ranking: o visitante vê o ranking DELE (D3) — o servidor filtra por arena. */}
          <div className="nav-section">Comunidade</div>
          {navFeature('ranking', '/ranking', 'Ranking', ICONS.trophy)}

          {(isSupervisor || isAdmin) && (
            <>
              <div className="nav-section">Avaliação</div>
              <Link to="/avaliacao" title="Avaliar sessão" className={isActive('/avaliacao') ? 'active' : ''}>{ICONS.evaluate}<span>Avaliar sessão</span></Link>
            </>
          )}

          {isAdmin && (
            <>
              <div className="nav-section">Administração</div>
              <Link to="/admin/freeplay" title="Personagens da Simulação" className={isActive('/admin/freeplay') ? 'active' : ''}>
                {ICONS.characters}<span>Personagens</span>
              </Link>
              <Link to="/admin/exercises" title="Exercícios da Trilha" className={isActive('/admin/exercises') ? 'active' : ''}>
                {ICONS.admin}<span>Exercícios da Trilha</span>
              </Link>
              <Link to="/admin/competencias" title="Competências da Trilha" className={isActive('/admin/competencias') ? 'active' : ''}>
                {ICONS.skill}<span>Competências</span>
              </Link>
              <Link to="/admin/entrevistador" title="Entrevistador" className={isActive('/admin/entrevistador') ? 'active' : ''}>
                {ICONS.evaluate}<span>Entrevistador</span>
              </Link>
              <Link to="/admin/contas" title="Contas" className={isActive('/admin/contas') ? 'active' : ''}>
                {ICONS.users}<span>Contas</span>
              </Link>
              <Link to="/admin/anuncios" title="Anúncios" className={isActive('/admin/anuncios') ? 'active' : ''}>
                {ICONS.flame}<span>Anúncios</span>
              </Link>
              <Link to="/admin/acessos" title="Acesso às funcionalidades" className={isActive('/admin/acessos') ? 'active' : ''}>
                {ICONS.admin}<span>Acessos</span>
              </Link>
            </>
          )}
        </nav>

        <div className="sidebar-user">
          <Link to="/perfil" className="profile-mini" title="Editar perfil">
            <span className={`profile-mini-avatar ${streak?.isAlive ? 'with-streak' : ''}`}>
              {user.profilePhoto ? <img src={user.profilePhoto} alt={user.name} /> : ICONS.user}
            </span>
            <div className="profile-mini-info">
              <div className="profile-mini-name">{user.name}</div>
              {title && <div className={`player-title tier-${title.tier}`}>{title.title}</div>}
              <div className="profile-mini-role">
                {streak?.isAlive
                  ? `${streak.current} ${streak.current === 1 ? 'dia consecutivo' : 'dias consecutivos'}`
                  : roleLabel}
              </div>
            </div>
          </Link>
          <button onClick={handleLogout} className="btn btn-ghost btn-sm" title="Sair">{ICONS.exit}</button>
        </div>
      </aside>

      <main className="main-content">
        {/* Demanda #11: um erro de renderização em UMA tela derrubava o app inteiro (tela
            preta). O boundary contém a falha na tela; a sidebar e o menu continuam de pé.
            `resetKey` = a rota atual: ao navegar para outra tela, o erro é limpo. */}
        <ErrorBoundary resetKey={location.pathname}>
        <Routes>
          <Route path="/inicio" element={<Home user={user} />} />

          {/* Prática */}
          <Route path="/freeplay" element={<FreePlay user={user} />} />
          <Route path="/competitivo" element={featureRoute('competitivo', 'Competitivo', <Competitive user={user} />)} />
          <Route path="/skills" element={<SkillMap user={user} />} />
          <Route path="/chat/exercise/:id" element={<ChatSession user={user} />} />
          <Route path="/chat/freeplay/:id" element={<EchoSession user={user} sessionType="freeplay" />} />

          {/* Duelo */}
          <Route path="/duelo" element={featureRoute('duelo', 'Duelo', <Duelo user={user} />)} />
          <Route path="/duelo/logs" element={featureRoute('logsSociais', 'Logs sociais', <LogsSociais user={user} />)} />
          <Route path="/duelo/sessao/:id" element={<DuelSession user={user} />} />
          <Route path="/duelo/aceitar/:id" element={<DuelAccept user={user} />} />
          <Route path="/duelo/convite/:token" element={<DuelAccept user={user} />} />

          <Route path="/progression" element={featureRoute('progressao', 'Progressão', <Progression user={user} />)} />
          <Route path="/missoes" element={featureRoute('objetivos', 'Objetivos', <Missoes user={user} />)} />
          <Route path="/ranking" element={featureRoute('ranking', 'Ranking', <Ranking user={user} />)} />

          {/* Histórico. /logs = as minhas; /supervisor = as dos alunos. */}
          <Route path="/logs" element={<Logs user={user} userId={user.id} />} />
          <Route path="/supervisor" element={<Logs user={user} />} />

          <Route path="/avaliacao" element={<Avaliacao user={user} />} />
          <Route path="/perfil" element={<Profile user={user} onUpdate={handleUpdateUser} />} />

          {isAdmin && <Route path="/admin/freeplay" element={<AdminFreeplay />} />}
          {isAdmin && <Route path="/admin/exercises" element={<AdminExercises />} />}
          {isAdmin && <Route path="/admin/entrevistador" element={<AdminEntrevistador user={user} />} />}
          {isAdmin && <Route path="/admin/contas" element={<AdminUsers user={user} />} />}
          {isAdmin && <Route path="/admin/acessos" element={<AdminFeatures />} />}
          {isAdmin && <Route path="/admin/competencias" element={<AdminSkills />} />}
          {isAdmin && <Route path="/admin/anuncios" element={<AdminAnnouncements />} />}

          <Route path="*" element={<Navigate to={defaultRoute(user)} replace />} />
        </Routes>
        </ErrorBoundary>
      </main>

      {lockedFeature && (
        <LockedModal
          featureLabel={lockedFeature}
          message={lockedMessage}
          onClose={() => setLockedFeature(null)}
        />
      )}

      {/* Anúncios do admin (demanda #9): pop-up no primeiro login após publicado. */}
      <AnnouncementPopup userId={user.id} />
    </div>
  );
}

// Demanda #8: o prazo do visitante venceu. Tela dedicada — um erro genérico o deixaria
// sem entender o que houve, e o login o levaria a se recadastrar (que também dá 403).
function VisitorExpired({ onLogout }) {
  return (
    <div className="login-container">
      <div className="login-card">
        <img src={`${import.meta.env.BASE_URL}logo.png`} alt="Genus Praxis" className="login-mark" />
        <div className="login-eyebrow">Acesso de visitante</div>
        <h1>Seu acesso <span className="accent">expirou</span></h1>
        <div className="login-ornament" />
        <p className="subtitle" style={{ lineHeight: 1.6 }}>
          O período de demonstração terminou. Fale com a administração para renovar o seu
          acesso ou criar uma conta de aluno.
        </p>
        <button type="button" className="btn btn-outline" onClick={onLogout} style={{ marginTop: 18 }}>
          Sair
        </button>
      </div>
    </div>
  );
}

// Tela mostrada quando o usuário chega por URL direta numa funcionalidade bloqueada.
// Mesma mensagem do pop-up (D6) — uma só, definida pelo admin.
function LockedPage({ label, message }) {
  return (
    <div className="page-header" style={{ maxWidth: 560 }}>
      <div className="eyebrow">Acesso bloqueado</div>
      <h2>{label}</h2>
      <div className="ornament" />
      <p style={{ whiteSpace: 'pre-wrap', color: 'var(--text-soft)', lineHeight: 1.6 }}>{message}</p>
    </div>
  );
}

function defaultRoute(user) {
  if (user.role === 'supervisor') return '/supervisor';
  return '/inicio';
}

// O <FeaturesProvider> precisa saber QUEM está logado: a matriz de acesso tem uma coluna
// por papel, então trocar de conta troca a sidebar. Como o provider tem que envolver o
// shell (é ele que consome o hook), o id do usuário sobe para cá via `onUserChange`.
export default function App() {
  const [userId, setUserId] = useState(null);
  return (
    <FeaturesProvider userId={userId}>
      <SkillsProvider>
        <AppShell onUserChange={setUserId} />
      </SkillsProvider>
    </FeaturesProvider>
  );
}
