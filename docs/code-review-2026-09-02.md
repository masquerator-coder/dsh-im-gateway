# dsh-im-gateway 代码审核报告

- **审核日期**: 2026-09-02
- **审核范围**: `src/`（插件主源码，19 个 TS/TSX 文件）、`dsh-cmcc-newmsg/`（本地子插件）、`scripts/`（构建与冒烟测试）、`cordis*.yml` 配置层、`lib/` 提交产物一致性
- **审核维度**: 业务逻辑正确性与完整性、安全漏洞、代码规范与可读性、异常处理与边界情况、性能与资源、测试覆盖率
- **验证手段**: 逐文件人工审查 + ESLint（3 errors / 20 warnings）+ `tsc --noEmit`（通过）+ `smoke.mts`（通过）+ `node scripts/build.mjs` 产物比对（发现不同步）

---

## 一、总体结论

| 维度 | 评价 |
| --- | --- |
| 架构设计 | **良好**。多通道 transport 抽象、rpcId 回复认领、per-session 串行化、workspace 绑定 + 跨重启 resume 等设计清晰，注释详尽 |
| 业务逻辑 | **存在 1 处确定性缺陷**（Email 回复地址错误）+ 1 处文档与实现不符（per-channel allowlist 未实现） |
| 安全 | **入站 HTTP 无请求体大小限制**；其余鉴权/脱敏设计较完善，但有若干最佳实践缺口 |
| 代码规范 | 类型检查通过；ESLint 有 3 个 error（未使用变量）、20 个 warning（`any` 泛滥、unused disable） |
| 异常处理 | 主项目较完善（bounded retry、显式 NOT delivered 日志）；子项目 `dsh-cmcc-newmsg` 明显落后 |
| 性能资源 | 若干 Map 无淘汰策略、外发请求无超时、同步读大文件等问题 |
| 测试覆盖率 | **低**。仅一个冒烟脚本，核心 `gateway.ts` 逻辑（ReplyWaiter/dedup/allowlist/串行化）无任何单测 |

**问题统计**: 高风险 **4** 项、中风险 **10** 项、低风险 **12** 项。

---

## 二、高风险问题（建议立即修复）

### H-1 Email 通道回复地址错误 — 回复必然发送失败

| 项目 | 内容 |
| --- | --- |
| 位置 | `src/transports/email.ts:134-135`（chatId 生成）与 `email.ts:194-202`（`sendText`）配合 `src/channels/manager.ts:163-178`（`routeInbound` 的 reply sink） |
| 类型 | 业务逻辑缺陷 |

**问题**: 入站邮件的 chatId 被构造成复合格式 `` `${account}/${sender \|\| uid}` ``（用于 session 隔离，合理），但 `ChannelManager.routeInbound` 的回复回调直接执行 `t.sendText(route.chatId, reply)`，`EmailTransport.sendText` 又把这个复合 chatId 原样作为 SMTP 收件人 `to:`。`"you@example.com/sender@foo.com"` 不是合法邮箱地址，nodemailer 必然发送失败 → 触发两次重试后记录 `reply NOT delivered`。**Email 通道的自动回复功能整体不可用。**

**修复建议**:
```ts
// EmailTransport.sendText: 从复合 chatId 中解析真实发件地址
async sendText(to: string, text: string): Promise<void> {
  const realTo = to.includes('/') ? to.split('/')[1]! : to
  await this.transport.sendMail({ from: this.options.account, to: realTo, ... })
}
```
或让 `InboundRoute` 携带独立的 `replyTo` 字段，与 session key 解耦。

### H-2 多通道渠道缺少 per-channel allowlist，且 cwd/agentPreset 未接线 — 与 README 声明不符

| 项目 | 内容 |
| --- | --- |
| 位置 | `src/channels/schema.ts`（无 `allowlist` 字段）、`src/channels/types.ts:24-78`、`src/channels/manager.ts:187-191`（`base` 仅传 `provider/model/disposeAfterReply`） |
| 类型 | 越权 / 鉴权缺失 / 功能缺口 |

**问题**:
1. README 明确声称 *"Sender access control — set `allowlist` (per-channel)"*，但 `ChannelConfig` 与 `ChannelsSettingsSchema` 中**根本没有 `allowlist` 字段**，UI 模板也没有该字段。多通道模式下（email / qq / wechat / cmcc），**任何发件人**（任意邮箱地址、任意 QQ 号、任意手机号）都可以驱动底层 Agent 及其模型调用——既产生费用风险，也是越权面。
2. `manager.buildTransport` 构造 `base` 时只传递 `provider / model / disposeAfterReply`；schema 中定义的 `cwd`、`agentPreset` 字段**配置了也不会生效**（未传入 `route.runtime`）。
3. 陷阱：legacy 全局配置的 `config.allowlist` 会作为 `ImGateway` 的 defaults **跨通道生效**，而各通道的 `senderId` 语义不同（邮箱地址 vs QQ 号 vs 任意 HTTP 字段值），极易造成误拦截或误放行。

**修复建议**: 在 `ChannelConfig` / schema / UI 模板中增加 `allowlist: string[]` 字段；`manager.ts` 的 `routeInbound` 把 `channel.allowlist`、`channel.cwd`、`channel.agentPreset`、`channel.maxTokens` 一并合入 `runtime`（`gateway.handle` 已支持 per-call 覆盖 `AgentRouting`，需要把 allowlist 从“仅 defaults”提升为可 per-message 覆盖）。

### H-3 入站 HTTP 服务器无请求体大小限制 — 内存耗尽 DoS

| 项目 | 内容 |
| --- | --- |
| 位置 | `src/inbound.ts:21-36`（`readJson` 无界收集 chunks）、`src/inbound.ts:107-144`（`handle` 无并发/速率限制） |
| 类型 | 拒绝服务 |

**问题**: `readJson` 把请求体全部缓冲到内存，没有 `content-length` 校验也没有流式截断。默认监听 `127.0.0.1`（风险受限），但一旦按 README 部署到防火墙外或 `secret` 留空，单个恶意大 POST（或多并发）即可耗尽进程内存；即便有 secret，**401 判定发生在读 body 之前**（顺序正确），但 400/404 分支前无任何限制。

**修复建议**:
```ts
const MAX_BODY = 1_000_000 // 1MB
req.on('data', (chunk: Buffer) => {
  chunks.push(chunk)
  if (Buffer.concat(chunks).length > MAX_BODY) {
    req.destroy(); reject(new Error('payload too large'))
  }
})
```
并考虑加简单的并发上限（`server.maxConnections`）或令牌桶限速。

### H-4 提交的 `lib/` 构建产物落后于 `src/` — 分发版本运行旧代码

| 项目 | 内容 |
| --- | --- |
| 位置 | `lib/index.js`（已提交版本） vs `src/transports/cmcc/smsClient.ts`、`src/gateway.ts` |
| 类型 | 发布流程违规（违反本仓库 README 的硬性规则） |

**问题**: 重新执行 `node scripts/build.mjs` 后与已提交的 `lib/index.js` 比对存在 **78 行差异**：src 中的「错误日志注入（`errLog`/`emitLog`，替换裸 `console.error`）」和「workspace 预建去重（`workspaceInFlight`）」两处修改**未重建提交**。该包的 Git 安装方式直接挂载预构建 `lib/`，下游用户将运行缺少这些修复的代码。另外工作树中还有 `package.json`、`pnpm-lock.yaml` 及 5 个 `src/` 文件的未提交修改。

**修复建议**: 执行 `pnpm build` 并将 `lib/` 与全部 src 修改在同一提交中提交；建议在 CI 中加一步「构建后 `git diff --exit-code lib/`」防止再次脱节。

---

## 三、中风险问题

| 编号 | 位置 | 问题 | 修复建议 |
| --- | --- | --- | --- |
| M-1 | `src/inbound.ts:114-118` | secret 比较用 `!==`（非常量时间），存在理论时序侧信道 | 用 `crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret))`（先比长度或 pad） |
| M-2 | `src/inbound.ts:141-143` | 500 响应把内部 `error.message` 原样返回给外部调用方（信息泄露） | 返回固定文案 `{ error: 'internal error' }`，详情只写日志 |
| M-3 | `src/index.ts:57-62`、`src/transports/http.ts:78-86`、`src/transports/wechat.ts:88-98` | 回调/外发 `fetch` 均无超时；undici 默认超时可达 300s × 2 次重试，期间该 chat 的串行化 tail 链被阻塞约 10 分钟 | 统一加 `signal: AbortSignal.timeout(30_000)`；wechat 轮询类请求可更短 |
| M-4 | `src/gateway.ts:197`（`agents`）、`src/transports/qq.ts:30`（`targets`） | Map 只增不减（`disposeAfterReply=false` 时每个 chat 常驻一个 Agent；QQ 每个 chat 一条路由记录），长运行进程内存无限增长 | 加 LRU/空闲淘汰（如 N 分钟无消息 dispose agent，靠 resume 机制可无损恢复）；`targets` 在 `sendText` 成功后即可清理或加容量上限 |
| M-5 | `src/transports/cmcc/smsClient.ts:256`、`dsh-cmcc-newmsg/src/transport/websocket.ts:247` | 入站消息 `from` 缺失时 fallback 到 `this.apiKey` → 所有解析失败的消息共享同一个 session，**跨发送者串扰隔离** | fallback 改为丢弃该消息并记日志（`return`），而不是归并到 apiKey 会话 |
| M-6 | `dsh-cmcc-newmsg/src/bridge.ts:120-127, 265-271` | 子插件并发消息 bug：同一手机号连发两条消息会产生两个 `ReplyCollector`，`onSessionEvent` 对同 session 的**所有** collector 都 `append` → 两条回复内容互相污染；主项目已用 rpcId claiming 修复，子插件未同步。另外 `ensureAgent` 只会 `agents.create`，无 `sessionPersisted` 探测 → 跨重启可能与持久化 session 冲突；constructor 里 `ctx.on('session/event', …)` 未保存 disposer，插件卸载后监听器泄漏 | 将主项目 `ReplyWaiter`（rpcId 认领）与 resume 探测逻辑移植过来；保存 disposer 并在 `close()` 中调用 |
| M-7 | `dsh-cmcc-newmsg/src/transport/fileTransfer.ts:72-105, 125` | 媒体下载无大小限制（磁盘耗尽风险）；上传用 `fs.readFileSync` 把整个文件同步读进内存并阻塞事件循环 | 下载流式统计字节数超限即中断；上传改 `fs.createReadStream` 或分块；顺带 `uniqueName` 已用 `path.basename` 防穿越（正确） |
| M-8 | `src/client/ChannelsSection.tsx:256` | 保存时 `enabled: true` 硬编码，UI 没有启用/停用开关（locales 里有 enable/disable 词条但没有按钮）；必填字段（email 的 host/account/password）无前端校验，填错只能等运行时报错 | 增加启用开关与必填校验；错误状态已在 RPC 里有 detail，可在表单内联提示 |
| M-9 | `src/transports/wechat.ts:84-98`、`src/transports/http.ts:78` | token/secret 通过请求体或 header 走 `clawUrl`/`callbackUrl`，若用户配置了明文 `http://` 远程地址则凭证明文传输 | 对非 localhost 的 http 目标打印告警；文档中强调使用 https |
| M-10 | 全仓库 | 测试覆盖率低：仅 `scripts/smoke.mts`（session hash、HTTP 路由、回调、CMCC 失败 4 组断言）；`gateway.ts` 的 ReplyWaiter 认领、dedup 窗口、allowlist、per-session 串行化、`manager.ts` 的 reconcile、全部 client UI 均无测试 | 引入 vitest（或继续用 node:test），优先为 `ReplyWaiter`、`isRecentDuplicate`、`allowSender`、`ChannelManager.reconcile` 补单测——这些都是纯逻辑、易测试 |

---

## 四、低风险问题

| 编号 | 位置 | 问题 | 修复建议 |
| --- | --- | --- | --- |
| L-1 | `eslint.config.mjs:15`、`src/gateway.ts:11`、`src/transports/email.ts:120` | ESLint 3 个 error：未使用变量（`reactHooksConfigs`、`Session`、`host`）；另有 20 个 warning（`any`、unused disable directive 等） | `pnpm lint:fix` + 手工清理；`any` 已知是 DSH 未发布类型的妥协，可保留 warn |
| L-2 | `src/transports/email.ts:185` | 正文清洗正则 `/>.*\n/g` 会误删正文里以 `>` 开头的行，且不处理 `\r\n`；`subject` 硬编码 `Re: IM Gateway` | 改为按行 split 后过滤 `^>` 行；subject 可存入 chatId 旁路或回 `Re: <原文主题>` |
| L-3 | `src/transports/email.ts:135` | 邮件无 `from` 时 chatId fallback 到 `uid`（每次变化）→ session 不稳定 | 无 from 的邮件直接跳过并记日志 |
| L-4 | `src/transports/cmcc/smsClient.ts:104-112` | `AUTH_TIMEOUT_MS = 10000` 但实际用 `AUTH_TIMEOUT_MS * 2`（20s），常量语义与实际值不一致 | 直接写 `const AUTH_TIMEOUT_MS = 20000` |
| L-5 | `src/transports/wechat.ts:36, 134` | `seen` 去重仅在内存，进程重启后若 companion 重放历史消息会重复触发模型调用 | 依赖 gateway 层 5s dedup 之外，可把最近 id 持久化或让 companion 提供游标 |
| L-6 | `dsh-cmcc-newmsg/src/transport/websocket.ts:55`、`fileTransfer.ts:27` | `logError` 无条件 `console.error`（DEBUG=false 也输出），与主项目已改为注入式 logger 不一致 | 移植主项目 `errLog` 方案 |
| L-7 | `src/client/ChannelsSection.tsx` 全文件 | 大量内联样式与 `any`，组件 420 行单文件；状态轮询 `setInterval` 3s 且面板隐藏时不停 | 拆分子组件 / 抽样式常量（已部分做）；轮询可在 `document.hidden` 时暂停 |
| L-8 | `src/client/ChannelsSection.tsx:300-314` | 删除通道无二次确认 | 加 `confirm` 或两步按钮 |
| L-9 | `src/gateway.ts:590-595` | `sessionIdOf` 对 Session 对象形状（`id`/`sessionId`）做假设，若上游字段变更会静默丢事件 | 加一条 debug 日志兜底 |
| L-10 | `src/gateway.ts:470-484` | `sessionPersisted` 只处理 `Symbol.dispose`，若 lease 提供 `Symbol.asyncDispose` 会泄漏 | 同时探测 `Symbol.asyncDispose` 并 await |
| L-11 | `dsh-cmcc-newmsg/cordis.local.yml` | 真实 apiKey（`ak_b84f…`）以明文存于工作目录。已确认被 `.gitignore` 覆盖、未被 git 追踪（处理正确），但该文件已出现在本次会话与本地磁盘中 | 建议在 CMCC 平台轮换该 key；继续确保任何打包/分享操作排除该文件 |
| L-12 | `scripts/smoke.mts:25` 等 | 冒烟脚本无类型标注（依赖 `--experimental-transform-types`），Node 版本升级有兼容风险 | 给 `step/withTimeout` 等加显式类型；关注该 flag 转正进度 |

---

## 五、按文件审查摘要

| 文件 | 结论 |
| --- | --- |
| `src/index.ts` | 结构清晰；legacy fire-and-forget + catch 注释合理；回调 fetch 缺超时（M-3） |
| `src/gateway.ts` | **核心逻辑质量高**（rpcId 认领、dedup 有界、串行化、超时兜底、重试有日志）；`agents` Map 无淘汰（M-4）；`Session` 未用 import（L-1） |
| `src/inbound.ts` | 路由/鉴权顺序正确（先鉴权后读 body）；**无 body 大小限制（H-3）**；timing 比较与 500 泄露（M-1/M-2） |
| `src/session.ts` | 纯函数、sha1 16 位截断，设计有注释依据；无问题 |
| `src/config.ts` | 与 README 一致；`callbackUrl` required 合理 |
| `src/channels/schema.ts` | **缺 allowlist 字段（H-2）**；`SECRET()` 用法正确 |
| `src/channels/manager.ts` | reconcile/restart 竞态窗口小（连续快速保存可能短暂双启动，最终一致）；`buildTransport` 参数未接全（H-2）；`stop()` 双 emitStatus 小瑕疵 |
| `src/transports/http.ts` | 简洁正确；fetch 无超时（M-3） |
| `src/transports/email.ts` | **chatId→收件人 bug（H-1）**；其余为 L-2/L-3 小问题 |
| `src/transports/feishu.ts` | 长连接 + 回调封装合理；SDK `any` 属妥协；无 allowlist（并入 H-2） |
| `src/transports/wechat.ts` | 健康探测不致命、重试语义合理；token 明文 http 风险（M-9）；内存 dedup（L-5） |
| `src/transports/qq.ts` | `targets` 无界（M-4）；fallback `pickFriend` 行为可接受 |
| `src/transports/cmcc.ts` + `cmcc/smsClient.ts` | 容错解析（tryFixJson 等）有启发式风险但有 fallback；`from` fallback apiKey（M-5）；心跳/重连逻辑正确 |
| `src/client/*` | UI 可用但粗糙（M-8/L-7/L-8）；secrets“留空即保留”的交互处理正确 |
| `dsh-cmcc-newmsg/*`（本地，git-ignored） | **明显落后于主项目**：collector 串扰、无 resume、监听器泄漏（M-6）、文件传输无限制（M-7）；建议直接复用主项目 `ImGateway` 而非维护平行实现 |
| `scripts/build.mjs` | 构建策略（external、双产物、ModuleLoader banner）正确 |
| `scripts/smoke.mts` | 覆盖太少（M-10），但现有断言有效且通过 |
| `cordis*.yml` | 已提交版本均无真实 secret ✅；`cordis.local.yml`（真实 key）确认未被追踪（L-11） |

---

## 六、修复优先级路线图

1. **立即（上线阻断级）**: H-1（email 回复地址）、H-2（allowlist 接线 + 传参补全）、H-3（body 限制）、H-4（重建并提交 lib/）
2. **短期（1-2 周）**: M-1/M-2（鉴权与报错硬化）、M-3（超时）、M-5（from fallback）、M-8（UI 停用开关与校验）
3. **中期**: M-4（Map 淘汰）、M-6/M-7（子插件对齐或废弃）、M-10（补核心单测）
4. **择机清理**: 全部 L 项，可与日常迭代合并处理

---

*报告由静态审查 + 本地工具链验证生成；未审查 `design/`、`video/`（本地工具产物，git-ignored）与 `node_modules/`。*
