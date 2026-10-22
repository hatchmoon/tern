import {readdirSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,relative} from 'node:path';
import {spawnSync} from 'node:child_process';
import {ternRoot} from '../lib/runtime.mjs';
import {sha256} from '../lib/patch.mjs';

const root=join(ternRoot,'packages','tern_updater'),dist=join(ternRoot,'dist');
const skip=new Set(['.dart_tool','.gradle','.kotlin','.idea','.git','build','local.properties','.flutter-plugins-dependencies','pubspec.lock','.metadata','GeneratedPluginRegistrant.java','tern.yaml','shorebird.yaml','tern-runtime.json']);
const files=[];
function walk(directory){
  for(const entry of readdirSync(directory,{withFileTypes:true})){
    if(skip.has(entry.name)||entry.name.endsWith('.iml')||entry.name.startsWith('.tern'))continue;
    if(entry.isSymbolicLink())throw new Error('Unexpected package symlink: '+entry.name);
    const path=join(directory,entry.name);
    if(entry.isDirectory())walk(path);else files.push(relative(join(ternRoot,'packages'),path));
  }
}
for(const name of ['lib','android','test','example'])walk(join(root,name));
for(const name of ['pubspec.yaml','analysis_options.yaml','README.md','CHANGELOG.md','.gitignore'])files.push(join('tern_updater',name));
mkdirSync(dist,{recursive:true});
const version=readFileSync(join(root,'pubspec.yaml'),'utf8').match(/^version:\s*([0-9]+\.[0-9]+\.[0-9]+)\s*$/m)?.[1];
if(!version)throw new Error('Package needs an explicit semantic version.');
const archive=join(dist,'tern_updater-'+version+'.zip');
const result=spawnSync('tar',['-a','-cf',archive,'-C',join(ternRoot,'packages'),...files],{encoding:'utf8'});
if(result.status!==0)throw new Error(result.stderr||'Archive creation failed.');
const bytes=readFileSync(archive);
const report={archive,sha256:sha256(bytes),source_files:files.length,bytes:bytes.length};
writeFileSync(join(dist,'tern_updater-'+version+'.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
