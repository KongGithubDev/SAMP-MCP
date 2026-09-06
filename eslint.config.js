import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'eslint.config.js'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      // Dead-code guard: flag imports, locals, args and private members that are never used.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // The codebase is loosely typed by design (protocol buffers, pawn output, MCP params).
      '@typescript-eslint/no-explicit-any': 'off',
      // Guard rails that would have caught recent regressions.
      '@typescript-eslint/no-unused-expressions': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
    },
  }
);
