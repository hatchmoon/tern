import { readFileSync,writeFileSync,existsSync,mkdirSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runTool } from '../lib/process.mjs';
import { ternRoot } from '../lib/runtime.mjs';
import { sha256 } from '../lib/patch.mjs';

const exec=promisify(execFile);
const serial=process.env.TERN_ANDROID_DEVICE||'emulator-5554';
if(!/^emulator-\d+$/.test(serial))throw new Error('This automated demo installs only on an Android emulator. Set TERN_ANDROID_DEVICE to its emulator serial.');
const sdk=process.env.ANDROID_HOME||process.env.ANDROID_SDK_ROOT||(process.platform==='win32'?join(process.env.LOCALAPPDATA,'Android','sdk'):null);
const adb=process.env.TERN_ADB||(sdk?join(sdk,'platform-tools',process.platform==='win32'?'adb.exe':'adb'):'adb');
const packageName='dev.tern.tern_example';
const project=join(ternRoot,'examples','hello_flutter');
const configPath=join(project,'.tern.json');
const results=join(ternRoot,'test-results','android');mkdirSync(results,{recursive:true});
const cli=join(ternRoot,'cli','tern.mjs');
const server=(process.env.TERN_SERVER||'http://127.0.0.1:4310').replace(/\/$/,'');
const token=process.env.TERN_TOKEN||readFileSync(join(ternRoot,'.tern-data','admin-token'),'utf8').trim();
async function command(...args) {
  const result=await runTool(process.execPath,[cli,...args,'--json'],{cwd:ternRoot});
  return JSON.parse(result.stdout);
}
async function api(path,payload) {
  const response=await fetch(server+path,{method:payload?'POST':'GET',headers:{Authorization:`Bearer ${token}`,...(payload?{'Content-Type':'application/json'}:{})},body:payload?JSON.stringify(payload):undefined});
  const result=await response.json();if(!response.ok)throw new Error(result.error);return result;
}
const device=(...args)=>runTool(adb,['-s',serial,...args],{capture:true});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function stage(message){console.log(`[Android verification] ${message}`);}
async function logs() {
  const {stdout}=await device('shell','pidof',packageName);
  const pid=stdout.trim();if(!/^\d+$/.test(pid))return '';
  return (await device('logcat','-d','--pid',pid,'-v','brief')).stdout;
}
async function waitForLog(pattern,label,timeout=60_000) {
  const until=Date.now()+timeout;
  while(Date.now()<until) {
    const output=await logs().catch(()=>'');
    if(pattern.test(output)){writeFileSync(join(results,`${label}.log`),output);return output;}
    await delay(1000);
  }
  const output=await logs().catch(()=>'No running demo process.');
  writeFileSync(join(results,`${label}-failure.log`),output);
  throw new Error(`Timed out waiting for ${label}. Inspect test-results/android/${label}-failure.log.`);
}
async function launch() {
  await device('shell','am','force-stop',packageName);
  await device('shell','am','start','-n',`${packageName}/.MainActivity`);
}
async function screenshot(name) {
  await delay(1000); // Let the Android launch fade finish before recording the UI.
  const {stdout}=await exec(adb,['-s',serial,'exec-out','screencap','-p'],{encoding:'buffer',windowsHide:true,maxBuffer:16*1024*1024});
  writeFileSync(join(results,`${name}.png`),stdout);
}
async function tapCheck() {
  for(let attempt=0;attempt<4;attempt++) {
    await device('shell','uiautomator','dump','/data/local/tmp/tern-verification.xml');
    const xml=(await device('shell','cat','/data/local/tmp/tern-verification.xml')).stdout;
    const node=xml.match(/<node\b[^>]*(?:text|content-desc)="Check for update"[^>]*>/)?.[0];
    const bounds=node?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if(bounds) {
      const[,x1,y1,x2,y2]=bounds.map(Number);
      await device('shell','input','tap',String(Math.floor((x1+x2)/2)),String(Math.floor((y1+y2)/2)));
      return;
    }
    // Scroll only within this dedicated sample app if its button is below the fold.
    const size=(await device('shell','wm','size')).stdout.match(/(\d+)x(\d+)/);
    if(size)await device('shell','input','swipe',String(Math.floor(Number(size[1])/2)),String(Math.floor(Number(size[2])*.8)),String(Math.floor(Number(size[1])/2)),String(Math.floor(Number(size[2])*.35)),'350');
  }
  throw new Error('Could not find the sample app’s Check for update button.');
}
async function packageTimestamp() {
  return (await device('shell','dumpsys','package',packageName)).stdout.match(/lastUpdateTime=([^\r\n]+)/)?.[1]?.trim();
}

stage('Checking emulator and local server.');
if((await device('get-state')).stdout.trim()!=='device')throw new Error('Start an Android emulator first.');
const arch=(await device('shell','getprop','ro.product.cpu.abi')).stdout.trim()==='x86_64'?'x86_64':'aarch64';
const url=new URL(server);
if(!['127.0.0.1','localhost'].includes(url.hostname))throw new Error('This local emulator verifier expects a loopback Tern server.');
const port=url.port||'80';await device('reverse',`tcp:${port}`,`tcp:${port}`);
if(!existsSync(configPath))await command('init','--project',project,'--name','Tern Android runtime','--configure-runtime','--runtime','legacy','--channel','staging','--manual-updates','--update-url',server);
const config=JSON.parse(readFileSync(configPath,'utf8'));
let release=(await api('/api/snapshot')).releases.find(r=>r.app_id===config.app_id&&r.platform==='android'&&r.version==='1.0.0+1');
if(!release) {
  stage('Building and registering the original APK.');
  release=await command('release','--project',project,'--arch',arch,'--dart-define','TERN_DEMO_VARIANT=baseline');
}
const apk=join(project,'.tern-build','release','1.0.0+1','app-release.apk');
if(!existsSync(apk))throw new Error('The registered original APK is missing. Restore it before running the device test.');
const originalHash=sha256(readFileSync(apk));
stage('Installing only the original APK and clearing this demo app’s test data.');
await device('install','-r',apk);await device('shell','pm','clear',packageName);
await launch();
await waitForLog(/TERN_RUNTIME variant=baseline current=0 next=0 available=true/,'baseline');
const before=await packageTimestamp();await screenshot('01-baseline');

stage('Compiling changed Dart code and uploading a patch.');
const patch=await command('patch','--project',project,'--dart-define','TERN_DEMO_VARIANT=patched','--notes','Native emulator verification: coral UI delivered without APK reinstall');
await api(`/api/patches/${patch.id}/deploy`,{channel:'staging',rollout:100});
stage(`Downloading patch ${patch.number} through the native updater.`);
await tapCheck();
await waitForLog(new RegExp(`TERN_RUNTIME variant=baseline current=0 next=${patch.number} available=true`),'downloaded');
await launch();
await waitForLog(new RegExp(`TERN_RUNTIME variant=patched current=${patch.number} next=${patch.number} available=true`),'patched');
await screenshot('02-patched');
if(await packageTimestamp()!==before)throw new Error('The package installation timestamp changed during patching.');
if(sha256(readFileSync(apk))!==originalHash)throw new Error('The archived original APK changed.');

stage('Revoking the patch and verifying fallback to the installed release.');
await api(`/api/patches/${patch.id}/rollback`,{});await tapCheck();
await waitForLog(new RegExp(`TERN_RUNTIME variant=patched current=${patch.number} next=0 available=true`),'rollback-downloaded');
await launch();
await waitForLog(/TERN_RUNTIME variant=baseline current=0 next=0 available=true/,'rolled-back');
await screenshot('03-rolled-back');
if(await packageTimestamp()!==before)throw new Error('The package was reinstalled during rollback.');
const report={verified:true,device:serial,arch,application_id:config.app_id,release_id:release.id,patch_id:patch.id,patch_number:patch.number,
  runtime_available:true,patched_dart_executed:true,rollback_executed:true,apk_reinstalled:false,original_apk_sha256:originalHash,package_last_update:before,verified_at:new Date().toISOString()};
writeFileSync(join(results,'report.json'),JSON.stringify(report,null,2)+'\n');
stage('Passed: original code → downloaded Dart patch → original code, without reinstalling the APK.');
console.log(JSON.stringify(report,null,2));
