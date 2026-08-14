# Genus Praxis

Plataforma de **simulação clínica** — white label do All_OS com a estética laranja
da marca. O único modo é a **Simulação / Treinamento**: o aluno atende pacientes
simulados por IA, sessão a sessão, e o log de cada atendimento é registrado.

> _"Todo ser humano é único e possui um potencial ilimitado."_

## Como rodar

```bash
# 1. Dependências (raiz instala o servidor e, via postinstall, o cliente)
npm install

# 2. Configure o ambiente
cp .env.example .env
#   - JWT_SECRET  → obrigatório (gere: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
#   - OPENAI_API_KEY → opcional. Sem ela, a simulação roda em "modo demonstração"
#     (respostas fixas) e o Whisper (áudio) fica indisponível.

# 3. Desenvolvimento (servidor :3001 + Vite :5173 com hot reload)
npm run dev
#   Abra http://localhost:5173

# 4. Produção (build do cliente + servidor único servindo tudo)
npm run build
npm start
#   Abra http://localhost:3001
```

## Contas — o primeiro admin

O app usa **JWT** para as sessões (assinado com `JWT_SECRET`) e **bcrypt** para as
senhas. Na primeira execução ele cria o(s) usuário(s) inicial(is); depois é só
logar como admin e criar as demais contas na tela **Contas**.

**Desenvolvimento local** (sem `ADMIN_INITIAL_PASSWORD`) — cria contas de demonstração:

| Usuário       | Senha           | Função         |
| ------------- | --------------- | -------------- |
| `admin`       | `admin123`      | Administrador  |
| `supervisor`  | `supervisor123` | Professor      |
| `aluno`       | `aluno123`      | Aluno          |

**Produção** — defina `ADMIN_INITIAL_PASSWORD` (mín. 8 caracteres) na env do
servidor **antes do primeiro boot**. O app cria então **apenas o admin** com essa
senha (usuário `admin`, ou o que estiver em `ADMIN_INITIAL_USERNAME`). As contas de
demonstração **não** são criadas.

```bash
ADMIN_INITIAL_USERNAME=admin
ADMIN_INITIAL_PASSWORD=uma-senha-forte-aqui
```

> A senha vive só na env do servidor (nunca no repositório). Ela só é usada uma
> vez, na criação inicial — depois você pode trocá-la em **Perfil**. Como
> `server/data/` é ignorado pelo git, num host novo o primeiro boot usa essa env.

## Deploy — Railway

Um único serviço Node roda o Express, que serve a API **e** o front já buildado
(`client/dist`). Não existe deploy separado do front.

O repositório já traz `railway.json` com o build (`npm run build`), o start
(`npm start`) e o healthcheck (`/api/health`).

### 1. Criar o serviço

**New Project → Deploy from GitHub repo** e aponte para este repositório.
O Railway detecta o Node e usa o `railway.json`.

### 2. Criar o volume (OBRIGATÓRIO)

O filesystem do Railway é **efêmero**: sem volume, contas, logs, MMR, duelos e
fotos de paciente somem a cada deploy.

- **Service → Variables → New Volume**, mount path: `/data`
- Defina a variável `DATA_DIR=/data`

No primeiro boot o servidor copia `server/seed/` (pacientes + exercícios) para o
`DATA_DIR`, **sem nunca sobrescrever** um arquivo que já exista lá.

### 3. Variáveis de ambiente

| Variável | Obrigatória | Observação |
|---|---|---|
| `JWT_SECRET` | sim | mín. 32 chars. `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `DATA_DIR` | sim | `/data` — o mount path do volume |
| `ADMIN_INITIAL_PASSWORD` | sim (1º boot) | cria só a conta admin. Sem ela, o app cria as contas de DEMONSTRAÇÃO (`admin/admin123`) — **nunca em produção** |
| `OPENAI_API_KEY` | não | sem ela, simulação/avaliação/entrevistador ficam em modo demonstração |
| `PORT` | **não defina** | o Railway injeta automaticamente |
| `CORS_ALLOWLIST` | não | mesma origem: não precisa mexer |

### 4. Conferir

`GET /api/health` responde `200` com `{ ok, dataDir, dataWritable, openai }`.
Se `dataWritable` for `false`, o volume não está montado — o healthcheck falha
(503) e o Railway não promove o deploy.

> **Antes do primeiro push**, garanta que os prompts estão versionados:
> `server/entrevistador/promptentrevistador.md` e `server/avaliacao/*.md`.
> Eles não estão no `.gitignore`, mas se não forem commitados o entrevistador e
> os avaliadores de duelo/progressão respondem erro em produção.

## O que tem

- **Login** (aluno, professor, administrador).
- **Início** — banner + instruções + botão "Jogar simulação".
- **Simulação** (aba à esquerda) — biblioteca de pacientes → chat com:
  - cronômetro de sessão,
  - **Próxima sessão** (time skip) com contagem funcional,
  - função de **áudio (Whisper)**,
  - destaque de mensagens,
  - **Finalizar e enviar** → tela de agradecimento; o log é salvo.
- **Criação de Personagens** (só admin).
- **Contas** (só admin) — com o liga/desliga do avaliador.
- **Meus logs** (aluno) / **Todos os logs** (professor e admin) — com filtros,
  ordenação, agrupamento por pessoa, visualização e download.
- **Perfil** — dados, foto e senha.

## Avaliador (estrutura pronta, desligado)

A avaliação por IA **não está ativa** — ao finalizar a sessão o aluno vê a tela de
agradecimento e o log é salvo para análise humana. Toda a estrutura já está montada
para ligar depois. Veja **`server/avaliacao/README.md`**: basta escrever o prompt em
`server/avaliacao/avaliador.md`, escolher o modelo (`OPENAI_EVAL_MODEL`) e ligar
(env `EVALUATOR_ENABLED=true` ou o botão na tela **Contas**).

## Estrutura

```
server/          Express + persistência em JSON (server/data)
  index.js       API (auth, contas, personagens, logs, sessões, chat, avaliação, whisper)
  prompts.js     montagem dos system prompts (server-side)
  scoring.js     cálculo determinístico da nota final
  avaliacao/     onde vive o prompt do avaliador (quando for ligado)
client/          React + Vite
  src/pages/     Login, Home, Simulacao, ChatSession, AdminCharacters, AdminUsers, Logs, Profile
  src/index.css  tema escuro (laranja + roxo), títulos Anton, corpo UniNeue (fallback Jost)
```

### Fontes

Títulos usam **Anton** (Google Fonts). O corpo usa **UniNeue** — se você tiver os
arquivos da fonte, coloque `UniNeueBook.woff2`/`.woff` em `client/public/fonts/` e
ela é usada automaticamente; caso contrário, cai no fallback **Jost**.
