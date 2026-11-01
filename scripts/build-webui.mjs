/**
 * 打包 World 页的浏览器产物:webui/client.ts -> dist/webui.js + dist/webui.css。
 * package.json 的 cortico.webUiClient / webUiStyle 指这两个文件;浏览器端只 import type,
 * 产物里不含任何 cortico/* 运行时依赖。
 */
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = join(root, 'dist');
const entry = join(root, 'webui', 'client.ts');

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

await esbuild.build({
  entryPoints: [entry],
  outdir,
  entryNames: 'webui',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
});

for (const file of ['webui.js', 'webui.css']) {
  const path = join(outdir, file);
  if (!existsSync(path)) {
    console.error(`缺少产物 ${path}`);
    process.exit(1);
  }
  console.log(`${file}  ${(statSync(path).size / 1024).toFixed(1)} KiB`);
}
