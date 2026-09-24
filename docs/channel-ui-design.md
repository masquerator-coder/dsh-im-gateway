# dsh-im-gateway 多通道管理 UI —— 设计文档

> 状态：**已实现**（本文档与 `src/channels/*`、`src/transports/*`、`src/client/*` 同步更新）。
> 目标：IM 通道管理面板出现在 DSH **侧栏「插件」页**中，作为**本组合包自己那张卡片**的页面内容（「插件 → `dsh-im-gateway`」）。
> 用户已决策：并入 dsh-im-gateway；首批可用通道 = 5G消息 + email + 通用HTTP；微信/QQ/飞书随后实现为真实收发（非占位）。—— 现在六类通道全部真实收发。

## 变更沿革（入口的两次搬迁）

| 版本 | 挂载点 | 结果 |
| --- | --- | --- |
| 初版 | `settings.section`（设置面板左侧导航多一行「IM 通道」） | 占用设置页导航，与其他插件不一致 |
| 二版 | `settings.plugin.item`（「插件 → 插件设置」里一张可展开卡片，键 = settings 命名空间） | 视觉与系统插件卡一致 |
| **当前** | **`plugins.bundle.config`（「插件」页里本组合包页面上的配置区，键 = 包名）** | 上游退役了 `settings.plugin.item`，本版跟随新扩展点 |

## 1. 核心机制（已确认，基于 DSH 0.1.6-alpha.2 checkout 源码）

### 1.1 设置页 = `sidebar.settings` slot
- 设置页整体由 `packages/client/ui-settings-general` 的 `SettingsRoot.tsx` 渲染（占据主侧栏底部的 `sidebar.settings` slot）。
- 设置页是**模态（modal）**面板：左侧 `nav`（Section 列表）+ 右侧 `content`（当前 section 面板）。

### 1.2 插件配置页 = 「插件」页的 `plugins.bundle.config` slot（keyed 类型）
- 上游提交 `90af3110b7 feat(web): host plugin configuration on the Plugins page` 把**插件配置从设置面板搬到了侧栏「插件」页**，并**删除 `settings.plugin.item`**：
  - `ui-settings-plugins` 删除 `ConfigurablePluginsTab.tsx`、`PluginCard.tsx`、`tab-store.ts`、`slot-contract.ts`；
  - 该包的 `settings.section`（id=`plugins`）退化为**只读插件清单**外壳（「内置插件」，唯一的 tab 是 `ui-settings-plugin-inventory` 的插件列表）；
  - 新增 `packages/client/ui-plugin-manager/src/client/slot-contract.ts`，由「插件」页声明三个 slot：
    - `plugins.item`（list）：**宿主平面官方插件**的配置页，列在 Official 分组（被 `ui-settings-plugins` 占用于 shell / agent-loop / subagent / web-search 四个页面）；
    - `plugins.bundle.config`（keyed，键 = **组合包包名**）：组合包自己的配置，渲染在该组合包页面里（描述与行列表之间）；
    - `plugins.row.config`（keyed，键 = `<包名>#<行 id>`）：单行配置，该行因此多出一个「配置」控件。
- 派发逻辑（`ui-plugin-manager/src/client/config-ledger.ts` + `PluginManagerPage.tsx`）：`configLedgerSource` 把三份 slot 账本投影成一个可观察对象；页面按 `entry.options.key === pkg.name` 找到本包条目，且仅当该组合包**已开启**时才渲染，所以关掉的组合包不留配置控件痕迹。
- **两种视图**：页面通过 owner props 向每个条目索取两次——`view: 'summary'` 是卡片标题下的一句话简介，`view: 'page'` 是插件页面里的表单本体。**。页面自己画标题、图标与面包屑。

### 1.3 注册方式（client 插件内）
```ts
ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
  name: 'plugins.bundle.config',
  key: 'dsh-im-gateway',   // 必须逐字等于 package.json 的 name
  locale: NS,
  inject: () => ({ scope, t }),
}, ChannelsConfigEntry))
```
- 键必须**逐字等于包名**：页面用 `entry.options.key === pkg.name` 配对，键漂移会让面板**静默消失**（既不报错也不打印日志）。
- 注册与组合包的浏览器半侧同生共死：插件行关掉 → 浏览器半侧卸下 → 面板一并消失。

### 1.4 为什么不再用 `settings.plugin.item`
该 slot 在新版 DSH 中**没有任何插件声明**。往未声明的 slot 注册时，`ctx.slots.inject(...)` 的回调**永不执行**，且不抛错、不打印——症状正是「设置界面里什么都看不到」。`scripts/smoke.mts` 第 14 项因此在**构建产物** `lib/client.js` 上断言：必须含 `plugins.bundle.config`、不得含 `settings.plugin.item`（构建产物才是浏览器真正加载的东西，且 `.tsx` 无法被 smoke 的 `--experimental-transform-types` 加载）。

## 2. client 插件分发机制（已确认，基于 DSH checkout 源码）
- **一个插件包可同时含 node half + browser/client half**：
  - node half：`main` = `lib/index.js`（宿主端 apply）。
  - client half：`exports["./client"]` = `lib/client.js`，通过 `package.json` 的 `dsh.client` 字段声明（含 `inject` 数组 + `platform: "web"`）。
- DSH 从 `package.json` 的 `dsh.client` 声明发现 client half，在 web 端自动加载。
- **client half 的 apply 是标准 Cordis client apply**，可：
  - `ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({name,key,locale,inject}, Component))` 把本包的配置渲染到「插件」页本组合包的页面上；
  - `ctx.locale.register(NS, {zh, en})` 本地化；
  - `ctx.remote.$on('...', cb)` 收宿主事件；
  - 调 `ctx.remote.<namespace>.<method>()` 走 RPC 到宿主。
- **持久化/通信**：client 通过 `ctx.remote.<ns>` 调 node half 暴露的远程命名空间；密钥走 `remote.credentials`；配置走 `settingsScope`。**真实连接状态**改为经同源 web 路由 `/im-gateway/status` 拉取（见 §6）。
- **构建**：内置包用 `tsdown` + `clientBundle`；我们插件用 esbuild（`scripts/build.mjs`）同时产出 node 与 client 两个 bundle。client half 保持对宿主组件的零耦合——面板用内联样式 + 同一 `--dsw-alias-*` 设计令牌，卡壳与页面骨架由「插件」页自己画（见 `ChannelsCard.tsx` 顶部注释）。

## 2.5 已确认（实现结论）
- [x] **client half 随包分发**：esbuild `scripts/build.mjs` 同时产出 `lib/index.js`（node）与 `lib/client.js`（browser CJS factory）。
- [x] **状态回传形态**：原设计（`ctx.remote.define('imGateway', …)` + client 轮询）**在树外插件上行不通**（Remote namespace 是 Typert 生成的封闭清单，`requireStrictDescriptor` 拒绝树外描述符），已改为 node half 用 `ctx.webServer.register` 注册同源路由 `GET /im-gateway/status`，client 每 3s 轮询（见 §6）。
- [x] **入口形态**：不再占用设置页导航，也不再是「插件设置」里的一张自绘展开卡；改为向 `plugins.bundle.config` 注册一条以**包名**为键的条目（`ChannelsConfigEntry`），由「插件」页在**本组合包页面**上按 `summary` / `page` 两视图渲染。
- [x] **密钥与回显分离**：通道记录存放于 `im-channels` settings 作用域，密钥字段用 `role('secret')`，宿主 transports 经 settings scope 读回；client 端 describe 永不回传密钥（空值 = 保留已存值）。

## 3. UI 结构（已实现）
「插件」页 → 已安装分组 → **`dsh-im-gateway`** 卡片 → 打开该组合包页面，配置区（描述与行列表之间）即：
- 配置区顶部（两列之上）为**全局默认工作目录**（section 级字段 `im-channels.cwd`）：未单独设置 `cwd` 的通道都用它，通道自己的设置优先；留空则退回 `cordis.yml` 的 `cwd`，再退回 `~/.dsh/im-workspace`。宿主在**每条入站消息到达时**解析，因此保存它不会重启任何通道。因为 DSH 会话的 cwd 在创建时即固定（resume 只还原持久化会话头，`workspaceRegistry.attachSession()` 还会拒绝把 cwd 不一致的会话挂到工作区上），**改工作目录会让该聊天在下一轮消息时于新目录里开始新会话**，旧会话仍留在原工作区（网页端可打开）；从未配置过工作目录的聊天 session id 保持不变。
  - 该输入框旁有 **浏览…** 按钮（section 级与通道级 `cwd` 各一个），打开面板内目录选择器：面包屑 + 子目录列表 + 上级 / 刷新 + 常用位置快捷方式（用户目录 / 插件 `cwd` / `~/.dsh/im-workspace`）。选中即回填输入框，仍需点「保存」才写入宿主。
- 工作目录参与会话身份：`sessionIdForChat(chatId, channel, cwd)` → 有显式配置时用 `sha1("<channel>:<chatId>@<cwd>")`，否则保持历史的 `sha1("<channel>:<chatId>")`（老会话不被重置）。
- 卡片标题下的一句话简介来自 `summary` 视图（`card.description`）；卡片标题本身是**包名** `dsh-im-gateway`，由「插件」页绘制，本插件不再自绘卡壳。
- 左列："新建通道"六类按钮（微信 / QQ / email / 5G消息 / 飞书 / 通用HTTP），下方"已配置"通道列表（名称 + 类型 + 实时状态）。
- 右列（选中某通道/新建时）：**状态行**（类型 · 实时连接状态 + 错误详情）、名称、该类型的**傻瓜式配置表单**、保存/删除。
  - **5G消息**：只填 `apiKey`；`serverUrl`、`version` 预填模板自动带入。
  - **email**：先选邮箱服务商（QQ/163/Gmail/Outlook/企业微信/自定义），已知服务商自动填 host/IMAP/SMTP/TLS，用户只填账号 + 授权码；选"自定义"时显示 host/端口字段。
  - **通用HTTP**：填 `callbackUrl` + 可选 `secret`；`inboundPath`/字段映射预填。
  - **飞书**：只填 App ID + App Secret（长连接）。
  - **微信**：填 ilink 网关地址（预填 `https://ilinkai.weixin.qq.com`）+ token（可选，绑定后自动回填）；显示官方 ilink 登录 QR，扫码绑定。
  - **QQ**：官方机器人，填 AppID/AppSecret + botApiBase（默认 `https://api.sgroup.qq.com`，可切沙箱），走官方 WebSocket 网关。

## 4. 配置持久化
- 通道记录存于 `im-channels` settings 命名空间（`ChannelsSettingsSchema`），client 经 settings scope 提交，宿主经 settings scope 读取。
- 同一命名空间**根字段** `cwd` = 插件级全局默认工作目录：client 用 `scope.set('cwd', …)` 提交，宿主经 `ChannelManager.defaultCwd()` 实时读取，与通道自身的 `cwd` 一起由 `resolveChannelCwd()` 决定实际工作目录（通道优先）。
- 密钥字段用 `Schema.string().role('secret')`（与 dsh-cmcc-newmsg 的 apiKey 一致），描述/回显时被框架抹除，宿主 transports 从 settings scope 直接读回。
- 本地覆盖层 cordis.local.yml 承载真实密钥，不入 Git。

## 5. 后端连接管理（已实现）
- 六类通道各有一个真实 transport（`src/transports/*.ts`）：
  - `http.ts`：共享 `InboundHttpServer` 的按路径注册 webhook 路由，回复 POST 回 callbackUrl。
  - `cmcc.ts` + `cmcc/smsClient.ts`：WebSocket 接中国移动 新消息/5G消息 网关（X-API-Key 头 + auth 握手 + 心跳 + 断线重连）。
  - `email.ts`：`nodemailer` 发（SMTP）+ `imapflow` 收（IMAP 轮询 INBOX，uid 去重）。
  - `feishu.ts`：官方 Lark/Feishu SDK WebSocket 长连接事件服务；SDK 不随依赖安装，而是构建期 vendored 到 `lib/vendor/lark-sdk.cjs`（其传递依赖 `protobufjs` 带 postinstall，会让 `dsh plugin add` 在干净 profile 上失败），运行时按计算路径懒加载。
  - `wechat.ts`：直连官方 ilink 机器人网关（`https://ilinkai.weixin.qq.com`）——扫码绑定 + getupdates 轮询 + sendmessage（参考 dsh-clawbot）。
  - `qqbot.ts`：官方 QQ bot 网关（appId/appSecret → token → `api.sgroup.qq.com/gateway` → WebSocket，C2C/群收发）。

## 6. 连接状态回传（已实现）
- `ChannelManager` 维护每通道 status（idle/connecting/connected/error）+ detail。
- node half 用 `ctx.webServer.register` 注册同源路由 **`GET /im-gateway/status`**（`src/status-route.ts`），守卫复用 `/api` 的浏览器鉴权检查、`cache-control: no-store`、只读（非 GET/HEAD 返回 405 + `Allow: GET`），payload 形状由 `src/status-proto.ts` 固定（含 `qr` 与 `bound`）。
- client 每 3s 轮询该路由，文档隐藏时暂停、恢复可见时立即拉一次；QR 由本地 `qrcode-generator` 编码成 SVG（网关返回的是 HTML 页面 URL，不是图片）。
- 之所以不用 `ctx.remote`：见 §2 的已确认结论（树外插件无法发布 Remote namespace）。

### 6.1 目录浏览路由（`浏览…` 按钮的后端）

- node half 再注册一条同源只读路由 **`GET /im-gateway/browse?path=<abs>`**（`src/status-route.ts` 的 `createBrowseHandler`，纯逻辑在 `src/browse-route.ts`），与状态路由并列。两路由共用同一套准入规则（`admit()`）：**守卫缺失或抛异常一律 401（fail closed）**、非 GET/HEAD 一律 405 + `Allow: GET`、`cache-control: no-store`。
- **为什么必须由宿主列目录**：用户要选的是 **Agent 真正运行的那台机器**上的目录 = 宿主进程，未必是浏览器所在机器。`<input webkitdirectory>` 只能拿到用户选中的**文件**（拿不到目录树），File System Access API 仅 Chromium 且每个根目录都要一次用户手势，原生对话框在 DSH 远程部署时浏览的是**浏览器**那台机器——三者都不成立。
- 语义（`src/status-proto.ts` 的 `BrowsePayload`）：只列**目录**（按 name 排序，各带绝对路径）；根目录 `parent: null`（否则「上级」在根上是永远无效的按钮）；`..` 先 `resolve` 再列（路径穿越无法操纵读取）；**失败是有内容的正常结果**——HTTP 200 + `error` + `entries: []`（把「目录不存在 / 不是目录 / 无权限」渲染成空列表，等于告诉用户"目录是空的"，是 typo 最糟的呈现）；列得出来但进不去的目录仍然显示（`readable: false`，置灰不可点），隐藏它会让存在的目录看起来不存在。
- client 侧纯逻辑在 `src/client/browse-client.ts`（URL 构造、不可信 payload 收窄、面包屑、保存前校验），UI 在 `src/client/DirectoryBrowser.tsx`。面包屑**按字符串**推导而非用 `node:path`：浏览器里没有 `node:path`，且宿主与页面的分隔符可能不同，宿主返回的字符串才是唯一权威。
- `scripts/smoke.mts` 第 17 项在**真实临时目录**上验证：文件不被列出、失败被报出而非吞成空列表、根无 parent、快捷方式去重（Windows 大小写不敏感）、守卫 fail closed 且拒绝时不泄漏任何目录名、method guard、roots 视图、`?path=` 重复时取首值。
