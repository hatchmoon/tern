import {existsSync,readFileSync,writeFileSync,mkdirSync,renameSync,chmodSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';

export const installationRoot=fileURLToPath(new URL('../',import.meta.url));
export const managedInstallation=()=>existsSync(join(installationRoot,'installer.json'))||existsSync(join(installationRoot,'distribution.json'));
export const clientHome=()=>resolve(process.env.TERN_HOME||(process.platform==='win32'?join(process.env.LOCALAPPDATA||join(homedir(),'AppData','Local'),'Tern'):join(process.env.XDG_CONFIG_HOME||join(homedir(),'.config'),'tern')));
export function canonicalServer(value){
  const u=new URL(value);
  if(u.username||u.password||u.search||u.hash||u.pathname!=='/'||!['https:','http:'].includes(u.protocol))throw new Error('Server must be an HTTPS origin without credentials, paths, or query parameters.');
  if(u.protocol==='http:'&&!['127.0.0.1','[::1]','localhost'].includes(u.hostname))throw new Error('HTTP is allowed only for a local development server. Use HTTPS for your VPS.');
  return u.origin;
}
export function atomicJson(path,value){
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  const temp=path+'.'+randomUUID()+'.tmp';
  writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});renameSync(temp,path);
  if(process.platform!=='win32')chmodSync(path,0o600);
}
export function readSettings(){
  const path=join(clientHome(),'settings.json');
  if(!existsSync(path))return {format:1,profiles:{}};
  const data=JSON.parse(readFileSync(path,'utf8'));
  if(data.format!==1||!data.profiles||typeof data.profiles!=='object')throw new Error('Invalid Tern user settings. Restore settings.json from your backup.');
  return data;
}
function protect(value,decrypt=false){
  if(process.platform!=='win32')return value;
  const operation=decrypt?'Unprotect':'Protect';
  const script="Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); $b="+(decrypt?"[Convert]::FromBase64String($v)":"[Text.Encoding]::UTF8.GetBytes($v)")+"; $o=[Security.Cryptography.ProtectedData]::"+operation+"($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write("+(decrypt?"[Text.Encoding]::UTF8.GetString($o)":"[Convert]::ToBase64String($o)")+")";
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{input:value,encoding:'utf8',windowsHide:true});
  if(result.status!==0)throw new Error('Windows could not '+(decrypt?'unlock':'protect')+' the Tern credential. Sign in again as this Windows user.');
  return result.stdout;
}
export function saveLogin(server,credential){
  server=canonicalServer(server);const settings=readSettings();
  settings.server=server;settings.profiles[server]={token:protect(credential.token),protection:process.platform==='win32'?'windows-dpapi':'file-permissions',expires_at:credential.expires_at,id:credential.id};
  atomicJson(join(clientHome(),'settings.json'),settings);
}
export function savedToken(server){
  const profile=readSettings().profiles[canonicalServer(server)];
  if(!profile)return '';
  if(profile.expires_at<=Date.now())throw new Error('Tern sign-in expired. Run tern login again.');
  if(profile.protection==='windows-dpapi'&&process.platform!=='win32')throw new Error('This credential belongs to another Windows machine. Run tern login here.');
  return profile.protection==='windows-dpapi'?protect(profile.token,true):profile.token;
}
export function forgetLogin(server){const settings=readSettings();delete settings.profiles[canonicalServer(server)];atomicJson(join(clientHome(),'settings.json'),settings);}
export function toolDirectory(){return resolve(process.env.TERN_CACHE_DIR||(managedInstallation()?join(clientHome(),'cache'):join(installationRoot,'.tern-tools')));}
export function signingKeyPath(appId){
  if(!/^[a-zA-Z0-9-]+$/.test(appId))throw new Error('Invalid application ID.');
  const legacy=join(installationRoot,'.tern-data','signing',appId+'.private.pem');
  return existsSync(legacy)?legacy:join(clientHome(),'keys',appId+'.private.pem');
}
