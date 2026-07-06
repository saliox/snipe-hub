const $ = (id) => document.getElementById(id);
const H = window.hub;
let current = null;   // plateforme sélectionnée
let info = null;      // infos de l'adaptateur courant
let soonMode = false; // plateforme « bientôt » sélectionnée -> actions verrouillées

// Verrouille/déverrouille les actions (plateforme pas encore branchée).
function setSoon(on) {
  soonMode = on;
  ['loginBtn', 'checkBtn', 'snipeBtn', 'watchAddBtn'].forEach((id) => { $(id).disabled = on; });
}

// ---------- Journal ----------
function logLine(line, pid) {
  const el = $('log');
  el.textContent += (pid ? `[${pid}] ` : '') + line + '\n';
  el.scrollTop = el.scrollHeight;
}
H.onLog((d) => logLine(d.line, d.pid));
$('logClear').onclick = () => { $('log').textContent = ''; };

// ---------- Version + MàJ ----------
(async () => { try { $('version').textContent = 'v' + (await H.version()); } catch {} })();
$('updateBtn').onclick = async () => {
  logLine('⟳ Vérification des mises à jour…');
  const r = await H.updateCheck();
  if (!r || !r.ok) { logLine('❌ MàJ : ' + ((r && r.error) || 'échec de la vérification.')); return; }
  if (r.updateAvailable) {
    if (confirm(`Mise à jour ${r.version} disponible (tu as v${r.current}). Installer et redémarrer maintenant ?`)) {
      logLine(`⬇️ Installation de la v${r.version}…`);
      const a = await H.updateApply();
      if (a && a.ok === false) logLine('❌ MàJ : ' + a.error);
    }
  } else logLine(`✔️ Déjà à jour (v${r.current}).`);
};
// Progression / statut poussés par le processus principal pendant le téléchargement.
H.onUpdate && H.onUpdate((d) => {
  if (!d) return;
  if (d.state === 'available') logLine(`🆕 Version ${d.version} disponible (bouton « MàJ » pour installer).`);
  else if (d.state === 'downloading') logLine('⬇️ Téléchargement de la mise à jour…');
  else if (d.state === 'installing') logLine('⚙️ Installation… l\'application va redémarrer.');
  else if (d.state === 'error') logLine('❌ MàJ : ' + d.error);
});
H.onUpdateProgress && H.onUpdateProgress((p) => { if (p && p.pct != null) $('version').textContent = `MàJ ${p.pct}%`; });

// ---------- Plateformes (sidebar) ----------
async function loadPlatforms() {
  const list = await H.platforms();
  const box = $('platforms'); box.innerHTML = '';
  for (const p of list) {
    const b = document.createElement('button');
    b.className = 'pf-item' + (p.soon ? ' soon' : '');
    b.innerHTML = `<span class="e">${p.emoji}</span> <span>${p.label}</span>${p.soon ? '<span class="badge">bientôt</span>' : ''}`;
    b.onclick = () => selectPlatform(p.id);   // les « bientôt » sont cliquables : elles montrent un aperçu
    if (p.soon) b.title = 'Bientôt disponible';
    b.dataset.pid = p.id;
    box.appendChild(b);
  }
}

async function selectPlatform(pid) {
  current = pid;
  [...document.querySelectorAll('.pf-item')].forEach((e) => e.classList.toggle('active', e.dataset.pid === pid));
  const r = await H.info(pid);
  if (!r.ok) { logLine('❌ ' + r.error); return; }
  info = r;
  $('pfEmoji').textContent = r.emoji;
  $('pfLabel').textContent = r.soon ? r.label + ' — bientôt' : r.label;
  $('pfNeeds').textContent = r.needs || '';

  if (r.soon) {
    // Aperçu d'une plateforme pas encore branchée : on informe et on verrouille les actions.
    $('acct').textContent = '⏳ Bientôt disponible';
    $('acct').className = 'acct muted';
    $('loginArg').classList.add('hidden');
    $('guildId').classList.add('hidden');
    $('snipePassword').classList.add('hidden');
    $('logoutBtn').classList.add('hidden');
    $('accounts').classList.add('hidden');
    $('bulkCard').classList.add('hidden');
    setSoon(true);
    return;
  }
  setSoon(false);

  // Champs selon la plateforme
  const needsGuild = (r.extraFields || []).some((f) => f.key === 'guildId');
  const needsPassword = (r.extraFields || []).some((f) => f.key === 'password');
  $('guildId').classList.toggle('hidden', !needsGuild);
  $('snipePassword').classList.toggle('hidden', !needsPassword);
  // Type de connexion
  const kind = r.loginKind;
  $('loginArg').classList.toggle('hidden', kind === 'device');
  $('loginArg').placeholder = kind === 'token'
    ? (pid === 'twitch' ? 'colle ton jeton OAuth Twitch…'
      : pid === 'x' ? 'cookies x.com : auth_token=…; ct0=…'
      : 'token(s) de bot — plusieurs séparés par des virgules')
    : kind === 'code' ? 'colle ton authorizationCode…'
    : kind === 'cookie' ? 'colle ton cookie .ROBLOSECURITY…' : '';
  $('loginBtn').textContent = kind === 'device' ? 'Connexion (device code)' : 'Enregistrer';
  $('bulkCard').classList.toggle('hidden', !r.bulk);
  refreshAccount();
  renderAccounts(pid);
}

async function refreshAccount() {
  if (!current) return;
  const r = await H.whoami(current);
  const acct = r.ok && r.account;
  $('acct').textContent = acct ? `✅ ${acct.name}` : '⚪ non connecté';
  $('acct').className = 'acct ' + (acct ? 'ok' : 'muted');
  $('logoutBtn').classList.toggle('hidden', !acct);
}

// ---------- Comptes / bots (multi) ----------
async function renderAccounts(pid) {
  const box = $('accounts');
  let r;
  try { r = await H.accounts(pid); } catch { box.classList.add('hidden'); box.innerHTML = ''; return; }
  const items = (r && r.items) || [];
  if (!r || !r.mode || !items.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  box.innerHTML = `<div class="acc-title">${r.mode === 'all' ? 'Bots — tous tirent ensemble' : 'Comptes — clique pour activer'}</div>`;
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'acc-row' + (it.active && r.mode === 'select' ? ' active' : '');
    const name = document.createElement('button');
    name.className = 'acc-name';
    name.textContent = (it.active && r.mode === 'select' ? '● ' : '') + it.label;
    if (r.mode === 'select') name.onclick = async () => { const rr = await H.accountSetActive(pid, it.id); if (rr && rr.ok) { renderAccounts(pid); refreshAccount(); } };
    else name.disabled = true;
    const del = document.createElement('button');
    del.className = 'acc-x'; del.textContent = '×'; del.title = 'Retirer ce compte';
    del.onclick = async () => { await H.accountRemove(pid, it.id); renderAccounts(pid); refreshAccount(); };
    row.appendChild(name); row.appendChild(del); box.appendChild(row);
  }
}

// ---------- Connexion ----------
$('loginBtn').onclick = async () => {
  if (!current || soonMode) return;
  const kind = info.loginKind;
  if ((kind === 'token' || kind === 'code' || kind === 'cookie') && !$('loginArg').value.trim()) {
    return alert(kind === 'token' ? 'Colle ton token Discord.' : kind === 'cookie' ? 'Colle ton cookie .ROBLOSECURITY.' : 'Colle ton authorizationCode Epic.');
  }
  const btn = $('loginBtn'); const label = btn.textContent;
  btn.disabled = true; btn.textContent = '⏳ Connexion…';
  logLine(`Connexion ${current}…`, current);
  try {
    let r;
    if (kind === 'token' || kind === 'cookie') r = await H.setToken(current, $('loginArg').value.trim());
    else r = await H.login(current, $('loginArg').value.trim() || undefined);
    if (r && r.ok) { logLine('✅ Connecté.', current); $('loginArg').value = ''; }
    else logLine('❌ ' + (r && r.error ? r.error : 'Échec de connexion.'), current);
  } catch (e) { logLine('❌ ' + (e && e.message ? e.message : e), current); }
  finally { btn.disabled = false; btn.textContent = label; refreshAccount(); renderAccounts(current); }
};
$('logoutBtn').onclick = async () => { if (current) { await H.logout(current); refreshAccount(); renderAccounts(current); } };

// ---------- Disponibilité ----------
$('checkBtn').onclick = async () => {
  if (!current) return alert('Choisis une plateforme.');
  const name = $('checkName').value.trim(); if (!name) return;
  $('checkResult').textContent = '…'; $('checkResult').className = 'result muted';
  const r = await H.check(current, name);
  if (!r.ok) { $('checkResult').textContent = '❌ ' + r.error; $('checkResult').className = 'result bad'; return; }
  $('checkResult').textContent = r.free ? `🟢 « ${name} » est LIBRE` : `🔴 « ${name} » est pris`;
  $('checkResult').className = 'result ' + (r.free ? 'good' : 'bad');
};

// ---------- Mode planifié ----------
$('modeAt').onchange = $('modeMonitor').onchange = () => { $('atValue').classList.toggle('hidden', !$('modeAt').checked); };

// Convertit le champ « planifié » en epoch ms : les moteurs attendent un NOMBRE
// (ms), pas la chaîne brute. Accepte une date ISO (« 2026-07-10T15:00:00Z ») ou un
// délai relatif (« 90s », « 5m », « 2h »). Renvoie undefined si vide/invalide.
function parseDropAt(s) {
  if (!s) return undefined;
  const rel = s.match(/^(\d+(?:\.\d+)?)\s*(s|m|h)?$/i);
  if (rel) {
    const mult = { s: 1000, m: 60000, h: 3600000 }[(rel[2] || 's').toLowerCase()];
    return Date.now() + Math.round(parseFloat(rel[1]) * mult);
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
}

function snipeOpts() {
  const monitor = $('modeMonitor').checked;
  return {
    name: $('snipeName').value.trim(),
    guildId: $('guildId').value.trim() || undefined,
    password: $('snipePassword').value || undefined,
    monitor,
    dropAt: monitor ? undefined : parseDropAt($('atValue').value.trim()),
    burst: +$('burst').value || 6, spacingMs: +$('spacing').value || 30,
    leadMs: +$('lead').value || 40, connections: +$('connections').value || 3,
    autoLead: $('autoLead').checked, skipNtp: $('skipNtp').checked,
  };
}

let sniping = false;
$('snipeBtn').onclick = async () => {
  const btn = $('snipeBtn');
  // Pendant un snipe, le bouton devient « Arrêter » : un clic stoppe le moteur.
  if (sniping) { logLine('⏹ Arrêt demandé…', current); await H.stop(); return; }
  if (!current) return alert('Choisis une plateforme.');
  if (soonMode) return;
  const o = snipeOpts();
  if (!o.name) return alert('Entre un nom / code à sniper.');
  if (!o.monitor && !o.dropAt) return alert('Mode planifié : entre une date ISO (2026-07-10T15:00:00Z) ou un délai (90s, 5m, 2h).');
  sniping = true;
  btn.classList.add('stopping'); btn.textContent = '⏹ Arrêter';
  const r = await H.snipe(current, o);
  sniping = false;
  btn.classList.remove('stopping'); btn.textContent = '🎯 Lancer le snipe';
  if (r && r.ok === false) logLine('❌ ' + r.error, current);
};

// ---------- Watchlist ----------
async function renderWatch(items) {
  const box = $('watchlist');
  if (!items || !items.length) { box.innerHTML = '<div class="muted small">Aucun nom surveillé.</div>'; return; }
  box.innerHTML = '';
  for (const it of items) {
    const row = document.createElement('div'); row.className = 'watch-row';
    // textContent (pas innerHTML) : un nom surveillé est saisi par l'utilisateur → pas d'injection HTML.
    const wn = document.createElement('span'); wn.className = 'wname'; wn.textContent = it.name;
    const wp = document.createElement('span'); wp.className = 'wpf'; wp.textContent = it.platform;
    const del = document.createElement('button'); del.className = 'x'; del.textContent = '×';
    del.onclick = async () => { const r = await H.watchRemove(it.platform, it.name); renderWatch(r.items); };
    row.appendChild(wn); row.appendChild(wp); row.appendChild(del); box.appendChild(row);
  }
}
$('watchAddBtn').onclick = async () => {
  if (!current) return alert('Choisis une plateforme.');
  const name = $('snipeName').value.trim() || $('checkName').value.trim();
  if (!name) return alert('Entre un nom.');
  const r = await H.watchAdd({ platform: current, name, guildId: $('guildId').value.trim() || null });
  renderWatch(r.items); logLine(`➕ « ${name} » ajouté à la watchlist (${current}).`);
};
$('watchClear').onclick = async () => { const r = await H.watchClear(); renderWatch(r.items); };

// ---------- Check en masse ----------
H.onBulk((d) => { if (d && d.total) $('bulkProgress').textContent = `${d.done}/${d.total}…`; });
function renderBulk(results) {
  const box = $('bulkResults'); box.innerHTML = '';
  const sorted = [...results].sort((a, b) => (b.free === true) - (a.free === true));
  for (const it of sorted) {
    const cls = it.free === true ? 'free' : it.free === false ? 'taken' : 'unknown';
    const tag = it.free === true ? '🟢 LIBRE' : it.free === false ? '🔴 pris' : '⚪ ?';
    const row = document.createElement('div');
    row.className = 'bulk-row ' + cls;
    row.innerHTML = `<span class="bname"></span><span class="btag">${tag}</span>`;
    row.querySelector('.bname').textContent = it.name;   // textContent = pas d'injection HTML
    box.appendChild(row);
  }
}
$('bulkBtn').onclick = async () => {
  if (!current || soonMode) return;
  const names = $('bulkNames').value.trim();
  if (!names) return alert('Entre au moins un nom (un par ligne).');
  const btn = $('bulkBtn'); btn.disabled = true; btn.textContent = '⏳ Vérification…';
  $('bulkResults').innerHTML = ''; $('bulkProgress').textContent = 'préparation…';
  try {
    const r = await H.bulk(current, { names, proxies: $('bulkProxies').value, concurrency: +$('bulkConc').value || 20 });
    if (!r || !r.ok) { $('bulkProgress').textContent = ''; return alert('❌ ' + (r && r.error ? r.error : 'échec')); }
    renderBulk(r.results);
    $('bulkProgress').textContent = `✅ ${r.free}/${r.total} libres`;
  } catch (e) { $('bulkProgress').textContent = ''; alert('❌ ' + (e && e.message ? e.message : e)); }
  finally { btn.disabled = false; btn.textContent = 'Vérifier tout'; }
};

// ---------- Init ----------
(async () => { await loadPlatforms(); const w = await H.watchGet(); renderWatch(w.items); })();
