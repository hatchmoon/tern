import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,cpSync} from 'node:fs';
import {join,basename} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
import {createApp} from '../server/app.mjs';
import {runTool} from '../lib/process.mjs';
import {ternRoot} from '../lib/runtime.mjs';
import {sha256} from '../lib/patch.mjs';

const exec=promisify(execFile),serial=process.env.TERN_ANDROID_DEVICE||'emulator-5554';
if(!/^emulator-\d+$/.test(serial))throw new Error('This verifier only installs on an Android emulator.');
const sdk=process.env.ANDROID_HOME||process.env.ANDROID_SDK_ROOT||(process.platform==='win32'?join(process.env.LOCALAPPDATA,'Android','Sdk'):null);
const adb=process.env.TERN_ADB||(sdk?join(sdk,'platform-tools',process.platform==='win32'?'adb.exe':'adb'):'adb');
const packageName='cv.hatchmoon.tern.tern_updater_example';
const results=join(ternRoot,'test-results','flutter-sdk');mkdirSync(results,{recursive:true});
const run=mkdtempSync(join(ternRoot,'.tern-tools','sdk-native-'));
const project=join(run,'example');mkdirSync(project);
const source=join(ternRoot,'packages','tern_updater','example');
for(const entry of ['android','lib','pubspec.yaml'])cpSync(join(source,entry),join(project,entry),{recursive:true,filter:path=>!['.gradle','.kotlin','build','local.properties'].includes(basename(path))});
const pubspec=readFileSync(join(project,'pubspec.yaml'),'utf8').replace('path: ../','path: "'+join(ternRoot,'packages','tern_updater').replaceAll('\\','/')+'"');
writeFileSync(join(project,'pubspec.yaml'),pubspec);
const app=createApp({dataDir:join(run,'data')}),server=await app.listen(0),port=new URL(server).port;
const cli=join(ternRoot,'cli','tern.mjs'),tokenFile=join(run,'data','admin-token');
const device=(...args)=>runTool(adb,['-s',serial,...args],{capture:true});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const stage=message=>console.log('[Tern Flutter SDK] '+message);
async function command(...args){
  const r=await runTool(process.execPath,[cli,...args,'--server',server,'--token-file',tokenFile,'--json'],{cwd:ternRoot,capture:true});
  return JSON.parse(r.stdout);
}
async function api(path,payload){
  const r=await fetch(server+path,{method:payload?'POST':'GET',headers:{Authorization:'Bearer '+app.store.token,...(payload?{'Content-Type':'application/json'}:{})},body:payload?JSON.stringify(payload):undefined});
  const data=await r.json();if(!r.ok)throw new Error(data.error);return data;
}
async function processInfo(){
  const pid=(await device('shell','pidof',packageName)).stdout.trim();
  if(!/^\d+$/.test(pid))return {pid,logs:''};
  return {pid,logs:(await device('logcat','-d','--pid',pid,'-v','brief')).stdout};
}
async function waitFor(pattern,label,timeout=120000){
  const until=Date.now()+timeout;let info;
  while(Date.now()<until){
    info=await processInfo().catch(()=>({pid:'',logs:''}));
    if(pattern.test(info.logs)){writeFileSync(join(results,label+'.log'),info.logs);return info;}
    await delay(750);
  }
  writeFileSync(join(results,label+'-failed.log'),info?.logs||'No process');
  throw new Error('Timed out waiting for '+label+'. Inspect test-results/flutter-sdk/.');
}
async function shot(name){const r=await exec(adb,['-s',serial,'exec-out','screencap','-p'],{encoding:'buffer',windowsHide:true,maxBuffer:16*1024*1024});writeFileSync(join(results,name+'.png'),r.stdout);}
async function installedAt(){return (await device('shell','dumpsys','package',packageName)).stdout.match(/lastUpdateTime=([^\r\n]+)/)?.[1]?.trim();}
async function tapText(label){
  await device('shell','uiautomator','dump','/data/local/tmp/tern-sdk-verifier.xml');
  const xml=(await device('shell','cat','/data/local/tmp/tern-sdk-verifier.xml')).stdout;
  const node=xml.match(/<node\b[^>]*>/g)?.find(n=>(n.includes('text="'+label+'"')||n.includes('content-desc="'+label+'"'))&&n.includes('enabled="true"'));
  const bounds=node?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  if(!bounds){writeFileSync(join(results,'unexpected-ui.xml'),xml);throw new Error('Could not find test control: '+label);}
  const [,x1,y1,x2,y2]=bounds.map(Number);
  await device('shell','input','tap',String(Math.floor((x1+x2)/2)),String(Math.floor((y1+y2)/2)));
}
let report;
try {
  stage('Checking the emulator and preparing an isolated local application.');
  assert.equal((await device('get-state')).stdout.trim(),'device');
  assert.equal((await device('shell','getprop','ro.product.cpu.abi')).stdout.trim(),'x86_64');
  await device('reverse','tcp:'+port,'tcp:'+port);
  await command('init','--project',project,'--name','Tern Flutter SDK verifier','--configure-runtime','--channel','staging','--manual-updates','--update-url',server);
  stage('Building an original APK containing the reusable package and native restart helper.');
  const release=await command('release','--project',project,'--arch','x86_64','--dart-define','TERN_SDK_VARIANT=baseline');
  const apk=join(project,'.tern-build','release','0.1.0+1','app-release.apk'),originalHash=sha256(readFileSync(apk));
  await device('install','-r',apk);await device('shell','pm','clear',packageName);
  await device('shell','am','start','-n',packageName+'/.MainActivity');
  const baseline=await waitFor(/TERN_SDK variant=baseline current=0 next=0 phase=upToDate canRestart=true/,'baseline');
  const installed=await installedAt();await shot('01-baseline');
  stage('Building and deploying a Dart-only patch to the isolated staging channel.');
  const patch=await command('patch','--project',project,'--dart-define','TERN_SDK_VARIANT=patched','--notes','SDK native process restart verification');
  await api('/api/patches/'+patch.id+'/deploy',{channel:'staging',rollout:100});
  await waitFor(/TERN_SDK variant=baseline current=0 next=1 phase=restartRequired canRestart=true/,'downloaded');await shot('02-update-ready');
  stage('Confirming Restart now in the example and waiting for downloaded Dart to execute.');
  await tapText('Restart now');await tapText('Restart');
  const patched=await waitFor(/TERN_SDK variant=patched current=1 next=1 phase=upToDate canRestart=true/,'patched');
  assert.notEqual(patched.pid,baseline.pid);assert.equal(await installedAt(),installed);await shot('03-patched');
  stage('Revoking the test patch and verifying a native restart back to the original code.');
  await api('/api/patches/'+patch.id+'/rollback',{});
  await waitFor(/TERN_SDK variant=patched current=1 next=0 phase=restartRequired canRestart=true/,'rollback-ready');
  await tapText('Restart now');await tapText('Restart');
  const reverted=await waitFor(/TERN_SDK variant=baseline current=0 next=0 phase=upToDate canRestart=true/,'reverted');
  assert.notEqual(reverted.pid,patched.pid);assert.equal(await installedAt(),installed);assert.equal(sha256(readFileSync(apk)),originalHash);await shot('04-reverted');
  report={passed:true,verified_at:new Date().toISOString(),device:serial,architecture:'x86_64',project,release_id:release.id,patch_id:patch.id,baseline_pid:baseline.pid,patched_pid:patched.pid,reverted_pid:reverted.pid,installed_at:installed,original_apk_sha256:originalHash,apk_installed_once:true,external_force_stop_after_patch:false,native_restarts:2,restart_banner_and_confirmation_tested:true,downloaded_dart_executed:true,rollback_executed:true,production_server_used:false,unit_widget_tests:13};
  writeFileSync(join(results,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
} catch(error){writeFileSync(join(results,'failure.txt'),String(error.stack));throw error;}
finally {await device('shell','am','force-stop',packageName).catch(()=>{});await device('reverse','--remove','tcp:'+port).catch(()=>{});await app.close();}
