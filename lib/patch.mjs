import { createHash } from 'node:crypto';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

export const MAX_ARTIFACT = 64 * 1024 * 1024;
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const HEADER = Buffer.from([0xdf, 0xb1, 0, 0, 0, 0x10, 0, 0]);

function varint(value) {
  const bytes = [];
  do {
    const next = value % 128;
    value = Math.floor(value / 128);
    bytes.push(next | (value ? 128 : 0));
  } while (value);
  return Buffer.from(bytes);
}

// Independently implemented bidiff v1 wire encoder. A position-wise additive
// delta keeps unchanged regions zero-filled and highly compressible with zstd.
// The original release is always the base, never the previous patch.
export function makePatch(base, target) {
  if (base.length > MAX_ARTIFACT || target.length > MAX_ARTIFACT) throw new Error('Artifacts must be at most 64 MiB.');
  const length = Math.min(base.length, target.length);
  const difference = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i++) difference[i] = (target[i] - base[i]) & 255;
  return zstdCompressSync(Buffer.concat([
    HEADER, varint(length), difference,
    varint(target.length - length), target.subarray(length), varint(0),
  ]));
}

export function applyPatch(base, compressed) {
  const bytes = zstdDecompressSync(compressed, { maxOutputLength: MAX_ARTIFACT + 4096 });
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(HEADER)) throw new Error('Unsupported bidiff patch header.');
  let cursor = 8;
  let baseCursor = 0;
  let outputLength = 0;
  const output = [];
  function readNumber() {
    let value = 0;
    let scale = 1;
    for (let i = 0; i < 8; i++) {
      if (cursor >= bytes.length) throw new Error('Truncated patch.');
      const byte = bytes[cursor++];
      value += (byte & 127) * scale;
      if (!Number.isSafeInteger(value)) throw new Error('Invalid patch integer.');
      if (!(byte & 128)) return value;
      scale *= 128;
    }
    throw new Error('Invalid patch integer.');
  }
  function take(length) {
    if (length > MAX_ARTIFACT || cursor + length > bytes.length) throw new Error('Truncated or oversized patch.');
    const result = bytes.subarray(cursor, cursor + length);
    cursor += length;
    outputLength += length;
    if (outputLength > MAX_ARTIFACT) throw new Error('Patched artifact exceeds 64 MiB.');
    return result;
  }
  while (cursor < bytes.length) {
    const length = readNumber();
    if (baseCursor < 0 || baseCursor + length > base.length) throw new Error('Patch does not match the release artifact.');
    const delta = take(length);
    const added = Buffer.allocUnsafe(length);
    for (let i = 0; i < length; i++) added[i] = (base[baseCursor + i] + delta[i]) & 255;
    output.push(added);
    baseCursor += length;
    output.push(take(readNumber()));
    const seek = readNumber();
    baseCursor += seek % 2 ? -(seek + 1) / 2 : seek / 2;
  }
  return Buffer.concat(output, outputLength);
}
