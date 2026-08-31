# dsh-im-gateway 多通道管理 UI —— 设计文档

> 状态：**已实现**（本文档与 `src/channels/*`、`src/transports/*`、`src/client/*` 同步更新）。
> 目标：在 DSH 设置页左侧列表最末新增"IM 通道"入口，点开后右侧选择/管理通道。
> 用户已决策：并入 dsh-im-gateway；左侧列表最末；首批可用通道 = 5G消息 + email + 通用HTTP；微信/QQ/飞书随后实现为真实收发（非占位）。—— 现在六类通道全部真实收发。

## 1. 核心机制（已确认，基于 DSH checkout 源码）

### 1.1 设置页 = `sidebar.settings` slot
- 设置页整体由 `packages/client/ui-settings-general` 的 `SettingsRoot.tsx` 渲染（占据主侧栏底部的 `sidebar.settings` slot）。
- 设置页是**模态（modal）**面板：左侧 `nav`（Section 列表）+ 右侧 `content`（当前 section 面板）。

### 1.2 设置页左侧"栏目"= `settings.section` slot（list 类型）
- 每个 entry 选项：`id`（栏目键，驱动 `only` 过滤）、`order`（导航位置）、`label`（本地化显示文本）。
- `SettingsRoot` 把 `settings.section` ledger 投影成左侧导航行（按 order 排序），点击后以 `only: id` 渲染对应面板。
- **现有 entry 参考**：`GeneralSection`（id=`general`, order=`0`）；还有 models / agent-presets / plugins。
- 点开面板后右侧调用：`renderSlot('settings.section', { close }, { only: active })`。

### 1.3 注册方式（client 插件内）
```ts
ctx.slots.inject('settings.section', () => ctx.slots.register({
  name: 'settings.section',
  id: 'im-gateway',
  order: 100,            // 排在最末
  label: () => t('nav'), // 本地化
  locale: NS,
}, ImGatewaySection))
```
- 这是**受支持的标准扩展点**，第三方插件无需修改 DSH 内核即可新增设置页栏目。

## 2. client 插件分发机制（已确认，基于 DSH checkout 源码）
- **一个插件包可同时含 node half + browser/client half**：
  - node half：`main` = `lib/index.js`（宿主端 apply）。
  - client half：`exports["./client"]` = `lib/client.js`，通过 `package.json` 的 `dsh.client` 字段声明（含 `inject` 数组 + `platform: "web"`）。
- DSH 从 `package.json` 的 `dsh.client` 声明发现 client half，在 web 端自动加载。参考：`packages/client/ui-permission-presets`、`ui-plan`、`ui-cordis`。
- **client half 的 apply 是标准 Cordis client apply**，可：
  - `ctx.slots.inject('settings.section', () => ctx.slots.register({name,id,order,label,locale}, Component))` 增设置页栏目；
  - `ctx.locale.register(NS, {zh, en})` 本地化；
  - `ctx.remote.$on('...', cb)` 收宿主事件；
  - 调 `ctx.remote.<namespace>.<method>()` 走 RPC 到宿主。
- **持久化/通信**：client 通过 `ctx.remote.<ns>` 调 node half 暴露的远程命名空间；密钥走 `remote.credentials`；配置可走 `remote.settings` 或自定义 `remote.imGateway`。
- **构建**：内置包用 `tsdown` + `clientBundle`（`tsdown.config.ts`）；我们插件现有 esbuild（`scripts/build.mjs`）需扩展以同时产出 node 与 client 两个 bundle，且 client bundle 用浏览器平台（react/jsx），node bundle 用 node 平台。

## 2.5 已确认（实现结论）
- [x] **client half 随包分发**：esbuild `scripts/build.mjs` 同时产出 `lib/index.js`（node）与 `lib/client.js`（browser CJS factory），浏览器平台 seed 经 `window.__ModuleLoader__.load({id, factory})` 加载 client half。
- [x] **`ctx.remote` RPC 形态**：node half 用 `ctx.remote.define('imGateway', () => ({ list }))` 注册远程命名空间；client half 经 `remote.imGateway.list()` 轮询拉取通道状态快照（`statusList()` 含 status/detail/qr）。
- [x] **密钥与回显分离**：通道记录存放于 `im-channels` settings 作用域，密钥字段用 `role('secret')`，宿主 transports 经 settings scope 读回；client 端 describe 永不回传密钥（空值 = 保留已存值）。

## 3. UI 结构（已实现）
设置页左侧最末新增「IM 通道」栏目 → 右侧面板：
- 左列："新建通道"六类按钮（微信 / QQ / email / 5G消息 / 飞书 / 通用HTTP），下方"已配置"通道列表（名称 + 类型 + 实时状态）。
- 右列（选中某通道/新建时）：**状态行**（类型 · 实时连接状态 + 错误详情）、名称、该类型的**傻瓜式配置表单**、保存/删除。
  - **5G消息**：只填 `apiKey`；`serverUrl`、`version` 预填模板自动带入。
  - **email**：先选邮箱服务商（QQ/163/Gmail/Outlook/企业微信/自定义），已知服务商自动填 host/IMAP/SMTP/TLS，用户只填账号 + 授权码；选"自定义"时显示 host/端口字段。
  - **通用HTTP**：填 `callbackUrl` + 可选 `secret`；`inboundPath`/字段映射预填。
  - **飞书**：只填 App ID + App Secret（长连接）。
  - **微信**：填 clawbot 网关地址（预填） + token；显示伴生网关登录 QR。
  - **QQ**：留空即扫码登录——登录 QR 由宿主经 RPC 回传并在面板内显示。

## 4. 配置持久化
- 通道记录存于 `im-channels` settings 命名空间（`ChannelsSettingsSchema`），client 经 settings scope 提交，宿主经 settings scope 读取。
- 密钥字段用 `Schema.string().role('secret')`（与 dsh-cmcc-newmsg 的 apiKey 一致），描述/回显时被框架抹除，宿主 transports 从 settings scope 直接读回。
- 本地覆盖层 cordis.local.yml 承载真实密钥，不入 Git。

## 5. 后端连接管理（已实现）
- 六类通道各有一个真实 transport（`src/transports/*.ts`）：
  - `http.ts`：共享 `InboundHttpServer` 的按路径注册 webhook 路由，回复 POST 回 callbackUrl。
  - `cmcc.ts` + `cmcc/smsClient.ts`：WebSocket 接中国移动 新消息/5G消息 网关（X-API-Key 头 + auth 握手 + 心跳 + 断线重连）。
  - `email.ts`：`nodemailer` 发（SMTP）+ `imapflow` 收（IMAP 轮询 INBOX，uid 去重）。
  - `feishu.ts`：官方 `@larksuiteoapi/node-sdk` WebSocket 长连接事件服务。
  - `wechat.ts`：clawbot 伴生网关的轻量 HTTP 客户端（/health·/receive·/send·/qr）。
  - `qq.ts`：`icqq` bot（扫码或密码登录，群/私聊均可收发）。
- **连接状态回传**：`ChannelManager` 维护每通道 status（idle/connecting/connected/error）+ detail，`remote.define('imGateway', { list })` 暴露 `statusList()`（含新增的 `qr`），client 每 3s 轮询拉取并渲染；QQ/微信的登录 QR 经同一 RPC 的 `qr` 字段回传到 UI 显示。
