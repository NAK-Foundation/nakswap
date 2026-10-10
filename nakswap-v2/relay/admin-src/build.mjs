// Bundles main.js into ../public/admin/app.js (served by the relay at /admin).
import { build } from 'esbuild';
await build({
  entryPoints: [new URL('./main.js', import.meta.url).pathname],
  outfile: process.env.OUTFILE || new URL('../public/admin/app.js', import.meta.url).pathname,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  legalComments: 'linked',
  define: { global: 'globalThis', __TEST_SEED__: process.env.TEST_SEED ? JSON.stringify(process.env.TEST_SEED) : 'null' },
});
console.log('built public/admin/app.js');
