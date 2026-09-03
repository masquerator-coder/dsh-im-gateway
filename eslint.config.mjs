// dsh-im-gateway — ESLint flat config (ESLint 9/10 + typescript-eslint).
//
// Host half (`src/*.ts`) + browser half (`src/client/*.tsx`) are both typechecked
// by typescript-eslint. Build output and vendored lockfiles never linted.
// `pnpm lint` runs this; `pnpm lint:fix` auto-fixes what it safely can.
//
// Note: this plugin deliberately uses `any` on DSH runtime faces that have no
// published types (see src/client/dsh-stubs.d.ts). `@typescript-eslint/
// no-explicit-any` is therefore a warning, not an error, so it stays visible
// without failing the build.

import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

const reactHooksConfigs = reactHooks.configs ?? {}

export default tseslint.config(
  {
    ignores: [
      '**/.pnpm-store/**',
      '**/node_modules/**',
      'lib/**',
      '**/*.map',
      'scripts/**',
      'design/**',
      'video/**',
      'dsh-cmcc-newmsg/**',
      'pnpm-lock.yaml',
    ],
  },
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/client/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // Classic hooks rules only. The v7 "recommended-latest" preset adds
      // `react-hooks/set-state-in-effect`, which false-positives on this
      // section's "sync the form to the selected channel" effect — so use the
      // two classic rules and disable the new one.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/set-state-in-effect': 'off',
    },
  },
)
