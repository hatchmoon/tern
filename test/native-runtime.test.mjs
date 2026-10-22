import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createApp} from '../server/app.mjs';
import {sha256} from '../lib/patch.mjs';
import {patchSignatureMessage,verifyNativePatch,integrateNativeProject,nativeToolchain} from '../lib/native-runtime.mjs';

const pair=generateKeyPairSync('rsa',{modulusLength:2048});
const publicKey=pair.publicKey.export({type:'spki',format:'der'}).toString('base64');
const engine='2'.repeat(40),target=Buffer.from('updated Dart code'),base=Buffer.from('original Dart code');
const manifest={format:'tern-android-v1',flutter_revision:'1'.repeat(40),engine_revision:engine,target:'lib/main.dart',runtime:{id:'tern-native-v1',public_key:publicKey},files:{'classes.dex':sha256('native classes')}};
const context=appId=>({app_id:appId,version:'1.0.0+1',engine_revision:engine,arch:'x86_64',hash:sha256(target)});
const signature=appId=>sign('sha256',Buffer.from(patchSignatureMessage(context(appId))),pair.privateKey).toString('base64');
async function fixture(t) {
  const app=createApp({dataDir:mkdtempSync(join(tmpdir(),'tern-native-api-'))}),origin=await app.listen(0);
  t.after(()=>app.close());
  const request=async(path,payload,authenticated=true)=>{
    const response=await fetch(origin+path,{method:payload?'POST':'GET',headers:{'Content-Type':'application/json',...(authenticated?{Authorization:'Bearer '+app.store.token}:{})},body:payload?JSON.stringify(payload):undefined});
    return {status:response.status,data:await response.json()};
  };
  const appId=(await request('/api/apps',{name:'Independent runtime test'})).data.id;
  const release=await request('/api/releases',{app_id:appId,version:'1.0.0+1',platform:'android',engine_version:engine,build_manifest:manifest,artifacts:[{arch:'x86_64',data:base.toString('base64')}]});
  assert.equal(release.status,201);
  const patch=(overrides={})=>request('/api/patches',{release_id:release.data.id,engine_version:engine,build_manifest:manifest,artifacts:[{arch:'x86_64',data:target.toString('base64'),hash_signature:signature(appId),...overrides}]});
  const check=(extra={})=>request('/api/v1/patches/check',{app_id:appId,release_version:'1.0.0+1',platform:'android',arch:'x86_64',client_id:'test-install',runtime:'tern-native-v1',...extra},false);
  return {app,origin,request,appId,release:release.data,patch,check};
}

test('independent toolchain points exclusively to official Flutter',()=>{
  assert.equal(nativeToolchain.provider,'flutter-official');assert.equal(nativeToolchain.repository,'https://github.com/flutter/flutter.git');
  assert.equal(nativeToolchain.artifactBaseUrl,'https://storage.googleapis.com');
  assert.ok(!JSON.stringify(nativeToolchain).includes('shorebird'));
});

test('native signatures bind the application, release, engine, architecture and content',()=>{
  const original=context('app-one'),signed=signature('app-one');
  assert.equal(verifyNativePatch(publicKey,original,signed),true);
  for(const key of Object.keys(original))assert.equal(verifyNativePatch(publicKey,{...original,[key]:'changed'},signed),false,key);
  assert.equal(verifyNativePatch(publicKey,original,''),false);
  assert.equal(verifyNativePatch('invalid',original,signed),false);
});

test('native release rejects unsigned, tampered and cross-application patches',async t=>{
  const f=await fixture(t);
  for(const artifact of [{hash_signature:null},{hash_signature:signature('another-app')},{data:Buffer.from('tampered').toString('base64')}])assert.equal((await f.patch(artifact)).status,400);
  assert.equal((await f.request('/api/snapshot')).data.patches.length,0);
  assert.equal((await f.patch()).status,201);
});

test('native offers return verified full libraries while preserving private baselines and rollback',async t=>{
  const f=await fixture(t),patch=(await f.patch()).data;
  await f.request('/api/patches/'+patch.id+'/deploy',{channel:'stable',rollout:100});
  const offer=(await f.check()).data;
  assert.equal(offer.patch.format,'tern-full-v1');assert.equal(offer.patch.engine_revision,engine);
  assert.equal(verifyNativePatch(publicKey,context(f.appId),offer.patch.hash_signature),true);
  assert.deepEqual(Buffer.from(await (await fetch(offer.patch.download_url)).arrayBuffer()),target);
  assert.equal((await fetch(f.origin+'/artifacts/'+sha256(base))).status,404);
  assert.equal((await f.check({runtime:undefined})).data.patch_available,false,'legacy updater never receives an incompatible patch');
  const range=await fetch(offer.patch.download_url,{headers:{Range:'bytes=0-6'}});
  assert.equal(range.status,206);assert.equal(await range.text(),'updated');
  await f.request('/api/patches/'+patch.id+'/rollback',{});
  const rolledBack=(await f.check({current_patch_number:patch.number})).data;
  assert.equal(rolledBack.patch_available,false);assert.deepEqual(rolledBack.rolled_back_patch_numbers,[patch.number]);
});

test('native integration is idempotent and refuses to overwrite a custom Application',()=>{
  const project=mkdtempSync(join(tmpdir(),'tern-native-integrate-')),directory=join(project,'android/app/src/main');mkdirSync(directory,{recursive:true});
  const path=join(directory,'AndroidManifest.xml');
  writeFileSync(path,'<manifest><application android:name="${applicationName}"></application></manifest>');
  writeFileSync(join(project,'pubspec.yaml'),'name: test\ndependencies:\n  flutter:\n    sdk: flutter\nflutter:\n  assets:\n    - tern.yaml\n');
  integrateNativeProject(project,{dryRun:true});assert.match(readFileSync(path,'utf8'),/\$\{applicationName\}/);
  integrateNativeProject(project);const before=readFileSync(path,'utf8'),pubspec=readFileSync(join(project,'pubspec.yaml'),'utf8');
  integrateNativeProject(project);assert.equal(readFileSync(path,'utf8'),before);assert.equal(readFileSync(join(project,'pubspec.yaml'),'utf8'),pubspec);
  assert.match(before,/cv.hatchmoon.tern.updater.TernApplication/);assert.match(pubspec,/- tern-runtime.json/);assert.match(pubspec,/- tern.yaml/);
  writeFileSync(path,'<manifest><application android:name="my.CustomApplication"></application></manifest>');
  assert.throws(()=>integrateNativeProject(project),/Custom Android Application/);assert.match(readFileSync(path,'utf8'),/my.CustomApplication/);
});

test('CLI migration preserves application identity and protects an existing baseline',async()=>{
  const project=mkdtempSync(join(tmpdir(),'tern-native-migrate-')),directory=join(project,'android/app/src/main');mkdirSync(directory,{recursive:true});
  writeFileSync(join(directory,'AndroidManifest.xml'),'<manifest><application android:name="${applicationName}"></application></manifest>');
  const spec=join(project,'pubspec.yaml');writeFileSync(spec,'name: app\nversion: 1.0.0+1\ndependencies:\n  flutter:\n    sdk: flutter\nflutter:\n  assets:\n    - tern.yaml\n');
  const yaml=join(project,'tern.yaml'),original='app_id: existing-app\nbase_url: https://updates.example.com\nchannel: stable\n';writeFileSync(yaml,original);
  const baseline=join(project,'.tern-build/release/1.0.0+1');mkdirSync(baseline,{recursive:true});writeFileSync(join(baseline,'app-release.apk'),'existing baseline');
  const cli=resolve('cli/tern.mjs'),exec=promisify(execFile);
  await assert.rejects(exec(process.execPath,[cli,'integrate'],{cwd:project}),error=>error.stderr.includes('Increase the app version/build'));
  assert.equal(readFileSync(yaml,'utf8'),original);
  writeFileSync(spec,readFileSync(spec,'utf8').replace('1.0.0+1','1.0.1+2'));
  const result=JSON.parse((await exec(process.execPath,[cli,'integrate'],{cwd:project})).stdout);
  assert.equal(result.new_baseline_required,true);assert.equal(result.runtime,'tern-native-v1');
  assert.equal(readFileSync(yaml,'utf8'),'runtime: tern-native-v1\n'+original);
  assert.equal(readFileSync(join(baseline,'app-release.apk'),'utf8'),'existing baseline');
});
