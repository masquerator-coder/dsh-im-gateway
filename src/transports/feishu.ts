import type { ChannelTransport, InboundRoute } from './types.ts'

/**
 * Resolve the vendored Feishu / Lark SDK at `lib/vendor/lark-sdk.cjs`.
 *
 * The SDK is **vendored, not installed**: its hard dependency `protobufjs`
 * carries a `postinstall` script, and pnpm >= 10 refuses to run an unapproved
 * dependency build script, so `dsh plugin add <git-url>` dies with
 * `ERR_PNPM_IGNORED_BUILDS` on a clean profile (see `scripts/build.mjs` for the
 * full rationale). Loading it from a *computed* specifier keeps the vendored
 * file out of the esbuild graph — the node-half bundle must not inline 1.9 MB
 * of third-party code — while one code path serves both layouts:
 *
 *   - built bundle  `lib/index.js`         -> `./vendor/lark-sdk.cjs`
 *   - source overlay `src/transports/*.ts` -> `../../lib/vendor/lark-sdk.cjs`
 *
 * @returns the SDK's module namespace (`Client`, `EventDispatcher`, `WSClient`, …).
 */
let cachedLarkSdk: unknown
export async function loadFeishuSdk(): Promise<Record<string, unknown>> {
  if (cachedLarkSdk !== undefined) return cachedLarkSdk as Record<string, unknown>
  const candidates = ['./vendor/lark-sdk.cjs', '../../lib/vendor/lark-sdk.cjs']
  let lastError: unknown
  for (const candidate of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = (await import(new URL(candidate, import.meta.url).href)) as any
      // The vendored file is CJS: its named exports survive bundling only as
      // `default` (`module.exports`), so unwrap when they are not top-level.
      const sdk = mod?.Client !== undefined ? mod : (mod?.default ?? mod)
      cachedLarkSdk = sdk
      return sdk as Record<string, unknown>
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(
    `feishu: vendored SDK not found (tried ${candidates.join(', ')}); `
    + `run "pnpm build" to regenerate lib/vendor/lark-sdk.cjs — ${String(lastError)}`,
  )
}

export interface FeishuChannelOptions {
  appId: string
  appSecret: string
  provider?: string
  model?: string
  maxTokens?: number
  disposeAfterReply?: boolean
  onInbound: (route: InboundRoute) => void
  log?: (msg: string) => void
  /** Called with a change to the connection state. */
  onState?: (status: 'connected' | 'error' | 'connecting' | 'idle', detail?: string) => void
}

/**
 * Feishu / Lark bot transport using the official long-connection (WebSocket)
 * event service, so no public HTTPS URL is required. Sending uses the tenant
 * access token. The "傻瓜式" config only asks for `appId` + `appSecret` from
 * Feishu's open platform.
 */
export class FeishuTransport implements ChannelTransport {
  private wsClient: any = null
  private larkClient: any = null
  private connected = false

  constructor(private readonly options: FeishuChannelOptions) {}

  async start(): Promise<void> {
    const { appId, appSecret } = this.options
    if (!appId || !appSecret) {
      if (this.options.onState) this.options.onState('error', 'missing appId/appSecret')
      throw new Error('feishu channel requires appId and appSecret')
    }

    // Load the vendored SDK lazily so other channels never break if it is
    // missing, and so plugin startup never pays for it.
    const lark = await loadFeishuSdk()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { Client, EventDispatcher, WSClient } = lark as any

    this.larkClient = new Client({ appId, appSecret })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dispatcher = new EventDispatcher({ loggerLevel: 'warn' }).register({
      'im.message.receive_v1': (data: any) => {
        try { this.onReceive(data) } catch (e) { this.options.log?.(`feishu receive error: ${String(e)}`) }
      },
    })

    this.wsClient = new WSClient({
      appId,
      appSecret,
      loggerLevel: 'warn',
      onReady: () => {
        this.connected = true
        this.options.onState?.('connected')
      },
      onReconnecting: () => {
        if (this.options.onState) this.options.onState('connecting', 'reconnecting…')
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onError: (err: any) => {
        this.options.onState?.('error', err instanceof Error ? err.message : String(err))
      },
    })

    this.options.onState?.('connecting')
    try {
      await this.wsClient.start({ eventDispatcher: dispatcher })
    } catch (error) {
      this.options.onState?.('error', error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  private onReceive(data: any): void {
    const message = data?.message
    if (!message) return
    const msgType = message.message_type
    if (msgType !== 'text') return
    const text = this.extractText(message)
    if (!text) return
    const chatId = message.chat_id || message.message_id || ''
    const senderId = data?.sender?.sender_id?.open_id
      || data?.sender?.sender_id?.user_id || ''
    if (!chatId) return
    this.options.onInbound({
      chatId,
      text,
      senderId: senderId || undefined,
      runtime: {
        provider: this.options.provider,
        model: this.options.model,
        maxTokens: this.options.maxTokens,
        disposeAfterReply: this.options.disposeAfterReply,
        channel: 'feishu',
      },
    })
  }

  private extractText(message: any): string {
    try {
      const content = JSON.parse(message.content || '{}')
      return String(content.text || '').trim()
    } catch {
      return ''
    }
  }

  isConnected(): boolean {
    return this.connected
  }

  /** Send a text message into a chat. */
  async sendText(chatId: string, text: string): Promise<void> {
    if (!this.larkClient) throw new Error('feishu channel not started')
    await this.larkClient.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    })
  }

  async stop(): Promise<void> {
    try { await this.wsClient?.close?.() } catch { /* ignore */ }
    this.wsClient = null
    this.larkClient = null
    this.connected = false
    this.options.onState?.('idle')
  }
}
