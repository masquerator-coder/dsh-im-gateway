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

process.stderr.write('\n✔ All local smoke checks passed.\n')
process.exit(0)
