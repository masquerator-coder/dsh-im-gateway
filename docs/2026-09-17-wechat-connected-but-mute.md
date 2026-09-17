# 「面板显示已连接，但微信/5G 发消息不回复」诊断与修复记录（2026-09-17）

## 现象
- 微信通道面板显示「已连接」，从微信给 bot 发消息**永远没有回复**；重启 dsh web 也不恢复。
- 5G 消息通道同样不回（见后文「为什么 5G 是另一条线」）。

## 证据链（这次是逐段证伪，而不是猜）

1. **入站确实到达了插件进程**。`~/.dsh/im-workspace/wechat-state/<channelId>.json` 只在
   `getupdates` 收到「绑定用户带 context_token 的消息」时被重写；它每次发消息都更新
   （21:52:03、22:01:55 …），说明 poll 循环活着、消息已消费。
2. **ilink 链路正常**：直接用 state 文件里的 `bot_token` 打
   `POST /ilink/bot/getupdates`（带文件里的 cursor）返回 200、`msgs: []`，且回来的
   `get_updates_buf` 与文件中的 cursor 一致（无积压）；进程到 `120.204.0.108:443`
   （`ilinkai.weixin.qq.com`）的 keep-alive 连接也一直 ESTABLISHED。
3. **出站也正常**：用 state 文件里的 `context_token` 直接 `POST /ilink/bot/sendmessage`
   返回 `{"message_id": ...}`，手机微信**真的收到了**那条测试消息（用户确认）。
4. **gateway 本身没坏（create 路径）**：用插件自带的 legacy HTTP webhook
   （`127.0.0.1:8799/im`，`scripts/inbound-probe.mjs` 就是这条探针）发一条新 chat_id 的消息，
   202 → Agent 真跑了模型 → 回复经 callback `127.0.0.1:9999/reply` 回来（`诊断通过`）。
5. **失败点在「resume 已有会话」这一段**：IM 会话
   `~/.dsh/sessions/--C-Users-fuqia-.dsh-im-workspace--/im-8687e00c01bb9b36/` 的日志里，
   自 `21:06:40` 那次 `/new`（create 路径）之后**没有任何 `user/message` / `turn/start`**，
   只在 `21:28:14` 多了一条 `session/end-seed`——那正是「用 seed 构造一个 Session（= resume
   的加载步骤）」留下的标记，说明 resume 起步了，却再没有后续 turn。
   （对照：正在使用的 GUI 会话 jsonl 是**秒级实时落盘**的，所以「没有 turn 事件」= agent 真的没跑。）

## 根因
**一个 Session 在宿主里是单写入者（single-writer）。** 只要同一个 session 已经 live
（最典型的情形：**操作者把这个 IM 会话开在 Web 界面里看**），插件再去
`agents.resume()` 就拿不到写所有权，`agents.create()` 也无法重新进入同一个 id。

DSH 自己的源码把这条规则写得很明确：

- `packages/core/agent-loop/src/index.ts`（resume）：*"Taking write ownership FIRST excludes a
  concurrent resume of the same id (in this process, a **live agent's handle holds the claim**)."*
- `packages/session/session-persistence-jsonl/src/storage.ts`：`claimWrite()` 冲突直接抛
  `SessionAlreadyOwnedError`（不会等待）。
- `packages/api/session-controller/src/agent.ts` 的 `createOrAdopt()` 因此**先**
  `const live = this.ctx.agents.get(sessionId); if (live !== undefined) return live`，
  才去碰持久化。

而旧版本的插件只查自己进程内的 `this.agents`，从不查宿主的 `ctx.agents`，于是：
- 第一次消息（会话还没被任何人打开）→ create → 正常（这就是「第一次配置后能正常通信」）；
- 之后只要该会话在 Web 端被打开过 → resume 抢锁失败 → `handle()` 的 catch 只写
  `ctx.logger.warn`（GUI 里看不到）→ **用户侧完全静默**；
- 重启 dsh web 也不解决：浏览器恢复该会话后又是 live。

「切到别的会话」不一定释放它——DSH 不会因为侧边栏切换就卸载会话，所以那个实验不能证伪本结论。

## 修复（本次提交）
1. **复用 live agent**：`ImGateway.acquireAgent()` 先 `this.ctx.agents.get(sessionId)`，
   命中就复用（并保证**永不 dispose 不是自己创建的 agent**），与 DSH `createOrAdopt` 同规则。
2. **失败不再静默**：turn 失败（取 agent 失败/超时、模型报错、空回复、投递失败）会
   **回发到同一个聊天**：`⚠️ 处理失败，未能回复。原因：…`，同时写进该通道的状态行
   （`onFault` → 面板 detail），回复成功则清除。取 agent 的过程加 60s 上限——旧版无限等待
   会把该会话的串行 tail 永久挂住，后面所有消息一起被吞。
3. **「已连接」可证伪**：微信通道连续 10 次 `getupdates` 往返失败（约 15s）从 connected
   降级为 error 并写明原因，成功即恢复；`errcode -14`（会话吊销）在**任何**一次往返都立刻报错
   （旧代码只在「尚未连接」时检查，连接后吊销永远不报）。
4. **CMCC 看门狗**：新增独立 socket 看门狗（socket 状态 + ping/pong 新鲜度），半开连接
   （睡眠/换网后没有 FIN）会被强制重连；`attemptReconnect` 不再因 `connected` 这个可能过期的
   标志而空转。

## 为什么 5G 是另一条线
- 5G 通道在 `~/.dsh/im-workspace` 下**根本没有 IM 会话目录**，说明它的入站从未到达 gateway。
- 进程与 `5gvas01.cmicmaap.com`（36.133.1.9:443）的 WebSocket 时有时无（采样时曾整段缺失，
  后又 ESTABLISHED），与 2026-09-14 那次的结论一致：**平台侧在进程重启后不一定把该号码的
  入站重新投递到新连接**，属平台侧问题；本插件这侧这次补的是「半开连接强制重连 + 状态如实上报」，
  所以下次平台不再投递时，面板会显示真实连接状态，而不是绿着不动。

## 可复用的本地排查手段
- **入站探针**：`node scripts/inbound-probe.mjs <chatId> <文本>` —— 起一个 127.0.0.1:9999
  的 callback 收集器，往运行中的宿主 legacy webhook（`127.0.0.1:8799/im`）投一条消息，
  能区分「gateway 整体坏了」还是「只有 resume 路径坏了」（新 chatId = create 路径）。
- **多帧 zstd 会话日志**：`.jsonl.zstd` 是**多帧拼接**，`zlib.zstdDecompressSync` 只解第一帧；
  要按 zstd magic `28 B5 2F FD` 逐帧循环解（另见 2026-09-14 文档）。
- **判断入站是否到 agent**：看该 IM 会话的 `session.v3.jsonl.zstd` mtime 与内容里有没有
  `user/message`。正在使用的会话是实时落盘的，所以「静默」= 没跑。
- **判断通道链路**：`netstat -ano | Select-String "36.133.1.9"`（CMCC）/`120.204.0.108`（ilink，
  多条 A 记录里的一个），宿主 = 监听 `:3080` 的 node PID。
