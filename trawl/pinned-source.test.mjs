import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { installPinnedSources } from './pinned-source.mjs';
const revision='0123456789abcdef0123456789abcdef01234567';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const root=await mkdtemp(join(tmpdir(),'trawl-pin-test-'));
  const bytes=Buffer.from('synthetic public source\n');
  const config={revision,files:[{name:'helper.mjs',target:join(root,'installed.mjs'),sha256:hash(bytes)}]};
  const extract=async(dir,c)=>{assert.equal(c.revision,revision);await writeFile(join(dir,'helper.mjs'),bytes);};
  const fetcher=async(url,options)=>{
    assert.equal(url,`https://codeload.github.com/plhery/universal-parcel-scraper/tar.gz/${revision}`);
    assert.equal(options.redirect,'error');assert(options.signal instanceof AbortSignal);
    return new Response('synthetic archive');
  };
  return{root,bytes,config,extract,fetcher};
}
test('pinned installation verifies bytes before writing the requested module',async()=>{
  const f=await fixture();try{
    await installPinnedSources(f.config,f);assert.deepEqual(await readFile(f.config.files[0].target),f.bytes);
  }finally{await rm(f.root,{recursive:true,force:true});}
});
test('a changed source hash never installs a file',async()=>{
  const f=await fixture();try{
    f.config.files[0].sha256='0'.repeat(64);
    await assert.rejects(installPinnedSources(f.config,f),/hash mismatch/);
    await assert.rejects(access(f.config.files[0].target));
  }finally{await rm(f.root,{recursive:true,force:true});}
});
test('download refusal, oversized archive and extraction failure stop installation',async()=>{
  for(const change of [
    {fetcher:async()=>new Response('',{status:403})},
    {fetcher:async()=>new Response('x',{headers:{'content-length':'50000001'}})},
    {extract:async()=>{throw Error('synthetic extraction error');}},
  ]){
    const f=await fixture();try{
      await assert.rejects(installPinnedSources(f.config,{...f,...change}));
      await assert.rejects(access(f.config.files[0].target));
    }finally{await rm(f.root,{recursive:true,force:true});}
  }
});
test('source revision and member names cannot alter the archive request or tar arguments',async()=>{
  const f=await fixture();try{
    await assert.rejects(installPinnedSources({...f.config,revision:'main'},f),/Invalid pinned/);
    await assert.rejects(installPinnedSources({...f.config,files:[{...f.config.files[0],name:'../helper.mjs'}]},f),/Invalid pinned/);
  }finally{await rm(f.root,{recursive:true,force:true});}
});
