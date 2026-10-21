import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32,deflateRawSync } from 'node:zlib';
import { mkdtempSync,readFileSync,writeFileSync,existsSync,mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readZip } from '../lib/zip.mjs';
import { inspectApk,assertPatchCompatible } from '../lib/android.mjs';
import { ensureRuntimeAsset,migrateRuntimeConfig,withRuntimeAssetBridge,readPubspecVersion } from '../lib/project.mjs';
import { sha256 } from '../lib/patch.mjs';
import { parseArgs } from '../cli/tern.mjs';

function zip(files) {
  const local=[],directory=[];let offset=0;
  for(const[name,content]of Object.entries(files)) {
    const filename=Buffer.from(name),data=Buffer.from(content),compressed=deflateRawSync(data),crc=crc32(data);
    const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(8,8);header.writeUInt32LE(crc,14);header.writeUInt32LE(compressed.length,18);header.writeUInt32LE(data.length,22);header.writeUInt16LE(filename.length,26);
    local.push(header,filename,compressed);
    const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(8,10);central.writeUInt32LE(crc,16);central.writeUInt32LE(compressed.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(filename.length,28);central.writeUInt32LE(offset,42);
    directory.push(central,filename);offset+=header.length+filename.length+compressed.length;
  }
  const central=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(Object.keys(files).length,8);end.writeUInt16LE(Object.keys(files).length,10);end.writeUInt32LE(central.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,central,end]);
}
const runtime={flutter_revision:'1'.repeat(40),engine_revision:'2'.repeat(40)};
const files={
 'assets/flutter_assets/shorebird.yaml':'app_id: native-app\nbase_url: https://updates.example.com\nchannel: staging\nauto_update: false\n',
 'lib/x86_64/libflutter.so':'ELF fixture shorebird updater',
 'lib/x86_64/libapp.so':'original Dart code',
 'AndroidManifest.xml':'native manifest',
 'classes.dex':'native code',
 'assets/flutter_assets/image.png':'image asset',
};
test('APK ZIP reader reconstructs entries and rejects corrupted bytes',()=>{
 const bytes=zip(files),entries=readZip(bytes);assert.equal(entries.get('classes.dex').read().toString(),'native code');
 const corrupted=Buffer.from(bytes);corrupted[40]^=42;
 assert.throws(()=>readZip(corrupted).get('assets/flutter_assets/shorebird.yaml').read());
 assert.throws(()=>readZip(Buffer.from('not a zip')));
});
test('APK inspection extracts Dart artifacts and records nonpatchable fingerprints',()=>{
 const inspected=inspectApk(zip(files),runtime);
 assert.equal(inspected.app_id,'native-app');assert.equal(inspected.artifacts[0].arch,'x86_64');
 assert.equal(Buffer.from(inspected.artifacts[0].data,'base64').toString(),'original Dart code');
 assert.ok(inspected.build_manifest.files['classes.dex']);assert.ok(!inspected.build_manifest.files['lib/x86_64/libapp.so']);
});
test('native and asset changes are rejected while Dart-only changes are permitted',()=>{
 const original=inspectApk(zip(files),runtime).build_manifest;
 const patch=inspectApk(zip({...files,'lib/x86_64/libapp.so':'patched Dart code'}),runtime).build_manifest;
 assert.doesNotThrow(()=>assertPatchCompatible(original,patch));
 for(const name of ['classes.dex','AndroidManifest.xml','assets/flutter_assets/image.png','lib/x86_64/libflutter.so']) {
  const changed=inspectApk(zip({...files,[name]:files[name]+' changed'}),runtime).build_manifest;
  assert.throws(()=>assertPatchCompatible(original,changed),/new store release/);
 }
 assert.throws(()=>assertPatchCompatible(original,{...patch,engine_revision:'3'.repeat(40)}),/original runtime/);
});
test('stock Flutter APKs and absent updater assets are rejected',()=>{
 assert.throws(()=>inspectApk(zip({...files,'lib/x86_64/libflutter.so':'stock engine'}),runtime),/update runtime/);
 const without={...files};delete without['assets/flutter_assets/shorebird.yaml'];
 assert.throws(()=>inspectApk(zip(without),runtime),/generated updater asset/);
});
test('project initialization adds the runtime asset without losing existing assets',()=>{
 const project=mkdtempSync(join(tmpdir(),'tern-assets-')),path=join(project,'pubspec.yaml');
 writeFileSync(path,'name: app\nflutter:\n  uses-material-design: true\n  assets:\n    - images/\n');
 const before=readFileSync(path,'utf8');ensureRuntimeAsset(project,{dryRun:true});assert.equal(readFileSync(path,'utf8'),before);
 ensureRuntimeAsset(project);ensureRuntimeAsset(project);
 const output=readFileSync(path,'utf8');assert.ok(output.includes('    - images/'));
 assert.equal(output.match(/- tern.yaml/g).length,1);
});

test('legacy project config migrates to tern.yaml and retains its values and other assets',()=>{
 const project=mkdtempSync(join(tmpdir(),'tern-migration-'));
 writeFileSync(join(project,'pubspec.yaml'),'name: app\nflutter:\n  assets:\n    - images/\n    - "shorebird.yaml" # updater\n    - tern.yaml\n');
 writeFileSync(join(project,'shorebird.yaml'),'app_id: existing-app\nbase_url: https://example.com\n');
 assert.equal(migrateRuntimeConfig(project),true);assert.equal(migrateRuntimeConfig(project),false);
 assert.equal(existsSync(join(project,'shorebird.yaml')),false);
 assert.match(readFileSync(join(project,'tern.yaml'),'utf8'),/existing-app/);
 const pubspec=readFileSync(join(project,'pubspec.yaml'),'utf8');
 assert.match(pubspec,/- images\//);assert.match(pubspec,/- tern.yaml # updater/);
 assert.equal(pubspec.match(/- tern.yaml/g).length,1);
});

test('runtime bridge packages the existing native asset and restores the source after success or failure',async()=>{
 const project=mkdtempSync(join(tmpdir(),'tern-bridge-'));
 const original='name: app\r\nversion: "1.0.0+1"\r\nflutter:\r\n  assets:\r\n    - tern.yaml\r\n    - images/\r\n';
 writeFileSync(join(project,'pubspec.yaml'),original);writeFileSync(join(project,'tern.yaml'),'app_id: bridge-app\n');
 for(const failure of [false,true]) {
  const build=()=>withRuntimeAssetBridge(project,async()=>{
   assert.match(readFileSync(join(project,'pubspec.yaml'),'utf8'),/- shorebird.yaml/);
   assert.doesNotMatch(readFileSync(join(project,'pubspec.yaml'),'utf8'),/- tern.yaml/);
   assert.equal(readFileSync(join(project,'shorebird.yaml'),'utf8'),'app_id: bridge-app\n');
   await assert.rejects(withRuntimeAssetBridge(project,async()=>{}),/Another Tern build/);
   if(failure)throw Error('build failed');return 'built';
  });
  if(failure)await assert.rejects(build(),/build failed/);else assert.equal(await build(),'built');
  assert.equal(readFileSync(join(project,'pubspec.yaml'),'utf8'),original);
  assert.equal(existsSync(join(project,'shorebird.yaml')),false);
  assert.equal(existsSync(join(project,'.tern-build','runtime-bridge.json')),false);
 }
});

test('interrupted runtime builds recover and edits during builds are preserved',async()=>{
 const project=mkdtempSync(join(tmpdir(),'tern-recovery-'));
 const original='name: app\nflutter:\n  assets:\n    - tern.yaml\n';
 const prepared=original.replace('tern.yaml','shorebird.yaml'),config=Buffer.from('app_id: recover\n');
 writeFileSync(join(project,'pubspec.yaml'),prepared);writeFileSync(join(project,'tern.yaml'),config);writeFileSync(join(project,'shorebird.yaml'),config);
 mkdirSync(join(project,'.tern-build'));
 writeFileSync(join(project,'.tern-build','runtime-bridge.json'),JSON.stringify({project,pid:2147483647,original,prepared,generatedLegacy:true,configHash:sha256(config)}));
 await withRuntimeAssetBridge(project,async()=>writeFileSync(join(project,'pubspec.yaml'),prepared+'# kept user edit\n'));
 assert.equal(readFileSync(join(project,'pubspec.yaml'),'utf8'),original+'# kept user edit\n');
 assert.equal(existsSync(join(project,'shorebird.yaml')),false);
 writeFileSync(join(project,'shorebird.yaml'),'different configuration');
 await assert.rejects(withRuntimeAssetBridge(project,async()=>{}),/differ/);
 assert.equal(readFileSync(join(project,'shorebird.yaml'),'utf8'),'different configuration');
});

test('pubspec versions accept quotes and comments and explain missing build numbers',()=>{
 for(const line of ['version: 1.2.3+42','version: "1.2.3+42" # release',"version: '1.2.3+42'",'\uFEFFversion: 1.2.3+42'])assert.equal(readPubspecVersion(line),'1.2.3+42');
 for(const source of ['name: app\n','version: 1.2.3','version: "1.2.3+4 junk"'])assert.throws(()=>readPubspecVersion(source,'D:/app/pubspec.yaml'),/D:\/app\/pubspec.yaml needs a version/);
});
test('CLI preserves multiple defines and accepts manual native updates',()=>{
 const {options}=parseArgs(['init','--manual-updates','--dart-define','A=x','--dart-define','B=y']);
 assert.equal(options['manual-updates'],true);assert.deepEqual(options['dart-define'],['A=x','B=y']);
});
