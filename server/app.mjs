import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync,existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { Store } from './store.mjs';
import { getAdministrator, getAccountSetup, normalizeEmail, validatePassword, hashPassword, verifyPassword, saveAdministrator } from './accounts.mjs';
import { makePatch, applyPatch, sha256, MAX_ARTIFACT } from '../lib/patch.mjs';
import { validateBuildManifest, assertPatchCompatible } from '../lib/android.mjs';
import { verifyNativePatch } from '../lib/native-runtime.mjs';
import {initializeCliAuth,cliCredential,startAuthorization,authorization,decideAuthorization,redeemAuthorization} from './cli-auth.mjs';
import {verifyRelease} from '../cli/upgrade.mjs';

const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
const platforms = ['android', 'ios', 'macos', 'windows', 'linux'];
const architectures = ['aarch64', 'arm', 'x86', 'x86_64'];
const channels = ['stable', 'beta', 'staging'];
const eventTypes = ['__patch_install__', '__patch_install_failure__', '__patch_download__', '__patch_update_failure__'];
const now = () => new Date().toISOString();
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };
function textField(value, name, max = 200, multiline = false) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || (multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f]/ : /[\x00-\x1f]/).test(value)) fail(400, `Invalid ${name}.`);
  return value.trim();
}
function choice(value, values, name) {
  if (!values.includes(value)) fail(400, `${name} must be one of: ${values.join(', ')}.`);
  return value;
}
function integer(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(400, `Invalid ${name}.`);
  return value;
}
function decode(value) {
  // Avoid nested, repeated regex groups: V8 can exhaust its regexp stack on
  // real multi-megabyte native binaries even when the input is valid.
  if (typeof value !== 'string' || value.length % 4 || value.length > Math.ceil(MAX_ARTIFACT / 3) * 4 || /[^A-Za-z0-9+/=]/.test(value)) fail(400, 'Artifact must be valid base64.');
  const bytes = Buffer.from(value, 'base64');
  if(bytes.toString('base64')!==value)fail(400,'Artifact must be valid canonical base64.');
  if (!bytes.length || bytes.length > MAX_ARTIFACT) fail(400, 'Artifacts must contain between 1 byte and 64 MiB.');
  return bytes;
}
async function body(request, limit = 128 * 1024) {
  if (!request.headers['content-type']?.startsWith('application/json')) fail(415, 'Use application/json.');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) fail(413, 'Request exceeds the upload limit.');
    chunks.push(chunk);
  }
  try {
    const result = JSON.parse(Buffer.concat(chunks).toString());
    if (!result || Array.isArray(result) || typeof result !== 'object') fail(400, 'Expected a JSON object.');
    return result;
  } catch (error) { if (error.status) throw error; fail(400, 'Invalid JSON.'); }
}
function equal(a, b) { return timingSafeEqual(Buffer.from(sha256(a)), Buffer.from(sha256(b))); }

export function createApp({ dataDir, publicUrl, secureCookies = false, trustProxy = false } = {}) {
  const store = new Store(dataDir);
  initializeCliAuth(store);
  const sessions = new Map();
  const attempts = new Map();
  const rates = new Map();
  let passwordChecks = 0;
  let address;
  const clientAddress = request => {
    const forwarded = request.headers['x-forwarded-for']?.split(',')[0]?.trim();
    return trustProxy && isIP(forwarded || '') ? forwarded : request.socket.remoteAddress;
  };
  async function passwordWork(work) {
    if (passwordChecks >= 2) fail(429, 'Sign-in is busy. Try again in a moment.');
    passwordChecks++;
    try { return await work(); } finally { passwordChecks--; }
  }
  function issueSession(response) {
    for (const [key, value] of sessions) if (value.expiresAt < Date.now()) sessions.delete(key);
    if (sessions.size >= 1000) sessions.delete(sessions.keys().next().value);
    const session = randomBytes(32).toString('hex');
    sessions.set(session, { expiresAt: Date.now() + 12 * 3600_000, version: getAdministrator(store)?.password_hash || null });
    response.setHeader('Set-Cookie', `tern_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secureCookies ? '; Secure' : ''}`);
  }
  function json(response, status, value) {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(value));
  }
  function authenticated(request) {
    const bearer = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (bearer && equal(bearer, store.token)) return true;
    if (bearer && cliCredential(store,bearer)) return true;
    const id = request.headers.cookie?.match(/(?:^|;\s*)tern_session=([a-f0-9]{64})(?:;|$)/)?.[1];
    const session = sessions.get(id);
    if (session && session.expiresAt > Date.now() && session.version === (getAdministrator(store)?.password_hash || null)) return true;
    if (id) sessions.delete(id);
    return false;
  }
  function requireAdmin(request) { if (!authenticated(request)) fail(401, 'Sign in to your Tern account.'); }
  function lookup(table, id) {
    const row = store.get(`SELECT * FROM ${table} WHERE id=?`, id);
    if (!row) fail(404, `${table.slice(0, -1)} not found.`);
    return row;
  }
  function artifactList(list) {
    if (!Array.isArray(list) || !list.length || list.length > 4) fail(400, 'Supply between 1 and 4 architecture artifacts.');
    const seen = new Set();
    let total = 0;
    return list.map(a => {
      if (!a || typeof a !== 'object') fail(400, 'Invalid artifact.');
      const arch = choice(a.arch, architectures, 'arch');
      if (seen.has(arch)) fail(400, 'Duplicate architecture.');
      seen.add(arch);
      const bytes = decode(a.data);
      total += bytes.length;
      if (total > MAX_ARTIFACT) fail(413, 'Combined artifacts exceed 64 MiB.');
      return { ...a, arch, bytes };
    });
  }
  function checkOrigin(request) {
    const origin = request.headers.origin;
    if (!origin) return;
    const allowed = new Set([address, publicUrl].filter(Boolean).map(u => new URL(u).origin));
    if (!allowed.has(origin)) fail(403, 'Cross-origin requests are not allowed.');
  }
  function rateLimit(request, route, maximum) {
    const key = `${clientAddress(request)}:${route}`;
    const time = Date.now();
    let rate = rates.get(key);
    if (!rate || rate.reset < time) {
      if (rates.size >= 10_000) rates.delete(rates.keys().next().value);
      rate = { count: 0, reset: time + 60_000 }; rates.set(key, rate);
    }
    if (++rate.count > maximum) fail(429, 'Too many requests. Try again in one minute.');
    if (rates.size > 10_000) for (const [k, v] of rates) if (v.reset < time) rates.delete(k);
  }
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(request.url, 'http://localhost');
      const path = url.pathname;
      const method = request.method;
      checkOrigin(request);
      if(path==='/api/cli/authorize'&&method==='POST'){
        rateLimit(request,'cli-start',10);
        try{return json(response,201,startAuthorization(store,await body(request)));}catch(error){fail(400,error.message);}
      }
      if(path==='/api/cli/token'&&method==='POST'){
        rateLimit(request,'cli-poll',90);const b=await body(request);
        try{return json(response,200,redeemAuthorization(store,b.id,b.verifier));}catch(error){fail(401,error.message);}
      }
      if(path==='/api/cli/approval'&&['GET','POST'].includes(method)){
        // Only an interactive browser session may approve a machine.
        if(request.headers.authorization)fail(403,'Approve this request in your browser.');
        requireAdmin(request);
        const b=method==='POST'?await body(request):{id:url.searchParams.get('id')};
        const item=authorization(store,b.id);if(!item)fail(404,'This sign-in request expired. Run tern login again.');
        if(method==='GET')return json(response,200,{id:item.id,machine:item.machine,code:item.code,status:item.status,expires_at:item.expires_at});
        if(typeof b.approve!=='boolean')fail(400,'Choose approve or decline.');
        try{decideAuthorization(store,b.id,b.approve,b.code);}catch(error){fail(409,error.message);}
        return json(response,200,{approved:b.approve});
      }
      if (method === 'GET' && path === '/health') return json(response, 200, { status: 'ok', version: '0.1.0' });
      if (method === 'GET' && path === '/api/auth/status') return json(response, 200, { password_sign_in: !!getAdministrator(store) });
      if (method === 'GET' && ['/','/app.js','/style.css','/logo.svg'].includes(path)) {
        const filename = path === '/' ? 'index.html' : path.slice(1);
        const types = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml' };
        response.writeHead(200, { 'Content-Type': types[filename.split('.').pop()], 'Cache-Control': 'no-cache' });
        return response.end(readFileSync(join(webRoot, filename)));
      }
      if (path === '/api/session' && method === 'POST') {
        rateLimit(request, 'login', 30);
        const ip = clientAddress(request);
        const attempt = attempts.get(ip);
        if (attempt?.until > Date.now()) fail(429, 'Too many sign-in attempts. Wait one minute.');
        const payload = await body(request);
        const account = getAdministrator(store);
        let valid;
        if (account) {
          let email;
          try { email = normalizeEmail(payload.email); } catch { email = ''; }
          const passwordValid = await passwordWork(() => verifyPassword(payload.password, account.password_hash));
          valid = email === account.email && passwordValid;
          // A password reset may have completed while scrypt was running.
          valid = valid && getAdministrator(store)?.password_hash === account.password_hash;
        } else {
          valid = typeof payload.token === 'string' && equal(payload.token, store.token);
        }
        if (!valid) {
          if (attempts.size >= 10_000) attempts.delete(attempts.keys().next().value);
          const count = (attempt?.count || 0) + 1;
          attempts.set(ip, { count, until: count >= 5 ? Date.now() + 60_000 : 0 });
          fail(401, account ? 'Email or password is incorrect.' : 'Finish administrator setup using your private setup link.');
        }
        attempts.delete(ip);
        issueSession(response);
        return json(response, 200, { authenticated: true, email: account?.email || null });
      }
      if (path === '/api/auth/setup/status' && method === 'POST') {
        rateLimit(request,'setup-status',60);
        const payload = await body(request);
        const setup = getAccountSetup(store,payload.token);
        if (!setup) fail(401,'This setup link is invalid or has expired. Ask the server administrator for a new link.');
        return json(response,200,{email:setup.email,expires_at:setup.expires_at});
      }
      if (path === '/api/auth/setup' && method === 'POST') {
        rateLimit(request,'account-setup',10);
        const payload = await body(request);
        const setup = getAccountSetup(store,payload.token);
        if (!setup) fail(401,'This setup link is invalid or has expired. Ask the server administrator for a new link.');
        try { validatePassword(payload.password); } catch(error) { fail(400,error.message); }
        const passwordHash = await passwordWork(() => hashPassword(payload.password));
        store.transaction(() => {
          if (!getAccountSetup(store,payload.token)) fail(409,'This setup link has already been used or has expired.');
          saveAdministrator(store,setup.email,passwordHash);
          store.run('DELETE FROM administrator_setup WHERE id=1');
        });
        sessions.clear(); attempts.clear(); issueSession(response);
        return json(response,200,{authenticated:true,email:setup.email});
      }
      if (path === '/api/session' && method === 'DELETE') {
        const session = request.headers.cookie?.match(/tern_session=([a-f0-9]{64})/)?.[1];
        sessions.delete(session);
        response.setHeader('Set-Cookie', `tern_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookies ? '; Secure' : ''}`);
        return json(response, 200, { authenticated: false });
      }
      if (path === '/api/v1/patches/check' && method === 'POST') {
        rateLimit(request, 'check', 1200);
        const b = await body(request);
        const appId = textField(b.app_id, 'app_id');
        const version = textField(b.release_version, 'release_version');
        const platform = choice(b.platform, platforms, 'platform');
        const arch = choice(b.arch, architectures, 'arch');
        const channel = choice(b.channel ?? 'stable', channels, 'channel');
        const current = integer(b.current_patch_number ?? b.patch_number ?? 0, 'current_patch_number');
        const clientId = b.client_id ? textField(b.client_id, 'client_id', 128) : null;
        const release = store.get('SELECT * FROM releases WHERE app_id=? AND version=? AND platform=?', appId, version, platform);
        const runtimeManifest=release&&store.get('SELECT manifest FROM release_manifests WHERE release_id=?',release.id);
        const runtime=runtimeManifest&&JSON.parse(runtimeManifest.manifest).runtime;
        const result = { patch_available: false, patch: null, rolled_back_patch_numbers: [] };
        if (!release || !store.get('SELECT 1 FROM release_artifacts WHERE release_id=? AND arch=?', release.id, arch)) return json(response, 200, result);
        if((runtime?.id==='tern-native-v1')!==(b.runtime==='tern-native-v1'))return json(response,200,result);
        if (clientId) {
          const clientHash = sha256(`${store.privacySalt}:${appId}:${clientId}`);
          store.run(`INSERT INTO devices(app_id,client_hash,release_id,arch,channel,current_patch,last_seen)
            VALUES(?,?,?,?,?,?,?) ON CONFLICT(app_id,client_hash,release_id,arch) DO UPDATE SET
            channel=excluded.channel,current_patch=excluded.current_patch,last_seen=excluded.last_seen`,
            appId, clientHash, release.id, arch, channel, current, now());
        }
        result.rolled_back_patch_numbers = store.all("SELECT number FROM patches WHERE release_id=? AND status='revoked' ORDER BY number", release.id).map(p => p.number);
        const deployment = store.get(`SELECT d.rollout,p.id,p.number,p.status,a.blob_hash,a.target_hash,a.hash_signature
          FROM deployments d JOIN patches p ON p.id=d.patch_id JOIN patch_artifacts a ON a.patch_id=p.id
          WHERE d.release_id=? AND d.channel=? AND a.arch=?`, release.id, channel, arch);
        if (deployment && deployment.status === 'active' && deployment.number > current) {
          const bucket = clientId ? parseInt(sha256(`${appId}:${release.id}:${channel}:${clientId}`).slice(0, 8), 16) % 10000 : 10000;
          if (deployment.rollout === 100 || bucket < deployment.rollout * 100) {
            result.patch_available = true;
            result.patch = { number: deployment.number, hash: deployment.target_hash,
              download_url: `${publicUrl || address}/artifacts/${deployment.blob_hash}`,
              hash_signature: deployment.hash_signature || null };
            if(runtime?.id==='tern-native-v1')Object.assign(result.patch,{format:'tern-full-v1',engine_revision:release.engine_version,download_url:`${publicUrl||address}/artifacts/native/${deployment.id}/${arch}/${deployment.target_hash}`});
          }
        }
        return json(response, 200, result);
      }
      if (path === '/api/v1/patches/events' && method === 'POST') {
        rateLimit(request, 'events', 1200);
        const payload = await body(request);
        const event = payload.event;
        if (!event || typeof event !== 'object') fail(400, 'Expected an event object.');
        const appId = textField(event.app_id, 'app_id');
        const platform = choice(event.platform, platforms, 'platform');
        const arch = choice(event.arch, architectures, 'arch');
        const version = textField(event.release_version, 'release_version');
        const number = integer(event.patch_number, 'patch_number', 1);
        const kind = choice(event.type, eventTypes, 'event.type');
        const client = textField(event.client_id, 'client_id', 128);
        const patch = store.get(`SELECT p.id,p.release_id FROM patches p JOIN releases r ON r.id=p.release_id
          JOIN patch_artifacts a ON a.patch_id=p.id WHERE r.app_id=? AND r.version=? AND r.platform=? AND p.number=? AND a.arch=?`, appId, version, platform, number, arch);
        if (!patch) fail(404, 'Patch not found for this release and architecture.');
        const clientHash = sha256(`${store.privacySalt}:${appId}:${client}`);
        store.run(`INSERT OR IGNORE INTO events(id,app_id,patch_id,kind,client_hash,arch,message,created_at) VALUES(?,?,?,?,?,?,?,?)`,
          randomUUID(), appId, patch.id, kind, clientHash, arch, typeof event.message === 'string' ? event.message.slice(0, 500) : '', now());
        // Fleet adoption comes from checks, not duplicate or delayed install events.
        return json(response, 201, { accepted: true });
      }
      const nativeDownload=path.match(/^\/artifacts\/native\/([a-zA-Z0-9-]+)\/(aarch64|arm|x86_64)\/([a-f0-9]{64})$/);
      if(nativeDownload&&['GET','HEAD'].includes(method)) {
        const artifact=store.get(`SELECT a.*,b.hash AS base_hash,m.manifest FROM patch_artifacts a JOIN patches p ON p.id=a.patch_id JOIN release_artifacts b ON b.release_id=p.release_id AND b.arch=a.arch JOIN release_manifests m ON m.release_id=p.release_id WHERE a.patch_id=? AND a.arch=? AND a.target_hash=?`,nativeDownload[1],nativeDownload[2],nativeDownload[3]);
        if(!artifact||JSON.parse(artifact.manifest).runtime?.id!=='tern-native-v1')fail(404,'Artifact not found.');
        const bytes=applyPatch(store.read(artifact.base_hash),store.read(artifact.blob_hash));
        if(sha256(bytes)!==artifact.target_hash)fail(500,'Stored patch hash differs.');
        return sendBinary(request,response,bytes,artifact.target_hash);
      }
      const download = path.match(/^\/artifacts\/([a-f0-9]{64})$/);
      if (download && ['GET', 'HEAD'].includes(method)) {
        if (!store.get('SELECT 1 FROM patch_artifacts WHERE blob_hash=?', download[1])) fail(404, 'Artifact not found.');
        return sendBinary(request, response, store.read(download[1]), download[1]);
      }
      if (!path.startsWith('/api/')) fail(404, 'Not found.');
      requireAdmin(request);
      if(['/api/cli/downloads/manifest','/api/cli/downloads/windows-x64'].includes(path)&&['GET','HEAD'].includes(method)){
        const directory=join(store.directory,'cli-distributions'),manifest=join(directory,'tern-cli-latest.json');
        if(!existsSync(manifest))fail(404,'The Windows installer has not been published on this server.');
        const envelope=JSON.parse(readFileSync(manifest,'utf8')),release=verifyRelease(envelope);
        if(path.endsWith('/manifest'))return json(response,200,envelope);
        const file=join(directory,release.filename);if(!existsSync(file))fail(404,'Installer file is missing.');
        const bytes=readFileSync(file);if(bytes.length!==release.size||sha256(bytes)!==release.sha256)fail(503,'Installer integrity verification failed.');
        response.setHeader('Content-Disposition','attachment; filename="'+release.filename+'"');
        return sendBinary(request,response,bytes,release.sha256,true);
      }
      if(['/api/cli/downloads/npm/manifest','/api/cli/downloads/npm'].includes(path)&&['GET','HEAD'].includes(method)){
        const directory=join(store.directory,'cli-distributions'),manifest=join(directory,'tern-npm-latest.json');
        if(!existsSync(manifest))fail(404,'The npm package has not been published on this server.');
        const envelope=JSON.parse(readFileSync(manifest,'utf8')),release=verifyRelease(envelope);
        if(release.platform!=='npm')fail(503,'The npm release manifest is invalid.');
        if(path.endsWith('/manifest'))return json(response,200,envelope);
        const file=join(directory,release.filename);if(!existsSync(file))fail(404,'npm package file is missing.');
        const bytes=readFileSync(file);if(bytes.length!==release.size||sha256(bytes)!==release.sha256)fail(503,'npm package integrity verification failed.');
        response.setHeader('Content-Disposition','attachment; filename="'+release.filename+'"');
        return sendBinary(request,response,bytes,release.sha256,true);
      }
      if(path==='/api/cli/credentials'&&method==='GET')return json(response,200,{credentials:store.all('SELECT id,machine,created_at,expires_at,last_used,revoked FROM cli_credentials WHERE account_version=? ORDER BY created_at DESC',sha256(getAdministrator(store)?.password_hash||''))});
      const revokeCredential=path.match(/^\/api\/cli\/credentials\/([a-zA-Z0-9-]+)$/);
      if(revokeCredential&&method==='DELETE'){
        const id=revokeCredential[1]==='current'?cliCredential(store,request.headers.authorization?.slice(7))?.id:revokeCredential[1];
        if(!id)fail(400,'No CLI credential was supplied.');
        store.run('UPDATE cli_credentials SET revoked=1 WHERE id=?',id);return json(response,200,{revoked:true});
      }
      if (path === '/api/snapshot' && method === 'GET') return json(response, 200, { ...store.snapshot(), administrator: { email: getAdministrator(store)?.email || null } });
      if (path === '/api/account/password' && method === 'POST') {
        rateLimit(request,'change-password',6);
        const account = getAdministrator(store);
        if (!account) fail(409,'Finish administrator setup first.');
        const payload = await body(request);
        try { validatePassword(payload.new_password); } catch(error) { fail(400,error.message); }
        const valid = await passwordWork(() => verifyPassword(payload.current_password,account.password_hash));
        if (!valid) fail(401,'The current password is incorrect.');
        const passwordHash = await passwordWork(() => hashPassword(payload.new_password));
        store.transaction(() => {
          if (getAdministrator(store)?.password_hash !== account.password_hash) fail(409,'Your password changed during this request. Sign in again.');
          saveAdministrator(store,account.email,passwordHash);
          store.run('DELETE FROM administrator_setup WHERE id=1');
        });
        sessions.clear(); issueSession(response);
        return json(response,200,{changed:true});
      }
      if (path === '/api/apps' && method === 'POST') {
        const b = await body(request);
        const name = textField(b.name, 'app name', 80);
        const app = { id: randomUUID(), name, created_at: now() };
        store.transaction(() => {
          store.run('INSERT INTO apps VALUES(?,?,?)', app.id, name, app.created_at);
          store.event(app.id, 'app_created', `${name} is ready for its first release.`);
        });
        return json(response, 201, app);
      }
      const deleteApp = path.match(/^\/api\/apps\/([^/]+)$/);
      if (deleteApp && method === 'DELETE') {
        const app = lookup('apps',deleteApp[1]);
        const payload = await body(request);
        if(payload.confirm_name!==app.name)fail(400,'Type the exact application name to confirm deletion.');
        return json(response,200,store.deleteApplication(app.id));
      }
      if (path === '/api/releases' && method === 'POST') {
        const b = await body(request, 90 * 1024 * 1024);
        lookup('apps', textField(b.app_id, 'app_id'));
        const release = { id: randomUUID(), app_id: b.app_id, version: textField(b.version, 'version', 80),
          platform: choice(b.platform, platforms, 'platform'), engine_version: textField(b.engine_version, 'engine_version', 160), created_at: now() };
        if (store.get('SELECT 1 FROM releases WHERE app_id=? AND version=? AND platform=?', b.app_id, release.version, release.platform)) fail(409, 'This release already exists. Release artifacts are immutable.');
        const artifacts = artifactList(b.artifacts);
        if(b.build_manifest) {
          try { validateBuildManifest(b.build_manifest); } catch(error) { fail(400,error.message); }
          if(release.platform!=='android'||b.build_manifest.engine_revision!==release.engine_version)fail(400,'Build manifest must match the Android release engine.');
        }
        store.transaction(() => {
          store.run('INSERT INTO releases VALUES(?,?,?,?,?,?)', release.id, release.app_id, release.version, release.platform, release.engine_version, release.created_at);
          if(b.build_manifest)store.run('INSERT INTO release_manifests VALUES(?,?)',release.id,JSON.stringify(b.build_manifest));
          for (const a of artifacts) store.run('INSERT INTO release_artifacts VALUES(?,?,?,?)', release.id, a.arch, store.put(a.bytes), a.bytes.length);
          store.event(release.app_id, 'release_created', `Released ${release.version} for ${release.platform}.`);
        });
        return json(response, 201, release);
      }
      const releaseBinary = path.match(/^\/api\/releases\/([^/]+)\/artifacts\/([^/]+)$/);
      if (releaseBinary && method === 'GET') {
        const artifact = store.get('SELECT * FROM release_artifacts WHERE release_id=? AND arch=?', releaseBinary[1], releaseBinary[2]);
        if (!artifact) fail(404, 'Release artifact not found.');
        response.setHeader('Cache-Control', 'private, no-store');
        return sendBinary(request, response, store.read(artifact.hash), artifact.hash, true);
      }
      if (path === '/api/patches' && method === 'POST') {
        const b = await body(request, 90 * 1024 * 1024);
        const release = lookup('releases', textField(b.release_id, 'release_id'));
        if (b.engine_version !== release.engine_version) fail(409, 'Engine version must exactly match the release. Rebuild with the original toolchain.');
        const baseline=store.get('SELECT manifest FROM release_manifests WHERE release_id=?',release.id);
        if(baseline) {
          if(!b.build_manifest)fail(409,'This release is runtime-managed. Build the patch with the Tern CLI to verify native files and bundled assets.');
          try { assertPatchCompatible(JSON.parse(baseline.manifest),b.build_manifest); } catch(error) { fail(409,error.message); }
        }
        const notes = b.notes == null ? '' : textField(b.notes, 'notes', 1000, true);
        const artifacts = artifactList(b.artifacts).map(a => {
          const base = store.get('SELECT * FROM release_artifacts WHERE release_id=? AND arch=?', release.id, a.arch);
          if (!base) fail(400, `Release has no ${a.arch} artifact.`);
          let compressed, target;
          try {
            if (a.format === 'bidiff-v1-zstd') {
              compressed = a.bytes;
              target = applyPatch(store.read(base.hash), compressed);
              if (!/^[a-f0-9]{64}$/.test(a.target_hash) || sha256(target) !== a.target_hash) fail(400, 'Reconstructed patch hash does not match target_hash.');
            } else if (!a.format || a.format === 'target') {
              target = a.bytes;
              compressed = makePatch(store.read(base.hash), target);
            } else fail(400, 'Unsupported patch format.');
          } catch (error) { fail(400, `Invalid patch: ${error.message}`); }
          if (!target.length) fail(400, 'Patch target cannot be empty.');
          if (a.hash_signature != null && (typeof a.hash_signature !== 'string' || a.hash_signature.length > 2048 || !/^[A-Za-z0-9+/]+=*$/.test(a.hash_signature))) fail(400, 'Invalid hash_signature.');
          const runtime=baseline&&JSON.parse(baseline.manifest).runtime;
          if(runtime?.id==='tern-native-v1'&&!verifyNativePatch(runtime.public_key,{app_id:release.app_id,version:release.version,engine_revision:release.engine_version,arch:a.arch,hash:sha256(target)},a.hash_signature))fail(400,'Tern native patch signature rejected.');
          return { ...a, compressed, target_hash: sha256(target), target_size: target.length };
        });
        const original = store.all('SELECT arch FROM release_artifacts WHERE release_id=?', release.id);
        if (original.length !== artifacts.length) fail(400, 'A patch must include every architecture in the release.');
        const patch = { id: randomUUID(), release_id: release.id, notes, status: 'active', created_at: now() };
        store.transaction(() => {
          patch.number = store.get('SELECT COALESCE(MAX(number),0)+1 AS next FROM patches WHERE release_id=?', release.id).next;
          store.run('INSERT INTO patches(id,release_id,number,notes,status,created_at) VALUES(?,?,?,?,?,?)', patch.id, release.id, patch.number, notes, 'active', patch.created_at);
          for (const a of artifacts) store.run('INSERT INTO patch_artifacts VALUES(?,?,?,?,?,?,?)', patch.id, a.arch, store.put(a.compressed), a.target_hash, a.target_size, a.compressed.length, a.hash_signature || null);
          store.event(release.app_id, 'patch_created', `Patch ${patch.number} built for ${release.version}.`, patch.id);
        });
        return json(response, 201, patch);
      }
      const deploy = path.match(/^\/api\/patches\/([^/]+)\/deploy$/);
      if (deploy && method === 'POST') {
        const b = await body(request);
        const patch = lookup('patches', deploy[1]);
        if (patch.status === 'revoked') fail(409, 'A revoked patch cannot be deployed. Create a new patch.');
        const release = lookup('releases', patch.release_id);
        const channel = choice(b.channel, channels, 'channel');
        const rollout = integer(b.rollout ?? 100, 'rollout', 0, 100);
        const previous = store.get(`SELECT p.number FROM deployments d JOIN patches p ON p.id=d.patch_id WHERE d.release_id=? AND d.channel=?`, release.id, channel);
        if (previous && previous.number > patch.number) fail(409, 'Cannot deploy an older patch. Revoke the current patch first.');
        store.transaction(() => {
          store.run(`INSERT INTO deployments VALUES(?,?,?,?,?) ON CONFLICT(release_id,channel) DO UPDATE SET
            patch_id=excluded.patch_id,rollout=excluded.rollout,updated_at=excluded.updated_at`, release.id, channel, patch.id, rollout, now());
          store.event(release.app_id, 'patch_deployed', `Patch ${patch.number} deployed to ${channel} at ${rollout}%.`, patch.id);
        });
        return json(response, 200, { patch_id: patch.id, channel, rollout });
      }
      const rollback = path.match(/^\/api\/patches\/([^/]+)\/rollback$/);
      if (rollback && method === 'POST') {
        const patch = lookup('patches', rollback[1]);
        const release = lookup('releases', patch.release_id);
        if (patch.status !== 'revoked') store.transaction(() => {
          store.run("UPDATE patches SET status='revoked' WHERE id=?", patch.id);
          store.run('DELETE FROM deployments WHERE patch_id=?', patch.id);
          store.event(release.app_id, 'patch_rolled_back', `Patch ${patch.number} revoked on every channel. Devices will return to a valid patch or the store release on restart.`, patch.id);
        });
        return json(response, 200, { ...patch, status: 'revoked' });
      }
      fail(404, 'Endpoint not found.');
    } catch (error) {
      if (!error.status) console.error('Request failed:', error.message);
      if (!response.headersSent) json(response, error.status || 500, { error: error.status ? error.message : 'An internal error occurred.' });
      else response.end();
    }
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 15_000;
  return { server, store,
    async listen(port = 4310, host = '127.0.0.1') {
      if (publicUrl && !/^https?:\/\//.test(publicUrl)) throw new Error('Public URL must use HTTP or HTTPS.');
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      address = `http://${host.includes(':') ? `[${host}]` : host}:${server.address().port}`;
      return address;
    },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); },
  };
}

function sendBinary(request, response, bytes, hash, privateArtifact = false) {
  const headers = { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes',
    'ETag': `"${hash}"`, 'Cache-Control': privateArtifact ? 'private, no-store' : 'public, max-age=31536000, immutable' };
  let start = 0;
  let end = bytes.length - 1;
  if (request.headers.range) {
    const range = request.headers.range.match(/^bytes=(\d*)-(\d*)$/);
    if (!range || (!range[1] && !range[2])) { response.writeHead(416, { 'Content-Range': `bytes */${bytes.length}` }); return response.end(); }
    if (!range[1]) start = Math.max(0, bytes.length - Number(range[2]));
    else { start = Number(range[1]); if (range[2]) end = Math.min(end, Number(range[2])); }
    if (start > end || start >= bytes.length) { response.writeHead(416, { 'Content-Range': `bytes */${bytes.length}` }); return response.end(); }
    headers['Content-Range'] = `bytes ${start}-${end}/${bytes.length}`;
  }
  headers['Content-Length'] = end - start + 1;
  response.writeHead(request.headers.range ? 206 : 200, headers);
  response.end(request.method === 'HEAD' ? undefined : bytes.subarray(start, end + 1));
}
