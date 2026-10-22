import {spawn} from 'node:child_process';
import {hostname} from 'node:os';
import {createHash,randomBytes,createPrivateKey,createPublicKey} from 'node:crypto';
import {readFileSync,existsSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {createInterface,emitKeypressEvents} from 'node:readline';
import {stdin,stdout} from 'node:process';
import {setTimeout as delay} from 'node:timers/promises';
import {saveLogin,forgetLogin,clientHome,atomicJson,signingKeyPath} from '../lib/client-state.mjs';
import {readRuntimeYaml} from '../lib/android.mjs';
import {readPubspecVersion} from '../lib/project.mjs';

export function openBrowser(url){
  let file,args;
  if(process.platform==='win32'){
    file='powershell.exe';const script="Start-Process '"+url.replaceAll("'","''")+"'";
    args=['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')];
  }else{file=process.platform==='darwin'?'open':'xdg-open';args=[url];}
  const child=spawn(file,args,{stdio:'ignore',windowsHide:true,detached:true});child.on('error',()=>{});child.unref();
}
export async function browserLogin(server,{noBrowser=false,machine=hostname(),timeout=600_000}={}){
  const verifier=randomBytes(32).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url');
  async function post(path,data){
    const response=await fetch(server+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),redirect:'error',signal:AbortSignal.timeout(15_000)});
    const result=await response.json();if(!response.ok)throw new Error(result.error||'Sign-in failed.');return result;
  }
  const ticket=await post('/api/cli/authorize',{challenge,machine});
  const url=server+'/#cli='+ticket.id;
  console.log('Approve this machine in your browser. Match verification code: '+ticket.code+'\n'+url);
  if(!noBrowser)openBrowser(url);
  const expires=Math.min(ticket.expires_at,Date.now()+timeout);
  while(Date.now()<expires){
    const result=await post('/api/cli/token',{id:ticket.id,verifier});
    if(!result.pending){saveLogin(server,result);console.log('Signed in to '+server+'. Credential expires '+new Date(result.expires_at).toLocaleDateString()+'.');return;}
    await delay(1500);
  }
  throw new Error('Sign-in timed out. Run tern login again.');
}
export async function logout(server,request){
  try{await request('/api/cli/credentials/current',undefined,true,'DELETE');}
  catch(error){if(error.status!==401)throw new Error('Could not revoke this machine credential: '+error.message+'. Retry while the server is reachable.');}
  forgetLogin(server);return {signed_out:true,server};
}
export async function connectProject({project,server,appId,request}){
  const pubspec=join(project,'pubspec.yaml');if(!existsSync(pubspec))throw new Error('Run tern connect inside your Flutter project folder.');
  const yamlPath=join(project,'tern.yaml'),legacyPath=join(project,'shorebird.yaml');
  const yaml=existsSync(yamlPath)?readRuntimeYaml(readFileSync(yamlPath,'utf8')):existsSync(legacyPath)?readRuntimeYaml(readFileSync(legacyPath,'utf8')):{};
  const configPath=join(project,'.tern.json'),existing=existsSync(configPath)?JSON.parse(readFileSync(configPath,'utf8')):{};
  const snapshot=await request('/api/snapshot');
  let selected=appId||yaml.app_id||existing.app_id;
  if(!selected){
    if(snapshot.apps.length===1)selected=snapshot.apps[0].id;
    else{
      if(!stdin.isTTY)throw new Error('Choose an application with tern connect --app APP_ID. Run tern apps to list IDs.');
      console.log(snapshot.apps.map((a,i)=>(i+1)+'. '+a.name+' ('+a.id+')').join('\n'));
      const rl=createInterface({input:stdin,output:stdout});
      try{const choice=await new Promise(resolve=>rl.question('Application number: ',resolve));selected=snapshot.apps[Number(choice)-1]?.id;}finally{rl.close();}
    }
  }
  const app=snapshot.apps.find(a=>a.id===selected);if(!app)throw new Error('Application not found on this server.');
  if((yaml.app_id&&yaml.app_id!==app.id)||(existing.app_id&&existing.app_id!==app.id))throw new Error('This project already belongs to another application. Its app ID was preserved.');
  const version=readPubspecVersion(readFileSync(pubspec,'utf8'),pubspec);
  const baseline=snapshot.releases.find(r=>r.app_id===app.id&&r.platform==='android'&&r.version===version);
  if(!yaml.app_id&&!baseline)throw new Error('Restore the original tern.yaml for this project; no matching release exists to recover its runtime safely.');
  const native=yaml.app_id?yaml.runtime==='tern-native-v1':baseline?.build_manifest?.runtime?.id==='tern-native-v1';
  if(!existsSync(yamlPath)&&!existsSync(legacyPath))writeFileSync(yamlPath,(native?'runtime: tern-native-v1\n':'')+'app_id: '+app.id+'\nbase_url: '+server+'\nchannel: stable\nauto_update: true\n',{flag:'wx'});
  atomicJson(configPath,{...existing,server,app_id:app.id});
  return {connected:true,application:app.name,app_id:app.id,server,runtime:native?'tern-native-v1':'legacy',next:'Run tern setup, then tern doctor. Existing releases keep their original version and signing configuration.'};
}
export async function passphrase(options){
  if(options['passphrase-file'])return readFileSync(resolve(options['passphrase-file']),'utf8').replace(/\r?\n$/,'');
  if(!stdin.isTTY)throw new Error('Use an interactive terminal or --passphrase-file for encrypted signing-key transfer.');
  stdout.write('Key backup passphrase (15+ characters): ');emitKeypressEvents(stdin);stdin.setRawMode(true);stdin.resume();
  return new Promise((resolve,reject)=>{
    let value='';function finish(error){stdin.removeListener('keypress',key);stdin.setRawMode(false);stdin.pause();stdout.write('\n');error?reject(error):resolve(value);}
    function key(text,k){if(k?.ctrl&&k.name==='c')return finish(new Error('Cancelled.'));if(k?.name==='return')return finish();if(k?.name==='backspace'){value=[...value].slice(0,-1).join('');return;}if(text&&!k?.ctrl&&!/[\x00-\x1f]/.test(text))value+=text;}
    stdin.on('keypress',key);
  });
}
export async function transferKey(action,options,appId,project,expectedKey){
  if(!['export','import'].includes(action)||!appId)throw new Error('Use tern keys export|import --app APP_ID --output FILE or --input FILE.');
  const path=signingKeyPath(appId),phrase=await passphrase(options);
  if([...phrase].length<15)throw new Error('Use a backup passphrase of at least 15 characters.');
  if(action==='export'){
    if(!options.output)throw new Error('Supply --output for your encrypted key backup.');
    if(!existsSync(path))throw new Error('The original signing key is missing on this machine.');
    const encrypted=createPrivateKey(readFileSync(path)).export({format:'pem',type:'pkcs8',cipher:'aes-256-cbc',passphrase:phrase});
    writeFileSync(resolve(options.output),encrypted,{flag:'wx',mode:0o600});return {exported:true,file:resolve(options.output),encrypted:true};
  }
  if(!options.input)throw new Error('Supply --input for your encrypted key backup.');
  const input=readFileSync(resolve(options.input),'utf8');if(!input.startsWith('-----BEGIN ENCRYPTED PRIVATE KEY-----'))throw new Error('Import requires an encrypted PKCS#8 backup.');
  const key=createPrivateKey({key:input,passphrase:phrase}),publicKey=createPublicKey(key).export({type:'spki',format:'der'}).toString('base64');
  if(expectedKey&&publicKey!==expectedKey)throw new Error('Backup key does not match this release on the server.');
  if(key.asymmetricKeyType!=='rsa'||key.asymmetricKeyDetails.modulusLength<3072)throw new Error('Expected a Tern RSA-3072 signing key.');
  const runtimeFile=join(project,'tern-runtime.json');
  if(existsSync(runtimeFile)){const runtime=JSON.parse(readFileSync(runtimeFile,'utf8'));if(runtime.app_id===appId&&runtime.public_key&&runtime.public_key!==publicKey)throw new Error('Backup key does not match this application’s embedded public key.');}
  if(existsSync(path)){
    if(createPublicKey(readFileSync(path)).export({type:'spki',format:'der'}).toString('base64')!==publicKey)throw new Error('A different signing key already exists. It was preserved.');
    return {imported:true,already_present:true};
  }
  mkdirSync(dirname(path),{recursive:true,mode:0o700});writeFileSync(path,key.export({format:'pem',type:'pkcs8'}),{flag:'wx',mode:0o600});return {imported:true,app_id:appId,home:clientHome()};
}
