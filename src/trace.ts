/**
 * Minimal diagnostic file trace for the approval/question delivery path.
 *
 * `ctx.logger` output is routed by the DSH host (GUI/telemetry) and does NOT
 * reach the stdout redirection of `pnpm dsh web`, which made live debugging of
 * "[im-gateway] …" lines impossible. This module writes straight to a file so
 * a reproduction can be captured without relying on the host logger.
 *
 * Enabled only when `DSH_IM_GATEWAY_TRACE=1` is set in the dsh process env.
 * File: `<DSH_HOME or ~/.dsh>/dsh-im-gateway-trace.log`, appended per line.
 * Failures to open/write are swallowed (tracing must never break the host).
 */

import { appendFile } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ENABLED = process.env.DSH_IM_GATEWAY_TRACE === '1'
const FILE = join(
  process.env.DSH_HOME ?? join(homedir(), '.dsh'),
  'dsh-im-gateway-trace.log',
)

/** Append one trace line; safe no-op when tracing is disabled. */
export function trace(message: string): void {
  if (!ENABLED) return
  const line = `${new Date().toISOString()} ${message}\n`
  appendFile(FILE, line, () => { /* best-effort */ })
}

/** True when the diagnostic trace file is active (for cheap pre-checks). */
export function tracing(): boolean {
  return ENABLED
}
