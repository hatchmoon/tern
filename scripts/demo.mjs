import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { applyPatch, sha256 } from '../lib/patch.mjs';

const server=(process.env.TERN_SERVER||'http://127.0.0.1:4310').replace(/\/$/,'');
const directory=resolve(process.env.TERN_DATA_DIR||'.tern-data');
const token=process.env.TERN_TOKEN||(existsSync(join(directory,'admin-token'))?readFileSync(join(directory,'admin-token'),'utf8').trim():'');
if(!token)throw new Error('Start the Tern server first with npm start.');
async function api(path,payload,admin=true){
  const response=await fetch(server+path,{method:payload?'POST':'GET',headers:{...(admin?{Authorization:`Bearer ${token}`} : {}),...(payload?{'Content-Type':'application/json'}:{})},body:payload?JSON.stringify(payload):undefined});
  const data=await response.json();if(!response.ok)throw new Error(data.error);return data;
}
const name='Harbor · simulated demo';
const before=await api('/api/snapshot');
if(before.apps.some(a=>a.name===name)){
  console.log('Demo application already exists. Your existing data was preserved.');
}else{
  const app=await api('/api/apps',{name});
  const base=Buffer.from(JSON.stringify({app:'harbor-demo',checkoutTotal:100,theme:'blue',padding:'x'.repeat(8192)}));
  const target=Buffer.from(JSON.stringify({app:'harbor-demo',checkoutTotal:99,theme:'blue',padding:'x'.repeat(8192)}));
  const artifact=bytes=>[{arch:'aarch64',data:bytes.toString('base64')}];
  const release=await api('/api/releases',{app_id:app.id,version:'1.0.0+1',platform:'android',engine_version:'demo-fixture-not-native-code',artifacts:artifact(base)});
  const patch=await api('/api/patches',{release_id:release.id,engine_version:release.engine_version,notes:'Correct checkout total · distribution demo only',artifacts:artifact(target)});
  for(const channel of ['staging','beta','stable'])await api(`/api/patches/${patch.id}/deploy`,{channel,rollout:channel==='stable'?25:100});
  for(let i=1;i<=8;i++){
    const request={app_id:app.id,release_version:release.version,platform:'android',arch:'aarch64',channel:'staging',client_id:`demo-simulator-${i}`};
    const check=await api('/api/v1/patches/check',request,false);
    const compressed=Buffer.from(await(await fetch(check.patch.download_url)).arrayBuffer());
    if(sha256(applyPatch(base,compressed))!==sha256(target))throw new Error('Demo reconstruction failed.');
    for(const type of ['__patch_download__','__patch_install__'])await api('/api/v1/patches/events',{event:{...request,patch_number:patch.number,type,timestamp:Math.floor(Date.now()/1000)}},false);
    await api('/api/v1/patches/check',{...request,current_patch_number:1},false);
  }
  mkdirSync(join(directory,'demo'),{recursive:true});
  writeFileSync(join(directory,'demo','base.bin'),base);writeFileSync(join(directory,'demo','target.bin'),target);
  console.log(`Created ${name}: one release, one patch, three deployments, eight verified simulated installs.\nThese sample binaries are JSON fixtures, not Flutter machine code.\nConsole: ${server}`);
}
