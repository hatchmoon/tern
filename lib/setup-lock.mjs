import {mkdirSync,writeFileSync,readFileSync,unlinkSync} from 'node:fs';
import {dirname} from 'node:path';
export async function withSetupLock(directory,work){
  mkdirSync(dirname(directory),{recursive:true});const path=directory+'.setup-lock';
  function acquire(){writeFileSync(path,JSON.stringify({pid:process.pid}),{flag:'wx',mode:0o600});}
  try{acquire();}catch(error){
    if(error.code!=='EEXIST')throw error;
    let pid;try{pid=JSON.parse(readFileSync(path,'utf8')).pid;}catch{throw new Error('An incomplete setup lock exists at '+path+'. Close other setup processes before removing it.');}
    let alive=true;try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')alive=false;}
    if(alive)throw new Error('Another Tern setup is running. Wait for it to finish.');
    unlinkSync(path);acquire();
  }
  try{return await work();}finally{unlinkSync(path);}
}
