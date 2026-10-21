import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { sha256 } from '../lib/patch.mjs';

const derive = promisify(scrypt);
const options = { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 };
export function normalizeEmail(value) {
  if (typeof value !== 'string') throw new Error('Enter a valid email address.');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@\x00-\x1f]+@[^\s@\x00-\x1f]+\.[^\s@\x00-\x1f]+$/.test(email)) throw new Error('Enter a valid email address.');
  return email;
}
export function validatePassword(value) {
  if (typeof value !== 'string' || [...value].length < 15 || [...value].length > 128) throw new Error('Use a password between 15 and 128 characters. A passphrase works well.');
}
export async function hashPassword(password) {
  validatePassword(password);
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 32, options);
  return `scrypt$131072$8$1$${salt}$${key.toString('hex')}`;
}
export async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || [...password].length > 128 || typeof encoded !== 'string') return false;
  const match = encoded.match(/^scrypt\$131072\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{64})$/);
  if (!match) return false;
  const key = await derive(password, match[1], 32, options);
  return timingSafeEqual(key, Buffer.from(match[2], 'hex'));
}
export const getAdministrator = store => store.get('SELECT * FROM administrator WHERE id=1');
export function getAccountSetup(store, token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
  const setup = store.get('SELECT * FROM administrator_setup WHERE id=1');
  if (!setup || setup.expires_at <= Date.now()) return null;
  return timingSafeEqual(Buffer.from(setup.token_hash, 'hex'), Buffer.from(sha256(token), 'hex')) ? setup : null;
}
export function issueAccountSetup(store, email, { reset = false, ttlMs = 3600_000 } = {}) {
  email = normalizeEmail(email);
  if (getAdministrator(store) && !reset) throw new Error('An administrator already exists. Use --reset to issue a recovery link.');
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 86400_000) throw new Error('Setup expiry must be between one millisecond and 24 hours.');
  const token = randomBytes(32).toString('hex');
  const expiresAt = Date.now() + ttlMs;
  store.run('INSERT OR REPLACE INTO administrator_setup(id,email,token_hash,expires_at) VALUES(1,?,?,?)',email,sha256(token),expiresAt);
  return { token, email, expires_at: expiresAt };
}
export function saveAdministrator(store, email, passwordHash) {
  store.run('INSERT OR REPLACE INTO administrator(id,email,password_hash,updated_at) VALUES(1,?,?,?)',email,passwordHash,new Date().toISOString());
}
