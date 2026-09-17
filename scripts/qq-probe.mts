#!/usr/bin/env node
/**
 * QQ 通道真机探针 —— 不经过 DSH 宿主，直接把 QQBotTransport 指向真实开放平台跑一遍：
 * 取 AccessToken → 取网关地址 → WebSocket 鉴权（IDENTIFY/RESUME）→ 收消息 → 被动回复。
 *
 * 用途（与微信那次的 inbound-probe 同性质）：把「面板说连接中/报错」这件事拆开，
 * 明确告诉你卡在哪一步、平台原话是什么。所有失败都按面板会显示的口径打印出来，
 * 并且**不会**打印 AppSecret / AccessToken。
 *
 * 用法:
 *   node --experimental-transform-types scripts/qq-probe.mts <appId> <appSecret> [选项]
 *   pnpm qq-probe <appId> <appSecret> [选项]
 *
 * 选项:
 *   --ints <规格>     订阅事件，十进制位掩码或关键字（默认 c2c,public_guild）
 *   --sandbox         使用沙箱环境网关 https://sandbox.api.sgroup.qq.com
 *   --api <base>      覆盖 API 基地址（默认 https://api.bot.qq.com）
 *   --token-url <url> 覆盖取票地址（默认 https://api.bot.qq.com/app/getAppAccessToken）
 *   --seconds <n>     连接成功后等待收消息的秒数（默认 90，0 = 连上即退出）
 *   --no-reply        只收不回（默认会把收到的消息用「探针回执」被动回复一次）
 *
 * 退出码: 0 = 握手成功；2 = 连接失败或用错了参数（原因见打印）。
 * 注意: 这里只设置 process.exitCode、绝不调用 process.exit()——在 Windows 上
 * 一边关 ws/socket 句柄一边强退会让 libuv 直接 abort（退出码变成 0xC0000409）。
 */

import { QQBotTransport, DEFAULT_INTENTS, parseIntents } from '../src/transports/qqbot.ts'

interface Args {
  appId: string
  appSecret: string
  intents?: string
  sandbox: boolean
  api?: string
  tokenUrl?: string
  seconds: number
  reply: boolean
}

const USAGE = '用法: node --experimental-transform-types scripts/qq-probe.mts <appId> <appSecret> [选项]\n'
  + '选项: --ints <c2c,public_guild|位掩码> --sandbox --api <base> --token-url <url> --seconds <n> --no-reply\n'

const log = (line: string): void => { process.stdout.write(`${line}\n`) }

function parseArgs(argv: string[]): Args {
  const positional: string[] = []
  const out: Args = { appId: '', appSecret: '', sandbox: false, seconds: 90, reply: true }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const next = (): string => {
      const value = argv[++i]
      if (value === undefined) throw new Error(`${arg} 需要一个取值`)
      return value
    }
    switch (arg) {
      case '--ints': out.intents = next(); break
      case '--api': out.api = next(); break
      case '--token-url': out.tokenUrl = next(); break
      case '--seconds': out.seconds = Number(next()); break
      case '--sandbox': out.sandbox = true; break
      case '--no-reply': out.reply = false; break
      case '-h':
      case '--help': positional.length = 0; out.appId = ''; out.appSecret = ''; out.seconds = -1; break
      default:
        if (arg.startsWith('--')) throw new Error(`未知选项：${arg}`)
        positional.push(arg)
    }
  }
  out.appId = positional[0] ?? ''
  out.appSecret = positional[1] ?? ''
  return out
}

/** Print the fixes for the failure modes the probe can meet. */
function printRemedies(): void {
  log('排查建议：')
  log('  1) 关闭码 4014（intent 无权限）：机器人未获得「单聊 / 群聊」等事件权限 —— 请到 q.qq.com 申请并提审；')
  log('     若只想先验证链路，可用 --ints public_guild 只订阅默认有权限的公域频道事件。')
  log('  2) 关闭码 4914 / 4915：机器人已下架或封禁，加 --sandbox 或用另一个机器人。')
  log('  3) code 100007 / 100016 / 10004：AppID 或 AppSecret 不正确（或机器人不存在）。')
  log('  4) code 11253：该机器人未获得调用接口的权限（需在开放平台申请）。')
}

async function main(): Promise<number> {
  let args: Args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    log(`✗ ${error instanceof Error ? error.message : String(error)}`)
    log(USAGE)
    return 2
  }
  if (args.seconds === -1) { log(USAGE); return 0 }
  if (!args.appId || !args.appSecret) {
    log('✗ 需要 AppID 与 AppSecret 两个参数（q.qq.com → 机器人 → 开发设置）')
    log(USAGE)
    return 2
  }

  // 先把要订阅的事件算出来：写错了要立刻告诉用户，而不是等网关秒断。
  let intents: number
  try {
    intents = parseIntents(args.intents)
  } catch (error) {
    log(`✗ intents 无效：${error instanceof Error ? error.message : String(error)}`)
    return 2
  }

  const inbound: Array<{ chatId: string; text: string }> = []
  const states: string[] = []

  log('=== QQ 通道探针 ===')
  log(`AppID      : ${args.appId}`)
  log(`密钥       : 已提供（${args.appSecret.length} 位，不打印）`)
  log(`API 基地址 : ${args.sandbox ? 'https://sandbox.api.sgroup.qq.com（沙箱）' : args.api || 'https://api.bot.qq.com'}`)
  log(`取票地址   : ${args.tokenUrl || 'https://api.bot.qq.com/app/getAppAccessToken'}`)
  log(`订阅事件   : ${intents}${args.intents ? '' : `（默认 ${DEFAULT_INTENTS} = c2c + public_guild）`}`)
  log('')

  const transport = new QQBotTransport({
    appId: args.appId,
    clientSecret: args.appSecret,
    apiBase: args.api,
    sandbox: args.sandbox,
    tokenUrl: args.tokenUrl,
    intents,
    onInbound: (route) => {
      inbound.push({ chatId: route.chatId, text: route.text })
      log(`← 收到消息 chatId=${route.chatId} sender=${route.senderId ?? '(无)'} 文本=${JSON.stringify(route.text.slice(0, 200))}`)
      if (!args.reply) return
      void transport.sendText(route.chatId, `✅ 探针收到：${route.text.slice(0, 80)}`)
        .then(() => log('→ 已被动回复（QQ 里应能看到回执）'))
        .catch((error: unknown) => log(`✗ 回复失败：${error instanceof Error ? error.message : String(error)}`))
    },
    log: (message) => log(`  [transport] ${message}`),
    onState: (status, detail) => {
      states.push(`${status}${detail ? `: ${detail}` : ''}`)
      log(`  [state] ${status}${detail ? ` — ${detail}` : ''}`)
    },
  })

  log('正在连接…')
  try {
    await transport.start()
  } catch (error) {
    log('')
    log(`✗ 连接失败：${error instanceof Error ? error.message : String(error)}`)
    log('')
    printRemedies()
    await transport.stop().catch(() => {})
    return 2
  }

  log('')
  log('✅ 已连接（READY/RESUMED）：链路本身是通的。')
  if (args.seconds > 0) {
    log(`现在请在 QQ 里给机器人发一条消息（群聊需 @机器人）—— 本探针会等 ${args.seconds} 秒。`)
    await new Promise<void>((resolve) => { setTimeout(resolve, args.seconds * 1000) })
  }

  const stillConnected = transport.isConnected()
  log('')
  log('=== 小结 ===')
  log(`连接状态   : ${stillConnected ? '已连接' : '未连接（期间断开过，原因见上方 [transport]）'}`)
  log(`收到消息   : ${inbound.length} 条`)
  log(`状态变化   : ${states.length > 0 ? states.join(' | ') : '(无)'}`)
  if (inbound.length === 0 && args.seconds > 0) {
    log('')
    log('一条消息都没收到？按这两步区分是谁的问题：')
    log('  · 单聊：在 QQ 里搜索机器人（或用「机器人」卡片）发起会话，消息才可能进来；')
    log('  · 群聊：必须把机器人拉进群并 @ 它；未提审通过前平台只对白名单账号推送。')
    log('  · 关闭码速查：4009 连接过期（会 RESUME 补发）、4014 intent 无权限（需在 q.qq.com 申请）、'
      + '4915 机器人已封禁（不可重试）。')
  }
  await transport.stop().catch(() => {})
  return 0
}

process.exitCode = await main()
