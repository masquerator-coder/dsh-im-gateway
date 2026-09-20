/**
 * Ambient type stubs for DSH `@deepseek-ai/dsh-client-*` and `@deepseek-ai/dsh-api-remotes`
 * modules. These packages are NOT published / installed in this repo — they are
 * provided by the DSH web runtime at load time. The client half imports them
 * only for their *types* (side-effect `import type {}`), so ambient stubs here
 * let a standalone `tsc` typecheck succeed without the real declarations.
 * Runtime behaviour is verified against the live platform, never these stubs.
 *
 * `@deepseek-ai/dsh-client-ui-plugin-manager/client` carries the declaration
 * merge for the `plugins.bundle.config` slot this plugin registers into (see
 * src/client/index.ts); the import is type-only because cross-plugin
 * collaboration goes through cordis services, never a value import.
 */

declare module '@deepseek-ai/dsh-client-ui-slots'
declare module '@deepseek-ai/dsh-client-locale'
declare module '@deepseek-ai/dsh-client-ui-settings'
declare module '@deepseek-ai/dsh-client-ui-plugin-manager/client'
declare module '@deepseek-ai/dsh-api-remotes'
