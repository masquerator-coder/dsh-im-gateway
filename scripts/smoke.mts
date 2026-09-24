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
 *  15. The client write path — `writeField` must turn a Host-REFUSED write
 *      (`set` resolving false) into a throw. It used to be awaited for its
 *      side effect only, so a refusal was indistinguishable from success: the
 *      panel said 已保存, cleared the create form, and dropped back to the
 *      "尚未配置任何通道" empty state — which reads as "the QR never appeared".
 *      Exercised for real (not string-matched) because the failure is silence.
 *  16. Required-field rules when EDITING — `requiredMissing` must not demand a
 *      secret while editing. The Host strips `role('secret')` fields out of
 *      every wire layer, so the panel's old `rec[key] !== undefined` presence
 *      probe could never be true and every already-configured channel failed
 *      validation on a field the user could not fill without retyping a
 *      credential they meant to keep. Also pins that the relaxation did NOT
 *      disable validation wholesale (non-secret mandatory fields and a custom
 *      email host are still enforced on edit).
 *  17. Directory browser — the host route behind the panel's 浏览… button, and
 *      the client helpers that drive it. The listing has to come from the host
 *      (a page cannot read the filesystem, and the directory that matters is on
 *      the AGENT's machine), so the route is a filesystem surface: it must fail
 *      CLOSED on the trust gate, report an UNREADABLE directory as an error
 *      rather than as an empty one, and stop "up" at a real root. Exercised
 *      against real temp directories, because every one of those failures is
 *      silent in production.
 *
 * Real transports that need live services (email / feishu / wechat / qq / a
 * live CMCC gateway) are exercised by starting them in the plugin; this file
 * only proves the plumbing that validates them.
 *
 * Run:  node --experimental-transform-types scripts/smoke.mts
 */

import { createServer, type Server, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import assert from 'node:assert/strict'
import type { InboundRoute } from '../src/transports/types.ts'

// Unbuffered progress marker (stderr) so a kill/timeout still shows where we are.
const step = (s: string): void => { process.stderr.write(`[smoke] ${s}\n`) }

/**
 * The bound port of a listening server.
 *
 * `server.address()` is `AddressInfo | string | null`, and this suite binds
 * every fixture to port 0 with an explicit host, so the string/null cases are
 * unreachable — but asserting that here keeps every call site free of the same
 * non-null dance (and makes the assumption fail loudly if it ever breaks).
 * @param server - a server that has already started listening.
 * @returns its TCP port.
 */
const portOf = (server: Server): number => {
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error(`expected a TCP address for a listening server, got ${String(address)}`)
  }
  return address.port
}

const withTimeout = <T,>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), ms)),
  ])

/** Poll a predicate until it holds (or fail the smoke run). */
const waitUntil = async (predicate: () => boolean, ms: number, label: string): Promise<void> => {
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

// --- 1c. HTML-only mail must still produce a readable body ---
// `extractText` read `parsed.text` alone. Plenty of senders ship NO text/plain
// part, so those messages parsed to '' — and the caller skipped them while
// still advancing the UID cursor, dropping the mail permanently and silently.
// The HTML fallback is asserted against mailparser's OWN plaintext rendering of
// the same message, so it cannot silently drift into producing something the
// plain-text path would never have produced.
const { htmlToText } = await import('../src/transports/email.ts')
{
  const { simpleParser } = await import('mailparser')
  const htmlOnly = [
    'From: sender@example.com',
    'To: me@example.com',
    'Subject: =?utf-8?B?5L2g5aW9?=',
    'Content-Type: text/html; charset="utf-8"',
    '',
    '<html><head><style>body{color:red}</style></head><body>',
    '<p>Hello <b>there</b></p>',
    '<div>Line two &amp; more</div>',
    '<script>alert(1)</script>',
    '<p>3 &lt; 5</p>',
    '<table><tr><td>cell</td></tr></table>',
    '</body></html>',
  ].join('\r\n')
  const parsed = await simpleParser(htmlOnly)
  assert.equal(parsed.text, 'Hello there\n\nLine two & more\n\n3 < 5\n\ncell',
    'fixture sanity: mailparser derives plaintext from this HTML')
  const viaFallback = htmlToText(String(parsed.html)).replace(/\n\n+/g, '\n\n')
  assert.equal(
    viaFallback.replace(/\n+/g, '\n'),
    String(parsed.text).replace(/\n+/g, '\n'),
    'the HTML fallback must recover the same words mailparser would have',
  )
  assert.ok(!/color:red/.test(viaFallback), 'CSS must not reach the model')
  assert.ok(!/alert\(1\)/.test(viaFallback), 'script content must not reach the model')
  assert.ok(!/<[a-z/]/i.test(viaFallback), 'no tags may survive into the prompt')
}
step('email HTML-only body falls back to readable text OK')

// --- 2 + 3. HTTP route -> dispatch -> reply callback round-trip ---
const { InboundHttpServer } = await import('../src/inbound.ts')
const { HttpTransport } = await import('../src/transports/http.ts')

/** One captured reply-callback request. */
interface CapturedReply {
  body: { chat_id?: string; text?: string; ts?: number }
  headers: IncomingHttpHeaders
}

const replies: CapturedReply[] = []
const callbackServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  let body = ''
  req.on('data', (d) => (body += d))
  req.on('end', () => {
    replies.push({ body: JSON.parse(body || '{}'), headers: req.headers })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
})
await new Promise<void>((r) => callbackServer.listen(0, '127.0.0.1', () => r()))
const callbackPort = portOf(callbackServer)

const inbound = new InboundHttpServer('127.0.0.1', 0)
await inbound.listen()
// The server was bound to an explicit host + port 0, so `address()` is non-null
// once listening; a null here means the bind silently failed.
const inboundAddress = inbound.address()
if (inboundAddress === null) throw new Error('inbound server reported no address after listen()')
const inboundPort = inboundAddress.port

const received: InboundRoute[] = []
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
const firstRoute = received[0]
assert.ok(firstRoute !== undefined, 'the inbound route must be captured')
assert.equal(firstRoute.chatId, 'c1')
assert.equal(firstRoute.text, 'hello')
assert.equal(firstRoute.senderId, 'u1')
step('HTTP route parsed + dispatched message: ' + JSON.stringify(firstRoute))

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
const firstReply = replies[0]
assert.ok(firstReply !== undefined, 'the reply callback must be captured')
assert.equal(firstReply.body.text, 'agent reply')
assert.equal(firstReply.body.chat_id, 'c1')
assert.equal(firstReply.headers['x-im-chat-id'], 'c1', 'an ASCII chat id still rides the configured header')
step('HttpTransport reply callback OK: ' + JSON.stringify(firstReply.body))

// A NON-ASCII chat id must not become an undeliverable reply. `fetch` (undici)
// rejects any header value with a code point above 0xFF by throwing
// `TypeError: Cannot convert argument to a ByteString` BEFORE the request is
// sent, so echoing an unbounded chat id into a header meant one such chat could
// never receive a reply at all. The id must still arrive via the JSON body.
const nonAsciiChat = '用户-42'
await transport.sendText(nonAsciiChat, '你好 reply')
await new Promise((r2) => setTimeout(r2, 200))
assert.equal(replies.length, 2, 'a non-ASCII chat id must still deliver a reply')
const secondReply = replies[1]
assert.ok(secondReply !== undefined, 'the non-ASCII reply must be captured')
assert.equal(secondReply.body.chat_id, nonAsciiChat, 'the chat id must still ride the JSON body')
assert.equal(secondReply.headers['x-im-chat-id'], undefined, 'a non-ASCII chat id must be omitted from headers, not crash the send')
step('non-ASCII chat id still delivers (header omitted, body carries it) OK')

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
  // `catch` binds `unknown`; narrow instead of assuming the error shape. The
  // `&& e.message` fallback preserves the original `(e && e.message) || e`
  // semantics exactly: a thrown value with an empty `message` still falls
  // through to `String(e)`.
  cmccError = e instanceof Error && e.message ? e.message : String(e)
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
  // Same narrowing + empty-message fallback as the cmcc case above.
  feishuError = e instanceof Error && e.message ? e.message : String(e)
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
const ilinkHits: string[] = []
const ilinkServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  ilinkHits.push(req.url ?? '')
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(req.url?.startsWith('/ilink/bot/get_bot_qrcode')
    ? JSON.stringify({ qrcode: 'q-smoke', qrcode_img_content: 'https://example.invalid/qr/q-smoke', ret: 0 })
    : JSON.stringify({ status: 'waiting' })) // never "confirmed": no state file is written
})
await new Promise<void>((ready) => ilinkServer.listen(0, '127.0.0.1', () => ready()))
const ilinkPort = portOf(ilinkServer)

let wechatQr = ''
const wechatDetails: string[] = []
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
const lastWechatDetail = wechatDetails[wechatDetails.length - 1]
assert.ok(lastWechatDetail !== undefined, 'a live WeChat status detail must have been pushed')
assert.match(
  lastWechatDetail,
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
const badIlink = createServer((_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ qrcode: 'q-no-image', ret: 0 })) // no qrcode_img_content
})
await new Promise<void>((ready) => badIlink.listen(0, '127.0.0.1', () => ready()))
const badPort = portOf(badIlink)

for (const [label, baseUrl] of [['unusable response', `http://127.0.0.1:${badPort}`], ['unreachable gateway', 'http://127.0.0.1:1']]) {
  let detail = ''
  const broken = new WechatIlinkTransport({
    channelId: 'smoke-wechat-broken',
    baseUrl,
    onInbound: () => {},
    onState: (_status, d) => { if (d !== undefined) detail = d },
  })
  await broken.start()
  // `detail` is only assigned from a non-undefined callback arg, but the
  // compiler cannot see that; the guard documents the assumption.
  assert.ok(detail !== '', `${label}: a failure detail must be reported`)
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
const unboundRow = projected[0]
const boundRow = projected[1]
assert.ok(unboundRow !== undefined && boundRow !== undefined, 'both projected rows must exist')
assert.equal(unboundRow.bound, false, 'an unbound channel must report bound: false')
const unboundSource = statusRows[0]
assert.ok(unboundSource !== undefined, 'the unbound fixture row must exist')
assert.equal(unboundRow.qr, unboundSource.qr, 'the bind URL must survive projection')
assert.equal(boundRow.bound, true, 'a bound channel must report bound: true')
assert.equal(boundRow.qr, undefined, 'a bound channel carries no QR')
const thirdRow = projected[2]
assert.ok(thirdRow !== undefined, 'the third projected row must exist')
assert.deepEqual(
  thirdRow,
  { id: 'ch-e', type: 'email', name: '邮箱', status: 'idle' },
  'absent optionals must be dropped, not serialized as undefined',
)

let gate: 0 | 401 | 403 = 0
const statusServer = createServer(createStatusHandler({
  list: () => statusRows,
  reject: () => (gate === 0 ? undefined : gate),
}))
await new Promise<void>((ready) => statusServer.listen(0, '127.0.0.1', () => ready()))
const statusBase = `http://127.0.0.1:${portOf(statusServer)}/`

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

// FAIL CLOSED when the trust gate itself is unavailable. The panel's route is
// registered straight on `webServer`, which authenticates nothing, and its body
// carries a LIVE bind QR — credential-equivalent, since whoever reads it can
// complete the bind. `deps.reject?.()` treated a missing gate as "nothing to
// check" and served the payload unauthenticated; `src/index.ts` resolves that
// gate per request because the connection service can mount late, so the
// absent case is a real startup race, not a hypothetical.
const noGateServer = createServer(createStatusHandler({ list: () => statusRows }))
await new Promise<void>((ready) => noGateServer.listen(0, '127.0.0.1', () => ready()))
const noGateBase = `http://127.0.0.1:${portOf(noGateServer)}/`
const noGate = await fetch(noGateBase)
assert.equal(noGate.status, 401, 'a missing trust gate must REFUSE (fail closed), never serve the QR')
const noGateBody = await noGate.text()
assert.equal(noGateBody, 'unauthorized')
assert.ok(!noGateBody.includes('qrcode'), 'no bind URL may leak when the gate is unavailable')
noGateServer.close()

// A THROWING gate must also refuse: a trust check that cannot run is not a pass.
const throwingServer = createServer(createStatusHandler({
  list: () => statusRows,
  reject: () => { throw new Error('trust service exploded') },
}))
await new Promise<void>((ready) => throwingServer.listen(0, '127.0.0.1', () => ready()))
const throwingBase = `http://127.0.0.1:${portOf(throwingServer)}/`
const throwing = await fetch(throwingBase)
assert.equal(throwing.status, 401, 'a failing trust check must refuse')
assert.ok(!(await throwing.text()).includes('qrcode'), 'no bind URL may leak when the trust check fails')
throwingServer.close()

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
const boundServer = createServer((req: IncomingMessage, res: ServerResponse) => {
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
await new Promise<void>((ready) => boundServer.listen(0, '127.0.0.1', () => ready()))
const boundPort = portOf(boundServer)

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
const firstBoundInbound = boundInbound[0]
assert.ok(firstBoundInbound !== undefined, 'the bound user text frame must be captured')
assert.equal(firstBoundInbound.chatId, 'user@im.wechat')
assert.equal(firstBoundInbound.text, '你好')
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

// --- 10b. a revoked WeChat session must re-arm the QR bind, not wedge ---
// `errcode: -14` means the ilink session is dead. The transport used to clear
// only its `connected` flag, leaving token + scannedUser in place — and since
// `isBound()` is `token && scannedUser`, `pollOnce` kept routing every round to
// `pollInbound`, which returned early at its own `isBound()` guard. The QR
// retry branch was therefore unreachable and the channel stayed permanently
// dead until the user manually edited the config: no QR, no messages, and a
// panel that could only say "connection lost". Credentials must be dropped so
// the normal unbound path takes over again.
const deadStateDir = await mkdtemp(joinPath(tmpdir(), 'dsh-im-gateway-smoke-dead-'))
const deadChannelId = 'smoke-wechat-dead'
const deadStateKey = Buffer.from(deadChannelId).toString('hex').slice(0, 40)
await writeStateFile(
  joinPath(deadStateDir, `${deadStateKey}.json`),
  JSON.stringify({
    token: 'smoke-revoked-token',
    baseUrl: '',
    botId: 'bot@im.bot',
    scannedUser: 'user@im.wechat',
    contextToken: 'ctx-dead',
    cursor: 'cursor-dead',
    lastError: '',
  }),
  'utf8',
)

const deadHits: string[] = []
const deadServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  deadHits.push(req.url ?? '')
  res.writeHead(200, { 'content-type': 'application/json' })
  // getupdates answers the revocation; every other endpoint is the QR handshake.
  res.end((req.url ?? '').startsWith('/ilink/bot/getupdates')
    ? JSON.stringify({ errcode: -14, errmsg: 'session expired' })
    : JSON.stringify({ qrcode: 'q-rebind', qrcode_img_content: 'https://example.invalid/qr/q-rebind', ret: 0 }))
})
await new Promise<void>((ready) => deadServer.listen(0, '127.0.0.1', () => ready()))
const deadPort = portOf(deadServer)

let deadQr = ''
const deadStates: Array<[string, string | undefined]> = []
const dead = new WechatIlinkTransport({
  channelId: deadChannelId,
  baseUrl: `http://127.0.0.1:${deadPort}`,
  stateDir: deadStateDir,
  pollIntervalMs: 20,
  onInbound: () => {},
  onQr: (url) => { deadQr = url },
  onState: (status, detail) => { deadStates.push([status, detail]) },
})
await dead.start()
assert.equal(dead.isBound(), true, 'the channel starts out bound')

// The revocation must be reported, not swallowed.
await waitUntil(
  () => deadStates.some(([, detail]) => /会话已失效/.test(String(detail))),
  5000,
  'a revoked session must be reported to the panel',
)
assert.equal(dead.isBound(), false, 'a revoked session must drop the dead bind (token + scannedUser)')
assert.equal(dead.isConnected(), false, 'a revoked session must not report connected')

// Crucially the SAME poll loop must now be able to re-bind without a restart.
await waitUntil(() => deadQr !== '', 5000, 'the poll loop must re-request a login QR after revocation')
assert.equal(deadQr, 'https://example.invalid/qr/q-rebind', 'the fresh QR must reach the UI')
assert.ok(
  deadHits.some(u => u.startsWith('/ilink/bot/get_bot_qrcode')),
  'the QR endpoint must be hit again after revocation, hits: ' + JSON.stringify(deadHits.slice(0, 6)),
)
// A revoked channel must also refuse to send rather than pretend to deliver.
await assert.rejects(() => dead.sendText('user@im.wechat', 'hi'), /not bound/, 'a revoked channel must refuse to send')

const deadPersisted = JSON.parse(
  await (await import('node:fs/promises')).readFile(joinPath(deadStateDir, `${deadStateKey}.json`), 'utf8'),
)
assert.equal(deadPersisted.token, '', 'the revoked token must be cleared from persisted state')
assert.equal(deadPersisted.scannedUser, '', 'the revoked bind must be cleared from persisted state')
await dead.stop()
deadServer.close()
step('a revoked WeChat session re-arms the QR bind instead of wedging OK')

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

/**
 * Declared shape of the fake QQ Open Platform's mutable state.
 *
 * The JSON bodies here are deliberately NOT the shapes the transport expects:
 * the token endpoint answers either `{ access_token, expires_in }` or the
 * failure form `{ code, message }`, and the send endpoint answers either
 * `{ id, timestamp }` or `{ err_code, message }`. Annotating the state at its
 * declaration is what lets each scenario overwrite `tokenBody` /
 * `sendResponder` with the other variant, instead of casting at every use.
 */
interface FakeQqPlatformState {
  tokenRequests: number
  gatewayRequests: number
  wsConnections: number
  wsHeaders: any[]
  identify: any[]
  resumes: any[]
  heartbeats: number
  sends: Array<{ url: string; body: any }>
  sockets: any[]
  tokenStatus: number
  /** Either the success body or the `{ code, message }` failure body. */
  tokenBody: { access_token?: string; expires_in?: string; code?: number; message?: string }
  gatewayStatus: number
  gatewayBody: any
  heartbeatInterval: number
  ackHeartbeats: boolean
  onIdentify: (ws: any) => void
  /** Returns the raw JSON body the send endpoint should answer with. */
  sendResponder: (body: any) => { status: number; body: any }
}

async function startFakeQqPlatform() {
  const state: FakeQqPlatformState = {
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
  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
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
  await new Promise<void>((ready) => http.listen(0, '127.0.0.1', () => ready()))
  const port = portOf(http)
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
  const firstSend = platform.state.sends[0]
  const secondSend = platform.state.sends[1]
  assert.ok(firstSend !== undefined && secondSend !== undefined, 'both replies must have been posted')
  assert.equal(firstSend.url, '/v2/users/user-openid-1/messages')
  assert.equal(firstSend.body.msg_id, 'msg-inbound-1')
  assert.equal(firstSend.body.msg_type, 0)
  assert.equal(firstSend.body.msg_seq, 1, 'first reply of a msg_id is msg_seq 1')
  assert.equal(
    secondSend.body.msg_seq,
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
  assert.ok(last !== undefined, 'the expired-passive fallback must have posted a message')
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
const overflowLast = overflow[4]
assert.ok(overflowLast !== undefined, 'the 5th chunk must exist')
assert.match(overflowLast, /已截断/, 'the overflow must be marked, never dropped silently')
assert.deepEqual(chunkText('   '), [], 'blank replies produce nothing to send')

assert.deepEqual(
  apiFailure(200, { err_code: 40034005, message: '回复消息msg_id已过期' }, ''),
  { code: 40034005, message: '回复消息msg_id已过期', fatal: false },
  'a body err_code on HTTP 200 is a failure',
)
assert.equal(apiFailure(200, { id: 'msg-1' }, ''), null, 'a successful body is not a failure')
const permissionFailure = apiFailure(401, { code: 11253, message: 'no permission' }, '')
assert.ok(permissionFailure !== null, 'a body code on HTTP 401 is a failure')
assert.equal(permissionFailure.fatal, true, 'a permission code is fatal')
// A BARE HTTP 401/403 — no platform body code — is a retryable auth blip, not a
// fatal misconfiguration. Marking it fatal set `desiredConnected = false` and
// stopped the reconnect loop for good, so one transient token rejection killed
// the channel until an operator manually re-saved it.
const bare401 = apiFailure(401, null, '')
const bare403 = apiFailure(403, null, '')
assert.ok(bare401 !== null && bare403 !== null, 'a bare HTTP failure is still a failure')
assert.equal(bare401.fatal, false, 'a bare HTTP 401 must stay retryable')
assert.equal(bare403.fatal, false, 'a bare HTTP 403 must stay retryable')
assert.equal(apiFailure(401, null, '{"message":"Unauthorized"}')?.code, 401, 'the HTTP status is still surfaced')
assert.equal(apiFailure(500, null, 'boom')?.code, 500, 'an unparseable failure falls back to the HTTP status')
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

// DSH 0.1.7 removed the plugin-registrable settings NAMESPACE
// (`settings.register(ns, schema)`): the channel list and the plugin-wide
// default working directory are now VOLATILE fields on this plugin's own Config,
// projected into the form by the framework and written back without a remount.
// The value the user stores for `channelsCwd` is therefore a plain string on the
// Config root — there is no longer a section wrapper to resolve.
const { Config } = await import('../src/config.ts')
const parsed = Config({ callbackUrl: 'http://127.0.0.1:9999/reply', channelsCwd: '/srv/im', channels: [] })
assert.equal(parsed.channelsCwd.get(), '/srv/im', 'the settings card value lands on the volatile channelsCwd reference')
assert.deepEqual(parsed.channels.get(), [], 'an empty channel list resolves to []')
const parsedWithoutCwd = Config({ callbackUrl: 'http://127.0.0.1:9999/reply' })
assert.equal(parsedWithoutCwd.channelsCwd.get(), undefined, 'an untouched field stays unset (no bogus default directory)')

// The client half must ask for the plugin's own profile ENTRY (not a namespace
// it registered itself), and that id must match what the bundle patch inserts.
const { ENTRY_ID, BUNDLE_NAME } = await import('../src/client/bundle-name.ts')
assert.equal(ENTRY_ID, 'im-gateway', 'the configForms key is the profile entry id')
const patchText = await (await import('node:fs/promises')).readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
assert.ok(patchText.includes(`id: ${ENTRY_ID}`), 'cordis.patch.yml inserts a row with exactly that id')

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
const { existsSync, readdirSync } = await import('node:fs')
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
const manifestName = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name
assert.equal(BUNDLE_NAME, manifestName, 'the registration key must be the package name the Plugins page dispatches on')
assert.equal(BUNDLE_NAME, 'dsh-im-gateway')
// DSH 0.1.7-alpha.1 deleted BOTH the client `settingsScope` service and the
// host-side `settings.register(ns, schema)` namespace API. Cordis parks a fiber
// with an unsatisfied `inject` in `pending` forever WITHOUT erroring, and the
// client boot audit then fails the whole page with "Failed to load plugins" — so
// a stale name here is not a cosmetic bug, it takes down the entire Web client.
// Assert on the built bundle (what the browser actually executes).
assert.ok(
  !clientBundle.includes('settingsScope'),
  'the client bundle must not reference the deleted settingsScope service',
)
assert.ok(
  clientBundle.includes('configForms'),
  'the client half must bind to ctx.configForms (the replacement for settingsScope)',
)
assert.ok(
  clientBundle.includes(ENTRY_ID),
  'the client bundle must key its form on the plugin profile entry id',
)
step('client half targets plugins.bundle.config, keyed by the package name OK')

// --- 15. the client write path ---
// `ConfigForm.set` answers FALSE when the Host refuses a write (revision
// conflict, entry no longer configurable, section shadowed by an overlay) and
// only rejects on a transport failure. The panel used to await it purely for
// its side effect, so a refusal took the success branch: 已保存 was reported,
// the create form was cleared, and the still-empty channel list rendered the
// "尚未配置任何通道" empty state. From the user's seat that is indistinguishable
// from "the WeChat QR never appeared", so it gets a real behavioural test.
const { writeField } = await import('../src/client/write-field.ts')

/** A minimal stand-in for a bound ConfigForm that always refuses. */
const refusingForm = { set: async () => false }
await assert.rejects(
  () => writeField(refusingForm, 'channels', [{ id: 'ch-1', type: 'wechat' }], (k) => k),
  /channels\.writeRefused/,
  'a Host-refused write must surface as an error, never as a silent success',
)

/** A form that accepts: the helper must resolve and pass the value through. */
let seen: { field?: string; value?: unknown } = {}
const acceptingForm = {
  set: async (field: string, value: unknown) => { seen = { field, value }; return true },
}
await writeField(acceptingForm, 'channels', [{ id: 'ch-2' }], (k) => k)
assert.equal(seen.field, 'channels', 'the accepted write must reach the bound form')
assert.deepEqual(seen.value, [{ id: 'ch-2' }], 'the accepted write must carry the value through')

/** A form that rejects (transport failure) must propagate the original error. */
await assert.rejects(
  () => writeField({ set: async () => { throw new Error('offline') } }, 'channels', [], (k) => k),
  /offline/,
  'a transport failure must propagate unchanged (not be masked as a refusal)',
)
step('client write path surfaces a refused save OK')

// --- 16. editing an existing channel must not demand its stored secrets ---
// The Host strips `role('secret')` fields out of EVERY wire layer it sends the
// browser (`redactSecrets` returns undefined for the node, then drops the key;
// and `value`/`base`/`user` are all redacted). The panel used to test
// `rec[f.key] !== undefined` to decide "secret already stored", which can
// therefore NEVER be true: editing any already-configured channel failed
// front-end validation with 缺少必填项 on a field the user could not fill
// without retyping a credential they only meant to keep. This is a silent
// failure — no crash, just a permanently unsavable form — so it gets a real
// behavioural test rather than a string match.
const { requiredMissing } = await import('../src/client/required-fields.ts')

/** A field list shaped like a real secret-bearing template (QQ). */
const qqTemplate = {
  defaults: {},
  fields: [
    { key: 'appId', labelKey: 'field.appId' },
    { key: 'appSecret', labelKey: 'field.appSecret', secret: true },
  ],
}

// Creating: the secret IS required (nothing is stored yet).
assert.equal(
  requiredMissing('qq', qqTemplate, false, { appId: '123' }, 'custom'),
  'field.appSecret',
  'a NEW channel must still require its secret',
)
// Creating with the secret filled: complete.
assert.equal(
  requiredMissing('qq', qqTemplate, false, { appId: '123', appSecret: 's3cret' }, 'custom'),
  null,
  'a new channel with every field filled must validate',
)
// EDITING with the secret box left blank: must NOT be reported missing — the
// blank means "keep the stored value", and its presence is unknowable here.
assert.equal(
  requiredMissing('qq', qqTemplate, true, { appId: '123', appSecret: '' }, 'custom'),
  null,
  'editing must accept a blank secret box (blank = keep the stored credential)',
)
// Non-secret required fields are still enforced on EDIT: the relaxation must
// not have disabled validation wholesale.
assert.equal(
  requiredMissing('qq', qqTemplate, true, { appId: '', appSecret: '' }, 'custom'),
  'field.appId',
  'editing must still require non-secret mandatory fields',
)
// A custom email server still needs an explicit host while editing.
assert.equal(
  requiredMissing('email', { defaults: {}, fields: [{ key: 'account', labelKey: 'field.account' }] },
    true, { account: 'a@b.c' }, 'custom'),
  'field.host',
  'editing must still require a host for a custom email provider',
)
step('editing an existing channel keeps its stored secret optional OK')

// --- 17. directory browser (the panel's 浏览… button) ---
// The panel cannot enumerate directories itself: `<input webkitdirectory>` only
// yields the FILES a user picked, and the File System Access API is
// Chromium-only with a gesture per root. What the user is choosing is also the
// directory on the machine the AGENT runs on — the host process, which is not
// necessarily the browser's machine — so the listing has to come from a host
// route. That makes it a filesystem surface, and the ways it can be WRONG are
// all silent, which is why this is exercised for real.
const { BROWSE_ROUTE_PATH } = await import('../src/status-proto.ts')
assert.equal(BROWSE_ROUTE_PATH, '/im-gateway/browse', 'the browse route path is part of the contract')

const { createBrowseHandler } = await import('../src/status-route.ts')
const { browseDirectory, defaultBrowseDeps, parentOf, browseRoots, validateDirectory, describeFsError } =
  await import('../src/browse-route.ts')
const {
  browseUrl, normalizeBrowsePayload, fetchDirectory, breadcrumbs, directoryProblem,
} = await import('../src/client/browse-client.ts')

// 17a. Pure path rules: where "up" stops, and what a root is.
{
  const isWin = process.platform === 'win32'
  // At a real root there must be NO parent offered: a naive `dirname` chain
  // makes "up" an endless no-op button on POSIX ('/' -> '/') and Windows
  // ('C:\\' -> 'C:\\'), so the panel would look broken rather than finished.
  assert.equal(parentOf(isWin ? 'C:\\' : '/'), null, 'a filesystem root has no parent to walk to')
  // A bare drive spec ('C:') is drive-RELATIVE on Windows, not the drive root:
  // `dirname` cannot walk above it either, so it too must report no parent
  // rather than sending the panel to '.' (the host process's own cwd).
  if (isWin) {
    assert.equal(parentOf('C:'), null, 'a bare drive spec has no walkable parent (never ".")')
    assert.equal(parentOf('C:\\work'), 'C:\\', 'a normal Windows directory offers its drive root')
  } else {
    assert.equal(parentOf('/work/im'), '/work', 'a normal directory offers its parent')
    assert.equal(parentOf('/'), null)
  }
}
step('browse path rules (root has no parent) OK')

// 17b. Breadcrumbs are derived from the HOST's string, never from node:path.
// `node:path` is unavailable in the browser, and its separator differs from the
// host's, so the trail must be built by text alone.
{
  assert.deepEqual(breadcrumbs(''), [], 'no path -> no trail')
  assert.deepEqual(breadcrumbs('/a/b'), ['/', '/a', '/a/b'], 'POSIX trail is root-first')
  if (process.platform === 'win32') {
    assert.deepEqual(breadcrumbs('C:\\a\\b'), ['C:\\', 'C:\\a', 'C:\\a\\b'], 'Windows trail keeps the drive root')
  }
  assert.deepEqual(breadcrumbs('C:/a'), ['C:\\', 'C:\\a'], 'forward slashes still name one trail, not two')
}
step('browse breadcrumbs (host-string derived) OK')

// 17c. Real directory listing against real temp directories.
const { mkdir: mkdirBrowse, writeFile: writeFileBrowse, rm: rmBrowse } =
  await import('node:fs/promises')
const browseTmp = await mkdtemp(joinPath(tmpdir(), 'dsh-im-gateway-browse-'))
const deps = {
  ...defaultBrowseDeps(),
  // Pin the shortcuts so the assertions do not depend on the machine's HOME.
  home: browseTmp,
  cwd: '',
  imWorkspace: joinPath(browseTmp, 'im-workspace'),
  processCwd: browseTmp,
}
await mkdirBrowse(joinPath(browseTmp, 'zeta'), { recursive: true })
await mkdirBrowse(joinPath(browseTmp, 'alpha'), { recursive: true })
await mkdirBrowse(joinPath(browseTmp, 'nested', 'deep'), { recursive: true })
// A FILE must never be offered: the field is a working DIRECTORY.
await writeFileBrowse(joinPath(browseTmp, 'a-file.txt'), 'x')

const listed = await browseDirectory(browseTmp, deps)
assert.equal(listed.path, browseTmp, 'the listing echoes the resolved absolute path')
assert.equal(listed.error, undefined, 'a readable directory reports no error (absent, like every other optional)')
assert.deepEqual(
  listed.entries.map(e => e.name),
  ['alpha', 'nested', 'zeta'],
  'directories are listed name-sorted, files excluded',
)
assert.ok(listed.entries.every(e => e.readable), 'every readable directory is offered')
assert.ok(
  listed.entries.every(e => e.path === joinPath(browseTmp, e.name)),
  'each entry carries the absolute path the host will store',
)

// The parent is offered so the panel can walk up without retyping.
const deep = await browseDirectory(joinPath(browseTmp, 'nested', 'deep'), deps)
assert.equal(deep.parent, joinPath(browseTmp, 'nested'), 'a nested directory offers its parent')
assert.equal(deep.entries.length, 0, 'an empty directory lists nothing')

// An EMPTY directory and an UNREADABLE one must not look the same. Reporting a
// missing directory as an empty listing is indistinguishable from "your files
// are gone", which is the worst possible rendering of a typo.
const missing = await browseDirectory(joinPath(browseTmp, 'nope'), deps)
assert.equal(missing.entries.length, 0)
assert.ok(missing.error !== '', 'a missing directory must report an error, not an empty listing')
assert.equal(missing.path, joinPath(browseTmp, 'nope'), 'the failed path is echoed so the panel can show it')

// A path that is a FILE rather than a directory: the user pasted a file path.
const asFile = await browseDirectory(joinPath(browseTmp, 'a-file.txt'), deps)
const asFileError = String(asFile.error ?? '')
assert.ok(asFileError !== '', 'a file path must be reported as an error, not listed as empty')
assert.match(asFileError, /不是目录/, 'the panel must be able to say the path is not a directory, got: ' + asFileError)

// Traversal syntax is resolved BEFORE listing, so it can never steer the walk.
const traversed = await browseDirectory(joinPath(browseTmp, 'nested', '..', 'alpha'), deps)
assert.equal(traversed.path, joinPath(browseTmp, 'alpha'), '..-segments resolve to a real, normalized path')
assert.equal(traversed.error, undefined)

// The roots-only view: no path asked for, and NO error (an error here would
// paint the picker's very first frame as a failure).
const rootsView = await browseDirectory('', deps)
assert.equal(rootsView.error, undefined, 'the opening view is not an error')
assert.equal(rootsView.path, '', 'the opening view names no path')
assert.deepEqual(rootsView.entries, [], 'the opening view lists nothing until a path is chosen')
assert.deepEqual(
  rootsView.roots.map(r => r.id),
  ['home', 'imWorkspace'],
  'shortcuts are reported up front, with duplicates collapsed',
)
step('browse route lists real directories (files excluded, failures reported) OK')

// 17d. Shortcut de-duplication: the plugin cwd frequently EQUALS home, and a
// duplicated shortcut is a second button that does nothing new.
{
  const duplicated = browseRoots({ ...deps, home: browseTmp, cwd: browseTmp, imWorkspace: browseTmp })
  assert.equal(duplicated.length, 1, 'the same directory must not appear as three shortcuts')
  const cased = browseRoots({ ...deps, home: browseTmp, cwd: browseTmp.toUpperCase(), imWorkspace: '' })
  if (process.platform === 'win32') {
    assert.equal(cased.length, 1, 'Windows paths that differ only in case are one directory')
  }
  assert.deepEqual(browseRoots({ ...deps, home: '', cwd: '', imWorkspace: '' }), [],
    'with nothing resolvable there are simply no shortcuts')
}
step('browse shortcuts de-duplicated OK')

// 17e. Saving a bad directory must be refused while the user is still looking
// at the box: a saved typo silently starts every chat in a NEW, wrong
// workspace, and that is invisible at save time.
{
  assert.equal(await validateDirectory('', deps), 'ok', 'empty means "use the fallbacks", not an error')
  assert.equal(await validateDirectory(browseTmp, deps), 'ok', 'a real directory is accepted')
  const relative = await validateDirectory('relative/dir', deps)
  assert.match(String(relative), /绝对路径/, 'a relative path must be refused (it would resolve against the host cwd)')
  const bad = await validateDirectory(joinPath(browseTmp, 'nope'), deps)
  assert.ok(bad !== 'ok', 'a non-existent directory must be refused')
  assert.equal(describeFsError({ code: 'EACCES' }, 'X'), '没有权限读取：X', 'permission errors are named')
  assert.equal(describeFsError({ code: 'ENOENT' }, 'X'), '目录不存在：X', 'a missing directory is named')
  assert.ok(
    !describeFsError(new Error("ENOENT: no such file or directory, scandir 'C:\\x'"), 'X').includes('scandir'),
    'the raw Node error text must not leak into the panel',
  )
}
step('browse validates a typed path before it can be saved OK')

// 17f. Client helpers: URL shape, untrusted-payload narrowing, staleness guard.
{
  assert.equal(browseUrl(''), BROWSE_ROUTE_PATH, 'no path -> the roots-only view')
  assert.equal(browseUrl('C:\\work\\im'), `${BROWSE_ROUTE_PATH}?path=C%3A%5Cwork%5Cim`, 'the path is URI-encoded')
  assert.ok(browseUrl('/a b').endsWith('path=%2Fa%20b'), 'spaces must not break the query')

  const narrowed = normalizeBrowsePayload({
    path: '/x',
    parent: '/',
    entries: [
      { name: 'ok', path: '/x/ok', readable: true },
      { name: 'no-path' },        // dropped: no path
      null,                        // dropped: not an object
      { name: 'assumed', path: '/x/a' }, // readable defaults to true
    ],
    roots: [{ id: 'home', path: '/home' }, { path: '/no-id' }],
  })
  assert.deepEqual(narrowed.entries.map(e => e.name), ['ok', 'assumed'], 'malformed entries are dropped, not trusted')
  assert.equal(narrowed.entries[1]?.readable, true, 'a missing `readable` is treated as readable')
  assert.deepEqual(narrowed.roots.map(r => r.id), ['home'], 'a shortcut without an id is dropped')

  const garbage = normalizeBrowsePayload('not an object')
  assert.deepEqual(
    { path: garbage.path, parent: garbage.parent, n: garbage.entries.length, e: garbage.error },
    { path: '', parent: null, n: 0, e: '' },
    'a non-object body degrades to an empty result instead of crashing the picker',
  )

  // A transport failure must come back as a RESULT with an error, never a
  // rejection: the picker renders one failure state and has no catch of its own.
  const refused = await fetchDirectory('/x', async () => ({ ok: false, status: 401, json: async () => ({}) }))
  assert.ok(refused.error !== '', 'an unauthenticated listing is an error result')
  assert.match(refused.error, /权限/, 'a 401 must name the auth problem, got: ' + refused.error)
  assert.equal(refused.path, '/x', 'the failed path is preserved for display')

  const unreachable = await fetchDirectory('/y', async () => { throw new Error('offline') })
  assert.match(unreachable.error, /offline/, 'a thrown transport error becomes a result, not a rejection')

  const okFetch = await fetchDirectory('/z', async () => ({
    ok: true, status: 200, json: async () => ({ path: '/z', parent: '/', entries: [], roots: [] }),
  }))
  assert.equal(okFetch.path, '/z', 'a successful listing passes through')
}
step('browse client helpers (URL, narrowing, failure-as-result) OK')

// 17g. `directoryProblem` must never block a save it cannot vouch for: an
// unverified path (typed, never browsed) is not an error, but a path the host
// just refused IS.
{
  const failed = { path: '/x', parent: null, entries: [], roots: [], error: '目录不存在：/x' }
  assert.equal(directoryProblem('/x', failed), '目录不存在：/x', 'a path the host refused must be surfaced')
  assert.equal(directoryProblem('', failed), '', 'empty is never an error')
  assert.equal(directoryProblem('/typed', failed), '', 'an unverified path must not be blocked')
  assert.equal(directoryProblem('/x', { ...failed, error: '' }), '', 'a healthy listing raises nothing')
}
step('browse save-guard only blocks what was actually verified OK')

// 17h. The route end-to-end: gate, method guard, and real listing.
{
  let gate: 0 | 401 | 403 = 0
  const browseServer = createServer(createBrowseHandler({
    browse: deps,
    reject: () => (gate === 0 ? undefined : gate),
  }))
  await new Promise<void>((ready) => browseServer.listen(0, '127.0.0.1', () => ready()))
  const base = `http://127.0.0.1:${portOf(browseServer)}`

  const ok = await fetch(`${base}${browseUrl(browseTmp)}`)
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('cache-control'), 'no-store', 'a cached listing would show a stale tree')
  const body = await ok.json() as { entries: Array<{ name: string }>; error?: string; parent?: string | null }
  assert.deepEqual(body.entries.map(e => e.name), ['alpha', 'nested', 'zeta'], 'the route serves the real listing')
  assert.ok(!('error' in body), 'a healthy listing must not ride the wire with an error key at all')

  // A failing path is still HTTP 200 (the request SUCCEEDED; the directory did
  // not), carrying the reason — so the panel has one shape to render.
  const failedList = await fetch(`${base}${browseUrl(joinPath(browseTmp, 'nope'))}`)
  assert.equal(failedList.status, 200, 'an unreadable directory is a reported outcome, not a transport error')
  const failedBody = await failedList.json() as { error?: string; entries: unknown[] }
  assert.ok(String(failedBody.error ?? '') !== '', 'the failure reason must ride the body')
  assert.deepEqual(failedBody.entries, [], 'a failed listing carries no entries')

  // FAIL CLOSED: this endpoint enumerates the host's filesystem and
  // `webServer.register` authenticates nothing, so an unauthenticated caller
  // must be refused — and the refusal must not leak a single directory name.
  gate = 401
  const denied = await fetch(`${base}${browseUrl(browseTmp)}`)
  assert.equal(denied.status, 401, 'an unauthenticated listing must be refused')
  const deniedText = await denied.text()
  assert.equal(deniedText, 'unauthorized')
  assert.ok(!deniedText.includes('alpha'), 'no directory name may leak on a refusal')
  gate = 0

  // A MISSING gate is a startup race, not a pass.
  const noGateServer = createServer(createBrowseHandler({ browse: deps }))
  await new Promise<void>((ready) => noGateServer.listen(0, '127.0.0.1', () => ready()))
  const noGate = await fetch(`http://127.0.0.1:${portOf(noGateServer)}${browseUrl(browseTmp)}`)
  assert.equal(noGate.status, 401, 'a missing trust gate must REFUSE (fail closed)')
  assert.ok(!(await noGate.text()).includes('alpha'), 'no directory name may leak when the gate is unavailable')
  noGateServer.close()

  const posted = await fetch(`${base}${browseUrl(browseTmp)}`, { method: 'POST' })
  assert.equal(posted.status, 405, 'the route is read-only')
  assert.equal(posted.headers.get('allow'), 'GET')

  const headed = await fetch(`${base}${browseUrl(browseTmp)}`, { method: 'HEAD' })
  assert.equal(headed.status, 200)
  assert.equal(await headed.text(), '', 'HEAD must not carry a body')

  // A missing path is the roots view, not a 400: the panel's first paint must
  // be usable.
  const opening = await fetch(`${base}${BROWSE_ROUTE_PATH}`)
  assert.equal(opening.status, 200)
  const openingBody = await opening.json() as { path: string; roots: unknown[] }
  assert.equal(openingBody.path, '', 'no path -> the roots view')
  assert.ok(openingBody.roots.length > 0, 'the opening view offers shortcuts')

  // A repeated `?path=` arrives as an array: the FIRST value wins, because
  // joining them would invent a path nobody asked for.
  const repeated = await fetch(`${base}${BROWSE_ROUTE_PATH}?path=${encodeURIComponent(browseTmp)}&path=${encodeURIComponent('/nope')}`)
  const repeatedBody = await repeated.json() as { path: string }
  assert.equal(repeatedBody.path, browseTmp, 'a repeated path parameter must not be concatenated')

  browseServer.close()
}
step('browse route (gate fails closed, method guard, roots view) OK')

// --- 18. the client half must not paint literal colours ---
// The panel is drawn with INLINE styles (it cannot import the host's CSS
// modules), so a hard-coded `#1f1f1f` / `rgba(128,128,128,…)` is not a neutral
// choice: it renders identically on both themes. The directory dialog shipped
// with invented token names (`--dsw-alias-bg-elevated`) plus dark literals as
// fallbacks, so on the LIGHT theme the undefined variables fell through to those
// fallbacks and painted a dark card with dark text — unreadable, and invisible
// to every other check, because an undefined `var()` is not an error: it is
// simply "use the fallback".
//
// Asserted on the BUILT bundle (the artifact the browser actually executes).
{
  const themeDir = process.env.DSH_THEME_DIR
    ?? 'D:/Apps/deepseek-harness/packages/client/ui-theme/src/styles'
  const clientBundleText = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

  // Every theme token the bundle references...
  const referenced = new Set(
    [...clientBundleText.matchAll(/--dsw-alias-[a-z0-9-]+/g)].map(m => m[0]),
  )
  assert.ok(referenced.size > 0, 'the panel must style itself through theme tokens')

  // ...must NOT carry a literal fallback: that fallback is precisely what hides
  // a misspelled token name on the theme the literal does not match.
  const withFallback = [...clientBundleText.matchAll(/var\((--dsw-alias-[a-z0-9-]+)\s*,/g)]
    .map(m => m[1]!)
  assert.deepEqual(
    [...new Set(withFallback)], [],
    'an --dsw-alias-* reference must not carry a literal fallback (it masks a wrong token name)',
  )

  // Cross-check the names against the host theme when its sources are present.
  // On a bare install the artifact is absent and the checks above still hold;
  // this is the stronger version and needs the DSH checkout.
  if (existsSync(themeDir)) {
    const css = readdirSync(themeDir)
      .filter(name => name.endsWith('.css'))
      .map(name => readFileSync(joinPath(themeDir, name), 'utf8'))
      .join('\n')
    const defined = new Set([...css.matchAll(/(--dsw-alias-[a-z0-9-]+)\s*:/g)].map(m => m[1]!))
    const unknown = [...referenced].filter(token => !defined.has(token))
    assert.deepEqual(
      unknown, [],
      `tokens that do not exist in the DSH theme (they would silently fall back): ${unknown.join(', ')}`,
    )
  }

  // No bare colour literals in OUR OWN panel sources. Scoped to the plugin's
  // `.tsx`/`.ts` rather than the built bundle, because the bundle also contains
  // vendored third-party code — `qrcode-generator` legitimately emits
  // `#000000`/`#ffffff` for the QR modules, which is a SCANNING requirement, not
  // a theming choice. Sweeping the bundle would either fail on that or force a
  // loophole wide enough to hide a real literal.
  //
  // The QR tile's own white background is the one deliberate exception in our
  // code: a QR printed on a dark surface does not scan. It is asserted
  // separately below so the exception cannot quietly grow.
  const ourSources = readdirSync(new URL('../src/client/', import.meta.url))
    .filter(name => name.endsWith('.ts') || name.endsWith('.tsx'))
    .map(name => readFileSync(new URL(`../src/client/${name}`, import.meta.url), 'utf8'))
    .join('\n')
  // Strip block comments first: the prose in these files quotes the offending
  // literals on purpose (explaining why they were removed).
  const ourCode = ourSources.replace(/\/\*[\s\S]*?\*\//g, '')
  const literalColours = [...ourCode.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)]
    .map(m => m[0])
    .filter(token => token.toLowerCase() !== '#fff')
  assert.deepEqual(
    literalColours, [],
    `panel colours must come from theme tokens, found literals: ${literalColours.join(', ')}`,
  )
  assert.ok(
    ourCode.includes('#fff'),
    'the QR tile must keep its literal white background (a dark-surface QR does not scan)',
  )
}
step('client half paints only real theme tokens (no literal colours) OK')

await rmBrowse(browseTmp, { recursive: true, force: true })

process.stderr.write('\n✔ All local smoke checks passed.\n')
process.exit(0)
