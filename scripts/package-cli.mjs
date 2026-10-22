import {readFileSync,writeFileSync,mkdirSync,existsSync,copyFileSync} from 'node:fs';
import {join,resolve,relative,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash,generateKeyPairSync,createPublicKey,sign} from 'node:crypto';
import {readZip} from '../lib/zip.mjs';
import {fileURLToPath} from 'node:url';

if(process.platform!=='win32')throw new Error('Build the Windows installer on Windows.');
const root=fileURLToPath(new URL('../',import.meta.url));
const version=JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version;
const build=join(root,'.tern-tools','installer-build'),payload=join(build,'payload-'+version),dist=join(root,'dist');
const toolchain=JSON.parse(readFileSync(join(root,'runtime','installer-toolchain.json'),'utf8'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function run(cmd,args){const r=spawnSync(cmd,args,{encoding:'utf8',windowsHide:true,maxBuffer:4*1024*1024});if(r.status!==0)throw new Error((r.stderr||r.stdout||cmd+' failed'));return r.stdout;}
for(const directory of [build,payload,dist,join(root,'.tern-data')])mkdirSync(directory,{recursive:true});
const privatePath=join(root,'.tern-data','cli-release-signing.pem'),publicPath=join(root,'runtime','cli-release-public.pem');
if(!existsSync(privatePath)){
  if(existsSync(publicPath))throw new Error('Restore the original CLI release signing key before publishing.');
  const pair=generateKeyPairSync('ed25519');writeFileSync(privatePath,pair.privateKey.export({type:'pkcs8',format:'pem'}),{flag:'wx',mode:0o600});writeFileSync(publicPath,pair.publicKey.export({type:'spki',format:'pem'}),{flag:'wx'});
}
const privateKey=readFileSync(privatePath);
if(createPublicKey(privateKey).export({type:'spki',format:'pem'}).toString()!==readFileSync(publicPath,'utf8'))throw new Error('CLI release signing identity differs from the trusted public key.');
const archivePath=join(build,'node-v'+toolchain.node_version+'-win-x64.zip');
if(!existsSync(archivePath)){
  const response=await fetch(toolchain.windows_x64.url,{signal:AbortSignal.timeout(180000)});if(!response.ok)throw new Error('Node download failed');
  writeFileSync(archivePath,Buffer.from(await response.arrayBuffer()));
}
const archive=readFileSync(archivePath);if(hash(archive)!==toolchain.windows_x64.sha256)throw new Error('Official Node archive checksum mismatch.');
const nodeFiles=readZip(archive),prefix='node-v'+toolchain.node_version+'-win-x64/';
writeFileSync(join(payload,'node.exe'),nodeFiles.get(prefix+'node.exe').read());
writeFileSync(join(payload,'NODE-LICENSE.txt'),nodeFiles.get(prefix+'LICENSE').read());
// Build only explicitly tracked application sources. No credentials, project
// caches, local builds, or distribution signing keys can enter the payload.
const files=run('git',['-C',root,'ls-files','--','cli','lib','runtime','packages/tern_updater/lib','packages/tern_updater/android','packages/tern_updater/pubspec.yaml','packages/tern_updater/README.md','packages/tern_updater/CHANGELOG.md','package.json']).trim().split(/\r?\n/);
// Newly added sources must be staged before packaging.
if(!files.includes('cli/upgrade.mjs')||!files.includes('runtime/cli-release-public.pem'))throw new Error('Stage all CLI sources and the public release key before packaging.');
for(const file of files){if(!file||file.endsWith('.pem')&&file!=='runtime/cli-release-public.pem')throw new Error('Unexpected payload entry.');const target=join(payload,file);mkdirSync(dirname(target),{recursive:true});copyFileSync(join(root,file),target);}
writeFileSync(join(payload,'installer.json'),JSON.stringify({format:1,version,platform:'win32',arch:'x64',node:toolchain.node_version})+'\n');
const compiler=join(process.env.WINDIR,'Microsoft.NET','Framework64','v4.0.30319','csc.exe');
run(compiler,['/nologo','/codepage:65001','/target:exe','/platform:x64','/out:'+join(payload,'launcher.exe'),join(root,'installer','Launcher.cs')]);
const manifest={};const payloadFiles=[...files,'node.exe','NODE-LICENSE.txt','installer.json','launcher.exe'];
for(const file of payloadFiles)manifest[file]=hash(readFileSync(join(payload,file)));
writeFileSync(join(payload,'payload-manifest.json'),JSON.stringify(manifest));
const payloadZip=join(build,'tern-cli-'+version+'-payload.zip');
run('tar.exe',['-a','-cf',payloadZip,'-C',payload,...payloadFiles,'payload-manifest.json']);
const payloadHash=hash(readFileSync(payloadZip));
const info=join(build,'BuildInfo.cs');writeFileSync(info,'public static class BuildInfo { public const string Version="'+version+'"; public const string PayloadHash="'+payloadHash+'"; }\n');
const filename='TernSetup-'+version+'-windows-x64.exe',output=join(dist,filename);
run(compiler,['/nologo','/codepage:65001','/target:winexe','/platform:x64','/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll','/reference:System.Web.Extensions.dll','/reference:System.IO.Compression.dll','/reference:System.IO.Compression.FileSystem.dll','/out:'+output,'/resource:'+payloadZip+',payload.zip',info,join(root,'installer','Setup.cs')]);
const bytes=readFileSync(output);
const release={format:1,version,platform:'windows-x64',filename,sha256:hash(bytes),size:bytes.length,node:toolchain.node_version,authenticode:false};
const envelope={payload:release,signature:sign(null,Buffer.from(JSON.stringify(release)),privateKey).toString('base64')};
writeFileSync(join(dist,'tern-cli-latest.json'),JSON.stringify(envelope,null,2)+'\n');
writeFileSync(join(dist,filename+'.sha256'),release.sha256+'  '+filename+'\n');
console.log(JSON.stringify({...release,path:output,release_manifest_signed:true},null,2));
