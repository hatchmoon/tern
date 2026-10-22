import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {generateKeyPairSync,createPublicKey,sign,verify} from 'node:crypto';
import {runTool} from './process.mjs';
import {readZip} from './zip.mjs';
import {sha256} from './patch.mjs';
import {readPubspecVersion} from './project.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
export const nativeToolchain=JSON.parse(readFileSync(join(root,'runtime/toolchain.json'),'utf8'));
const sdkRoot=()=>resolve(process.env.TERN_FLUTTER_ROOT||join(root,'.tern-tools','official-flutter'));
const flutter=()=>join(sdkRoot(),'bin',process.platform==='win32'?'flutter.bat':'flutter');
const environment={FLUTTER_STORAGE_BASE_URL:nativeToolchain.artifactBaseUrl,FLUTTER_SUPPRESS_ANALYTICS:'true',CI:'true'};
export async function officialRuntimeInfo() {
  if(!existsSync(flutter()))throw new Error('Official Flutter toolchain is missing. Run: tern setup');
  const result=await runTool(flutter(),['--version','--machine'],{env:environment,capture:true});
  const info=JSON.parse(result.stdout.slice(result.stdout.indexOf('{'),result.stdout.lastIndexOf('}')+1));
  if(info.frameworkRevision!==nativeToolchain.revision||info.engineRevision!==nativeToolchain.engineRevision)throw new Error('The official Flutter SDK differs from Tern’s pin. Run tern setup, or set TERN_FLUTTER_ROOT to the pinned official SDK.');
  return {provider:'flutter-official',runtime:'tern-native-v1',flutter_root:sdkRoot(),flutter_revision:info.frameworkRevision,engine_revision:info.engineRevision,flutter_version:info.frameworkVersion,dart_version:info.dartSdkVersion};
}
export async function setupOfficialRuntime() {
  if(process.env.TERN_FLUTTER_ROOT)return officialRuntimeInfo();
  mkdirSync(join(root,'.tern-tools'),{recursive:true});
  if(!existsSync(sdkRoot()))await runTool('git',['clone','--depth','1','--branch',nativeToolchain.flutterVersion,'--filter=blob:none','--sparse','--no-checkout',nativeToolchain.repository,sdkRoot()]);
  const remote=await runTool('git',['-C',sdkRoot(),'remote','get-url','origin'],{capture:true});
  if(remote.stdout.trim()!==nativeToolchain.repository)throw new Error('Unexpected official Flutter checkout origin; refusing to replace it.');
  await runTool('git',['-C',sdkRoot(),'sparse-checkout','set','bin','packages','dev']);
  await runTool('git',['-C',sdkRoot(),'fetch','--depth','1','origin',nativeToolchain.revision]);
  await runTool('git',['-C',sdkRoot(),'checkout','--detach',nativeToolchain.revision]);
  await runTool('git',['-C',sdkRoot(),'fetch','--depth','1','origin',`refs/tags/${nativeToolchain.flutterVersion}:refs/tags/${nativeToolchain.flutterVersion}`]);
  return officialRuntimeInfo();
}

export function patchSignatureMessage({app_id,version,engine_revision,arch,hash}) {
  return ['tern-native-v1',app_id,version,engine_revision,arch,hash].join('\n');
}
export function verifyNativePatch(publicKey,context,signature) {
  try {return verify('sha256',Buffer.from(patchSignatureMessage(context)),{key:Buffer.from(publicKey,'base64'),format:'der',type:'spki'},Buffer.from(signature,'base64'));}catch{return false;}
}
function signingKey(appId,{create=false}={}) {
  if(!/^[a-zA-Z0-9-]+$/.test(appId))throw new Error('Invalid application ID for signing key storage.');
  const directory=join(root,'.tern-data','signing'),path=join(directory,appId+'.private.pem');
  if(!existsSync(path)) {
    if(!create)throw new Error('The release signing key is missing. Restore it securely from the original build machine.');
    mkdirSync(directory,{recursive:true,mode:0o700});
    const pair=generateKeyPairSync('rsa',{modulusLength:3072,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
    writeFileSync(path,pair.privateKey,{mode:0o600,flag:'wx'});
  }
  const key=readFileSync(path,'utf8');
  return {privateKey:key,publicKey:createPublicKey(key).export({type:'spki',format:'der'}).toString('base64')};
}

/** Explicitly wire the early loader into a Flutter Android project. */
export function integrateNativeProject(project,{dryRun=false}={}) {
  const manifest=join(project,'android/app/src/main/AndroidManifest.xml');
  let xml=readFileSync(manifest,'utf8');
  const app=xml.match(/<application\b[^>]*>/)?.[0];
  if(!app)throw new Error('AndroidManifest.xml has no application element.');
  const name=app.match(/android:name="([^"]+)"/)?.[1];
  if(name&&name!=='${applicationName}'&&name!=='cv.hatchmoon.tern.updater.TernApplication')throw new Error('Custom Android Application detected. Call TernApplication.install(this) before Flutter initialization, then configure Tern manually.');
  const updated=name?app.replace(/android:name="[^"]+"/,'android:name="cv.hatchmoon.tern.updater.TernApplication"'):app.replace('<application','<application android:name="cv.hatchmoon.tern.updater.TernApplication"');
  xml=xml.replace(app,updated);
  if(!xml.includes('android.permission.INTERNET'))xml=xml.replace(updated,'<uses-permission android:name="android.permission.INTERNET" />\n    '+updated);
  const path=join(project,'pubspec.yaml');let pubspec=readFileSync(path,'utf8');
  if(!/^  tern_updater:/m.test(pubspec)) {
    if(!/^dependencies:\s*$/m.test(pubspec))throw new Error('Add a standard dependencies: section to pubspec.yaml before integrating Tern.');
    pubspec=pubspec.replace(/^dependencies:\s*$/m,'dependencies:\n  tern_updater:\n    path: "'+join(root,'packages','tern_updater').replaceAll('\\','/')+'"');
  }
  if(!/^    - ['"]?tern-runtime\.json['"]?\s*$/m.test(pubspec)) {
    if(/^  assets:\s*$/m.test(pubspec))pubspec=pubspec.replace(/^  assets:\s*$/m,'  assets:\n    - tern-runtime.json');
    else pubspec=pubspec.replace(/^flutter:\s*$/m,'flutter:\n  assets:\n    - tern-runtime.json');
  }
  if(dryRun)return;
  writeFileSync(manifest,xml);writeFileSync(path,pubspec);
  const gradle=join(project,'android/app/build.gradle.kts');
  if(existsSync(gradle))writeFileSync(gradle,readFileSync(gradle,'utf8').replace(/minSdk = flutter.minSdkVersion/,'minSdk = 26'));
}

export function inspectNativeApk(bytes,runtime,target='lib/main.dart') {
  const entries=readZip(bytes),config=JSON.parse(entries.get('assets/flutter_assets/tern-runtime.json')?.read().toString('utf8')||'null');
  if(config?.runtime!=='tern-native-v1'||config.engine_revision!==runtime.engine_revision)throw new Error('APK does not contain matching Tern native runtime configuration.');
  const artifacts=[];
  for(const [arch,abi]of Object.entries({aarch64:'arm64-v8a',arm:'armeabi-v7a',x86_64:'x86_64'})) {
    const dart=entries.get(`lib/${abi}/libapp.so`);if(dart)artifacts.push({arch,data:dart.read().toString('base64')});
  }
  if(!artifacts.length)throw new Error('No compiled Dart libraries found in APK.');
  const files=Object.create(null);
  for(const [name,entry]of entries)if(!name.endsWith('/')&&!/^META-INF\//.test(name)&&!/^lib\/[^/]+\/libapp\.so$/.test(name))files[name]=sha256(entry.read());
  return {artifacts,app_id:config.app_id,update_url:config.base_url,build_manifest:{format:'tern-android-v1',flutter_revision:runtime.flutter_revision,engine_revision:runtime.engine_revision,target,runtime:{id:'tern-native-v1',public_key:config.public_key},files}};
}

export async function buildNativeAndroid({project,archs,defines=[],target='lib/main.dart',mode='release',resume=false}) {
  project=resolve(project);
  const version=readPubspecVersion(readFileSync(join(project,'pubspec.yaml'),'utf8'),join(project,'pubspec.yaml'));
  const runtime=await officialRuntimeInfo();
  const yaml=Object.fromEntries(readFileSync(join(project,'tern.yaml'),'utf8').split(/\r?\n/).map(line=>line.match(/^([a-z_]+):\s*(.*?)\s*$/)).filter(Boolean).map(([,key,value])=>[key,value]));
  if(yaml.runtime!=='tern-native-v1')throw new Error('Independent runtime builds require runtime: tern-native-v1 in tern.yaml.');
  const signing=signingKey(yaml.app_id,{create:mode==='release'});
  const origin=new URL(yaml.base_url),local=['127.0.0.1','localhost','[::1]'].includes(origin.hostname);
  if(origin.protocol!=='https:'&&!(origin.protocol==='http:'&&local))throw new Error('Use HTTPS for updates, or loopback HTTP for local testing.');
  const configuration={runtime:'tern-native-v1',app_id:yaml.app_id,base_url:yaml.base_url.replace(/\/$/,''),release_version:version,engine_revision:runtime.engine_revision,public_key:signing.publicKey,channel:yaml.channel||'stable',auto_update:yaml.auto_update!=='false',allow_local_http:local&&origin.protocol==='http:'};
  const output=join(project,'.tern-build',mode,version),apk=join(output,'app-release.apk');
  if(mode==='release'&&existsSync(apk)) {
    if(!resume)throw new Error('The original APK already exists. Use --resume or increase the release version.');
    const saved=inspectNativeApk(readFileSync(apk),runtime,target);
    if(saved.app_id!==yaml.app_id||saved.build_manifest.runtime.public_key!==signing.publicKey)throw new Error('Archived APK differs from the application or signing key.');
    return {...saved,version,engine_version:runtime.engine_revision,apk};
  }
  writeFileSync(join(project,'tern-runtime.json'),JSON.stringify(configuration,null,2)+'\n');
  const targets={aarch64:'android-arm64',arm:'android-arm',x86_64:'android-x64'};
  if(!archs?.length||archs.some(arch=>!targets[arch]))throw new Error('Unsupported Android architectures.');
  await runTool(flutter(),['pub','get'],{cwd:project,env:environment});
  await runTool(flutter(),['build','apk','--release','--target-platform='+archs.map(arch=>targets[arch]).join(','),'--no-tree-shake-icons','--target='+target,...defines.map(value=>'--dart-define='+value)],{cwd:project,env:environment});
  const bytes=readFileSync(join(project,'build/app/outputs/flutter-apk/app-release.apk'));
  const inspected=inspectNativeApk(bytes,runtime,target);
  if(mode==='patch')for(const artifact of inspected.artifacts)artifact.hash_signature=sign('sha256',Buffer.from(patchSignatureMessage({app_id:yaml.app_id,version,engine_revision:runtime.engine_revision,arch:artifact.arch,hash:sha256(Buffer.from(artifact.data,'base64'))})),signing.privateKey).toString('base64');
  mkdirSync(output,{recursive:true});writeFileSync(apk,bytes);writeFileSync(join(output,'build-manifest.json'),JSON.stringify(inspected.build_manifest,null,2)+'\n');
  return {...inspected,version,engine_version:runtime.engine_revision,apk};
}
