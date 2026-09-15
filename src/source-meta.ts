/**
 * Model-visible source attribution for the IM gateway.
 *
 * An inbound IM message can tell the model WHICH channel and WHICH sender asked,
 * by prepending a `<dsh_im_source>{channel, senderId}</dsh_im_source>` block to
 * the prompt. That block is part of the user message text, so it is persisted in
 * the session, shown verbatim as the user bubble in the session view, and
 * replayed in the history of every later turn.
 *
 * Emitting it on every message therefore costs tokens each turn and clutters the
 * transcript while telling the model nothing it cannot already read from the
 * earlier message. The block is consequently emitted only when the source
 * CHANGES for a session: its first message, a different sender, or a different
 * channel. Compaction can shadow the span that carried it (the summary need not
 * preserve the channel), so the caller resets the session when that happens.
 *
 * This module deliberately imports nothing from the DSH runtime, which is what
 * lets `scripts/smoke.mts` verify the contract offline (the gateway itself
 * cannot be imported without a full peer install).
 */

/** Tag name of the injected block. */
const TAG = 'dsh_im_source'

/** Per-session source attribution state for one gateway instance. */
export class SourceMetadata {
  /** session id → the payload currently present in that session's history. */
  private readonly injected = new Map<string, string>()

  /**
   * Prompt text for one inbound message: the original `text`, prefixed with the
   * source block only when this session does not already carry that exact
   * payload (or carries none). `channel`/`senderId` that are absent/empty
   * contribute nothing; a message with neither yields the plain text.
   */
  compose(
    sessionId: string,
    channel: string | undefined,
    senderId: string | undefined,
    text: string,
  ): string {
    const meta: Record<string, string> = {}
    if (channel !== undefined && channel !== '') meta.channel = channel
    if (senderId !== undefined && senderId !== '') meta.senderId = senderId
    if (Object.keys(meta).length === 0) return text
    const payload = JSON.stringify(meta)
    if (this.injected.get(sessionId) === payload) return text
    this.injected.set(sessionId, payload)
    return `<${TAG}>${payload}</${TAG}>\n\n${text}`
  }

  /**
   * Forget one session's payload. Called when compaction replaced the span that
   * carried the block, so the next inbound message re-attributes the source.
   */
  reset(sessionId: string): void {
    this.injected.delete(sessionId)
  }

  /** Drop every remembered payload (plugin unload). */
  clear(): void {
    this.injected.clear()
  }
}
