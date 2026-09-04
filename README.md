# dsh-im-gateway — DeepSeek Harness IM gateway plugin

A [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) (Cordis) plugin that bridges external IM platforms into Harness:

1. **Inbound** — a multi-channel gateway receives messages from external IM platforms.
2. **Bridge** — each message is injected into a **persistent Harness Agent** that is stably mapped to the external chat, so a conversation keeps context across messages while separate chats (and separate channels) stay isolated.
3. **Outbound** — the Agent's reply is collected from the global session-event stream by **rpcId claiming** and delivered back through the **same channel** that received it.

It ships both a **legacy single HTTP webhook** and a **multi-channel settings UI** ("IM 通道" in the DSH settings panel) covering six channel kinds — 微信 (clawbot), QQ (icqq bot), 邮箱 Email (SMTP/IMAP), 中国移动 5G消息 (WebSocket), 飞书 (official bot), and 通用 HTTP 回调.

---

## How it works

```
external IM --POST--> [channel transport (webhook / WS / IMAP / icqq / claw)] -> [workspace-attached Agent/session per chat]
     ^                                                                                              |
     |                                                                                global session/event stream (rpcId claim)
     +-- <-- same channel delivers (bounded retry) <-- [collected reply]
```

Agents are composed **exactly like the DSH webhook / session-controller path**:

- **Real workspace attach** — every session is attached to a real Harness workspace (an explicit `cwd`, else the plugin's `~/.dsh/im-workspace`), so the stable id resolves a durable session instead of colliding with a persisted `_no-cwd` log.
- **Webhook-aligned composition** — `installModelSelection` picks the channel's explicit provider/model, else the **DSH runtime's currently-active model** (`agentDefaultModel.currentSelection()`); the configured agent preset is mounted, the deployment default **permission preset** is pinned, and a stable session title is set.
- **Cross-restart continuation** — on a restarted process, an existing stable session is probed via `sessionQuery.observeSession` and **resumed** with `agents.resume(...)`; only brand-new ids go through `agents.create(...)`. Restarting never re-creates or collides with an already-persisted chats.
- **rpcId reply claiming** — each inbound user message carries an opaque `rpcId` on its source; a per-turn waiter subscribes to the **global** `session/event` stream and claims exactly that prompt's `user/message → assistant/message → turn/end` sequence (race-immune, no `whenIdle()` polling).

### Session keying & isolation

- Every chat maps to a stable session id: `SessionId = im-<sha1(f"{channel}:{chat_id}")[0:16]>`.
- The **receiving channel** is part of the key, so the same external chat id arriving through two different channels (e.g. email vs cmcc) never shares a session (isolation mirrors dsh-im-main's `ConversationRoute`). An empty namespace keeps the historical chatId-only key for callers that predate multi-channel.
- The same `channel + chat_id` always reuses the same Agent (durable context); different chats are never shared.

### Built-in gateway safeguards

- **Sender access control** — when `allowlist` is configured, only those `senderId`s may drive the agent; unauthorized (or sender-less) messages are **denied before any agent/workspace/model side effect**. Empty allowlist = allow all (rely on `secret` / private network).
- **Inbound de-duplication** — an identical `chat + text` replayed/echoed within 5s is suppressed, so a platform replay never double-triggers a model turn.
- **Per-session serialization** — at most one in-flight turn per chat: concurrent messages queue on a per-session tail instead of overwriting each other's reply claim.
- **Source metadata injection** — when present, a `<dsh_im_source>{channel, senderId}</dsh_im_source>` block is prepended to the prompt so the model knows which channel/sender asked.
- **Bounded delivery retry** — a reply is pushed through the sink with up to 2 attempts; every failure is logged and a final give-up is explicitly logged `reply NOT delivered` (no silent loss).

---

## Multi-channel IM management (settings UI)

In the DSH **「插件 → 插件设置」** page an **"IM 通道设置"** card (styled like the other system plugin cards) expands on click to reveal the per-channel management UI. Each channel kind ships a **foolproof prefill template**, so fixed items are already correct and the user only fills in the cherry-picked key/token/account (or scans a QR):

| Type | Fixed items auto-filled | User provides | Transport |
| --- | --- | --- | --- |
| **微信** (clawbot) | `clawUrl` (`http://127.0.0.1:9001`) | token; scan companion QR | polling HTTP client of a clawbot companion gateway |
| **QQ** | — | (optional qq/password; scan QR to log in) | `icqq` bot (QR or password login) |
| **Email** | server/ports/TLS from chosen provider (QQ/163/Gmail/Outlook/企业微信/自定义) | account + 授权码/密码 | `nodemailer` (SMTP out) + `imapflow` (IMAP in; 首次只处理最近 50 封) |
| **中国移动 5G消息** | `serverUrl` (`wss://…/ws/msg`), `version: 2.0` | apiKey | WebSocket `SmsClient` to the 5G 消息 gateway |
| **飞书** | — | App ID + App Secret | official `@larksuiteoapi/node-sdk` WebSocket long connection |
| **通用 HTTP** | `inboundPath` `/im`, field mapping (`chat_id`/`text`/`sender_id`) | callbackUrl + (optional) secret | shared inbound `node:http` webhook route |

Each enabled channel holds a **live connection** (`connected` / `connecting` / `error` / `idle`) that the host reports back to the UI through the `imGateway` RPC (`remote.define('imGateway', { list })`, polled by the client); the UI also shows the login **QR** for QQ/微信 scan-to-login and the connection error detail when present. Channel records live under the `im-channels` settings namespace, with secret fields (`apiKey`, `password`, `appSecret`, `token`, …) declared `role('secret')` — redacted on every wire boundary, only the host transports read them back from the settings scope.

Every channel card exposes an **高级选项（接入控制 / 模型路由）** fold for the agent-routing fields shared with the legacy webhook: `allowlist` (one sender id per line — email address / QQ / phone / HTTP `sender_id`), `provider`, `model`, `maxTokens`, `cwd`, `agentPreset`, plus a 启用/停用 switch for the whole channel. These are applied **per channel instance**: two channels of the same kind (e.g. two `http` webhooks) never share an agent session even when their external `chat_id` collides, and a channel without its own `allowlist` allows all senders — it never inherits the legacy global webhook allowlist (whose sender-id semantics belong to that HTTP caller).

> **Secrets**: keep real values out of Git. `.gitignore` already excludes `cordis.local.yml` / `.env*` and `lib/`; never commit an apiKey/appSecret/password to a channel record that ends up under version control.

---

## Files

| Path | Purpose |
| --- | --- |
| `src/config.ts` | Schemastery `Config` schema (legacy single-webhook tunables, incl. `allowlist`) |
| `src/inbound.ts` | Embedded `node:http` webhook server (routes by URL path; acks `202` only after `handle()` resolves) |
| `src/gateway.ts` | Workspace-attached session composition, rpcId reply claiming, allowlist / dedup / serialization / source injection / delivery retry |
| `src/session.ts` | Deterministic channel-scoped `im-<sha1(channel:chat_id)>` session-key derivation |
| `src/index.ts` | Plugin entry (`name`/`inject`/`Config`/`apply` + lifecycle + `imGateway` RPC) |
| `src/channels/types.ts` | Channel type model + status (pure types, shared client/host) |
| `src/channels/schema.ts` | Host-side `im-channels` settings schema (SECRET fields via `role('secret')`) |
| `src/channels/manager.ts` | Per-channel connection lifecycle, transport build, live status snapshots |
| `src/transports/*.ts` | One real adapter per channel (http / email / cmcc / feishu / wechat / qq), each tags its runtime with `channel` |
| `src/client/*` | Browser half: expandable plugin card (`ChannelsCard`) wrapping the channel management UI (`ChannelsSection`), foolproof templates, live status + QR |
| `cordis.yml` | Local source overlay (`--patch`) for development / e2e iteration |
| `cordis.patch.yml` | Published **bundle** layer — references the package by name (`dsh-im-gateway` → `lib/index.js`) |
| `scripts/build.mjs` | esbuild build: emits `lib/index.js` (node) + `lib/client.js` (browser) |
| `scripts/smoke.mts` | Local smoke test (session hashing, HTTP route, reply callback, CMCC failure) |
| `lib/` | **Committed** build output — no `prepare`; git installs mount it as-is. Rebuild & commit together with every `src/` change |
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
| `senderField` | `sender_id` | Optional body field for the sender id (used by allowlist + source injection) |
| `allowlist` | `[]` | Sender allowlist (access control). Non-empty ⇒ only these `senderId`s may drive the agent; others / sender-less are denied up front |
| `callbackUrl` | *(required)* | URL the reply is POSTed to |
| `callbackChatHeader` | `x-im-chat-id` | Header holding the chat id on the callback |
| `callbackSecretHeader` | `x-im-secret` | Header holding the secret on the callback |
| `provider` | `''` | Model provider route override (empty = runtime default model) |
| `model` | `''` | Model id override (empty = runtime default model) |
| `maxTokens` | `0` | Positive output cap, or 0 for default |
| `agentPreset` | `''` | Optional agent preset applied on creation |
| `cwd` | `''` | Optional working directory for the Agent session (a real Harness workspace) |
| `disposeAfterReply` | `false` | Dispose the Agent after each reply (frees resources, drops context) |

> ⚠️ Only `host`/`port`/`inboundPath`/`chatIdField`/`textField`/`senderField`/`allowlist`/`callbackChatHeader`/`callbackSecretHeader`
> and the checkbox-like fields are non-sensitive wiring. **`secret` and `callbackUrl` are deployment secrets** —
> never commit real values. Keep your `cordis.yml` secret in `.env`/local overrides and out of the repository.

---

## Security

- **Inbound auth**: set `secret` so the webhook only accepts requests carrying
  `x-im-secret: <secret>`. Leave it empty only when the endpoint is firewalled
  and the upstream IM platform is the sole caller.
- **Sender access control**: set `allowlist` (per-channel) so only known senders
  can drive the agent. Unauthorized (or sender-less) messages are denied before
  any agent/workspace/model side effect.
- **Inbound hardening**: the shared webhook caps request bodies at 1 MiB (413)
  and limits concurrent connections; secret checks are constant-time; internal
  error details are logged but never returned in 5xx responses.
- **Outbound timeouts**: every reply callback / companion HTTP call carries an
  `AbortSignal.timeout`, so a black-holed endpoint cannot wedge a chat's
  serialized turn for the undici default duration.
- **Secrets management**: keep the real `secret` and `callbackUrl` out of Git.
  This repo ships `secret: ''` and a loopback placeholder `callbackUrl` only.
  Create a `.env`-backed or local-only `cordis.yml` overlay for real values.
- **Agent access**: the plugin creates a persistent, workspace-attached Harness
  Agent per external chat. Gate the endpoint with `secret` + `allowlist` and/or
  put it behind a private network — otherwise anyone who can reach it can drive
  the underlying agent (and its model cost).

---

## Usage

The plugin ships in **two interchangeable forms**:

- a **bundle** (recommended for deployment) — installed by package name, loads the built `lib/index.js`;
- a **local source overlay** (development) — `--patch` against `src/` for fast iteration.

### Install as a bundle

Add the bundle to a profile. The built `lib/` is **committed**, and the package has
no `prepare`/`postinstall` script, so nothing runs on install:

```sh
dsh plugin --profile demo add github:you/dsh-im-gateway
```

> No build scripts run on a Git install, so **no `allowBuilds` entry is needed** —
> on this machine or on any sharee's. Just install and load.
> **Contributor rule:** because `lib/` is committed, every `src/` change must ship
> with its rebuilt `lib/` (`pnpm build` then commit) — otherwise the distributed
> version runs a stale bundle.
> For a single-file artifact instead of a Git install, run `pnpm pack` and
> `dsh plugin --profile demo add ./dsh-im-gateway-<version>.tgz`.

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
        allowlist: ['user-7']
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

> Send header `x-im-secret: <secret>` when `secret` is set. The gateway responds `202 { ok: true }` **immediately** once the message is accepted — it does not wait for the model turn. The agent reply always arrives later over the callback (see below).
> When `allowlist` is set and `sender_id` is not in it (or missing), the message is denied up front (a `202` is still returned) — no agent turn, no reply.

### Gateway → external IM (outbound callback)

The collected reply is POSTed to `callbackUrl` (with up to 2 delivery attempts; a give-up is logged `reply NOT delivered`):

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

The committed `lib/` is what consumers load from a Git install. There is **no**
`prepare` script — a Git install does not build anything (which is exactly why
it needs no `allowBuilds` entry on any machine). **Rebuild and commit `lib/`
together with every `src/` change** so the distributed bundle stays current.

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
  -d '{"chat_id":"some-chat","sender_id":"user-7","text":"你好"}'
```

The 202 acknowledgment is returned immediately; the agent's reply arrives later
over the configured callback URL. Because the session is workspace-attached and
resumed by stable id, restarting the DSH process and sending another message at
the same `chat_id` continues the same conversation without an id collision.
