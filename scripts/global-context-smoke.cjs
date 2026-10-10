/* eslint-disable @typescript-eslint/no-require-imports -- Node integration verification harness. */
require("@next/env").loadEnvConfig(process.cwd());
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const modules = new Map();
function load(filename) {
  const absolute = path.resolve(filename);
  if (modules.has(absolute)) return modules.get(absolute).exports;
  const loadedModule = { exports: {} };
  modules.set(absolute, loadedModule);
  const code = ts.transpileModule(fs.readFileSync(absolute, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const localRequire = (name) => name.startsWith(".") ? load(path.resolve(path.dirname(absolute), `${name}.ts`)) : require(name);
  vm.runInThisContext(`(function(require,module,exports){${code}\n})`)(localRequire, loadedModule, loadedModule.exports);
  return loadedModule.exports;
}

(async () => {
  const contexts = await load("lib/global-context.ts").fetchGlobalContexts(process.argv.slice(2).length ? process.argv.slice(2) : ["441"]);
  const { findContextSegment, GLOBAL_CONTEXT_SEGMENTS } = load("lib/global-context-catalog.ts");
  const store = load("lib/sqlite.ts").getAdminStore();
  const saved = await Promise.all(contexts.map((context) => store.getLatestGlobalContext(context.glid)));
  console.log(JSON.stringify(contexts.map((context, index) => ({
    glid: context.glid, status: context.status, mappingId: context.mappingId, error: context.error,
    requestedSegments: context.requestedSegments,
    returnedSegments: GLOBAL_CONTEXT_SEGMENTS.filter((key) => findContextSegment(context.data, key) !== undefined),
    responseKeys: context.response && typeof context.response === "object" ? Object.keys(context.response) : [],
    dataKeys: context.data && typeof context.data === "object" ? Object.keys(context.data) : [],
    snapshotSaved: !!saved[index],
  })), null, 2));
  if (contexts.some((context) => context.status !== "success" || context.error)) process.exitCode = 1;
})().catch(() => { console.error("Global Context verification failed."); process.exitCode = 1; });
