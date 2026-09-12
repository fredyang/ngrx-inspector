import stylistic from '@stylistic/eslint-plugin';
import typescriptParser from '@typescript-eslint/parser';

const controlStatements = ['if', 'for', 'while', 'do', 'switch', 'try', 'function', 'class'];

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'coverage/**',
      '.vitest/**',
      '.vite/**',
      '.nyc_output/**',
    ],
  },
  {
    files: ['**/*.{js,cjs,mjs,ts,tsx}'],
    plugins: { '@stylistic': stylistic },
    rules: {
      curly: ['error', 'all'],
      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: ['const', 'let', 'var'], next: '*' },
        { blankLine: 'any', prev: ['const', 'let', 'var'], next: ['const', 'let', 'var'] },
        { blankLine: 'always', prev: '*', next: ['return', 'throw'] },
        { blankLine: 'always', prev: '*', next: controlStatements },
        { blankLine: 'always', prev: controlStatements, next: '*' },
        { blankLine: 'always', prev: 'multiline-const', next: 'const' },
        { blankLine: 'always', prev: 'import', next: '*' },
        { blankLine: 'any', prev: 'import', next: 'import' },
      ],
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { parser: typescriptParser },
  },
];
