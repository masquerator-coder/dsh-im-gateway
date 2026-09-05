# WeChat clawbot 伴生网关 — 实现方案（草案 v0.1）

> **状态：已被 ilink 直连方案取代（2026-06）。** dsh-im-gateway 的微信通道现改走**直连腾讯官方 ilink 网关**（`https://ilinkai.weixin.qq.com`，扫码绑定 + getupdates 轮询 + sendmessage），不再需要本地伴生网关；见 `src/transports/wechat.ts`（`WechatIlinkTransport`）与根 README。本草案保留作为「伴生网关」备选路线的存档，其 §2 契约（`/health` `/receive` `/send` `/qr`）已不再对应当前实现。
> 相关代码：`src/transports/wechat.ts`（ilink 直连传输层）、`src/channels/manager.ts`（通道生命周期）、`src/channels/schema.ts`（配置字段 `baseUrl`/`token`）。

---

## 1. 背景与目标

dsh-im-gateway 的**微信通道不是一个直连适配器**，而是「clawbot 伴生网关」的 HTTP 客户端（设计动机：个人微信无官方自动化 API，登录与收发由单独运行的伴生程序持有，插件保持零逆向、零第三方 SDK 依赖）。当前状态：

- 插件侧传输层已实现并随插件发布（`WechatClawTransport`，轮询式客户端）；
- **伴生网关本身不存在**：仓库未附带、9001 端口无进程监听 → 微信通道开箱不可用。

本方案的目标：产出一个**独立于 Cordis 插件包**运行的伴生网关程序，使微信通道达到与 QQ/5G 通道同级的可用状态（扫码登录 → 收消息 → 回消息 → 状态可见），并保证**契约可被自动化验证**（不依赖真实微信即可先跑通协议）。

### 验收标准（Definition of Done）

1. 伴生网关实现插件契约的全部 4 个端点，协议一致性由「真实 `WechatClawTransport` × Mock 伴生」自动化测试证明（见 Phase 0）。
2. 接入真实微信引擎后：界面可展示登录二维码（或明确的引导文案）→ 扫码 → 通道状态变为可收发 → 私聊/群聊文本消息双向可达。
3. 伴生网关可独立启停、可配置 token、默认只绑 127.0.0.1；重启后不重放已处理消息。
4. 文档化已知边界与风险（文本优先、引擎版本锁、合规）。

---

## 2. 契约规范（协议 v1）— 以插件代码为准

伴生网关监听地址 `clawUrl`（默认 `http://127.0.0.1:9001`）。除下述端点外**不得依赖任何其它端点/推送通道**——插件侧只有一次启动探测 + 3s 轮询，没有回调注入点。

所有端点均为 `POST`，`Content-Type: application/json`，可选的共享令牌放在 JSON 体 `token` 字段（与插件通道配置的 `token` 一致）。鉴权失败返回 401；令牌为空字符串时不鉴权（仅限本机调试）。

### 2.1 `POST /health` — 存活探测
请求：`{"token"?: string}`；响应：`200 {"ok": true}`。
- 插件在 `start()` 时调用一次；非 200 / 非 `ok:true` / 网络失败都视为未就绪，插件会进入 `connecting`（detail「等待 clawbot 伴生网关就绪…」）并继续轮询 `/receive`。
- **必须永远快速应答**：插件只在启动时探测一次，此后全靠 `/receive` 轮询判定存活，`/health` 不应有副作用。

### 2.2 `POST /receive` — 拉取入站消息（3s 轮询）
请求：`{"token"?: string}`；响应：`200 {"messages": [...]}`，`messages` 必须恒为数组（可为空）。
消息元素：`{ "id"?: string, "from": string, "content": string }`。

| 字段 | 语义 | 要求 |
|---|---|---|
| `id` | 消息稳定唯一 id | 建议提供；插件用它做内存去重（`seen` 上限 2000 条，环形裁剪） |
| `from` | **对话实体的稳定键**：联系人 `wxid` 或群 `*@chatroom` 房间 id；**不是昵称**（昵称可变） | 必填；插件原样回传给 `/send` 的 `to` |
| `content` | 纯文本内容 | v1 只支持文本；图片/语音/文件等先忽略或丢弃 |

轮询语义建议（伴生侧实现要点）：
- **pop-on-read + 稳定 id**：消息交给某次 `/receive` 后即出队；同时服务端保留最近 N 条（如 500）id 环形去重，避免插件重启后重放。
- **背压上限**：待拉取队列上限建议 1000 条；插件若停机多时，恢复后不应一次性灌入无限积压（防 Agent 风暴）。
- 若插件短暂离线，伴生侧把消息排在队列里等它回来拉取即可——不要丢。
- **中途失联对插件不可见**：插件在首次 `/receive` 成功后即认为 `connected` 且不再回落（轮询异常被静默吞掉）。因此伴生端任何时刻都要保证 `/receive` 快速返回 200 + 合法 JSON；自身的微信连接状态变化不要试图通过让 `/receive` 报错来表达（会被吞），只能体现在 UI 之外的日志里。插件侧周期性复检属于后续增强（见 §7 非阻塞项）。

### 2.3 `POST /send` — 外发回复
请求：`{"token"?: string, "to": string, "text": string}`；响应：`2xx`（内容不限）。
- `to` = 收到该消息时的 `from`（联系人 wxid 或群房间 id），伴生端据此路由到私聊或群。
- 2xx 视为「已受理投递」；插件网关层对失败最多重试 2 次，仍失败则记 `reply NOT delivered`。因此伴生端应**先快速确认入队/发送成功**（微信引擎发送为毫秒级），不要在响应前做重活。
- 群场景下，引擎侧通常需把回复文本发到群而非回复个人（v1 直接群发即可，@ 提及留待 v2）。

### 2.4 `POST /qr` — 登录二维码
请求：`{"token"?: string}`；响应：`200 {"url": string}`。
- `url` 被插件原样放入状态快照的 `qr` 字段，前端渲染为 `<img src={qr}>`（168×168）。因此 `url` 必须是浏览器可直接加载的地址：**推荐 `data:image/png;base64,...`**（浏览器可能与伴生网关不在同一台机器，绝对 URL 会失效；data URL 无此问题）。
- 插件仅在 `start()` 时调用一次。二维码过期/刷新后插件**不会自动重拉**——已知限制：需用户关闭再启用通道触发重新登录。可选增强见 §7。

### 2.5 状态机（插件侧观察到的形态，伴生端据此对齐）

```
idle ──enable──> connecting ──/receive 首次成功──> connected
  ^                                                  │
  └──────────────────disable/stop────────────────────┘
```
- `connecting`：伴生未起/未登录（detail 提示语见上）。
- `connected`：**只表示伴生网关 HTTP 可达并成功拉取过一次**，不等于微信本体已登录。真正的「微信在线」状态目前无通道回传 UI——请在伴生端日志与健康页体现。

---

## 3. 总体架构

```
┌────────────────────────────── dsh-im-gateway (Cordis 插件, 已存在) ─────────────────────────────┐
│  ChannelsSection(UI) ──RPC──> ChannelManager ──buildTransport──> WechatClawTransport             │
└──────────────────────────────────────────────┬───────────────────────────────────────────────────┘
                                   HTTP POST (3s 轮询 / 事件触发)
┌──────────────────────────────────────────────▼───────────────────────────────────────────────────┐
│  clawbot 伴生网关（本方案，独立进程，Node ≥ 22）                                                 │
│                                                                                                   │
│  HTTP API Server (127.0.0.1:9001)          ┌──────────────┐      ┌─────────────────────────────┐ │
│   /health   → 存活                        │   核心调度     │      │  WeChat 引擎驱动(可插拔)      │ │
│   /receive  → 出队入站消息(≤3s内)          │   · 入站队列   │◄────►│   DriverIf 接口              │ │
│   /send     → 入队外发                     │   · 出站 worker│      │   · MockDriver(测试/默认)    │ │
│   /qr       → 当前登录二维码(data URL)      │   · 状态/事件   │      │   · WcfDriver(WeChatFerry)  │ │
│   (可选) /status → 人类可读诊断             │   · 消息去重    │      │   · WxAutoDriver(备选)      │ │
└────────────────────────────────────────────┴──────┬───────┴──────┴─────────────────────────────┘
                                                     │ 本地进程内事件
                                      ┌──────────────▼───────────────┐
                                      │ Windows 微信本体(由驱动拉起/附着) │
                                      └──────────────────────────────┘
```

设计要点：

1. **驱动抽象（DriverIf）** — 微信自动化方案的差异全部关在驱动层；HTTP 契约层、队列、去重与插件无关。
2. **队列即缓冲** — 微信引擎事件（入站）进队，插件轮询出队；插件外发入队，引擎 worker 投递。两边速率解耦。
3. **文本优先 v1** — 非文本消息在驱动层降级（忽略/占位），不入队。
4. **独立包、独立工具链** — 与 Cordis 插件包解耦（该仓库 `pnpm-workspace.yaml` 是单包 workspace，插件 `files` 白名单也不该塞入伴生程序）。建议仓库内新增子目录 `clawbot/`，自带 `package.json`。

---

## 4. 引擎选型（Windows 11 宿主）

> 合规声明：所有方案均为对个人微信的**非官方自动化**，违反微信《软件许可及服务协议》，存在**封号风险**。仅建议低频、自用、测试账号使用。以下为工程现实，不构成合规背书。

| 候选 | 机制 | 优点 | 风险/代价 | 建议 |
|---|---|---|---|---|
| **WeChatFerry (wcf)** | 向 Windows 微信进程注入 hook DLL，经 RPC 收发 | 消息可编程取用、社区活跃（[lich0821/WeChatFerry](https://github.com/lich0821/WeChatFerry)、[sglmsn/WeChatFerry fork](https://github.com/sglmsn/WeChatFerry)）；Node 有 `wcferry`/`wechatferry` 绑定 | **版本锁死**（通常锁微信 3.9.x 具体小版本）；注入被安全软件/微信更新打断；需保持微信登录态 | **首选**，但先做 3 天 spike 验证版本匹配与二维码获取路径 |
| **wxauto**（[doun/wxauto](https://github.com/doun/wxauto)） | Windows UI 自动化（不注入、不逆向） | 无 DLL 注入、随官方客户端更新容错高、Python 生态成熟 | 依赖窗口焦点/界面；大量消息时吞吐低；仍需微信客户端已登录 | 备选（文本量低时够用）；跨语言（Py 桥）增加部署面 |
| ntchat / 其它 hook | 同 WeChatFerry | — | 版本锁、维护度参差、闭源化趋势 | 不推荐 |
| Wechaty | Puppet 架构 | 抽象最好 | web 协议已废；可用 puppet 多需付费或同样逆向 | 不推荐作为自托管首选 |

**关键未决点（spike 必答）**：个人微信的「扫码登录」发生在 **Windows 微信客户端本体**（hook 类方案要求微信已登录才注入；未登录时能否经 RPC 取得二维码、或只能引导用户在微信窗口扫码）需要实测。因此驱动层把「二维码能力」设计为**可选能力**：
- 驱动能取到 QR → 走 `data URL` 进 `/qr`，UI 内直接扫码；
- 驱动取不到 → `/qr` 返回占位说明（如文本提示「请在微信客户端完成扫码登录」编码为简单图片或空 `url` 由 UI 兜底展示 hint——插件对 `qr.url` 为空有容错），并在 `/status`/日志给出指引。

---

## 5. 驱动接口与数据模型（草案）

```ts
// clawbot/src/driver/types.ts
export interface WechatMessage {
  id: string            // 引擎消息 id（稳定、单调）
  from: string          // 对话实体稳定键: 联系人 wxid | 群 xxx@chatroom
  text: string          // 纯文本（非文本消息由驱动丢弃或置空）
  ts: number
}

export interface DriverStatus { loggedIn: boolean; detail?: string }

export interface WechatDriver {
  readonly kind: string                      // 'mock' | 'wcferry' | 'wxauto'
  start(): Promise<void>                     // 附着/拉起微信本体
  getLoginQr(): Promise<{ dataUrl?: string; hint?: string }>  // 可选能力
  getStatus(): DriverStatus
  onMessage(cb: (m: WechatMessage) => void): void   // 引擎事件 → 入站队列
  sendText(to: string, text: string): Promise<void>  // 群/私聊路由在驱动内解析
  stop(): Promise<void>
}
```

```ts
// clawbot/src/http/api.ts —— 契约端点（§2），薄层：鉴权 → 队列/状态操作，无微信逻辑
```

---

## 6. 实现步骤（Phase 划分）

> 每 Phase 结束有可运行产物；Phase 0/1 不依赖真实微信。

### Phase 0 — 契约一致性测试（先立规矩）
- 新增 `scripts/claw-contract-test.mts`（沿用仓库 `node --experimental-transform-types` 的 smoke 模式）：
  1. 起一个 **MockDriver 伴生**（内存队列，模拟 `/health` `/receive` `/send` `/qr`）；
  2. **导入真实 `src/transports/wechat.ts` 的 `WechatClawTransport`** 连上去；
  3. 断言：健康探测→`connecting`；收到消息→`connected` + `onInbound` 载荷正确；`sendText` 命中 `/send` 且 `{to,text}` 正确；同 `id` 消息不重复入站；`/qr` 的 url 出现在 `onQr`。
- 意义：把 §2 契约固化成可回归测试；伴生程序与插件任何一侧改动都能立刻发现契约破坏。

### Phase 1 — 伴生骨架（MockDriver 完整可用）
- 目录 `clawbot/`（独立 `package.json`，Node ≥ 22，ESM + TS 类型剥离，零额外构建链）。
- HTTP API Server（§2 四端点 + 鉴权 + `/status`）+ 入站队列/去重 + 出站 worker。
- MockDriver：支持脚本注入假消息（调试/演示微信通道全链路）。

### Phase 2 — 端到端联调（无真实微信）
- 把 Phase 1 伴生跑在 9001；在 DSH 插件设置里新建微信通道（`clawUrl` 默认值 + token）；
- 验证 UI：启用 → 显示 QR（mock 图）→ 状态流转 → mock 消息触发真实 Agent 回复且回复回到 mock 发送方。
- 交付：微信通道「全链路可用性」在 mock 下证明，留档录屏/截图。

### Phase 3 — WeChatFerry spike（3 天，验证后并入）
- 验证项：① 受支持微信版本与注入；② 未登录态二维码获取路径（决定 §4 二维码分支）；③ 消息事件吞吐与稳定性；④ 群/私聊路由。
- 通过后实现 `WcfDriver`（或退而选 `WxAutoDriver`），接入真实微信端到端验收。

### Phase 4 — 加固
- 鉴权默认开启、绑定 `127.0.0.1`；token 恒时比较。
- 队列上限、id 环形去重、崩溃恢复（最近 id 落盘小文件）。
- 结构化日志（连接事件/登录态/收发统计）；`/status` 人类可读。
- 使用说明（README of clawbot）：下载匹配版本微信、首次登录、自启动、与插件 token 配置对应关系。

### Phase 5（可选，非阻塞）— 发布与插件侧小改
- 插件侧非阻塞增强（回仓库）：`wechat.ts` fetch 加 `AbortSignal.timeout(30s)`（对齐 code-review M-3）；`connecting` 期间周期重拉 `/qr`（二维码刷新体验）；跨重启 `seen` 落盘（对齐 L-5）。这些都不阻塞伴生上线，可后续单独立项。

---

## 7. 风险与开放问题

| # | 风险/问题 | 影响 | 缓解 |
|---|---|---|---|
| R1 | 微信版本锁 + 更新打断（WeChatFerry 类） | 通道随时可能失效 | 驱动可插拔；README 固化版本；升级流程文档化 |
| R2 | 个人号自动化合规/封号 | 账号风险 | 仅低频自用；文档显著警示；提供「仅回不主动发」保守模式 |
| R3 | 未登录二维码获取路径未验证 | 扫码体验未知 | Phase 3 spike 先行；驱动二维码能力可降级为引导文案 |
| R4 | 插件无法感知伴生**中途**掉线（见 §2.5） | UI 状态失真 | 伴生保证 `/receive` 恒快响应 + 自身日志；插件周期性复检列为增强 |
| R5 | `seen` 去重仅在插件内存；插件重启可能重放 | 重复触发 Agent | 伴生 pop-on-read + 服务端 id 环形去重 + 落盘游标（Phase 4） |
| R6 | token 经明文 http 传输（若 clawUrl 非本机） | 凭据泄露 | 默认绑 127.0.0.1；非本机强制要求 https + 告警日志（对齐 M-9） |
| R7 | 群消息回复可能打扰全体成员 | 体验 | v1 群直接回复文本；@ 提及 / 仅@机器人 留 v2 |

---

## 8. 需要评审拍板的点

1. 伴生程序放仓库 `clawbot/` 子目录（推荐）还是独立仓库？
2. 引擎首选 WeChatFerry 是否接受其版本锁与注入风险（还是先上 wxauto 保守路线）？
3. 「仅回不主动发」等保守模式是否作为 v1 默认？
4. Phase 0 契约测试先做（推荐），还是直接按 Phase 1 搭骨架？
