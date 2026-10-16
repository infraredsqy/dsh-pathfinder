import { defineConfig } from 'tsdown'

/**
 * 宿主半身一个入口：tsc 先把 src/host 出到 lib/types，tsdown 再把它捆成 lib/host/index.js。
 * 这份形状照 DSH 自己的插件包写（入口取编译产物、format/platform/target 三样与它们一致）。
 *
 * 浏览器半身进来的时候在这一份里加它自己的入口；DSH 那边是给 client 侧单开一份配置，
 * 到时候照它们的写法加，本格的 src/client 还是空的。
 */
export default defineConfig({
  entry: { 'host/index': 'lib/types/host/index.js' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})