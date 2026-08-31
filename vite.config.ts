import preact from '@preact/preset-vite';
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';

// 本扩展不 import 宿主 ST 的任何模块 —— 需要的能力全部经 globalThis.SillyTavern.getContext()
// 拿到(见 src/st/context.ts)。因此无需把 dist/ 到 ST public/ 的相对路径算进构建,
// 仓库放在 ST 目录外也能正常构建。
const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'),
) as { version?: string };

export default defineConfig(({ mode }) => ({
  define: {
    __SRDB_VERSION__: JSON.stringify(String(packageJson.version ?? '0.0.0')),
  },

  plugins: [preact()],

  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },

  // 索引构建 Worker 也走 ES 模块,便于直接 import 共享的纯函数模块。
  worker: { format: 'es' },

  build: {
    rollupOptions: {
      input: 'src/index.tsx',
      output: {
        format: 'es',
        entryFileNames: 'index.js',
        chunkFileNames: '[name].[hash].chunk.js',
        assetFileNames: '[name].[ext]',
      },
    },
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: mode === 'production' ? true : 'inline',
    minify: mode === 'production',
    target: 'esnext',
  },
}));
