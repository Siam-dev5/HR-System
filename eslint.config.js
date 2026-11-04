import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/', 'dist/', '.wrangler/', 'public/assets/app.js', '.tmp/', 'worker-configuration.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['warn', { allow: ['error', 'warn'] }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // tests deal with loosely-typed JSON responses
    files: ['tests/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    // runs before the bundle to apply the saved theme without a flash
    files: ['public/assets/theme-init.js'],
    languageOptions: { globals: { window: 'readonly', document: 'readonly', localStorage: 'readonly' } },
  },
  {
    files: ['scripts/**/*.mjs', 'eslint.config.js'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly', Buffer: 'readonly', TextEncoder: 'readonly' } },
  },
  {
    // browser suites: Node code plus callbacks that Playwright runs inside the page (page.evaluate / waitForFunction)
    files: ['tests/ui/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly', process: 'readonly', Buffer: 'readonly', fetch: 'readonly', URL: 'readonly', URLSearchParams: 'readonly', setTimeout: 'readonly',
        document: 'readonly', window: 'readonly', location: 'readonly', localStorage: 'readonly', getComputedStyle: 'readonly', matchMedia: 'readonly',
        innerWidth: 'readonly', innerHeight: 'readonly', scrollX: 'readonly', scrollY: 'readonly', HTMLElement: 'readonly', Image: 'readonly', OffscreenCanvas: 'readonly', createImageBitmap: 'readonly',
      },
    },
  },
);
