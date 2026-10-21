import { spawn } from 'node:child_process';

export function runTool(executable, args, { cwd, env = {}, capture = false } = {}) {
  let command = executable;
  let commandArgs = args;
  if (process.platform === 'win32' && /\.(bat|cmd)$/i.test(executable)) {
    // Literal PowerShell arguments prevent project paths and build arguments
    // from becoming shell syntax, including spaces, apostrophes, and $().
    const literal = value => `'${String(value).replaceAll("'", "''")}'`;
    const script = `$ErrorActionPreference='Stop'; & ${[executable,...args].map(literal).join(' ')}; exit $LASTEXITCODE`;
    command = 'powershell.exe';
    commandArgs = ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')];
  }
  return new Promise((resolve,reject) => {
    const child = spawn(command, commandArgs, { cwd, env:{...process.env,...env}, windowsHide:true, stdio:['ignore','pipe','pipe'] });
    let stdout='',stderr='';
    child.stdout.on('data',chunk=>{ stdout+=chunk; if(!capture)process.stderr.write(chunk); });
    child.stderr.on('data',chunk=>{ stderr+=chunk; if(!capture)process.stderr.write(chunk); });
    child.on('error',reject);
    child.on('close',code=>code===0?resolve({stdout,stderr}):reject(new Error(`${executable} failed (${code}).${capture ? '\n'+stderr.slice(-5000)+'\n'+stdout.slice(-5000) : ''}`)));
  });
}
