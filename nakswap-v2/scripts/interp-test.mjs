// Runs src/test/e2e.mo in the Motoko interpreter (npm `motoko` package): no replica,
// no PocketIC, no dfx. The interpreter does not support `mixin`/`include`, so this
// script first inlines each mixin into a temporary copy of the router.
//
//   npm i --no-save motoko@5     (once)
//   mops install                 (puts mo:core in .mops/)
//   node --stack-size=50000 scripts/interp-test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mo = require('motoko');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function load(realDir, virtDir, transform = (p, s) => s) {
  for (const name of fs.readdirSync(realDir)) {
    const real = path.join(realDir, name);
    const virt = `${virtDir}/${name}`;
    if (fs.statSync(real).isDirectory()) load(real, virt, transform);
    else if (name.endsWith('.mo')) mo.write(virt, transform(virt, fs.readFileSync(real, 'utf8')));
  }
}

// Inline `include X(args);` for mixins whose parameter names match the actor's bindings.
function flatten(virtPath, src) {
  if (!src.includes('include ')) return src;
  const dir = path.dirname(virtPath);
  const imports = new Map(); // alias -> path
  for (const m of src.matchAll(/^import (\w+) "([^"]+)";$/gm)) imports.set(m[1], m[2]);
  const extraImports = new Set();
  const out = src.replace(/^(\s*)include (\w+)\(([^)]*)\);$/gm, (_, indent, alias) => {
    const rel = imports.get(alias);
    const file = path.join(root, 'src', path.relative('src', dir), rel + '.mo');
    const msrc = fs.readFileSync(file, 'utf8');
    for (const m of msrc.matchAll(/^import (\w+) "([^"]+)";$/gm)) {
      let p = m[2];
      if (!p.startsWith('mo:')) p = path.posix.normalize(path.posix.join(path.posix.dirname(rel), p));
      extraImports.add(`import ${m[1]} "${p}";`);
    }
    const start = msrc.indexOf('{', msrc.indexOf(') {', msrc.indexOf('mixin')));
    const end = msrc.lastIndexOf('};');
    return `${indent}// --- inlined ${alias} ---\n${msrc.slice(start + 1, end)}`;
  });
  const existing = new Set([...src.matchAll(/^import .*$/gm)].map((m) => m[0]));
  const add = [...extraImports].filter((l) => {
    const alias = l.split(' ')[1];
    return ![...existing].some((e) => e.split(' ')[1] === alias);
  });
  return add.join('\n') + '\n' + out.replace(/^import \w+ "mixins\/[^"]+";$/gm, '');
}

// Second interpreter quirk: calls made from an `async*` function that lives in a *module*
// carry the wrong caller (the compiled canister is fine). So the router's Engine module is
// also inlined into the actor for the interpreter run.
function inlineModule(src, alias, rel, dirOfImporter) {
  const file = path.join(root, 'src', dirOfImporter, rel + '.mo');
  const msrc = fs.readFileSync(file, 'utf8');
  const imports = [];
  for (const m of msrc.matchAll(/^import (\w+) "([^"]+)";$/gm)) {
    let p = m[2];
    if (!p.startsWith('mo:')) p = path.posix.normalize(path.posix.join(path.posix.dirname(rel), p));
    imports.push(`import ${m[1]} "${p}";`);
  }
  let body = msrc.slice(msrc.indexOf('module {') + 'module {'.length, msrc.lastIndexOf('};'));
  body = body.replace(/\bpublic func\b/g, 'func').replace(/\bpublic type\b/g, 'type');
  let out = src.replace(new RegExp(`^import ${alias} "[^"]+";$`, 'm'), '');
  out = out.replace(new RegExp(`\\b${alias}\\.`, 'g'), '');
  out = out.replace(/(actor class [^{]*\{)/, `$1\n  // --- inlined ${alias} ---\n${body}\n`);
  const have = new Set([...out.matchAll(/^import (\w+) /gm)].map((m) => m[1]));
  return imports.filter((l) => !have.has(l.split(' ')[1])).join('\n') + '\n' + out;
}

const coreDir = fs.readdirSync(path.join(root, '.mops')).find((d) => d.startsWith('core@'));
load(path.join(root, '.mops', coreDir, 'src'), 'pkg/core');
mo.usePackage('core', 'pkg/core');
load(path.join(root, 'src'), 'src', (virt, s) => {
  // The interpreter has no cycles or controller primitives: stub them (plenty of cycles,
  // nobody is a controller) so the e2e run exercises the order logic.
  s = flatten(virt, s);
  if (virt === 'src/router/main.mo') s = inlineModule(s, 'Engine', 'lib/Engine', 'router');
  return s.replace(/Cycles\.balance\(\)/g, '(10_000_000_000_000 : Nat)').replace(/caller\.isController\(\)/g, 'false');
});

const r = mo.run('src/test/e2e.mo');
process.stdout.write(r.stdout || '');
const errs = (r.stderr || '').split('\n').filter((l) => l && !l.includes('warning') && !/^\s+Nat$/.test(l));
if (errs.length) process.stderr.write(errs.join('\n') + '\n');
process.exit((r.stdout || '').includes('ALL PASSED') ? 0 : 1);
