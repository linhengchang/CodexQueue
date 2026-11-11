import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findCodex } from '../dist/server/codex.js';
import { Engine } from '../dist/server/engine.js';
import { Store } from '../dist/server/store.js';
async function root() { return mkdtemp(path.join(os.tmpdir(), 'auto-work-codex-')); }
async function fake(file, body) { await mkdir(path.dirname(file), {recursive:true}); await writeFile(file, `#!${process.execPath}\n${body}`); await chmod(file,0o755); }
test('Finder-style PATH resolves bundled CLI without invoking a login shell', async()=>{
 const home=await root();const binary=path.join(home,'Applications','ChatGPT.app','Contents','Resources','codex-cli','CodexCLI.app','Contents','MacOS','codex');
 await fake(binary,'');
 const result=await findCodex('codex',{env:{PATH:'/usr/bin:/bin'},platform:'darwin',home,applicationRoots:[path.join(home,'Applications')],commonDirectories:[]});
 assert.equal(result,binary);
 const explicit=await findCodex(binary,{env:{PATH:''},platform:'darwin',home}); assert.equal(explicit,binary);
 await assert.rejects(findCodex(path.join(home,'missing')),/配置的 Codex 路径/);
});
test('executable startup failure is distinct from CLI not being installed',async()=>{
 const home=await root();const binary=path.join(home,'broken');await fake(binary,'process.exit(9)');
 const result=await new Engine(new Store(home),binary).auth();assert.equal(result.installed,true);assert.equal(result.status,'check-failed');assert.equal(result.binaryPath,binary);assert.match(result.message,/版本或参数检查失败/);
});
test('signed-out CLI is distinguished from credential-store and config failures',async()=>{
 const home=await root(); const binary=path.join(home,'signed-out');
 const common="const a=process.argv.slice(2);if(a.includes('--version')){console.log('codex-cli test');process.exit(0)}if(a.includes('--help')){console.log('--sandbox --json --image --ephemeral --output-schema');process.exit(0)}";
 await fake(binary,common+"console.error('WARNING: test warning');console.log('Not logged in');process.exit(1)");
 const signedOut=await new Engine(new Store(home),binary).auth();assert.equal(signedOut.status,'signed-out');assert.equal(signedOut.installed,true);assert.equal(signedOut.loggedIn,false);
 const broken=path.join(home,'bad-store');await fake(broken,common+"console.error('credential store unavailable');process.exit(2)");
 const error=await new Engine(new Store(home),broken).auth();assert.equal(error.status,'check-failed');assert.match(error.message,/凭据存储/);
 const good=path.join(home,'good');await fake(good,common+"console.error('Logged in using ChatGPT')");
 const ready=await new Engine(new Store(home),good).auth();assert.equal(ready.status,'ready');assert.equal(ready.loggedIn,true);assert.equal(ready.supported,true);
});
