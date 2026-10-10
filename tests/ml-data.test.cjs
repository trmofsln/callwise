/* eslint-disable @typescript-eslint/no-require-imports -- Python contract verification wrapper. */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
test('data contracts reject unknown labels, leaking history and crossing retry chains',()=>{
  const result=spawnSync('python',['-m','unittest','discover','-s','tests','-p','ml_data_checks.py'],{encoding:'utf8',timeout:60000});
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.match(result.stderr,/Ran 9 tests/);
});
