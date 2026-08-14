# Demandas — controle de avanço

Backlog levantado em **2026-07-09**. Decisões de produto fechadas com o usuário em
**2026-07-09** (ver "Decisões fechadas"). **Nenhuma linha de código foi escrita ainda.**

Estimativas em **Fibonacci** (1, 2, 3, 5, 8, 13, 21): pontos de *complexidade*, não de
horas. Um dia focado ≈ 5–8 pontos, mas a incerteza cresce muito acima de 8.

| # | Demanda | Pontos | Status |
|---|---|---|---|
| [1](#1-cadastro-do-visitante-nome-e-mail-e-telefone) | Cadastro do visitante (nome, e-mail, telefone únicos) | **8** | ✅ **FEITA** (backend + client, verificada ao vivo) |
| [2](#2-visitante-com-as-mesmas-permissões-de-aluno) | Visitante com as mesmas permissões de aluno | **8** | ✅ **FEITA** (+ D3/D9, verificada ao vivo) |
| [3](#3-cadeado-nas-abas-bloqueadas--pop-up-editável) | Cadeado nas abas bloqueadas + pop-up editável | **5** | ✅ **FEITA** (depois da #4, que a destrava) |
| [4](#4-painel-do-admin-liberarbloquear-funcionalidades-por-papel) | Admin: liberar/bloquear funcionalidades por papel | **8** | ✅ **FEITA** (`server/features.js` + /admin/acessos) |
| [5a](#5a-admin-editar-as-competências-existentes) | Admin: editar as competências existentes | **5** | ✅ **FEITA** (`skills.json` é a fonte única) |
| [5b](#5b-admin-adicionarremover-competências) | Admin: adicionar/remover competências | **8** | ✅ **FEITA** (o pentágono virou polígono de N lados) |
| [6](#6-admin-ver-os-dados-de-alunos-e-visitantes) | Admin: ver dados de alunos e visitantes | **2** | ✅ **FEITA** (+ 2 bugs achados no caminho) |
| [7](#7-admin-liberarbloquear-pacientes-por-papel) | Admin: liberar/bloquear pacientes por papel | **5** | ✅ **FEITA** (a armadilha da spec, fechada) |
| [8](#8-admin-validade-do-acesso-do-visitante) | Admin: validade do acesso do visitante | **8** | ✅ **FEITA** (+ o furo do recadastro, fechado) |

**Total: 57 pontos.** Grosseiramente 2 a 3 semanas de trabalho focado.

> A #2 subiu de 5 → 8 pontos por causa da decisão do **ranking separado**: não é mais só
> remover exclusões, é bifurcar o ranking e decidir o que fazer com duelo visitante×aluno.
> A #5 foi quebrada em **5a** (barata, entrega valor) e **5b** (a que dói).

---

## ✅ Decisões fechadas (não reabrir sem motivo)

| # | Decisão |
|---|---|
| D1 | **O visitante NÃO tem senha.** Nome + e-mail + telefone bastam para entrar. É captura de lead, não autenticação. Consequência aceita: quem souber o e-mail de um visitante entra na conta dele. |
| D2 | **Telefone: o formato mais simples possível (BR).** A prioridade é o lead conseguir entrar, não a validação perfeita. |
| D3 | **Visitante tem ranking PRÓPRIO**, que não se mistura com o dos alunos. |
| D4 | **Deletar competência deixa os exercícios órfãos** (não bloqueia, não realoca). |
| D5 | **A tela de edição de competências precisa explicar o sistema.** O admin tem que entender que não está mudando algo visual — está mexendo no prompt do paciente e na avaliação. |
| D6 | **A mensagem do cadeado é UMA SÓ** para todas as funções bloqueadas. |
| D7 | **Pacientes existentes nascem BLOQUEADOS** na migração. |
| D8 | **Mudar a duração padrão afeta só os novos visitantes.** Ao desbloquear um visitante antigo, ele recebe a duração padrão vigente naquele momento. |
| D9 | **Visitante duela APENAS com visitante.** Nunca contra aluno. Mantém os dois rankings limpos. |

---

## ⚠ A decisão que atravessa tudo: o visitante deixa de ser efêmero

Hoje o visitante é **anônimo e descartável por design**:

```js
// server/index.js:306
app.post('/api/login/visitor', visitorLimiter, (req, res) => {
  const id = 'visitor-' + crypto.randomBytes(6).toString('hex');
  const visitorUser = { id, username: id, name: 'Visitante', role: 'visitor', ... };
  res.json({ token: signToken(visitorUser), user: visitorUser });
});
```

Ele **não é gravado em `users.json`** — existe só dentro do token. É por isso que hoje não
tem perfil, não entra no ranking, não recebe notificação e não pontua no MMR.

As demandas **1, 2, 6 e 8 exigem o contrário**: um visitante com cadastro, dados
persistidos, permissões de aluno e prazo de validade. **O visitante vira um usuário de
verdade**, com um papel diferente.

Isso toca **17 pontos** no `server/index.js` que assumem "visitante = efêmero", incluindo
4 rotas que devolvem `403` só por ser visitante e o `pushNotification`, que pula qualquer
id começando com `visitor-`.

**Faça as demandas 1 e 2 juntas, primeiro.** São o alicerce. Tentar a 6 ou a 8 antes é
retrabalho garantido.

---

## 1. Cadastro do visitante (nome, e-mail e telefone)

> Como visitante, para logar preciso informar e-mail, telefone e nome — os três
> obrigatórios e únicos.

**Pontos: 8** · Backend pesado, frontend leve.

### O que muda
- `POST /api/login/visitor` deixa de gerar id aleatório e passa a **criar (ou recuperar)
  um usuário** em `users.json`, com `role: 'visitor'`.
- Novo campo **`phone`** — não existe no schema (conferido: 0 ocorrências no `server/index.js`).
- **Unicidade dos três campos.** Hoje só o `username` é validado; **não há nenhuma checagem
  de unicidade de e-mail** (conferido). Precisa de checagem em `users.json` + `409` dizendo
  qual campo colidiu.
- Login sem senha (**D1**): o visitante que já existe e informa os mesmos dados **volta para
  a mesma conta** (não cria duplicata).

### Formato do telefone (D2)
Deliberadamente permissivo — o objetivo é o lead entrar:
- Guardar **só os dígitos** (`replace(/\D/g, '')`).
- Aceitar **10 ou 11 dígitos** (fixo com DDD / celular com 9).
- Aceitar com ou sem máscara, com ou sem `+55` (descartar o 55 se vier com 12–13 dígitos).
- **Não** validar DDD contra lista, **não** exigir formato específico.
- Máscara só visual no client; a unicidade compara os dígitos normalizados.

### Riscos
- **Sem senha, o "login" é uma declaração de identidade.** Quem souber o e-mail de um
  visitante entra na conta dele — inclusive vendo os logs dele. Aceito em D1, mas registre:
  se um dia o visitante puder ver algo sensível, isso vira um problema.
- O `visitorLimiter` (30/h **por IP**) passa a limitar **cadastros**. Uma turma de 30 atrás
  do NAT da escola esgota a cota. **Revisar junto** (mesma classe do bug do `loginLimiter`).

### Testes a escrever
Unicidade dos 3 campos (409 por campo), telefone com/sem máscara/DDD/+55 normalizando para
a mesma chave, reentrada do mesmo visitante volta à mesma conta, colisão com `username` de
aluno, campos faltando (400).

---

## 2. Visitante com as mesmas permissões de aluno

> Como visitante, quero o mesmo acesso e permissões de um aluno.

**Pontos: 8** (era 5; subiu por causa de D3) · Depende da **#1**.

### O que muda
Reverter as exclusões espalhadas pelo servidor. Levantamento completo:

| lugar | hoje | vira |
|---|---|---|
| `POST /api/me/title` | 403 | permitido |
| `GET /api/ranking` | 403 | permitido, **mas só vê o ranking de visitantes** (D3) |
| `POST /api/duel` (×2) | 403 | permitido |
| `GET /api/duel/opponents` | 403 | permitido — **só lista visitantes** (D3) |
| `GET /api/notifications` | `{items:[], unread:0}` | lista real |
| `pushNotification` | pula `visitor-*` | notifica |
| `POST /api/logs` (MMR) | não pontua | **pontua** (D3) |
| `GET /api/me/mmr` | `{visitor:true}` | MMR real |
| `applyDuelMmr` | `{ranked:false, reason:'visitor'}` | **ranqueia** (D3) |

### O ranking separado (D3) — o que isso implica de verdade
O `GET /api/ranking` já lê `u.role` de cada linha, então **filtrar por papel é barato**: o
aluno vê só alunos, o visitante vê só visitantes. O `mmr.json` é chaveado por `userId` e
serve os dois sem mudança.

O problema está no **duelo**:
- `GET /api/duel/opponents` hoje lista só `role === 'therapist'`. Precisa listar **os pares
  do mesmo papel**: aluno vê alunos, visitante vê visitantes.
- `applyDuelMmr` hoje marca como **unranked** qualquer duelo com visitante
  (`server/index.js:1688`). Com D3, precisa ranquear.
- ⚠ **Duelo visitante × aluno**: se o link de convite atravessar os papéis, o duelo
  alimenta *qual* ranking? A saída simples é **proibir**: só duela quem é do mesmo papel
  (rejeitar no `POST /api/duel` e no aceite por token). **Confirmar antes de codar** —
  está em "Perguntas em aberto".

### Riscos
- **Custo de IA.** Hoje o visitante não é avaliado por padrão, justamente para não gastar.
  Virando aluno pleno, cada sessão dispara o avaliador. O toggle `visitorEvaluationEnabled`
  deve ser **absorvido pela #4** (permissões por papel).
- **9 asserções da suíte vão quebrar de propósito** (`security.test.js`, `ranking.test.js`,
  `duel.test.js`). É o comportamento esperado: cada uma precisa ser **reescrita
  conscientemente**, não deletada no atacado.

---

## 3. Cadeado nas abas bloqueadas + pop-up editável

> Vejo todas as funções na barra lateral, mas as bloqueadas ganham um cadeado. Ao clicar,
> abre um pop-up com uma mensagem que o admin edita.

**Pontos: 5** · Puro frontend + um campo de texto no `settings.json`.

### O que muda
- `App.jsx` hoje **esconde** as abas (`{!isVisitor && <Link .../>}`). Passa a **mostrar
  sempre**, em estado bloqueado.
- Abas afetadas: **Competitivo, Duelo, Progressão, Objetivos, Logs Sociais, Ranking**.
- O botão mantém a animação e o visual — **só ganha o ícone de cadeado**.
- Clicar abre um `<LockedModal>` com **uma mensagem única** (D6), vinda do servidor.
- Novo campo em `settings.json` (ex.: `lockedFeatureMessage`), exposto em `GET /api/settings`
  e editável em `PUT /api/admin/settings`.

### Depende de
A **#4** — é ela que diz *quais* abas estão bloqueadas para *qual* papel. Sem a #4, o
cadeado seria hardcoded (retrabalho).

### Atenção
- O botão bloqueado **não navega**. E a **rota também precisa barrar** o acesso por URL
  direta — senão o cadeado é decorativo.
- **O bloqueio real é no servidor.** O cadeado é UX; a rota devolve 403 mesmo se o usuário
  digitar a URL na mão.

---

## 4. Painel do admin: liberar/bloquear funcionalidades por papel

> Liberar ou bloquear funcionalidades, diferenciando visitante de aluno (posso liberar para
> um e não para o outro).

**Pontos: 8** · A peça central. Backend + UI + enforcement em todas as rotas.

### O que muda
- Nova estrutura em `settings.json`:
  ```json
  "featureAccess": {
    "competitivo": { "aluno": true,  "visitante": false },
    "duelo":       { "aluno": true,  "visitante": false },
    "progressao":  { "aluno": true,  "visitante": false },
    "objetivos":   { "aluno": true,  "visitante": true  },
    "logsSociais": { "aluno": true,  "visitante": false },
    "ranking":     { "aluno": true,  "visitante": false },
    "avaliacao":   { "aluno": true,  "visitante": false }
  }
  ```
- Middleware `requireFeature('duelo')` nas rotas correspondentes — **este é o ponto de
  verdade**, não a sidebar.
- Tela no admin com uma matriz de checkboxes: funcionalidade × papel.
- `GET /api/settings` devolve o `featureAccess` para o client montar a sidebar.

### Substitui
O toggle `visitorEvaluationEnabled` de hoje vira um caso particular deste modelo
(`avaliacao.visitante`).

### Atenção
- **Enforcement em duas camadas**: sidebar (UX) e rota (segurança). Só a sidebar não basta.
- Definir a lista canônica de funcionalidades **num só lugar (server)**, para o client não
  inventar chaves.

---

## 5a. Admin: editar as competências existentes

> Editar os nomes, cores e textos das competências da trilha.

**Pontos: 5** · Entrega valor rápido, sem mexer na geometria.

### O que muda
- Novo `skills.json` com as 5 competências: `{ id, name, color, criteria, order }`.
- CRUD de **edição** (sem adicionar/remover) em `/api/admin/skills`.
- `client/src/utils/skills.js` (`SKILL_NAMES`, `SKILL_COLORS`) passa a **ler do servidor**.
- `server/prompts.js` → `SKILL_CRITERIA` passa a ler do `skills.json`.

### D5 — a tela precisa EXPLICAR o sistema
Esta é a parte que não pode ser esquecida. O admin **não está mudando um rótulo** — o campo
`criteria` de cada competência **entra no system prompt do paciente**:

```js
// server/prompts.js:96
buildExercisePrompt(skillId, specificInstruction) {
  return GENERAL_INSTRUCTION + '\n' + (SKILL_CRITERIA[skillId] || '') + ...
}
```

A tela deve deixar explícito, em texto na própria interface:
- **O que é o `criteria`**: são os critérios que a IA usa para avaliar o aluno naquela
  competência. Editar isso **muda como o aluno é avaliado** em todos os exercícios daquela
  competência.
- **O que é afetado**: o prompt do paciente, a nota do exercício, o SkillMap e os logs
  (que gravam o `skillId`).
- **Quantos exercícios** usam cada competência (contar e mostrar na tela).
- Um aviso visível: *"Alterar os critérios afeta a avaliação de todos os exercícios desta
  competência, inclusive os já criados."*

---

## 5b. Admin: adicionar/remover competências

> Poder adicionar e remover competências.

**Pontos: 8** · Depende da **#5a**. É aqui que dói.

### Por que dói: a geometria é um pentágono literal
```js
// client/src/pages/SkillMap.jsx:16
const PENTAGON_ANGLES_DEG = [270, 342, 54, 126, 198];   // 5 ângulos FIXOS
// linha 244
for (let i = 1; i <= 5; i++) bySkill[i] = [];           // 5 hardcoded
if (sid >= 1 && sid <= 5) bySkill[sid].push(ex);        // 5 hardcoded
```
Mudar o número de competências **quebra o desenho do mapa**. Ele precisa calcular os
ângulos a partir de `N` (`360 / N`), o que muda o layout, as arestas, o zoom e os rótulos.

### D4 — exercício órfão: o que acontece HOJE (conferido no código)
Deletar uma competência deixa os exercícios com um `skillId` que não existe mais. Hoje isso
**não é neutro** — o exercício órfão:

1. **Some do SkillMap.** O filtro é `if (sid >= 1 && sid <= 5)`. Um `skillId` fora da faixa
   é silenciosamente ignorado: o exercício **desaparece da trilha**.
2. **Perde os critérios no prompt do paciente.** `SKILL_CRITERIA[orfao]` é `undefined`, e o
   código faz `|| ''` — o prompt monta **sem os critérios da competência**.
3. **Continua avaliável.** Os 3 exercícios reais usam avaliador customizado, que não olha o
   `skillId`. A nota sai normal.
4. **Continua nos logs** (o `skillId` órfão fica gravado).

**Ou seja: "deixar órfão" hoje = "sumir da trilha e degradar o prompt", em silêncio.**

Como D4 escolheu deixar órfão, a implementação precisa tornar isso **visível, não silencioso**:
- Ao deletar, **avisar quantos exercícios ficarão órfãos** e o que vai acontecer com eles.
- Mostrar os órfãos em algum lugar do admin (uma seção "Exercícios sem competência"), para
  o admin poder reatribuí-los depois.
- Decidir se o exercício órfão continua acessível por URL direta ou é desativado.

---

## 6. Admin: ver os dados de alunos e visitantes

> Ver e-mail, telefone e nome dos meus alunos e visitantes.

**Pontos: 2** · Trivial — **desde que a #1 esteja pronta**.

### O que muda
- `GET /api/admin/users` já existe e já devolve `email`. Falta o `phone` (que a #1 cria) e
  os visitantes aparecerem na lista (que a #1 faz, ao persistir o visitante).
- `AdminUsers.jsx` ganha as colunas e um filtro por papel.

### Nota
Sem a #1 esta demanda é **impossível**: o visitante de hoje não tem dados nem existe em
`users.json`. Os 2 pontos assumem a #1 feita.

---

## 7. Admin: liberar/bloquear pacientes por papel

> Na edição de paciente, uma coluna de acesso do aluno e outra do visitante.

**Pontos: 5** · Backend simples, com uma armadilha de segurança.

### O que muda
- `FREEPLAY_FIELDS` ganha dois campos: `allowStudent`, `allowVisitor`.
- `GET /api/freeplay` **filtra por papel** — o aluno não vê o card de um paciente bloqueado.
- `AdminFreeplay` ganha os dois toggles na tabela.

### ⚠ A armadilha
Filtrar só o `GET` **não basta**. Sem barrar também as rotas abaixo, dá para conversar com
um paciente bloqueado direto pela API (o card some, o acesso não):
- `POST /api/chat` com o `itemId` bloqueado;
- `POST /api/logs`, `POST /api/duel`, `/api/progression/*`.

**É aqui que mora o risco de segurança desta demanda.** O bloqueio precisa ser no
`resolveChatPrompt` / nas rotas, não só na listagem.

### Migração (D7)
Os **6 pacientes existentes nascem BLOQUEADOS** para os dois papéis. Consequência direta:
**depois do deploy, ninguém consegue praticar até o admin liberar.** Isso precisa estar no
checklist de deploy, ou o sistema "quebra" sem quebrar.

---

## 8. Admin: validade do acesso do visitante

> Limitar o tempo de acesso do visitante (1 hora, 3 dias, 1 semana). Expirado, bloqueia. O
> admin desbloqueia e a contagem recomeça.

**Pontos: 8** · Depende da **#1**.

### O que muda
- `visitorAccessDuration` em `settings.json` (o padrão que o admin define).
- No usuário visitante: `accessExpiresAt`, `blocked`.
- Middleware que **checa a expiração a cada request** do visitante e devolve 403 com um
  código próprio (ex.: `VISITOR_EXPIRED`), para o client mostrar a tela certa em vez de um
  erro genérico.
- Em `AdminUsers`: seletor de duração + botão "Desbloquear".

### D8 — a semântica exata
- Mudar a duração padrão **afeta só os visitantes novos**. Quem já tem `accessExpiresAt` não
  é recalculado.
- **Desbloquear** um visitante antigo: `accessExpiresAt = agora + duração padrão VIGENTE`.
  Ou seja, ele "renasce" com a regra atual, não com a que valia quando se cadastrou.

### ⚠ Atenção: o JWT tem validade própria
`TOKEN_TTL = '7d'` (`server/index.js:89`). Um visitante com **token válido** e **acesso
expirado** precisa ser barrado mesmo assim. Logo, a checagem **tem que ler o `users.json`**
a cada request — não pode confiar só no token. Isso adiciona uma leitura de arquivo por
request do visitante (aceitável: o arquivo é pequeno).

---

## Ordem sugerida

```
  #1 (cadastro)  ──┬──> #2 (permissões) ──> #4 (feature flags) ──> #3 (cadeado)
                   ├──> #6 (ver dados)
                   └──> #8 (validade)

  #5a (editar competências) ──> #5b (adicionar/remover)   [independente]
  #7 (pacientes)                                          [independente]
```

**Fase 1 — a fundação (18 pts):** #1 + #2 + #6.
A #6 é barata e sai de graça junto da #1. Sem essa fase, metade do backlog não sai do papel.

**Fase 2 — controle de acesso (18 pts):** #4 → #3 → #7.
A #4 é o coração; a #3 é a cara dela; a #7 usa o mesmo modelo mental.

**Fase 3 — o resto (21 pts):** #8 · #5a · #5b.
A #5 é a mais cara e a mais independente — pode ir em paralelo, por outra pessoa.

---

## ❓ Perguntas em aberto

**Nenhuma.** A última foi fechada em 2026-07-09:

| # | Decisão |
|---|---|
| D9 | **Visitante duela APENAS com visitante.** `GET /api/duel/opponents` lista só os pares do mesmo papel, e o convite por link é rejeitado se os papéis divergirem. Mantém os dois rankings limpos. *(afeta a #2)* |

---

## Impacto na suíte de testes

Hoje: **575 testes, 24 arquivos, todos passando.**

As demandas **#2 e #4 vão quebrar 9 asserções de propósito** (`security.test.js`,
`ranking.test.js`, `duel.test.js`) — são exatamente as que travam as exclusões do visitante
(403 em título/ranking/duelo, notificações vazias, MMR ausente).

**Isso é bom**: são as decisões que precisam ser revistas uma a uma. **Não delete esses
testes no atacado** — reescreva cada um com o novo comportamento. Se um for simplesmente
removido, some junto a garantia que ele dava.

Some **~40 testes novos** ao escopo: unicidade do cadastro, normalização do telefone,
matriz de permissões, enforcement de rota (o bloqueio real, não a sidebar), expiração do
visitante, filtro de pacientes por papel, ranking bifurcado.

---

## 📋 Diário de implementação

### 2026-07-09 — Demanda #1 (backend) ✅ + `loginLimiter` validado

**`loginLimiter` (pendência da sessão anterior) — VALIDADO.** Passou nos 4 testes:
30 alunos da mesma turma/IP entram (antes 10 levavam 429); 15 senhas erradas na mesma
conta → barrado após 10; a conta barrada não derruba as outras; login certo não consome
cota. **Destrava o deploy com uma turma real.**

**Demanda #1 — backend pronto.** `586 testes passando` (era 575).

- `normalizePhone` / `normalizeEmail` — BR permissivo (D2). Testados nos 17 casos de borda:
  máscara, DDD, `+55`, `null`, `{}`. Guarda só os dígitos.
- `POST /api/login/visitor` agora **cadastra um usuário real** em `users.json`
  (`role: 'visitor'`), com nome/e-mail/telefone únicos. Sem senha (D1).
  Repetir os mesmos dados **volta para a MESMA conta** (não duplica).
  Colisão → `409` com o campo que colidiu. Um visitante **não pode roubar o e-mail de um aluno**.
- `signToken` / `requireAuth` — o visitante deixou de ser reconstruído do token e passou a
  ser **lido do `users.json` a cada request**. É isso que vai permitir barrar um visitante
  expirado (demanda #8) mesmo com o JWT válido: quem manda é o disco, não o token.
- `pushNotification` — o guard `startsWith('visitor-')` virou letra morta (o id agora é
  numérico). Removido, não "consertado": o bloqueio não é mais desejado (demanda #2).

**Testes reescritos, não deletados.** 5 falharam de propósito (travavam o visitante
efêmero) e foram reescritos para o novo contrato. Um deles — *"NÃO grava o visitante em
users.json"* — estava **passando por acidente** (o `send({})` virou 400, então nada era
gravado e o `before === after` dava verde). Falso positivo, agora corrigido.

**Verificado ao vivo:** cadastro persiste com e-mail/telefone normalizados, sem senha;
reentrada devolve o mesmo id; e as fronteiras de segurança seguem de pé (admin 403,
entrevistador 403, sem vazamento de gabarito, logs isolados).

### 2026-07-14 — Demanda #1 (client) ✅ — **DEMANDA #1 FECHADA**

`602 testes passando` (era 586; +16 do `visitor-form`). `vite build` ok (90 módulos).

- **`client/src/visitorForm.js`** (novo, **puro** — sem React/CSS/DOM, por isso testável no
  ambiente node da suíte): `phoneDigits`, `maskPhone`, `isValidPhone`, `isValidEmail`,
  `isValidName`, `validateVisitor`. Máscara progressiva BR: celular quebra em 5-4
  (`(11) 91234-5678`), fixo em 4-4 (`(11) 3456-7890`). É **UX, não segurança** — as regras
  espelham as do servidor só para o lead ver o erro antes do round-trip.
- **`Login.jsx`** — o botão virou formulário de 3 campos. Erro por campo
  (`.input-error` + `.field-error`), limpo assim que o usuário mexe no campo.
- **`api.js`** — buraco real fechado: o `request()` **descartava** o corpo do erro, então
  o `field` do 409 e o `fields` do 400 nunca chegavam à tela. Agora o `Error` carrega
  `.status`, `.field` e `.fields`.
- **`demo.js`** — `loginVisitor` aceita o payload e recusa com mensagem clara (o `<Login>`
  esconde o form no modo demonstração; só seria alcançado por engano).

**Verificado ao vivo** (servidor real, volume limpo): cadastro normaliza e-mail/telefone e
grava **sem senha**; repetir os mesmos dados devolve **o mesmo id**; 400 lista os 3 campos;
409 aponta o campo que colidiu. Contra uma **aluna de verdade** (com e-mail preenchido),
o visitante leva 409 no e-mail e 409 no nome — **não dá para sequestrar a conta de um aluno**.

> ⚠ Achado de fixture (não é bug): o admin semeado nasce com `email: ''` (`DEFAULT_PROFILE`).
> Testar colisão contra `admin@genus.local` dá **200**, porque *ninguém tem esse e-mail* —
> não porque o check falhe. Ao testar colisão, use um usuário que realmente tenha e-mail.

### 2026-07-14 — Demanda #2 ✅ (backend + client) — **FECHADA**

`610 testes passando` (era 602). `vite build` ok.

**A ideia central: uma chave única de segmentação.** Em vez de espalhar comparações com
`'therapist'`/`'visitor'` pelas rotas, criei `peerRole(user)` + `samePeerGroup(a, b)` — a
**arena** do jogador. Ranking, lista de oponentes e aceite de duelo passam todos por ali,
para não existirem duas noções divergentes de "meu par".

**Exclusões derrubadas** (o visitante virou aluno pleno): `/api/me/title`, `/api/ranking`,
`/api/me/mmr`, `/api/notifications` (×3), `POST /api/duel` (×2), `/api/duel/opponents`,
`/api/duels/social`, o MMR do `POST /api/logs` e o `reason:'visitor'` do `applyDuelMmr`.
Sobrou **um** guard de propósito: o `visitorEvaluationEnabled` (custo de IA) — que a
**demanda #4** vai absorver.

**D9 — onde o furo realmente estava.** Bloquear `POST /api/duel` é o óbvio, mas o convite
por **link** não escolhe o oponente: quem abre o link **se auto-adiciona**. Era por ali que
um visitante entraria num duelo de aluno e alimentaria os dois rankings de uma vez. O guard
que importa está no `acceptDuel` — ponto único por onde passam as duas rotas de aceite.

**Regressão que a spec não previu** (achada pelos testes): o ranking listava QUALQUER
usuário com partidas — inclusive um **professor** que tivesse jogado. Com o filtro por
arena, supervisor/admin não pertencem a nenhuma e saem da tabela. Está travado em teste.

**Client** — o gating do visitante nasceu de premissas que a #2 derrubou ("id efêmero",
"não pontua", "403 no backend"), e todas foram removidas:
- `App.jsx`: menu completo (Competitivo, Duelo, Progressão, Objetivos, Ranking, sino de
  notificações, perfil, streak e título).
- `Profile.jsx`: **o bloqueio inteiro caiu** — ele tem perfil, conquistas e título. Só o
  card "Alterar senha" fica escondido (visitante não tem senha, demanda #1).
- `ChatSession`/`EchoSession`: autosave, restauração de sessão e progresso da trilha.
- `Duelo.jsx`: o card prometia "quem abrir entra como visitante" — texto **enganoso** agora
  (a D9 rejeita esse aceite com 403). Reescrito: o link exige alguém da mesma arena.
- `DuelSession.jsx`: o ramo `reason === 'visitor'` virou código morto. Removido.

**Validado por MUTAÇÃO** — os 4 guards foram reintroduzidos como bug e a suíte pegou todos:
sem o guard do `acceptDuel` (2 falhas), sem o `samePeerGroup` no `POST /api/duel` (3), sem
o filtro de arena no ranking (2), e com `opponents` listando todo mundo (2).

**Verificado ao vivo** (servidor real): visitante jogou 5 partidas competitivas, saiu da
calibração e chegou a **MMR 70** — impossível antes. Ranking do aluno traz só alunos; o do
visitante, só visitantes. Aluno não vê visitante entre os oponentes. Cruzar a arena por id
forjado → 403; pelo link → 403. Visitante × visitante pelo link → 200.

### 2026-07-14 — Demandas #4 e #3 ✅ — **FECHADAS** (nesta ordem, de propósito)

`641 testes passando` (era 610). `vite build` ok (94 módulos).

**Inverti a ordem do backlog.** A própria spec da #3 avisava: *"Depende da #4 — sem ela, o
cadeado seria hardcoded (retrabalho)"*. A #4 é quem define **quais** abas estão bloqueadas
para **qual** papel; a #3 é só a UX em cima disso. Fiz a #4 primeiro e a #3 saiu de graça.

**`server/features.js` (novo) — a fonte única.** Catálogo de 7 funcionalidades
(`competitivo`, `duelo`, `progressao`, `objetivos`, `logsSociais`, `ranking`, `avaliacao`),
cada uma com rótulo, descrição e defaults. O client **não inventa chaves**: ele recebe o
catálogo em `GET /api/settings`. Uma feature nova nasce no servidor e aparece na tela do
admin sozinha.

**Duas camadas, e só a segunda é segurança:**
1. a sidebar desenha o cadeado (UX);
2. `requireFeature(key)` devolve **403** com `{ locked, feature, error }` — quem digitar a
   URL na mão bate aqui. Sem isso o cadeado seria decorativo, como a spec alertava.
   O 403 leva a mensagem do admin para o client abrir o **mesmo** pop-up.

**Decisões de projeto que valem registro:**
- **Admin e professor ficam FORA da matriz.** Não é esquecimento: se fossem bloqueáveis, um
  admin poderia **se trancar para fora do próprio sistema** — sem tela para se desbloquear.
- **`avaliacao` não usa `requireFeature`.** Bloqueada, ela responde `{disabled:true}` com
  **200**, porque o cliente conta com isso para encerrar a sessão com o agradecimento. Um 403
  quebraria o fim da sessão: é bloqueio de *feedback*, não de acesso à tela.
- **O guard do duelo fica na ENTRADA** (criar/listar/aceitar), não nas rotas do duelo em
  andamento. Senão, desligar a feature deixaria **preso para sempre** um duelo já aceito.
  Há teste travando os dois lados.
- **Falha ABERTA** no client (`can()` devolve true enquanto o settings não chega) e em
  `canUseFeature` (chave desconhecida libera). Falhar fechado desenharia a sidebar inteira
  cadeada num hiccup de rede — e o servidor barra de qualquer jeito.

**MIGRAÇÃO (a parte mais arriscada).** Um `settings.json` que já existe não tem
`featureAccess`. Sem migrar, o `visitorEvaluationEnabled` que o admin tinha **ligado** seria
descartado em silêncio (o default de `avaliacao.visitante` é `false`) — e ele descobriria
pelo aluno reclamando que a avaliação sumiu. O boot converte o campo antigo e o remove.
Testado num processo novo, com volume real.

**O toggle `visitorEvaluationEnabled` morreu** — virou a célula `avaliacao × visitante`.
O card antigo em `AdminUsers` foi **removido** (o texto ainda dizia que visitante "não
pontua", falso desde a #2) e substituído por um atalho para a nova tela: manter dois lugares
editando a mesma coisa era convite a divergirem.

**Client:** `features.jsx` (contexto + `useFeatures`), `LockedModal`, `LockedPage` (URL
direta), `navFeature()` na sidebar (o item **continua visível**, ganha cadeado e abre o
pop-up em vez de navegar) e a tela **`/admin/acessos`** com a matriz de checkboxes + o editor
da mensagem. A tela abre com um aviso explícito de que **aquilo não é ajuste visual** — foi
pedido do usuário — e lista as consequências que passam despercebidas.

**Validado por MUTAÇÃO** (4 mutantes, todos pegos): `requireFeature` virando no-op (3
falhas), migração removida (1), admin virando bloqueável (3), `normalizeFeatureAccess` não
completando feature ausente (3).

**Verificado ao vivo:** admin bloqueia duelo+ranking só para o visitante e escreve a
mensagem → o visitante recebe `myFeatures` coerente, e a URL direta devolve **403 com a
mensagem dele**; o aluno segue com 200 nas duas; e com **tudo** bloqueado para os dois
papéis, o admin continua entrando (não se trancou para fora).

### 2026-07-14 — Demanda #6 ✅ — **FECHADA** (e dois bugs reais no caminho)

`650 testes passando` (era 641). O backend já estava pronto pela #1 (`publicUser` faz spread,
então o `phone` já saía). A tela era o que faltava — mas **ligar a tela revelou dois bugs**:

1. **🔴 Editar um visitante era impossível.** `visitor` não está em `VALID_ROLES` (de
   propósito: ninguém é *promovido* a visitante), e o `PUT /api/admin/users/:id` validava o
   papel do merge sem abrir exceção para quem **já era** visitante → **400 "Função inválida"**.
   O botão "Editar" da linha dele estava simplesmente quebrado.
2. **🔴 Promover um lead a aluno criava uma CONTA MORTA.** O visitante entra **sem senha**
   (D1), então não tem `passwordHash`. Ao virar `therapist`, ele perdia as **duas** portas de
   entrada — o login por senha exige o hash, e o login de visitante só recupera quem tem
   `role: 'visitor'`. Respondia **200**, e a pessoa nunca mais entrava. Um admin
   bem-intencionado ("vou converter meu lead em aluno") destruía o acesso dela em silêncio.
   Agora a conversão **exige senha** (400 + `field: 'password'`), e o client explica isso
   no modal antes de salvar.

**Client:** filtro "Visitantes (n)", coluna **Contato** (e-mail + telefone mascarado pelo
mesmo `maskPhone` do formulário — fonte única), botão "Senha" escondido para visitante (não
há o que redefinir), e a opção "Visitante" no select só aparece para quem já é um.

**Privacidade — verificado, não presumido:** o telefone é dado pessoal. `publicUser` só é
usado em rotas que já exigem ser o dono, o professor do aluno, ou admin. Ranking e lista de
oponentes montam objetos próprios e **não** passam por ele. Há teste travando isso — um
`...u` distraído lá vazaria o telefone para os colegas de turma.

**Mutação:** os dois guards novos foram reintroduzidos como bug e a suíte pegou os dois.

### 2026-07-14 — Demanda #7 ✅ — **FECHADA**

`668 testes passando` (era 650). `vite build` ok.

**A armadilha que a spec anunciava — e ela era real.** Filtrar o `GET /api/freeplay` faz o
card sumir, mas **não bloqueia nada**: o `itemId` é conhecido (basta ter atendido antes, ou
ler o bundle). Reproduzi ao vivo. O gate está em `canUsePatient`, e todo caminho que resolve
um paciente passa por ele:
- `resolveChatPrompt` (o coração — sem isto, `POST /api/chat` com o id na mão conversava);
- `POST /api/duel` (não se duela num paciente que você não pode atender);
- `POST /api/progression/evaluate` **e** a lista de pacientes da progressão;
- `POST /api/logs` — ver abaixo.

**A decisão sutil no `POST /api/logs`:** o log **é salvo**, mas **não pontua**. Se o admin
bloquear no meio de uma sessão em andamento, o aluno não pode perder o que já escreveu — o
que ele não leva é o MMR de um paciente que não deveria estar atendendo. (Sessões *novas* já
são barradas no `/api/chat`.)

**⚠ MIGRAÇÃO D7 — CONSEQUÊNCIA OPERACIONAL GRANDE.** Os pacientes que já existem nascem
**BLOQUEADOS** para aluno e visitante. Depois do deploy **ninguém consegue praticar** até um
admin liberar em *Admin → Personagens*. **Nada dá erro** — os cards simplesmente somem. O
boot grita isso no log, a tela mostra um aviso enquanto houver paciente bloqueado, e está no
checklist de deploy abaixo.

Um paciente **novo** (criado depois) nasce **liberado**: `canUsePatient` trata campo ausente
como liberado, e seria absurdo o admin criar um paciente e ele "não aparecer". A D7 fala dos
**existentes**, não do comportamento futuro.

**Client:** duas colunas de checkbox (**Aluno** / **Visitante**) direto na tabela do
`AdminFreeplay`, com salvamento imediato — abrir o modal para dois cliques seria fricção à
toa. Aviso no topo enquanto houver paciente sem ninguém liberado.

**Validado por MUTAÇÃO** (5 mutantes, todos pegos): gate do chat removido (2 falhas), gate
do duelo (1), paciente bloqueado voltando a pontuar MMR (1), campo ausente virando
"bloqueado" (2), e a migração D7 revertida (2).

**Verificado ao vivo:** boot bloqueou os 6 pacientes reais; aluno vê 0 e admin vê 6; `chat`
e `duel` com o id na mão dão **403**; ao liberar só para aluno, o mesmo paciente responde
**200 ao aluno e 403 ao visitante**.

---

## 🚀 CHECKLIST DE DEPLOY — leia antes de subir

1. **Libere os pacientes.** A migração D7 bloqueia todos os que já existem. Entre em
   *Admin → Personagens* e marque **Aluno** / **Visitante** em cada um. **Sem isso, ninguém
   pratica e nada dá erro.**
2. **Confira a matriz de acesso** em *Admin → Acessos* (demanda #4). A avaliação por IA nasce
   **desligada para o visitante** (cada avaliação é uma chamada paga).
3. Variáveis: `JWT_SECRET`, `ADMIN_INITIAL_PASSWORD`, `OPENAI_API_KEY`, `DATA_DIR=/data`
   (+ volume montado). **Não** defina `PORT`.
4. **Nunca escale para 2+ réplicas** — `withFileLock` é um mutex em memória, por processo.

### 2026-07-14 — Demanda #8 ✅ — **FECHADA**

Sem testes novos (a pedido: foco na implementação). `668 testes` seguem passando; verificado
ao vivo, ponta a ponta.

- `VISITOR_DURATIONS` (1h / 1d / 3d / 1 semana / 1 mês / **sem prazo**) + o padrão em
  `settings.json`. O "sem prazo" é escape hatch: uma turma em visita, um evento — sem ele o
  admin desbloquearia na mão o tempo todo.
- O prazo é carimbado **no cadastro**, com a duração vigente. Mudar o padrão depois **não
  recalcula** quem já entrou (D8).
- **Renovar** dá a duração **vigente**, não a do cadastro (D8). Verificado: mudei o padrão de
  1h para 1 semana e o renovado ganhou 7 dias.
- Checagem em `requireAuth`, **contra o disco**: o JWT dura 7 dias, mas o acesso pode durar
  1 hora — confiar no token seria dar 7 dias a todo mundo. É **403 + `VISITOR_EXPIRED`**, não
  401: um 401 dispararia o logout do client e jogaria o lead na tela de login.
- Client: tela `<VisitorExpired>` dedicada, seletor de duração em *Acessos*, e os botões
  **Renovar / Bloquear** + o selo de prazo na tabela de Contas.

**⚠ O furo que a spec não previu — e estava aberto.** Um visitante **expirado** podia
simplesmente **refazer o cadastro com os mesmos dados**: ele caía no ramo "já se cadastrou
antes → volta para a mesma conta" e **recebia um token novo**. O prazo seria contornável por
qualquer um, sem esforço. Agora esse ramo checa a expiração e devolve 403. Verificado ao vivo.

### 2026-07-14 — Demandas #5a e #5b ✅ — **FECHADAS** (juntas)

Fiz as duas de uma vez: compartilham a mesma fundação (`skills.json` + CRUD), e separá-las
significaria escrever o CRUD duas vezes.

**`server/skills.js` — a fonte única.** As competências viviam em **três** lugares que podiam
divergir: `SKILL_CRITERIA` (prompts.js), `SKILL_NAMES`/`SKILL_COLORS` (client) e um pentágono
com 5 ângulos fixos (SkillMap). Agora tudo sai de `skills.json`.

**O que faz a #5a valer alguma coisa:** `buildExercisePrompt` deixou de ler um
`SKILL_CRITERIA` hardcoded e passou a receber o texto vindo do `skills.json`. Verifiquei ao
vivo que o critério editado pelo admin **chega mesmo ao prompt do paciente** — sem isso a
demanda seria cosmética.

**D5 — a tela explica o sistema.** O aviso no topo diz, com todas as letras, que os critérios
entram no prompt do paciente e mudam a avaliação de **todos** os exercícios daquela
competência, inclusive os já criados. A tabela mostra **quantos exercícios** usam cada uma.

**#5b — o pentágono virou um polígono de N lados.** `polygonAngles(n)` calcula os vértices a
partir de `360/n`. Com N = 5 o desenho é **idêntico** ao anterior (o pentágono fixo era
exatamente `270 + k·72`), então a trilha existente não muda. Testei com 3 competências: vira
um triângulo. A ordem da lista é a ordem dos vértices (há reordenação).

**D4 — órfão deixou de ser silencioso.** Apagar uma competência exige `?confirm=1` no
servidor, e a tela avisa **quantos exercícios** ficarão órfãos e o que acontece com eles
(somem da trilha; o prompt monta sem critérios). E há uma seção **"Exercícios sem
competência"** no admin — sem ela, um exercício órfão simplesmente desapareceria e ninguém
nunca mais o encontraria.

**Segurança:** o aluno **não** recebe os `criteria` em `GET /api/skills` (só id/nome/cor) —
é material de avaliação, e vazá-lo entrega o que a IA procura.

---

## 🎉 TODAS AS 8 DEMANDAS ESTÃO FEITAS

| # | Demanda | Pontos |
|---|---|---|
| 1 | Cadastro do visitante | 8 |
| 2 | Visitante com permissões de aluno (+ D3/D9) | 8 |
| 3 | Cadeado + pop-up | 5 |
| 4 | Matriz de acesso por papel | 8 |
| 5a | Editar competências | 5 |
| 5b | Adicionar/remover competências | 8 |
| 6 | Admin vê os dados dos leads | 2 |
| 7 | Bloquear pacientes por papel | 5 |
| 8 | Validade do acesso do visitante | 8 |

**57 pontos.** `668 testes` passando, `vite build` limpo.

### 2026-07-14 — Testes das #8, #5a e #5b ✅ + **2 bugs reais que eles acharam**

`719 testes passando` (era 668). `visitor-expiry` (20) · `skills` (31).

**🔴 BUG REAL #1 — o `nextSkillId` reciclava o id.** `max(ids) + 1` sobre a lista **viva**:
apagada a competência 5, o max caía para 4 e a próxima nascia com **id 5** — herdando os
exercícios órfãos e os logs da apagada, que voltariam à trilha ligados à competência
**errada**, em silêncio. O comentário do meu próprio módulo dizia que isso não podia
acontecer, e acontecia.
Corrigido com três fontes que nunca regridem: as competências vivas, os `skillId` gravados
em exercícios/logs, e uma **marca d'água** (`skillIdFloor`) persistida no DELETE — porque
apagar uma competência que ninguém referenciava apagaria também a memória de que ela existiu.

**🔴 BUG REAL #2 — o harness não semeava o `skills.json`.** O `resetData()` apaga o DATA_DIR
inteiro, e o bootstrap do servidor só roda no `require`. Resultado: **todo teste rodava com
ZERO competências**, e o `skillId` dos exercícios apontava para o vazio. A suíte estava
verde testando um sistema sem trilha nenhuma. (Aproveitei e tirei o `visitorEvaluationEnabled`
morto da fixture de settings.)

**Validado por MUTAÇÃO** (6 mutantes, todos pegos):
| mutante | pego por |
|---|---|
| `requireAuth` não checa a expiração (o JWT de 7d vira o prazo real) | visitor-expiry (4) |
| o expirado se recadastra e ganha token novo (**o furo**) | visitor-expiry (2) |
| renovar não usa a duração vigente (quebra a D8) | visitor-expiry (2) |
| `buildExercisePrompt` ignora os critérios (**a #5a vira cosmética**) | skills (2) |
| `nextSkillId` volta a reciclar o id | skills (3) |
| o aluno passa a receber os `criteria` (vaza o gabarito da avaliação) | skills (1) |

### ▶️ O que ainda falta
1. **Nada foi testado em navegador real.** Em especial o polígono de N lados (3, 6, 8
   competências): a geometria foi verificada, o **desenho** não.
2. A casca React segue sem testes (sem jsdom) — vale para todo o projeto, não só para estas
   demandas.

---

## 🔧 Estado do repositório

- **Nada commitado.** 36+ arquivos untracked, incluindo `server/mmr.js`, `server/seed/`, os
  prompts `.md` e o `railway.json`. **Rode `git add -A` antes do primeiro commit** — sem
  eles o servidor nem sobe (crash em `require('./mmr')`).
- **586 testes passando**, servidor sobe limpo.
- Contexto de capacidade, deploy e arquitetura: ver `CLAUDE.md`.
- Diferenças em relação ao All_OS: ver `DIFERENCAS.md`.
- ⚠ `all_os/` é **somente leitura** — é a referência, nunca editar.

---

## 🔬 AUDITORIA DA SUÍTE (2026-07-14) — 12 BUGS REAIS, todos corrigidos

Auditei os 30 arquivos de teste (7.376 linhas) procurando redundância. Encontrei redundância
— mas o achado importante foi outro: **a suíte de 719 testes passava INTEIRA com 12 bugs
reais no código**. Testes demais no lugar errado escondem o que não é testado.

### Os bugs (todos reproduzidos antes de corrigir, todos travados por teste + mutação)

| # | bug | efeito |
|---|---|---|
| 1 | `Number('')` é **0**, e 0 é finito | 🔴 critério que a IA deixou EM BRANCO virava zero e **derrubava a nota do aluno pela metade** (80 → 40). A correção já existia no CLIENTE (`isRealScore`); o servidor — que é quem grava a nota, o MMR e o ranking — ficou com o filtro ingênuo. |
| 2 | o parser de notas varria o texto INTEIRO | 🔴 "o aluno interrompeu **3: 20** vezes" virava o critério 3 com nota 20 → nota **117/100** no ranking |
| 3 | `score` do cliente entrava sem limite | 🔴 `{score: 999999}` via DevTools destruía a média e desbloqueava conquistas |
| 4 | `reorder` de competências não checava unicidade | 🔴 `ids: ["1","1","1","1","1"]` **DESTRUÍA 4 competências** (gravava a mesma 5×), sem aviso |
| 5 | `PUT` de competência era replace, não merge | 🔴 um PUT parcial **apagava os critérios** — o prompt do paciente passava a ser montado sem eles, e **nada falhava** |
| 6 | `allowStudent: "false"` (string) é truthy | 🟠 o paciente ficava **liberado** com o admin achando que o bloqueou |
| 7 | duelo em paciente bloqueado alimentava o MMR | 🔴 o `/api/logs` tinha o guard; o duelo não. Furava a demanda #7 |
| 8 | `applyDuelMmr` não validava arena | 🔴 um duelo cross-arena legado **acoplava os dois rankings** — o que a D9 existe para impedir |
| 9 | re-submit na janela `evaluating` | 🔴 `finalizeDuel` rodava 2× → **a mesma partida pontuava duas vezes** |
| 10 | e-mail sem unicidade no `PUT /api/users/:id` | 🔴 um aluno **assumia o e-mail de um visitante** — e o login de visitante recupera contas por `email+phone` |
| 11 | `dayKey` em UTC × `getHours()` local | 🟠 no Brasil, a sessão das 21h+ caía no **dia seguinte**: quem estuda à noite via a streak "pular" |
| 12 | `extractBloco2` pegava a PRIMEIRA geração | 🟠 dois casos na mesma entrevista eram **fundidos num personagem só** |

Mais: `NaN` envenenava o MMR **permanentemente** (o anti-smurf não pega NaN, porque todo
comparativo com NaN é `false`); `lua_cheia` prometia "em dias diferentes" e desbloqueava
com uma vigília única; a progressão gastava IA **sem** consultar a feature `avaliacao`, que
existe justamente para conter custo; sessões ativas de paciente bloqueado viravam um beco
sem saída (o card aparecia, o clique dava 403).

### O que a auditoria diz sobre a suíte

- **O harness estava cego ao fuso** (`dayKey` usava UTC, como o bug) — a suíte não *podia*
  ver o bug 11.
- **Um teste meu era verde por acidente**: o de double-finalize passava com o guard
  REMOVIDO (outro guard interceptava antes). Só a mutação pegou.
- **`custom-evaluator` "cobria" o `/api/evaluate` por `grep` no fonte** — o caminho quente
  nunca era executado.
- Vários testes só afirmavam `status === 200` sem conferir o disco: um handler que
  respondesse certo e não gravasse nada passava.

### Consolidação
719 → **788 testes**, mas com **menos gordura**: as tabelas `it.each` substituíram blocos
repetitivos, e o espaço foi para cobertura que não existia — **8 conquistas** e **as 3
missões diárias** não tinham nenhum teste de lógica; `PUT`/`DELETE` de `/api/exercises` não
tinham nenhum teste de autorização; o `withFileLock` (o diferencial do projeto) não tinha
teste de concorrência — agora tem, e provei que sem ele dois aceites simultâneos dão 200/200.

**Todas as 18 correções validadas por mutação.**

---

## 📏 ESCALA ÚNICA 0–100 (2026-07-14) — revoga uma decisão anterior

**Antes:** exercício dava nota **0–10** (os 3 avaliadores customizados definem "5 eixos de
0–2, máx. 10" dentro do próprio prompt) e freeplay dava **0–100**. O `<ScoreBadge>` clampa
em 0–100 — então **um 10/10 de exercício aparecia em VERMELHO como "Erro"**: a nota máxima
pintada como a pior possível. E a conquista `high_score` era inalcançável por exercício.

Isso estava registrado como "defeito herdado do All_OS, decidido não corrigir". **O usuário
reabriu e pediu a padronização.**

### Como foi feito (sem tocar no material pedagógico)

A escala 0–10 está **entranhada nos prompts do usuário**: os 5 eixos, as faixas de
referência ("9–10: Excepcional", "7–8: Muito bom") e o template de saída ("NOTA FINAL:
[X/10]"). Reescrevê-los seria mexer na pedagogia.

A saída foi mexer só no **wrapper** (`wrapCustomEvaluatorPrompt`, que é código nosso):
- a régua interna do admin fica **intacta** — é o raciocínio da IA;
- o wrapper exige que a nota **reportada** seja convertida para 0–100;
- e proíbe mostrar a escala original ao aluno — senão o selo diria **70** e o texto da
  devolutiva diria **"7/10"**: dois números para a mesma sessão.

### ⚠ Por que NÃO auto-convertemos no código (×10)

Seria tentador multiplicar por 10 qualquer nota ≤ 10. **É armadilha.** Um `[NOTA:7]` é
**ambíguo**: pode ser um "7/10" que a IA esqueceu de converter — ou um **7/100 legítimo**
(sessão péssima). Converter na dúvida **promoveria silenciosamente a 70 um aluno que foi
mal**, e a favor dele. Pior que o bug original.

Em vez disso: a nota é registrada **como veio**, e o `/api/evaluate` **grita no log**
(`console.warn`) quando ela parece estar em 0–10. Um avaliador mal-comportado se detecta
pelo aviso, não por notas erradas em produção.

### Efeito colateral corrigido junto
`high_score` exigia `score >= 25` — limiar herdado do All_OS, onde a trilha usava a escala
**−9..+9**. Numa escala 0–100, 25 é nota **fraca**, e "Excelência técnica" (tier **ouro**)
saía quase de graça. Subiu para **85**.

### Verificado AO VIVO com a OpenAI real
Avaliador real ("A boca fala uma coisa, o corpo outra", que pensa em máx. 10 pts):
a IA **converteu**, registrou `score: 80` e escreveu **"NOTA FINAL: [80/100]"** no texto que
o aluno lê. Selo e devolutiva concordam; o marcador `[NOTA:]` não vazou.

Travado por teste + mutação (restaurar o wrapper antigo quebra 2 testes).
**É uma divergência deliberada do All_OS**, que mantém o defeito.


---

# 📥 BACKLOG NOVO (não implementado)

## ▶️ COMEÇAR AQUI AMANHÃ (2026-07-15)

As 8 demandas originais estão **feitas e commitadas**. O que ficou para amanhã, em ordem de
prioridade sugerida — tudo levantado na sessão de 2026-07-14:

| # | o que é | tamanho | decisão? |
|---|---|---|---|
| ~~**10**~~ | ~~Desligar o TTL de 30 dias dos logs~~ | ~~2 pts~~ | ✅ **FEITA** |
| ~~**9**~~ | ~~Anúncios do admin~~ | ~~5 pts~~ | ✅ **FEITA** |

~~**A #10 é a mais rápida** — comece por ela.~~ ✅ **FEITA** em 2026-07-15 (ver abaixo).

**A #9 precisa de 4 decisões suas antes de eu codar** (quem vê, se o visitante vê, se um
anúncio novo reabre o pop-up de quem já viu o anterior, se é retroativo). Estão listadas em
§9. Traga as respostas e eu implemento direto.

> ⚠ **Nada de novo foi codado hoje para a #9 e a #10** — só documentado. O que foi *corrigido*
> hoje (contradição do selo × texto da nota, e a confusão da avaliação por papel) **já está
> commitado**. Não há retrabalho: amanhã é backlog novo, não conserto do de hoje.

---


## 9. Anúncios do admin (pop-up no primeiro login)

> As notificações atuais são genéricas, feitas em desenvolvimento — **limpar todas**. Quero
> um lugar onde o administrador publique um anúncio, e ele apareça como **pop-up** para
> cada usuário no primeiro login **depois** de o anúncio ser criado. Depois disso, ele vai
> para a lista de notificações, que já existe.

**Status:** ✅ **FEITA** (2026-07-15) · **Pontos: 5**

### ✅ Implementado (backend + client, 16 testes + mutação)
- `announcements.json` (novo): anúncios globais `{id,title,body,roles,active,createdAt,createdBy}`.
- Cada usuário guarda `seenAnnouncements:[ids]` em users.json (escondido do client via `publicUser`).
- `GET /api/announcements/pending` — os pop-ups pendentes do usuário; `POST /:id/seen` fecha.
- CRUD admin em `/api/admin/announcements`. A tela é `/admin/anuncios`.
- `<AnnouncementPopup>` no App: abre no login, um de cada vez (o próximo abre ao fechar o atual).

### Decisões fechadas (2026-07-14) — todas travadas em teste
- **Público POR PAPEL** ao publicar (chips: alunos / visitantes / professores / admins).
  Nenhum marcado = todos. Papel forjado no `roles` é descartado.
- **O visitante VÊ** (é usuário real, demanda #1).
- **Cada anúncio novo REABRE** o pop-up para quem já viu o anterior (cada anúncio é um evento).
- **RETROATIVO**: quem se cadastra depois vê os anúncios ativos, enquanto publicados.
- Despublicar (`active:false`) tira o pop-up sem apagar o anúncio (dá para republicar).

### Notificações de desenvolvimento — não havia o que limpar
O `notifications.json` NÃO é versionado, não tem seed, e o boot o cria vazio (`{}`). Um deploy
limpo **já nasce sem notificações**. As genéricas que o usuário viu vinham de um volume dele —
limpeza de dado, não de código. (O `announcements.json` foi incluído no `/api/admin/export`.)

### O que já existe (e dá para reaproveitar)
- `notifications.json` + `pushNotification(userId, notif)` — mas hoje a notificação é
  **por usuário** e nasce de um evento (convite/resultado de duelo).
- `GET /api/notifications`, `POST /api/notifications/:id/read`, `.../read-all`.
- O `<NotificationBell>` no client já lista e marca como lida.

### O que muda
1. **Limpar o `notifications.json`** no deploy (as atuais são lixo de desenvolvimento).
2. Um anúncio é **global**, não por usuário — replicar a mesma mensagem para N usuários
   seria caro e não cobriria quem se cadastrar depois. Provavelmente um `announcements.json`
   separado, e cada usuário guarda o que já viu (`lastSeenAnnouncementAt` ou a lista de ids).
3. **Tela de admin** para escrever/publicar (e provavelmente despublicar).
4. **Pop-up no primeiro login após a publicação** — "primeiro login depois que o anúncio foi
   criado", não "toda vez". Depois de fechado, o anúncio continua na lista do sino.

### ⚠ Pontos a decidir antes de codar
- **Quem vê?** Todos, ou dá para segmentar por papel (só alunos, só visitantes)? A matriz de
  acesso da demanda #4 já tem o vocabulário para isso.
- **O visitante vê?** Ele é efêmero-ish (tem prazo, demanda #8).
- **Um anúncio novo reabre o pop-up** para quem já tinha visto o anterior? (Sim, presumo —
  senão o segundo anúncio nunca apareceria.)
- **Retroativo?** Quem se cadastrar amanhã vê o anúncio de hoje? (Provavelmente sim, se ele
  ainda estiver publicado.)


---

## 10. Explicar (e decidir) a persistência de dados no Railway

> "No sistema antigo tem a mensagem de que os logs serão apagados em 30 dias, mas isso não é
> mais verdade, porque agora temos o /data, certo?"

**Status:** ✅ **FEITA** (2026-07-15) · **Pontos: 2**

### ✅ Implementado
- `LOG_TTL_DAYS` virou env: `0` (ou vazio) = **nunca expira** (o novo padrão); `> 0` religa o
  prune sem redeploy. Documentada no `.env.example`.
- `pruneExpiredLogs()` e `logExpiresAt()` respeitam o desligado (retornam cedo).
- `GET /api/logs/policy` devolve `{ ttlDays: 0 }`; o client esconde o aviso de expiração e o
  selo "expira em Xd" quando `ttlDays === 0` (o fallback local de 30 dias foi REMOVIDO — ele
  inventaria uma data que não existe mais).
- Verificado: log de 400 dias sobrevive ao `GET /api/logs`; religando `LOG_TTL_DAYS=30` (boot
  novo) a policy volta a `30`. Travado por teste (799 passando) — inclusive a leitura da env
  num processo separado.
- ⚠ O TTL do **duelo** (`DUEL_TTL_MS`, 30 dias) foi deixado INTACTO — o usuário falou só de logs.

### (registro original da decisão)

### ✅ DECISÃO DO USUÁRIO (2026-07-14): os logs NÃO expiram mais
> "Eu não vou querer mais que os logs apaguem em 30 dias. Eles têm que ficar no /data e eu
> vou lá apagar manualmente."

**A fazer:**
1. Desligar o `pruneExpiredLogs()` — sem apagamento automático. Sugestão: manter a
   infraestrutura viva atrás de uma env (`LOG_TTL_DAYS`, com `0` = "nunca expira"), para dar
   para religar sem redeploy de código se um dia mudar de ideia.
2. `GET /api/logs/policy` passa a devolver `ttlDays: 0` (ou `null`).
3. **A mensagem no client (`Logs.jsx`)** "Os logs expiram após 30 dias. Baixe os que quiser
   guardar" tem que **sumir** — senão passa a mentir. Ela já lê o `/logs/policy`, então basta
   esconder o aviso quando `ttlDays` for 0.
4. Os `expiresAt` / `ExpiryNote` do client (o "expira em Xd" por log) também somem.

**⚠ A consequência que fica (aceita pelo usuário):** sem TTL, o `logs.json` cresce para
sempre. O arquivo é lido e reescrito INTEIRO a cada log salvo — medimos ~147 ms de event
loop bloqueado com 14 MB (≈ 30 alunos × 30 dias). Com um ano de uso isso vira ~170 MB num
único JSON, e o tempo de gravação passa a doer. **O teto real do projeto deixa de ser o TTL
e passa a ser o `logs.json`.** A saída definitiva é migrar os logs para SQLite — não urgente,
mas é o próximo teto de escala, e apagar manualmente no /data alivia mas não resolve.

⚠ O **duelo** tem TTL próprio (`DUEL_TTL_MS`, 30 dias). O usuário falou só de logs — **NÃO
mexer no duelo sem confirmar**.

### ⚠ A premissa está ERRADA — e isso importa

**O volume e o TTL são coisas diferentes, e o TTL continua ATIVO.**

| | o que faz | o volume `/data` resolve? |
|---|---|---|
| **Volume do Railway** | os arquivos **sobrevivem ao redeploy**. Sem ele, todo deploy zerava tudo. | — |
| **TTL de 30 dias** | `pruneExpiredLogs()` **APAGA do `logs.json`** todo log com mais de 30 dias | ❌ **NÃO.** O prune deleta o dado; o volume só garante que o arquivo persista entre deploys. |

Conferido no código (`server/index.js`): `LOG_TTL_DAYS = 30`, e `pruneExpiredLogs()` roda a
cada `GET /api/logs`, reescrevendo o arquivo **sem** os logs vencidos. É deleção real, não
uma flag de "oculto".

**Ou seja: a mensagem que o aluno vê ("Os logs expiram automaticamente após 30 dias. Baixe os
que quiser guardar antes disso.") está CORRETA e continuará valendo no Railway.** Se subirmos
assim, os logs dos alunos **serão apagados** aos 30 dias — inclusive as avaliações da IA.

### O que precisa ser decidido
1. **Manter o TTL de 30 dias?** Era uma escolha de contenção (o `logs.json` é reescrito
   inteiro a cada gravação; medimos ~147 ms de event loop bloqueado com 14 MB). Sem TTL, o
   arquivo cresce para sempre — e esse é o próximo teto de escala do projeto.
2. **Ou aumentar / desligar?** `LOG_TTL_DAYS` é uma constante — mudar é trivial. O custo não
   é o código, é o desempenho: com 30 alunos × 5 sessões/semana, 30 dias ≈ 14 MB. Um ano
   seria ~170 MB num único JSON lido e reescrito a cada log salvo. **Aí o TTL deixa de ser o
   problema e o `logs.json` passa a ser** — a saída real seria migrar para SQLite.
3. **Se mudar, a mensagem do client (`Logs.jsx`) tem que mudar junto** — ela lê o
   `GET /api/logs/policy`, então acompanha sozinha o `ttlDays`. Mas o texto "Baixe os que
   quiser guardar" precisa sumir se não houver mais expiração.

### O que já está resolvido (não confundir)
- O **volume** está configurado (`DATA_DIR=/data` + mount no Railway), e sem ele o deploy
  falha no healthcheck (`/api/health` responde 503 se o diretório não for gravável).
- O **duelo** tem TTL próprio (`DUEL_TTL_MS`, 30 dias) — mesma discussão, escopo menor.

---

# 📥 BACKLOG NOVO — 2026-07-15 (deploy no ar)

## 11. ✅ BUG: a tela "Acessos" fica preta (crash de runtime) — CORRIGIDO

> A tela de Admin → Acessos carrega e, quando termina, fica uma tela preta gigante.
> Não dá para ver nada.

**Status:** ✅ FEITO (commit do fix do import de Link). Falta só o DEPLOY MANUAL para o ar pegar. Pontos: 2

### Causa raiz — JÁ IDENTIFICADA no console do navegador
```
Uncaught ReferenceError: Link is not defined   (index-*.js)
```
`client/src/pages/AdminFeatures.jsx` usa `<Link to="/admin/contas">` (no aviso da chave
mestra que adicionei junto com a clarificação da avaliação por papel) **mas nunca importa
o `Link` do `react-router-dom`**. Como o React não tem tratamento de erro, um `ReferenceError`
na renderização derruba a árvore inteira → tela preta.

Fui eu que introduzi ao editar essa tela. O `vite build` NÃO pega isso (um símbolo global
indefinido só estoura em runtime), e a suíte não renderiza React — por isso passou.

### A fazer
1. **Corrigir:** `import { Link } from 'react-router-dom';` em `AdminFeatures.jsx`.
2. **Varrer o resto:** procurar em TODAS as páginas/componentes qualquer `<Link>`,
   `<Navigate>`, `useNavigate`, `useParams` usado sem o import correspondente — se aconteceu
   numa, pode ter em outra que editei.
3. **ErrorBoundary (a lição de fundo):** hoje, um erro em qualquer tela deixa a tela preta,
   sem mensagem. Adicionar um `<ErrorBoundary>` em volta das rotas para que o próximo crash
   mostre "algo deu errado nesta tela" em vez de derrubar o app todo. Isto é o que transforma
   um bug de uma tela num incidente de UMA tela, não do sistema inteiro.
4. **Trava de teste:** a suíte node não renderiza React, mas dá para travar no fonte — um
   teste que falha se um arquivo usar `<Link` sem importar `Link` (grep no fonte, no espírito
   do `prompt-files.test.js`). Barato, e pega exatamente esta classe de bug.

---

## 12. ✅ Anúncios: dois tipos (notificação × atualização) + controle do admin — FEITO

> O anúncio pode ser uma NOTIFICAÇÃO ou uma ATUALIZAÇÃO DO SISTEMA. Comportamento padrão dos
> dois: pop-up no primeiro login; depois vai para o seu histórico respectivo — notificação no
> **sininho**, atualização no botão de **atualizações do sistema**. E o admin precisa poder
> RETIRAR um anúncio da tela dos usuários.

**Status:** ✅ FEITO (2026-07-15) · **Pontos: 5** · Estende a demanda #9.

### ✅ Implementado
- Campo `type` no anúncio (`notification` | `update`, padrão notification). POST e PUT o aceitam.
- `GET /api/announcements/history` → `{ notifications, updates }`, por papel, só os ativos.
- **Sino** (`NotificationBell`) passa a misturar os anúncios do tipo notification (como
  histórico "lido", sem inflar o badge de não-lidos).
- **Botão de atualizações** (`SystemUpdates`) passa a ler os anúncios do tipo update do
  SERVIDOR — o `changelog.js` hardcoded foi **esvaziado** (mostrava notas de dev antigas).
- Tela de admin: seletor de tipo (rádio) + coluna Tipo na lista.
- Retirar: o "despublicar" (active:false) da #9 já tira o anúncio do pop-up E do histórico
  (sino/updates). Verificado ao vivo.
- Limpeza: um deploy limpo começa SEM atualizações (o changelog foi zerado; os anúncios do
  servidor nascem vazios).
- 7 testes novos + 2 mutantes. 842 testes no total.

### O que muda em relação à #9 (que já entregou o pop-up + tela de admin)
1. **Tipo do anúncio.** Ao criar, o admin escolhe: `notificação` ou `atualização do sistema`.
   - Hoje o pop-up existe (#9), mas o "depois do pop-up" só contempla notificação.
   - **Notificação** → depois de lida, entra na lista do **sino** (`NotificationBell`, já existe).
   - **Atualização do sistema** → depois de lida, entra na lista do botão de **atualizações**
     (`<SystemUpdates>` + `changelog.js`, já existem — hoje o conteúdo é hardcoded no
     `changelog.js`).
2. **O admin retira o anúncio.** Já existe "despublicar" (`active:false`) na #9 — confirmar
   que ele TIRA da tela do usuário (do sino / das atualizações), não só do pop-up. Talvez
   precise de um "arquivar" além do "apagar".
3. **Ligar os anúncios ao `SystemUpdates`.** Hoje o `<SystemUpdates>` lê um `changelog.js`
   ESTÁTICO (hardcoded no client). Os anúncios do tipo "atualização" precisam alimentar esse
   botão — ou o `SystemUpdates` passa a ler do servidor (`announcements` do tipo update), ou
   o changelog.js some e tudo vira anúncio.

### 🧹 Limpeza no deploy (parte da demanda)
> Tem várias atualizações do sistema ANTIGAS que não existem mais. Apagar como padrão; ao
> subir o sistema, começa em branco.

O `<SystemUpdates>` mostra um `changelog.js` versionado, com entradas de desenvolvimento
("8 de julho — Duelo, Ranking e Progressão…") que não deveriam aparecer para os usuários
reais. **Limpar o `changelog.js`** (ou migrar tudo para os anúncios do servidor, que já
nascem vazios num deploy limpo — ver #9). Um deploy limpo deve começar SEM atualizações.

### ⚠ Decisões a confirmar antes de codar
- O `<SystemUpdates>` deve passar a ler do servidor (anúncios tipo "update"), ou continua um
  arquivo estático que a gente só esvazia? (Ler do servidor é o certo se o admin vai criar
  atualizações pela tela; estático é mais simples se as atualizações forem raras e via deploy.)
- "Retirar da tela" = despublicar (some para todos, mas o anúncio fica no admin) ou apagar
  de vez? Provavelmente os dois, como na #9.

---

# 📥 BACKLOG NOVO — 2026-08-14

Sessão de grilling com o usuário. As #11 e #12 foram confirmadas **funcionando em
produção** (deploy já feito). O que segue é o backlog desta sessão.

| # | o que é | pontos | status |
|---|---|---|---|
| 13 | Renomear "Genus Práxis" → "Genus Praxis" (tirar o acento) | 1 | ✅ **FEITA** |
| 14 | Banner da Home vira link para a OMNIA | 1 | ✅ **FEITA** |
| 15 | 🔴 BUG: competências editadas não aparecem no `<select>` de exercícios | 3 | ✅ **FEITA** |
| 16 | Terminar a #11: ErrorBoundary + varredura + teste de imports | 3 | ✅ **FEITA** |

---

## 13. Renomear para "Genus Praxis" (sem acento) ✅

**Decisão do usuário:** mantém o "Genus"; muda só `Práxis` → `Praxis`. O nome do produto na
tela passa a bater com o domínio (`praxis.lucasalbertoni.com`).

**Escopo A (fechado com o usuário): só o que o cliente vê.** Alterados: `client/index.html`
(title + meta description), `App.jsx` (sidebar, topo, `alt` das logos), `Login.jsx`,
`Avaliacao.jsx` (o autor "Genus Praxis · Avaliador"), `Duelo.jsx` (o texto do convite
compartilhado no WhatsApp), `package.json`, `README.md` e o log de boot do servidor.

**Deliberadamente NÃO alterados:** comentários de código e de CSS, `CLAUDE.md` e
`DIFERENCAS.md` — lá "Genus" é usado em oposição a "All_OS" para explicar a origem do fork,
e reescrever perderia a história do porte sem ganho para o usuário.

⚠ **O diretório do repositório (`genus_praxis`) e o `DATA_DIR` NÃO mudam.** Renomear
quebraria os caminhos locais e o volume do Railway. Nome de produto ≠ nome de pasta.

O `<span className="accent">` foi preservado: "Genus" fica branco e "Praxis" laranja, como
era antes.

---

## 14. Banner da Home → OMNIA ✅

O "CLIQUE AQUI" faz parte da **imagem** do banner (não era um elemento próprio), então o
banner inteiro virou o link — decisão do usuário.

- Destino: `https://omnia.lucasalbertoni.com/`
- **Nova aba** (`target="_blank"`) — sair do Praxis no meio de um atendimento faria o aluno
  perder a tela. Com `rel="noopener noreferrer"`: sem ele, a página de destino ganha acesso
  programático à nossa aba via `window.opener`.
- **Visível para todos os papéis** (decisão do usuário — inclusive admin e professor).
- CSS: o `<div>` virou `<a>`, que é `inline` por padrão — sem `display:block` a moldura e o
  raio não envolveriam a imagem. Ganhou realce de `:hover` para sinalizar que é clicável.

---

## 15. 🔴 BUG (produção): o `<select>` de competências mostrava a lista antiga ✅

> "Meu administrador trocou as competências, mas quando vai alterar os exercícios da trilha
> e clica em competência continua aparecendo as antigas."

### Causa raiz — não era falta de link entre as telas

As duas telas já liam da mesma fonte (`skills.json` → `GET /api/skills`). O problema era
**quando**: `useSkills()` buscava as competências num `useEffect` com dependências `[]` —
**uma vez, no mount do app**, e o valor ficava congelado em memória pela sessão inteira.

`AdminSkills` (onde ele editou) tem estado **próprio** e atualiza otimisticamente — por isso
a tabela dele mostrava o resultado certo e parecia ter salvo. E tinha salvo. Mas
`AdminExercises`, `SkillMap` e os selos dos `Logs` leem do **contexto compartilhado**, que
ninguém nunca avisava da mudança. Só um F5 corrigia.

**Confirmado como cache, não corrupção:** o usuário deu Ctrl+Shift+R e as competências novas
apareceram. Os dados no servidor estavam certos o tempo todo.

### A correção (opção B, escolhida pelo usuário)
1. **`reload()` no provider.** `useSkills` expõe `reload`; o `AdminSkills` o chama de dentro
   do próprio `load()` — que é o **ponto único** por onde salvar, apagar e reordenar já
   passavam. Sem espalhar chamada por handler.
2. **A carga parou de falhar em silêncio.** O `.catch(() => {})` engolia o erro e a trilha
   inteira exibia as 5 competências **fantasma** do `FALLBACK_SKILLS` hardcoded — que, numa
   instalação que já editou as competências, é informação errada apresentada como certa.
   Agora há `console.error` e uma flag `stale`.

**NÃO mexemos no `FALLBACK_SKILLS`** (opção C, descartada): ele existe para a tela não piscar
com um polígono de zero lados durante o carregamento, e trocá-lo tem efeito visual que não dá
para verificar sem navegador.

### Verificado ao vivo (servidor real, volume limpo)
Reproduzida a trilha real do administrador (Empatia / Experiencialidade / Não diretividade /
Aceitação / Relacionalidade) via API: o `GET /api/skills` serve a lista nova, os `criteria`
sobrevivem a um PUT parcial, e um **processo novo contra o mesmo volume** devolve tudo intacto.

> 💡 Achado do caminho (**não é bug**): renomear a competência 1 para "Empatia" é recusado com
> `409 "Já existe uma competência com esse nome"` enquanto a 3 ainda se chamar Empatia. O admin
> precisa renomear na ordem que evita a colisão. O servidor está certo — dois nomes iguais
> seriam indistinguíveis no SkillMap e nos logs.

---

## 16. Terminar a demanda #11 ✅ (o que faltava dela)

A #11 tinha sido fechada só com o passo 1 (o `import { Link }`). Os passos 2, 3 e 4 que a
própria spec pedia estavam pendentes:

**2. Varredura do client — limpa.** Verifiquei todos os `.jsx` atrás de `Link`, `Navigate`,
`Outlet`, `useNavigate`, `useParams`, `useLocation` e `useSearchParams` usados sem import.
O `AdminFeatures` era o único caso; não havia irmão escondido.

**3. `<ErrorBoundary>` em volta das rotas.** Hoje um erro de renderização em UMA tela
derrubava a árvore inteira do React — tela preta, sem sidebar, sem mensagem, sem saída. Agora
a falha fica contida na tela e o menu continua de pé.
- `resetKey={location.pathname}`: sem isso o boundary vira **armadilha** — uma vez em erro,
  continuaria mostrando a tela de falha mesmo depois de navegar para outra rota, porque o
  estado sobrevive à troca de filhos.
- O CSS mora no `index.css`, não num arquivo próprio: se o CSS da página quebrada não
  carregar, a tela de erro ainda precisa aparecer.
- ⚠ **Limitação do React, não escolha nossa:** só captura erros de **renderização**. Exceção
  em `onClick`, `setTimeout` ou promise rejeitada NÃO passa pelo boundary.

**4. `tests/client-imports.test.js` (novo, 43 testes).** Trava a classe de bug no **fonte**,
no espírito do `prompt-files.test.js` — porque nada mais a pega: o `vite build` compila numa
boa (símbolo global indefinido só estoura em runtime) e a suíte não renderiza React.
- Remove comentários e strings antes de procurar o uso: um `<Link>` citado num comentário
  contaria como uso real, e falso positivo é a forma mais rápida de um teste ser desativado.
- **Validado por MUTAÇÃO:** removi o `import { Link }` do `AdminFeatures` (o bug original de
  produção) e o teste falhou nomeando arquivo e símbolo. Restaurado depois.

---

## 📌 Persistência no deploy — confirmado com o usuário (2026-08-14)

> "Quando eu subir o novo deploy eu não quero que suba apagando o que ele construiu."

**Não apaga.** Verificado no código e ao vivo, não presumido:

| o que o admin edita **pela tela** | onde mora | sobrevive |
|---|---|---|
| Prompt do paciente (`specificInstruction`) | `exercises.json` / `freeplay-characters.json` | ✅ |
| Gabarito (`evaluationCriteria`) e avaliador customizado | idem | ✅ |
| Competências + critérios | `skills.json` | ✅ |
| Contas, logs, MMR, anúncios, configurações | os JSONs do volume | ✅ |

Duas garantias: o seed copia **arquivo por arquivo só se o destino não existir**
(`if (!fs.existsSync(dst))`, server/index.js:75), e o volume `/data` sobrevive ao redeploy.

**Prova ao vivo:** editei o prompt de um exercício com um marcador, matei o processo e subi
outro contra o mesmo volume — o marcador estava lá. Note que `exercises.json` **é** um dos
dois arquivos do `server/seed/`, e mesmo assim não foi sobrescrito.

⚠ **Os prompts do SISTEMA são o caso oposto.** `server/avaliacao/*.md` e
`server/entrevistador/promptentrevistador.md` vêm do **git**, não do volume. Estão commitados
(verificado), então o deploy os leva — mas quem editar um deles direto no servidor perde a
alteração no próximo deploy. Não são editáveis pela interface, então na prática não é risco.

**A regra em uma frase:** o que é editado *pela tela* está no volume e sobrevive; o que é
editado *por arquivo* vem do git e é substituído a cada deploy.

⚠ A única forma real de perder dados: **desmontar/recriar o volume ou mudar o `DATA_DIR`** no
Railway. Aí o app escreve em outro lugar e sobe vazio — parece "o deploy apagou tudo", mas foi
troca de destino. Um export por *Admin → Exportar* antes de subir custa 10 segundos.
