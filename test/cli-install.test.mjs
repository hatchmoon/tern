import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomBytes,generateKeyPairSync,createPublicKey} from 'node:crypto';
import {createApp} from '../server/app.mjs';
import {issueAccountSetup} from '../server/accounts.mjs';
import {canonicalServer,saveLogin,savedToken,readSettings,signingKeyPath} from '../lib/client-state.mjs';
import {connectProject,transferKey} from '../cli/onboarding.mjs';
import {withSetupLock} from '../lib/setup-lock.mjs';
import {verifyRelease} from '../cli/upgrade.mjs';

async function fixture(t){
  const directory=mkdtempSync(join(tmpdir(),'tern-cli-auth-')),app=createApp({dataDir:directory}),server=await app.listen(0);
  t.after(()=>app.close());
  const request=async(path,payload,headers={},method)=>{
    const response=await fetch(server+path,{method:method||(payload?'POST':'GET'),headers:{...(payload?{'Content-Type':'application/json'}:{}),...headers},body:payload?JSON.stringify(payload):undefined});
    return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  };
  const setup=issueAccountSetup(app.store,'owner@example.com');
  const session=await request('/api/auth/setup',{token:setup.token,password:'A very long test passphrase'});
  const headers={Cookie:session.cookie};
  const verifier=randomBytes(32).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url');
  const start=await request('/api/cli/authorize',{challenge,machine:'New build laptop'});assert.equal(start.status,201);
  return {directory,app,server,request,headers,verifier,start:start.data};
}

test('browser approval is required; verifier is bound; credentials are hashed and revocable',async t=>{
  const f=await fixture(t),{id,code}=f.start;
  assert.equal((await f.request('/api/cli/token',{id,verifier:f.verifier})).data.pending,true);
  assert.equal((await f.request('/api/cli/approval?id='+id)).status,401);
  assert.equal((await f.request('/api/cli/approval',{id,code,approve:true},{Authorization:'Bearer '+f.app.store.token})).status,403);
  assert.equal((await f.request('/api/cli/approval',{id,code:'BAD-CODE',approve:true},f.headers)).status,409);
  assert.equal((await f.request('/api/cli/approval',{id,code,approve:true},f.headers)).status,200);
  assert.equal((await f.request('/api/cli/token',{id,verifier:'X'.repeat(43)})).status,401);
  const login=await f.request('/api/cli/token',{id,verifier:f.verifier});assert.equal(login.status,200);assert.match(login.data.token,/^tern_cli_/);
  assert.equal((await f.request('/api/cli/token',{id,verifier:f.verifier})).status,401);
  const authorization={Authorization:'Bearer '+login.data.token};
  assert.equal((await f.request('/api/snapshot',null,authorization)).status,200);
  const db=f.app.store.get('SELECT * FROM cli_credentials WHERE id=?',login.data.id);assert.ok(!JSON.stringify(db).includes(login.data.token));
  const listed=await f.request('/api/cli/credentials',null,f.headers);assert.ok(!JSON.stringify(listed.data).includes(db.token_hash));
  assert.equal((await f.request('/api/cli/credentials/'+login.data.id,null,f.headers,'DELETE')).status,200);
  assert.equal((await f.request('/api/snapshot',null,authorization)).status,401);
});
test('expired, denied and cross-origin machine approvals fail',async t=>{
  const f=await fixture(t),{id,code}=f.start;
  assert.equal((await f.request('/api/cli/approval',{id,code,approve:true},{...f.headers,Origin:'https://attacker.invalid'})).status,403);
  assert.equal((await f.request('/api/cli/approval',{id,code,approve:false},f.headers)).status,200);
  assert.equal((await f.request('/api/cli/token',{id,verifier:f.verifier})).status,401);
  f.app.store.run('UPDATE cli_authorizations SET expires_at=? WHERE id=?',Date.now()-1,id);
  assert.equal((await f.request('/api/cli/approval?id='+id,null,f.headers)).status,404);
});
test('password changes invalidate machine credentials',async t=>{
  const f=await fixture(t),{id,code}=f.start;
  await f.request('/api/cli/approval',{id,code,approve:true},f.headers);
  const login=await f.request('/api/cli/token',{id,verifier:f.verifier});
  assert.equal((await f.request('/api/account/password',{current_password:'A very long test passphrase',new_password:'A different long test passphrase'},f.headers)).status,200);
  assert.equal((await f.request('/api/snapshot',null,{Authorization:'Bearer '+login.data.token})).status,401);
});
test('machine credential and pending authorization survive server restart',async t=>{
  const f=await fixture(t),{id,code}=f.start;
  await f.request('/api/cli/approval',{id,code,approve:true},f.headers);
  const login=await f.request('/api/cli/token',{id,verifier:f.verifier});
  await f.app.close();f.app.close=async()=>{};
  const restarted=createApp({dataDir:f.directory}),url=await restarted.listen(0);t.after(()=>restarted.close());
  assert.equal((await fetch(url+'/api/snapshot',{headers:{Authorization:'Bearer '+login.data.token}})).status,200);
});
test('server profiles stay bound to origins and Windows encrypts stored credentials',()=>{
  process.env.TERN_HOME=mkdtempSync(join(tmpdir(),'tern-profile-'));
  assert.equal(canonicalServer('https://tern.example.com/'),'https://tern.example.com');
  for(const url of ['http://example.com','https://user:secret@example.com','https://example.com/path','https://example.com/?token=secret'])assert.throws(()=>canonicalServer(url));
  saveLogin('https://tern.example.com',{id:'test',token:'private-test-credential',expires_at:Date.now()+60000});
  assert.equal(savedToken('https://tern.example.com'),'private-test-credential');assert.equal(savedToken('https://another.example.com'),'');
  if(process.platform==='win32')assert.ok(!readFileSync(join(process.env.TERN_HOME,'settings.json'),'utf8').includes('private-test-credential'));
  assert.equal(readSettings().server,'https://tern.example.com');delete process.env.TERN_HOME;
});
test('connect restores an ignored project config and preserves an existing legacy app identity',async()=>{
  const project=mkdtempSync(join(tmpdir(),'tern-connect-'));
  writeFileSync(join(project,'pubspec.yaml'),'name: example\nversion: 2.0.3+1\n');
  writeFileSync(join(project,'tern.yaml'),'app_id: original-id\nbase_url: https://tern.example.com\n');
  const original=readFileSync(join(project,'tern.yaml'),'utf8');
  const snapshot={apps:[{id:'original-id',name:'Existing Winstar'}],releases:[]};
  const result=await connectProject({project,server:'https://tern.example.com',request:async()=>snapshot});
  assert.equal(result.runtime,'legacy');assert.equal(result.app_id,'original-id');assert.equal(readFileSync(join(project,'tern.yaml'),'utf8'),original);
  assert.equal(JSON.parse(readFileSync(join(project,'.tern.json'))).app_id,'original-id');assert.equal(snapshot.apps.length,1);
  await assert.rejects(()=>connectProject({project,server:'https://tern.example.com',appId:'different',request:async()=>({apps:[{id:'different',name:'Other app'}],releases:[]})}),/another application/);
});
test('encrypted key transfer round trips and rejects the wrong passphrase without creating a key',async()=>{
  const homeA=mkdtempSync(join(tmpdir(),'tern-key-source-')),homeB=mkdtempSync(join(tmpdir(),'tern-key-target-')),appId='test-'+randomBytes(8).toString('hex'),project=mkdtempSync(join(tmpdir(),'tern-key-project-'));
  const pair=generateKeyPairSync('rsa',{modulusLength:3072}),pem=pair.privateKey.export({format:'pem',type:'pkcs8'});
  process.env.TERN_HOME=homeA;const source=signingKeyPath(appId);mkdirSync(join(homeA,'keys'));writeFileSync(source,pem);
  const passwordFile=join(project,'passphrase'),backup=join(project,'backup.pem');writeFileSync(passwordFile,'A private backup passphrase');
  await transferKey('export',{output:backup,'passphrase-file':passwordFile},appId,project);assert.ok(readFileSync(backup,'utf8').startsWith('-----BEGIN ENCRYPTED PRIVATE KEY-----'));
  process.env.TERN_HOME=homeB;writeFileSync(passwordFile,'An incorrect backup passphrase');
  await assert.rejects(()=>transferKey('import',{input:backup,'passphrase-file':passwordFile},appId,project));assert.equal(existsSync(signingKeyPath(appId)),false);
  writeFileSync(passwordFile,'A private backup passphrase');await transferKey('import',{input:backup,'passphrase-file':passwordFile},appId,project);
  assert.equal(createPublicKey(readFileSync(signingKeyPath(appId))).export({type:'spki',format:'pem'}).toString(),pair.publicKey.export({type:'spki',format:'pem'}).toString());delete process.env.TERN_HOME;
});
test('concurrent SDK setup cannot mutate the same cache',async()=>{
  const directory=join(mkdtempSync(join(tmpdir(),'tern-setup-')),'sdk');let entered=false;
  await withSetupLock(directory,async()=>{await assert.rejects(()=>withSetupLock(directory,async()=>{entered=true;}),/Another Tern setup/);});assert.equal(entered,false);
  await withSetupLock(directory,async()=>{entered=true;});assert.equal(entered,true);
});
test('unsigned or altered installer manifests are rejected before downloads',()=>{
  const payload={format:1,platform:'windows-x64',version:'0.2.0',filename:'TernSetup-0.2.0-windows-x64.exe',sha256:'a'.repeat(64),size:1000};
  assert.throws(()=>verifyRelease({payload,signature:Buffer.alloc(64).toString('base64')}),/signature rejected/);
  assert.throws(()=>verifyRelease({payload:{...payload,filename:'../evil.exe'},signature:''}),/Invalid/);
});
