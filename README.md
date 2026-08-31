# dsh-im-gateway — DeepSeek Harness IM gateway plugin

A [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) (Cordis) plugin that bridges external IM platforms into Harness:

1. **Inbound** — a multi-channel gateway receives messages from external IM platforms.
2. **Bridge** — each message is injected into a **persistent Harness Agent** that is stably mapped to the external chat id (so a conversation keeps context across messages; separate chats stay isolated).
3. **Outbound** — the Agent's reply is collected from the session event stream and delivered back through the **same channel** that received it.

It ships both a **legacy single HTTP webhook** and a **multi-channel settings UI** ("IM 通道" in the DSH settings panel) covering six channel kinds — 微信 (clawbot), QQ (icqq bot), 邮箱 Email (SMTP/IMAP), 中国移动 5G消息 (WebSocket), 飞书 (official bot), and 通用 HTTP 回调.

---

## How it works

```
external IM  --POST-->  [channel transport (webhook / WS / IMAP / icqq / claw)]  --followup-->  [persistent Agent/session per chat]
      ^                                                                                            |
      |                                                                                            | session/event
      +-- <-- same channel delivers--  [collected reply]
```

- **Per-chat session**: `SessionId = im-<sha1(chat_id)[0:16]>`. The same external chat always reuses the same Agent (durable context); different chats never share one.
- **Reply delivery**: text blocks of each `assistant/message` session event (`@deepseek-ai/dsh-session`) are accumulated until the agent reaches quiescence (`agent.whenIdle()`), then delivered back through the receiving transport.

---

## Multi-channel IM management (settings UI)

In the DSH settings panel an **"IM 通道"** entry (pushed to the end of the left nav) opens a per-channel management UI. Each channel kind ships a **foolproof prefill template**, so fixed items are already correct and the user only fills in the cherry-picked key/token/account (or scans a QR):

| Type | Fixed items auto-filled | User provides | Transport |
| --- | --- | --- | --- |
| **微信** (clawbot) | `clawUrl` (`http://127.0.0.1:9001`) | token; scan companion QR | polling HTTP client of a clawbot companion gateway |
| **QQ** | — | (optional qq/password; scan QR to log in) | `icqq` bot (QR or password login) |
| **Email** | server/ports/TLS from chosen provider (QQ/163/Gmail/Outlook/企业微信/自定义) | account + 授权码/密码 | `nodemailer` (SMTP out) + `imapflow` (IMAP in) |
| **中国移动 5G消息** | `serverUrl` (`wss://…/ws/msg`), `version: 2.0` | apiKey | WebSocket `SmsClient` to the 5G 消息 gateway |
| **飞书** | — | App ID + App Secret | official `@larksuiteoapi/node-sdk` WebSocket long connection |
| **通用 HTTP** | `inboundPath` `/im`, field mapping (`chat_id`/`text`/`sender_id`) | callbackUrl + (optional) secret | shared inbound `node:http` webhook route |

Each enabled channel holds a **live connection** (`connected` / `connecting` / `error` / `idle`) that the host reports back to the UI through the `imGateway` RPC (`remote.define('imGateway', { list })`, polled by the client); the UI also shows the login **QR** for QQ/微信 scan-to-login and the connection error detail when present. Channel records live under the `im-channels` settings namespace, with secret fields (`apiKey`, `password`, `appSecret`, `token`, …) declared `role('secret')` — redacted on every wire boundary, only the host transports read them back from the settings scope.

> **Secrets**: keep real values out of Git. `.gitignore` already excludes `cordis.local.yml` / `.env*` and `lib/`; never commit an apiKey/appSecret/password to a channel record that ends up under version control.

---

## Files

| Path | Purpose |
| --- | --- |
| `src/config.ts` | Schemastery `Config` schema (legacy single-webhook tunables) |
| `src/inbound.ts` | Embedded `node:http` webhook server (routes by URL path) |
| `src/gateway.ts` | chat→agent mapping, message injection, reply collection + delivery |
| `src/session.ts` | Deterministic `im-<sha1(chat_id)>` session-key derivation |
| `src/index.ts` | Plugin entry (`name`/`inject`/`Config`/`apply` + lifecycle + `imGateway` RPC) |
| `src/channels/types.ts` | Channel type model + status (pure types, shared client/host) |
| `src/channels/schema.ts` | Host-side `im-channels` settings schema (SECRET fields via `role('secret')`) |
| `src/channels/manager.ts` | Per-channel connection lifecycle, transport build, live status snapshots |
| `src/transports/*.ts` | One real adapter per channel (http / email / cmcc / feishu / wechat / qq) |
| `src/client/*` | Browser half: settings section UI, foolproof templates, live status + QR |
| `cordis.yml` | Local source overlay (`--patch`) for development / e2e iteration |
| `cordis.patch.yml` | Published **bundle** layer — references the package by name (`dsh-im-gateway` → `lib/index.js`) |
| `scripts/build.mjs` | esbuild build: emits `lib/index.js` (node) + `lib/client.js` (browser) |
| `scripts/smoke.mts` | Local smoke test (session hashing, HTTP route, reply callback, CMCC failure) |
| `lib/` | Generated build output (git-ignored; produced by `prepare` on install) |
| `docs/channel-ui-design.md` | Design doc for the multi-channel settings UI |
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

### External IM → gateway (legacy HTTP webhook)

> The settings UI is the primary way to attach channels (see above). The legacy
> single HTTP webhook path below is retained for back-compat / headless setups.

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
