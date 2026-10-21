import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const binary = value => ({ arch: 'aarch64', data: Buffer.from(value).toString('base64') });

async function start(t, overrides = {}, directory = mkdtempSync(join(tmpdir(), 'tern-cloud-'))) {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const token = overrides.TERN_ADMIN_TOKEN || randomBytes(32).toString('hex');
  const child = spawn(process.execPath, ['server/main.mjs'], {
    cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOST: '', RENDER: '', RENDER_EXTERNAL_URL: '', TERN_PUBLIC_URL: '',
      TERN_DATA_DIR: directory, TERN_ADMIN_TOKEN: token, PORT: String(port), ...overrides },
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const stopped = once(child, 'exit');
  async function stop() {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await stopped;
  }
  t.after(stop);
  const url = 'http://127.0.0.1:' + port;
  const deadline = Date.now() + 15_000;
  while (true) {
    if (child.exitCode !== null) throw new Error('Server exited during startup: ' + output);
    try {
      const response = await fetch(url + '/health', { signal: AbortSignal.timeout(500) });
      if (response.ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error('Server did not become healthy: ' + output);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const request = (path, data, headers = {}) => fetch(url + path, {
    method: data ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + token, ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: data ? JSON.stringify(data) : undefined,
  });
  return { url, token, directory, request, stop, output: () => output };
}

test('Render entrypoint uses HTTPS origin, secure cookies, and public artifact URLs', async t => {
  const origin = 'https://tern-test.onrender.com';
  const f = await start(t, { RENDER: 'true', RENDER_EXTERNAL_URL: origin + '/' });
  assert.match(f.output(), /Console  https:\/\/tern-test.onrender.com/);
  assert.equal((await fetch(f.url + '/api/snapshot')).status, 401);
  const session = await f.request('/api/session', { token: f.token }, { Origin: origin });
  assert.equal(session.status, 200);
  const cookie = session.headers.get('set-cookie');
  assert.match(cookie, /; Secure/);
  assert.match(cookie, /HttpOnly/);
  assert.equal((await fetch(f.url + '/api/snapshot', { headers: { Cookie: cookie.split(';')[0] } })).status, 200);
  assert.equal((await f.request('/api/session', { token: f.token }, { Origin: 'https://other.example' })).status, 403);

  const app = await (await f.request('/api/apps', { name: 'Cloud verification' }, { Origin: origin })).json();
  const releaseResponse = await f.request('/api/releases', {
    app_id: app.id, version: '1.0.0+1', platform: 'android', engine_version: 'cloud-fixture',
    artifacts: [binary('original cloud bytes')],
  });
  assert.equal(releaseResponse.status, 201);
  const release = await releaseResponse.json();
  const patch = await (await f.request('/api/patches', {
    release_id: release.id, engine_version: 'cloud-fixture', artifacts: [binary('updated cloud bytes')],
  })).json();
  assert.equal((await f.request('/api/patches/' + patch.id + '/deploy', { channel: 'staging', rollout: 100 })).status, 200);
  const check = await (await f.request('/api/v1/patches/check', {
    app_id: app.id, release_version: release.version, platform: 'android', arch: 'aarch64', channel: 'staging',
  })).json();
  assert.equal(check.patch_available, true);
  assert.ok(check.patch.download_url.startsWith(origin + '/artifacts/'));
  const bytes = await fetch(f.url + new URL(check.patch.download_url).pathname);
  assert.equal(bytes.status, 200);
  assert.ok(Number(bytes.headers.get('content-length')) > 0);
});

test('explicit public custom domain overrides the Render hostname', async t => {
  const f = await start(t, { RENDER: 'true', RENDER_EXTERNAL_URL: 'https://old.onrender.com', TERN_PUBLIC_URL: 'https://updates.example.com/' });
  assert.match(f.output(), /Console  https:\/\/updates.example.com/);
  assert.equal((await f.request('/api/session', { token: f.token }, { Origin: 'https://old.onrender.com' })).status, 403);
  assert.equal((await f.request('/api/session', { token: f.token }, { Origin: 'https://updates.example.com' })).status, 200);
});

test('local startup stays on loopback and a replacement process retains disk data', async t => {
  const f = await start(t);
  assert.ok(f.output().includes('Console  ' + f.url));
  const session = await f.request('/api/session', { token: f.token });
  assert.doesNotMatch(session.headers.get('set-cookie'), /; Secure/);
  const app = await (await f.request('/api/apps', { name: 'Survives redeploy' })).json();
  await f.stop();
  const restarted = await start(t, { TERN_ADMIN_TOKEN: f.token }, f.directory);
  const snapshot = await (await restarted.request('/api/snapshot')).json();
  assert.equal(snapshot.apps[0].id, app.id);
});
