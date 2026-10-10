/* eslint-disable @typescript-eslint/no-require-imports -- Offline CLI/test loader for server TypeScript. */
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function loadServer(filename, overrides = {}, cache = new Map()) {
  const file = path.resolve(filename);
  if (cache.has(file)) return cache.get(file).exports;
  const mod = { exports: {} }; cache.set(file, mod);
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const localRequire = name => {
    if (Object.hasOwn(overrides, name)) return overrides[name];
    if (name.startsWith('.') || name.startsWith('@/')) {
      const target = name.startsWith('@/') ? path.resolve(name.slice(2)) : path.resolve(path.dirname(file), name);
      if (target.endsWith('.json')) return require(target);
      return loadServer(target.endsWith('.ts') ? target : `${target}.ts`, overrides, cache);
    }
    return require(name);
  };
  new Function('require', 'module', 'exports', compiled)(localRequire, mod, mod.exports);
  return mod.exports;
}
module.exports = { loadServer };
