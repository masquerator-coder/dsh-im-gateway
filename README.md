# dsh-im-gateway — DeepSeek Harness IM gateway plugin

A [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) (Cordis) plugin that bridges an external IM platform into Harness:

1. **Inbound** — an embedded HTTP webhook server receives messages POSTed by the external IM platform.
2. **Bridge** — each message is injected into a **persistent Harness Agent** that is stably mapped to the external chat id (so a conversation keeps context across messages; separate chats stay isolated).
3. **Outbound** — the Agent's reply is collected from the session event stream and **POSTed back to a configurable callback URL**.

It is IM-agnostic: both the inbound and outbound legs are plain HTTP, so it works with WeCom, Feishu, Telegram bots, Discord, custom systems, etc., without binding to any vendor SDK.

---

## How it works

```
external IM  --POST-->  [HTTP webhook (this plugin)]  --followup-->  [persistent Agent/session per chat]
      ^                                                                      |
      |                                                                      | session/event
      +-- <--callback POST--  [collected reply]
```

- **Per-chat session**: `SessionId = im-<sha1(chat_id)[0:16]>`. The same external chat always reuses the same Agent (durable context); different chats never share one.
- **Reply delivery**: text blocks of each `assistant/message` session event (`@deepseek-ai/dsh-session`) are accumulated until the agent reaches quiescence (`agent.whenIdle()`), then POSTed to `callbackUrl`.

---

## Files

| Path | Purpose |
| --- | --- |
| `src/config.ts` | Schemastery `Config` schema (all tunables) |
| `src/inbound.ts` | Embedded `node:http` webhook server |
| `src/gateway.ts` | chat→agent mapping, message injection, reply collection + callback |
| `src/index.ts` | Plugin entry (`name`/`inject`/`Config`/`apply` + lifecycle) |
| `cordis.yml` | Local source overlay (`--patch`) for development / e2e iteration |
| `cordis.patch.yml` | Published **bundle** layer — references the package by name (`dsh-im-gateway` → `lib/index.js`) |
| `scripts/build.mjs` | esbuild build: bundles `src/` → `lib/index.js` (the `build`/`prepare` script) |
| `lib/` | Generated build output (git-ignored; produced by `prepare` on install) |
| `LICENSE` | MIT license |
| `README.md` | This file |

---

## Configuration (via `cordis.yml`)

| Key | Default | Meaning |
| --- | --- | --- |
| `host` | `127.0.0.1` | Inbound listen address |
| `port` | `8799` | Inbound listen port |
| `inboundPath` | `/im` | Webhook URL path |
| `secret` | `''` | Optional shared secret; requests must send it in header `x-im-secret`. Empty = no auth. |
| `chatIdField` | `chat_id` | Webhook JSON body field identifying the chat |
| `textField` | `text` | Webhook JSON body field carrying the message text |
| `senderField` | `sender_id` | Optional body field for the sender id (attribution summary) |
| `callbackUrl` | *(required)* | URL the reply is POSTed to |
| `callbackChatHeader` | `x-im-chat-id` | Header holding the chat id on the callback |
| `callbackSecretHeader` | `x-im-secret` | Header holding the secret on the callback |
| `provider` | `''` | Model provider route for created Agents (empty = runtime default) |
| `model` | `''` | Model id for created Agents (empty = runtime default) |
| `maxTokens` | `0` | Positive output cap, or 0 for default |
| `agentPreset` | `''` | Optional agent preset applied on creation |
| `cwd` | `''` | Optional working directory for the Agent session |
| `disposeAfterReply` | `false` | Dispose the Agent after each reply (frees resources, drops context) |

> ⚠️ Only `host`/`port`/`inboundPath`/`chatIdField`/`textField`/`senderField`/`callbackChatHeader`/`callbackSecretHeader`
> and the checkbox-like fields are non-sensitive wiring. **`secret` and `callbackUrl` are deployment secrets** —
> never commit real values. Keep your `cordis.yml` secret in `.env`/local overrides and out of the repository.

---

## Security

- **Inbound auth**: set `secret` so the webhook only accepts requests carrying
  `x-im-secret: <secret>`. Leave it empty only when the endpoint is firewalled
  and the upstream IM platform is the sole caller.
- **Secrets management**: keep the real `secret` and `callbackUrl` out of Git.
  This repo ships `secret: ''` and a loopback placeholder `callbackUrl` only.
  Create a `.env`-backed or local-only `cordis.yml` overlay for real values.
- **Agent access**: the plugin creates a persistent Harness Agent per external
  chat. Anyone who can reach the webhook endpoint can drive that agent — put it
  behind a private network / auth and set a per-deployment secret.

---

## Usage

The plugin ships in **two interchangeable forms**:

- a **bundle** (recommended for deployment) — installed by package name, loads the built `lib/index.js`;
- a **local source overlay** (development) — `--patch` against `src/` for fast iteration.

### Install as a bundle

Add the bundle to a profile (Git install builds `lib/` automatically via `prepare`):

```sh
dsh plugin --profile demo add github:you/dsh-im-gateway
```

> A Git install fetches sources and runs `prepare` (esbuild) to emit `lib/index.js`.
> If your pnpm refuses the build permission, copy the package key pnpm prints into
> the profile's `pnpm-workspace.yaml` `allowBuilds:` block (see the DSH
> [publish docs](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish)).
> For built artifacts instead, run `pnpm pack` and `dsh plugin --profile demo add ./dsh-im-gateway-<version>.tgz`.

The bundle's layer is `cordis.patch.yml`, which inserts the `im-gateway` row with
sensible defaults. Override any key from your profile's own `cordis.patch.yml`
(a later layer wins per row and replaces the whole `config`, so restate every key).

### Load the local source overlay (development)

From the DSH repository root (after the run-from-source path), start the Web UI with this overlay:

```sh
pnpm dsh web --patch /path/to/dsh-im-gateway/cordis.yml
```

`cordis.yml` example:

```yaml
- insert:
    - id: im-gateway
      name: './src/index.ts'
      config:
        inboundPath: '/im'
        secret: 'change-me'
        chatIdField: 'chat_id'
        textField: 'text'
        senderField: 'sender_id'
        callbackUrl: 'https://your-im-bridge.example/reply'
        provider: 'deepseek'
        model: 'deepseek-chat'
```

### External IM → gateway (inbound)

POST messages to `http://<host>:<port>/im`:

```json
{ "chat_id": "group-42|user-7", "sender_id": "user-7", "text": "你好" }
```

> Send header `x-im-secret: <secret>` when `secret` is set. The gateway responds `202 { ok: true }` immediately; the reply arrives later over the callback.

### Gateway → external IM (outbound callback)

The collected reply is POSTed to `callbackUrl`:

```
POST <callbackUrl>
x-im-chat-id: group-42|user-7
x-im-secret: change-me

{ "chat_id": "group-42|user-7", "text": "<agent reply>", "ts": 1710000000000 }
```

---

## Development

The plugin is meant to be loaded **inside a running DeepSeek Harness**, which
already provides every `@deepseek-ai/*` package it needs (`cordis`, `dsh-llm`,
`dsh-session`, `dsh-agent`, `schemastery`). They are declared as **optional
peer dependencies**: do not install them yourself — resolve them from the DSH
runtime the plugin is loaded into.

### Build

The distributable bundle is built with **esbuild** (the only devDependency),
bundling `src/index.ts` into `lib/index.js` with every `@deepseek-ai/*` package
left external (they resolve from the host runtime):

```sh
pnpm build      # or: node scripts/build.mjs
```

`prepare` runs the same build automatically when the package is installed from
Git, so consumers always get a freshly built `lib/`. `lib/` is git-ignored.

### Type-checking

To type-check `src/` against the real DSH types, place (or link) this package
inside a DSH checkout so its `node_modules` resolve `@deepseek-ai/*`, then run:

```sh
pnpm typecheck   # or: npx tsc -p tsconfig.json --noEmit
```

`tsconfig.json` reads `@deepseek-ai/*` from `node_modules` exactly like any DSH
workspace package does — there are no hardcoded paths in this repository.

### Live load (end-to-end)

From your DSH repository root (run-from-source path), point `--patch` at this
repo's `cordis.yml`:

```sh
pnpm dsh web --patch /path/to/dsh-im-gateway/cordis.yml
```

Then send an inbound message:

```sh
curl -X POST http://127.0.0.1:8799/im \
  -H 'content-type: application/json' \
  -H 'x-im-secret: <your-secret>' \
  -d '{"chat_id":"some-chat","text":"你好"}'
```

The 202 acknowledgment is returned immediately; the agent's reply arrives later
over the configured callback URL.
