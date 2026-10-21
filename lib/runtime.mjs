import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTool } from './process.mjs';

export const ternRoot = fileURLToPath(new URL('../',import.meta.url));
export const runtimeRoot = join(ternRoot,'.tern-tools','flutter');
export const toolchain = JSON.parse(readFileSync(join(ternRoot,'runtime','toolchain.json'),'utf8'));
export const flutterTool = join(runtimeRoot,'bin',process.platform==='win32'?'flutter.bat':'flutter');
export const runtimeEnvironment = { FLUTTER_STORAGE_BASE_URL:toolchain.artifactBaseUrl, FLUTTER_SUPPRESS_ANALYTICS:'true', CI:'true' };

export async function setupRuntime() {
  const toolsDirectory=join(ternRoot,'.tern-tools');
  mkdirSync(toolsDirectory,{recursive:true});
  if(!existsSync(join(runtimeRoot,'.git'))) {
    if(existsSync(runtimeRoot)&&readdirSync(runtimeRoot).length)throw new Error(`Unexpected files in ${runtimeRoot}; refusing to overwrite them.`);
    await runTool('git',['init',runtimeRoot]);
    await runTool('git',['-C',runtimeRoot,'config','core.longpaths','true']);
    await runTool('git',['-C',runtimeRoot,'remote','add','origin',toolchain.repository]);
    await runTool('git',['-C',runtimeRoot,'sparse-checkout','init','--cone']);
  }
  await runTool('git',['-C',runtimeRoot,'sparse-checkout','set','bin','packages','dev','examples']);
  const current=await runTool('git',['-C',runtimeRoot,'rev-parse','HEAD'],{capture:true}).catch(()=>({stdout:''}));
  if(current.stdout.trim()!==toolchain.revision) {
    await runTool('git',['-C',runtimeRoot,'fetch','--depth','1','--filter=blob:none','origin',toolchain.revision]);
    await runTool('git',['-C',runtimeRoot,'-c','advice.detachedHead=false','checkout','--detach',toolchain.revision]);
  }
  // Flutter's fork resolves the human version from these remote release refs.
  // A shallow SHA-only checkout otherwise reports 0.0.0 and breaks pub solving.
  await runTool('git',['-C',runtimeRoot,'fetch','--depth','1','origin',`refs/heads/${toolchain.releaseBranch}:refs/remotes/origin/${toolchain.releaseBranch}`]);
  for(const path of [join(runtimeRoot,'bin','cache','flutter.version.json'),join(runtimeRoot,'version')])if(existsSync(path))unlinkSync(path);
  const info=await runtimeInfo();
  writeFileSync(join(toolsDirectory,'runtime.json'),JSON.stringify({...info,installed_at:new Date().toISOString()},null,2)+'\n');
  return info;
}

export async function runtimeInfo() {
  if(!existsSync(flutterTool))throw new Error('Flutter update runtime is not installed. Run: npm run cli -- setup');
  const {stdout}=await runTool(flutterTool,['--version','--machine'],{env:runtimeEnvironment,capture:true});
  const start=stdout.indexOf('{'),end=stdout.lastIndexOf('}');
  if(start<0||end<start)throw new Error('The Flutter runtime did not return version metadata.');
  const version=JSON.parse(stdout.slice(start,end+1));
  if(version.frameworkRevision!==toolchain.revision)throw new Error('Runtime revision differs from the pinned toolchain. Run setup before building.');
  if(version.frameworkVersion==='0.0.0-unknown')throw new Error('Runtime version metadata is incomplete. Run setup again.');
  return {provider:toolchain.provider,flutter_root:runtimeRoot,flutter_revision:version.frameworkRevision,
    engine_revision:version.engineRevision,flutter_version:version.frameworkVersion,dart_version:version.dartSdkVersion};
}

export async function runFlutter(args,{project,capture=false}={}) {
  await runtimeInfo();
  return runTool(flutterTool,args,{cwd:project ? resolve(project) : undefined,env:runtimeEnvironment,capture});
}
