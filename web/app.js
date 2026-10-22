const root = document.querySelector('#root');
const modal = document.querySelector('#modal');
const toastElement = document.querySelector('#toast');
const state = { data: null, view: 'overview', app: '', search: '', tab: 'all', online: true };
let toastTimer;
function readSetupToken() {
  const token = location.hash.match(/^#setup=([a-f0-9]{64})$/)?.[1] || null;
  if (token) history.replaceState(null,'',location.pathname + location.search);
  return token;
}
let pendingSetupToken = readSetupToken();
const readCliRequest=()=>location.hash.match(/^#cli=([a-f0-9]{64})$/)?.[1]||null;
let pendingCliRequest=readCliRequest();
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const paths = {
  grid:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  apps:'M4 7h16v13H4z M8 7V4h8v3 M4 12h16', layers:'m12 3 9 5-9 5-9-5 9-5z M3 12l9 5 9-5 M3 16l9 5 9-5',
  rocket:'M13 4c3-2 7-1 7-1s1 4-1 7l-7 7-5-5 6-8z M7 12l-4 1v5l4-1 M12 17l-1 4h5l1-4 M5 20l-2 1 1-3 M15 7h.01',
  branch:'M6 4v12a3 3 0 0 0 6 0v-1a5 5 0 0 1 5-5 M6 4a2 2 0 1 0 .01 0 M17 6a2 2 0 1 0 .01 0',
  activity:'M3 12h4l3-8 4 16 3-8h4', book:'M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1z M12 5v15',
  plus:'M12 5v14 M5 12h14', arrow:'M5 12h14 M14 7l5 5-5 5', chevron:'m9 5 7 7-7 7', down:'m6 9 6 6 6-6',
  terminal:'m5 7 5 5-5 5 M13 17h6', copy:'M8 8h12v13H8z M16 8V3H3v13h5',
  globe:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M3 12h18 M12 3c-5 5-5 13 0 18 5-5 5-13 0-18',
  check:'m5 12 4 4L19 6', clock:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M12 7v5l3 2',
  upload:'M12 16V3 M7 8l5-5 5 5 M4 15v6h16v-6', download:'M12 3v13 M7 11l5 5 5-5 M4 16v5h16v-5',
  close:'m6 6 12 12 M6 18 18 6', search:'M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0 M15 15l6 6',
  device:'M7 2h10v20H7z M11 18h2', shield:'m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3z M8 12l3 3 5-6',
  undo:'M4 10h10a6 6 0 0 1 0 12 M4 10l5-5 M4 10l5 5', logout:'M10 4H4v16h6 M9 12h12 M16 7l5 5-5 5',
  menu:'M4 6h16 M4 12h16 M4 18h16', info:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M12 11v6 M12 7h.01',
  trash:'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7',
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.grid}"/></svg>`;
const badge = (text, type = '', dot = false) => `<span class="badge ${type}">${dot ? '<span class="status-dot"></span>' : ''}${esc(text)}</span>`;
const button = (label, action, type = '', symbol = '') => `<button class="button ${type}" data-action="${action}">${symbol ? icon(symbol) : ''}${label}</button>`;
const relative = value => {
  const seconds = Math.max(0, (Date.now() - new Date(value)) / 1000);
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
};
const size = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
const count = value => new Intl.NumberFormat().format(value);
const appOf = release => state.data.apps.find(a => a.id === release?.app_id);
const releaseOf = patch => state.data.releases.find(r => r.id === patch.release_id);
function toast(message) {
  clearTimeout(toastTimer); toastElement.textContent = message;
  toastElement.classList.add('visible'); toastTimer = setTimeout(() => toastElement.classList.remove('visible'), 4200);
}
async function api(path, payload, method) {
  const response = await fetch(path, { method: method || (payload ? 'POST' : 'GET'),
    headers: payload ? { 'Content-Type': 'application/json' } : {}, body: payload ? JSON.stringify(payload) : undefined });
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error || 'Request failed.'); error.status = response.status; throw error; }
  return result;
}
async function login() {
  let enabled = false, setup = null, errorMessage = '';
  try {
    enabled = (await api('/api/auth/status')).password_sign_in;
    if (pendingSetupToken) setup = await api('/api/auth/setup/status',{token:pendingSetupToken});
  } catch(error) { errorMessage = error.message; pendingSetupToken = null; }
  const isSetup = !!setup;
  root.innerHTML = `<main class="login"><section class="login-story"><div class="brand"><img src="/logo.svg" alt="">tern<span class="local-label">SELF-HOSTED</span></div><div class="eyebrow">A shorter path to your users</div><h1>Good fixes<br>shouldn’t wait.</h1><p>Your Flutter releases. Your update server. A little more control over what ships next.</p><div class="story-foot">Built for the space between app store releases.</div></section><section class="login-form"><h2>${isSetup ? 'Set your password' : 'Open your console'}</h2><p>${isSetup ? 'Create the administrator password for this Tern workspace.' : 'Sign in to manage your applications, releases, and patches.'}</p><form id="login-form"><div class="field"><label for="login-email">Email address</label><input id="login-email" name="email" type="email" required autocomplete="username" maxlength="254" placeholder="you@example.com" value="${esc(setup?.email || '')}" ${isSetup ? 'readonly' : ''}></div><div class="field"><label for="login-password">${isSetup ? 'New password' : 'Password'}</label><input id="login-password" name="password" type="password" required maxlength="128" autocomplete="${isSetup ? 'new-password' : 'current-password'}" ${isSetup ? 'minlength="15"' : ''}>${isSetup ? '<small>Use 15–128 characters. A passphrase works well.</small>' : ''}</div>${isSetup ? '<div class="field"><label for="login-confirm">Confirm password</label><input id="login-confirm" name="confirmation" type="password" required minlength="15" maxlength="128" autocomplete="new-password"></div>' : ''}<button class="button primary full" type="submit" ${!isSetup && !enabled ? 'disabled' : ''}>${isSetup ? 'Set password and sign in' : 'Sign in to Tern'} ${icon('arrow')}</button><p class="form-error" id="login-error" role="alert">${esc(errorMessage)}</p></form><div class="login-hint">${isSetup ? 'This private setup link expires after one hour and can be used once.' : enabled ? 'Forgot your password? Ask your server administrator for a private recovery link.' : 'An administrator needs to finish account setup. Open your private setup link to create your password.'}</div></section></main>`;
  root.querySelector('#login-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget, submit = form.querySelector('button'); submit.disabled = true;
    try {
      if (isSetup && form.elements.password.value !== form.elements.confirmation.value) throw new Error('The passwords do not match.');
      if (isSetup) await api('/api/auth/setup',{token:pendingSetupToken,password:form.elements.password.value});
      else await api('/api/session',{email:form.elements.email.value,password:form.elements.password.value});
      pendingSetupToken = null; form.reset(); await refresh(true);
    } catch(error) { form.querySelector('#login-error').textContent = error.message; }
    finally { submit.disabled = !isSetup && !enabled; }
  });
}
const views = { overview: ['Overview',''], applications: ['Applications','A home for every Flutter app you ship.'], releases: ['Releases','The store builds your patches are based on.'], patches: ['Patches','Small updates. A shorter trip to production.'], channels: ['Channels','Give each update a safe path to production.'], activity: ['Activity','An audit trail of releases, patches, and installs.'], docs: ['Getting started','From your first release to your next fix.'] };
function shell() {
  const nav = [['overview','grid','Overview'],['applications','apps','Applications'],['releases','layers','Releases'],['patches','rocket','Patches'],['channels','branch','Channels'],['activity','activity','Activity']];
  root.innerHTML = `<div class="shell"><aside class="sidebar"><a class="brand" href="#overview" aria-label="Tern overview"><img src="/logo.svg" alt="">tern</a><div class="workspace"><span class="workspace-avatar">W</span><span class="workspace-name">My workspace<small class="muted small"> · local</small></span>${icon('down')}</div><div class="nav-label">WORKSPACE</div><nav>${nav.map(([view,symbol,label]) => `<button class="nav-link ${state.view === view ? 'active' : ''}" data-nav="${view}" ${state.view === view ? 'aria-current="page"' : ''}>${icon(symbol)}${label}</button>`).join('')}</nav><div class="nav-spacer"></div><div class="nav-label">RESOURCES</div><button class="nav-link ${state.view === 'docs' ? 'active' : ''}" data-nav="docs">${icon('book')}Getting started</button><div class="sidebar-bottom"><div class="server-status"><span class="status-dot"></span>Update server online</div><div class="profile"><div class="avatar">AD</div><button class="profile-account" data-action="account" aria-label="Account settings"><span>Administrator</span><small class="muted small">${esc(state.data.administrator?.email || 'Self-hosted workspace')}</small></button><button data-action="logout" aria-label="Sign out">${icon('logout')}</button></div></div></aside><main class="main"><header class="topbar"><div class="breadcrumbs"><button class="mobile-menu" data-action="menu" aria-label="Toggle navigation">${icon('menu')}</button>${icon('grid')}<span>Workspace</span><span>/</span><strong>${views[state.view][0]}</strong></div><div class="top-actions"><button class="docs-link muted" data-nav="docs">${icon('book')} Documentation</button></div></header><div class="content" id="content">${content()}</div></main></div>`;
}
function pageTitle() {
  const [title, description] = views[state.view];
  const primary = ['overview','applications'].includes(state.view) ? button('New application','new-app','primary','plus')
    : state.view === 'releases' ? button('New release','new-release','primary','plus')
    : state.view === 'patches' ? button('Create patch','new-patch','primary','plus') : '';
  return `<div class="page-title"><div><h1>${title}</h1>${description ? `<p>${description}</p>` : ''}</div><div class="page-buttons">${state.view === 'overview' ? button('CLI guide','guide','secondary-action','terminal') : ''}${primary}</div></div>`;
}
function content() {
  if (!state.data) return '';
  return pageTitle() + ({ overview, applications, releases, patches, channels, activity, docs }[state.view])() + `<footer class="footer"><span>Tern · Flutter code push, on your terms.</span></footer>`;
}
function overview() {
  const d = state.data;
  const live = new Set(d.deployments.filter(a => a.rollout > 0).map(a => a.patch_id)).size;
  const devices = d.devices.reduce((sum,a) => sum + a.count, 0);
  const totals = d.patches.flatMap(p => p.telemetry);
  const success = totals.filter(t => t.kind === '__patch_install__').reduce((s,t) => s + t.count, 0);
  const failures = totals.filter(t => t.kind === '__patch_install_failure__').reduce((s,t) => s + t.count, 0);
  const health = success + failures ? `${(success / (success + failures) * 100).toFixed(1)}%` : '—';
  const stat = (symbol,label,value,note) => `<div class="stat"><div class="stat-label">${icon(symbol)}${label}</div><div class="stat-value">${value}</div><div class="stat-note">${note}</div></div>`;
  return `${!sessionStorage.getItem('tern-notice-hidden') ? `<div class="notice">${icon('info')}<p><strong>Your update server is ready.</strong> Register a release, test a patch in staging, then send it to stable. Native code updates require an updater-enabled Flutter build.</p><button data-action="hide-notice" aria-label="Dismiss notice">${icon('close')}</button></div>` : ''}<div class="stats">${stat('apps','Applications',count(d.apps.length),'Connected to this workspace')}${stat('rocket','Active patches',count(live),'Deployed with rollout above 0%')}${stat('device','Active installs',count(devices),'Unique installs seen in 30 days')}${stat('shield','Successful installs',health,success + failures ? `${count(success + failures)} reported install outcomes` : 'Waiting for install telemetry')}</div><div class="lower-grid"><section><div class="section-heading"><div><h2>Your applications</h2></div><button class="text-button" data-nav="applications">View all ${icon('arrow')}</button></div>${appCards(d.apps.slice(0,4))}</section><aside class="overview-sidebar"><section class="panel"><div class="panel-header"><h2>Recent activity</h2>${icon('clock')}</div><div class="activity">${activityRows(d.activity.slice(0,5))}</div><div class="panel-bottom"><button class="text-button" data-nav="activity">View all activity ${icon('arrow')}</button></div></section></aside></div>`;
}
function empty(title, description, label, action, symbol='apps') {
  return `<div class="empty"><div class="empty-symbol">${icon(symbol)}</div><h2>${title}</h2><p>${description}</p>${label ? button(label, action, 'primary','plus') : ''}</div>`;
}
function appCards(apps) {
  if (!apps.length) return empty('Your first app starts here','Connect a Flutter application to start keeping track of releases and patches.','New application','new-app');
  return apps.map(app => {
    const rs = state.data.releases.filter(r => r.app_id === app.id);
    const ps = state.data.patches.filter(p => rs.some(r => r.id === p.release_id));
    const live = ps.filter(p => state.data.deployments.some(d => d.patch_id === p.id && d.rollout > 0));
    return `<article class="app-card"><div class="app-card-top"><div class="app-icon">${esc(app.name.charAt(0).toUpperCase())}</div><div class="app-card-title"><button class="app-name" data-open-app="${app.id}">${esc(app.name)}</button><div class="mono">${esc(app.id)}</div></div><div class="app-card-meta">${badge(live.length ? 'Patches live' : rs.length ? 'Release ready' : 'Getting started', live.length ? '' : 'gray', !!live.length)}<button class="button icon-button" data-open-app="${app.id}" aria-label="Open ${esc(app.name)}">${icon('chevron')}</button><button class="button icon-button danger" data-delete-app="${app.id}" aria-label="Delete ${esc(app.name)}" title="Delete application">${icon('trash')}</button></div></div><div class="app-card-bottom"><span>${icon('layers')}<strong>${rs.length ? esc(rs[0].version) : 'No releases yet'}</strong>${rs.length ? ` &nbsp;·&nbsp; ${esc([...new Set(rs.map(r => r.platform))].join(', '))}` : ''}</span><span>${ps.length} ${ps.length === 1 ? 'patch' : 'patches'} &nbsp;·&nbsp; ${relative(app.created_at)}</span></div></article>`;
  }).join('');
}
function applications() {
  const apps = state.data.apps.filter(a => a.name.toLowerCase().includes(state.search.toLowerCase()));
  return `<div class="filter-row"><span class="muted small">${state.data.apps.length} applications</span><div class="search">${icon('search')}<input id="app-search" aria-label="Search applications" placeholder="Search applications…" value="${esc(state.search)}"></div></div><div id="app-list">${apps.length || !state.search ? appCards(apps) : empty('No matching applications','Try a different application name.','','')}</div>`;
}
function appFilter() {
  return `<div class="details-bar"><span class="muted small">Application</span><select id="app-filter" aria-label="Filter by application"><option value="">All applications</option>${state.data.apps.map(a => `<option value="${a.id}" ${state.app === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>${state.app ? '<button class="text-button" data-action="clear-filter">Clear filter</button>' : ''}<span class="last-refresh">Updates automatically</span></div>`;
}
function releases() {
  const list = state.data.releases.filter(r => !state.app || r.app_id === state.app);
  return appFilter() + (list.length ? `<div class="panel table-wrap"><table><thead><tr><th>Release</th><th>Application</th><th>Platform</th><th>Architectures</th><th>Created</th><th></th></tr></thead><tbody>${list.map(r => `<tr><td><strong class="mono">${esc(r.version)}</strong><div class="subtext mono" title="${esc(r.engine_version)}">${esc(r.engine_version.slice(0,22))}</div></td><td>${esc(appOf(r)?.name)}</td><td>${badge(r.platform,'blue')}</td><td class="mono">${esc(r.artifacts.map(a => a.arch).join(', '))}</td><td class="muted">${relative(r.created_at)}</td><td><button class="button" data-patch-release="${r.id}">${icon('plus')} Create patch</button></td></tr>`).join('')}</tbody></table></div>` : empty('Register a store release','Upload compiled Dart artifacts from an updater-enabled Flutter engine. Each release becomes the permanent base for its patches.','New release','new-release','layers'));
}
function patches() {
  const list = state.data.patches.filter(p => (!state.app || releaseOf(p)?.app_id === state.app) && (state.tab === 'all' || p.status === state.tab));
  return appFilter() + `<div class="tabs">${[['all','All patches'],['active','Available'],['revoked','Rolled back']].map(([key,label]) => `<button class="tab ${state.tab === key ? 'active' : ''}" data-tab="${key}">${label}</button>`).join('')}</div>` + (list.length ? `<div class="panel table-wrap"><table><thead><tr><th>Patch</th><th>Release</th><th>Distribution</th><th>Download size</th><th>Installs</th><th>Actions</th></tr></thead><tbody>${list.map(p => {
    const r = releaseOf(p), deployments = state.data.deployments.filter(d => d.patch_id === p.id);
    const installs = p.telemetry.filter(t => t.kind === '__patch_install__').reduce((s,t) => s + t.count,0);
    return `<tr><td><strong>Patch ${p.number}</strong><div class="subtext" title="${esc(p.notes)}">${esc(p.notes.slice(0,32) || 'No release notes')}</div></td><td><span class="mono">${esc(r.version)}</span><div class="subtext">${esc(appOf(r)?.name)} · ${r.platform}</div></td><td>${p.status === 'revoked' ? badge('Rolled back','red') : deployments.length ? deployments.map(d => badge(`${d.channel} · ${d.rollout}%`, d.channel === 'stable' ? '' : 'blue')).join(' ') : badge('Ready to deploy','gray')}</td><td class="mono">${size(p.artifacts.reduce((sum,a) => sum+a.size,0))}<div class="subtext">${p.artifacts.length} architecture${p.artifacts.length === 1 ? '' : 's'}</div></td><td>${count(installs)}<div class="subtext">reported successful</div></td><td><div class="table-actions">${p.status === 'active' ? `<button class="button" data-deploy="${p.id}">${icon('rocket')} Deploy</button><button class="button danger" data-rollback="${p.id}" aria-label="Roll back patch ${p.number}">${icon('undo')}</button>` : badge('Revoked','gray')}</div></td></tr>`;
  }).join('')}</tbody></table></div>` : empty('No patches here yet','Build a fix with the same Flutter toolchain as your release, then upload the updated Dart artifacts.','Create patch','new-patch','rocket'));
}
function channels() {
  return appFilter() + `<div class="channel-grid">${[['staging','terminal','Test a patch on your own devices.'],['beta','branch','Start small with a stable install cohort.'],['stable','globe','Updates for your production users.']].map(([channel,symbol,description]) => {
    const deployments = state.data.deployments.filter(d => d.channel === channel && (!state.app || state.data.releases.find(r => r.id === d.release_id)?.app_id === state.app));
    return `<section class="panel channel-card"><div class="section-heading"><h2>${channel.charAt(0).toUpperCase() + channel.slice(1)}</h2>${icon(symbol)}</div><p>${description}</p>${deployments.length ? deployments.map(d => {
      const p = state.data.patches.find(p => p.id === d.patch_id),r = releaseOf(p);
      return `<div class="channel-deployment"><strong>${esc(appOf(r)?.name)}</strong><div class="muted">${esc(r.version)} · ${r.platform} · Patch ${p.number}</div><progress class="rollout-progress" value="${d.rollout}" max="100" aria-label="${d.rollout}% rollout"></progress><div class="progress-caption"><span>${d.rollout === 0 ? 'Paused' : 'Rollout'}</span><span>${d.rollout}% of eligible installs</span></div><button class="text-button" data-deploy="${p.id}" data-channel="${channel}">Manage rollout ${icon('arrow')}</button></div>`;
    }).join('') : `<div class="activity-empty">No patches deployed to ${channel}.</div>`}</section>`;
  }).join('')}</div><div class="notice channel-note">${icon('info')}<p>Rollouts use a stable cohort for each release and channel. Increasing the percentage adds installs. Reducing it stops new downloads; use rollback to revoke an installed patch.</p></div>`;
}
function activityRows(rows) {
  if (!rows.length) return '<div class="activity-empty">Your next release starts the story. Activity will appear here as you ship.</div>';
  return rows.map(a => {
    const isRollback = a.kind === 'patch_rolled_back' || a.kind.includes('failure');
    const symbol = a.kind === 'app_created' ? 'apps' : a.kind === 'release_created' ? 'layers' : a.kind === '__patch_install__' ? 'check' : isRollback ? 'undo' : a.kind === '__patch_download__' ? 'download' : 'rocket';
    const message = a.kind === '__patch_install__' ? `Patch ${a.patch_number} installed successfully.` : a.kind === '__patch_download__' ? `Patch ${a.patch_number} downloaded.` : a.kind.includes('failure') ? `Patch ${a.patch_number} reported an update failure.` : a.message;
    return `<div class="activity-row"><div class="activity-symbol ${isRollback ? 'orange' : symbol === 'check' ? 'green' : ''}">${icon(symbol)}</div><div class="activity-text"><p><strong>${esc(a.app_name)}</strong><br>${esc(message)}</p><small title="${esc(new Date(a.created_at).toLocaleString())}">${relative(a.created_at)}</small></div></div>`;
  }).join('');
}
function activity() {
  return `<div class="panel activity-page"><div class="panel-header"><h2>Recent workspace events</h2><span class="muted small">Latest 50 events · server receipt time</span></div><div class="activity">${activityRows(state.data.activity)}</div></div>`;
}
function docs() {
  const code = lines => '<pre>' + esc(lines.join('\n')) + '</pre>';
  const server = location.origin;
  return `<div class="docs"><div class="notice">${icon('check')}<p><strong>Before you begin.</strong> Tern delivers Dart code updates to Flutter Android apps. A new app needs a Tern-enabled release installed on devices before it can receive patches. An existing app keeps the runtime used by its installed release.</p></div>
  <section class="panel panel-body"><h2>1. Install Tern</h2><p>Install a patched Node.js 24 or 26 release, then download the Tern npm package. Run this command in the folder containing the downloaded file; npm adds tern to your PATH.</p><p><a class="button primary" href="/api/cli/downloads/npm">${icon('download')} Download npm package</a></p>${code(['npm install -g ./tern-cli-0.2.0.tgz','tern login --server ' + server])}<p>Reopen your terminal if tern is not found. Git, Java 17+, and Android SDK tools are still needed to build apps. The self-contained <a href="/api/cli/downloads/windows-x64">Windows installer</a> remains available if you prefer it.</p><p>Approve the machine in your browser after checking that its verification code matches your terminal. Manage and revoke machine access below.</p><p>${button('Manage connected machines','machines','','device')}</p></section>
  <section class="panel panel-body"><h2>2. Connect a Flutter application</h2><p>Open a terminal in your Flutter project folder. To register a new app and add Tern’s Android integration:</p>${code(['tern init --name "My app" --configure-runtime --server ' + server,'tern setup','tern doctor'])}<p>Add TernUpdateScope and the update banner to your Flutter UI. Use Android API 26 or later and an explicit app version such as 1.0.0+1.</p><p>Already registered this project on another machine? Run the following commands instead:</p>${code(['tern connect','tern setup','tern doctor'])}<p>Tern keeps the runtime used by an existing release. Restore the project’s Android signing configuration and, when required, import its encrypted patch-signing key before building a patch.</p></section>
  <section class="panel panel-body"><h2>3. Build your first release</h2>${code(['tern release'])}<p>Tern builds an updater-enabled APK and records the original build for future patches. Install or distribute the APK shown in the output; devices need this baseline before they can receive updates. Keep the original APK, and back up the patch-signing key with tern keys export. If an upload is interrupted, retry with tern release --resume.</p></section>
  <section class="panel panel-body"><h2>4. Build and deploy a fix</h2>${code(['tern patch --notes "Fix checkout"','tern deploy --patch PATCH_ID --channel staging --rollout 100'])}<p>Edit Dart code while keeping the original version and build number. Tern rejects native, asset, and runtime changes that require a new store release. Let the original installed app download the patch, then restart it to run the fix. Promote the tested patch to beta or stable in the dashboard.</p></section>
  <section class="panel panel-body"><h2>Rollback and application deletion</h2>${code(['tern rollback --patch PATCH_ID'])}<p>Rollback permanently revokes a patch on every channel. Devices learn about it on their next check and return to valid code on restart. To remove an application, open Applications, click its delete button, and type its exact name. Deletion permanently removes its releases, patches, deployments, and metrics, and stops future updates for that application.</p></section>
  <section class="panel panel-body"><h2>Compatibility and migration</h2><p>New Android apps use Tern’s native updater and a pinned official Flutter toolchain. For an app with an existing release, keep its runtime and version when building patches. Changing runtimes requires a new app version and a new baseline APK. iOS support and physical ARM-device validation are still pending.</p><p><a href="https://github.com/hatchmoon/tern/blob/main/docs/INDEPENDENT_RUNTIME.md" target="_blank" rel="noreferrer">Tern runtime setup and migration ↗</a></p></section></div>`;
}
function showModal(title, description, fields, actionLabel, handler, danger = false) {
  modal.innerHTML = `<form id="modal-form"><div class="modal-heading"><h2 id="modal-title">${title}</h2><button type="button" data-action="close-modal" aria-label="Close dialog">${icon('close')}</button></div><p class="modal-description">${description}</p>${fields}<p class="form-error" role="alert" id="modal-error"></p><div class="modal-actions"><button class="button" type="button" data-action="close-modal">Cancel</button><button class="button ${danger ? 'danger' : 'primary'}" type="submit" id="modal-submit">${actionLabel}</button></div></form>`;
  modal.onsubmit = async event => {
    event.preventDefault(); const form = event.target; const submit = form.querySelector('#modal-submit'); submit.disabled = true;
    try { await handler(form); modal.close(); await refresh(true); }
    catch (error) { modal.querySelector('#modal-error').textContent = error.message; }
    finally { submit.disabled = false; }
  };
  modal.showModal();
}
const inputField = (name,label,placeholder='',value='',type='text') => `<div class="field"><label for="field-${name}">${label}</label><input id="field-${name}" name="${name}" type="${type}" placeholder="${esc(placeholder)}" value="${esc(value)}" required></div>`;
const selectField = (name,label,options) => `<div class="field"><label for="field-${name}">${label}</label><select id="field-${name}" name="${name}" required>${options}</select></div>`;
const appOptions = () => state.data.apps.map(a => `<option value="${a.id}" ${a.id === state.app ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
function newApp() {
  showModal('New application','Give your Flutter app a home in this workspace.',inputField('name','Application name','e.g. Harbor mobile'),'Create application',async form => {
    await api('/api/apps',{ name:form.elements.name.value }); toast('Application created. You can now register its first release.');
  });
}
function accountSettings() {
  if (!state.data.administrator?.email) return toast('Finish administrator account setup first.');
  showModal('Change password',`Signed in as ${esc(state.data.administrator.email)}.`,
    inputField('current_password','Current password','','','password') + inputField('new_password','New password','','','password') + inputField('confirmation','Confirm new password','','','password') + '<div class="upload-note">Use 15–128 characters. Changing your password signs out other browser sessions.</div>',
    'Update password',async form => {
      if (form.elements.new_password.value !== form.elements.confirmation.value) throw new Error('The passwords do not match.');
      await api('/api/account/password',{current_password:form.elements.current_password.value,new_password:form.elements.new_password.value});
      form.reset(); toast('Password updated. Other browser sessions have been signed out.');
    });
  modal.querySelector('[name="current_password"]').autocomplete = 'current-password';
  for (const name of ['new_password','confirmation']) {
    const input = modal.querySelector(`[name="${name}"]`); input.autocomplete = 'new-password'; input.minLength = 15; input.maxLength = 128;
  }
}
function deleteApp(id) {
  const app = state.data.apps.find(a => a.id === id);
  if (!app) return;
  showModal('Delete application',`Permanently delete <strong>${esc(app.name)}</strong> and its releases, patches, deployments, and device metrics? Installed apps will stop receiving updates from this application.`,
    inputField('confirm_name','Type the application name to confirm',app.name), 'Delete application', async form => {
      if (form.elements.confirm_name.value !== app.name) throw new Error('Type the exact application name to confirm deletion.');
      const result = await api(`/api/apps/${encodeURIComponent(id)}`,{confirm_name:form.elements.confirm_name.value},'DELETE');
      if (state.app === id) state.app = '';
      toast(result.artifact_cleanup_pending ? 'Application deleted. Some artifact files could not be removed; check the server logs.' : 'Application deleted.');
    }, true);
  modal.querySelector('[name="confirm_name"]').autocomplete = 'off';
}
function fileRow(arch='aarch64',fixed=false) {
  return `<div class="file-row"><select name="arch" aria-label="Artifact architecture" ${fixed ? 'disabled' : ''}>${['aarch64','arm','x86_64','x86'].map(a => `<option ${a === arch ? 'selected' : ''}>${a}</option>`).join('')}</select><input type="file" name="binary" aria-label="Compiled Dart binary for ${arch}" required></div>`;
}
async function collectArtifacts(form) {
  const rows = [...form.querySelectorAll('.file-row')];
  let total = 0;
  return Promise.all(rows.map(async row => {
    const file = row.querySelector('input').files[0];
    if (!file) throw new Error('Choose a binary file for every architecture.');
    total += file.size;
    if (total > 64 * 1024 * 1024) throw new Error('Combined artifacts must be at most 64 MiB.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let i=0;i<bytes.length;i+=8192) binary += String.fromCharCode(...bytes.subarray(i,i+8192));
    return { arch:row.querySelector('select').value, data:btoa(binary) };
  }));
}
function newRelease() {
  if (!state.data.apps.length) { toast('Create an application first.'); return newApp(); }
  showModal('Register a release','Upload the original compiled Dart binary from your store build.',
    selectField('app','Application',appOptions()) + `<div class="field-row">${inputField('version','Release version','1.0.0+1')}${selectField('platform','Platform',['android','ios','windows','macos','linux'].map(p => `<option>${p}</option>`).join(''))}</div>` + inputField('engine','Engine revision','Exact updater-enabled engine revision') + '<div class="artifact-label">Compiled Dart artifacts</div><div id="artifact-rows">'+fileRow()+'</div><button class="text-button" type="button" data-action="add-architecture">+ Add architecture</button><p class="artifact-help">Upload extracted libapp.so or equivalent compiled code. Maximum 64 MiB total. Do not upload an APK or AAB.</p>',
    'Register release',async form => {
      await api('/api/releases',{ app_id:form.elements.app.value,version:form.elements.version.value,platform:form.elements.platform.value,engine_version:form.elements.engine.value,artifacts:await collectArtifacts(form) });
      state.view='releases'; toast('Release registered. Original artifacts are now immutable.');
    });
}
function newPatch(releaseId) {
  if (!state.data.releases.length) { toast('Register a release before creating a patch.'); return newRelease(); }
  const list = state.data.releases.filter(r => !state.app || r.app_id === state.app);
  const release = list.find(r => r.id === releaseId) || list[0] || state.data.releases[0];
  function patchFields(r) {
    return `<div class="upload-note">Base release: <strong>${esc(r.version)}</strong> for ${r.platform}. Every architecture in the original release must be included.${r.build_manifest ? '<br>This release uses Tern’s managed runtime. The CLI builds and uploads a patch with its compatibility manifest: <code>tern patch --project YOUR_APP</code>' : ''}</div>${inputField('engine','Engine revision','Must match the original release',r.engine_version)}<div class="artifact-label">Updated compiled Dart artifacts</div><div id="artifact-rows">${r.artifacts.map(a => fileRow(a.arch,true)).join('')}</div>${r.build_manifest ? '<div class="field"><label for="native-build-manifest">Patch build manifest</label><input type="file" id="native-build-manifest" accept="application/json,.json" required><small>Use the build-manifest.json generated alongside your compiled patch APK. Native files and bundled assets must match the release.</small></div>' : ''}<p class="artifact-help">Build with the original toolchain. The server checks the declared engine revision and reconstructs each uploaded binary.</p>`;
  }
  showModal('Create a patch','Upload your compiled fix. You’ll choose a deployment channel next.',
    selectField('release','Base release',state.data.releases.map(r => `<option value="${r.id}" ${r.id === release.id ? 'selected' : ''}>${esc(appOf(r)?.name)} · ${esc(r.version)} · ${r.platform}</option>`).join('')) + `<div id="patch-fields">${patchFields(release)}</div><div class="field"><label for="patch-notes">Release notes</label><textarea id="patch-notes" name="notes" maxlength="1000" placeholder="What does this patch fix?"></textarea></div>`,
    'Create patch',async form => {
      const manifest=form.querySelector('#native-build-manifest')?.files[0];
      await api('/api/patches',{ release_id:form.elements.release.value,engine_version:form.elements.engine.value,notes:form.elements.notes.value.trim() || undefined,artifacts:await collectArtifacts(form),build_manifest:manifest ? JSON.parse(await manifest.text()) : undefined });
      state.view='patches';state.tab='all'; toast('Patch created. Deploy it to staging to begin testing.');
    });
  modal.querySelector('[name="release"]').addEventListener('change',event => {
    modal.querySelector('#patch-fields').innerHTML = patchFields(state.data.releases.find(r => r.id === event.target.value));
  });
}
function deployPatch(id,channel) {
  const p = state.data.patches.find(p => p.id === id),r = releaseOf(p);
  const current = state.data.deployments.find(d => d.patch_id === id && d.channel === channel);
  showModal(`Deploy patch ${p.number}`,`${esc(appOf(r)?.name)} · ${esc(r.version)} · ${r.platform}`,
    selectField('channel','Channel',['staging','beta','stable'].map(c => `<option value="${c}" ${c === (channel || 'staging') ? 'selected' : ''}>${c.charAt(0).toUpperCase()+c.slice(1)}</option>`).join('')) + inputField('rollout','Rollout percentage','0–100',current?.rollout ?? 100,'number') + '<div class="upload-note">The same installs stay in the rollout as you increase its percentage. Setting 0 pauses new downloads. Existing installs keep their patch until it is revoked.</div>',
    'Deploy patch',async form => {
      await api(`/api/patches/${id}/deploy`,{ channel:form.elements.channel.value,rollout:Number(form.elements.rollout.value) }); toast('Patch deployed. Eligible devices receive it on their next update check.');
    });
  const rolloutInput = modal.querySelector('[name="rollout"]'); rolloutInput.min='0'; rolloutInput.max='100'; rolloutInput.step='1';
}
function rollbackPatch(id) {
  const p = state.data.patches.find(p => p.id === id),r = releaseOf(p);
  showModal(`Roll back patch ${p.number}?`,`${esc(appOf(r)?.name)} · ${esc(r.version)}`,
    '<div class="upload-note">This permanently revokes the patch on every channel. Devices learn about the rollback on their next check and stop using this patch on restart. Create a new patch to ship the fix again.</div>',
    'Revoke patch',async () => { await api(`/api/patches/${id}/rollback`,{});toast(`Patch ${p.number} revoked on every channel.`); },true);
}
async function cliApproval(){
  const request=await api('/api/cli/approval?id='+encodeURIComponent(pendingCliRequest));
  root.innerHTML=`<main class="login cli-authorization"><section class="login-form"><div class="brand"><img src="/logo.svg" alt="">tern</div><h1>Connect this machine?</h1><p><strong>${esc(request.machine)}</strong> is requesting CLI access to this workspace. It will be able to manage applications, releases, patches, and deployments for up to 90 days.</p><p>Only approve a request you started yourself. Enter the verification code shown in your terminal.</p><form id="cli-approval"><div class="field"><label for="cli-code">Terminal verification code</label><input id="cli-code" name="code" autocomplete="off" maxlength="8" minlength="8" required placeholder="8-character code"></div><button class="button primary" type="submit" ${request.status!=='pending'?'disabled':''}>Approve machine</button> <button class="button" id="cli-decline" type="button">Decline</button><p class="form-error" role="alert"></p></form></section></main>`;
  const form=root.querySelector('#cli-approval');
  async function decide(approve){
    try{
      await api('/api/cli/approval',{id:pendingCliRequest,code:approve?form.elements.code.value.trim().toUpperCase():request.code,approve});
      pendingCliRequest=null;history.replaceState(null,'','#docs');state.view='docs';
      root.innerHTML='<main class="login"><section class="login-form"><h1>'+ (approve?'Machine approved':'Request declined')+'</h1><p>'+(approve?'Return to your terminal to finish signing in.':'This machine was not granted access.')+'</p><a href="/">Open dashboard</a></section></main>';
    }catch(error){form.querySelector('.form-error').textContent=error.message;}
  }
  form.addEventListener('submit',event=>{event.preventDefault();decide(true);});
  root.querySelector('#cli-decline').addEventListener('click',()=>decide(false));
}
async function connectedMachines(){
  try{
    const {credentials}=await api('/api/cli/credentials');
    const list=credentials.filter(c=>!c.revoked&&c.expires_at>Date.now());
    showModal('Connected machines','CLI access expires after 90 days. Changing your account password also invalidates machine credentials.',list.length?list.map(c=>`<div class="panel panel-body"><strong>${esc(c.machine)}</strong><p>Expires ${esc(new Date(c.expires_at).toLocaleDateString())} · Last used ${c.last_used?esc(relative(c.last_used)):'never'}</p><button class="button danger" type="button" data-revoke-machine="${esc(c.id)}">Revoke access</button></div>`).join(''):'<p>No machines connected.</p>','Done',async()=>{});
  }catch(error){toast(error.message);}
}
async function refresh(force=false) {
  if (pendingSetupToken) { if(modal.open)modal.close(); await login(); return; }
  try {
    const data = await api('/api/snapshot');
    if(pendingCliRequest){
      try{await cliApproval();}catch(error){if(error.status===401)throw error;root.innerHTML='<main class="login"><section class="login-form"><h1>Unable to connect</h1><p>'+esc(error.message)+'</p><p>Run tern login again to start a new request.</p><a href="/">Open dashboard</a></section></main>';}
      return;
    }
    const compare = d => d && JSON.stringify({...d,server_time:undefined});
    const changed = compare(state.data) !== compare(data);
    state.data=data; state.online=true;
    if (force || changed || !root.querySelector('.shell')) shell();
    const status = root.querySelector('.server-status'); if(status) status.innerHTML='<span class="status-dot"></span>Update server online';
  } catch(error) {
    if(error.status===401) {state.data=null;if(modal.open)modal.close();await login();}
    else {state.online=false;const status=root.querySelector('.server-status');if(status)status.textContent='Server unreachable · retrying';else root.innerHTML='<div class="initial-loading"><p>Could not reach the server. Reconnecting…</p></div>';}
  }
}
function navigate(view) { state.view=view;state.search='';history.replaceState(null,'',`#${view}`);shell();window.scrollTo(0,0); }
document.addEventListener('click',async event => {
  const target = event.target.closest('button,a'); if(!target)return;
  if(target.matches('a.brand')){event.preventDefault();return navigate('overview');}
  if(target.dataset.nav) return navigate(target.dataset.nav);
  if(target.dataset.openApp) {state.app=target.dataset.openApp;return navigate('releases');}
  if(target.dataset.deleteApp) return deleteApp(target.dataset.deleteApp);
  if(target.dataset.tab) {state.tab=target.dataset.tab;return shell();}
  if(target.dataset.patchRelease) return newPatch(target.dataset.patchRelease);
  if(target.dataset.deploy) return deployPatch(target.dataset.deploy,target.dataset.channel);
  if(target.dataset.rollback) return rollbackPatch(target.dataset.rollback);
  const action=target.dataset.action;
  if(action==='new-app')newApp();
  if(action==='account')accountSettings();
  if(action==='machines')connectedMachines();
  if(target.dataset.revokeMachine){
    try{await api('/api/cli/credentials/'+encodeURIComponent(target.dataset.revokeMachine),null,'DELETE');modal.close();toast('Machine access revoked.');await connectedMachines();}catch(error){toast(error.message);}return;
  }
  if(action==='new-release')newRelease();
  if(action==='new-patch')newPatch();
  if(action==='guide')navigate('docs');
  if(action==='close-modal')modal.close();
  if(action==='menu')root.querySelector('.sidebar').classList.toggle('is-open');
  if(action==='clear-filter'){state.app='';shell();}
  if(action==='hide-notice'){sessionStorage.setItem('tern-notice-hidden','1');shell();}
  if(action==='add-architecture'){
    const rows=modal.querySelectorAll('.file-row');
    if(rows.length>=4)return toast('A release supports up to four architectures.');
    modal.querySelector('#artifact-rows').insertAdjacentHTML('beforeend',fileRow(['aarch64','arm','x86_64','x86'][rows.length]));
  }
  if(action==='logout'){try{await api('/api/session',null,'DELETE');state.data=null;await login();}catch(error){toast(error.message);}}
  if(action==='copy-help'){try{await navigator.clipboard.writeText('tern --help');toast('CLI command copied.');}catch{toast('Run: tern --help');}}
});
document.addEventListener('input',event=>{
  if(event.target.id==='app-search'){
    state.search=event.target.value;
    const apps=state.data.apps.filter(a=>a.name.toLowerCase().includes(state.search.toLowerCase()));
    document.querySelector('#app-list').innerHTML=apps.length ? appCards(apps) : empty('No matching applications','Try a different application name.','','');
  }
});
document.addEventListener('change',event=>{if(event.target.id==='app-filter'){state.app=event.target.value;shell();}});
const initialView=location.hash.slice(1);if(views[initialView])state.view=initialView;
window.addEventListener('hashchange',async()=>{
  const cli=readCliRequest();if(cli){pendingCliRequest=cli;await refresh();return;}
  const token=readSetupToken();
  if(token){pendingSetupToken=token;await refresh();}
});
await refresh();
setInterval(()=>{if(!document.hidden&&!modal.open&&!document.activeElement?.matches('input,select,textarea'))refresh();},10_000);
