import {spawnSync} from 'node:child_process';
import {existsSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {signingKeyPath,clientHome,toolDirectory} from '../lib/client-state.mjs';
import {officialRuntimeInfo} from '../lib/native-runtime.mjs';
import {runtimeInfo} from '../lib/runtime.mjs';

export async function diagnose({server,project,yaml,request,serverOnly=false}){
  const checks=[];const check=(name,ok,fix,detail)=>checks.push({name,status:ok?'ok':'error',...(detail?{detail}:{}),...(!ok?{fix}: {})});
  let healthy=false,authenticated=false,applications=0;
  try{const health=await request('/health',null,false);healthy=health.status==='ok';check('Server',healthy,'Check the server address and connection.',server);}
  catch(error){check('Server',false,'Check HTTPS, DNS and your server address.',error.message);}
  if(healthy)try{const snapshot=await request('/api/snapshot');authenticated=true;applications=snapshot.apps.length;check('Sign-in',true);}
  catch(error){check('Sign-in',false,'Run tern login --server '+server,error.message);}
  if(!serverOnly){
    const [major,minor,patch]=process.versions.node.split('.').map(Number);
    check('Node.js security baseline',(major===24&&(minor>22||(minor===22&&patch>=1)))||(major===26&&(minor>12||(minor===12&&patch>=1)))||major>26,'Install a patched Node.js 24.22.1+ runtime.',process.version);
    const git=spawnSync('git',['--version'],{encoding:'utf8',windowsHide:true});check('Git',git.status===0,'Install Git and reopen the terminal. Git is required by Flutter SDK setup.');
    const java=spawnSync(process.env.JAVA_HOME?join(process.env.JAVA_HOME,'bin',process.platform==='win32'?'java.exe':'java'):'java',['-version'],{encoding:'utf8',windowsHide:true});
    const javaVersion=(java.stderr||java.stdout||'').match(/version "(\d+)/)?.[1];check('Java',java.status===0&&Number(javaVersion)>=17,'Install JDK 17+ and configure JAVA_HOME.',javaVersion?'Java '+javaVersion:undefined);
    const sdk=process.env.ANDROID_HOME||process.env.ANDROID_SDK_ROOT||(process.platform==='win32'?join(process.env.LOCALAPPDATA||join(homedir(),'AppData','Local'),'Android','Sdk'):process.platform==='darwin'?join(homedir(),'Library','Android','sdk'):join(homedir(),'Android','Sdk'));
    check('Android SDK',existsSync(join(sdk,'platform-tools'))&&existsSync(join(sdk,'platforms','android-36')),'Install Android SDK platform 36 and platform tools in Android Studio, and set ANDROID_HOME.',sdk);
    check('Android SDK licenses',existsSync(join(sdk,'licenses','android-sdk-license')),'Accept the Android SDK licenses using sdkmanager --licenses.');
    check('Android build tools',existsSync(join(sdk,'build-tools'))&&readdirSync(join(sdk,'build-tools')).length>0,'Install Android SDK build tools in Android Studio.');
    check('Android NDK',existsSync(join(sdk,'ndk'))&&readdirSync(join(sdk,'ndk')).length>0,'Install the NDK version required by the pinned Flutter SDK using Android Studio.');
    if(existsSync(join(project,'pubspec.yaml'))){
      check('Project connection',!!yaml.app_id,'Run tern connect for an existing application, or tern init for a new one.');
      try{const info=await (yaml.runtime==='tern-native-v1'?officialRuntimeInfo():runtimeInfo());check('Pinned Flutter SDK',true,undefined,info.flutter_version);}
      catch(error){check('Pinned Flutter SDK',false,'Run tern setup from this project folder.',error.message);}
      if(yaml.runtime==='tern-native-v1'&&yaml.app_id)check('Patch signing key',existsSync(signingKeyPath(yaml.app_id)),'For an existing release, import the original encrypted signing-key backup. A new release creates its first key.');
    }
  }
  return {server,node:process.version,status:healthy?'ok':'unreachable',authenticated,applications,ready:checks.every(c=>c.status==='ok'),home:clientHome(),cache:toolDirectory(),checks};
}
