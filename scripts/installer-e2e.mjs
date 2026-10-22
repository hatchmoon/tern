import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,copyFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import {createApp} from '../server/app.mjs';
import {issueAccountSetup} from '../server/accounts.mjs';
import {verifyRelease} from '../cli/upgrade.mjs';

if(process.platform!=='win32')throw new Error('Run installer verification on Windows.');
const modulePath=process.env.TERN_PLAYWRIGHT_PATH;
const {chromium}=modulePath?await import(pathToFileURL(modulePath).href):await import('playwright');
const distribution=resolve('dist'),release=verifyRelease(JSON.parse(readFileSync(join(distribution,'tern-cli-latest.json'))));
const initialFile=resolve('.tern-tools/installer-build/installation-initial.json');
const initial=existsSync(initialFile)?JSON.parse(readFileSync(initialFile)):null;
const root=initial?.root||join(mkdtempSync(join(tmpdir(),'tern-install-')),'CLI With Spaces');
const home=join(mkdtempSync(join(tmpdir(),'tern-user-')),'User Data With Spaces');mkdirSync(home,{recursive:true});
const env={...process.env,TERN_HOME:home};delete env.TERN_TOKEN;delete env.TERN_SERVER;delete env.TERN_CACHE_DIR;
function execute(file,args,options={}){const r=spawnSync(file,args,{encoding:'utf8',env,windowsHide:true,...options});assert.equal(r.status,0,r.stderr||'Process failed: '+file);return r.stdout;}
function executeAsync(file,args,options={},expected=0){return new Promise((resolve,reject)=>{let out='',err='';const child=spawn(file,args,{env,windowsHide:true,...options});child.stdout.on('data',chunk=>out+=chunk);child.stderr.on('data',chunk=>err+=chunk);child.once('error',reject);child.once('exit',code=>{try{assert.equal(code,expected,err);resolve({stdout:out,stderr:err});}catch(error){reject(error);}});});}
const currentBefore=existsSync(join(root,'current.txt'))?readFileSync(join(root,'current.txt'),'utf8').trim():null;
execute(join(distribution,release.filename),['/silent','/nopath','/dir',root]);
const cli=join(root,'bin','tern.exe'),current=readFileSync(join(root,'current.txt'),'utf8').trim();
assert.equal(execute(cli,['--version'],{env:{...env,PATH:''}}).trim(),release.version);
assert.ok(execute(cli,['--help']).includes('connect'));
if(currentBefore&&currentBefore!==current){assert.equal(readFileSync(join(root,'previous.txt'),'utf8').trim(),currentBefore);assert.ok(existsSync(join(root,'versions',currentBefore,'node.exe')));}
const dataDir=mkdtempSync(join(tmpdir(),'tern-installer-server-')),app=createApp({dataDir}),server=await app.listen(0);
const distributions=join(dataDir,'cli-distributions');mkdirSync(distributions);for(const file of [release.filename,'tern-cli-latest.json'])copyFileSync(join(distribution,file),join(distributions,file));
const browser=await chromium.launch({channel:process.env.TERN_BROWSER_CHANNEL||'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
let loginProcess;
const results=resolve('test-results','installer');mkdirSync(results,{recursive:true});
try{
  const setup=issueAccountSetup(app.store,'installer-test@example.com');
  await page.goto(server+'/#setup='+setup.token);await page.getByLabel('New password',{exact:true}).fill('A private installer QA passphrase');await page.getByLabel('Confirm password',{exact:true}).fill('A private installer QA passphrase');await page.getByRole('button',{name:'Set password and sign in'}).click();await page.getByRole('heading',{name:'Overview',exact:true}).waitFor();
  let output='';loginProcess=spawn(cli,['login','--server',server,'--no-browser','--machine','Installer QA laptop'],{env,windowsHide:true});loginProcess.stdout.on('data',chunk=>{output+=chunk;});loginProcess.stderr.on('data',chunk=>{output+=chunk;});
  const loginExit=new Promise(resolve=>loginProcess.once('exit',resolve));
  let url,code;for(let i=0;i<200;i++){url=output.match(/http:\/\/127\.0\.0\.1:\d+\/#cli=[a-f0-9]{64}/)?.[0];code=output.match(/verification code: ([A-F0-9]{8})/)?.[1];if(url&&code)break;await delay(100);}assert.ok(url&&code,'CLI login did not print an approval link');
  await page.goto(url);await page.getByRole('heading',{name:'Connect this machine?'}).waitFor();
  await page.screenshot({path:join(results,'browser-approval-desktop.png'),fullPage:true});
  await page.getByLabel('Terminal verification code').fill(code);await page.getByRole('button',{name:'Approve machine',exact:true}).click();await page.getByRole('heading',{name:'Machine approved'}).waitFor();assert.equal(await loginExit,0,output);
  const settings=readFileSync(join(home,'settings.json'),'utf8');assert.ok(!settings.includes('tern_cli_'));assert.ok(settings.includes('windows-dpapi'));
  // Commands use saved origin and protected credential from a separate process.
  assert.equal(JSON.parse((await executeAsync(cli,['doctor','--server-only'])).stdout).authenticated,true);
  const project=join(mkdtempSync(join(tmpdir(),'tern-existing-project-')),'Flutter Project With Spaces');mkdirSync(project);
  const appResponse=await fetch(server+'/api/apps',{method:'POST',headers:{Authorization:'Bearer '+app.store.token,'Content-Type':'application/json'},body:JSON.stringify({name:'Existing installer test app'})});const application=await appResponse.json();
  writeFileSync(join(project,'pubspec.yaml'),'name: installer_test\nversion: 2.0.3+1\n');writeFileSync(join(project,'tern.yaml'),'app_id: '+application.id+'\nbase_url: '+server+'\nchannel: stable\nauto_update: true\n');
  const connected=JSON.parse((await executeAsync(cli,['connect'],{cwd:project})).stdout);assert.equal(connected.app_id,application.id);assert.equal(connected.runtime,'legacy');assert.equal(app.store.snapshot().apps.length,1);
  const upgrade=JSON.parse((await executeAsync(cli,['upgrade','--check'])).stdout);assert.equal(upgrade.verified,true);assert.equal(upgrade.update_available,false);
  assert.equal((await fetch(server+'/api/cli/downloads/windows-x64')).status,401);
  await page.goto(server+'/#docs');await page.getByRole('link',{name:'Download Tern for Windows'}).waitFor();
  const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('link',{name:'Download Tern for Windows'}).click()]);const downloaded=join(results,release.filename);await download.saveAs(downloaded);
  assert.equal(createHash('sha256').update(readFileSync(downloaded)).digest('hex'),release.sha256);
  await page.getByRole('button',{name:'Manage connected machines'}).click();await page.getByText('Installer QA laptop',{exact:true}).waitFor();
  await page.screenshot({path:join(results,'connected-machines-desktop.png'),fullPage:true});
  await page.getByRole('button',{name:'Revoke access',exact:true}).click();await page.getByText('No machines connected.',{exact:true}).waitFor();
  const rejected=await executeAsync(cli,['apps'],{},1);assert.ok(rejected.stderr.includes('Sign in'));
  await page.getByRole('button',{name:'Done',exact:true}).click();await page.setViewportSize({width:390,height:844});await page.goto(server+'/#docs');await page.getByRole('link',{name:'Download Tern for Windows'}).waitFor();
  await page.waitForFunction(()=>document.querySelector('.sidebar')?.getBoundingClientRect().right<=0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:join(results,'installer-guide-mobile.png'),fullPage:true});
  assert.deepEqual(errors,[]);
  // Corrupt the embedded ZIP without changing its managed entry point. Setup
  // must fail before changing the active, functioning installation.
  const broken=readFileSync(join(distribution,release.filename)),zip=broken.indexOf(Buffer.from('504b0304','hex'));assert.ok(zip>0);broken[zip+50]^=1;const damaged=join(results,'damaged-installer.exe');writeFileSync(damaged,broken);
  const failed=spawnSync(damaged,['/silent','/nopath','/dir',root],{encoding:'utf8',windowsHide:true});assert.equal(failed.status,1);assert.equal(readFileSync(join(root,'current.txt'),'utf8').trim(),current);assert.equal(execute(cli,['--version']).trim(),release.version);
  let rollbackVerified=false;
  if(existsSync(join(root,'previous.txt'))){const previous=readFileSync(join(root,'previous.txt'),'utf8').trim();if(previous!==current){assert.equal(JSON.parse(execute(cli,['upgrade','--rollback'])).rolled_back,true);assert.equal(readFileSync(join(root,'current.txt'),'utf8').trim(),previous);assert.ok(execute(cli,['--version']).trim());execute(join(distribution,release.filename),['/silent','/nopath','/dir',root]);assert.equal(readFileSync(join(root,'current.txt'),'utf8').trim(),current);rollbackVerified=true;}}
  // Uninstall a separate owned copy, retaining its unrelated user settings.
  const removalRoot=join(mkdtempSync(join(tmpdir(),'tern-uninstall-')),'Owned CLI');execute(join(distribution,release.filename),['/silent','/nopath','/dir',removalRoot]);execute(join(distribution,release.filename),['/silent','/nopath','/uninstall','/dir',removalRoot]);assert.equal(existsSync(removalRoot),false);assert.equal(existsSync(join(home,'settings.json')),true);
  const report={passed:true,verified_at:new Date().toISOString(),version:release.version,installer_sha256:release.sha256,isolated_install:true,space_paths:true,bundled_node_without_PATH:true,browser_sign_in:true,windows_encrypted_credential:true,existing_app_connection:true,legacy_runtime_preserved:true,signed_update_check:true,authenticated_download_verified:true,machine_revocation:true,desktop_mobile_no_overflow:true,corrupt_installer_preserved_current:true,previous_version_retained:!!currentBefore&&existsSync(join(root,'versions',currentBefore)),rollback_verified:rollbackVerified,uninstall_retains_settings:true,browser_errors:errors,root,home};
  writeFileSync(join(results,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{loginProcess?.kill();await browser.close();await app.close();}
