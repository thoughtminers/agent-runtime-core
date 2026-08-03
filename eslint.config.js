import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**'],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // @thoughtminers/agent-runtime-core must have ZERO runtime dependencies: only
    // node builtins (via the node: prefix) and its own relative modules may be imported.
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?!\\.|node:).*',
              message:
                '@thoughtminers/agent-runtime-core is zero-dependency: import only node:* builtins or relative modules.',
            },
          ],
        },
      ],
    },
  }
);
