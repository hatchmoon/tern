#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { applyPatch, sha256 } from '../lib/patch.mjs';
import { setupRuntime, ternRoot } from '../lib/runtime.mjs';
import { buildAndroid,readRuntimeYaml } from '../lib/android.mjs';
import { ensureRuntimeAsset,readPubspecVersion } from '../lib/project.mjs';
import {setupOfficialRuntime,buildNativeAndroid,integrateNativeProject} from '../lib/native-runtime.mjs';
import {readSettings,canonicalServer,savedToken} from '../lib/client-state.mjs';
import {browserLogin,connectProject,logout,transferKey} from './onboarding.mjs';
import {diagnose} from './doctor.mjs';

const cliVersion=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;

const help = `
  Tern · self-hosted Flutter code push

  tern <command> [options]

  login      Sign in through your browser [--server https://tern.hatchmoon.cv]
             --no-browser prints a link for manual approval
  logout     Revoke this machine's credential and sign out
  connect    Connect this Flutter project to an existing app [--app APP_ID]
  keys       export --output backup.pem | import --input backup.pem
             Encrypted signing-key transfer; prompts for a passphrase
  upgrade    Check the latest release [--check]; Windows installs can download it
             --rollback switches back to the previous Windows installer version

  init       --name "My app" [--configure-runtime]
  integrate  Wire Tern's independent runtime into an existing Android project
             Requires a new baseline release; does not migrate installed APKs
  setup      Install the pinned official Flutter toolchain (no Shorebird)
             --runtime legacy installs the old toolchain for existing releases
  release    [--project path/to/flutter_app] [--arch x86_64]
  patch      [--project path/to/flutter_app] [--dart-define KEY=value]
             Builds with the pinned runtime, extracts artifacts, and uploads.
  apps       List applications and releases
  release    --version 1.0.0+1 --platform android --engine <revision>
             --artifact aarch64=path/to/libapp.so [--artifact arm=...]
  patch      --version 1.0.0+1 --platform android --engine <same-revision>
             --artifact aarch64=path/to/new/libapp.so [--notes "Fix checkout"]
  deploy     --patch <id> --channel beta [--rollout 10]
  rollback   --patch <id>
  check      --app <id> --version 1.0.0+1 --platform android
             [--arch aarch64] [--channel stable] [--client <install-id>]
  simulate   Same as check, plus --base <original-binary> --output <patched-file>
             Downloads, reconstructs, verifies, and reports install telemetry.
             This validates distribution; it does not execute Flutter code.
  config     Print the runtime YAML for the configured app
  doctor     Check connection, sign-in, Java, Android SDK and runtime
             --server-only checks connectivity; --build fails if a check fails

  Global: --server <url> --token-file <path> --app <id> --json
  Project builds: --project <folder> --arch aarch64,arm,x86_64
                  --dart-define KEY=value --target lib/main.dart
  Configuration: --configure-runtime --update-url <device-reachable-url>
                 --channel staging --manual-updates
                 --runtime legacy retains the old runtime for existing releases
  Retry upload: release --project <folder> --resume (uses the saved original APK)
  Auth: --token-file, TERN_TOKEN, or .tern-data/admin-token beside Tern's installation.
  Config: .tern.json in the current directory. No credentials are saved here.
  Run release and patch from your Flutter project folder; --project is optional.
  Project runtime configuration: tern.yaml.
  Release and patch binaries must use the same pinned official Flutter toolchain
  and Tern native integration. Migrating an old runtime needs a new baseline APK.
`;

export function parseArgs(args) {
  const options = { artifact: [], 'dart-define': [] };
  let command = 'help';
  if (args[0] && !args[0].startsWith('--')) command = args.shift();
  const flags = new Set(['json', 'configure-runtime', 'manual-updates', 'resume', 'help','no-browser','server-only','build','check','rollback']);
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) throw new Error(`Unexpected argument: ${args[i]}`);
    const key = args[i].slice(2);
    if (flags.has(key)) { options[key] = true; continue; }
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`--${key} needs a value.`);
    if (key === 'artifact') options.artifact.push(value);
    else if (key === 'dart-define') options['dart-define'].push(value);
    else options[key] = value;
  }
  return { command, options };
}

export async function run(args = process.argv.slice(2)) {
  if(args.length===1&&['--version','version'].includes(args[0]))return console.log(cliVersion);
  let keyAction;if(args[0]==='keys'){args=[...args];keyAction=args.splice(1,1)[0];}
  const { command, options: o } = parseArgs([...args]);
  if (command === 'help' || o.help) return console.log(help);
  if(o.runtime&&!['tern','legacy'].includes(o.runtime))throw new Error('--runtime must be tern or legacy. New applications default to tern.');
  const project = resolve(o.project || '.');
  const yamlPath=join(project,'tern.yaml'),oldYamlPath=join(project,'shorebird.yaml');
  const yaml=existsSync(yamlPath)?readRuntimeYaml(readFileSync(yamlPath,'utf8')):existsSync(oldYamlPath)?readRuntimeYaml(readFileSync(oldYamlPath,'utf8')):{};
  if(command==='setup')return console.log(JSON.stringify(await (o.runtime==='legacy'||(!o.runtime&&yaml.app_id&&yaml.runtime!=='tern-native-v1')?setupRuntime():setupOfficialRuntime()),null,2));
  const configPath = resolve(project,'.tern.json');
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
  const server = canonicalServer(o.server || process.env.TERN_SERVER || config.server || yaml.base_url || readSettings().server || 'https://tern.hatchmoon.cv');
  const parsedServer = new URL(server);
  if (!['http:', 'https:'].includes(parsedServer.protocol) || parsedServer.username || parsedServer.password) throw new Error('Server must be an HTTP(S) URL without embedded credentials.');
  const defaultToken = existsSync(resolve('.tern-data/admin-token')) ? resolve('.tern-data/admin-token') : join(ternRoot,'.tern-data','admin-token');
  const tokenPath = resolve(o['token-file'] || defaultToken);
  if(command==='login')return browserLogin(server,{noBrowser:o['no-browser'],machine:o.machine});
  if(command==='keys'&&keyAction==='export')return console.log(JSON.stringify(await transferKey(keyAction,o,o.app||config.app_id||yaml.app_id,project),null,2));
  if(command==='upgrade'&&o.rollback){const {rollbackInstallation}=await import('./upgrade.mjs');return console.log(JSON.stringify(rollbackInstallation(),null,2));}
  if(o['token-file']&&!existsSync(tokenPath))throw new Error('Token file not found: '+tokenPath);
  const token = process.env.TERN_TOKEN || (o['token-file']&&existsSync(tokenPath)?readFileSync(tokenPath,'utf8').trim():'') || savedToken(server) || (existsSync(tokenPath)?readFileSync(tokenPath,'utf8').trim():'');
  const appId = o.app || config.app_id;
  const need = (name, value = o[name]) => {
    if (value == null || value === '') throw new Error(`Supply --${name}.`);
    return value;
  };
  async function request(path, payload, auth = true, method) {
    if (auth && !token) throw new Error('Run tern login, set TERN_TOKEN, or supply --token-file.');
    const response = await fetch(`${server}${path}`, {
      method: method || (payload ? 'POST' : 'GET'),
      headers: { ...(auth ? { Authorization: `Bearer ${token}` } : {}), ...(payload ? { 'Content-Type': 'application/json' } : {}) },
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(120_000), redirect: 'error',
    });
    const result = await response.json();
    if (!response.ok){const error=new Error(result.error || `Server returned ${response.status}.`);error.status=response.status;throw error;}
    return result;
  }
  const print = result => console.log(JSON.stringify(result, null, 2));
  if(command==='connect')return print(await connectProject({project,server,appId:o.app,request}));
  if(command==='logout')return print(await logout(server,request));
  if(command==='keys'){
    let expectedKey;
    if(keyAction==='import'){
      const snapshot=await request('/api/snapshot');
      const version=existsSync(join(project,'pubspec.yaml'))?readPubspecVersion(readFileSync(join(project,'pubspec.yaml'),'utf8'),join(project,'pubspec.yaml')):null;
      const release=snapshot.releases.find(r=>r.app_id===(appId||yaml.app_id)&&r.version===version&&r.platform==='android');expectedKey=release?.build_manifest?.runtime?.public_key;
    }
    return print(await transferKey(keyAction,o,appId||yaml.app_id,project,expectedKey));
  }
  if(command==='upgrade'){const {upgrade}=await import('./upgrade.mjs');return print(await upgrade({server,token,check:o.check}));}
  const legacyConfig=o.runtime==='legacy'||(!o.runtime&&existsSync(join(project,'tern.yaml'))&&!/^runtime:\s*tern-native-v1\s*$/m.test(readFileSync(join(project,'tern.yaml'),'utf8')));
  const runtimeConfig = id => `# Tern update configuration.\n${legacyConfig?'':'runtime: tern-native-v1\n'}app_id: ${id}\nbase_url: ${o['update-url'] || server}\nchannel: ${o.channel || 'stable'}\nauto_update: ${o['manual-updates'] ? 'false' : 'true'}\n`;
  if(command==='integrate') {
    if(o.runtime==='legacy')throw new Error('Use the original 0.1.0 package and release toolchain to maintain a legacy application.');
    const path=join(project,'tern.yaml');
    if(!existsSync(path))throw new Error('No tern.yaml found. Initialize a new application with tern init --configure-runtime.');
    const source=readFileSync(path,'utf8');
    const version=readPubspecVersion(readFileSync(join(project,'pubspec.yaml'),'utf8'),join(project,'pubspec.yaml'));
    if(!/^runtime:\s*tern-native-v1\s*$/m.test(source)&&existsSync(join(project,'.tern-build','release',version,'app-release.apk')))throw new Error('Increase the app version/build before migrating to a new runtime baseline.');
    integrateNativeProject(project,{dryRun:true});ensureRuntimeAsset(project,{dryRun:true});
    integrateNativeProject(project);ensureRuntimeAsset(project);
    writeFileSync(path,/^runtime:/m.test(source)?source.replace(/^runtime:.*$/m,'runtime: tern-native-v1'):'runtime: tern-native-v1\n'+source);
    if(!existsSync(join(project,'tern-runtime.json')))writeFileSync(join(project,'tern-runtime.json'),'{}\n',{flag:'wx'});
    return print({runtime:'tern-native-v1',project,new_baseline_required:true,next:'Use tern_updater 0.2.0 or later (added to pubspec.yaml if missing), add TernUpdateScope/banner, then run tern release for a new app version/build.'});
  }
  if (command === 'doctor') {
    const result=await diagnose({server,project,yaml,request,serverOnly:o['server-only']});print(result);
    if(!result.authenticated||(o.build&&!result.ready))process.exitCode=1;return;
  }
  if (command === 'init') {
    if (existsSync(configPath)) throw new Error('.tern.json already exists. Use --app to target another app.');
    if (o['configure-runtime'] && (existsSync(join(project,'tern.yaml'))||existsSync(join(project,'shorebird.yaml')))) throw new Error('Runtime configuration already exists. Use tern config and merge the values into tern.yaml manually.');
    if (o['configure-runtime']) ensureRuntimeAsset(project,{dryRun:true});
    if (o['configure-runtime']&&o.runtime!=='legacy')integrateNativeProject(project,{dryRun:true});
    const app = await request('/api/apps', { name: need('name') });
    writeFileSync(configPath, JSON.stringify({ server, app_id: app.id }, null, 2) + '\n', { flag: 'wx' });
    if (o['configure-runtime']) {
      if(o.runtime!=='legacy')integrateNativeProject(project);
      writeFileSync(join(project,'tern.yaml'), runtimeConfig(app.id), { flag: 'wx' });
      ensureRuntimeAsset(project);
      if(o.runtime!=='legacy')writeFileSync(join(project,'tern-runtime.json'),'{}\n',{flag:'wx'});
    }
    print(app);
    if (!o.json) console.log('\nCreated .tern.json. Next: upload the compiled release with the release command.');
    return;
  }
  if (command === 'config') return console.log(runtimeConfig(need('app', appId)));
  if (command === 'apps') {
    const data = await request('/api/snapshot');
    return print(data.apps.map(app => ({ ...app, releases: data.releases.filter(r => r.app_id === app.id).map(r => ({ id: r.id, version: r.version, platform: r.platform, engine_version: r.engine_version })) })));
  }
  if (command === 'release' || command === 'patch') {
    need('app', appId);
    if (!o.artifact.length && (o.project || existsSync(join(project,'pubspec.yaml')))) {
      const projectVersion=readPubspecVersion(readFileSync(join(project,'pubspec.yaml'),'utf8'),join(project,'pubspec.yaml'));
      const snapshot=await request('/api/snapshot');
      const baseline=command==='patch' ? snapshot.releases.find(r=>r.app_id===appId&&r.platform==='android'&&r.version===(o.version||projectVersion)) : null;
      if(command==='patch'&&!baseline)throw new Error('No Android release found for this application. Build a release first.');
      const archs=o.arch ? o.arch.split(',') : baseline ? baseline.artifacts.map(a=>a.arch) : ['aarch64','arm','x86_64'];
      const independent=existsSync(join(project,'tern.yaml'))&&/^runtime:\s*tern-native-v1\s*$/m.test(readFileSync(join(project,'tern.yaml'),'utf8'));
      if(baseline&&independent!==(baseline.build_manifest?.runtime?.id==='tern-native-v1'))throw new Error('Changing runtimes requires a new baseline release and app version. Existing releases must use their original runtime.');
      const built=await (independent?buildNativeAndroid:buildAndroid)({project,archs,defines:o['dart-define'],target:o.target||baseline?.build_manifest?.target||'lib/main.dart',mode:command,resume:!!o.resume});
      if(built.app_id!==appId)throw new Error('The APK app ID differs from .tern.json. Fix tern.yaml before uploading.');
      if(command==='release') {
        const result=await request('/api/releases',{app_id:appId,version:built.version,platform:'android',engine_version:built.engine_version,artifacts:built.artifacts,build_manifest:built.build_manifest});
        return print({...result,apk:built.apk});
      }
      if(built.version!==baseline.version)throw new Error(`Patch version ${built.version} differs from release ${baseline.version}. Keep the original version to patch it.`);
      const result=await request('/api/patches',{release_id:baseline.id,engine_version:built.engine_version,artifacts:built.artifacts,build_manifest:built.build_manifest,notes:o.notes||undefined});
      return print({...result,compiled_apk:built.apk,install_apk:false});
    }
    need('version'); need('platform'); need('engine');
    if (!o.artifact.length) throw new Error('Supply --artifact arch=path for every architecture in the release.');
    const artifacts = o.artifact.map(input => {
      const separator = input.indexOf('=');
      if (separator < 1) throw new Error('Artifact syntax: --artifact aarch64=path/to/libapp.so');
      return { arch: input.slice(0, separator), data: readFileSync(resolve(input.slice(separator + 1))).toString('base64') };
    });
    if (command === 'release') return print(await request('/api/releases', {
      app_id: appId, version: o.version, platform: o.platform, engine_version: o.engine, artifacts,
    }));
    const data = await request('/api/snapshot');
    const release = data.releases.find(r => r.app_id === appId && r.version === o.version && r.platform === o.platform);
    if (!release) throw new Error('Release not found. Upload a release with the exact version and platform first.');
    return print(await request('/api/patches', { release_id: release.id, engine_version: o.engine, notes: o.notes || undefined, artifacts }));
  }
  if (command === 'deploy') return print(await request(`/api/patches/${encodeURIComponent(need('patch'))}/deploy`, {
    channel: need('channel'), rollout: o.rollout == null ? 100 : Number(o.rollout),
  }));
  if (command === 'rollback') return print(await request(`/api/patches/${encodeURIComponent(need('patch'))}/rollback`, {}));
  if (command === 'check' || command === 'simulate') {
    const payload = { app_id: need('app', appId), release_version: need('version'), platform: need('platform'),
      arch: o.arch || 'aarch64', channel: o.channel || 'stable', client_id: o.client || randomUUID(), current_patch_number: Number(o.current || 0) };
    const result = await request('/api/v1/patches/check', payload, false);
    if (command === 'check' || !result.patch_available) return print(result);
    const output = resolve(need('output'));
    if (existsSync(output)) throw new Error('Output already exists. Choose a new path to protect existing files.');
    const base = readFileSync(resolve(need('base')));
    const binary = await fetch(result.patch.download_url, { signal: AbortSignal.timeout(120_000), redirect: 'error' });
    if (!binary.ok) throw new Error(`Download failed: HTTP ${binary.status}.`);
    const compressed = Buffer.from(await binary.arrayBuffer());
    const report = type => request('/api/v1/patches/events', { event: { ...payload, patch_number: result.patch.number, type, timestamp: Math.floor(Date.now() / 1000) } }, false);
    await report('__patch_download__');
    try {
      const target = applyPatch(base, compressed);
      if (sha256(target) !== result.patch.hash) throw new Error('SHA-256 mismatch. The original release binary may be incorrect.');
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, target, { flag: 'wx' });
      await report('__patch_install__');
      // Follow-up check reports the now-running simulated patch for fleet metrics.
      await request('/api/v1/patches/check', { ...payload, current_patch_number: result.patch.number }, false);
      return print({ verified: true, patch_number: result.patch.number, sha256: sha256(target), downloaded_bytes: compressed.length,
        reconstructed_bytes: target.length, output, client_id: payload.client_id, simulated: true });
    } catch (error) { await report('__patch_install_failure__').catch(() => {}); throw error; }
  }
  throw new Error(`Unknown command: ${command}. Run with --help.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  run().catch(error => { console.error(`Tern: ${error.message}`); process.exitCode = 1; });
}
