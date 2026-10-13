import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/',
      'node_modules/',
      'build.mjs',
      'eslint.config.js',
      // 舊版 v2 擴充功能與 OCR 後端實驗，保留在本機但不納入版控，也不檢查。
      '*.js',
      'dots-ocr/',
      'runpod-*/',
      'paddleocrvl-pipeline-worker/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
);
