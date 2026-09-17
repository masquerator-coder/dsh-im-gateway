# dsh-im-gateway — DeepSeek Harness IM gateway plugin

A [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) (Cordis) plugin that bridges external IM platforms into Harness:

1. **Inbound** — a multi-channel gateway receives messages from external IM platforms.
2. **Bridge** — each message is injected into a **persistent Harness Agent** that is stably mapped to the external chat, so a conversation keeps context across messages while separate chats (and separate channels) stay isolated.
3. **Outbound** — the Agent's reply is collected from the global session-event stream by **rpcId claiming** and delivered back through the **same channel** that received it.

It ships both a **legacy single HTTP webhook** and a **multi-channel settings UI** ("IM 通道" in the DSH settings panel) covering six channel kinds — 微信 (ilink bot), QQ (官方 bot), 邮箱 Email (SMTP/IMAP), 中国移动 5G消息 (WebSocket), 飞书 (official bot), and 通用 HTTP 回调.

---

## How it works

```
external IM --POST--> [channel transport (webhook / WS / IMAP / QQ bot / ilink)] -> [workspace-attached Agent/session per chat]
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
- **Source metadata injection (on change)** — a `<dsh_im_source>{channel, senderId}</dsh_im_source>` block is prepended to the prompt **only when that source changes** for the session (its first message, or a different sender/channel), so the model still learns who/which channel asked while the block is not repeated on every bubble — the first one already remains in the replayed history. It is re-emitted when compaction shadows the span that carried it.
- **Bounded delivery retry** — a reply is pushed through the sink with up to 2 attempts; every failure is logged and a final give-up is explicitly logged `reply NOT delivered` (no silent loss).

### IM-side confirmations (approval / user-questions)

DSH's tool-approval (`approval/request`) and user-question (`user-questions/request`) are agent-scoped waterfall events. On every agent this gateway creates/resumes a **bridge answerer** is installed that pushes the prompt down the *same* IM channel driving that session and maps the user's textual reply back to the outcome the seam expects — so a 5G消息 / email / … user is asked over IM instead of only seeing a web dialog.

Ordering is load-bearing: in the `web` profile the `dsh-api-remotes` forwarder that feeds the browser answerer registers on the root context at startup, and Cordis waterfalls run listeners in **registration order** (scope filtering admits listeners, it does not reorder them). The bridge therefore registers with `prepend: true` so it heads the waterfall and the IM channel wins. Fallback: if the session has no reachable outbound sender (or the IM push fails) the bridge calls `next()` and **delegates to the web answerer** rather than fail-closing — an offline IM channel never wedges an approval a web user could answer. Pure web conversations are unaffected (only gateway-owned agents install the bridge).

---

## Multi-channel IM management (settings UI)

In the DSH **「插件 → 插件设置」** page an **"IM 通道设置"** card (styled like the other system plugin cards) expands on click to reveal the per-channel management UI. Each channel kind ships a **foolproof prefill template**, so fixed items are already correct and the user only fills in the cherry-picked key/token/account (or scans a QR):

| Type | Fixed items auto-filled | User provides | Transport |
| --- | --- | --- | --- |
| **微信** (wechat) | `baseUrl` (`https://ilinkai.weixin.qq.com`) | token (auto at bind); scan official ilink QR | direct client of Tencent's official ilink bot gateway (QR bind → getupdates poll → sendmessage) |
| **QQ** | `botApiBase` (`https://api.sgroup.qq.com`) | AppID + AppSecret (create bot at q.qq.com) | official QQ bot WebSocket gateway (`getAppAccessToken` → `api.sgroup.qq.com/gateway` → wss; C2C/group) |
| **Email** | server/ports/TLS from chosen provider (QQ/163/Gmail/Outlook/企业微信/自定义) | account + 授权码/密码 | `nodemailer` (SMTP out) + `imapflow` (IMAP in; 首次只处理最近 50 封) |
| **中国移动 5G消息** | `serverUrl` (`wss://…/ws/msg`), `version: 2.0` | apiKey | WebSocket `SmsClient` to the 5G 消息 gateway |
| **飞书** | — | App ID + App Secret | official Lark/Feishu SDK WebSocket long connection (**vendored** into `lib/vendor/` — see [Install](#install-as-a-bundle)) |
| **通用 HTTP** | `inboundPath` `/im`, field mapping (`chat_id`/`text`/`sender_id`) | callbackUrl + (optional) secret | shared inbound `node:http` webhook route |

Each enabled channel holds a **live connection** (`connected` / `connecting` / `error` / `idle`) that the host reports back to the UI over a **plugin-owned web route** — `GET /im-gateway/status` (registered with `ctx.webServer.register`, gated by the same browser-auth check as `/api`, `cache-control: no-store`), polled by the panel every 3s and paused while the document is hidden. The panel also renders the login **QR** for 微信 scan-to-login plus the connection detail when present.

> **为什么不是 `ctx.remote`**：DSH 的 `ctx.remote.<namespace>` 是 **Typert 生成** 的描述符投影 —— 浏览器侧只挂载 DSH 自带 assembly 里那份固定清单（`@deepseek-ai/dsh-api-remotes/client`），且拒绝任何没有 strict 生成 codec 的描述符（`requireStrictDescriptor`）。**树外插件无法发布 Remote namespace**，所以本插件改为注册一条同源 web 路由（也顺带复用守卫 `/api` 的浏览器鉴权 cookie）。

Channel records live under the `im-channels` settings namespace, with secret fields (`apiKey`, `password`, `appSecret`, `token`, …) declared `role('secret')` — redacted on every wire boundary, only the host transports read them back from the settings scope.

Every channel card exposes an **高级选项（接入控制 / 模型路由）** fold for the agent-routing fields shared with the legacy webhook: `allowlist` (one sender id per line — email address / QQ / phone / HTTP `sender_id`), `provider`, `model`, `maxTokens`, `cwd`, `agentPreset`, plus a 启用/停用 switch for the whole channel. These are applied **per channel instance**: two channels of the same kind (e.g. two `http` webhooks) never share an agent session even when their external `chat_id` collides, and a channel without its own `allowlist` allows all senders — it never inherits the legacy global webhook allowlist (whose sender-id semantics belong to that HTTP caller).

### 微信通道（直连官方 ilink 网关）

The WeChat channel is a **direct client of Tencent's official ilink bot gateway** (no local companion process needed), ported from the [dsh-clawbot](dsh-clawbot-main/) reference. Default gateway: `https://ilinkai.weixin.qq.com` (field `baseUrl`; keep default unless you self-host a gateway). Lifecycle:

1. **保存并启用**通道 → 面板显示官方登录二维码（`baseUrl` 预填，`token` 留空）。
2. **手机微信扫码**确认绑定 → ilink 下发 `bot_token`，自动持久化到 `~/.dsh/im-workspace/wechat-state/<channelId>.json`（跨重启复用，无需重复扫码）。
3. **在微信里给新出现的 bot 联系人发一条消息**解锁发送凭证 `context_token`。
4. 状态变为「已连接」后，绑定账号在微信里发的文本/语音转写会驱动 Agent，回复经同一 ilink 网关回送。

> **关于二维码怎么画出来的**：`get_bot_qrcode` 返回的 `qrcode_img_content` **不是图片**，而是一个 HTML 页面 URL（`https://liteapp.weixin.qq.com/q/...`，`content-type: text/html`）；那个页面自己用 `toCanvas(canvas, window.location.href)` 现画二维码，所以可扫的字符串就是该 URL 本身。面板因此**本地**用 `qrcode-generator` 把同一个 URL 编码成 SVG 二维码（`src/client/qr.ts`，自绘白底、4 模块静默区，暗色主题也能扫）；旁边保留「打开登录二维码」链接作为兜底。之前把它塞进 `<img src>` 只能渲染出一个破损图。

> **获取二维码失败会自动重试**：`requestQr` 无论抛异常还是返回不可用内容，都会把「获取二维码失败，正在重试…」写到状态行，并在未绑定期间每 10 秒重试一次——不会再出现「面板静静停在提示文案上」。

> **关于手动填 `token`**：`bot_token` 只是 ilink 网关凭证，**单独填它并不会连接微信**——绑定是「扫码 + 解锁发消息」两步完成的，`token` 在扫码确认后由网关自动填入。若通道只有 token 而没有完成绑定的微信账号（无 `scannedUser`），网关会**仍然显示登录二维码**并明确提示「已填写 token 但尚未绑定微信」，引导你扫码并发送一条消息完成绑定，而不是误报「已连接」。

> 边界（与参考实现一致）：ilink 网关对**主动发送严重限流**——这是通知/拍板渠道，不是聊天工具；`context_token` 只会在绑定账号先发一条消息后下发；收到 *转发* 的文章/文件收不到（需发原始链接）。绑定状态默认只发给绑定账号自己。

### QQ 通道（官方 QQ 开放平台机器人）

The QQ channel is a **direct client of the official QQ Open Platform robot gateway** — create a robot at [q.qq.com](https://q.qq.com), copy its **AppID + AppSecret**, and this transport handles the **official WebSocket gateway**: `POST https://bots.qq.com/app/getAppAccessToken` → `GET {botApiBase}/gateway` → connect the returned `wss://...` (IDENTIFY + heartbeat) to receive `C2C_MESSAGE_CREATE` / `GROUP_AT_MESSAGE_CREATE`, and posts replies to `api.sgroup.qq.com/v2/users|groups/{openid}/messages`.

- Default gateway `botApiBase`: `https://api.sgroup.qq.com` (预填). `sandbox` toggle switches to `https://sandbox.api.sgroup.qq.com`.
- AppID is non-secret; **AppSecret** is a `role('secret')` field (reuses the feishu `appSecret` field).
- **边界**：群 / C2C 能力需在 q.qq.com 提审开通，未过审时接口报权限错误属正常；C2C/群消息为**被动回复**（需先用 `msg_id` 引用，无主动推送）；AppSecret 是机密，勿提交进 Git。

> **Secrets**: keep real values out of Git. `.gitignore` already excludes `cordis.local.yml` / `.env*`; never commit an apiKey/appSecret/password to a channel record that ends up under version control.

---

## Files

| Path | Purpose |
| --- | --- |
| `src/config.ts` | Schemastery `Config` schema (legacy single-webhook tunables, incl. `allowlist`) |
| `src/inbound.ts` | Embedded `node:http` webhook server (routes by URL path; acks `202` only after `handle()` resolves) |
| `src/gateway.ts` | Workspace-attached session composition, rpcId reply claiming, allowlist / dedup / serialization / source injection / delivery retry |
| `src/session.ts` | Deterministic channel-scoped `im-<sha1(channel:chat_id)>` session-key derivation |
| `src/index.ts` | Plugin entry (`name`/`inject`/`Config`/`apply` + lifecycle + `GET /im-gateway/status` route) |
| `src/status-proto.ts` | Host↔client wire contract for live channel status (dependency-free; why a route, not a Remote namespace) |
| `src/status-route.ts` | The status route handler (payload projection, browser-auth gate, method guard) |
| `src/channels/types.ts` | Channel type model + status (pure types, shared client/host) |
| `src/channels/schema.ts` | Host-side `im-channels` settings schema (SECRET fields via `role('secret')`) |
| `src/channels/manager.ts` | Per-channel connection lifecycle, transport build, live status snapshots |
| `src/transports/*.ts` | One real adapter per channel (http / email / cmcc / feishu / wechat / qq / qqbot), each tags its runtime with `channel` |
| `src/client/*` | Browser half: expandable plugin card (`ChannelsCard`) wrapping the channel management UI (`ChannelsSection`), foolproof templates, live status + locally-encoded QR (`qr.ts`) |
| `cordis.yml` | Local source overlay (`--patch`) for development / e2e iteration |
| `cordis.patch.yml` | Published **bundle** layer — references the package by name (`dsh-im-gateway` → `lib/index.js`) |
| `scripts/build.mjs` | esbuild build: emits `lib/index.js` (node) + `lib/client.js` (browser) + `lib/vendor/lark-sdk.cjs` (vendored Feishu SDK) |
| `scripts/check-install-scripts.mjs` | Build guard: fails if any *runtime* dependency (transitively) ships an install-time script |
| `scripts/smoke.mts` | Local smoke test (session hashing, HTTP route, reply callback, CMCC failure, vendored Feishu SDK) |
| `lib/` | **Committed** build output — no `prepare`; git installs mount it as-is. Rebuild & commit together with every `src/` change |
| `lib/vendor/lark-sdk.cjs` | **Committed** vendored third-party (Feishu SDK, MIT) — generated by `scripts/build.mjs`, never edited by hand |
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

> **No `allowBuilds` entry is needed — on this machine or on any sharee's.**
> pnpm ≥ 10 refuses to run an unapproved *dependency* build script and exits
> non-zero, which `dsh plugin` reports as a failed install ("add the exact key
> pnpm printed above under allowBuilds in …"), so one stray `postinstall`
> anywhere in the runtime dependency closure would break the one-command install
> for every user. This package therefore guarantees that closure is empty of
> them: the Feishu SDK — whose hard dependency `protobufjs` ships a purely
> cosmetic `postinstall` — is **vendored** into `lib/vendor/lark-sdk.cjs`
> instead of being installed, and `pnpm build` runs
> `scripts/check-install-scripts.mjs`, which fails the build the moment any
> runtime dependency (transitively) gains a `preinstall`/`install`/`postinstall`
> script. Verified by installing this package on a clean profile with no
> `allowBuilds` section at all: `pnpm` exits 0.
> **Contributor rule:** because `lib/` is committed, every `src/` change must ship
> with its rebuilt `lib/` (`pnpm build` then commit) — otherwise the distributed
> version runs a stale bundle.
> For a single-file artifact instead of a Git install, run `pnpm pack` and
> `dsh plugin --profile demo add ./dsh-im-gateway-<version>.tgz`.

> **Upgrading from a version that needed `allowBuilds`?** If an earlier install
> failure already wrote a `protobufjs:` placeholder into your profile's
> `pnpm-workspace.yaml` (`C:\Users\<you>\.dsh\profiles\<profile>\pnpm-workspace.yaml`),
> delete that line — `protobufjs` is no longer part of the dependency tree — and
> re-run the `add` command.

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
pnpm build          # build.mjs (3 artifacts) + the install-script guard
pnpm check:deps     # guard alone: scan the runtime dependency closure
```

`pnpm build` emits three committed artifacts and then verifies the install story:

| Artifact | What it is |
| --- | --- |
| `lib/index.js` | node half — the Cordis plugin entry (`@deepseek-ai/*`, `ws`, `nodemailer`, `imapflow`, `mailparser` stay external) |
| `lib/client.js` | browser half — the DSH client-module bundle |
| `lib/vendor/lark-sdk.cjs` | the **vendored** Feishu/Lark SDK (bundled + minified from the published `@larksuiteoapi/node-sdk` devDependency, protobufjs inlined, upstream MIT text in the header) |

**Why the Feishu SDK is vendored.** `@larksuiteoapi/node-sdk` hard-depends on
`protobufjs`, whose `postinstall` script (it only prints a version-scheme
warning) makes pnpm abort an install with `ERR_PNPM_IGNORED_BUILDS` unless the
*consumer* allowlists it — and `dsh plugin` turns that non-zero exit into a
failed install with a "hand-edit your profile's `pnpm-workspace.yaml`"
instruction. Since the published SDK dist is already a self-contained bundle
(its only runtime `require` is `protobufjs/minimal`), vendoring it once here
removes the package — and every other install-time script — from the tree that
consumers install. To upgrade it, bump the `@larksuiteoapi/node-sdk`
devDependency, run `pnpm build`, and commit the regenerated
`lib/vendor/lark-sdk.cjs` (the version is recorded in its header). The transport
loads it lazily from a computed path (`src/transports/feishu.ts`), so the node
half never inlines it and plugin startup never pays for it.

The committed `lib/` is what consumers load from a Git install. There is **no**
`prepare` script — a Git install does not build anything. **Rebuild and commit
`lib/` together with every `src/` change** so the distributed bundle stays
current; `pnpm check:deps` must stay green, because a single transitive
install-time script silently breaks `dsh plugin add` for everyone.

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
