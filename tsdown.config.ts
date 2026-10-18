import { defineConfig } from 'tsdown'

/**
 * 宿主半身一个入口：tsc 先把 src/host 出到 lib/types，tsdown 再把它捆成 lib/host/index.js。
 * 这份形状照 DSH 自己的插件包写（入口取编译产物、format/platform/target 三样与它们一致）。
 * 这一份配置只管宿主那一半：下面这张表里只有宿主那一个入口。
 *
 * 浏览器半身是 src/client/ 那一份（五个源码文件加它自己的 tsconfig 与 virtual.d.ts，共七个），
 * 产物不由 tsdown 出——tools/build-client.mjs 把样式收拢到面板那一层、再用 rolldown 捆成
 * lib/client.js（`npm run bundle:client`），配 package.json 的 `exports["./client"]`。
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
  /* schemastery 由宿主提供（peerDependency），本仓不装它，捆的时候也不许去找它：
     这一条留在外面，产物里那句动态 import 照原样进包，装载时由宿主的模块图接上。 */
  deps: { neverBundle: ['@deepseek-ai/schemastery'] },
})