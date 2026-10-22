import {readFileSync,mkdirSync,writeFileSync,renameSync,existsSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {verify,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {clientHome,installationRoot} from '../lib/client-state.mjs';

export function rollbackInstallation(){
  if(!existsSync(join(installationRoot,'installer.json')))throw new Error('CLI rollback requires a managed Windows installation.');
  const root=dirname(dirname(installationRoot.replace(/[\\/]$/,''))),previous=readFileSync(join(root,'previous.txt'),'utf8').trim();
  if(!/^\d+\.\d+\.\d+-[a-f0-9]{12}$/.test(previous)||!existsSync(join(root,'versions',previous,'node.exe')))throw new Error('No complete previous CLI installation is available.');
  const current=readFileSync(join(root,'current.txt'),'utf8');
  writeFileSync(join(root,'current.next'),previous+'\n');renameSync(join(root,'current.next'),join(root,'current.txt'));
  writeFileSync(join(root,'previous.txt'),current);return {rolled_back:true,version:previous,settings_preserved:true};
}

export function verifyRelease(envelope){
  const {payload,signature}=envelope||{};
  if(!payload||payload.format!==1||payload.platform!=='windows-x64'||!/^\d+\.\d+\.\d+$/.test(payload.version)||!/^TernSetup-\d+\.\d+\.\d+-windows-x64\.exe$/.test(payload.filename)||!/^[a-f0-9]{64}$/.test(payload.sha256)||!Number.isSafeInteger(payload.size)||payload.size<1||payload.size>150*1024*1024)throw new Error('Invalid CLI release manifest.');
  if(!verify(null,Buffer.from(JSON.stringify(payload)),readFileSync(new URL('../runtime/cli-release-public.pem',import.meta.url)),Buffer.from(signature||'','base64')))throw new Error('CLI release signature rejected.');
  return payload;
}
export async function upgrade({server,token,check=false}){
  const response=await fetch(server+'/api/cli/downloads/manifest',{headers:token?{Authorization:'Bearer '+token}:{},redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error('Could not retrieve the CLI release. Sign in and retry.');
  const release=verifyRelease(await response.json()),current=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
  const newer=release.version.localeCompare(current,undefined,{numeric:true})>0;
  if(check||!newer)return {current,available:release.version,update_available:newer,verified:true};
  if(process.platform!=='win32'||process.arch!=='x64')throw new Error('This release supports Windows x64.');
  const binary=await fetch(server+'/api/cli/downloads/windows-x64',{headers:token?{Authorization:'Bearer '+token}:{},redirect:'error',signal:AbortSignal.timeout(180000)});
  if(!binary.ok)throw new Error('Installer download failed. Your current version is unchanged.');
  const chunks=[];let size=0;for await(const chunk of binary.body){size+=chunk.length;if(size>release.size)throw new Error('Installer exceeds its signed size.');chunks.push(chunk);}
  const bytes=Buffer.concat(chunks);
  if(bytes.length!==release.size||createHash('sha256').update(bytes).digest('hex')!==release.sha256)throw new Error('Installer checksum rejected. Your current version is unchanged.');
  const directory=join(clientHome(),'downloads');mkdirSync(directory,{recursive:true});const output=join(directory,release.filename),temporary=output+'.part';
  writeFileSync(temporary,bytes,{mode:0o600});renameSync(temporary,output);
  const child=spawn(output,[],{detached:true,stdio:'ignore',windowsHide:false});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
  return {installer_opened:true,version:release.version,verified:true};
}
