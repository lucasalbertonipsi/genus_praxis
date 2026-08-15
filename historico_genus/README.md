# histórico_genus — o que o cliente construiu, versionado

Backup do material pedagógico criado pelo cliente **fora** do volume de produção.

## Por que isto existe

Em 2026-08-14 o cliente perdeu dias de trabalho: o projeto no Railway nunca teve
volume montado, então `DATA_DIR=/data` gravava dentro do container e cada deploy
apagava tudo. O volume foi montado depois (o `/api/health` agora responde
`persisted: true`), mas a lição ficou: **um backup que mora no mesmo lugar que o dado
não é backup.**

Há três camadas hoje, e esta é a única fora do servidor:

| camada | onde mora | protege de |
|---|---|---|
| `server/seed/` | repositório | volume nascer vazio (deploy limpo) |
| snapshot automático | `/data/_snapshots` | bug, exclusão acidental, deploy ruim |
| **esta pasta** | repositório | **perder o volume inteiro** |

## Conteúdo

- **`praxis-trilha-*.json`** — export de `/api/admin/export`, filtrado: competências,
  exercícios e clientes. Sem usuários, logs ou dados pessoais (conferido).
- **`Célio Martins (atualizado).docx`** — a fonte do prompt do exercício "Sob Pressão",
  escrita pelo cliente.

## Relação com `server/seed/`

O `server/seed/` é **cópia fiel** do que está aqui — conferido campo a campo. A diferença
é o `skillId`: o export traz os ids antigos das competências (Empatia era 3), e o seed usa
o esquema 1..5. Ao trazer um export novo, **remapeie** — sem isso cada exercício fica
ligado à competência errada, em silêncio.

## Como atualizar

1. *Admin → Contas → Exportar dados* (ou o snippet de console que filtra só a trilha).
2. Salve o `.json` aqui.
3. Reflita as mudanças em `server/seed/`, remapeando o `skillId`.
4. `npm test` e boot em volume limpo para conferir que nada ficou órfão.

⚠ O seed **não** sobrescreve um volume que já tem dados — ele só preenche o que falta.
Para restaurar algo em produção, use as rotas de snapshot (`/api/admin/snapshots`).
