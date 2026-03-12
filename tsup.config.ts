import { defineConfig } from 'tsup';

/**
 * @input tsup 构建器与 src/index.ts 入口
 * @output dist/index.js 与类型声明
 * @position wx-filehelper 插件构建配置
 * @auto-doc Update header and folder INDEX.md when this file changes
 */

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
});
