# dsh-im-gateway 多通道管理 UI —— 设计文档

> 状态：设计阶段（待 client 插件打包/通信机制调研结果最终确认）
> 目标：在 DSH 设置页左侧列表最末新增"IM 通道"入口，点开后右侧选择/管理通道。
> 用户已决策：并入 dsh-im-gateway；左侧列表最末；首批可用通道 = 5G消息 + email + 通用HTTP，微信/QQ/飞书做占位+引导。

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

## 2.5 待确认（依赖调研子代理结果）
- [ ] 第三方插件通过 `dsh plugin add` 安装时，client half 是否自动随包分发并被 web 端发现（还是需要额外步骤，如替换 web bundle / client plugin host）。
- [ ] `ctx.remote` 的精确调用形态与"node half 如何注册远程命名空间"（`ctx.router`? 还是插件暴露 service）。
- [ ] `remote.credentials` 读写 API 精确签名。

## 3. UI 结构（目标形态）
设置页左侧最末新增「IM 通道」栏目 → 右侧面板：
- 上区：通道选择（微信 / QQ / email / 5G消息(中国移动新消息) / 飞书 / 通用HTTP 回调）卡片网格，加图标 + 标题 + 状态(未连接/已连接/占位)。
- 下区（选中某通道后）：
  - **5G消息**：填写 `apiKey` + `serverUrl`（默认预填），可选上传/扫码引导。
  - **email**：填写 SMTP/IMAP 服务器、账号、授权码、收发规则。
  - **通用HTTP**：既有 `callbackUrl`、`secret`、字段映射（chatIdField/textField…）。
  - 微信/QQ/飞书：占位卡 + "接入指引"文案（官方资质/扫码说明）。

## 4. 配置持久化
- 沿用 DSH settings 持久化：`ctx.remote.$host` / settings describe + ScopeBinder（client 端），经 `remote` 服务提交给宿主。
- 密钥字段用 `Schema.string().role('secret')`（与 dsh-cmcc-newmsg 的 apiKey 一致），避免明文进日志/回调。
- 本地覆盖层 cordis.local.yml 承载真实密钥，不入 Git。

## 5. 后端连接管理
- 复用现有：HTTP webhook（通用）已在 `src/`；5G消息 WebSocket（`dsh-cmcc-newmsg`）收编或作为通道实现。
- email：新增 SMTP/IMAP 收发实现（方案阶段）。
- 连接状态回传给 UI（每通道 connected/error/idle），UI 显示。
