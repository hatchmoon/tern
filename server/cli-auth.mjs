import {randomBytes,randomUUID} from 'node:crypto';
import {sha256} from '../lib/patch.mjs';
import {getAdministrator} from './accounts.mjs';

export function initializeCliAuth(store){store.db.exec(`
  CREATE TABLE IF NOT EXISTS cli_authorizations(id TEXT PRIMARY KEY,challenge TEXT NOT NULL,code TEXT NOT NULL,machine TEXT NOT NULL,expires_at INTEGER NOT NULL,status TEXT NOT NULL,account_version TEXT);
  CREATE TABLE IF NOT EXISTS cli_credentials(id TEXT PRIMARY KEY,token_hash TEXT UNIQUE NOT NULL,machine TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,last_used INTEGER,revoked INTEGER NOT NULL DEFAULT 0,account_version TEXT NOT NULL);
`);}
const version=store=>sha256(getAdministrator(store)?.password_hash||'');
export function cliCredential(store,token){
  if(typeof token!=='string'||!/^tern_cli_[a-f0-9]{64}$/.test(token))return null;
  const row=store.get('SELECT * FROM cli_credentials WHERE token_hash=?',sha256(token));
  if(!row||row.revoked||row.expires_at<=Date.now()||row.account_version!==version(store))return null;
  store.run('UPDATE cli_credentials SET last_used=? WHERE id=?',Date.now(),row.id);return row;
}
export function startAuthorization(store,{challenge,machine}){
  if(typeof challenge!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(challenge))throw new Error('A SHA-256 proof challenge is required.');
  if(typeof machine!=='string'||!machine.trim()||machine.length>100||/[\x00-\x1f]/.test(machine))throw new Error('Invalid machine name.');
  store.run('DELETE FROM cli_authorizations WHERE expires_at<?',Date.now());
  if(store.get('SELECT COUNT(*) AS count FROM cli_authorizations').count>=1000)throw new Error('Too many pending sign-ins. Try again later.');
  const row={id:randomBytes(32).toString('hex'),code:randomBytes(4).toString('hex').toUpperCase(),machine:machine.trim(),expires_at:Date.now()+600_000};
  store.run("INSERT INTO cli_authorizations VALUES(?,?,?,?,?,'pending',NULL)",row.id,challenge,row.code,row.machine,row.expires_at);
  return row;
}
export function authorization(store,id){
  if(typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))return null;
  const row=store.get('SELECT * FROM cli_authorizations WHERE id=?',id);
  return row&&row.expires_at>Date.now()?row:null;
}
export function decideAuthorization(store,id,approve,code){
  const row=authorization(store,id);
  if(!row||row.status!=='pending')throw new Error('This sign-in request expired or was already handled.');
  if(code!==row.code)throw new Error('Verification code does not match.');
  store.run('UPDATE cli_authorizations SET status=?,account_version=? WHERE id=?',approve?'approved':'denied',version(store),id);
}
export function redeemAuthorization(store,id,verifier){
  const row=authorization(store,id);
  if(!row)throw new Error('This sign-in request expired. Run tern login again.');
  if(typeof verifier!=='string'||!/^[A-Za-z0-9_-]{43,128}$/.test(verifier)||Buffer.from(sha256(verifier),'hex').toString('base64url')!==row.challenge)throw new Error('Sign-in proof rejected.');
  if(row.status==='denied')throw new Error('Sign-in was declined.');
  if(row.status==='pending')return {pending:true};
  if(row.status!=='approved'||row.account_version!==version(store))throw new Error('Sign-in approval is no longer valid.');
  const token='tern_cli_'+randomBytes(32).toString('hex'),idKey=randomUUID(),expires=Date.now()+90*86400_000;
  store.transaction(()=>{
    store.run('INSERT INTO cli_credentials VALUES(?,?,?,?,?,?,0,?)',idKey,sha256(token),row.machine,Date.now(),expires,null,version(store));
    store.run('DELETE FROM cli_authorizations WHERE id=?',id);
  });
  return {id:idKey,token,expires_at:expires};
}
