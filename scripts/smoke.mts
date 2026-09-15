#!/usr/bin/env node
/**
 * dsh-im-gateway runtime smoke test.
 *
 * Verifies the pieces that can run without a live DSH host or external IM
 * services:
 *   1. sessionIdForChat — deterministic per-chat agent session-id strings.
 *   2. InboundHttpServer — POST a message to a registered route, confirm parse
 *      + dispatch + 202 ack, and the 404 / 401 guard rails.
 *   3. HttpTransport — the per-channel reply callback receives the payload.
 *   4. CmccTransport — constructing the WS client wires up, and connecting to an
 *      unreachable endpoint surfaces a clear error (bounded by a timeout).
 *   5. FeishuTransport — the VENDORED Feishu SDK (lib/vendor/lark-sdk.cjs, not
 *      an npm dependency) resolves and still exports Client / WSClient /
 *      EventDispatcher, and missing credentials fail before any socket opens.
 *   6. ImGateway.composePrompt — the `<dsh_im_source>` block is prepended ONLY
 *      when the source changes for that session (first message, sender/channel
 *      change, or after a compaction shadowed the span that carried it), so a
 *      steady sender no longer repeats the block on every bubble.
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

// --- 1. session id hashing (pure, no live deps) ---
const { sessionIdForChat } = await import('../src/session.ts')
const a = sessionIdForChat('chat-123')
const b = sessionIdForChat('chat-123')
const c = sessionIdForChat('chat-456')
assert.equal(a, b, 'same chat -> same session id')
assert.notEqual(a, c, 'different chat -> different session id')
assert.ok(String(a).startsWith('im-'), 'session id stamped with im- prefix')
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

// --- 6. source metadata injection: change-only, per session ---
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

process.stderr.write('\n✔ All local smoke checks passed.\n')
process.exit(0)
