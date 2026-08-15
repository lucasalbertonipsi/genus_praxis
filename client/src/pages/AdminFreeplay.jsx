import { useState, useEffect } from 'react';
import { api, assetUrl } from '../api';
import Typewriter from '../components/Typewriter';
import PhotoPicker from '../components/PhotoPicker';
import '../styles/Admin.css';

const EMPTY_FORM = { name: '', age: '', description: '', assistantId: '', specificInstruction: '', evaluationCriteria: '' };

export default function AdminFreeplay() {
  const [characters, setCharacters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [photoData, setPhotoData] = useState(null);
  const [photoCleared, setPhotoCleared] = useState(false);
  const [currentPhotoUrl, setCurrentPhotoUrl] = useState(null);
  // Ids em salvamento nos toggles de acesso (demanda #7).
  const [togglingId, setTogglingId] = useState(null);

  function load() {
    setLoading(true);
    api.getFreeplay()
      .then(setCharacters)
      .catch((err) => setError(err.message || 'Erro ao carregar personagens'))
      .finally(() => setLoading(false));
  }
  useEffect(() => { load(); }, []);

  function resetPhoto() { setPhotoData(null); setPhotoCleared(false); setCurrentPhotoUrl(null); }
  /**
   * Liga/desliga o acesso de um papel a este cliente (demanda #7). Salva na hora — são
   * dois cliques por linha, e abrir o modal só para isso seria fricção à toa.
   *
   * Atualiza o estado local de forma otimista e recarrega no fim: o `difficulty` da linha
   * é calculado no servidor (vem do MMR) e não deve ser inventado aqui.
   */
  async function toggleAccess(c, field) {
    if (togglingId) return;
    setTogglingId(c.id); setError('');
    const novo = !(c[field] !== false);
    try {
      await api.updateFreeplay(c.id, { [field]: novo });
      setCharacters((list) => list.map((x) => (x.id === c.id ? { ...x, [field]: novo } : x)));
    } catch (err) {
      setError(err.message || 'Erro ao alterar o acesso.');
    } finally {
      setTogglingId(null);
    }
  }

  // Sem NENHUM papel liberado: o cliente é invisível para todo mundo.
  const bloqueados = characters.filter((c) => c.allowStudent === false && c.allowVisitor === false);

  function openCreate() { setForm(EMPTY_FORM); setEditingId(null); setFormError(''); resetPhoto(); setShowModal(true); }

  function openEdit(c) {
    setForm({
      name: c.name || '',
      age: c.age != null ? String(c.age) : '',
      description: c.description || '',
      assistantId: c.assistantId || '',
      specificInstruction: c.specificInstruction || '',
      evaluationCriteria: c.evaluationCriteria || '',
    });
    setEditingId(c.id); setFormError('');
    setPhotoData(null); setPhotoCleared(false);
    setCurrentPhotoUrl(assetUrl(c.photoIcon) || null);
    setShowModal(true);
  }

  function closeModal() { setShowModal(false); setEditingId(null); setForm(EMPTY_FORM); setFormError(''); resetPhoto(); }

  function handleChange(e) {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.name.trim()) return setFormError('O nome é obrigatório.');
    setSaving(true); setFormError('');
    try {
      const payload = { ...form, age: form.age !== '' ? Number(form.age) : null };
      let charId = editingId;
      if (editingId) await api.updateFreeplay(editingId, payload);
      else { const created = await api.createFreeplay(payload); charId = created.id; }
      // No Genus a foto é rota separada (PUT /api/freeplay/:id/photo).
      if (photoData) await api.setFreeplayPhoto(charId, { icon: photoData.iconDataUrl, full: photoData.fullDataUrl });
      else if (photoCleared) await api.setFreeplayPhoto(charId, { clear: true });
      closeModal();
      load();
    } catch (err) {
      setFormError(err.message || 'Erro ao salvar');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(c) {
    if (!window.confirm(`Excluir o personagem "${c.name}"?`)) return;
    try { await api.deleteFreeplay(c.id); load(); }
    catch (err) { setError(err.message || 'Erro ao excluir'); }
  }

  return (
    <div className="admin-page">
      <div className="page-header with-action">
        <div>
          <div className="eyebrow">Administração · Simulação</div>
          <h2><Typewriter text="Personagens da " /><span className="accent"><Typewriter text="Simulação" delayStart={620} /></span></h2>
          <p>Cadastre os clientes simulados que aparecerão na biblioteca de Simulação para os alunos.</p>
        </div>
        <button className="btn btn-primary" onClick={openCreate}>+ Novo Personagem</button>
      </div>

      {/* Aparece só ENQUANTO houver cliente bloqueado. É o aviso do dia do deploy: a
          migração (D7) bloqueou todos os clientes que já existiam, e sem isto o admin
          veria os alunos "sem nenhum cliente" sem nenhuma mensagem de erro. */}
      {bloqueados.length > 0 && (
        <div className="alert" style={{ marginBottom: 18 }}>
          <strong>{bloqueados.length} cliente(s) sem ninguém liberado.</strong>{' '}
          Um cliente só aparece para quem estiver marcado nas colunas <strong>Aluno</strong> e{' '}
          <strong>Visitante</strong>. Enquanto as duas estiverem desmarcadas, ele não existe para
          ninguém — nem na biblioteca, nem no duelo, nem na progressão.
        </div>
      )}

      {error && <div className="alert error">{error}</div>}

      {loading ? (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}><span className="spinner" /> <span style={{ marginLeft: 12 }}>Carregando…</span></div>
      ) : characters.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 40, color: 'var(--text-soft)' }}>Nenhum personagem cadastrado ainda.</div>
      ) : (
        <div className="card tight" style={{ padding: 0, overflow: 'auto' }}>
          <table className="admin-table">
            <thead>
              <tr>
                <th>Nome</th><th>Idade</th><th>Dificuldade</th><th>Descrição</th>
                <th className="access-col" title="Quem pode atender este cliente">Aluno</th>
                <th className="access-col" title="Quem pode atender este cliente">Visitante</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {characters.map((c) => (
                <tr key={c.id}>
                  <td style={{ fontWeight: 600, color: 'var(--text)' }}>{c.name}</td>
                  <td>{c.age != null ? `${c.age} anos` : '—'}</td>
                  <td title={`Dificuldade do MMR (1–100) · ${c.competitiveMatches || 0} partida(s) competitiva(s)`}>
                    <strong>{Number.isFinite(c.difficulty) ? c.difficulty : '—'}</strong>
                  </td>
                  <td style={{ color: 'var(--text-soft)', maxWidth: 380 }}>
                    <span className="clamp-2">{c.description}</span>
                  </td>
                  {/* Acesso por papel (demanda #7). Campo ausente = liberado, mas a
                      migração D7 bloqueou todos os clientes que já existiam. */}
                  {['allowStudent', 'allowVisitor'].map((field) => (
                    <td key={field} className="access-col">
                      <label className="access-check">
                        <input
                          type="checkbox"
                          checked={c[field] !== false}
                          disabled={togglingId === c.id}
                          onChange={() => toggleAccess(c, field)}
                        />
                        <span className="sr-only">
                          {`${field === 'allowStudent' ? 'Aluno' : 'Visitante'} pode atender ${c.name}`}
                        </span>
                      </label>
                    </td>
                  ))}
                  <td>
                    <div className="actions">
                      <button className="btn btn-outline btn-sm" onClick={() => openEdit(c)}>Editar</button>
                      <button className="btn btn-danger btn-sm" onClick={() => handleDelete(c)}>Excluir</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showModal && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) closeModal(); }}>
          <div className="modal">
            <h3>{editingId ? 'Editar Personagem' : 'Novo Personagem'}</h3>
            <form className="admin-form" onSubmit={handleSubmit}>
              <div style={{ display: 'flex', gap: 14 }}>
                <div style={{ flex: 2 }}>
                  <label htmlFor="name">Nome</label>
                  <input id="name" name="name" value={form.name} onChange={handleChange} placeholder="Ex: Ana Luiza" required />
                </div>
                <div style={{ flex: 1 }}>
                  <label htmlFor="age">Idade</label>
                  <input id="age" name="age" type="number" min="1" max="120" value={form.age} onChange={handleChange} placeholder="34" />
                </div>
              </div>
              <div>
                <label>Foto do cliente <em className="opt">(opcional)</em></label>
                <PhotoPicker
                  currentUrl={photoCleared ? null : currentPhotoUrl}
                  onChange={(d) => { setPhotoData(d); setPhotoCleared(false); }}
                  onClear={() => { setPhotoData(null); setPhotoCleared(true); }}
                />
              </div>
              <div>
                <label htmlFor="description">Descrição visível</label>
                <input id="description" name="description" value={form.description} onChange={handleChange} placeholder="Apresentação curta para o aluno" />
              </div>
              <div>
                <label htmlFor="assistantId">OpenAI Assistant ID <em className="opt">(opcional)</em></label>
                <input id="assistantId" name="assistantId" value={form.assistantId} onChange={handleChange} placeholder="asst_xxxxxxxxxxxxxxxxxxxxxxxxxx" />
                <small className="field-hint">
                  Cole apenas o ID começando com <code>asst_</code>. Se vazio, usa a instrução abaixo via chat completion.
                </small>
              </div>
              <div>
                <label htmlFor="specificInstruction">Instrução específica (prompt da IA)</label>
                <textarea id="specificInstruction" name="specificInstruction" value={form.specificInstruction} onChange={handleChange} placeholder="História, traços de personalidade, queixa, forma de se expressar… (usado quando não há Assistant ID)" style={{ minHeight: 180 }} />
                <small className="field-hint">Descreve quem é o cliente. Não aparece para o aluno — vai apenas para a IA que encarna o personagem.</small>
              </div>
              <div>
                <label htmlFor="evaluationCriteria">Critério de correção <em className="opt">(gabarito do avaliador — opcional)</em></label>
                <textarea id="evaluationCriteria" name="evaluationCriteria" value={form.evaluationCriteria} onChange={handleChange} placeholder="Hipóteses corretas, sintomas que o aluno deve identificar, condutas esperadas, red flags… (não aparece para o aluno; vai apenas para o avaliador junto com o log)" style={{ minHeight: 160 }} />
                <small className="field-hint">Texto descritivo (não imperativo). Não aparece para o aluno: é injetado junto do log, server-side, quando o avaliador está ligado.</small>
              </div>
              {formError && <div className="alert error">{formError}</div>}
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={closeModal} disabled={saving}>Cancelar</button>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? 'Salvando…' : editingId ? 'Salvar Alterações' : 'Criar Personagem'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
