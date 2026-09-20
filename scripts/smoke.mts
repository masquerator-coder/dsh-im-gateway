#!/usr/bin/env node
/**
 * dsh-im-gateway runtime smoke test.
 *
 * Verifies the pieces that can run without a live DSH host or external IM
 * services:
 *   1. sessionIdForChat — deterministic per-chat agent session-id strings, with
 *      the legacy (no channel / no working directory) keys frozen and an
 *      explicitly configured working directory folded into the identity.
 *   2. InboundHttpServer — POST a message to a registered route, confirm parse
 *      + dispatch + 202 ack, and the 404 / 401 guard rails.
 *   3. HttpTransport — the per-channel reply callback receives the payload.
 *   4. CmccTransport — constructing the WS client wires up, and connecting to an
 *      unreachable endpoint surfaces a clear error (bounded by a timeout).
 *   5. FeishuTransport — the VENDORED Feishu SDK (lib/vendor/lark-sdk.cjs, not
 *      an npm dependency) resolves and still exports Client / WSClient /
 *      EventDispatcher, and missing credentials fail before any socket opens.
 *   6. WechatIlinkTransport — against a local fake ilink gateway: a channel that
 *      has a (manually pasted) bot_token but no bound WeChat account must STILL
 *      request the login QR and report "token present, not bound yet" instead of
 *      claiming to be connected, and must refuse to send.
 *   7. ImGateway.composePrompt — the `<dsh_im_source>` block is prepended ONLY
 *      when the source changes for that session (first message, sender/channel
 *      change, or after a compaction shadowed the span that carried it), so a
 *      steady sender no longer repeats the block on every bubble.
 *   8. qrSvgFor — the login QR is encoded locally from the bind URL the gateway
 *      reports (that field is an HTML page URL, not an image), with the white
 *      background and scalable viewBox the panel relies on.
 *   9. createStatusHandler — the panel's only link to the host. It is a web
 *      route rather than a Remote namespace (those are generated and closed to
 *      out-of-tree plugins): payload shape, auth gate, method guard.
 *  10. WechatIlinkTransport (bound) — liveness and inbound extraction against a
 *      local fake gateway with its own state dir: a bound channel whose round
 *      trips all fail must stop reporting "connected" (the panel used to say
 *      已连接 while every message was lost), recovery must report connected
 *      again, and only the bound user's text frames may be dispatched.
 *  11. QQBotTransport — against a local fake QQ Open Platform (token endpoint +
 *      /gateway + a real `ws` server): credential errors surface the platform
 *      code instead of a vague message and do NOT hot-loop; the default IDENTIFY
 *      never asks for the approval-only DIRECT_MESSAGE intent; an inbound C2C
 *      frame is dispatched; passive replies carry msg_id + a fresh msg_seq; a
 *      4014 (intent 无权限) close is reported as the real reason and stops
 *      reconnecting; a gateway that stops answering heartbeats is force
 *      reconnected; and send errors are surfaced (never silently swallowed).
 *  12. QQ intent/close-code helpers — parseIntents / diagnoseClose / chunkText /
 *      apiFailure, the pure parts the transport's honesty depends on.
 *  13. Default working directory — resolveChannelCwd (a channel's own `cwd`
 *      beats the plugin-wide default from the settings card) and the
 *      `im-channels.cwd` schema field itself.
 *  14. The client half's registration target — the built `lib/client.js` must
 *      register into `plugins.bundle.config` (keyed by the package name) and
 *      must no longer reference the retired `settings.plugin.item`. A stale
 *      target fails SILENTLY (the slot is never declared, so `ctx.slots.inject`
 *      waits forever and prints nothing), which is exactly why it is asserted.
 *      Asserted on the BUILT bundle rather than on the source: `.tsx` modules
 *      cannot be loaded by `node --experimental-transform-types`, and the
 *      bundle is what the browser actually executes.
 *
 * Real transports that need live services (email / feishu / wechat / qq / a
 * live CMCC gateway) are exercised by starting them in the plugin; this file
 * only proves the plumbing that validates them.
 *
 * Run:  node --experimental-transform-types scripts/smoke.mts
 */

import { createServer } from 'node:http'
import assert from 'node:assert/strict'

// Unbuffered progress marker (stderr) so a kill/timeout still shows where we are.
const step = (s) => { process.stderr.write(`[smoke] ${s}\n`) }

const withTimeout = (p, ms, label) =>
  Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), ms)),
  ])

/** Poll a predicate until it holds (or fail the smoke run). */
const waitUntil = async (predicate, ms, label) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`${label} did not happen within ${ms}ms`)
}

// --- 1. session id hashing (pure, no live deps) ---
const { sessionIdForChat } = await import('../src/session.ts')
const a = sessionIdForChat('chat-123')
const b = sessionIdForChat('chat-123')
const c = sessionIdForChat('chat-456')
assert.equal(a, b, 'same chat -> same session id')
assert.notEqual(a, c, 'different chat -> different session id')
assert.ok(String(a).startsWith('im-'), 'session id stamped with im- prefix')
// Frozen legacy keys: the digest seeds for a chat with no configured working
// directory must stay byte-identical, or every live IM chat silently resets.
assert.equal(sessionIdForChat('chat-123'), 'im-1bc8e29e57550e2a', 'the bare chatId key must not change')
assert.equal(sessionIdForChat('chat-123', 'cmcc'), 'im-2280b012dec09004', 'the channel-scoped key must not change')

// An explicitly configured working directory scopes the conversation: DSH pins
// a session's cwd at creation (resume restores the persisted header and the
// workspace registry refuses to attach a session whose cwd differs), so another
// directory has to be another session — resuming the old one is what made a
// changed working directory look ignored.
const scoped = sessionIdForChat('chat-123', 'cmcc', 'C:\\work\\im')
assert.notEqual(scoped, sessionIdForChat('chat-123', 'cmcc'), 'a configured cwd must start its own conversation')
assert.equal(scoped, sessionIdForChat('chat-123', 'cmcc', 'C:\\work\\im'), 'stable for the same directory')
assert.notEqual(scoped, sessionIdForChat('chat-123', 'cmcc', 'C:\\work\\other'), 'another directory is another conversation')
assert.equal(
  scoped,
  sessionIdForChat('chat-123', 'cmcc', '  C:\\work\\im\\  '),
  'surrounding whitespace / a trailing separator name the same workspace',
)
assert.notEqual(
  sessionIdForChat('chat-123', 'cmcc', 'C:\\'),
  sessionIdForChat('chat-123', 'cmcc', 'C:'),
  'a drive root must not collapse into a drive-relative path',
)
step(`sessionIdForChat OK: ${a}`)

// --- 1b. email reply-address parsing (compound chatId -> real recipient) ---
const { recipientOf } = await import('../src/transports/email.ts')
assert.equal(recipientOf('you@x.com/sender@foo.com'), 'sender@foo.com', 'compound chatId resolves to sender')
assert.equal(recipientOf('sender@foo.com'), 'sender@foo.com', 'plain chatId passes through')
step('email recipientOf OK')

// --- 2 + 3. HTTP route -> dispatch -> reply callback round-trip ---
const { InboundHttpServer } = await import('../src/inbound.ts')
const { HttpTransport } = await import('../src/transports/http.ts')

const replies = []
const callbackServer = createServer((req, res) => {
  let body = ''
  req.on('data', (d) => (body += d))
  req.on('end', () => {
    replies.push({ body: JSON.parse(body || '{}') })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
})
await new Promise((r) => callbackServer.listen(0, '127.0.0.1', r))
const callbackPort = callbackServer.address().port

const inbound = new InboundHttpServer('127.0.0.1', 0)
await inbound.listen()
const inboundPort = inbound.address().port

const received = []
const transport = new HttpTransport(inbound, {
  path: '/im',
  secret: 's3cr3t',
  chatIdField: 'chat_id',
  textField: 'text',
  senderField: 'sender_id',
  callbackUrl: `http://127.0.0.1:${callbackPort}/reply`,
  callbackChatHeader: 'x-im-chat-id',
  onInbound: (route) => received.push(route),
})
await transport.start()

const r = await fetch(`http://127.0.0.1:${inboundPort}/im`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-im-secret': 's3cr3t' },
  body: JSON.stringify({ chat_id: 'c1', text: 'hello', sender_id: 'u1' }),
})
assert.equal(r.status, 202, `route should ack 202, got ${r.status}`)
assert.equal(received.length, 1, 'inbound dispatch should fire once')
assert.equal(received[0].chatId, 'c1')
assert.equal(received[0].text, 'hello')
assert.equal(received[0].senderId, 'u1')
step('HTTP route parsed + dispatched message: ' + JSON.stringify(received[0]))

const bad = await fetch(`http://127.0.0.1:${inboundPort}/im`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-im-secret': 'wrong' },
  body: JSON.stringify({ chat_id: 'c1', text: 'x' }),
})
assert.equal(bad.status, 401, 'bad secret -> 401')
const nf = await fetch(`http://127.0.0.1:${inboundPort}/nope`, { method: 'POST' })
assert.equal(nf.status, 404, 'unknown path -> 404')
step('auth + path guard rails (401/404) OK')

// Oversized body is rejected (413) instead of buffered into memory.
const huge = await fetch(`http://127.0.0.1:${inboundPort}/im`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-im-secret': 's3cr3t' },
  body: JSON.stringify({ chat_id: 'c1', text: 'x'.repeat(1024 * 1024 + 100) }),
})
assert.equal(huge.status, 413, `oversized body -> 413, got ${huge.status}`)
step('HTTP body-size guard (413) OK')

await transport.sendText('c1', 'agent reply')
await new Promise((r2) => setTimeout(r2, 200))
assert.equal(replies.length, 1, 'reply callback should fire once')
assert.equal(replies[0].body.text, 'agent reply')
assert.equal(replies[0].body.chat_id, 'c1')
step('HttpTransport reply callback OK: ' + JSON.stringify(replies[0].body))

await transport.stop()
await inbound.close()
callbackServer.close()

// --- 4. CMCC transport: unreachable endpoint must fail loudly, bounded ---
const { CmccTransport } = await import('../src/transports/cmcc.ts')
let cmccState = ''
const cmcc = new CmccTransport({
  apiKey: 'ak_test',
  serverUrl: 'ws://127.0.0.1:1/nowhere',
  onInbound: () => {},
  onState: (s) => { cmccState = s },
})
let cmccError = ''
try {
  await withTimeout(cmcc.start(), 5000, 'cmcc connect')
} catch (e) {
  cmccError = String((e && e.message) || e)
}
await cmcc.stop().catch(() => {})
assert.ok(
  cmccError !== '' || /error|fail/i.test(cmccState),
  `cmcc connect should fail loudly, got: ${cmccError || cmccState}`,
)
step('CMCC connect failure surfaced: ' + (cmccError || cmccState))

// --- 5. Feishu transport: vendored SDK resolves offline; guards fail fast ---
// The Feishu SDK is vendored at lib/vendor/lark-sdk.cjs instead of installed
// (its transitive `protobufjs` postinstall made `dsh plugin add` fail on clean
// profiles), so this asserts the committed artifact is present, loadable, and
// still exports the three constructors the transport destructures.
const { FeishuTransport, loadFeishuSdk } = await import('../src/transports/feishu.ts')
const sdk = await loadFeishuSdk()
for (const name of ['Client', 'WSClient', 'EventDispatcher']) {
  assert.equal(typeof sdk[name], 'function', `vendored Feishu SDK must export ${name}`)
}
const probe = new (sdk.Client as any)({ appId: 'probe', appSecret: 'probe' })
assert.equal(typeof probe.im.message.create, 'function', 'Client.im.message.create must exist')
step('vendored Feishu SDK OK: Client / WSClient / EventDispatcher + im.message.create')

let feishuState = ''
const feishu = new FeishuTransport({
  appId: '',
  appSecret: '',
  onInbound: () => {},
  onState: (s) => { feishuState = s },
})
let feishuError = ''
try {
  await withTimeout(feishu.start(), 5000, 'feishu start')
} catch (e) {
  feishuError = String((e && e.message) || e)
}
assert.match(feishuError, /appId and appSecret/, 'missing credentials must fail before connecting')
assert.equal(feishuState, 'error', 'missing credentials must report the error state')
await feishu.stop().catch(() => {})
step('Feishu missing-credential guard OK: ' + feishuError)

// --- 6. WeChat: a pasted token must not suppress the login QR ---
// The bot_token is only the ilink gateway credential; it attaches no WeChat
// account. A channel that has one but no bound user (scannedUser) therefore has
// to keep driving the QR bind — otherwise the panel shows the qrHint forever and
// nothing can ever be paired. The transport is pointed at a local fake ilink
// gateway so the handshake is exercised without touching Tencent.
const { WechatIlinkTransport } = await import('../src/transports/wechat.ts')
const ilinkHits = []
const ilinkServer = createServer((req, res) => {
  ilinkHits.push(req.url ?? '')
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(req.url?.startsWith('/ilink/bot/get_bot_qrcode')
    ? JSON.stringify({ qrcode: 'q-smoke', qrcode_img_content: 'https://example.invalid/qr/q-smoke', ret: 0 })
    : JSON.stringify({ status: 'waiting' })) // never "confirmed": no state file is written
})
await new Promise((ready) => ilinkServer.listen(0, '127.0.0.1', ready))
const ilinkPort = ilinkServer.address().port

let wechatQr = ''
const wechatDetails = []
const wechat = new WechatIlinkTransport({
  channelId: 'smoke-wechat-unbound',
  baseUrl: `http://127.0.0.1:${ilinkPort}`,
  token: 'smoke-bot-token',
  onInbound: () => {},
  onQr: (url) => { wechatQr = url },
  onState: (_status, detail) => { if (detail !== undefined) wechatDetails.push(detail) },
})
await wechat.start()
assert.ok(
  ilinkHits.some(u => u.startsWith('/ilink/bot/get_bot_qrcode')),
  'a token-only channel must still request the login QR, hits: ' + JSON.stringify(ilinkHits),
)
assert.equal(wechatQr, 'https://example.invalid/qr/q-smoke', 'the QR URL must reach the UI')
assert.ok(
  wechatDetails.some(d => /尚未绑定微信/.test(d)),
  'status must say the token alone is not enough, got: ' + JSON.stringify(wechatDetails),
)
assert.match(
  wechatDetails[wechatDetails.length - 1],
  /请扫码绑定微信/,
  'the live status must state the next action, got: ' + JSON.stringify(wechatDetails),
)
assert.equal(wechat.isConnected(), false, 'an unbound channel must not report itself connected')
await assert.rejects(() => wechat.sendText('someone', 'hi'), /not bound/, 'unbound channel must refuse to send')
await wechat.stop()
ilinkServer.close()
step('WeChat token-only channel keeps requesting the login QR OK')

// A QR fetch that fails must be visible and retried, not silently swallowed:
// an inert panel is indistinguishable from "no QR appeared".
const badIlink = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ qrcode: 'q-no-image', ret: 0 })) // no qrcode_img_content
})
await new Promise((ready) => badIlink.listen(0, '127.0.0.1', ready))
const badPort = badIlink.address().port

for (const [label, baseUrl] of [['unusable response', `http://127.0.0.1:${badPort}`], ['unreachable gateway', 'http://127.0.0.1:1']]) {
  let detail = ''
  const broken = new WechatIlinkTransport({
    channelId: 'smoke-wechat-broken',
    baseUrl,
    onInbound: () => {},
    onState: (_status, d) => { if (d !== undefined) detail = d },
  })
  await broken.start()
  assert.match(detail, /获取二维码失败/, `${label}: failure must be surfaced, got: ${detail}`)
  assert.equal(broken.isConnected(), false, `${label}: must not claim to be connected`)
  await broken.stop()
}
badIlink.close()
step('WeChat QR fetch failure surfaced (and left retryable) OK')

// --- 7. source metadata injection: change-only, per session ---
// The gateway itself cannot be imported offline (its `@deepseek-ai/dsh-agent`
// peer pulls `@deepseek-ai/dsh-scope`, absent here), so the contract is verified
// on the dependency-free module the gateway delegates to.
const { SourceMetadata } = await import('../src/source-meta.ts')
const sources = new SourceMetadata()
const s1 = 'im-src-1'

const first = sources.compose(s1, 'cmcc', undefined, 'hello')
assert.ok(
  first.startsWith('<dsh_im_source>{"channel":"cmcc"}</dsh_im_source>\n\n'),
  'first message carries the source block: ' + first,
)
assert.ok(first.endsWith('hello'), 'the user text is preserved after the block')

assert.equal(
  sources.compose(s1, 'cmcc', undefined, 'again'),
  'again',
  'unchanged source must NOT repeat the block',
)

const other = sources.compose(s1, 'cmcc', 'u2', 'from someone else')
assert.ok(
  other.startsWith('<dsh_im_source>{"channel":"cmcc","senderId":"u2"}</dsh_im_source>\n\n'),
  'a different sender re-attributes: ' + other,
)
assert.equal(
  sources.compose(s1, 'cmcc', 'u2', 'same sender again'),
  'same sender again',
  'a steady sender stays clean',
)

const s2 = 'im-src-2'
assert.ok(sources.compose(s2, 'cmcc', undefined, 'hi').startsWith('<dsh_im_source>'), 'each session attributes independently')
assert.equal(sources.compose(s1, undefined, undefined, 'no source at all'), 'no source at all', 'no channel/sender -> plain text')
assert.ok(
  sources.compose(s1, 'email', undefined, 'other channel').startsWith('<dsh_im_source>{"channel":"email"}</dsh_im_source>'),
  'a different channel re-attributes',
)

// Compaction shadows the span that carried the block (its summary need not keep
// the channel), so the next inbound message must re-attribute the source.
sources.reset(s1)
assert.ok(
  sources.compose(s1, 'email', undefined, 'after compaction').startsWith('<dsh_im_source>{"channel":"email"}</dsh_im_source>'),
  'reset (compaction) must force a re-attribution',
)
sources.clear()
assert.ok(
  sources.compose(s1, 'email', undefined, 'after clear').startsWith('<dsh_im_source>'),
  'clear() must force a re-attribution',
)
step('source metadata injection (change-only) OK')

// --- 8. login QR is encoded locally ---
// `get_bot_qrcode` returns an HTML *page* URL in `qrcode_img_content` (the page
// draws the QR itself from `window.location.href`), so the panel cannot render
// it as an image and must encode the URL instead. Assert the helper is a thin,
// faithful wrapper on the encoder.
const { qrSvgFor, QR_SIZE_PX } = await import('../src/client/qr.ts')
assert.equal(qrSvgFor(''), '', 'no payload -> no QR markup')
assert.equal(qrSvgFor('   '), '', 'blank payload -> no QR markup')
const bindUrl = 'https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=deadbeefdeadbeef&bot_type=3'
const qrSvg = qrSvgFor(bindUrl)
assert.ok(qrSvg.startsWith('<svg'), 'helper must return an svg element: ' + qrSvg.slice(0, 40))
assert.match(qrSvg, /viewBox="0 0 \d+ \d+"/, 'the svg must be scalable so it stays crisp in the panel')
assert.match(qrSvg, /fill="white"/, 'the QR must paint its own background (dark theme stays scannable)')
assert.equal(qrSvgFor(bindUrl), qrSvg, 'same payload -> same markup')
assert.notEqual(
  qrSvgFor(bindUrl.replace('deadbeefdeadbeef', 'cafebabecafebabe')),
  qrSvg,
  'different payload -> different code',
)
assert.equal(QR_SIZE_PX, 168, 'the panel slot size is fixed')
step('login QR encoded locally (gateway URL is a page, not an image) OK')

// --- 9. channel-status route: the panel's only link to the host ---
// DSH's `ctx.remote.<ns>` is a projection of generated descriptors and its
// client refuses anything without a strict generated codec, so an out-of-tree
// plugin cannot publish a namespace. The panel therefore polls a web route the
// node half registers; this asserts the handler's contract with real req/res.
const { createStatusHandler, channelStatusPayload } = await import('../src/status-route.ts')
const { STATUS_ROUTE_PATH } = await import('../src/status-proto.ts')
assert.equal(STATUS_ROUTE_PATH, '/im-gateway/status', 'route path is part of the contract')

const statusRows = [
  {
    id: 'ch-w', type: 'wechat', name: '微信', status: 'connecting', bound: false,
    detail: '未绑定：请扫码绑定微信', qr: 'https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=abcdef&bot_type=3',
  },
  // A bound channel: no QR on purpose, and the panel needs `bound` to say so
  // instead of falling back to the "a QR appears here" hint.
  { id: 'ch-w2', type: 'wechat', name: '微信(已绑定)', status: 'connected', bound: true },
  { id: 'ch-e', type: 'email', name: '邮箱', status: 'idle' },
]
const projected = channelStatusPayload(statusRows).channels
assert.equal(projected[0].bound, false, 'an unbound channel must report bound: false')
assert.equal(projected[0].qr, statusRows[0].qr, 'the bind URL must survive projection')
assert.equal(projected[1].bound, true, 'a bound channel must report bound: true')
assert.equal(projected[1].qr, undefined, 'a bound channel carries no QR')
assert.deepEqual(
  projected[2],
  { id: 'ch-e', type: 'email', name: '邮箱', status: 'idle' },
  'absent optionals must be dropped, not serialized as undefined',
)

let gate: 0 | 401 | 403 = 0
const statusServer = createServer(createStatusHandler({
  list: () => statusRows,
  reject: () => (gate === 0 ? undefined : gate),
}))
await new Promise((ready) => statusServer.listen(0, '127.0.0.1', ready))
const statusBase = `http://127.0.0.1:${statusServer.address().port}/`

const statusOk = await fetch(statusBase)
assert.equal(statusOk.status, 200)
assert.equal(statusOk.headers.get('cache-control'), 'no-store', 'status must never be cached')
assert.deepEqual(await statusOk.json(), channelStatusPayload(statusRows))

gate = 401
const statusDenied = await fetch(statusBase)
assert.equal(statusDenied.status, 401, 'an unauthenticated read must be refused (live bind QR)')
assert.equal(await statusDenied.text(), 'unauthorized')
gate = 0

const statusPosted = await fetch(statusBase, { method: 'POST' })
assert.equal(statusPosted.status, 405, 'the route is read-only')
assert.equal(statusPosted.headers.get('allow'), 'GET')

const statusHead = await fetch(statusBase, { method: 'HEAD' })
assert.equal(statusHead.status, 200)
assert.equal(await statusHead.text(), '', 'HEAD must not carry a body')

statusServer.close()
step('channel-status route (payload + auth gate + method guard) OK')

// --- 10. bound WeChat channel: liveness reporting + inbound extraction ---
// The gateways' most expensive failure mode is a channel that REPORTS itself as
// connected while every inbound message is being dropped: the operator sees a
// healthy green panel and a silent chat. For the WeChat transport the only
// liveness signal is the getupdates round trip, so a bound channel whose round
// trips all fail has to leave the `connected` state (and come back when the
// gateway answers again). Inbound extraction is asserted at the same time: only
// the bound user's text/voice frames may reach the gateway — a stranger's
// message, the bot's own echo and a text-less frame must not.
const { mkdtemp, writeFile: writeStateFile } = await import('node:fs/promises')
const { tmpdir } = await import('node:os')
const { join: joinPath } = await import('node:path')
const boundStateDir = await mkdtemp(joinPath(tmpdir(), 'dsh-im-gateway-smoke-'))
const boundChannelId = 'smoke-wechat-bound'
const boundStateKey = Buffer.from(boundChannelId).toString('hex').slice(0, 40)
await writeStateFile(
  joinPath(boundStateDir, `${boundStateKey}.json`),
  JSON.stringify({
    token: 'smoke-bound-token',
    baseUrl: '',
    botId: 'bot@im.bot',
    scannedUser: 'user@im.wechat',
    contextToken: 'ctx-1',
    cursor: '',
    lastError: '',
  }),
  'utf8',
)

let boundGatewayUp = false
const boundServer = createServer((req, res) => {
  res.writeHead(boundGatewayUp ? 200 : 500, { 'content-type': 'application/json' })
  if (!boundGatewayUp) {
    res.end('{"errcode":-1,"errmsg":"gateway down"}')
    return
  }
  res.end(JSON.stringify({
    get_updates_buf: 'cursor-2',
    msgs: [
      { from_user_id: 'user@im.wechat', message_type: 1, context_token: 'ctx-2', item_list: [{ type: 1, text_item: { text: '你好' } }] },
      { from_user_id: 'stranger@im.wechat', message_type: 1, item_list: [{ type: 1, text_item: { text: 'do not route me' } }] },
      { from_user_id: 'user@im.wechat', message_type: 1, item_list: [{ type: 9, unknown_item: {} }] },
    ],
  }))
})
await new Promise((ready) => boundServer.listen(0, '127.0.0.1', ready))
const boundPort = boundServer.address().port

const boundInbound: Array<{ chatId: string; text: string; senderId?: string }> = []
const boundStates: Array<[string, string | undefined]> = []
const bound = new WechatIlinkTransport({
  channelId: boundChannelId,
  baseUrl: `http://127.0.0.1:${boundPort}`,
  stateDir: boundStateDir,
  pollIntervalMs: 20,
  onInbound: (route) => { boundInbound.push({ chatId: route.chatId, text: route.text, senderId: route.senderId }) },
  onState: (status, detail) => { boundStates.push([status, detail]) },
})
await bound.start()
assert.equal(bound.isBound(), true, 'the persisted bind state must make the channel bound')

await waitUntil(
  () => boundStates.some(([, detail]) => /通信失败/.test(String(detail))),
  5000,
  'a bound channel with failing round trips must report the link problem',
)
assert.equal(
  bound.isConnected(),
  false,
  'a bound channel whose round trips keep failing must stop reporting connected',
)
step('bound WeChat channel reports a failing link instead of staying "connected" OK')

boundGatewayUp = true
await waitUntil(() => boundInbound.length > 0, 5000, 'an inbound text frame must be dispatched')
assert.equal(boundInbound.length, 1, `only the bound user's text frame may be dispatched, got ${JSON.stringify(boundInbound)}`)
assert.equal(boundInbound[0].chatId, 'user@im.wechat')
assert.equal(boundInbound[0].text, '你好')
assert.ok(
  boundStates.some(([status]) => status === 'connected'),
  'a successful round trip must report connected again',
)
assert.equal(bound.isConnected(), true)

const persisted = JSON.parse(await (await import('node:fs/promises')).readFile(joinPath(boundStateDir, `${boundStateKey}.json`), 'utf8'))
assert.equal(persisted.cursor, 'cursor-2', 'the poll cursor must be persisted')
assert.equal(persisted.contextToken, 'ctx-2', 'a fresh context token must be persisted')
await bound.stop()
boundServer.close()
step('bound WeChat inbound extraction + recovery OK')

// --- 11. QQ transport: handshake, intents, close codes, sends ---
// The QQ channel has no QR: everything hangs off AppID/AppSecret → access token
// → /gateway → WebSocket IDENTIFY. Every one of those steps failed silently (or
// with a meaningless message) before, which is exactly what "QQ 连不上" looked
// like: an endless "重连中…" with the real reason only in the host log. The fake
// platform below drives each of those outcomes.
const {
  QQBotTransport, QqFatalError, QqApiError,
  DEFAULT_INTENTS, QQ_INTENT, parseIntents, diagnoseClose, chunkText, apiFailure,
} = await import('../src/transports/qqbot.ts')
const { WebSocketServer } = await import('ws')

async function startFakeQqPlatform() {
  const state = {
    tokenRequests: 0,
    gatewayRequests: 0,
    wsConnections: 0,
    wsHeaders: [] as any[],
    identify: [] as any[],
    resumes: [] as any[],
    heartbeats: 0,
    sends: [] as Array<{ url: string; body: any }>,
    sockets: [] as any[],
    tokenStatus: 200,
    tokenBody: { access_token: 'tok-smoke', expires_in: '7200' },
    gatewayStatus: 200,
    gatewayBody: {} as any,
    heartbeatInterval: 400,
    ackHeartbeats: true,
    // Default: accept the handshake with a READY dispatch.
    onIdentify: (ws: any) => {
      ws.send(JSON.stringify({ op: 0, s: 1, t: 'READY', d: { session_id: 'sess-smoke', user: { id: 'bot-smoke' } } }))
    },
    sendResponder: (_body: any) => ({ status: 200, body: { id: 'sent-1', timestamp: '2026-09-17T00:00:00+08:00' } }),
  }
  const http = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const url = req.url ?? ''
      if (url.startsWith('/app/getAppAccessToken')) {
        state.tokenRequests++
        res.writeHead(state.tokenStatus, { 'content-type': 'application/json' })
        res.end(JSON.stringify(state.tokenBody))
        return
      }
      if (url === '/gateway') {
        state.gatewayRequests++
        res.writeHead(state.gatewayStatus, { 'content-type': 'application/json' })
        res.end(JSON.stringify(state.gatewayBody))
        return
      }
      if (url.endsWith('/messages')) {
        const body = JSON.parse(raw || '{}')
        state.sends.push({ url, body })
        const answer = state.sendResponder(body)
        res.writeHead(answer.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(answer.body))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  await new Promise((ready) => http.listen(0, '127.0.0.1', ready))
  const port = http.address().port
  const wss = new WebSocketServer({ server: http, path: '/ws' })
  wss.on('connection', (ws, req) => {
    state.wsConnections++
    state.wsHeaders.push(req.headers)
    state.sockets.push(ws)
    ws.on('error', () => { /* the transport reports close/error itself */ })
    ws.on('message', (data) => {
      const frame = JSON.parse(String(data))
      if (frame.op === 1) {
        state.heartbeats++
        if (state.ackHeartbeats) ws.send(JSON.stringify({ op: 11 }))
        return
      }
      if (frame.op === 2) {
        state.identify.push(frame.d)
        state.onIdentify(ws)
        return
      }
      if (frame.op === 6) {
        state.resumes.push(frame.d)
        ws.send(JSON.stringify({ op: 0, s: 2, t: 'RESUMED', d: '' }))
      }
    })
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: state.heartbeatInterval } }))
  })
  return {
    state,
    base: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    close: () => {
      for (const socket of state.sockets) { try { socket.terminate() } catch { /* ignore */ } }
      wss.close()
      http.close()
    },
  }
}

// 11a. Missing credentials must be reported up front, in actionable Chinese.
{
  let state = ''
  const bare = new QQBotTransport({ appId: '', clientSecret: '', onInbound: () => {}, onState: (s) => { state = s } })
  await assert.rejects(() => bare.start(), /缺少 AppID/, 'a credential-less QQ channel must fail with the missing field')
  assert.equal(bare.isConnected(), false, 'it must not claim to be connected')
  assert.equal(state, '', 'no connection state is reported before credentials exist')
  await bare.stop()
}
step('QQ missing-credential guard OK')

// 11b. A bad AppSecret comes back as HTTP 200 + code 100016 (not an HTTP error):
// the panel has to name that, otherwise the operator debugs the network.
{
  const platform = await startFakeQqPlatform()
  platform.state.tokenBody = { code: 100016, message: 'invalid appid or secret' }
  const states: Array<[string, string | undefined]> = []
  const qq = new QQBotTransport({
    appId: '102000001', clientSecret: 'wrong-secret',
    apiBase: platform.base, tokenUrl: `${platform.base}/app/getAppAccessToken`,
    onInbound: () => {}, onState: (s, detail) => states.push([s, detail]),
  })
  await assert.rejects(() => qq.start(), /AppID 或 AppSecret 不正确/)
  assert.ok(
    states.some(([s, d]) => s === 'error' && /100016/.test(String(d))),
    'the platform code must reach the panel, got: ' + JSON.stringify(states),
  )
  assert.equal(platform.state.wsConnections, 0, 'a token failure must never open a socket')
  await qq.stop()
  platform.close()
}
step('QQ token failure surfaces the platform code (100016) OK')

// 11c. Happy path: default intents (no approval-only DIRECT_MESSAGE bit), READY,
// inbound C2C dispatch, and passive replies numbered with msg_seq.
{
  const platform = await startFakeQqPlatform()
  platform.state.gatewayBody = { url: platform.wsUrl }
  const inbound: Array<{ chatId: string; text: string; senderId?: string }> = []
  const states: string[] = []
  const qq = new QQBotTransport({
    appId: '102000001', clientSecret: 'smoke-secret',
    apiBase: platform.base, tokenUrl: `${platform.base}/app/getAppAccessToken`,
    onInbound: (route) => inbound.push({ chatId: route.chatId, text: route.text, senderId: route.senderId }),
    onState: (s) => states.push(s),
  })
  await withTimeout(qq.start(), 8000, 'qq start')
  assert.equal(qq.isConnected(), true, 'READY must report the channel connected')
  assert.equal(platform.state.identify.length, 1, 'exactly one IDENTIFY')
  assert.equal(platform.state.identify[0].intents, DEFAULT_INTENTS, 'IDENTIFY must carry the default intents')
  assert.equal(
    platform.state.identify[0].intents & QQ_INTENT.directMessage,
    0,
    'the approval-only DIRECT_MESSAGE intent must not be requested by default',
  )
  assert.equal(platform.state.identify[0].shard[0], 0)
  assert.equal(platform.state.identify[0].token, 'QQBot tok-smoke', 'IDENTIFY carries the QQBot token')
  assert.equal(platform.state.wsHeaders[0].authorization, 'QQBot tok-smoke', 'socket auth header')
  assert.equal(platform.state.wsHeaders[0]['x-union-appid'], '102000001', 'socket appid header')
  await waitUntil(() => platform.state.heartbeats > 0, 3000, 'a heartbeat must be sent')
  step('QQ handshake + default intents + heartbeat OK')

  // Inbound C2C message.
  platform.state.sockets[0].send(JSON.stringify({
    op: 0, s: 3, t: 'C2C_MESSAGE_CREATE',
    d: { id: 'msg-inbound-1', content: '你好', author: { id: 'user-openid-1' } },
  }))
  await waitUntil(() => inbound.length > 0, 3000, 'an inbound C2C frame must be dispatched')
  assert.deepEqual(inbound[0], { chatId: 'user-openid-1', text: '你好', senderId: 'user-openid-1' })

  // Passive reply: msg_id from the inbound frame + a fresh msg_seq each time.
  await qq.sendText('user-openid-1', '第一条回复')
  await qq.sendText('user-openid-1', '第二条回复')
  assert.equal(platform.state.sends.length, 2, 'two replies -> two POSTs')
  assert.equal(platform.state.sends[0].url, '/v2/users/user-openid-1/messages')
  assert.equal(platform.state.sends[0].body.msg_id, 'msg-inbound-1')
  assert.equal(platform.state.sends[0].body.msg_type, 0)
  assert.equal(platform.state.sends[0].body.msg_seq, 1, 'first reply of a msg_id is msg_seq 1')
  assert.equal(
    platform.state.sends[1].body.msg_seq,
    2,
    'the same msg_id must use a NEW msg_seq (a repeat is rejected as a duplicate)',
  )

  // A failed send must be thrown (the gateway then reports it back down the
  // chat and on the panel), never swallowed.
  platform.state.sendResponder = () => ({ status: 200, body: { err_code: 40054007, message: '消息长度超限' } })
  await assert.rejects(() => qq.sendText('user-openid-1', 'x'), /消息长度超限/)
  // 40054005 means "same msg_id + msg_seq already sent": that IS a delivery.
  platform.state.sendResponder = () => ({ status: 200, body: { err_code: 40054005, message: '消息被去重' } })
  await qq.sendText('user-openid-1', 'x')
  // Passive window expired (5 minutes) -> fall back to one active message.
  platform.state.sendResponder = (body: any) => (body.msg_id
    ? { status: 200, body: { err_code: 40034005, message: '回复消息msg_id已过期' } }
    : { status: 200, body: { id: 'sent-active', timestamp: 'now' } })
  await qq.sendText('user-openid-1', '超时之后的回复')
  const last = platform.state.sends[platform.state.sends.length - 1]
  assert.equal(last.body.msg_id, undefined, 'the expired passive reply must retry as an active message')
  step('QQ inbound dispatch + passive reply numbering + send-error surfacing OK')

  await qq.stop()
  platform.close()
}

// 11d. An un-granted intent (4014) is not a transient network blip: report it
// with the fix and stop reconnecting instead of looping for ever.
{
  const platform = await startFakeQqPlatform()
  platform.state.gatewayBody = { url: platform.wsUrl }
  platform.state.onIdentify = (ws: any) => ws.close(4014, 'intent 无权限')
  const states: Array<[string, string | undefined]> = []
  const qq = new QQBotTransport({
    appId: '102000001', clientSecret: 'smoke-secret',
    apiBase: platform.base, tokenUrl: `${platform.base}/app/getAppAccessToken`,
    onInbound: () => {}, onState: (s, detail) => states.push([s, detail]),
  })
  await assert.rejects(() => qq.start(), /4014|intent 无权限/, 'a refused intent must fail the start with the real reason')
  assert.ok(
    states.some(([s, d]) => s === 'error' && /q\.qq\.com/.test(String(d))),
    'the panel must get the actionable next step, got: ' + JSON.stringify(states),
  )
  assert.equal(qq.isConnected(), false)
  const connectionsAfterFailure = platform.state.wsConnections
  await new Promise((r) => setTimeout(r, 1200))
  assert.equal(
    platform.state.wsConnections,
    connectionsAfterFailure,
    'a fatal close code must NOT be retried in a hot loop',
  )
  await qq.stop()
  platform.close()
}
step('QQ fatal close code (4014 intent 无权限) reported + no hot loop OK')

// 11e. A gateway that keeps the socket open but stops answering heartbeats is a
// half-open connection: the watchdog has to force a reconnect.
{
  const platform = await startFakeQqPlatform()
  platform.state.gatewayBody = { url: platform.wsUrl }
  platform.state.ackHeartbeats = false
  platform.state.heartbeatInterval = 250
  const states: string[] = []
  const qq = new QQBotTransport({
    appId: '102000001', clientSecret: 'smoke-secret',
    apiBase: platform.base, tokenUrl: `${platform.base}/app/getAppAccessToken`,
    onInbound: () => {}, onState: (s, detail) => { if (detail !== undefined) states.push(`${s}:${detail}`) },
  })
  await withTimeout(qq.start(), 8000, 'qq start')
  await waitUntil(
    () => states.some(s => /心跳无响应/.test(s)),
    12000,
    'the watchdog must report a heartbeat-silent gateway',
  )
  assert.equal(qq.isConnected(), false, 'a stale socket must not keep reporting connected')
  await waitUntil(
    () => platform.state.wsConnections >= 2,
    12000,
    'a silent gateway must be force-reconnected',
  )
  await qq.stop()
  platform.close()
}
step('QQ heartbeat-ACK watchdog forces a reconnect OK')

// 11f. RESUME: a reconnect that still holds a session id must RESUME (the
// gateway then replays the events missed while disconnected) instead of
// IDENTIFYing a brand-new session.
{
  const platform = await startFakeQqPlatform()
  platform.state.gatewayBody = { url: platform.wsUrl }
  const qq = new QQBotTransport({
    appId: '102000001', clientSecret: 'smoke-secret',
    apiBase: platform.base, tokenUrl: `${platform.base}/app/getAppAccessToken`,
    onInbound: () => {}, onState: () => {},
  })
  await withTimeout(qq.start(), 8000, 'qq start')
  assert.equal(platform.state.identify.length, 1)
  // Server-side drop (e.g. 4009 连接过期): the next connection must RESUME.
  platform.state.sockets[0].close(4009, 'session expired')
  await waitUntil(() => platform.state.resumes.length > 0, 12000, 'the reconnect must RESUME the session')
  assert.equal(platform.state.resumes[0].session_id, 'sess-smoke')
  assert.equal(platform.state.resumes[0].seq, 1, 'RESUME must carry the last dispatch seq (no replay gap)')
  assert.equal(platform.state.identify.length, 1, 'RESUME must replace IDENTIFY on reconnect')
  await waitUntil(() => qq.isConnected(), 5000, 'RESUMED must report connected again')
  await qq.stop()
  platform.close()
}
step('QQ resume-on-reconnect OK')

// --- 12. QQ pure helpers ---
assert.equal(parseIntents(undefined), DEFAULT_INTENTS, 'empty intents -> the default subscription')
assert.equal(parseIntents(''), DEFAULT_INTENTS)
assert.equal(parseIntents('c2c,public_guild'), DEFAULT_INTENTS, 'keywords resolve to the same bits')
assert.equal(parseIntents('33554432'), QQ_INTENT.groupAndC2C, 'a decimal bitmask is accepted')
assert.equal(parseIntents('c2c|direct') & QQ_INTENT.directMessage, QQ_INTENT.directMessage)
assert.throws(() => parseIntents('nonsense'), /无法识别的 intents/, 'an unknown keyword must be rejected loudly')
assert.throws(() => parseIntents(1 << 20), /未知事件位/, 'a non-existent intent bit must be rejected')
assert.throws(() => parseIntents(1 << 31), /无效/, 'a negative bitmask must be rejected')

assert.deepEqual(
  { action: diagnoseClose(4014).action, retry: /无权限/.test(diagnoseClose(4014).reason) },
  { action: 'stop', retry: true },
  '4014 must not be retried and must name the permission problem',
)
assert.equal(diagnoseClose(4009).action, 'resume', '4009 keeps the session')
assert.equal(diagnoseClose(4006).action, 'identify', '4006 restarts with IDENTIFY')
assert.equal(diagnoseClose(4915).action, 'stop', 'a banned robot cannot be retried')

const long = 'a'.repeat(2500)
const chunks = chunkText(long)
assert.equal(chunks.length, 3, `2500 chars must split into 3 chunks, got ${chunks.length}`)
assert.ok(chunks.every(c => c.length <= 900), 'no chunk may exceed the conservative send size')
const overflow = chunkText('b'.repeat(9000))
assert.equal(overflow.length, 5, 'at most 5 passive replies per inbound message')
assert.match(overflow[4], /已截断/, 'the overflow must be marked, never dropped silently')
assert.deepEqual(chunkText('   '), [], 'blank replies produce nothing to send')

assert.deepEqual(
  apiFailure(200, { err_code: 40034005, message: '回复消息msg_id已过期' }, ''),
  { code: 40034005, message: '回复消息msg_id已过期', fatal: false },
  'a body err_code on HTTP 200 is a failure',
)
assert.equal(apiFailure(200, { id: 'msg-1' }, ''), null, 'a successful body is not a failure')
assert.equal(apiFailure(401, { code: 11253, message: 'no permission' }, '').fatal, true, 'a permission code is fatal')
assert.equal(apiFailure(500, null, 'boom').code, 500, 'an unparseable failure falls back to the HTTP status')
assert.ok(new QqApiError('x', 1) instanceof Error)
assert.ok(new QqFatalError('y') instanceof QqFatalError)
step('QQ intent/close-code/chunk/api helpers OK')

// --- 13. plugin-wide default working directory (settings card) ---
// Precedence: a channel's OWN cwd wins, else the plugin-wide default set on the
// settings card, else nothing (which leaves the gateway's Config.cwd and
// ~/.dsh/im-workspace fallbacks in charge).
const { resolveChannelCwd, channelRecordChanged } = await import('../src/channels/manager.ts')
assert.equal(resolveChannelCwd('/chan/dir', '/global/dir'), '/chan/dir', "a channel's own cwd must win")
assert.equal(resolveChannelCwd('  /chan/dir  ', '/global/dir'), '/chan/dir', "a channel's own cwd is trimmed")
assert.equal(resolveChannelCwd(undefined, '/global/dir'), '/global/dir', 'a channel without cwd inherits the default')
assert.equal(resolveChannelCwd('', '/global/dir'), '/global/dir', 'an empty channel cwd is "not set"')
assert.equal(resolveChannelCwd('   ', '  /global/dir  '), '/global/dir', 'whitespace is not a directory')
assert.equal(resolveChannelCwd(undefined, ''), undefined, 'no choice anywhere leaves the gateway fallbacks in charge')
assert.equal(resolveChannelCwd('', undefined), undefined)
assert.equal(resolveChannelCwd(undefined, undefined), undefined)

const { ChannelsSettingsSchema } = await import('../src/channels/schema.ts')
const withCwd = ChannelsSettingsSchema({ cwd: '/srv/im', channels: [] })
assert.equal(withCwd.cwd, '/srv/im', 'the settings card value is stored on the section root')
assert.deepEqual(withCwd.channels, [])
const withoutCwd = ChannelsSettingsSchema({ channels: [] })
assert.equal(withoutCwd.cwd, undefined, 'an untouched field stays unset (no bogus default directory)')

// The restart gate: only a channel whose OWN record changed may be restarted, so
// saving the section-level default (or another channel) never bounces this one.
const record = { id: 'ch-a', type: 'http', name: 'A', enabled: true, callbackUrl: 'https://x.example/reply' } as const
assert.equal(channelRecordChanged(record, { ...record }), false, 'a re-resolved identical record is not a change')
assert.equal(channelRecordChanged(record, { ...record, cwd: '/other' }), true, "the channel's own edit is a change")
assert.equal(channelRecordChanged(record, { ...record, enabled: false }), true)
step('plugin-wide default cwd precedence OK')

// --- 14. the client half's registration target ---
// DSH retired `settings.plugin.item` (the old 「插件 → 插件设置」 card slot) when
// it moved plugin configuration onto the Plugins page, so a stale registration
// there leaves the panel INVISIBLE: `ctx.slots.inject` waits for a slot nobody
// declares, forever, printing nothing. These are cheap assertions on the built
// client bundle — the only artifact the browser actually loads — because the
// failure mode is silence, not an error.
const { readFileSync } = await import('node:fs')
const clientBundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
assert.ok(
  clientBundle.includes('plugins.bundle.config'),
  'the client half must register into the Plugins page slot the current DSH declares',
)
assert.ok(
  !clientBundle.includes('settings.plugin.item'),
  'the retired settings.plugin.item slot must not be referenced (it renders nothing now)',
)
// The key has to equal package.json's name verbatim: the Plugins page looks a
// bundle's configuration up by `entry.options.key === pkg.name`.
const { BUNDLE_NAME } = await import('../src/client/bundle-name.ts')
const manifestName = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name
assert.equal(BUNDLE_NAME, manifestName, 'the registration key must be the package name the Plugins page dispatches on')
assert.equal(BUNDLE_NAME, 'dsh-im-gateway')
step('client half targets plugins.bundle.config, keyed by the package name OK')

process.stderr.write('\n✔ All local smoke checks passed.\n')
process.exit(0)
