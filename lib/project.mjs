import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sha256 } from './patch.mjs';

export function runtimeAssetSource(source, filename = 'tern.yaml') {
  const lines = source.split(/\r?\n/);
  const flutter = lines.findIndex(line => /^flutter:\s*(?:#.*)?$/.test(line));
  if (flutter < 0) throw new Error('Add a top-level flutter: section to pubspec.yaml before configuring runtime assets.');
  let end = lines.findIndex((line, index) => index > flutter && /^[^\s#][^:]*:/.test(line));
  if (end < 0) end = lines.length;
  const assets = lines.findIndex((line, index) => index > flutter && index < end && /^  assets:\s*(?:#.*)?$/.test(line));
  if (assets >= 0) {
    let assetEnd = lines.findIndex((line, index) => index > assets && index < end && /^  \S/.test(line));
    if (assetEnd < 0) assetEnd = end;
    let found = false;
    const entries = lines.slice(assets + 1, assetEnd).flatMap(line => {
      const match = line.match(/^(\s{4}-\s*)(?:['"]?)(?:shorebird|tern)\.yaml(?:['"]?)(\s*(?:#.*)?)$/);
      if (!match) return [line];
      if (found) return [];
      found = true;
      return [match[1] + filename + match[2]];
    });
    if (!found) entries.unshift('    - ' + filename);
    lines.splice(assets + 1, assetEnd - assets - 1, ...entries);
  } else {
    if (lines.slice(flutter + 1, end).some(line => /^\s*assets:/.test(line))) throw new Error('pubspec.yaml uses an inline or unusual assets block. Add tern.yaml to that list manually.');
    lines.splice(flutter + 1, 0, '  assets:', '    - ' + filename);
  }
  return lines.join(source.includes('\r\n') ? '\r\n' : '\n');
}

export function ensureRuntimeAsset(project, { dryRun = false } = {}) {
  const path = join(project, 'pubspec.yaml');
  if (!existsSync(path)) throw new Error('Runtime configuration needs a Flutter project with pubspec.yaml.');
  const source = readFileSync(path, 'utf8');
  const output = runtimeAssetSource(source);
  if (!dryRun && output !== source) writeFileSync(path, output);
}

export function migrateRuntimeConfig(project) {
  const path = join(project, 'tern.yaml');
  const legacy = join(project, 'shorebird.yaml');
  if (!existsSync(path) && existsSync(legacy)) {
    ensureRuntimeAsset(project, { dryRun: true });
    renameSync(legacy, path);
    ensureRuntimeAsset(project);
    return true;
  }
  return false;
}

export function readPubspecVersion(source, path = 'pubspec.yaml') {
  const line = source.replace(/^\uFEFF/, '').match(/^version:[ \t]*(.*)$/m)?.[1]?.trim();
  const value = line?.match(/^(?:"([^"]+)"|'([^']+)'|([^\s#]+))\s*(?:#.*)?$/);
  const version = value?.[1] || value?.[2] || value?.[3];
  if (!version || !/^\d+\.\d+\.\d+\+\d+$/.test(version)) {
    throw new Error(path + ' needs a version with a build number, for example version: 1.0.0+1' + (line ? '. Found: ' + line : '. No top-level version: field was found.'));
  }
  return version;
}

// The pinned native engine reads shorebird.yaml. Only the build temporarily
// packages that name; the project's public configuration stays tern.yaml.
export async function withRuntimeAssetBridge(project, build) {
  project = resolve(project);
  const pubspec = join(project, 'pubspec.yaml');
  const config = join(project, 'tern.yaml');
  const legacy = join(project, 'shorebird.yaml');
  const statePath = join(project, '.tern-build', 'runtime-bridge.json');
  function restore(state) {
    if (state.project !== project || typeof state.original !== 'string' || typeof state.prepared !== 'string') throw new Error('Invalid saved runtime build state. Review ' + statePath);
    if (state.generatedLegacy && existsSync(legacy) && sha256(readFileSync(legacy)) !== state.configHash) throw new Error('The generated runtime asset was edited. Review shorebird.yaml before retrying.');
    const current = readFileSync(pubspec, 'utf8');
    writeFileSync(pubspec, current === state.prepared ? state.original : runtimeAssetSource(current));
    if (state.generatedLegacy && existsSync(legacy)) unlinkSync(legacy);
    unlinkSync(statePath);
  }
  mkdirSync(join(project, '.tern-build'), { recursive: true });
  if (existsSync(statePath)) {
    const previous = JSON.parse(readFileSync(statePath, 'utf8'));
    let running = true;
    try { process.kill(previous.pid, 0); } catch (error) { if (error.code === 'ESRCH') running = false; }
    if (running) throw new Error('Another Tern build is using this project. Wait for it to finish.');
    restore(previous);
  }
  migrateRuntimeConfig(project);
  if (!existsSync(config)) throw new Error('Create tern.yaml with: tern init --name "My app" --configure-runtime');
  ensureRuntimeAsset(project);
  const content = readFileSync(config);
  if (existsSync(legacy) && !readFileSync(legacy).equals(content)) throw new Error('tern.yaml and shorebird.yaml differ. Merge the configuration into tern.yaml and remove the legacy file before building.');
  const original = readFileSync(pubspec, 'utf8');
  const state = { project, pid: process.pid, original, prepared: runtimeAssetSource(original, 'shorebird.yaml'), generatedLegacy: !existsSync(legacy), configHash: sha256(content) };
  writeFileSync(statePath, JSON.stringify(state), { flag: 'wx' });
  try {
    if (state.generatedLegacy) writeFileSync(legacy, content, { flag: 'wx' });
    writeFileSync(pubspec, state.prepared);
    return await build();
  } finally { restore(state); }
}
