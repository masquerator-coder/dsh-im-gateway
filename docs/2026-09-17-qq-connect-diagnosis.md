# 「QQ 连不上」诊断与修复记录（2026-09-17）

## 现象
- 面板「IM 通道设置」里 QQ 通道从未真正连上：本机当时**还没有配过 QQ 通道**（`settings.yaml` 里只有 cmcc + wechat），也**还没有 q.qq.com 的机器人**。
- 因此「QQ 连不上」不是入站/回复阶段的问题，而是**建连阶段**的问题；而旧实现恰恰在**建连阶段的每一种失败上都不说话**。

## 证据链（这次是「官方协议对账 + 代码审计」，不是猜）

1. **现场事实：QQ 从未有消息进入 gateway。**
   - `~/.dsh/settings.yaml` 的 `im-channels` 只有两条记录（cmcc / wechat），没有任何 qq 记录；
   - `~/.dsh/im-workspace/` 下只有一个 `wechat-state/<channelId>.json`（微信扫码绑定状态），QQ 没有状态文件（它本来也不需要）；
   - `~/.dsh/sessions/--C-Users-fuqia-.dsh-im-workspace--/` 下三个 IM 会话的 `<dsh_im_source>` 分别是 `http`(诊断探针) / `wechat`(测试消息一、三) / `cmcc`(测试消息二、4) —— **没有 qq**。
   - 结论：问题只可能出在「AppID/AppSecret → AccessToken → /gateway → WebSocket 鉴权」这一段。

2. **官方文档对账（文档在 2026-09-16 / 09-17 刚更新过），逐条与旧代码不一致：**

   | 官方口径 | 旧代码 | 后果 |
   | --- | --- | --- |
   | 统一请求地址 `https://api.bot.qq.com`（token 也在 `api.bot.qq.com/app/getAppAccessToken`） | 默认 `https://api.sgroup.qq.com`、token 用 `https://bots.qq.com/...` | 实测两个域名**都还在服务**（都返回 `{"code":10004,"message":"机器人不存在"}`），所以不是致命项，但默认值该更新 |
   | 失败可能返回 **HTTP 200** + `{code,message}`（如 `100016 invalid appid or secret`） | 只检查 `resp.ok` 与 `access_token` 是否存在 | 把「AppID/AppSecret 不正确」报成 `qq bot token missing in response`，用户往网络/协议方向查 |
   | `/gateway` 失败返回 401 + `{code:11244,...}`、权限类 `11253` | 只判断响应里有没有 `url` | 报成 `qq bot gateway url missing`，真实原因被吞 |
   | **只有 `guilds` / `public_guild_messages` / `guild_members` 默认有权限**；其余事件必须申请；「如果鉴权时传递了无权限的 intents，websocket 会报错，并直接关闭连接」 | IDENTIFY 固定 `(1<<25)C2C/群聊 \| (1<<30)公域频道@ \| (1<<12)频道私信` | 一个只做单聊/群聊的机器人，只要没有「频道私信」权限就**必然被网关以 4013/4014 秒断** |
   | 关闭码语义：4006/4007/4008/4009 可重试（4009 应 RESUME）、**4013/4014/4914/4915 不可重试** | 忽略关闭码，一律指数退避重连（封顶 60s） | 永远「重连中」，真正的原因只在 `ctx.logger.info` 里滚过去 |
   | 被动回复：`msg_id` **5 分钟**有效、同一条入站消息最多**回 5 次**、`msg_id`+`msg_seq` 重复发送会失败（`40054005 消息被去重`）、超长报 `40054007` | 只带 `msg_id`，不带也不递增 `msg_seq`，且**完全不看发送响应** | 长回复可能整条失败；重试被判重复；失败无人知 |

   （出处：[事件订阅 Intents](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/payload.html)、[WebSocket 方式](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html)、[WebSocket 错误码](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/error-trace/websocket.html)、[获取访问凭证](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html)、[API 调用指南](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/api-call-guide.html)、[发送群聊消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)）

3. **代码审计（旧 `src/transports/qqbot.ts`）确认四类缺陷，与微信那次是同一类病：**
   - **失败不可见**：关闭原因只进日志，`scheduleReconnect` 又把状态刷回 `connecting`，面板永远「QQ bot 网关重连中…」。
   - **「已连接」不可证伪**：`op=11 Heartbeat ACK` 从不跟踪，`readyState === OPEN` 就等于已连接 → 半开连接（睡眠/换网后没有 FIN）会一直绿着（与 CMCC 那次同类）。
   - **发送静默丢失**：`sendText` 不解析响应；更糟的是**网关的故障回执也走同一个 sink**，而缺少递增 `msg_seq` 会被判重复(40054005)，于是「⚠️ 处理失败」这类回执在 QQ 上也发不出去。
   - **两处错路**：`DIRECT_MESSAGE_CREATE` 的回复打到 `/v2/users/{guild_id}/messages`（应为 `/dms/{guild_id}/messages`）；没有 RESUME，断线期间的事件全丢。

## 根因
QQ 通道此前**从未被真机验证过**（无配置、无会话、无日志），实现停留在四个乐观假设上：机器人已过审、intents 都有权限、socket 一直活着、发送一定成功。真机上任何一条不成立时，插件都**不会说出来**——这就是「QQ 连不上」的全部内容。

## 修复（本次提交）

1. **握手结果决定成败**：`start()` 只在收到 `READY`/`RESUMED` 后 resolve；`4013/4014/4914/4915`、`100007/100016/10004/11253` 等**不可重试**失败 → 面板 `error` + 中文原因 + **下一步怎么做**（如「去 q.qq.com 申请单聊/群聊权限」），并**停止重连**（配置改好后重新保存通道即会重连）。
2. **默认 intents = `c2c + public_guild`**（不再索要需申请的 `direct`），并新增通道字段 `intents`（关键字 `c2c,public_guild,direct,interaction,…` 或十进制位掩码），写错会在保存时报错而不是等网关秒断。
3. **心跳 ACK 看门狗**：每个心跳周期检查「最近是否收到任何帧」，超过 `2×心跳周期 + 5s` 就强制断开重连（关掉半开连接）。
4. **RESUME**：保存 `session_id` + `seq`；`4009` 等可恢复关闭码带 RESUME 重连（由网关补发遗漏事件），`4006/4007` 等退回 IDENTIFY。
5. **发送侧真正校验**：解析 `err_code`/`code`（含 HTTP 200 的失败）、错误码翻译成中文、`msg_seq` 按 `msg_id` 递增（新增入站消息则重置）、长回复按 ~900 字切分（最多 5 条，超出显式标注「已截断」）、被动窗口过期时自动改发一条主动消息兜底、`40054005` 视为**已送达**（避免把成功当失败）、`DIRECT_MESSAGE` 改打 `/dms/...`。
6. **端点与配置面**：默认改为官方 2026-09 口径的 `https://api.bot.qq.com`（旧域名仍可用，老记录不用改）；面板里 AppID 改为**非机密**并纳入必填（原来被当机密，保存后看不见也改不掉）；新增 `intents` 字段与接入步骤文案（含 4014 的解释）。
7. **网关层**：投递失败时把 sink 的**真实原因**带上面板（`回复未能投递到通道：<原因>`），不再只有一句无从下手的「回复未能投递到通道」。
8. **真机探针**：新增 `scripts/qq-probe.mts`（`pnpm qq-probe <appId> <appSecret>`），不进宿主直接跑「取票 → 取网关 → 鉴权 → 收消息 → 被动回复」，把平台原话打印出来。

## 验证

**离线（已通过，`pnpm smoke`）** —— 用假 token 服务 + 假 `/gateway` + 真 `ws` 服务端（`scripts/smoke.mts` 第 11/12 节）：

- 缺 AppID/AppSecret → 直接以中文原因失败，不建 socket；
- token 失败返回 `{code:100016}` → 面板拿到 `AppID 或 AppSecret 不正确`（含 code），且**不**打开 socket；
- 正常路径：默认 intents 不含 `1<<12`、握手头正确、心跳发出、C2C 入站派发、被动回复带 `msg_id` + `msg_seq=1/2`；
- 发送失败（`40054007`）→ 抛错（而不是静默）；`40054005` → 视为已送达；被动窗口过期（`40034005`）→ 自动改发主动消息；
- `4014` → start 以真实原因失败、面板拿到「去 q.qq.com 申请」的提示，且 **1.2 秒内不再重连**（无热循环）；
- 心跳无人应答 → 看门狗报「心跳无响应」并强制重连（出现第二条 WebSocket 连接）；
- `4009` 断开 → 重连时发 `op=6 RESUME`（带 `session_id` 与 `seq=1`），而不是重新 IDENTIFY。

**真机（部分已通过）** —— `pnpm qq-probe 10000001 <假密钥>` 打真实 `api.bot.qq.com`：

```
[transport] qq bot connect failed: 获取 QQ AccessToken 失败：AppID 对应的机器人不存在（code 10004） —— 请核对 AppID / AppSecret（q.qq.com → 开发设置）后重新保存本通道
```

即「取票失败 → 中文原因 + 平台错误码」这条新链路在真网络上确实成立（旧代码在这里只会说 `token missing in response`）。

**待你实测（本机没有可用的机器人凭证）** —— 在 q.qq.com 创建机器人并填 AppID/AppSecret 后：

```sh
pnpm qq-probe <appId> <appSecret>          # 期望：✅ 已连接（READY）
pnpm qq-probe <appId> <appSecret> --ints public_guild   # 只想先验证链路（默认有权限的事件）
```

若报 `4014`：机器人还没拿到「单聊 / 群聊」事件权限 → 去 q.qq.com 申请并提审；提审通过后重新保存通道即可（不可重试的失败会停止重连，不会自愈）。

## 可复用的本地排查手段

- **QQ 真机探针**：`pnpm qq-probe <appId> <appSecret> [--ints …] [--sandbox] [--seconds 90] [--no-reply]`
  （不进宿主，直接打印取票/取网关/鉴权/收消息每一步的结果；不打印 AppSecret / AccessToken）。
- **关闭码速查**：`4006/4007` 需重新 IDENTIFY、`4008` 触发频控、`4009` 连接过期（RESUME 可补发）、
  `4013` intents 不合法、`4014` intents 无权限（去申请）、`4900~4913` 网关内部错误（可重连）、
  `4914` 已下架（只允许沙箱）、`4915` 已封禁（不可重试）。
- **错误码速查**：`100007/100016/10004` AppID/AppSecret 或机器人状态问题；`11244` token 失效（会自动刷新重试一次）；
  `11253` 接口无权限；`304103/40034005/40034128` 被动回复过期/超次；`40054005` 消息被去重（= 已送达）；
  `40054007` 内容超长；`304018` 机器人没连上网关。
- **判断入站是否到达**：看 `~/.dsh/sessions/--C-Users-fuqia-.dsh-im-workspace--/im-<hash>/session.v3.jsonl.zstd` 的
  mtime 与内容里有没有 `user/message`（正在使用的会话是实时落盘的，「静默」= 没跑）。
- **多帧 zstd 会话日志**：`.jsonl.zstd` 是**多帧拼接**，`zlib.zstdDecompressSync` 只解第一帧；要按 zstd magic
  `28 B5 2F FD` 逐帧循环解（另见 2026-09-14 与 2026-09-17 的另两份文档）。
