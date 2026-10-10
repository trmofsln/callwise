/* eslint-disable @typescript-eslint/no-require-imports -- Standalone slide export in isolated hidden Chrome. */
const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const pdf=path.resolve('docs/best-time-to-call/presentation.pdf');
const result=spawnSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--disable-gpu','--no-first-run',`--user-data-dir=${path.resolve('.data/btc-slide-browser')}`,`--print-to-pdf=${pdf}`,'--no-pdf-header-footer',pathToFileURL(path.resolve('docs/best-time-to-call/presentation.html')).href],{encoding:'utf8',windowsHide:true,timeout:30000});
if(result.status!==0||!fs.existsSync(pdf)){console.error('Slide export failed.');process.exitCode=1;}else console.log(JSON.stringify({pdf,pdf_bytes:fs.statSync(pdf).size}));
