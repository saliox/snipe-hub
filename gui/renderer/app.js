const $ = (id) => document.getElementById(id);
const H = window.hub;
let current = null;   // plateforme sélectionnée
let info = null;      // infos de l'adaptateur courant
let soonMode = false; // plateforme « bientôt » sélectionnée -> actions verrouillées
let sniping = false;  // snipe en cours (déclaré ici : syncGate() le lit)
let lastFreeName = null;               // dernier nom vérifié LIBRE (raccourcis de la carte Disponibilité)
const freeWatch = new Set();           // clés « platform:name » détectées libres par la surveillance
let watching = false;                  // surveillance de la watchlist active ?

// ---------- Toasts non bloquants (remplacent alert()) ----------
// Même valeur de retour qu'alert() (undefined) : « return notify(…) » est strictement
// équivalent à « return alert(…) ». Le confirm() de la MàJ est CONSERVÉ : il attend
// une réponse booléenne synchrone.
function notify(msg, kind = 'warn', ms = 4200) {
  const host = $('toasts');
  if (!host) { console.warn(msg); return; }
  const t = document.createElement('div');
  t.className = 'tst ' + kind;
  t.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  t.textContent = msg;                              // textContent : zéro injection
  const close = () => { t.classList.add('out'); setTimeout(() => t.remove(), 220); };
  t.onclick = close;
  host.appendChild(t);
  setTimeout(close, ms);
}
// Désigne le champ fautif au lieu de laisser deviner.
function flagField(id, msg) {
  const el = $(id); if (!el) return;
  el.classList.add('bad');
  el.addEventListener('animationend', () => el.classList.remove('bad'), { once: true });
  setTimeout(() => el.classList.remove('bad'), 1200);
  try { el.focus(); } catch {}
  if (msg) notify(msg);
}

// ---------- Portail unique de verrouillage des actions ----------
// Recalcule TOUT l'état depuis (current, soonMode, sniping). Remplace setSoon(), qui ne
// verrouillait que le cas « bientôt » et jamais le cas « aucune cible choisie » : sans
// plateforme, tous les boutons étaient actifs et ne rendaient qu'une alerte.
const ACT_IDS = ['loginBtn', 'checkBtn', 'snipeBtn', 'watchAddBtn', 'bulkBtn'];
function syncGate() {
  const locked = !current || soonMode;
  for (const id of ACT_IDS) {
    const e = $(id); if (!e) continue;
    // Exception : pendant un snipe, #snipeBtn est le bouton « Arrêter » -> jamais désactivé.
    e.disabled = locked && !(id === 'snipeBtn' && sniping);
  }
  document.body.classList.toggle('no-target', !current);
  const es = $('emptyState'); if (es) es.classList.toggle('hidden', !!current);
}
function setSoon(on) { soonMode = on; syncGate(); }   // même signature : appelants inchangés

// ---------- Journal (1 seul reflow par frame, plafonné, coloré) ----------
// `textContent +=` relisait puis recréait tout le nœud texte (O(n²)), et lire scrollHeight
// juste après forçait un reflow SYNCHRONE à chaque ligne. Aucun plafond : une surveillance
// de plusieurs heures accumulait des dizaines de milliers de lignes dans le DOM.
const LOG_MAX = 1500;      // lignes conservées
const LOG_SLACK = 300;     // hystérésis : on ne retaille qu'au-delà de MAX+SLACK
const logEl = $('log');
let logQueue = [], logRaf = 0, logErrPending = false;

// Échappements \u : les emoji astraux (🔔) casseraient une classe [..] sans le flag u.
function logClass(s) {
  if (s.startsWith('❌')) return 'err';                                        // ❌
  if (s.startsWith('✅') || s.startsWith('✔')) return 'ok';               // ✅ ✔️
  if (s.startsWith('🔔') || s.startsWith('🟢')) return 'bell'; // 🔔 🟢
  if (s.startsWith('⚠') || s.startsWith('⏹') || s.startsWith('🔴')) return 'warn'; // ⚠ ⏹ 🔴
  return '';
}

function flushLog() {
  logRaf = 0;
  if (!logQueue.length) return;
  const batch = logQueue; logQueue = [];
  // L'utilisateur suivait-il déjà le bas ? Sinon on ne lui vole pas sa lecture.
  const stick = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 26;
  const frag = document.createDocumentFragment();
  for (const { line, pid } of batch) {
    const div = document.createElement('div');
    const cls = logClass(line);
    div.className = 'l' + (cls ? ' ' + cls : '');
    if (pid) { const p = document.createElement('span'); p.className = 'pid'; p.textContent = `[${pid}] `; div.appendChild(p); }
    div.appendChild(document.createTextNode(line));   // pas d'innerHTML : zéro injection
    frag.appendChild(div);
  }
  logEl.appendChild(frag);                            // 1 seule insertion
  const n = logEl.childElementCount;
  if (n > LOG_MAX + LOG_SLACK) for (let i = n - LOG_MAX; i > 0; i--) logEl.removeChild(logEl.firstChild);
  if (stick) { logEl.scrollTop = logEl.scrollHeight; logErrPending = false; $('logNew').classList.add('hidden'); }
  else if (logErrPending) $('logNew').classList.remove('hidden');
}

function logLine(line, pid) {
  const s = String(line);
  if (logClass(s) === 'err') logErrPending = true;
  logQueue.push({ line: s, pid });
  if (!logRaf) logRaf = requestAnimationFrame(flushLog);
}

// Accepte { line, pid } ET { batch:[{line,pid}] } (agrégation côté main) : aucun risque
// si un seul des deux fichiers est déployé.
H.onLog((d) => {
  if (!d) return;
  if (Array.isArray(d.batch)) { for (const e of d.batch) logLine(e.line, e.pid); }
  else logLine(d.line, d.pid);
});
$('logClear').onclick = () => { logQueue = []; logEl.textContent = ''; logErrPending = false; $('logNew').classList.add('hidden'); };
$('logNew').onclick = () => { logEl.scrollTop = logEl.scrollHeight; logErrPending = false; $('logNew').classList.add('hidden'); };
$('logCopy').onclick = async () => {
  try { await navigator.clipboard.writeText(logEl.innerText); notify('Journal copié.', 'ok', 2200); }
  catch { notify('Copie impossible.', 'err'); }
};

// ---------- Version + MàJ ----------
async function showVersion() { try { $('version').textContent = 'v' + (await H.version()); } catch {} }
showVersion();
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
  if (d.state === 'available') { logLine(`🆕 Version ${d.version} disponible (bouton « MàJ » pour installer).`); showVersion(); }
  else if (d.state === 'downloading') logLine('⬇️ Téléchargement de la mise à jour…');
  else if (d.state === 'installing') logLine('⚙️ Installation… l\'application va redémarrer.');
  // États TERMINAUX sans installation : la pastille restait bloquée sur « MàJ 73% ».
  else if (d.state === 'error') { logLine('❌ MàJ : ' + d.error); showVersion(); }
  else if (d.state === 'uptodate') showVersion();
});
H.onUpdateProgress && H.onUpdateProgress((p) => { if (p && p.pct != null) $('version').textContent = `MàJ ${p.pct}%`; });

// ---------- Plateformes (sidebar) ----------
async function loadPlatforms() {
  const list = await H.platforms();
  const box = $('platforms'); box.innerHTML = '';
  for (const p of list) {
    const b = document.createElement('button');
    b.className = 'pf-item' + (p.soon ? ' soon' : '');
    b.innerHTML = `<span class="e">${p.emoji}</span> <span>${p.label}</span>${p.soon ? '<span class="badge">bientôt</span>' : '<span class="cdot" title="non connecté"></span>'}`;
    b.onclick = () => selectPlatform(p.id);   // les « bientôt » sont cliquables : elles montrent un aperçu
    if (p.soon) b.title = 'Bientôt disponible';
    b.dataset.pid = p.id;
    box.appendChild(b);
  }
}

// Pastilles de connexion : whoami est local (sans réseau) quand aucun identifiant n'est
// enregistré. En SÉRIE on payait la SOMME des latences au lieu du MAX (~1 s au démarrage).
let dotsSeq = 0;
async function refreshDots() {
  const seq = ++dotsSeq;
  const btns = [...document.querySelectorAll('.pf-item')].filter((b) => b.querySelector('.cdot'));
  const rs = await Promise.all(btns.map((b) => H.whoami(b.dataset.pid).catch(() => null)));
  if (seq !== dotsSeq) return;   // un refresh plus récent a déjà repeint
  btns.forEach((b, i) => {
    const dot = b.querySelector('.cdot');
    const r = rs[i];
    const acct = r && r.ok && r.account;
    dot.classList.toggle('on', !!acct);
    dot.title = acct ? ('connecté : ' + (acct.name || '')) : 'non connecté';
  });
}

// Compteur de séquence : en cliquant vite sur deux plateformes, la réponse la PLUS LENTE
// repeignait l'écran avec les champs de la mauvaise plateforme.
let selSeq = 0;

async function selectPlatform(pid) {
  const seq = ++selSeq;
  [...document.querySelectorAll('.pf-item')].forEach((e) => e.classList.toggle('active', e.dataset.pid === pid));
  const r = await H.info(pid);
  if (seq !== selSeq) return;   // un autre clic a pris la main : réponse périmée
  // On n'engage `current` qu'APRÈS le succès : sinon un adaptateur qui refuse de se charger
  // laissait un `info` périmé et le bouton Connexion mourait en silence.
  if (!r.ok) { logLine('❌ ' + r.error); current = null; info = null; syncGate(); return; }
  current = pid;
  info = r;
  try { localStorage.setItem('lastPlatform', pid); } catch {}
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
  if (seq !== selSeq) return;   // encore un clic entre-temps : ne pas repeindre le compte
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
    // Le message était codé en dur sur Discord ; on s'aligne sur le placeholder par plateforme.
    return flagField('loginArg', 'Renseigne le champ : ' + ($('loginArg').placeholder || 'identifiant requis'));
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
  finally { btn.disabled = false; btn.textContent = label; refreshAccount(); renderAccounts(current); refreshDots(); syncGate(); }
};
$('logoutBtn').onclick = async () => { if (current) { await H.logout(current); refreshAccount(); renderAccounts(current); refreshDots(); } };

// ---------- Disponibilité ----------
$('checkBtn').onclick = async () => {
  if (!current) return notify('Choisis d\'abord une plateforme à gauche.');
  const name = $('checkName').value.trim();
  if (!name) return flagField('checkName', 'Entre un nom à vérifier.');
  const btn = $('checkBtn'), label = btn.textContent, res = $('checkResult');
  $('checkActions').classList.add('hidden');
  lastFreeName = null;
  // Sans désactivation, Entrée répétée lançait N requêtes concurrentes dont la plus LENTE
  // gagnait l'affichage. Et sans try/catch, un rejet IPC figeait « … » pour toujours.
  btn.disabled = true; btn.textContent = '⏳ …';
  res.className = 'result muted pending';
  res.textContent = `Interrogation de ${(info && info.label) || current}…`;
  try {
    const r = await H.check(current, name);
    if (!r || !r.ok) { res.textContent = '❌ ' + ((r && r.error) || 'échec'); res.className = 'result bad'; return; }
    res.textContent = r.free ? `🟢 « ${name} » est LIBRE` : `🔴 « ${name} » est pris`;
    res.className = 'result ' + (r.free ? 'good' : 'bad');
    if (r.free) { lastFreeName = name; $('checkActions').classList.remove('hidden'); }
  } catch (e) {
    res.textContent = '❌ ' + (e && e.message ? e.message : e);
    res.className = 'result bad';
  } finally { btn.disabled = false; btn.textContent = label; }
};

// Un nom trouvé LIBRE se snipe en un clic : le retaper est la 1re source de faute de frappe.
$('useForSnipe').onclick = () => {
  const n = lastFreeName || $('checkName').value.trim(); if (!n) return;
  $('snipeName').value = n;
  $('snipeName').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  $('snipeBtn').focus();
  notify(`« ${n} » chargé dans le snipe.`, 'ok', 2600);
};
$('useForWatch').onclick = async () => {
  const n = lastFreeName || $('checkName').value.trim(); if (!n || !current) return;
  const r = await H.watchAdd({ platform: current, name: n, guildId: $('guildId').value.trim() || null });
  renderWatch(r.items); notify(`« ${n} » ajouté à la watchlist.`, 'ok', 2600);
};

// ---------- Mode planifié ----------
$('modeAt').onchange = $('modeMonitor').onchange = () => { $('atValue').classList.toggle('hidden', !$('modeAt').checked); };

// Convertit le champ « planifié » en epoch ms : les moteurs attendent un NOMBRE (ms), pas
// la chaîne brute. Accepte une date ISO (« 2026-07-10T15:00:00Z ») ou un délai relatif
// (« 90s », « 5m », « 2h »). Renvoie undefined si vide/invalide.
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

// Aperçu live : rien ne disait que 5m/2h marchent, ni qu'une ISO SANS Z est lue en heure
// locale (piège silencieux), ni qu'une date déjà passée était acceptée sans un mot.
const AT_FMT = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'medium' });
function humanDelay(ms) {
  if (ms <= 0) return 'déjà passé';
  const s = Math.round(ms / 1000);
  if (s < 60) return `dans ${s} s`;
  if (s < 3600) return `dans ${Math.floor(s / 60)} min ${s % 60} s`;
  return `dans ${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}
function syncAtPreview() {
  const el = $('atPreview'); if (!el) return;
  if (!$('modeAt').checked) { el.textContent = ''; el.className = 'at-preview small'; return; }
  const raw = $('atValue').value.trim();
  if (!raw) { el.textContent = 'ISO (…Z) ou délai : 90s · 5m · 2h'; el.className = 'at-preview small muted'; return; }
  const t = parseDropAt(raw);
  if (t === undefined) { el.textContent = '⚠️ format non reconnu'; el.className = 'at-preview small bad'; return; }
  const d = t - Date.now();
  el.textContent = `${AT_FMT.format(new Date(t))} — ${humanDelay(d)}`;
  el.className = 'at-preview small' + (d <= 0 ? ' bad' : d < 5000 ? ' warn' : '');
}
// addEventListener : ne PAS écraser le .onchange défini juste au-dessus.
$('atValue').addEventListener('input', syncAtPreview);
$('modeAt').addEventListener('change', syncAtPreview);
$('modeMonitor').addEventListener('change', syncAtPreview);
setInterval(() => { if ($('modeAt').checked && !$('atValue').classList.contains('hidden')) syncAtPreview(); }, 1000);

// Pastille « modifié » : un réglage exotique replié ne doit jamais devenir invisible.
(() => {
  const DEF = { burst: '6', spacing: '30', lead: '40', connections: '3' };
  const adv = document.querySelector('.adv'); if (!adv) return;
  const sync = () => {
    const dirty = Object.keys(DEF).some((k) => $(k).value !== DEF[k]) || $('autoLead').checked || $('skipNtp').checked;
    adv.classList.toggle('dirty', dirty);
  };
  ['burst', 'spacing', 'lead', 'connections', 'autoLead', 'skipNtp'].forEach((k) => $(k).addEventListener('change', sync));
  sync();
})();

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

$('snipeBtn').onclick = async () => {
  const btn = $('snipeBtn');
  // Pendant un snipe, le bouton devient « Arrêter » : un clic stoppe le moteur.
  if (sniping) { logLine('⏹ Arrêt demandé…', current); await H.stop(); return; }
  if (!current) return notify('Choisis une plateforme.');
  if (soonMode) return;
  const o = snipeOpts();
  if (!o.name) return flagField('snipeName', 'Entre un nom / code à sniper.');
  if (!o.monitor && !o.dropAt) return flagField('atValue', 'Mode planifié : date ISO (2026-07-10T15:00:00Z) ou délai (90s, 5m, 2h).');
  sniping = true; syncGate();
  btn.classList.add('stopping'); btn.textContent = '⏹ Arrêter';
  const r = await H.snipe(current, o);
  sniping = false; syncGate();
  btn.classList.remove('stopping'); btn.textContent = '🎯 Lancer le snipe';
  if (r && r.ok === false) logLine('❌ ' + r.error, current);
};

// ---------- Watchlist ----------
async function renderWatch(items) {
  const box = $('watchlist');
  const n = (items && items.length) || 0;
  $('watchCount').textContent = n;
  $('watchCount').classList.toggle('hidden', !n);
  $('watchClear').disabled = !n;
  $('watchMonitor').disabled = !n && !watching;   // toujours cliquable pour ARRÊTER
  if (!n) { box.innerHTML = '<div class="muted small">Aucun nom surveillé.</div>'; return; }
  box.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const it of items) {
    const key = it.platform + ':' + String(it.name).toLowerCase();
    const free = freeWatch.has(key);
    const row = document.createElement('div');
    row.className = 'watch-row' + (free ? ' free' : '');
    row.dataset.k = key;   // requis par markWatchFree() : mise à jour ciblée sans IPC
    // textContent (pas innerHTML) : un nom surveillé est saisi par l'utilisateur.
    const wn = document.createElement('span'); wn.className = 'wname'; wn.textContent = (free ? '🟢 ' : '') + it.name;
    const wp = document.createElement('span'); wp.className = 'wpf'; wp.textContent = free ? 'LIBRE' : it.platform;
    const use = document.createElement('button');
    use.className = 'use'; use.textContent = '🎯'; use.title = 'Charger dans le snipe';
    use.onclick = async () => {
      await selectPlatform(it.platform);            // protégé par selSeq
      $('snipeName').value = it.name;
      if (it.guildId) $('guildId').value = it.guildId;
      $('snipeBtn').focus();
      notify(`« ${it.name} » chargé (${it.platform}).`, 'ok', 2600);
    };
    const del = document.createElement('button');
    del.className = 'x'; del.textContent = '×'; del.title = 'Retirer';
    del.onclick = async () => { const r = await H.watchRemove(it.platform, it.name); renderWatch(r.items); };
    row.append(wn, wp, use, del);
    frag.appendChild(row);
  }
  box.appendChild(frag);
}
$('watchAddBtn').onclick = async () => {
  if (!current) return notify('Choisis une plateforme.');
  const name = $('snipeName').value.trim() || $('checkName').value.trim();
  if (!name) return flagField('snipeName', 'Entre un nom.');
  const r = await H.watchAdd({ platform: current, name, guildId: $('guildId').value.trim() || null });
  renderWatch(r.items);
  // Le main répond désormais ok:false si l'écriture disque a échoué : ne plus annoncer
  // un ajout qui disparaîtra au redémarrage.
  if (r && r.ok === false) notify('❌ ' + (r.error || 'Ajout non enregistré.'), 'err', 6000);
  else logLine(`➕ « ${name} » ajouté à la watchlist (${current}).`);
};
$('watchClear').onclick = async () => { freeWatch.clear(); const r = await H.watchClear(); renderWatch(r.items); };

// Surveillance de la watchlist : poll en arrière-plan (côté main) + notifs bureau.
$('watchMonitor').onclick = async () => {
  const r = await H.watchMonitor(!watching);
  watching = !!(r && r.monitoring);
  $('watchMonitor').textContent = watching ? '👁 Surveillance ACTIVE' : '👁 Surveiller la watchlist';
  $('watchMonitor').classList.toggle('on', watching);
  if (watching) logLine('👁 Surveillance de la watchlist activée — notif dès qu\'un nom se libère.');
  else { freeWatch.clear(); logLine('👁 Surveillance arrêtée.'); const w = await H.watchGet(); renderWatch(w.items); }
};
// Mise à jour CIBLÉE : on refaisait un IPC + une reconstruction complète de la liste à
// chaque notification, ce qui rejouait fadeInUp sur TOUTES les lignes (sidebar clignotante)
// alors qu'une seule ligne changeait — et le main n'émet qu'une fois par libération.
function markWatchFree(key, name) {
  const row = $('watchlist').querySelector(`.watch-row[data-k="${CSS.escape(key)}"]`);
  if (!row) return false;                       // liste modifiée entre-temps -> repli
  row.classList.add('free');
  const wn = row.querySelector('.wname'); if (wn) wn.textContent = '🟢 ' + name;
  const wp = row.querySelector('.wpf');   if (wp) wp.textContent = 'LIBRE';
  return true;
}
H.onWatchFree && H.onWatchFree(async (d) => {
  if (!d) return;
  const key = d.platform + ':' + String(d.name).toLowerCase();
  freeWatch.add(key);
  logLine(`🔔 « ${d.name} » est LIBRE sur ${d.platform} !`);
  notify(`🔔 « ${d.name} » est LIBRE sur ${d.platform} !`, 'ok', 9000);
  if (!markWatchFree(key, d.name)) { const w = await H.watchGet(); renderWatch(w.items); }
});

// ---------- Check en masse ----------
let bulkLast = [];
H.onBulk((d) => {
  if (!d || !d.total) return;
  $('bulkProgress').textContent = `${d.done}/${d.total}`;
  const bar = $('bulkBar'); bar.classList.remove('hidden');
  bar.firstElementChild.style.width = Math.round((d.done / d.total) * 100) + '%';
});
function renderBulk(results) {
  bulkLast = results || [];
  const sorted = [...bulkLast].sort((a, b) => (b.free === true) - (a.free === true));
  const frag = document.createDocumentFragment();   // hors du DOM vivant : 0 invalidation par ligne
  for (const it of sorted) {
    const cls = it.free === true ? 'free' : it.free === false ? 'taken' : 'unknown';
    const row = document.createElement('div');
    row.className = 'bulk-row ' + cls;
    const nm = document.createElement('span'); nm.className = 'bname'; nm.textContent = it.name;
    const tg = document.createElement('span'); tg.className = 'btag';
    tg.textContent = it.free === true ? '🟢 LIBRE' : it.free === false ? '🔴 pris' : '⚪ ?';
    row.append(nm, tg);
    if (it.free === true) {
      row.title = 'Charger dans le snipe';
      row.onclick = () => { $('snipeName').value = it.name; $('snipeBtn').focus(); notify(`« ${it.name} » chargé.`, 'ok', 2200); };
    }
    frag.appendChild(row);
  }
  $('bulkResults').replaceChildren(frag);           // 1 seule mutation du DOM vivant
  const freeNames = bulkLast.filter((r) => r.free === true);
  $('bulkCopy').classList.toggle('hidden', !freeNames.length);
}
$('bulkCopy').onclick = async () => {
  const txt = bulkLast.filter((r) => r.free === true).map((r) => r.name).join('\n');
  try { await navigator.clipboard.writeText(txt); notify('Noms libres copiés.', 'ok', 2200); }
  catch { notify('Copie impossible.', 'err'); }
};
$('bulkBtn').onclick = async () => {
  if (!current || soonMode) return;
  const names = $('bulkNames').value.trim();
  if (!names) return flagField('bulkNames', 'Entre au moins un nom (un par ligne).');
  const btn = $('bulkBtn'); btn.disabled = true; btn.textContent = '⏳ Vérification…';
  $('bulkResults').replaceChildren(); $('bulkCopy').classList.add('hidden');
  $('bulkProgress').textContent = 'préparation…';
  const bar = $('bulkBar'); bar.classList.remove('hidden'); bar.firstElementChild.style.width = '0%';
  try {
    const r = await H.bulk(current, { names, proxies: $('bulkProxies').value, concurrency: +$('bulkConc').value || 20 });
    if (!r || !r.ok) { $('bulkProgress').textContent = ''; bar.classList.add('hidden'); return notify('❌ ' + ((r && r.error) || 'échec'), 'err', 6000); }
    renderBulk(r.results);
    $('bulkProgress').textContent = `✅ ${r.free}/${r.total} libres`;
  } catch (e) { $('bulkProgress').textContent = ''; bar.classList.add('hidden'); notify('❌ ' + (e && e.message ? e.message : e), 'err', 6000); }
  finally { btn.disabled = false; btn.textContent = 'Vérifier tout'; }
};

// ---------- Réglages ----------
$('settingsBtn').onclick = async () => {
  const r = await H.settingsGet(); const s = (r && r.settings) || {};
  $('setMs').value = s.msClientId || ''; $('setEpicId').value = s.epicClientId || '';
  $('setEpicSecret').value = s.epicClientSecret || ''; $('setProxies').value = s.proxies || '';
  $('settingsMsg').textContent = '';
  $('settingsModal').classList.remove('hidden');
  setTimeout(() => $('setMs').focus(), 0);   // le focus restait sur le bouton DERRIÈRE la modale
};
$('settingsClose').onclick = () => $('settingsModal').classList.add('hidden');
$('settingsModal').onclick = (e) => { if (e.target === $('settingsModal')) $('settingsModal').classList.add('hidden'); };
$('settingsSave').onclick = async () => {
  const s = { msClientId: $('setMs').value.trim(), epicClientId: $('setEpicId').value.trim(), epicClientSecret: $('setEpicSecret').value.trim(), proxies: $('setProxies').value };
  const r = await H.settingsSave(s);
  if (s.proxies) $('bulkProxies').value = s.proxies;
  // « ✅ Enregistré. » s'affichait quoi qu'il arrive, y compris quand l'écriture
  // disque échouait : les identifiants repartaient à zéro au redémarrage suivant.
  if (r && r.ok === false) {
    $('settingsMsg').textContent = '⚠️ ' + (r.error || 'Non enregistré.');
    notify(r.error || 'Réglages non enregistrés.', 'err', 7000);
    return;   // on laisse la modale ouverte : l'utilisateur doit voir le problème
  }
  $('settingsMsg').textContent = '✅ Enregistré.';
  setTimeout(() => $('settingsModal').classList.add('hidden'), 700);
};

// ---------- Historique ----------
$('historyBtn').onclick = async () => {
  const r = await H.historyGet(); const items = (r && r.items) || [];
  const box = $('historyBody'); box.innerHTML = '';
  if (!items.length) { box.innerHTML = '<div class="muted small">Aucun snipe pour l\'instant.</div>'; }
  else {
    const frag = document.createDocumentFragment();
    for (const it of items) {
      const row = document.createElement('div'); row.className = 'hist-row ' + (it.success ? 'ok' : 'ko');
      const ico = document.createElement('span'); ico.textContent = it.success ? '✅' : '❌';
      const nm = document.createElement('span'); nm.className = 'hist-name'; nm.textContent = it.name;
      const pf = document.createElement('span'); pf.className = 'hist-pf'; pf.textContent = it.platform;
      const tm = document.createElement('span'); tm.className = 'hist-time'; tm.textContent = new Date(it.at).toLocaleString('fr-FR');
      row.append(ico, nm, pf, tm); frag.appendChild(row);
    }
    box.appendChild(frag);
  }
  $('historyModal').classList.remove('hidden');
  setTimeout(() => $('historyClose').focus(), 0);
};
$('historyClose').onclick = () => $('historyModal').classList.add('hidden');
$('historyModal').onclick = (e) => { if (e.target === $('historyModal')) $('historyModal').classList.add('hidden'); };

// ---------- Entrée pour lancer ----------
$('checkName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('checkBtn').click(); });
$('snipeName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('snipeBtn').click(); });
$('loginArg').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('loginBtn').click(); });

// ---------- Raccourcis clavier ----------
// Échap ne fermait AUCUNE modale — premier réflexe de tout utilisateur Windows.
function openModals() { return [...document.querySelectorAll('.modal:not(.hidden)')]; }
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const m = openModals().pop();
    if (m) { m.classList.add('hidden'); e.preventDefault(); return; }
    const t = document.querySelector('#toasts .tst'); if (t) t.remove();
    return;
  }
  if (openModals().length) return;   // ne pas court-circuiter la saisie d'un secret Epic
  const inField = /^(INPUT|TEXTAREA)$/.test((document.activeElement || {}).tagName || '');
  if (e.ctrlKey && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); $('checkName').focus(); $('checkName').select(); }
  else if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) { e.preventDefault(); $('logClear').click(); }
  else if (e.key === '/' && !inField) { e.preventDefault(); $('snipeName').focus(); }
});

// ---------- Quoi de neuf (au 1er lancement d'une nouvelle version) ----------
const CHANGELOG = {
  '0.5.0': 'Refonte visuelle : hiérarchie, focus clavier, journal coloré, options avancées repliées, toasts non bloquants — et animations gelées hors focus (0 GPU volé à ton jeu).',
  '0.4.0': 'Panneau Réglages (creds MC/Epic + proxies dans l\'UI), pastilles de connexion, historique des snipes, Entrée pour lancer.',
  '0.3.0': 'Notifications bureau + surveillance de la watchlist en arrière-plan (radar multi-plateforme).',
  '0.2.3': 'Vérification de disponibilité Twitch réparée (API Helix).',
  '0.2.1': 'Bouton Stop pour arrêter un snipe en surveillance.',
  '0.2.0': 'Ajout de X (Twitter) — 6 plateformes.',
};
(async () => {
  try {
    const v = await H.version();
    if (v && localStorage.getItem('lastSeenVersion') !== v) {
      const el = $('whatsnew'); el.innerHTML = '';
      const x = document.createElement('button'); x.className = 'toast-x'; x.textContent = '×'; x.onclick = () => el.classList.add('hidden');
      const t = document.createElement('div'); t.className = 'toast-title'; t.textContent = `✨ Quoi de neuf — v${v}`;
      const b = document.createElement('div'); b.textContent = CHANGELOG[v] || 'Nouvelle version installée.';
      el.append(x, t, b); el.classList.remove('hidden');
      localStorage.setItem('lastSeenVersion', v);
      setTimeout(() => el.classList.add('hidden'), 9000);
    }
  } catch {}
})();

// ---------- Gel des animations hors focus ----------
// L'app tourne en fond des heures pendant que l'utilisateur joue. Chromium ne throttle que
// si la fenêtre est minimisée ou totalement occluse : sur un 2ᵉ écran elle compose à plein
// régime et vole du GPU au jeu au premier plan.
const setAnimIdle = (v) => document.body.classList.toggle('anim-idle', v);
window.addEventListener('blur', () => setAnimIdle(true));
window.addEventListener('focus', () => setAnimIdle(false));
if (!document.hasFocus()) setAnimIdle(true);

// ---------- Init ----------
(async () => {
  syncGate();                              // verrouille AVANT tout : rien n'est cliquable à vide
  await loadPlatforms(); refreshDots();
  const w = await H.watchGet(); renderWatch(w.items);
  try { const r = await H.settingsGet(); const p = r && r.settings && r.settings.proxies; if (p) $('bulkProxies').value = p; } catch {}
  // Re-sélection de la dernière plateforme : on ne repart plus de zéro à chaque relance.
  try {
    const last = localStorage.getItem('lastPlatform');
    if (last && document.querySelector(`.pf-item[data-pid="${CSS.escape(last)}"]`)) await selectPlatform(last);
  } catch {}
  syncAtPreview();
})();
