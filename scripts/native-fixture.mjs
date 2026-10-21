import { mkdirSync,writeFileSync,readFileSync,existsSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { makePatch,sha256 } from '../lib/patch.mjs';
const directory=resolve('test-results/native');mkdirSync(directory,{recursive:true});
if(process.argv[2]==='verify'){
  const target=readFileSync(join(directory,'target.bin'));
  const decoded=readFileSync(join(directory,'decoded.bin'));
  if(!target.equals(decoded))throw new Error('Native upstream decoder output differs from target.');
  console.log(`Independent Rust verification passed: ${decoded.length} bytes, SHA-256 ${sha256(decoded)}`);
}else{
  if(existsSync(join(directory,'decoded.bin')))throw new Error('Native fixture already verified. Preserve it or choose a fresh workspace.');
  const base=randomBytes(65536),target=Buffer.concat([Buffer.from(base),Buffer.from('new trailing bytes')]);
  for(let i=0;i<target.length;i+=731)target[i]=(target[i]+57)&255;
  writeFileSync(join(directory,'base.bin'),base);writeFileSync(join(directory,'target.bin'),target);writeFileSync(join(directory,'patch.vmcode'),makePatch(base,target));
  console.log('Wrote binary fixtures for the independent Rust decoder to test-results/native.');
}
