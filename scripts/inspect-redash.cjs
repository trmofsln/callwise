/* eslint-disable @typescript-eslint/no-require-imports -- Node CLI harness. */
require("@next/env").loadEnvConfig(process.cwd());
const fs = require("node:fs");
const ts = require("typescript");
const vm = require("node:vm");
const compiled = ts.transpileModule(fs.readFileSync("lib/redash.ts", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const serverModule = { exports: {} };
vm.runInThisContext(`(function(require,module,exports){${compiled}\n})`)(require, serverModule, serverModule.exports);
const query = process.argv[2] || "SELECT database, name FROM system.tables WHERE name IN ('glusr_usr','company','sts_company','employee','iil_vertical') ORDER BY database, name";
const dataSourceId = Number(process.argv[3] || process.env.REDASH_DATA_SOURCE_ID || 70);
serverModule.exports.runQuery({ query, dataSourceId, queryIdEnv: dataSourceId === 13 ? "REDDASH_USER_QUERY_ID" : "REDDASH_ADHOC_QUERY_ID" }).then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
