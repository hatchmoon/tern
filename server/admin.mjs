#!/usr/bin/env node
import { resolve, join } from 'node:path';
import { writeFileSync, chmodSync } from 'node:fs';
import { Store } from './store.mjs';
import { issueAccountSetup } from './accounts.mjs';

const args = process.argv.slice(2);
let store;
try {
  if (args.shift() !== 'setup') throw new Error('Usage: node server/admin.mjs setup --email owner@example.com --origin https://updates.example.com [--reset] [--data-dir PATH]');
  const options = {};
  while (args.length) {
    const key = args.shift();
    if (key === '--reset') options.reset = true;
    else if (['--email','--origin','--data-dir'].includes(key)) {
      const value = args.shift();
      if (!value || value.startsWith('--')) throw new Error(key + ' needs a value.');
      options[key.slice(2)] = value;
    } else throw new Error('Unknown option: ' + key);
  }
  const origin = new URL(options.origin || process.env.TERN_PUBLIC_URL);
  if (!['http:','https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Use an HTTP(S) origin without a path or credentials.');
  store = new Store(resolve(options['data-dir'] || process.env.TERN_DATA_DIR || '.tern-data'));
  const setup = issueAccountSetup(store, options.email, { reset: !!options.reset });
  const path = join(store.directory,'admin-setup-url');
  writeFileSync(path, origin.origin + '/#setup=' + setup.token + '\n', { mode: 0o600 });
  chmodSync(path,0o600);
  console.log(JSON.stringify({ email: setup.email, expires_at: new Date(setup.expires_at).toISOString(), private_setup_url_file: path },null,2));
} catch (error) { console.error('Tern: ' + error.message); process.exitCode = 1; }
finally { store?.close(); }
