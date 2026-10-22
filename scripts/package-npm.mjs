import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,copyFileSync,renameSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash,createPublicKey,sign} from 'node:crypto';

const root=fileURLToPath(new URL('../',import.meta.url));
const build=join(root,'.tern-tools','npm-build'),dist=join(root,'dist');
const version=JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version;
function run(command,args,options={}){const result=spawnSync(command,args,{encoding:'utf8',windowsHide:true,maxBuffer:8*1024*1024,...options});if(result.status!==0)throw new Error(command+' failed: '+(result.error?.message||result.stderr||result.stdout));return result.stdout;}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
mkdirSync(build,{recursive:true});mkdirSync(dist,{recursive:true});
const stage=mkdtempSync(join(build,'package-'));
const files=run('git',['-C',root,'ls-files','-z','--','cli','lib','runtime','packages/tern_updater/lib','packages/tern_updater/android','packages/tern_updater/pubspec.yaml','packages/tern_updater/README.md','packages/tern_updater/CHANGELOG.md']).split('\0').filter(Boolean);
if(!files.includes('cli/tern.mjs')||!files.includes('runtime/cli-release-public.pem'))throw new Error('Stage the complete CLI before packaging.');
for(const file of files){
  if(file.includes('..')||file.endsWith('.pem')&&file!=='runtime/cli-release-public.pem'||!['cli/','lib/','runtime/','packages/tern_updater/'].some(prefix=>file.startsWith(prefix)))throw new Error('Unexpected npm package entry: '+file);
  const target=resolve(stage,file);if(!target.startsWith(stage+'\\')&&!target.startsWith(stage+'/'))throw new Error('Unsafe package entry.');
  mkdirSync(dirname(target),{recursive:true});copyFileSync(join(root,file),target);
}
const metadata={name:'@hatchmoon/tern',version,description:'Tern CLI for self-hosted Flutter updates',type:'module',bin:{tern:'./cli/tern.mjs'},engines:{node:'>=24.22.1 <25 || >=26.12.1'},repository:{type:'git',url:'https://github.com/hatchmoon/tern.git'},homepage:'https://tern.hatchmoon.cv',files:['cli','lib','runtime','packages/tern_updater','distribution.json']};
writeFileSync(join(stage,'package.json'),JSON.stringify(metadata,null,2)+'\n');
writeFileSync(join(stage,'distribution.json'),JSON.stringify({format:1,method:'npm',package:metadata.name})+'\n');
if(!process.env.npm_execpath)throw new Error('Run this packager with npm run package:npm.');
const pack=JSON.parse(run(process.execPath,[process.env.npm_execpath,'pack','--offline','--json','--pack-destination',dist],{cwd:stage}))[0];
const allowed=new Set([...files,'package.json','distribution.json']);
for(const entry of pack.files)if(!allowed.has(entry.path))throw new Error('Unexpected file in npm package: '+entry.path);
const filename='tern-cli-'+version+'.tgz',output=join(dist,filename);
renameSync(join(dist,pack.filename),output);
const bytes=readFileSync(output),privateKey=readFileSync(join(root,'.tern-data','cli-release-signing.pem'));
if(createPublicKey(privateKey).export({type:'spki',format:'pem'}).toString()!==readFileSync(join(root,'runtime','cli-release-public.pem'),'utf8'))throw new Error('CLI release signing identity differs from the trusted public key.');
const payload={format:1,version,platform:'npm',filename,sha256:sha(bytes),size:bytes.length};
writeFileSync(join(dist,'tern-npm-latest.json'),JSON.stringify({payload,signature:sign(null,Buffer.from(JSON.stringify(payload)),privateKey).toString('base64')},null,2)+'\n');
writeFileSync(output+'.sha256',payload.sha256+'  '+filename+'\n');
console.log(JSON.stringify({...payload,files:pack.files.length},null,2));
