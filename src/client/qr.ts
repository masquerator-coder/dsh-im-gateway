/**
 * Login-QR rendering for the channel panel.
 *
 * WHY THIS EXISTS: the ilink `get_bot_qrcode` response field is named
 * `qrcode_img_content`, but it is **not** image content — it is the URL of an
 * HTML page (`https://liteapp.weixin.qq.com/q/<app>?qrcode=<key>&bot_type=3`,
 * served as `text/html`). That page is a Vue app that draws the QR itself with
 * `toCanvas(canvas, window.location.href, { width: 250, margin: 2 })`, so the
 * scannable string is the URL verbatim. Feeding the URL to `<img src>` (as the
 * panel used to) can only ever produce a broken image, and the page cannot be
 * framed instead (`x-frame-options: SAMEORIGIN`).
 *
 * So the panel encodes that URL locally and renders the QR itself. Same payload
 * as the official page → scanning either one opens the same bind flow.
 */

import qrcode from 'qrcode-generator'

/**
 * Display size (px) of the QR box. The generated SVG is scalable (viewBox +
 * 100% width/height), so any size stays crisp; this matches the panel layout.
 */
export const QR_SIZE_PX = 168

/**
 * Error-correction level — `M` matches the `qrcode` package default used by the
 * official liteapp page, so the two QR codes carry identical modules.
 */
const EC_LEVEL = 'M'

/**
 * Quiet zone in modules. The official page passes `margin: 2`; we keep the
 * spec's 4-module quiet zone because the panel shows the code next to a
 * coloured border, and a QR needs that white margin to scan reliably.
 */
const MARGIN_MODULES = 4

/**
 * Encode a login-QR payload (the ilink bind URL) as a standalone SVG string.
 * The SVG paints its own white background, so the code stays scannable in the
 * dark theme as well.
 * @param payload - the URL reported by the transport's `onQr`.
 * @returns an `<svg>` string, or `''` when there is nothing to encode.
 */
export function qrSvgFor(payload: string): string {
  const text = (payload ?? '').trim()
  if (text === '') return ''
  try {
    // Type number 0 = pick the smallest version that fits (the bind URL is ~90
    // chars, which lands on version 6 / 41 modules).
    const qr = qrcode(0, EC_LEVEL)
    qr.addData(text)
    qr.make()
    // cellSize is nominal here: `scalable` emits a viewBox, so the box size
    // drives the rendering size. The output is pure data-driven markup (the
    // payload only selects modules, it is never interpolated), hence safe to
    // inject as HTML.
    return qr.createSvgTag({ cellSize: 4, margin: MARGIN_MODULES, scalable: true })
  } catch {
    // MUST NOT THROW. This runs inside a React render (`useMemo` in the panel),
    // so an exception here does not degrade the QR — it takes down the entire
    // settings panel. `qrcode-generator` rejects a payload too long for its
    // largest version, and the payload is gateway-supplied data that the panel
    // does not control. `''` renders the "no QR yet" state instead of a crash.
    return ''
  }
}
