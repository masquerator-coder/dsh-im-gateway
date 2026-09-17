# CMCC 5G 通道「连上但收不到入站」诊断记录（2026-09-14）

## 现象
- 用户通过 5G消息 通道发送消息，`dsh-im-gateway` 全程无回应。
- 本次现象发生在插件重新安装 + dsh 宿主重启之后；重启前 5G 通道工作正常。

## 实证结论
1. **通道 TCP/WebSocket 已连上**：`netstat -ano` 显示
   `TCP 192.168.0.77:<本地端口> → 36.133.1.9:443 ESTABLISHED`（`5gvas01.cmicmaap.com`），
   由当前宿主进程（持有 web GUI `:3080` 的 node PID）持有。多次采样端口稳定（本次未在重连轮换）。
2. **入站消息完全未到达 agent**：IM 会话日志
   `C:\Users\fuqia\.dsh\sessions\--C-Users-fuqia-.dsh-im-workspace--\im-ea06f4de58ccb1e0\session.v3.jsonl.zstd`
   的 mtime 自重启（22:54:11）起**零写入**，size 不变，且未产生任何新的 im 会话目录。
   只要入站消息到达 agent，日志必有 `user/message` / `turn/start` / `agent/inbox/spliced` 事件——现在完全没有。
3. **与审批修复（`{ prepend: true }`）无关**：修复只改 `approval/request` / `user-questions/request`
   的应答路由（让确认走 IM 而非 web），不触碰入站投递；且入站根本未到，修复无从触发。
   - 注：本次会话日志同时证明了此前「web 弹窗」正是 `ask_user_question`（`user-questions/request`）
     被 web 端应答（seq 41→42），确认了原修复目标成立。

## 判定
CMCC/5G **平台侧投递 / 会话绑定问题**：进程重启后新连接虽完成握手（ESTABLISHED），
平台未把该号码的入站消息重新投递/绑定到这条新连接。

## 待平台后台核实（用户执行）
- [ ] 该 bot / APIKey 在 5G 开放平台是否显示「在线」，订阅是否仍有效。
- [ ] 平台是否收到手机发送的消息，是否有转发/派发失败的记录。
- [ ] 是否因重启导致平台侧会话未重新绑定到新连接（旧连接已断开，消息仍路由向旧会话）。

## 附：本地排查手段（可复用）
- 解压多帧 zstd 会话日志：按 zstd magic `28 B5 2F FD` 分帧，`node:zlib` 的 `zstdDecompressSync` 逐帧解再拼接。
- 判断入站是否到达 agent：看该 IM 会话日志的 mtime 是否更新。
- 判定 CMCC 连接：`netstat -ano | Select-String 36.133.1.9`；宿主 = 持有 `:3080` 的 node PID。
- UI 显示「已配置」= host 未暴露 `imGateway` RPC 时的静态占位，不是通道故障标志。

## 处置后验证
若平台侧修复/确认后通道恢复，请复测：
1. 发普通消息「你好」→ 应有回复（验证入站投递恢复）。
2. 发「工作目录切换到AIWorkspace」→ 若触发 `ask_user_question`，确认该问题现在应通过 **5G 消息**发回手机
   （`{ prepend: true }` 已生效），而非 web 弹窗。
