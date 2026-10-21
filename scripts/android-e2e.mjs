import { readFileSync,writeFileSync,existsSync,mkdirSync,cpSync,rmSync } from 'node:fs';
import { join,basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runTool } from '../lib/process.mjs';
import { ternRoot } from '../lib/runtime.mjs';
import { sha256 } from '../lib/patch.mjs';
import { readZip } from '../lib/zip.mjs';
import { inspectAndroidPackage } from '../lib/android.mjs';

const exec=promisify(execFile);
const serial=process.env.TERN_ANDROID_DEVICE||'emulator-5554';
const physical=!/^emulator-\d+$/.test(serial);
// The verifier installs, clears, and launches only its own sample package, but
// a phone is someone's personal device, so it must be opted into explicitly.
if(physical&&process.env.TERN_ANDROID_PHYSICAL!=='1')throw new Error(`${serial} is not an emulator. Set TERN_ANDROID_PHYSICAL=1 to verify on this physical device; only dev.tern.tern_example is installed and cleared.`);
const format=process.env.TERN_ANDROID_FORMAT||'apk';
if(!['apk','aab'].includes(format))throw new Error('TERN_ANDROID_FORMAT must be apk or aab.');
const bundletool=process.env.TERN_BUNDLETOOL;
if(format==='aab'&&!bundletool)throw new Error('Set TERN_BUNDLETOOL to a bundletool .jar to install app bundles the way Google Play splits them.');
const sdk=process.env.ANDROID_HOME||process.env.ANDROID_SDK_ROOT||(process.platform==='win32'?join(process.env.LOCALAPPDATA,'Android','sdk'):null);
const adb=process.env.TERN_ADB||(sdk?join(sdk,'platform-tools',process.platform==='win32'?'adb.exe':'adb'):'adb');
const packageName='dev.tern.tern_example';
const sample=join(ternRoot,'examples','hello_flutter');
const cli=join(ternRoot,'cli','tern.mjs');
const server=(process.env.TERN_SERVER||'http://127.0.0.1:4310').replace(/\/$/,'');
const url=new URL(server),loopback=['127.0.0.1','localhost'].includes(url.hostname);
if(!loopback&&url.protocol!=='https:')throw new Error('Remote servers must use HTTPS. Use a loopback URL for local HTTP testing.');
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
async function waitForLog(pattern,label,timeout=physical||!loopback?180_000:60_000) {
  const until=Date.now()+timeout;
  while(Date.now()<until) {
    const output=await logs().catch(()=>'');
    if(pattern.test(output)){writeFileSync(join(results,`${label}.log`),output);return output;}
    await delay(1000);
  }
  const output=await logs().catch(()=>'No running demo process.');
  writeFileSync(join(results,`${label}-failure.log`),output);
  throw new Error(`Timed out waiting for ${label}. Inspect ${join(results,`${label}-failure.log`)}.`);
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
async function installedDartHash() {
  const paths=(await device('shell','pm','path',packageName)).stdout.split(/\r?\n/).map(line=>line.replace(/^package:/,'').trim()).filter(Boolean);
  for(const path of paths) {
    const {stdout}=await exec(adb,['-s',serial,'exec-out','cat',path],{encoding:'buffer',windowsHide:true,maxBuffer:512*1024*1024});
    const entry=readZip(stdout).get(`lib/${abi}/libapp.so`);
    if(entry)return sha256(entry.read());
  }
  // Devices may extract native libraries instead of loading them from the APK.
  const dir=(await device('shell','dumpsys','package',packageName)).stdout.match(/legacyNativeLibraryDir=(\S+)/)?.[1];
  if(dir){const {stdout}=await exec(adb,['-s',serial,'exec-out','cat',`${dir}/${{aarch64:'arm64',arm:'arm',x86_64:'x86_64'}[arch]}/libapp.so`],{encoding:'buffer',windowsHide:true,maxBuffer:512*1024*1024});if(stdout.length)return sha256(stdout);}
  throw new Error(`Could not find the installed libapp.so for ${abi}.`);
}
async function packageTimestamp() {
  return (await device('shell','dumpsys','package',packageName)).stdout.match(/lastUpdateTime=([^\r\n]+)/)?.[1]?.trim();
}

stage(`Checking ${physical?'physical device':'emulator'} ${serial} and the Tern server.`);
if((await device('get-state')).stdout.trim()!=='device')throw new Error(physical?`Connect ${serial} with USB debugging authorized.`:'Start an Android emulator first.');
const abi=(await device('shell','getprop','ro.product.cpu.abi')).stdout.trim();
const arch={'arm64-v8a':'aarch64','armeabi-v7a':'arm','x86_64':'x86_64'}[abi];
if(!arch)throw new Error(`Unsupported device ABI ${abi}. Tern builds arm64-v8a, armeabi-v7a, and x86_64.`);
const model=(await device('shell','getprop','ro.product.model')).stdout.trim();
// Loopback servers reach the device through adb reverse (USB or emulator). A
// remote server is used directly, so the device needs its own network route.
if(loopback){const port=url.port||'80';await device('reverse',`tcp:${port}`,`tcp:${port}`);}
else{const health=await fetch(server+'/health');if(!health.ok)throw new Error(`${server}/health returned ${health.status}.`);}
// The update URL and architectures are compiled into the original release, so
// each server/architecture/format pair gets its own copy of the sample.
// The original emulator verification keeps using the sample folder in place.
const legacy=loopback&&!physical&&arch==='x86_64'&&format==='apk';
const workspace=legacy?null:join(ternRoot,'.tern-tools','android-e2e',`${format}-${arch}-${sha256(Buffer.from(server)).slice(0,12)}`);
const project=workspace?join(workspace,'hello_flutter'):sample;
if(workspace&&!existsSync(project)) {
  mkdirSync(workspace,{recursive:true});
  cpSync(sample,project,{recursive:true,filter:path=>!['.dart_tool','.gradle','.kotlin','build','.tern-build','.tern.json','tern.yaml','shorebird.yaml','local.properties'].includes(basename(path))});
}
const results=join(ternRoot,'test-results','android',...(legacy?[]:[`${serial.replace(/[^\w.-]/g,'_')}-${format}`]));mkdirSync(results,{recursive:true});
const configPath=join(project,'.tern.json');
if(!existsSync(configPath))await command('init','--project',project,'--name',`Tern Android runtime (${legacy?'emulator':`${format} ${arch}`})`,'--configure-runtime','--channel','staging','--manual-updates','--update-url',server,'--server',server);
const config=JSON.parse(readFileSync(configPath,'utf8'));
if(config.server.replace(/\/$/,'')!==server)throw new Error(`${configPath} targets ${config.server}, not ${server}. Remove that sample copy to rebuild it for this server.`);
const findRelease=async()=>(await api('/api/snapshot')).releases.find(r=>r.app_id===config.app_id&&r.platform==='android'&&r.version==='1.0.0+1');
let release=await findRelease();
if(!release) {
  stage(`Building and registering the original ${format.toUpperCase()}.`);
  await command('release','--project',project,'--arch',arch,'--format',format,'--dart-define','TERN_DEMO_VARIANT=baseline','--server',server);
  release=await findRelease();
}
if(!release.artifacts.some(a=>a.arch===arch))throw new Error(`The registered release has no ${arch} build. Remove ${workspace||configPath} to rebuild it for this device.`);
const original=join(project,'.tern-build','release','1.0.0+1',`app-release.${format}`);
if(!existsSync(original))throw new Error(`The registered original ${format.toUpperCase()} is missing. Restore it before running the device test.`);
const originalHash=sha256(readFileSync(original));
stage(`Installing only the original ${format.toUpperCase()} and clearing this demo app’s test data.`);
if(format==='apk')await device('install','-r',original);
else {
  // bundletool produces the same split APKs Google Play would serve this device.
  const apks=join(results,'original.apks');rmSync(apks,{force:true});
  await runTool('java',['-jar',bundletool,'build-apks',`--bundle=${original}`,`--output=${apks}`,'--connected-device',`--device-id=${serial}`,`--adb=${adb}`],{capture:true});
  await runTool('java',['-jar',bundletool,'install-apks',`--apks=${apks}`,`--device-id=${serial}`,`--adb=${adb}`],{capture:true});
}
await device('shell','pm','clear',packageName);
// Patches are diffs against the release's libapp.so, so the installed copy
// must be byte-identical to the one Tern registered.
const releasedDart=inspectAndroidPackage(readFileSync(original),{},'lib/main.dart',format).artifacts.find(a=>a.arch===arch);
const installedDart=await installedDartHash();
if(installedDart!==sha256(Buffer.from(releasedDart.data,'base64')))throw new Error(`Installed libapp.so (${installedDart}) differs from the registered release.`);
await launch();
await waitForLog(/TERN_RUNTIME variant=baseline current=0 next=0 available=true/,'baseline');
const before=await packageTimestamp();await screenshot('01-baseline');

stage('Compiling changed Dart code and uploading a patch.');
const patch=await command('patch','--project',project,'--dart-define','TERN_DEMO_VARIANT=patched','--server',server,'--notes',`Native ${physical?'device':'emulator'} verification: coral UI delivered without reinstall`);
await api(`/api/patches/${patch.id}/deploy`,{channel:'staging',rollout:100});
stage(`Downloading patch ${patch.number} through the native updater.`);
await tapCheck();
await waitForLog(new RegExp(`TERN_RUNTIME variant=baseline current=0 next=${patch.number} available=true`),'downloaded');
await launch();
await waitForLog(new RegExp(`TERN_RUNTIME variant=patched current=${patch.number} next=${patch.number} available=true`),'patched');
await screenshot('02-patched');
if(await packageTimestamp()!==before)throw new Error('The package installation timestamp changed during patching.');
if(sha256(readFileSync(original))!==originalHash)throw new Error(`The archived original ${format.toUpperCase()} changed.`);

stage('Revoking the patch and verifying fallback to the installed release.');
await api(`/api/patches/${patch.id}/rollback`,{});await tapCheck();
await waitForLog(new RegExp(`TERN_RUNTIME variant=patched current=${patch.number} next=0 available=true`),'rollback-downloaded');
await launch();
await waitForLog(/TERN_RUNTIME variant=baseline current=0 next=0 available=true/,'rolled-back');
await screenshot('03-rolled-back');
if(await packageTimestamp()!==before)throw new Error('The package was reinstalled during rollback.');
const report={verified:true,device:serial,physical,model,abi,arch,server,format,application_id:config.app_id,release_id:release.id,patch_id:patch.id,patch_number:patch.number,
  runtime_available:true,patched_dart_executed:true,rollback_executed:true,apk_reinstalled:false,[`original_${format}_sha256`]:originalHash,installed_libapp_sha256:installedDart,package_last_update:before,verified_at:new Date().toISOString()};
writeFileSync(join(results,'report.json'),JSON.stringify(report,null,2)+'\n');
stage(`Passed on ${model} (${abi}) via ${server}: original code → downloaded Dart patch → original code, without reinstalling.`);
console.log(JSON.stringify(report,null,2));
