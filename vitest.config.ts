import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'url';
import { resolve } from 'path';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/test/**', 'src/ui/**', 'src/extension.ts'],
    },
  },
  resolve: {
    alias: {
      vscode: resolve(__dirname, 'src/test/__mocks__/vscode.ts'),
    },
  },
});
