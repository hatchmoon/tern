import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from '../server/app.mjs';
import { Store } from '../server/store.mjs';
import { hashPassword,verifyPassword,normalizeEmail,issueAccountSetup,getAdministrator } from '../server/accounts.mjs';

const password='A long private passphrase 🌙';
const replacement='Another long private passphrase';
const exec=promisify(execFile);
async function fixture(t,options={}) {
  const directory=mkdtempSync(join(tmpdir(),'tern-account-'));
  const app=createApp({dataDir:directory,...options}),url=await app.listen(0);
  t.after(()=>app.close());
  async function request(path,data,headers={},method=data?'POST':'GET') {
    const r=await fetch(url+path,{method,headers:{...(data?{'Content-Type':'application/json'}:{}),...headers},body:data?JSON.stringify(data):undefined});
    return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0],headers:r.headers};
  }
  const setup=issueAccountSetup(app.store,'Owner@Example.com');
  const finish=()=>request('/api/auth/setup',{token:setup.token,password});
  return {app,url,directory,request,setup,finish};
}

test('password hashes use independent salts and preserve Unicode and whitespace',async()=>{
  assert.equal(normalizeEmail(' Owner@Example.COM '),'owner@example.com');
  assert.throws(()=>normalizeEmail('bad address'));
  const value='  A private unicode passphrase 🌙  ';
  const a=await hashPassword(value),b=await hashPassword(value);
  assert.notEqual(a,b);assert.ok(!a.includes(value));
  assert.equal(await verifyPassword(value,a),true);
  assert.equal(await verifyPassword(value.trim(),a),false);
  assert.equal(await verifyPassword('wrong',a),false);
  assert.equal(await verifyPassword(value,a.replace('131072','999999999')),false);
  await assert.rejects(hashPassword('too short'),/15 and 128/);
});

test('account setup is private, expires, is single-use, and disables browser token login',async t=>{
  const f=await fixture(t,{publicUrl:'https://tern.example.com',secureCookies:true});
  assert.deepEqual((await f.request('/api/auth/status')).data,{password_sign_in:false});
  assert.equal((await f.request('/api/auth/setup',{email:'attacker@example.com',password})).status,401);
  assert.equal((await f.request('/api/auth/setup/status',{token:'0'.repeat(64)})).status,401);
  assert.equal((await f.request('/api/auth/setup/status',{token:f.setup.token},{Origin:'https://evil.example'})).status,403);
  assert.equal((await f.request('/api/auth/setup/status',{token:f.setup.token})).data.email,'owner@example.com');
  assert.ok(!JSON.stringify(f.app.store.get('SELECT * FROM administrator_setup')).includes(f.setup.token));
  assert.equal((await f.request('/api/auth/setup',{token:f.setup.token,password:'short'})).status,400);
  const session=await f.finish();assert.equal(session.status,200);
  assert.match(session.headers.get('set-cookie'),/HttpOnly; SameSite=Strict; Path=\/; Max-Age=43200; Secure/);
  assert.deepEqual((await f.request('/api/auth/status')).data,{password_sign_in:true});
  assert.equal((await f.finish()).status,401);
  assert.equal((await f.request('/api/session',{token:f.app.store.token})).status,401);
  const cli={Authorization:'Bearer '+f.app.store.token};
  assert.equal((await f.request('/api/snapshot',null,cli)).status,200);
  const snapshot=await f.request('/api/snapshot',null,{Cookie:session.cookie});
  assert.equal(snapshot.status,200);assert.equal(snapshot.data.administrator.email,'owner@example.com');
  assert.ok(!JSON.stringify(snapshot.data).includes('scrypt$'));
  assert.throws(()=>issueAccountSetup(f.app.store,'new@example.com'),/already exists/);
  const recovery=issueAccountSetup(f.app.store,'owner@example.com',{reset:true});
  f.app.store.run('UPDATE administrator_setup SET expires_at=?',Date.now()-1);
  assert.equal((await f.request('/api/auth/setup',{token:recovery.token,password:replacement})).status,401);
});

test('email sign-in uses generic failures, supports normalized email, and logout revokes cookies',async t=>{
  const f=await fixture(t);await f.finish();
  const wrongEmail=await f.request('/api/session',{email:'someone@example.com',password});
  const wrongPassword=await f.request('/api/session',{email:'owner@example.com',password:'not the password'});
  assert.equal(wrongEmail.status,401);assert.deepEqual(wrongEmail.data,wrongPassword.data);
  const session=await f.request('/api/session',{email:' OWNER@EXAMPLE.COM ',password});assert.equal(session.status,200);
  assert.equal((await f.request('/api/session',null,{Cookie:session.cookie},'DELETE')).status,200);
  assert.equal((await f.request('/api/snapshot',null,{Cookie:session.cookie})).status,401);
});

test('administrator credentials persist across restarts while browser sessions expire',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'tern-account-restart-'));
  const first=createApp({dataDir:directory}),firstUrl=await first.listen(0);
  let originalHash,token,oldCookie;
  try {
    const setup=issueAccountSetup(first.store,'owner@example.com');
    const session=await fetch(firstUrl+'/api/auth/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:setup.token,password})});
    assert.equal(session.status,200);oldCookie=session.headers.get('set-cookie').split(';')[0];
    originalHash=getAdministrator(first.store).password_hash;token=first.store.token;
  } finally { await first.close(); }
  const restarted=createApp({dataDir:directory}),url=await restarted.listen(0);
  t.after(()=>restarted.close());
  assert.equal(getAdministrator(restarted.store).password_hash,originalHash);
  assert.equal(restarted.store.token,token);
  assert.equal((await fetch(url+'/api/snapshot',{headers:{Cookie:oldCookie}})).status,401);
  const login=await fetch(url+'/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'owner@example.com',password})});
  assert.equal(login.status,200);
  assert.equal((await fetch(url+'/api/snapshot',{headers:{Cookie:login.headers.get('set-cookie').split(';')[0]}})).status,200);
});

test('password changes and recovery invalidate prior sessions while retaining CLI keys',async t=>{
  const f=await fixture(t),first=await f.finish();
  const second=await f.request('/api/session',{email:'owner@example.com',password});
  const headers={Cookie:first.cookie};
  assert.equal((await f.request('/api/account/password',{current_password:'incorrect',new_password:replacement},headers)).status,401);
  const change=await f.request('/api/account/password',{current_password:password,new_password:replacement},headers);
  assert.equal(change.status,200);
  for(const old of [first,second])assert.equal((await f.request('/api/snapshot',null,{Cookie:old.cookie})).status,401);
  assert.equal((await f.request('/api/snapshot',null,{Cookie:change.cookie})).status,200);
  assert.equal((await f.request('/api/session',{email:'owner@example.com',password})).status,401);
  assert.equal((await f.request('/api/session',{email:'owner@example.com',password:replacement})).status,200);
  const recovery=issueAccountSetup(f.app.store,'owner@example.com',{reset:true});
  const reset=await f.request('/api/auth/setup',{token:recovery.token,password});assert.equal(reset.status,200);
  assert.equal((await f.request('/api/snapshot',null,{Cookie:change.cookie})).status,401);
  assert.equal((await f.request('/api/snapshot',null,{Authorization:'Bearer '+f.app.store.token})).status,200);
});

test('parallel uses of a setup ticket create exactly one account',async t=>{
  const f=await fixture(t);
  const results=await Promise.all([f.finish(),f.finish()]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  assert.equal(f.app.store.get('SELECT COUNT(*) AS n FROM administrator').n,1);
  assert.equal(f.app.store.get('SELECT COUNT(*) AS n FROM administrator_setup').n,0);
});

test('sign-in throttling trusts forwarded addresses only when explicitly configured',async t=>{
  const f=await fixture(t);
  for(let i=0;i<5;i++)assert.equal((await f.request('/api/session',{token:'wrong'},{'X-Forwarded-For':'192.0.2.'+(i+1)})).status,401);
  assert.equal((await f.request('/api/session',{token:f.app.store.token},{'X-Forwarded-For':'198.51.100.2'})).status,429);
  const proxied=await fixture(t,{trustProxy:true});
  for(let i=0;i<5;i++)await proxied.request('/api/session',{token:'wrong'},{'X-Forwarded-For':'192.0.2.1'});
  assert.equal((await proxied.request('/api/session',{token:proxied.app.store.token},{'X-Forwarded-For':'192.0.2.1'})).status,429);
  assert.equal((await proxied.request('/api/session',{token:proxied.app.store.token},{'X-Forwarded-For':'192.0.2.2'})).status,200);
});

test('administrator CLI writes a private setup URL without exposing it in console output',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'tern-account-cli-'));
  const result=await exec(process.execPath,[resolve('server/admin.mjs'),'setup','--email','owner@example.com','--origin','https://tern.example.com','--data-dir',directory]);
  const url=readFileSync(join(directory,'admin-setup-url'),'utf8').trim();
  assert.match(url,/^https:\/\/tern.example.com\/#setup=[a-f0-9]{64}$/);
  assert.ok(!result.stdout.includes(url));
  const store=new Store(directory);
  try { assert.equal(getAdministrator(store),undefined);assert.equal(store.get('SELECT email FROM administrator_setup').email,'owner@example.com'); }
  finally { store.close(); }
});
