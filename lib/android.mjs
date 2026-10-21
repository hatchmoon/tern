import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { runFlutter, runtimeInfo } from './runtime.mjs';
import { readZip } from './zip.mjs';
import { sha256 } from './patch.mjs';
import { readPubspecVersion, withRuntimeAssetBridge } from './project.mjs';

const abiNames={aarch64:'arm64-v8a',arm:'armeabi-v7a',x86_64:'x86_64'};
const targetNames={aarch64:'android-arm64',arm:'android-arm',x86_64:'android-x64'};
export function readRuntimeYaml(source) {
  return Object.fromEntries(source.split(/\r?\n/).map(line=>line.match(/^([a-z_]+):\s*(.*?)\s*$/)).filter(Boolean).map(([,key,value])=>[key,value]));
}
export function validateBuildManifest(value) {
  if(!value||value.format!=='tern-android-v1'||!value.files||typeof value.files!=='object'||Array.isArray(value.files))throw new Error('Invalid Android build manifest.');
  if(!/^[a-f0-9]{40}$/.test(value.flutter_revision)||!/^[a-f0-9]{40}$/.test(value.engine_revision))throw new Error('Invalid runtime revision in build manifest.');
  const files=Object.entries(value.files);
  if(!files.length||files.length>15000||files.some(([name,hash])=>name.length>512||typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash)))throw new Error('Invalid unpatchable file fingerprints.');
  if(typeof value.target!=='string'||value.target.length>512)throw new Error('Invalid Dart entry point.');
  return value;
}
export function assertPatchCompatible(release,patch) {
  validateBuildManifest(release);validateBuildManifest(patch);
  if(release.flutter_revision!==patch.flutter_revision||release.engine_revision!==patch.engine_revision||release.target!==patch.target)throw new Error('Patch must use the original runtime and Dart entry point.');
  const changed=[...new Set([...Object.keys(release.files),...Object.keys(patch.files)])].filter(name=>release.files[name]!==patch.files[name]);
  if(changed.length)throw new Error(`A new store release is required. Native code or bundled assets changed: ${changed.slice(0,8).join(', ')}${changed.length>8?'…':''}`);
}
export function inspectApk(bytes, runtime, target='lib/main.dart') {
  const entries=readZip(bytes);
  const config=entries.get('assets/flutter_assets/shorebird.yaml');
  if(!config)throw new Error('The APK is missing the generated updater asset. Build it with tern release or tern patch.');
  const yaml=readRuntimeYaml(config.read().toString('utf8'));
  if(!yaml.app_id||!/^https?:\/\//.test(yaml.base_url||''))throw new Error('APK updater configuration needs app_id and base_url.');
  const artifacts=[];
  for(const [arch,abi]of Object.entries(abiNames)) {
    const dart=entries.get(`lib/${abi}/libapp.so`);
    if(!dart)continue;
    const engine=entries.get(`lib/${abi}/libflutter.so`);
    if(!engine||!engine.read().includes(Buffer.from('shorebird')))throw new Error(`APK engine for ${abi} does not contain the update runtime.`);
    artifacts.push({arch,data:dart.read().toString('base64')});
  }
  if(!artifacts.length)throw new Error('No compiled Dart libraries found in the APK.');
  const files=Object.create(null);
  for(const[name,entry]of entries) {
    if(name.endsWith('/')||/^META-INF\//.test(name)||/^lib\/[^/]+\/libapp\.so$/.test(name))continue;
    files[name]=sha256(entry.read());
  }
  return {artifacts,app_id:yaml.app_id,update_url:yaml.base_url,build_manifest:{format:'tern-android-v1',flutter_revision:runtime.flutter_revision,engine_revision:runtime.engine_revision,target,files}};
}

export async function buildAndroid({project,archs=['aarch64','arm','x86_64'],defines=[],target='lib/main.dart',mode='release',resume=false}={}) {
  project=resolve(project||'.');
  const pubspec=join(project,'pubspec.yaml');
  if(!existsSync(pubspec))throw new Error(`No Flutter project at ${project}.`);
  if(!existsSync(join(project,'tern.yaml'))&&!existsSync(join(project,'shorebird.yaml')))throw new Error('Initialize tern.yaml first: tern init --name "My app" --configure-runtime');
  const version=readPubspecVersion(readFileSync(pubspec,'utf8'),pubspec);
  if(!archs.length||archs.some(a=>!targetNames[a]))throw new Error('Android architectures: aarch64, arm, x86_64.');
  const runtime=await runtimeInfo();
  const outputDir=join(project,'.tern-build',mode,version);
  const archived=join(outputDir,'app-release.apk');
  if(mode==='release'&&existsSync(archived)) {
    if(!resume)throw new Error('The original APK already exists. Use --resume to retry its upload, or increase the release version for a new build.');
    const saved=JSON.parse(readFileSync(join(outputDir,'build-manifest.json'),'utf8'));
    if(saved.engine_revision!==runtime.engine_revision||saved.flutter_revision!==runtime.flutter_revision)throw new Error('The archived release uses a different runtime. Restore its toolchain pin before retrying the upload.');
    const inspected=inspectApk(readFileSync(archived),runtime,target);
    return {...inspected,version,engine_version:runtime.engine_revision,apk:archived};
  }
  const bytes=await withRuntimeAssetBridge(project,async()=>{
    await runFlutter(['pub','get'],{project});
    await runFlutter(['build','apk','--release',`--target-platform=${archs.map(a=>targetNames[a]).join(',')}`,'--no-tree-shake-icons',`--target=${target}`,...defines.map(d=>`--dart-define=${d}`)],{project});
    return readFileSync(join(project,'build','app','outputs','flutter-apk','app-release.apk'));
  });
  const inspected=inspectApk(bytes,runtime,target);
  mkdirSync(outputDir,{recursive:true});
  if(mode==='release'&&existsSync(archived))throw new Error('A local release APK already exists for this version. Increase the version to protect your original build.');
  writeFileSync(archived,bytes);
  writeFileSync(join(outputDir,'build-manifest.json'),JSON.stringify(inspected.build_manifest,null,2)+'\n');
  return {...inspected,version,engine_version:runtime.engine_revision,apk:archived};
}
