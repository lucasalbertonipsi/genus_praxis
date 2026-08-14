// Competências da Trilha, no client (demandas #5a e #5b).
//
// Antes isto era um objeto HARDCODED com as 5 competências. Agora a fonte única é o
// servidor (`skills.json` → `GET /api/skills`): o admin edita nome, cor e critérios, e
// pode adicionar ou remover competências — sem deploy.
//
// A geometria do SkillMap deixou de ser um pentágono literal: os vértices são calculados
// a partir de N (`360 / N`), então 3, 5 ou 8 competências desenham o polígono certo.

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api } from '../api';

/**
 * Usado só enquanto o servidor não responde — evita a tela piscar com um polígono de
 * zero lados. São as 5 competências originais.
 */
export const FALLBACK_SKILLS = [
  { id: 1, name: 'Hermenêutica', color: '#ff6200' },
  { id: 2, name: 'Estrutura', color: '#7a34b8' },
  { id: 3, name: 'Empatia', color: '#e05200' },
  { id: 4, name: 'Especificidade do caso', color: '#b06adf' },
  { id: 5, name: 'Eu', color: '#c14503' },
];

/**
 * Ângulos dos vértices do polígono, em graus, para N competências.
 *
 * O primeiro vértice fica no topo (270°) e os demais se distribuem em passos iguais no
 * sentido horário. Com N = 5 isto reproduz EXATAMENTE o pentágono fixo antigo
 * (`[270, 342, 54, 126, 198]` = 270 + k·72), então a trilha existente não muda de desenho.
 */
export function polygonAngles(n) {
  if (!n || n < 1) return [];
  const step = 360 / n;
  return Array.from({ length: n }, (_, i) => (270 + i * step) % 360);
}

/** `{ [id]: nome }` — para quem só precisa do rótulo (Logs, ChatSession, AdminExercises). */
export function skillNameMap(skills) {
  return Object.fromEntries((skills || []).map((s) => [s.id, s.name]));
}

/** `{ [id]: cor }`. */
export function skillColorMap(skills) {
  return Object.fromEntries((skills || []).map((s) => [s.id, s.color]));
}

/** Rótulo de uma competência, com fallback para o id (exercício órfão, D4). */
export function skillLabel(names, skillId) {
  if (skillId == null || skillId === '') return null;
  return names[skillId] || `Competência ${skillId}`;
}

/**
 * Carrega as competências do servidor.
 *
 * Enquanto carrega, devolve o fallback — assim nenhuma tela renderiza um polígono vazio
 * nem um rótulo em branco. O admin recebe também `criteria` e `exerciseCount`; o aluno,
 * só id/nome/cor (os critérios são material de avaliação e não vazam para ele).
 */
export function useSkills() {
  const [skills, setSkills] = useState(FALLBACK_SKILLS);
  const [loading, setLoading] = useState(true);
  // `stale` = estamos mostrando o FALLBACK porque a carga falhou, não porque estas são as
  // competências do sistema. Antes o erro era engolido por um `.catch(() => {})` e a trilha
  // inteira exibia 5 competências FANTASMA (as originais hardcoded) sem nenhum aviso — numa
  // instalação que já editou as competências, isso é informação errada apresentada como certa.
  const [stale, setStale] = useState(false);

  // `alive` vive num ref, não numa variável local do `load`.
  //
  // ⚠ ARMADILHA (já nos mordeu): a versão anterior declarava `let cancelled` DENTRO do
  // `load` e devolvia `() => { cancelled = true }`. Como o efeito era `useEffect(() =>
  // load(), [load])`, o React tratava esse retorno como a função de limpeza — e a limpeza
  // do StrictMode cancelava a própria busca que acabara de começar.
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(() => {
    setLoading(true);
    return api.getSkills()
      .then((list) => {
        if (!alive.current) return;
        if (!Array.isArray(list) || list.length === 0) { setStale(true); return; }
        setSkills(list);
        setStale(false);
      })
      .catch((err) => {
        if (!alive.current) return;
        setStale(true);
        console.error('[skills] Falha ao carregar as competências do servidor. A trilha está exibindo a lista de fallback, que pode não corresponder às competências reais.', err);
      })
      .finally(() => { if (alive.current) setLoading(false); });
  }, []);

  // `load` tem deps `[]` — é uma referência ESTÁVEL, então este efeito roda uma vez só.
  // Isso é o que impede o laço: quem chama `reload()` (o AdminSkills) não pode acabar
  // recriando o próprio efeito que dispara `reload()` de novo.
  useEffect(() => { load(); }, [load]);

  return {
    skills,
    loading,
    stale,
    // `reload` é o que fecha o bug relatado em produção: as competências eram buscadas UMA
    // vez, no mount do app, e ficavam congeladas em memória pela sessão inteira. O admin
    // editava a trilha e o <select> de AdminExercises seguia mostrando a lista antiga até
    // um F5 — os dados no servidor estavam certos o tempo todo. Quem edita chama isto.
    reload: load,
    names: skillNameMap(skills),
    colors: skillColorMap(skills),
  };
}

// ---------------------------------------------------------------------
// Contexto: uma carga só para o app inteiro.
//
// Sem isto, cada tela que mostra o nome de uma competência (Logs, ChatSession,
// AdminExercises, SkillMap) faria a própria chamada — e componentes auxiliares como o
// <SkillBadge> nem conseguiriam, porque são funções fora do componente de página.
// ---------------------------------------------------------------------
const SkillsContext = createContext(null);

export function SkillsProvider({ children }) {
  const value = useSkills();
  return <SkillsContext.Provider value={value}>{children}</SkillsContext.Provider>;
}

/** Como `useSkills`, mas reaproveitando a carga do provider. */
export function useSkillsContext() {
  return useContext(SkillsContext) || { skills: FALLBACK_SKILLS, loading: false, stale: false, reload: () => {}, names: skillNameMap(FALLBACK_SKILLS), colors: skillColorMap(FALLBACK_SKILLS) };
}
