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

- Every chat maps to a stable session id: `SessionId = im-<sha1(f"{channel}:{chat_id}")[0:16]>`, or `im-<sha1(f"{channel}:{chat_id}@{cwd}")[0:16]>` when an **explicitly configured working directory** applies (a channel's own `cwd`, or the settings card's 全局默认工作目录).
- The **receiving channel** is part of the key, so the same external chat id arriving through two different channels (e.g. email vs cmcc) never shares a session (isolation mirrors dsh-im-main's `ConversationRoute`). An empty namespace keeps the historical chatId-only key for callers that predate multi-channel.
- The **working directory** is part of the key because a DSH session's `cwd` is pinned when the session is created: `agents.resume` restores the persisted header (`ResumeAgentOptions` has no `cwd`), and `workspaceRegistry` refuses to attach a session whose header cwd differs from the workspace path. A conversation therefore lives in one workspace for its whole life, and pointing a channel at another directory **starts a new conversation there** — the old session stays in its old workspace (still openable in the Web UI). Silently resuming the old one is what used to make a changed working directory look ignored. The key is unchanged (and every existing IM session keeps its id) when no directory is configured: `cordis.yml`'s `cwd` stays a pure deployment fallback and does not scope the identity.
- The same `channel + chat_id` (+ the same working directory) always reuses the same Agent (durable context); different chats are never shared.

### Built-in gateway safeguards

- **Sender access control** — when `allowlist` is configured, only those `senderId`s may drive the agent; unauthorized (or sender-less) messages are **denied before any agent/workspace/model side effect**. Empty allowlist = allow all (rely on `secret` / private network).
- **Inbound de-duplication** — an identical `chat + text` replayed/echoed within 5s is suppressed, so a platform replay never double-triggers a model turn.
- **Per-session serialization** — at most one in-flight turn per chat: concurrent messages queue on a per-session tail instead of overwriting each other's reply claim.
- **Source metadata injection (on change)** — a `<dsh_im_source>{channel, senderId}</dsh_im_source>` block is prepended to the prompt **only when that source changes** for the session (its first message, or a different sender/channel), so the model still learns who/which channel asked while the block is not repeated on every bubble — the first one already remains in the replayed history. It is re-emitted when compaction shadows the span that carried it.
- **Bounded delivery retry** — a reply is pushed through the sink with up to 2 attempts; every failure is logged and a final give-up is explicitly logged `reply NOT delivered` (no silent loss).
- **Live-session reuse (never fight another owner)** — an Agent/Session is single-writer in the host. When the same session is already live elsewhere (the typical case: **the operator has that IM session open in the Web UI**), `resume` cannot take write ownership and `create` cannot re-enter the id — both fail. The gateway therefore reuses the live agent when the host already has one (`ctx.agents.get`, exactly like DSH's `createOrAdopt`) and never disposes an agent it did not create. Without this, opening the session in the browser silently muted the chat: the transport kept polling, reported itself connected, and every inbound message was dropped with nothing but a host-log warning.
- **Failures are never silent** — a turn that cannot reply (agent acquisition error, acquisition timeout, model error, empty reply, delivery failure) is reported **back down the same chat** (`⚠️ 处理失败，未能回复。原因：…`) and reflected in that channel's status line, so a "已连接 but 永远不回复" channel becomes a visible, actionable error. Agent acquisition is bounded (`60s`), because an unbounded wait there used to pin the chat's serialization tail for ever and drop every later message behind it.
- **Honest connection state** — the WeChat transport's only liveness signal is the `getupdates` round trip: 10 consecutive failures (~15 s) demote the channel from `connected` to `error` with the reason, and the next success restores `connected`. A revoked session (`errcode -14`) is reported on **any** round trip, not just the first. The CMCC socket gets an independent watchdog (socket state + ping/pong freshness) so a half-open socket after a sleep/network change is force-reconnected instead of staying silently "connected". The QQ gateway is held to the same rule: `start()` only succeeds once the gateway answered IDENTIFY/RESUME with READY/RESUMED, an un-retryable close code (`4013`/`4014`/`4914`/`4915`) is surfaced in Chinese with the fix and **stops the reconnect loop** instead of looping for ever, and a socket that stops answering heartbeats is force-reconnected (see [QQ 通道](#qq-通道官方-qq-开放平台机器人)).

### IM-side confirmations (approval / user-questions)

DSH's tool-approval (`approval/request`) and user-question (`user-questions/request`) are agent-scoped waterfall events. On every agent this gateway creates/resumes a **bridge answerer** is installed that pushes the prompt down the *same* IM channel driving that session and maps the user's textual reply back to the outcome the seam expects — so a 5G消息 / email / … user is asked over IM instead of only seeing a web dialog.

Ordering is load-bearing: in the `web` profile the `dsh-api-remotes` forwarder that feeds the browser answerer registers on the root context at startup, and Cordis waterfalls run listeners in **registration order** (scope filtering admits listeners, it does not reorder them). The bridge therefore registers with `prepend: true` so it heads the waterfall and the IM channel wins. Fallback: if the session has no reachable outbound sender (or the IM push fails) the bridge calls `next()` and **delegates to the web answerer** rather than fail-closing — an offline IM channel never wedges an approval a web user could answer. Pure web conversations are unaffected (only gateway-owned agents install the bridge).

---

## Multi-channel IM management (settings UI)

In the DSH **「插件 → 插件设置」** page an **"IM 通道设置"** card (styled like the other system plugin cards) expands on click to reveal the per-channel management UI. Each channel kind ships a **foolproof prefill template**, so fixed items are already correct and the user only fills in the cherry-picked key/token/account (or scans a QR):

| Type | Fixed items auto-filled | User provides | Transport |
| --- | --- | --- | --- |
| **微信** (wechat) | `baseUrl` (`https://ilinkai.weixin.qq.com`) | 什么也不用填：扫码绑定（`bot_token` 由网关下发并落盘） | direct client of Tencent's official ilink bot gateway (QR bind → getupdates poll → sendmessage) |
| **QQ** | `botApiBase` (`https://api.bot.qq.com`) | AppID + AppSecret (create bot at q.qq.com) | official QQ bot WebSocket gateway (`getAppAccessToken` → `/gateway` → wss; C2C/群聊 + 公域频道@) |
| **Email** | server/ports/TLS from chosen provider (QQ/163/Gmail/Outlook/企业微信/自定义) | account + 授权码/密码 | `nodemailer` (SMTP out) + `imapflow` (IMAP in; 首次只处理最近 50 封) |
| **中国移动 5G消息** | `serverUrl` (`wss://…/ws/msg`), `version: 2.0` | apiKey | WebSocket `SmsClient` to the 5G 消息 gateway |
| **飞书** | — | App ID + App Secret | official Lark/Feishu SDK WebSocket long connection (**vendored** into `lib/vendor/` — see [Install](#install-as-a-bundle)) |
| **通用 HTTP** | `inboundPath` `/im`, field mapping (`chat_id`/`text`/`sender_id`) | callbackUrl + (optional) secret | shared inbound `node:http` webhook route |

Each enabled channel holds a **live connection** (`connected` / `connecting` / `error` / `idle`) that the host reports back to the UI over a **plugin-owned web route** — `GET /im-gateway/status` (registered with `ctx.webServer.register`, gated by the same browser-auth check as `/api`, `cache-control: no-store`), polled by the panel every 3s and paused while the document is hidden. The panel also renders the login **QR** for 微信 scan-to-login plus the connection detail when present. The payload carries a `bound` flag for kinds that have a bind state: once WeChat is bound the panel shows 「已绑定微信，无需再扫码」 instead of the generic "a QR appears here" hint, so a finished pairing cannot look like a broken panel.

> **为什么不是 `ctx.remote`**：DSH 的 `ctx.remote.<namespace>` 是 **Typert 生成** 的描述符投影 —— 浏览器侧只挂载 DSH 自带 assembly 里那份固定清单（`@deepseek-ai/dsh-api-remotes/client`），且拒绝任何没有 strict 生成 codec 的描述符（`requireStrictDescriptor`）。**树外插件无法发布 Remote namespace**，所以本插件改为注册一条同源 web 路由（也顺带复用守卫 `/api` 的浏览器鉴权 cookie）。

Channel records live under the `im-channels` settings namespace, with secret fields (`apiKey`, `password`, `appSecret`, `token`, …) declared `role('secret')` — redacted on every wire boundary, only the host transports read them back from the settings scope.

Every channel card exposes an **高级选项（接入控制 / 模型路由）** fold for the agent-routing fields shared with the legacy webhook: `allowlist` (one sender id per line — email address / QQ / phone / HTTP `sender_id`), `provider`, `model`, `maxTokens`, `cwd`, `agentPreset`, plus a 启用/停用 switch for the whole channel. These are applied **per channel instance**: two channels of the same kind (e.g. two `http` webhooks) never share an agent session even when their external `chat_id` collides, and a channel without its own `allowlist` allows all senders — it never inherits the legacy global webhook allowlist (whose sender-id semantics belong to that HTTP caller).

Above the two columns the card carries one **section-level** field, **全局默认工作目录** (`im-channels.cwd`): the working directory (a real Harness workspace, holding the session log and giving the agent its file scope) used by every channel that has no `cwd` of its own — a channel's own `cwd` always wins. Resolution order per inbound message: **通道 `cwd` → 设置页全局默认 → `cordis.yml` 的 `cwd` → `~/.dsh/im-workspace`**. It is read when the message arrives, so saving it applies to the next message on every channel **without reconnecting anything**; only a change to a channel's *own* record restarts that channel (an unrelated save no longer bounces every enabled connection).

Because a DSH session's `cwd` is pinned at creation (and the workspace registry refuses to attach a session whose header cwd differs), a changed working directory **starts a new conversation in the new directory** on that chat's next message: the old session stays in its old workspace and remains openable in the Web UI, while the chat continues with a fresh context in the directory you configured (see [Session keying](#session-keying--isolation)). A chat that never configured a directory keeps its session id, so nothing is reset by the upgrade itself.

### 微信通道（直连官方 ilink 网关）

The WeChat channel is a **direct client of Tencent's official ilink bot gateway** (no local companion process needed), ported from the [dsh-clawbot](dsh-clawbot-main/) reference. Default gateway: `https://ilinkai.weixin.qq.com` (field `baseUrl`; keep default unless you self-host a gateway). Lifecycle:

1. **保存并启用**通道 → 面板在「接入步骤」正下方显示官方登录二维码（`baseUrl` 已预填，**面板不提供 Token 输入框**）。
2. **手机微信扫码**确认绑定 → ilink 下发 `bot_token`，自动持久化到 `~/.dsh/im-workspace/wechat-state/<channelId>.json`（跨重启复用，无需重复扫码）。
3. **在微信里给新出现的 bot 联系人发一条消息**解锁发送凭证 `context_token`。
4. 状态变为「已连接」后，绑定账号在微信里发的文本/语音转写会驱动 Agent，回复经同一 ilink 网关回送。

> **关于二维码怎么画出来的**：`get_bot_qrcode` 返回的 `qrcode_img_content` **不是图片**，而是一个 HTML 页面 URL（`https://liteapp.weixin.qq.com/q/...`，`content-type: text/html`）；那个页面自己用 `toCanvas(canvas, window.location.href)` 现画二维码，所以可扫的字符串就是该 URL 本身。面板因此**本地**用 `qrcode-generator` 把同一个 URL 编码成 SVG 二维码（`src/client/qr.ts`，自绘白底、4 模块静默区，暗色主题也能扫）；旁边保留「打开登录二维码」链接作为兜底。之前把它塞进 `<img src>` 只能渲染出一个破损图。

> **获取二维码失败会自动重试**：`requestQr` 无论抛异常还是返回不可用内容，都会把「获取二维码失败，正在重试…」写到状态行，并在未绑定期间每 10 秒重试一次——不会再出现「面板静静停在提示文案上」。

> **「已连接」是可证伪的**：绑定通道的存活信号就是 `getupdates` 往返。连续 10 次失败（约 15 秒）会把状态从「已连接」降级为错误并写明原因（`与微信网关通信失败（连续 N 次），正在重试`），下一次成功再自动回到「已连接」；会话被吊销（`errcode -14`）在**任何**一次往返都会立刻报错，而不是只在首次连接时检查一次。所以「面板说已连接，但发消息不回复」现在只有两种可能：入站没到（状态栏会说话），或者失败原因会**直接回发到微信**（见 [Gateway safeguards](#built-in-gateway-safeguards)）。

> **一个会话同时只能有一个写入者**：如果你在 Web 界面里打开着这个 IM 会话，宿主里它已经是 live 会话。插件会**复用**那个 live agent（与 DSH 自己的 `createOrAdopt` 同一规则），而不是去 resume/抢写锁；抢锁失败在旧版本里是静默的，现象正是「微信发消息不回复」。另外插件永不 dispose 不是自己创建的 agent。

> **面板为什么没有 Token 输入框**：`bot_token` 只是 ilink 网关凭证，**单独拥有它并不会连接微信**——绑定是「扫码 + 解锁发消息」两步完成的，`token` 在扫码确认后由网关下发、由宿主写入 `wechat-state/`。所以它不该由用户填写（早先的版本逼着用户粘贴，反而把常见的误解坐实了）。通道记录里的 `token` 字段仍然保留：手工编辑 `settings.yaml` 预置凭证这条路径还在，宿主会优先使用 `wechat-state/` 里的绑定结果。若通道只有 token 而没有绑定微信账号（无 `scannedUser`），网关会**仍然显示登录二维码**并提示「已填写 token 但尚未绑定微信」，而不是误报「已连接」。

> 边界（与参考实现一致）：ilink 网关对**主动发送严重限流**——这是通知/拍板渠道，不是聊天工具；`context_token` 只会在绑定账号先发一条消息后下发；收到 *转发* 的文章/文件收不到（需发原始链接）。绑定状态默认只发给绑定账号自己。

### QQ 通道（官方 QQ 开放平台机器人）

The QQ channel is a **direct client of the official QQ Open Platform robot gateway** — create a robot at [q.qq.com](https://q.qq.com), copy its **AppID + AppSecret**, and this transport handles the official WebSocket gateway: `POST https://api.bot.qq.com/app/getAppAccessToken` → `GET {botApiBase}/gateway` → connect the returned `wss://…` (Hello → IDENTIFY/RESUME → heartbeat) to receive `C2C_MESSAGE_CREATE` / `GROUP_AT_MESSAGE_CREATE` / `AT_MESSAGE_CREATE`, and posts replies to `{botApiBase}/v2/users|groups/{openid}/messages`.

**从零到能用（最短路径）**

1. 在 [q.qq.com](https://q.qq.com) 创建机器人，记下 **AppID / AppSecret**（开发设置里）。
2. 申请所需能力：**单聊 / 群聊**（这是「在 QQ 里跟机器人对话」的前提），提交审核。**未通过前连接会被网关拒绝**——插件会把拒绝原因原样显示在面板上（见下）。
3. 面板「IM 通道设置 → QQ」新建通道，填 AppID + AppSecret，保存启用。状态变「已连接」即代表 WebSocket 已 READY。
4. 在 QQ 里给机器人发消息（单聊直接发；群聊需 @ 机器人），Agent 的回复经同一网关回送。
5. 先验证链路而**不经过宿主**：`pnpm qq-probe <appId> <appSecret>`（见 [QQ 真机探针](#qq-真机探针)）。

- Default API base `botApiBase`: `https://api.bot.qq.com`（官方 2026-09 口径的「统一请求地址」；旧域名 `https://api.sgroup.qq.com` 仍然可用，老记录不必改）。`sandbox: true`（手工编辑 `settings.yaml`）切到 `https://sandbox.api.sgroup.qq.com`。
- AppID 字段**非机密**（它是机器人 ID，面板会显示已保存值）；**AppSecret** 是 `role('secret')` 字段（复用飞书的 `appSecret`），只保存在本机设置里、任何线上边界都会被抹掉。
- **订阅事件（intents）**：默认 `c2c + public_guild`（= `1107296256`）。官方规则是「只有 `guilds` / `public_guild_messages` / `guild_members` 默认有权限，其余事件**必须申请**；在鉴权时传了无权限的 intents，WebSocket 会**直接关闭连接**」。所以默认**故意不含** `direct`（频道私信，需单独申请）——一个只做单聊/群聊的机器人如果默认索要它会连不上。需要用别的组合时，在通道的 `intents` 里填关键字（`c2c,public_guild,direct,interaction,…`）或十进制位掩码。
- **被动回复的官方约束**（插件已按此实现）：`msg_id` 有效期 **5 分钟**、同一条入站消息**最多回复 5 次**；`msg_seq` 从 1 递增（同一 `msg_id` + 同一 `msg_seq` 会被平台判为重复）。因此：长回复按 ~900 字切分成多条并各自带新 `msg_seq`（超过 5 条会截断并显式标注「已截断」）；被动窗口过期（`40034005`/`304103`/`40034128`）时**自动改发一条主动消息兜底**；`40054005`（消息被去重）按「已送达」处理，避免把成功当失败重发。
- **「已连接」是可证伪的**（与微信那次同一口径）：网关的关闭码会翻译成中文并写上面板——`4014 intent 无权限`（附「去 q.qq.com 申请，或把 intents 改成已有权限的事件」的下一步）、`4013`、`4914`（已下架，只允许沙箱）、`4915`（已封禁）等**不可重试**的码会**停止重连**并把原因留在面板，而不是每 3~60 秒重试一次把真正的原因埋进日志；`4009` 等可恢复的码会带 **RESUME**（`session_id` + `seq`）重连，由网关补发断线期间遗漏的事件。
- **心跳 ACK 看门狗**：网关会对每个客户端心跳回 `op=11`。连续两个心跳周期（含 5 秒宽限）收不到**任何**帧就认定为半开连接，强制断开重连——修掉「socket 还 OPEN、面板还是绿的、消息却进不来」这一类。
- **发送失败不再静默**：发送响应会被真正解析（`err_code` / `code`，注意官方失败也可能返回 HTTP 200）。失败会抛出带中文原因的错误，由网关回发到同一会话并写进面板的通道状态行（`最近一次消息处理失败：…`）。
- **边界**：群 / C2C 能力需在 q.qq.com 提审开通，未过审时接口报权限错误属正常；C2C/群消息为**被动回复**（需先用 `msg_id` 引用，无主动推送）；AppSecret 是机密，勿提交进 Git。

#### QQ 真机探针

```sh
pnpm qq-probe <appId> <appSecret> [--ints c2c,public_guild] [--sandbox] [--seconds 90] [--no-reply]
```

不经过 DSH 宿主，直接把传输层指向真实开放平台跑一遍「取票 → 取网关 → WebSocket 鉴权 → 收消息 → 被动回复」，并把每一步的**平台原话**（含关闭码 / error code）打印出来；失败时按面板口径给出排查建议。它**不会**打印 AppSecret / AccessToken。用途与微信那次的 `scripts/inbound-probe.mjs` 相同：把「面板说连接中」拆成「卡在哪一步」。

> **Secrets**: keep real values out of Git. `.gitignore` already excludes `cordis.local.yml` / `.env*`; never commit an apiKey/appSecret/password to a channel record that ends up under version control.

---

## Files

| Path | Purpose |
| --- | --- |
| `src/config.ts` | Schemastery `Config` schema (legacy single-webhook tunables, incl. `allowlist`) |
| `src/inbound.ts` | Embedded `node:http` webhook server (routes by URL path; acks `202` only after `handle()` resolves) |
| `src/gateway.ts` | Workspace-attached session composition, live-agent reuse, rpcId reply claiming, allowlist / dedup / serialization / source injection / delivery retry / fault notices |
| `src/session.ts` | Deterministic session-key derivation: `im-<sha1(channel:chat_id[@cwd])>`, channel-isolated and scoped to an explicitly configured working directory |
| `src/index.ts` | Plugin entry (`name`/`inject`/`Config`/`apply` + lifecycle + `GET /im-gateway/status` route) |
| `src/status-proto.ts` | Host↔client wire contract for live channel status (dependency-free; why a route, not a Remote namespace) |
| `src/status-route.ts` | The status route handler (payload projection, browser-auth gate, method guard) |
| `src/channels/types.ts` | Channel type model + status (pure types, shared client/host) |
| `src/channels/schema.ts` | Host-side `im-channels` settings schema (SECRET fields via `role('secret')`, plus the plugin-wide default `cwd`) |
| `src/channels/manager.ts` | Per-channel connection lifecycle, transport build, live status snapshots |
| `src/transports/*.ts` | One real adapter per channel (http / email / cmcc / feishu / wechat / qq / qqbot), each tags its runtime with `channel` |
| `src/client/*` | Browser half: expandable plugin card (`ChannelsCard`) wrapping the channel management UI (`ChannelsSection`), foolproof templates, live status + locally-encoded QR (`qr.ts`) |
| `cordis.yml` | Local source overlay (`--patch`) for development / e2e iteration |
| `cordis.patch.yml` | Published **bundle** layer — references the package by name (`dsh-im-gateway` → `lib/index.js`) |
| `scripts/build.mjs` | esbuild build: emits `lib/index.js` (node) + `lib/client.js` (browser) + `lib/vendor/lark-sdk.cjs` (vendored Feishu SDK) |
| `scripts/check-install-scripts.mjs` | Build guard: fails if any *runtime* dependency (transitively) ships an install-time script |
| `scripts/smoke.mts` | Local smoke test (session hashing, HTTP route, reply callback, CMCC failure, vendored Feishu SDK, WeChat QR/liveness, QQ handshake/close-codes/watchdog/sends, default-cwd precedence) |
| `scripts/qq-probe.mts` | QQ 真机探针 (`pnpm qq-probe <appId> <appSecret>`): token → gateway → WS handshake → inbound → passive reply, prints the platform's own answer |
| `lib/` | **Committed** build output — no `prepare`; git installs mount it as-is. Rebuild & commit together with every `src/` change |
| `lib/vendor/lark-sdk.cjs` | **Committed** vendored third-party (Feishu SDK, MIT) — generated by `scripts/build.mjs`, never edited by hand |
| `docs/channel-ui-design.md` | Design doc for the multi-channel settings UI |
| `docs/2026-09-17-wechat-connected-but-mute.md` | 微信「已连接但不回复」的完整证据链与修复记录 |
| `docs/2026-09-17-qq-connect-diagnosis.md` | QQ「连不上」的协议对账、根因与修复记录（含关闭码/错误码速查） |
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
| `cwd` | `''` | Optional working directory for the Agent session (a real Harness workspace). Fallback only: a channel's own `cwd` and the settings card's 全局默认工作目录 take precedence (`~/.dsh/im-workspace` when nothing is set) |
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
