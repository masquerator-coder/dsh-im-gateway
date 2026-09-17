// Live diagnostic: drive the running dsh-im-gateway through its legacy HTTP
// webhook (same ImGateway.handle path the IM channels use) and capture the
// reply on the configured callback URL (127.0.0.1:9999).
//
// This is the probe that separated "the gateway is broken" from "only the
// resume path is broken" in the 2026-09-17 incident: a NEW chatId exercises the
// create path, while re-using a chatId whose session already exists (after a
// host restart, so the cached handle is gone) exercises resume. See
// docs/2026-09-17-wechat-connected-but-mute.md.
//
// Usage: node scripts/inbound-probe.mjs [chatId] [text]
import http from 'node:http'

const chatId = process.argv[2] ?? `diag-${Date.now()}`
const text = process.argv[3] ?? '请只回复四个字：诊断通过'

const received = []

const collector = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    received.push(body)
    console.log(`[callback] ${req.method} ${req.url} headers=${JSON.stringify(req.headers)}`)
    console.log(`[callback] body=${body.slice(0, 2000)}`)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
})

await new Promise((resolve) => collector.listen(9999, '127.0.0.1', resolve))
console.log('[probe] collector listening on http://127.0.0.1:9999')

const payload = { chat_id: chatId, text, sender_id: 'diag-probe' }
console.log(`[probe] POST http://127.0.0.1:8799/im ${JSON.stringify(payload)}`)
try {
  const res = await fetch('http://127.0.0.1:8799/im', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  })
  console.log(`[probe] webhook status=${res.status} body=${(await res.text()).slice(0, 500)}`)
} catch (error) {
  console.log(`[probe] webhook request FAILED: ${error.message} ${error.cause?.message ?? ''}`)
}

const deadline = Date.now() + 150_000
while (Date.now() < deadline && received.length === 0) {
  await new Promise((r) => setTimeout(r, 2000))
  console.log(`[probe] waiting… t+${Math.round((Date.now() - (deadline - 150_000)) / 1000)}s replies=${received.length}`)
}
console.log(`[probe] DONE replies=${received.length}`)
collector.close()
process.exit(0)
