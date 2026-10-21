import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { sha256 } from '../lib/patch.mjs';

export class Store {
  constructor(directory) {
    this.directory = directory;
    this.blobs = join(directory, 'artifacts');
    mkdirSync(this.blobs, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, 'tern.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS apps (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS releases (
        id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES apps(id),
        version TEXT NOT NULL, platform TEXT NOT NULL, engine_version TEXT NOT NULL,
        created_at TEXT NOT NULL, UNIQUE(app_id, version, platform)
      );
      CREATE TABLE IF NOT EXISTS release_artifacts (
        release_id TEXT NOT NULL REFERENCES releases(id), arch TEXT NOT NULL,
        hash TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY(release_id, arch)
      );
      CREATE TABLE IF NOT EXISTS release_manifests (
        release_id TEXT PRIMARY KEY REFERENCES releases(id), manifest TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS patches (
        id TEXT PRIMARY KEY, release_id TEXT NOT NULL REFERENCES releases(id),
        number INTEGER NOT NULL, notes TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL, UNIQUE(release_id, number)
      );
      CREATE TABLE IF NOT EXISTS patch_artifacts (
        patch_id TEXT NOT NULL REFERENCES patches(id), arch TEXT NOT NULL,
        blob_hash TEXT NOT NULL, target_hash TEXT NOT NULL, target_size INTEGER NOT NULL,
        size INTEGER NOT NULL, hash_signature TEXT, PRIMARY KEY(patch_id, arch)
      );
      CREATE TABLE IF NOT EXISTS deployments (
        release_id TEXT NOT NULL REFERENCES releases(id), channel TEXT NOT NULL,
        patch_id TEXT NOT NULL REFERENCES patches(id), rollout INTEGER NOT NULL,
        updated_at TEXT NOT NULL, PRIMARY KEY(release_id, channel)
      );
      CREATE TABLE IF NOT EXISTS devices (
        app_id TEXT NOT NULL REFERENCES apps(id), client_hash TEXT NOT NULL,
        release_id TEXT NOT NULL REFERENCES releases(id), arch TEXT NOT NULL,
        channel TEXT NOT NULL, current_patch INTEGER NOT NULL DEFAULT 0,
        last_seen TEXT NOT NULL, PRIMARY KEY(app_id, client_hash, release_id, arch)
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES apps(id),
        patch_id TEXT REFERENCES patches(id), kind TEXT NOT NULL,
        client_hash TEXT, arch TEXT, message TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS dedupe_device_events
        ON events(patch_id, kind, client_hash, arch) WHERE client_hash IS NOT NULL;
      CREATE INDEX IF NOT EXISTS recent_events ON events(created_at);
      CREATE TABLE IF NOT EXISTS administrator (
        id INTEGER PRIMARY KEY CHECK(id=1), email TEXT NOT NULL,
        password_hash TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS administrator_setup (
        id INTEGER PRIMARY KEY CHECK(id=1), email TEXT NOT NULL,
        token_hash TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
    `);
    const keyPath = join(directory, 'admin-token');
    if (!process.env.TERN_ADMIN_TOKEN && !existsSync(keyPath)) {
      writeFileSync(keyPath, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    }
    this.token = process.env.TERN_ADMIN_TOKEN || readFileSync(keyPath, 'utf8').trim();
    if (this.token.length < 32) throw new Error('TERN_ADMIN_TOKEN must contain at least 32 characters.');
    this.privacySalt = this.token;
  }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  get(sql, ...args) { return this.db.prepare(sql).get(...args); }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  put(bytes) {
    const hash = sha256(bytes);
    const path = join(this.blobs, hash);
    if (!existsSync(path)) {
      const temporary = `${path}.${randomUUID()}.tmp`;
      writeFileSync(temporary, bytes, { mode: 0o600 });
      renameSync(temporary, path);
    }
    return hash;
  }
  read(hash) { return readFileSync(join(this.blobs, hash)); }
  deleteApplication(appId) {
    const hashes=this.all(`SELECT a.hash FROM release_artifacts a JOIN releases r ON r.id=a.release_id WHERE r.app_id=?
      UNION SELECT a.blob_hash AS hash FROM patch_artifacts a JOIN patches p ON p.id=a.patch_id
      JOIN releases r ON r.id=p.release_id WHERE r.app_id=?`,appId,appId).map(row=>row.hash);
    this.transaction(()=>{
      this.run('DELETE FROM deployments WHERE release_id IN (SELECT id FROM releases WHERE app_id=?)',appId);
      this.run('DELETE FROM events WHERE app_id=?',appId);
      this.run('DELETE FROM devices WHERE app_id=?',appId);
      this.run('DELETE FROM patch_artifacts WHERE patch_id IN (SELECT p.id FROM patches p JOIN releases r ON r.id=p.release_id WHERE r.app_id=?)',appId);
      this.run('DELETE FROM patches WHERE release_id IN (SELECT id FROM releases WHERE app_id=?)',appId);
      this.run('DELETE FROM release_manifests WHERE release_id IN (SELECT id FROM releases WHERE app_id=?)',appId);
      this.run('DELETE FROM release_artifacts WHERE release_id IN (SELECT id FROM releases WHERE app_id=?)',appId);
      this.run('DELETE FROM releases WHERE app_id=?',appId);
      this.run('DELETE FROM apps WHERE id=?',appId);
    });
    let removed=0,pending=0;
    for(const hash of hashes) {
      if(this.get('SELECT 1 FROM release_artifacts WHERE hash=? UNION SELECT 1 FROM patch_artifacts WHERE blob_hash=?',hash,hash))continue;
      try { unlinkSync(join(this.blobs,hash));removed++; }
      catch(error) { if(error.code!=='ENOENT'){pending++;console.error('Artifact cleanup failed:',error.message);} }
    }
    return {deleted:true,app_id:appId,removed_artifacts:removed,artifact_cleanup_pending:pending};
  }
  event(appId, kind, message, patchId = null) {
    this.run('INSERT INTO events(id,app_id,patch_id,kind,message,created_at) VALUES(?,?,?,?,?,?)',
      randomUUID(), appId, patchId, kind, message, new Date().toISOString());
  }
  snapshot() {
    const apps = this.all('SELECT * FROM apps ORDER BY created_at DESC');
    const releases = this.all('SELECT * FROM releases ORDER BY created_at DESC');
    const releaseArtifacts = this.all('SELECT * FROM release_artifacts');
    const manifests = this.all('SELECT * FROM release_manifests');
    const patches = this.all('SELECT * FROM patches ORDER BY created_at DESC, number DESC');
    const patchArtifacts = this.all('SELECT * FROM patch_artifacts');
    const deployments = this.all('SELECT * FROM deployments');
    const devices = this.all(`SELECT app_id, release_id, arch, channel, current_patch, COUNT(*) AS count
      FROM devices WHERE last_seen > ? GROUP BY app_id, release_id, arch, channel, current_patch`,
      new Date(Date.now() - 30 * 86400000).toISOString());
    const telemetry = this.all(`SELECT patch_id, kind, COUNT(*) AS count FROM events
      WHERE client_hash IS NOT NULL GROUP BY patch_id, kind`);
    const activity = this.all(`SELECT e.id,e.app_id,e.patch_id,e.kind,e.message,e.created_at,
      a.name AS app_name,p.number AS patch_number FROM events e JOIN apps a ON a.id=e.app_id
      LEFT JOIN patches p ON p.id=e.patch_id ORDER BY e.created_at DESC, e.rowid DESC LIMIT 50`);
    return { apps, releases: releases.map(r => ({ ...r, artifacts: releaseArtifacts.filter(a => a.release_id === r.id), build_manifest: manifests.find(m => m.release_id === r.id) ? JSON.parse(manifests.find(m => m.release_id === r.id).manifest) : null })),
      patches: patches.map(p => ({ ...p, artifacts: patchArtifacts.filter(a => a.patch_id === p.id),
        telemetry: telemetry.filter(t => t.patch_id === p.id) })), deployments, devices, activity,
      server_time: new Date().toISOString() };
  }
  close() { this.db.close(); }
}
