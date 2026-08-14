import { useState } from 'react';
import { api, DEMO } from '../api';
import { maskPhone, validateVisitor } from '../visitorForm';

export default function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Cadastro do visitante (demanda #1): nome, e-mail e telefone, os três únicos.
  // Não tem senha — informar os dados já é o login.
  const [showVisitorForm, setShowVisitorForm] = useState(false);
  const [visitor, setVisitor] = useState({ name: '', email: '', phone: '' });
  const [visitorErrors, setVisitorErrors] = useState({});

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const user = await api.login(username, password);
      onLogin(user);
    } catch (err) {
      setError(err.message || 'Credenciais inválidas');
    } finally {
      setLoading(false);
    }
  }

  async function quickLogin(role) {
    setError('');
    setLoading(true);
    try {
      const user = await api.login(role, 'demo');
      onLogin(user);
    } catch (err) {
      setError(err.message || 'Erro');
    } finally {
      setLoading(false);
    }
  }

  function setVisitorField(field, value) {
    setVisitor((v) => ({ ...v, [field]: field === 'phone' ? maskPhone(value) : value }));
    // Limpa o erro do campo assim que o usuário mexe nele.
    setVisitorErrors((e) => (e[field] ? { ...e, [field]: undefined } : e));
  }

  async function handleVisitor(e) {
    e.preventDefault();
    setError('');

    // Validação local só para dar retorno rápido — quem manda é o servidor.
    const local = validateVisitor(visitor);
    if (Object.keys(local).length) { setVisitorErrors(local); return; }

    setVisitorErrors({});
    setLoading(true);
    try {
      const user = await api.loginVisitor(visitor);
      onLogin(user);
    } catch (err) {
      // 409 → um campo já cadastrado (`field`). 400 → lista de campos (`fields`).
      if (err.field) {
        setVisitorErrors({ [err.field]: err.message });
      } else if (Array.isArray(err.fields)) {
        setVisitorErrors(Object.fromEntries(err.fields.map((f) => [f.field, f.error])));
      } else {
        setError(err.message || 'Não foi possível entrar como visitante.');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-container">
      <div className="login-card">
        <img src={`${import.meta.env.BASE_URL}logo.png`} alt="Genus Praxis" className="login-mark" />
        <div className="login-eyebrow">Plataforma de Simulação Clínica</div>
        <h1>Genus <span className="accent">Praxis</span></h1>
        <p className="subtitle">todo ser humano é único e possui um potencial ilimitado</p>
        <div className="login-ornament" />

        <form onSubmit={handleSubmit}>
          <div>
            <label htmlFor="username">Usuário</label>
            <input id="username" type="text" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="seu usuário" autoComplete="username" required />
          </div>
          <div>
            <label htmlFor="password">Senha</label>
            <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="sua senha" autoComplete="current-password" required />
          </div>
          {error && <div className="alert error">{error}</div>}
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Entrando…' : 'Entrar'}
          </button>
        </form>

        {/* Visitante depende do backend (POST /api/login/visitor); no modo
            demonstração não existe servidor, então nada disso aparece. */}
        {!DEMO && (
          <div className="login-visitor">
            <div className="login-divider"><span>ou</span></div>

            {!showVisitorForm ? (
              <>
                <button type="button" className="btn btn-outline" onClick={() => setShowVisitorForm(true)} disabled={loading}>
                  Entrar como visitante
                </button>
                <p className="login-visitor-note">
                  Conheça a plataforma sem criar senha. Basta nome, e-mail e telefone.
                </p>
              </>
            ) : (
              <form onSubmit={handleVisitor} noValidate>
                <div>
                  <label htmlFor="v-name">Nome</label>
                  <input
                    id="v-name"
                    value={visitor.name}
                    onChange={(e) => setVisitorField('name', e.target.value)}
                    className={visitorErrors.name ? 'input-error' : ''}
                    placeholder="seu nome"
                    autoComplete="name"
                    autoFocus
                  />
                  {visitorErrors.name && <div className="field-error">{visitorErrors.name}</div>}
                </div>
                <div>
                  <label htmlFor="v-email">E-mail</label>
                  <input
                    id="v-email"
                    type="email"
                    value={visitor.email}
                    onChange={(e) => setVisitorField('email', e.target.value)}
                    className={visitorErrors.email ? 'input-error' : ''}
                    placeholder="voce@email.com"
                    autoComplete="email"
                  />
                  {visitorErrors.email && <div className="field-error">{visitorErrors.email}</div>}
                </div>
                <div>
                  <label htmlFor="v-phone">Telefone</label>
                  <input
                    id="v-phone"
                    type="tel"
                    inputMode="numeric"
                    value={visitor.phone}
                    onChange={(e) => setVisitorField('phone', e.target.value)}
                    className={visitorErrors.phone ? 'input-error' : ''}
                    placeholder="(11) 91234-5678"
                    autoComplete="tel"
                  />
                  {visitorErrors.phone && <div className="field-error">{visitorErrors.phone}</div>}
                </div>

                <button type="submit" className="btn btn-primary" disabled={loading}>
                  {loading ? 'Entrando…' : 'Entrar'}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => { setShowVisitorForm(false); setVisitorErrors({}); setError(''); }}
                  disabled={loading}
                >
                  Voltar
                </button>

                <p className="login-visitor-note">
                  Sem senha: seus dados já são o seu acesso. Se você já entrou antes, use os
                  mesmos dados para voltar à sua conta.
                </p>
              </form>
            )}
          </div>
        )}

        {DEMO && (
          <div className="login-demo">
            <div className="login-demo-tag">Modo demonstração · sem servidor</div>
            <p>Entre com qualquer senha, ou acesse direto como:</p>
            <div className="login-demo-btns">
              <button type="button" className="btn btn-outline btn-sm" onClick={() => quickLogin('admin')} disabled={loading}>Administrador</button>
              <button type="button" className="btn btn-outline btn-sm" onClick={() => quickLogin('supervisor')} disabled={loading}>Professor</button>
              <button type="button" className="btn btn-outline btn-sm" onClick={() => quickLogin('aluno')} disabled={loading}>Aluno</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
