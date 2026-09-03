/**
 * Focused verification of InteractionBridge (approval + user-question mapping).
 * Runs standalone with a minimal ctx logger stub — the module only needs the
 * type (erased) plus `this.ctx.logger.warn` at runtime.
 * Run: node --experimental-transform-types scripts/interaction-verify.mts
 */
import assert from 'node:assert'
import { InteractionBridge } from '../src/interaction.ts'

const loggerCtx = {
  logger: {
    warn: (m: string) => console.warn('[warn]', m),
    info: () => {},
  },
} as any

function installSession(bridge: InteractionBridge, sessionId: string) {
  const sent: string[] = []
  const agentCtx = {
    on: function (evt: string, cb: any) { (this as any)._handlers = (this as any)._handlers ?? {}; (this as any)._handlers[evt] = cb; return () => {} },
    _handlers: {} as Record<string, any>,
  } as any
  bridge.install(agentCtx, sessionId, async (text: string) => { sent.push(text) })
  return { agentCtx, sent }
}

async function main() {
  const bridge = new InteractionBridge(loggerCtx)

  // --- approval: reject via N ---
  {
    const { agentCtx, sent } = installSession(bridge, 's1')
    const handler = agentCtx._handlers['approval/request']
    const nextCalled = { v: false }
    const outcomeP = handler(
      { toolName: 'write', reason: '写入文件', signal: undefined },
      () => { nextCalled.v = true; return Promise.resolve('unavailable') },
    )
    assert.strictEqual(sent.length, 1, 'approval prompt sent')
    assert.match(sent[0], /授权请求/, 'prompt mentions approval')
    assert.match(sent[0], /write/, 'prompt carries tool name')
    // user replies N
    const consumed = bridge.consume('s1', 'N')
    assert.strictEqual(consumed.consumed, true, 'N consumed')
    assert.strictEqual(await outcomeP, 'rejected', 'N -> rejected')
    assert.strictEqual(nextCalled.v, false, 'not delegated')
    assert.strictEqual(bridge.has('s1'), false, 'pending cleared')
  }

  // --- approval: allow via Y ---
  {
    const { agentCtx } = installSession(bridge, 's2')
    const handler = agentCtx._handlers['approval/request']
    const p = handler({ toolName: 'bash', reason: '执行命令', signal: undefined }, () => Promise.resolve('unavailable'))
    const consumed = bridge.consume('s2', '允许')
    assert.strictEqual(consumed.consumed, true)
    assert.strictEqual(await p, 'allowed-once')
  }

  // --- approval: non-answer text NOT consumed (kept as conversation) ---
  {
    const { agentCtx } = installSession(bridge, 's3')
    const handler = agentCtx._handlers['approval/request']
    const p = handler({ toolName: 'bash', reason: '', signal: undefined }, () => Promise.resolve('unavailable'))
    const consumed = bridge.consume('s3', '今天天气怎么样')
    assert.strictEqual(consumed.consumed, false, 'irrelevant text not consumed')
    // then a real answer still works
    const consumed2 = bridge.consume('s3', 'y')
    assert.strictEqual(consumed2.consumed, true)
    assert.strictEqual(await p, 'allowed-once')
  }

  // --- approval: abort via signal -> cancelled ---
  {
    const { agentCtx } = installSession(bridge, 's4')
    const handler = agentCtx._handlers['approval/request']
    const ac = new AbortController()
    const p = handler({ toolName: 'bash', reason: '', signal: ac.signal }, () => Promise.resolve('unavailable'))
    ac.abort()
    assert.strictEqual(await p, 'cancelled')
  }

  // --- approval: no channel (sender rejects) -> fails closed instead of hanging ---
  {
    const agentCtx = {
      handlers: {} as Record<string, any>,
      on: function (evt: string, cb: any) { (this as any).handlers[evt] = cb; return () => {} },
    } as any
    const bridgeNoSend = new InteractionBridge(loggerCtx)
    bridgeNoSend.install(agentCtx, 's5', async () => { throw new Error('no channel') })
    const handler = agentCtx.handlers['approval/request']
    const outcome = await handler(
      { toolName: 'bash', reason: '', signal: undefined, agent: {} },
      () => Promise.resolve('unavailable'),
    )
    assert.strictEqual(outcome, 'unavailable', 'send failure -> fail closed')
    assert.strictEqual(bridgeNoSend.has('s5'), false, 'no stale pending')
  }

  // --- user question: multi-question q:o selection ---
  {
    const { agentCtx, sent } = installSession(bridge, 's6')
    const handler = agentCtx._handlers['user-questions/request']
    const questions = [
      { id: 'q1', question: '选择方案', options: [{ label: 'A' }, { label: 'B' }] },
      { id: 'q2', question: '是否继续', options: [{ label: '是' }, { label: '否' }] },
    ]
    const p = handler({ questions, signal: undefined }, () => Promise.resolve({ answers: [] }))
    assert.strictEqual(sent.length, 1)
    assert.match(sent[0], /提问/)
    assert.match(sent[0], /题号:选项/, 'multi-question protocol hint shown')
    bridge.consume('s6', '1:1 2:1')
    const ans = await p
    assert.strictEqual(ans.answers.length, 2, 'both answered')
    assert.deepStrictEqual(ans.answers[0]!.selected, ['A'])
    assert.deepStrictEqual(ans.answers[1]!.selected, ['是'])
  }

  // --- user question: single question bare-number option ---
  {
    const { agentCtx } = installSession(bridge, 's7')
    const handler = agentCtx._handlers['user-questions/request']
    const questions = [{ id: 'q1', question: '请选择', options: [{ label: '甲' }, { label: '乙' }] }]
    const p = handler({ questions, signal: undefined }, () => Promise.resolve({ answers: [] }))
    bridge.consume('s7', '2')
    const ans = await p
    assert.deepStrictEqual(ans.answers[0]!.selected, ['乙'])
  }

  // --- user question: free text -> first question custom ---
  {
    const { agentCtx } = installSession(bridge, 's8')
    const handler = agentCtx._handlers['user-questions/request']
    const questions = [{ id: 'q1', question: '你的意见？' }]
    const p = handler({ questions, signal: undefined }, () => Promise.resolve({ answers: [] }))
    bridge.consume('s8', '我觉得可行')
    const ans = await p
    assert.strictEqual(ans.answers[0]!.custom, '我觉得可行')
  }

  console.log('✔ InteractionBridge verification passed')
}

main().catch((e) => { console.error(e); process.exit(1) })
