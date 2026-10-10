/* eslint-disable @typescript-eslint/no-require-imports -- Server origin regression tests. */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {NextRequest}=require('next/server');
const {loadServer}=require('../scripts/server-loader.cjs');
const {checkOrigin}=loadServer('lib/admin-http.ts');
test('Admin origin checks accept the real loopback Host despite NextURL normalization',()=>{
  for(const host of ['localhost:3102','127.0.0.1:3102','[::1]:3102']) {
    const request=new NextRequest(`http://${host}/api/admin/session`,{headers:{Host:host,Origin:`http://${host}`}});
    assert.doesNotThrow(()=>checkOrigin(request));
  }
});
test('Admin origin checks still reject cross-site, alias-origin and forged proxy headers',()=>{
  for(const headers of [
    {Host:'127.0.0.1:3102',Origin:'http://localhost:3102'},
    {Host:'localhost:3102',Origin:'https://untrusted.example'},
    {Host:'localhost:3102',Origin:'http://localhost:3102','sec-fetch-site':'cross-site'},
    {Host:'localhost:3102',Origin:'https://untrusted.example','x-forwarded-host':'untrusted.example','x-forwarded-proto':'https'},
    {Host:'fake@localhost:3102',Origin:'http://localhost:3102'},
  ]) assert.throws(()=>checkOrigin(new NextRequest('http://localhost:3102/api/admin/settings',{headers})),{status:403});
});
