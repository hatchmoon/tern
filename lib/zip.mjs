import { inflateRawSync, crc32 } from 'node:zlib';

// Reads Android APK ZIP entries without writing archive-supplied paths.
export function readZip(bytes) {
  let end=-1;
  for(let p=bytes.length-22;p>=Math.max(0,bytes.length-65557);p--) {
    if(bytes.readUInt32LE(p)===0x06054b50 && p+22+bytes.readUInt16LE(p+20)===bytes.length){end=p;break;}
  }
  if(end<0)throw new Error('Not a valid APK/ZIP archive.');
  const count=bytes.readUInt16LE(end+10);
  let cursor=bytes.readUInt32LE(end+16);
  if(count===65535||cursor===0xffffffff)throw new Error('ZIP64 APKs are not supported.');
  const entries=new Map();
  for(let i=0;i<count;i++) {
    if(cursor+46>bytes.length||bytes.readUInt32LE(cursor)!==0x02014b50)throw new Error('Invalid ZIP directory.');
    const flags=bytes.readUInt16LE(cursor+8),method=bytes.readUInt16LE(cursor+10);
    const checksum=bytes.readUInt32LE(cursor+16),compressedSize=bytes.readUInt32LE(cursor+20),size=bytes.readUInt32LE(cursor+24);
    const nameLength=bytes.readUInt16LE(cursor+28),extraLength=bytes.readUInt16LE(cursor+30),commentLength=bytes.readUInt16LE(cursor+32);
    const offset=bytes.readUInt32LE(cursor+42);
    if(cursor+46+nameLength+extraLength+commentLength>bytes.length)throw new Error('Invalid ZIP entry.');
    const name=bytes.subarray(cursor+46,cursor+46+nameLength).toString('utf8');
    if(entries.has(name))throw new Error(`Duplicate APK entry: ${name}`);
    entries.set(name,{name,size,read(){
      if(flags&1)throw new Error('Encrypted archives are not supported.');
      if(offset+30>bytes.length||bytes.readUInt32LE(offset)!==0x04034b50)throw new Error('Invalid ZIP local header.');
      const start=offset+30+bytes.readUInt16LE(offset+26)+bytes.readUInt16LE(offset+28);
      if(bytes.subarray(offset+30,offset+30+bytes.readUInt16LE(offset+26)).toString('utf8')!==name)throw new Error('ZIP local filename differs from its directory entry.');
      if(start+compressedSize>bytes.length||size>128*1024*1024)throw new Error('APK entry exceeds limits.');
      const compressed=bytes.subarray(start,start+compressedSize);
      const data=method===0?compressed:method===8?inflateRawSync(compressed,{maxOutputLength:128*1024*1024}):null;
      if(!data)throw new Error(`Unsupported ZIP compression: ${method}`);
      if(data.length!==size||crc32(data)!==checksum)throw new Error(`APK checksum mismatch: ${name}`);
      return data;
    }});
    cursor+=46+nameLength+extraLength+commentLength;
  }
  return entries;
}
