/**
 * Ambient type stubs for DSH `@deepseek-ai/dsh-client-*` and `@deepseek-ai/dsh-api-remotes`
 * modules. These packages are NOT published / installed in this repo — they are
 * provided by the DSH web runtime at load time. The client half imports them
 * only for their *types* (side-effect `import type {}`), so ambient stubs here
 * let a standalone `tsc` typecheck succeed without the real declarations.
 * Runtime behaviour is verified against the live platform, never these stubs.
 */

declare module '@deepseek-ai/dsh-client-ui-slots'
declare module '@deepseek-ai/dsh-client-locale'
declare module '@deepseek-ai/dsh-client-ui-settings'
declare module '@deepseek-ai/dsh-api-remotes'
