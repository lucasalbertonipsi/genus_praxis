// Competências da Trilha — editar, adicionar, remover, reordenar (demandas #5a e #5b).
//
// D5: esta tela PRECISA explicar o sistema. O admin não está mudando um rótulo — o campo
// "critérios" entra no system prompt do paciente e define como o aluno é avaliado. O aviso
// no topo e o texto de cada campo existem por isso, e não são decoração.
import { useEffect, useState, useCallback } from 'react';
import { api } from '../api';
import { useSkillsContext } from '../utils/skills';
import Typewriter from '../components/Typewriter';
import '../styles/Admin.css';

const EMPTY = { name: '', color: '#ff6200', criteria: '' };

export default function AdminSkills() {
  const [skills, setSkills] = useState([]);
  const [orphans, setOrphans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');

  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);

  // Esta tela tem estado PRÓPRIO (precisa de `criteria` e `exerciseCount`, que o contexto
  // compartilhado não carrega para todo mundo). O contexto é quem alimenta o <select> de
  // AdminExercises, o SkillMap e os selos dos Logs — e ele só buscava as competências UMA
  // vez, no mount do app. Sem avisá-lo aqui, o admin editava a trilha e as outras telas
  // seguiam mostrando a lista ANTIGA até um F5 (bug relatado em produção).
  const { reload: reloadSkillsContext } = useSkillsContext();

  const load = useCallback(() => {
    setLoading(true);
    return Promise.all([api.getSkills(), api.adminSkillOrphans().catch(() => [])])
      .then(([list, orfaos]) => { setSkills(list || []); setOrphans(orfaos || []); })
      .catch((e) => setError(e.message || 'Erro ao carregar as competências.'))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  /**
   * Recarrega ESTA tela e avisa o contexto compartilhado.
   *
   * ⚠ Separado do `load` de propósito. A primeira versão chamava
   * `reloadSkillsContext()` de dentro do `load` e listava a função nas deps do
   * `useCallback` — o que criava um LAÇO: `load` mudava o estado do provider → o provider
   * devolvia um `reload` novo → `load` era recriado → o `useEffect([load])` disparava →
   * `load` de novo. Em produção a tela entrava em ciclo e exibia o FALLBACK.
   *
   * Só as MUTAÇÕES chamam isto; o carregamento inicial usa `load` puro, porque o provider
   * já busca as competências sozinho ao montar.
   */
  const reloadAll = useCallback(() => {
    reloadSkillsContext();
    return load();
  }, [load, reloadSkillsContext]);

  function openEdit(sk) {
    setEditingId(sk.id);
    setForm({ name: sk.name || '', color: sk.color || '#ff6200', criteria: sk.criteria || '' });
    setCreating(false);
    setError(''); setOk('');
  }
  function openCreate() {
    setCreating(true);
    setEditingId(null);
    setForm(EMPTY);
    setError(''); setOk('');
  }
  function closeForm() { setEditingId(null); setCreating(false); setForm(EMPTY); }

  async function save(e) {
    e.preventDefault();
    setSaving(true); setError(''); setOk('');
    try {
      if (creating) await api.adminCreateSkill(form);
      else await api.adminUpdateSkill(editingId, form);
      closeForm();
      reloadAll();
      setOk('Competência salva.');
    } catch (err) {
      setError(err.message || 'Erro ao salvar.');
    } finally {
      setSaving(false);
    }
  }

  /**
   * Apagar. O servidor recusa sem `confirm` e devolve **quantos exercícios ficarão
   * órfãos** — é assim que a decisão D4 ("deixa órfão") deixa de ser silenciosa: o admin
   * vê o número antes de decidir.
   */
  async function remove(sk) {
    setError(''); setOk('');

    // Quantos exercícios usam esta competência. O `GET /api/skills` já traz o número para
    // o admin — não precisamos de um round-trip só para perguntar.
    // (O servidor ainda exige `confirm=1`; é ele quem garante que ninguém apaga às cegas
    // pela API, mesmo que esta tela seja contornada.)
    const afetados = skills.find((s) => s.id === sk.id)?.exerciseCount ?? 0;

    const aviso = afetados > 0
      ? `Apagar "${sk.name}"?\n\n${afetados} exercício(s) ficarão SEM competência. Eles vão:\n`
        + '• sumir da Trilha (o mapa só desenha exercícios com competência);\n'
        + '• perder os critérios desta competência no prompt do paciente;\n'
        + '• continuar existindo — você poderá reatribuí-los na lista "sem competência" abaixo.'
      : `Apagar "${sk.name}"? Nenhum exercício usa esta competência.`;

    if (!window.confirm(aviso)) return;

    try {
      await api.adminDeleteSkill(sk.id, { confirm: true });
      reloadAll();
      setOk(afetados > 0 ? `Competência apagada. ${afetados} exercício(s) ficaram sem competência.` : 'Competência apagada.');
    } catch (err) {
      setError(err.message || 'Erro ao apagar.');
    }
  }

  /** Mover para cima/baixo: a ordem da lista é a ordem dos vértices no mapa. */
  async function move(idx, delta) {
    const alvo = idx + delta;
    if (alvo < 0 || alvo >= skills.length) return;
    const nova = [...skills];
    [nova[idx], nova[alvo]] = [nova[alvo], nova[idx]];
    setSkills(nova);                                  // otimista
    try {
      await api.adminReorderSkills(nova.map((s) => s.id));
    } catch (err) {
      setError(err.message || 'Erro ao reordenar.');
      reloadAll();
    }
  }

  if (loading) return <div className="admin-page"><p>Carregando…</p></div>;

  return (
    <div className="admin-page">
      <div className="page-header with-action">
        <div>
          <div className="eyebrow">Administração · Trilha</div>
          <h2><Typewriter text="Compe" /><span className="accent"><Typewriter text="tências" delayStart={300} /></span></h2>
        </div>
        <button className="btn btn-primary" onClick={openCreate}>+ Nova competência</button>
      </div>

      {/* D5 — o admin precisa entender o que está mexendo. */}
      <div className="card feature-warning">
        <h3 className="card-title">Isto muda como o aluno é avaliado</h3>
        <p>
          Uma competência não é só um rótulo colorido no mapa. O campo <strong>critérios</strong> é
          enviado para a IA <strong>dentro do prompt do paciente</strong>: é ele que diz o que a IA deve
          observar e cobrar do aluno naquela competência.
        </p>
        <p>Ao editar os critérios, você muda:</p>
        <ul>
          <li>a <strong>avaliação</strong> de <strong>todos</strong> os exercícios daquela competência — inclusive os já criados;</li>
          <li>o <strong>comportamento do paciente</strong> na conversa (o prompt é montado com esse texto);</li>
          <li>o que aparece no <strong>Mapa de Competências</strong> e nos <strong>logs</strong>.</li>
        </ul>
        <p className="feature-warning-note">
          A <strong>ordem</strong> da lista é a ordem dos vértices no mapa. Apagar uma competência deixa os
          exercícios dela <strong>sem competência</strong> — eles somem da trilha até serem reatribuídos.
        </p>
      </div>

      {error && <div className="alert error">{error}</div>}
      {ok && <div className="alert success">{ok}</div>}

      {(creating || editingId) && (
        <form className="card admin-form" onSubmit={save}>
          <h3 className="card-title">{creating ? 'Nova competência' : 'Editar competência'}</h3>

          <div style={{ display: 'flex', gap: 14 }}>
            <div style={{ flex: 1 }}>
              <label htmlFor="sk-name">Nome</label>
              <input
                id="sk-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Ex.: Hermenêutica"
                required
              />
            </div>
            <div>
              <label htmlFor="sk-color">Cor</label>
              <input
                id="sk-color"
                type="color"
                value={form.color}
                onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))}
                style={{ width: 64, height: 42, padding: 4 }}
              />
            </div>
          </div>

          <div>
            <label htmlFor="sk-criteria">Critérios de avaliação</label>
            <textarea
              id="sk-criteria"
              value={form.criteria}
              onChange={(e) => setForm((f) => ({ ...f, criteria: e.target.value }))}
              placeholder="O que a IA deve observar e cobrar do aluno nesta competência. Ex.: Critério 8 (Formulação de caso ×1) + Critério 9 (Insight ×2)"
              style={{ minHeight: 140 }}
              maxLength={2000}
            />
            <small className="field-hint">
              Este texto vai <strong>direto para o prompt do paciente</strong> e orienta a avaliação da IA.
              Não é um rótulo — mudar aqui muda a nota dos alunos nos exercícios desta competência.
            </small>
          </div>

          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={closeForm} disabled={saving}>Cancelar</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Salvando…' : 'Salvar'}
            </button>
          </div>
        </form>
      )}

      <div className="card tight" style={{ padding: 0, overflow: 'auto' }}>
        <table className="admin-table">
          <thead>
            <tr><th>#</th><th>Nome</th><th>Cor</th><th>Critérios</th><th>Exercícios</th><th>Ações</th></tr>
          </thead>
          <tbody>
            {skills.map((sk, i) => (
              <tr key={sk.id}>
                <td style={{ color: 'var(--text-muted)' }}>{i + 1}</td>
                <td style={{ fontWeight: 600, color: 'var(--text)' }}>{sk.name}</td>
                <td><span className="skill-swatch" style={{ background: sk.color }} title={sk.color} /></td>
                <td style={{ color: 'var(--text-soft)', maxWidth: 380 }}>
                  <span className="clamp-2">{sk.criteria || <em>— sem critérios —</em>}</span>
                </td>
                <td>{sk.exerciseCount ?? 0}</td>
                <td>
                  <div className="actions">
                    <button className="btn btn-ghost btn-sm" onClick={() => move(i, -1)} disabled={i === 0} title="Subir">↑</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => move(i, 1)} disabled={i === skills.length - 1} title="Descer">↓</button>
                    <button className="btn btn-outline btn-sm" onClick={() => openEdit(sk)}>Editar</button>
                    <button className="btn btn-danger btn-sm" onClick={() => remove(sk)}>Apagar</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Sem esta seção, um exercício órfão simplesmente DESAPARECE — some da trilha e
          ninguém nunca mais o encontra. A D4 aceitou deixar órfão; não aceitou sumir. */}
      {orphans.length > 0 && (
        <div className="card" style={{ marginTop: 20 }}>
          <h3 className="card-title">Exercícios sem competência ({orphans.length})</h3>
          <p className="settings-row-desc">
            Estes exercícios apontam para uma competência que não existe mais. Eles{' '}
            <strong>não aparecem na Trilha</strong> e o prompt do paciente é montado sem os critérios
            de competência. Edite cada um em <strong>Exercícios da Trilha</strong> e escolha uma competência.
          </p>
          <ul className="orphan-list">
            {orphans.map((o) => (
              <li key={o.id}>
                <strong>{o.title || o.id}</strong>
                <span className="muted"> · competência {o.skillId ?? '—'} (inexistente)</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
