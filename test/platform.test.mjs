import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { zstdDecompressSync } from 'node:zlib';
import { createApp } from '../server/app.mjs';
import { makePatch, applyPatch, sha256 } from '../lib/patch.mjs';

const exec = promisify(execFile);
const artifact = (arch, data) => ({ arch, data:Buffer.from(data).toString('base64') });

test('application deletion requires authentication, a trusted origin, and the exact name',async t=>{
 const f=await fixture(t),path='/api/apps/'+f.appId,confirmation={confirm_name:'Test mobile'};
 assert.equal((await f.request(path,confirmation,false,{},'DELETE')).status,401);
 assert.equal((await f.request(path,confirmation,true,{Origin:'https://other.example'},'DELETE')).status,403);
 for(const value of [{},{confirm_name:'test mobile'}])assert.equal((await f.request(path,value,true,{},'DELETE')).status,400);
 assert.equal((await f.request('/api/snapshot')).data.apps.length,1);
 assert.equal((await f.request('/api/apps/missing',confirmation,true,{},'DELETE')).status,404);
});

test('application deletion removes dependent data and unused blobs while retaining shared artifacts',async t=>{
 const f=await fixture(t),p=await f.patch();
 await f.request('/api/patches/'+p.id+'/deploy',{channel:'stable',rollout:100});
 const offer=(await f.check()).data;
 const shared=(await f.request('/api/apps',{name:'Other app'})).data;
 const otherRelease=(await f.request('/api/releases',{app_id:shared.id,version:'1.0.0+1',platform:'android',engine_version:'test-engine',artifacts:[artifact('aarch64','hello world')]})).data;
 const otherPatch=(await f.request('/api/patches',{release_id:otherRelease.id,engine_version:'test-engine',artifacts:[artifact('aarch64','hello tests')]})).data;
 // A distinct blob belonging only to the deleted app must be removed.
 const unique=await f.patch('unique unshared contents');
 const uniqueHash=f.app.store.get('SELECT blob_hash FROM patch_artifacts WHERE patch_id=?',unique.id).blob_hash;
 const manifest={format:'tern-android-v1',flutter_revision:'1'.repeat(40),engine_revision:'2'.repeat(40),target:'lib/main.dart',files:{'classes.dex':'3'.repeat(64)}};
 f.app.store.run('INSERT INTO release_manifests(release_id,manifest) VALUES(?,?)',f.release.id,JSON.stringify(manifest));
 const deleted=await f.request('/api/apps/'+f.appId,{confirm_name:'Test mobile'},true,{},'DELETE');
 assert.equal(deleted.status,200);assert.equal(deleted.data.deleted,true);assert.equal(deleted.data.removed_artifacts,1);
 assert.equal(existsSync(join(f.directory,'artifacts',uniqueHash)),false);
 const snapshot=(await f.request('/api/snapshot')).data;
 assert.deepEqual(snapshot.apps.map(a=>a.id),[shared.id]);assert.deepEqual(snapshot.releases.map(r=>r.id),[otherRelease.id]);
 assert.deepEqual(snapshot.patches.map(p=>p.id),[otherPatch.id]);assert.equal(snapshot.deployments.length,0);assert.equal(snapshot.devices.length,0);
 assert.ok(snapshot.activity.every(e=>e.app_id===shared.id));
 assert.equal(f.app.store.get('SELECT COUNT(*) AS n FROM release_manifests').n,0);
 assert.equal((await f.check()).data.patch_available,false);
 assert.equal((await f.request('/api/releases/'+f.release.id+'/artifacts/aarch64')).status,404);
 // The same compressed delta and release binary remain available for the other app.
 assert.equal((await fetch(offer.patch.download_url)).status,200);
 assert.equal(f.app.store.read(sha256('hello world')).toString(),'hello world');
 const last=await f.request('/api/apps/'+shared.id,{confirm_name:'Other app'},true,{},'DELETE');
 assert.equal(last.status,200);assert.equal(last.data.removed_artifacts,2);
 assert.equal((await fetch(offer.patch.download_url)).status,404);
 const empty=(await f.request('/api/apps',{name:'Empty'})).data;
 assert.equal((await f.request('/api/apps/'+empty.id,{confirm_name:'Empty'},true,{},'DELETE')).status,200);
});
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(),'tern-test-'));
  const app = createApp({dataDir:directory});
  const url = await app.listen(0);
  t.after(() => app.close());
  async function request(path, data, auth=true, headers={}, method=data ? 'POST' : 'GET') {
    const response = await fetch(url+path,{ method, headers:{...(auth?{Authorization:`Bearer ${app.store.token}`} : {}),...(data?{'Content-Type':'application/json'}:{}),...headers},body:data?JSON.stringify(data):undefined });
    const result = await response.json();
    return { status:response.status, data:result, headers:response.headers };
  }
  const created = await request('/api/apps',{name:'Test mobile'});
  const release = (await request('/api/releases',{app_id:created.data.id,version:'1.0.0+1',platform:'android',engine_version:'test-engine',artifacts:[artifact('aarch64','hello world')]})).data;
  const patch = async (target='hello tests') => (await request('/api/patches',{release_id:release.id,engine_version:'test-engine',artifacts:[artifact('aarch64',target)]})).data;
  const check = (overrides={}) => request('/api/v1/patches/check',{app_id:created.data.id,release_version:'1.0.0+1',platform:'android',arch:'aarch64',channel:'stable',client_id:'device-1',...overrides},false);
  return { app,url,request,release,patch,check,appId:created.data.id,directory };
}

test('bidiff reader accepts an upstream zstd fixture, independent of our encoder',()=>{
  // Published fixture from shorebirdtech/updater/patch/README.md (foo -> bar).
  const fixture=Buffer.from([40,181,47,253,0,128,113,0,0,223,177,0,0,0,16,0,0,0,3,98,97,114,0]);
  assert.equal(applyPatch(Buffer.from('foo'),fixture).toString(),'bar');
});
test('binary deltas reconstruct arbitrary growth, shrinkage, and byte changes',()=>{
  for(const [a,b] of [[0,0],[0,300],[500,0],[256,900],[900,128],[4096,4096]]){
    const base=randomBytes(a),target=randomBytes(b);
    assert.deepEqual(applyPatch(base,makePatch(base,target)),target);
  }
  const base=Buffer.alloc(128*1024,42),target=Buffer.from(base);target[65000]=43;
  assert.ok(makePatch(base,target).length<100);
  const raw=zstdDecompressSync(makePatch(Buffer.from('abc'),Buffer.from('abd')));
  assert.deepEqual([...raw.subarray(0,8)],[223,177,0,0,0,16,0,0]);
});
test('corrupt and mismatched patches fail safely',()=>{
  assert.throws(()=>applyPatch(Buffer.from('x'),Buffer.from('bad')));
  assert.throws(()=>applyPatch(Buffer.alloc(0),makePatch(Buffer.from('abc'),Buffer.from('abd'))),/release artifact/);
});
test('management APIs require authentication; update checks remain public',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/api/snapshot',null,false)).status,401);
  assert.equal((await f.request('/api/apps',{name:'unauthorized'},false)).status,401);
  assert.equal((await f.check()).status,200);
  assert.equal((await f.request('/api/apps',{name:'blocked'},true,{Origin:'https://untrusted.example'})).status,403);
});
test('multi-megabyte native artifacts upload without overflowing validation',async t=>{
  const f=await fixture(t),binary=Buffer.alloc(6*1024*1024,42);
  const response=await f.request('/api/releases',{app_id:f.appId,version:'4.0.0+1',platform:'android',engine_version:'large-test',artifacts:[artifact('aarch64',binary)]});
  assert.equal(response.status,201);
  const bytes=await fetch(`${f.url}/api/releases/${response.data.id}/artifacts/aarch64`,{headers:{Authorization:`Bearer ${f.app.store.token}`}});
  assert.equal(sha256(Buffer.from(await bytes.arrayBuffer())),sha256(binary));
});
test('release -> delta -> deployment -> download -> reconstruction -> rollback',async t=>{
  const f=await fixture(t),p=await f.patch();
  assert.equal(p.number,1);
  assert.equal((await f.check()).data.patch_available,false);
  assert.equal((await f.request(`/api/patches/${p.id}/deploy`,{channel:'stable',rollout:100})).status,200);
  const response=(await f.check()).data;
  assert.equal(response.patch_available,true);
  const download=await fetch(response.patch.download_url);
  const bytes=Buffer.from(await download.arrayBuffer());
  const target=applyPatch(Buffer.from('hello world'),bytes);
  assert.equal(target.toString(),'hello tests');assert.equal(sha256(target),response.patch.hash);
  assert.equal((await f.check({current_patch_number:1})).data.patch_available,false);
  await f.request(`/api/patches/${p.id}/rollback`,{});
  const rolled=(await f.check({current_patch_number:1})).data;
  assert.equal(rolled.patch_available,false);assert.deepEqual(rolled.rolled_back_patch_numbers,[1]);
  assert.equal((await f.request(`/api/patches/${p.id}/deploy`,{channel:'stable',rollout:100})).status,409);
  assert.equal((await f.patch('third version')).number,2);
});
test('version, platform, architecture, and channel isolate patches',async t=>{
  const f=await fixture(t),p=await f.patch();
  await f.request(`/api/patches/${p.id}/deploy`,{channel:'beta',rollout:100});
  assert.equal((await f.check()).data.patch_available,false);
  assert.equal((await f.check({channel:'beta'})).data.patch_available,true);
  for(const override of [{release_version:'2.0.0+1'},{platform:'ios'},{arch:'x86_64'},{app_id:'unknown'}]){
    assert.equal((await f.check({...override,channel:'beta'})).data.patch_available,false);
  }
});
test('releases are immutable and engine revision mismatches are rejected',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/api/releases',{app_id:f.appId,version:'1.0.0+1',platform:'android',engine_version:'test-engine',artifacts:[artifact('aarch64','overwrite')]})).status,409);
  assert.equal((await f.request('/api/patches',{release_id:f.release.id,engine_version:'different',artifacts:[artifact('aarch64','new')]})).status,409);
});
test('staged rollouts are deterministic, grow monotonically, and pause at zero',async t=>{
  const f=await fixture(t),p=await f.patch();
  async function cohort(percent){
    await f.request(`/api/patches/${p.id}/deploy`,{channel:'stable',rollout:percent});
    const ids=new Set();
    for(let i=0;i<120;i++)if((await f.check({client_id:`cohort-${i}`})).data.patch_available)ids.add(i);
    return ids;
  }
  const small=await cohort(10),again=await cohort(10),large=await cohort(50);
  assert.deepEqual(small,again);assert.ok(small.size>0&&small.size<30);assert.ok(large.size>35&&large.size<90);
  for(const id of small)assert.ok(large.has(id));
  assert.equal((await cohort(0)).size,0);
  assert.equal((await f.check({client_id:undefined})).data.patch_available,false);
});
test('every patch is based on the original release, not the preceding patch',async t=>{
  const f=await fixture(t);await f.patch('first patch content');const p=await f.patch('second independent patch');
  await f.request(`/api/patches/${p.id}/deploy`,{channel:'stable'});
  const c=(await f.check({current_patch_number:1})).data;
  const bytes=Buffer.from(await(await fetch(c.patch.download_url)).arrayBuffer());
  assert.equal(applyPatch(Buffer.from('hello world'),bytes).toString(),'second independent patch');
});
test('download supports resume, suffix ranges, HEAD, and rejects invalid ranges',async t=>{
  const f=await fixture(t),p=await f.patch();await f.request(`/api/patches/${p.id}/deploy`,{channel:'stable'});
  const c=(await f.check()).data,full=Buffer.from(await(await fetch(c.patch.download_url)).arrayBuffer());
  const partial=await fetch(c.patch.download_url,{headers:{Range:'bytes=5-'}});
  assert.equal(partial.status,206);assert.deepEqual(Buffer.from(await partial.arrayBuffer()),full.subarray(5));
  assert.equal(partial.headers.get('content-range'),`bytes 5-${full.length-1}/${full.length}`);
  const suffix=await fetch(c.patch.download_url,{headers:{Range:'bytes=-3'}});
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()),full.subarray(-3));
  assert.equal((await fetch(c.patch.download_url,{headers:{Range:'bytes=999999-'}})).status,416);
  const head=await fetch(c.patch.download_url,{method:'HEAD'});assert.equal(head.headers.get('content-length'),String(full.length));
});
test('original binaries are private and cannot be fetched through public artifact URLs',async t=>{
  const f=await fixture(t),hash=sha256(Buffer.from('hello world'));
  assert.equal((await fetch(`${f.url}/artifacts/${hash}`)).status,404);
  assert.equal((await fetch(`${f.url}/api/releases/${f.release.id}/artifacts/aarch64`)).status,401);
});
test('telemetry deduplicates retries and does not expose client identifiers',async t=>{
  const f=await fixture(t),p=await f.patch();
  const event={app_id:f.appId,release_version:'1.0.0+1',platform:'android',arch:'aarch64',patch_number:1,client_id:'private-install-id',type:'__patch_install__',timestamp:123};
  for(let i=0;i<3;i++)assert.equal((await f.request('/api/v1/patches/events',{event},false)).status,201);
  const snapshot=(await f.request('/api/snapshot')).data;
  assert.equal(snapshot.patches.find(a=>a.id===p.id).telemetry[0].count,1);
  assert.ok(!JSON.stringify(snapshot).includes('private-install-id'));
  assert.equal((await f.request('/api/v1/patches/events',{event:{...event,patch_number:999}},false)).status,404);
});
test('browser sessions use HttpOnly cookies and cannot be reused after logout',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/api/session',{token:'incorrect'},false)).status,401);
  const session=await f.request('/api/session',{token:f.app.store.token},false);
  const cookie=session.headers.get('set-cookie');assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);
  assert.equal((await f.request('/api/snapshot',null,false,{Cookie:cookie})).status,200);
  await fetch(f.url+'/api/session',{method:'DELETE',headers:{Cookie:cookie}});
  assert.equal((await f.request('/api/snapshot',null,false,{Cookie:cookie})).status,401);
});
test('validation rejects invalid uploads, incomplete architectures, and out-of-range rollouts',async t=>{
  const f=await fixture(t),p=await f.patch();
  assert.equal((await f.request(`/api/patches/${p.id}/deploy`,{channel:'stable',rollout:101})).status,400);
  assert.equal((await f.request(`/api/patches/${p.id}/deploy`,{channel:'unknown',rollout:100})).status,400);
  assert.equal((await f.request('/api/patches',{release_id:f.release.id,engine_version:'test-engine',artifacts:[{arch:'aarch64',data:'not base64!'}]})).status,400);
  const r=(await f.request('/api/releases',{app_id:f.appId,version:'2.0.0+1',platform:'android',engine_version:'test-engine',artifacts:[artifact('aarch64','arm64 base'),artifact('arm','arm base')]})).data;
  assert.equal((await f.request('/api/patches',{release_id:r.id,engine_version:'test-engine',artifacts:[artifact('aarch64','only one')]})).status,400);
});
test('prebuilt bidiff patches are reconstructed and checked before publication',async t=>{
  const f=await fixture(t),target=Buffer.from('prebuilt target');
  const a={arch:'aarch64',format:'bidiff-v1-zstd',data:makePatch(Buffer.from('hello world'),target).toString('base64'),target_hash:sha256(target)};
  assert.equal((await f.request('/api/patches',{release_id:f.release.id,engine_version:'test-engine',artifacts:[{...a,target_hash:'0'.repeat(64)}]})).status,400);
  assert.equal((await f.request('/api/patches',{release_id:f.release.id,engine_version:'test-engine',artifacts:[a]})).status,201);
});
test('runtime-managed releases require matching native file fingerprints for every patch',async t=>{
  const f=await fixture(t),engine='2'.repeat(40);
  const manifest={format:'tern-android-v1',flutter_revision:'1'.repeat(40),engine_revision:engine,target:'lib/main.dart',files:{'classes.dex':'a'.repeat(64)}};
  const release=(await f.request('/api/releases',{app_id:f.appId,version:'3.0.0+1',platform:'android',engine_version:engine,artifacts:[artifact('aarch64','native release')],build_manifest:manifest})).data;
  const payload={release_id:release.id,engine_version:engine,artifacts:[artifact('aarch64','Dart patch')]};
  assert.equal((await f.request('/api/patches',payload)).status,409);
  assert.equal((await f.request('/api/patches',{...payload,build_manifest:{...manifest,files:{'classes.dex':'b'.repeat(64)}}})).status,409);
  assert.equal((await f.request('/api/patches',{...payload,build_manifest:manifest})).status,201);
  const snapshot=(await f.request('/api/snapshot')).data;
  assert.deepEqual(snapshot.releases.find(r=>r.id===release.id).build_manifest,manifest);
});
test('CLI performs a real upload, deploy, reconstruction, and rollback workflow',async t=>{
  const f=await fixture(t),cwd=mkdtempSync(join(tmpdir(),'tern-cli-'));
  const cli=resolve('cli/tern.mjs');
  const env={...process.env,TERN_TOKEN:f.app.store.token,TERN_SERVER:f.url};
  const command=async(...args)=>JSON.parse((await exec(process.execPath,[cli,...args,'--json'],{cwd,env})).stdout);
  const app=await command('init','--name','CLI application');assert.ok(app.id);
  assert.ok(existsSync(join(cwd,'.tern.json')));assert.ok(!readFileSync(join(cwd,'.tern.json'),'utf8').includes(f.app.store.token));
  writeFileSync(join(cwd,'base.bin'),'base binary');writeFileSync(join(cwd,'target.bin'),'updated binary');
  await command('release','--version','1.0.0+1','--platform','android','--engine','cli-engine','--artifact','aarch64=base.bin');
  const p=await command('patch','--version','1.0.0+1','--platform','android','--engine','cli-engine','--artifact','aarch64=target.bin');
  await command('deploy','--patch',p.id,'--channel','staging');
  const simulated=await command('simulate','--version','1.0.0+1','--platform','android','--channel','staging','--base','base.bin','--output','result.bin');
  assert.equal(simulated.verified,true);assert.equal(readFileSync(join(cwd,'result.bin'),'utf8'),'updated binary');
  await command('rollback','--patch',p.id);
  const result=await command('check','--version','1.0.0+1','--platform','android','--channel','staging');
  assert.deepEqual(result.rolled_back_patch_numbers,[1]);
});

test('CLI initialization and builds detect the current Flutter project folder',async t=>{
 const f=await fixture(t),cwd=mkdtempSync(join(tmpdir(),'tern-current-project-')),cli=resolve('cli/tern.mjs');
 const env={...process.env,TERN_TOKEN:f.app.store.token,TERN_SERVER:f.url};
 const linked=join(cwd,'linked-tern');symlinkSync(resolve('.'),linked,process.platform==='win32'?'junction':'dir');
 assert.match((await exec(process.execPath,[join(linked,'cli','tern.mjs'),'--help'],{cwd,env})).stdout,/tern <command>/);
 writeFileSync(join(cwd,'pubspec.yaml'),'name: app\nversion: "1.0.0" # missing build number\nflutter:\n  uses-material-design: true\n');
 await exec(process.execPath,[cli,'init','--name','Current folder app','--configure-runtime','--json'],{cwd,env});
 assert.ok(existsSync(join(cwd,'tern.yaml')));assert.equal(existsSync(join(cwd,'shorebird.yaml')),false);
 assert.match(readFileSync(join(cwd,'pubspec.yaml'),'utf8'),/- tern.yaml/);
 const configured=JSON.parse(readFileSync(join(cwd,'.tern.json'),'utf8'));
 await f.request('/api/releases',{app_id:configured.app_id,version:'1.0.0+1',platform:'android',engine_version:'fixture',artifacts:[artifact('aarch64','base')]});
 for(const command of ['release','patch']) {
  await assert.rejects(exec(process.execPath,[cli,command],{cwd,env}),error=>error.stderr.includes(join(cwd,'pubspec.yaml')+' needs a version with a build number'));
 }
});
test('SQLite and artifact records survive restart with the same admin key',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'tern-persist-'));
  const first=createApp({dataDir:directory});await first.listen(0);
  const key=first.store.token;first.store.run('INSERT INTO apps VALUES(?,?,?)','persistent-id','Persistent app',new Date().toISOString());
  first.store.put(Buffer.from('persisted bytes'));await first.close();
  const second=createApp({dataDir:directory});await second.listen(0);
  try {assert.equal(second.store.token,key);assert.equal(second.store.snapshot().apps[0].name,'Persistent app');assert.equal(second.store.read(sha256('persisted bytes')).toString(),'persisted bytes');}
  finally{await second.close();}
});
