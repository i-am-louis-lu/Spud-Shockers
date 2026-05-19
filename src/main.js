import { Game } from './game.js';
import { WEAPONS, WEAPON_ORDER } from './weapons.js';
import { Multiplayer } from './multiplayer.js';
import { Auth, randomGuestName } from './auth.js';

// Dynamic-import character.js so any failure inside it (a missing GLB,
// a broken three.js addon URL, an unhandled exception) CANNOT break the
// start screen — the catch swallows it and the game runs with the
// procedural gun viewmodel just like the rollback build.
import('./character.js')
  .then((mod) => mod.preloadCharacter())
  .catch((err) => console.warn('character system disabled', err));

// Restore account state before reading any saved progress — for a returning
// logged-in user this copies their account snapshot into the live keys; for
// a returning guest it wipes; for an anonymous (never-signed-up) user it
// leaves everything alone so legacy progress is preserved.
const _bootInfo = Auth.bootstrap();

const canvas = document.getElementById('game-canvas');
const game = new Game(canvas);

// Spudgun is locked as the secondary (slot 2) and Knife as melee (slot 3),
// so neither belongs in the primary picker.
const PRIMARY_KEYS = WEAPON_ORDER.filter(k => k !== 'spudgun');

const STORE_NAME = 'spudshockers.name';
const STORE_WEAPON = 'spudshockers.weapon';
const STORE_XP = 'spudshockers.xp';
const STORE_WIN_STREAK = 'spudshockers.winstreak';
const STORE_BEST_WIN_STREAK = 'spudshockers.bestwinstreak';
const STORE_MASTERY = 'spudshockers.mastery';   // { weaponKey: kills }
const STORE_DAILY = 'spudshockers.daily';       // { date, challenges, claimed }
const STORE_LAST_WIN_DAY = 'spudshockers.lastwinday';
const STORE_TOTALS = 'spudshockers.totals';     // { matches, kills, headshots, multikills }
const STORE_COINS = 'spudshockers.coins';        // persistent wallet across matches

const savedName = localStorage.getItem(STORE_NAME) || '';
const rawSaved = localStorage.getItem(STORE_WEAPON);
const savedWeapon = (WEAPONS[rawSaved] && rawSaved !== 'spudgun') ? rawSaved : 'fryer';

let totalXP = parseInt(localStorage.getItem(STORE_XP) || '0', 10) || 0;
let winStreak = parseInt(localStorage.getItem(STORE_WIN_STREAK) || '0', 10) || 0;
let bestWinStreak = parseInt(localStorage.getItem(STORE_BEST_WIN_STREAK) || '0', 10) || 0;
let mastery = readJson(STORE_MASTERY, {});
let totals = readJson(STORE_TOTALS, { matches: 0, kills: 0, headshots: 0, multikills: 0 });

function readJson(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return v ?? fallback; }
  catch { return fallback; }
}
// writeJson also nudges the account sync so logged-in users have their
// account record updated atomically with the live key.
function writeJson(key, val) {
  localStorage.setItem(key, JSON.stringify(val));
  Auth.syncActive();
}
// String save with auto account-sync. Use this instead of localStorage.setItem
// for any persistent progress key so a logged-in user's account stays current.
function saveStr(key, val) {
  localStorage.setItem(key, val);
  Auth.syncActive();
}

function levelInfo(t) {
  let lvl = 1, used = 0;
  while (true) {
    const need = 100 * lvl;
    if (t - used < need) return { level: lvl, current: Math.max(0, t - used), needed: need };
    used += need;
    lvl++;
    if (lvl > 999) return { level: lvl, current: 0, needed: 1 };
  }
}

// Mastery tiers: Bronze 25 / Silver 75 / Gold 200 / Diamond 500
const MASTERY_TIERS = [
  { name: 'Diamond', min: 500, color: '#9be8ff', glow: '#5ec4ff' },
  { name: 'Gold',    min: 200, color: '#ffd700', glow: '#ffce5e' },
  { name: 'Silver',  min: 75,  color: '#dadada', glow: '#bfbfbf' },
  { name: 'Bronze',  min: 25,  color: '#d18b4a', glow: '#b8693a' },
];
function masteryForWeapon(key) {
  const k = mastery[key] || 0;
  for (const t of MASTERY_TIERS) if (k >= t.min) return { ...t, kills: k };
  return { name: '', min: 0, color: '#888', glow: '#888', kills: k };
}
function bumpMastery(weapon, n = 1) {
  if (!weapon) return;
  const before = masteryForWeapon(weapon).name;
  mastery[weapon] = (mastery[weapon] || 0) + n;
  writeJson(STORE_MASTERY, mastery);
  const after = masteryForWeapon(weapon).name;
  if (after && after !== before) {
    game.announceStreak(`${WEAPONS[weapon].name.toUpperCase()} → ${after.toUpperCase()}!`, masteryForWeapon(weapon).glow, 5);
  }
}

// --- Daily challenges ---
// Seeded RNG so the day's challenges are stable for everyone-with-the-same-date,
// and so reloading the page doesn't reroll them mid-day.
function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function seededRandom(seed) {
  let s = 0;
  for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) | 0;
  return () => {
    s = (s * 1664525 + 1013904223) | 0;
    return ((s >>> 0) % 1000) / 1000;
  };
}
const CHALLENGE_TEMPLATES = [
  { id: 'kills',       label: (n) => `Get ${n} kills`,                        amount: () => 12 + Math.floor(Math.random() * 10), xp: 200, coins: 60 },
  { id: 'headshots',   label: (n) => `Land ${n} headshots`,                   amount: () => 4 + Math.floor(Math.random() * 4),   xp: 250, coins: 80 },
  { id: 'multikills',  label: (n) => `Get ${n} multikills (2+ chain)`,        amount: () => 2 + Math.floor(Math.random() * 2),   xp: 220, coins: 70 },
  { id: 'specials',    label: (n) => `Use ${n} special moves (T)`,            amount: () => 4 + Math.floor(Math.random() * 4),   xp: 180, coins: 60 },
  { id: 'win',         label: ()  => `Win 1 match`,                           amount: () => 1,                                   xp: 300, coins: 100 },
  { id: 'streak',      label: (n) => `Reach a ${n}-kill streak (no death)`,   amount: () => 4 + Math.floor(Math.random() * 3),   xp: 250, coins: 80 },
  { id: 'killstreak',  label: (n) => `Trigger ${n} killstreak rewards`,       amount: () => 2,                                   xp: 220, coins: 80 },
  { id: 'weapon',      label: (n, w) => `Get ${n} kills with ${WEAPONS[w].name}`, amount: () => 6 + Math.floor(Math.random() * 6), xp: 220, coins: 70, needsWeapon: true },
  { id: 'loot',        label: (n) => `Pick up ${n} loot drops`,               amount: () => 3 + Math.floor(Math.random() * 3),   xp: 180, coins: 60 },
  { id: 'air_kills',   label: (n) => `Get ${n} mid-air kills`,                 amount: () => 3 + Math.floor(Math.random() * 3),   xp: 260, coins: 90 },
  { id: 'longshot',    label: (n) => `Get ${n} long-range kills (25m+)`,        amount: () => 4 + Math.floor(Math.random() * 4),   xp: 240, coins: 80 },
];

function rollDailyChallenges() {
  const key = dayKey();
  const stored = readJson(STORE_DAILY, null);
  if (stored && stored.date === key) return stored;
  const rand = seededRandom(key);
  // pick 3 distinct templates
  const ids = [];
  const pool = [...CHALLENGE_TEMPLATES];
  while (ids.length < 3 && pool.length > 0) {
    const idx = Math.floor(rand() * pool.length);
    ids.push(pool.splice(idx, 1)[0]);
  }
  const challenges = ids.map((tmpl) => {
    // re-seed amount/weapon deterministically per challenge
    const sub = seededRandom(key + tmpl.id);
    const amount = 1 + Math.floor(sub() * 30);
    const weaponKey = tmpl.needsWeapon
      ? PRIMARY_KEYS[Math.floor(sub() * PRIMARY_KEYS.length)]
      : null;
    // We need the original amount() call, but with our seeded rand. Use closure swap:
    const oldRandom = Math.random;
    Math.random = sub;
    const a = tmpl.amount();
    Math.random = oldRandom;
    return {
      id: tmpl.id,
      target: a,
      progress: 0,
      done: false,
      xp: tmpl.xp,
      coins: tmpl.coins,
      label: tmpl.needsWeapon ? tmpl.label(a, weaponKey) : tmpl.label(a),
      weaponKey,
    };
  });
  const fresh = { date: key, challenges, claimed: false };
  writeJson(STORE_DAILY, fresh);
  return fresh;
}
let daily = rollDailyChallenges();

function progressChallenge(id, n = 1, opts = {}) {
  let changed = false;
  for (const c of daily.challenges) {
    if (c.id !== id || c.done) continue;
    if (id === 'weapon' && opts.weapon !== c.weaponKey) continue;
    const before = c.progress;
    // For streak challenges we want "reach a N-kill streak" — set progress to max
    // observed streak rather than incrementing.
    if (opts.absolute) c.progress = Math.min(c.target, Math.max(c.progress, n));
    else               c.progress = Math.min(c.target, c.progress + n);
    if (c.progress >= c.target) {
      c.done = true;
      const earned = c.xp + c.coins;
      totalXP += c.xp;
      saveStr(STORE_XP, totalXP.toString());
      if (game.player) game.player.coins += c.coins;
      game.announceStreak(`CHALLENGE COMPLETE  +${c.xp} XP`, '#5effb8', 5);
      if (game.sfx) game.sfx.challenge && game.sfx.challenge();
    }
    if (c.progress !== before) changed = true;
  }
  if (changed) {
    writeJson(STORE_DAILY, daily);
    refreshDailyDisplay();
  }
}
// expose to game so player/awardKill can call into us
game.progressChallenge = progressChallenge;
game.bumpMastery = bumpMastery;
game.masteryForWeapon = masteryForWeapon;
game.totals = totals;

function refreshLevelDisplay() {
  const info = levelInfo(totalXP);
  document.getElementById('level-num').textContent = info.level;
  document.getElementById('xp-cur').textContent = info.current;
  document.getElementById('xp-need').textContent = info.needed;
  document.querySelector('#player-progress .xp-fill').style.width = (info.current / info.needed * 100) + '%';
  const ws = document.getElementById('win-streak-display');
  if (ws) {
    if (winStreak > 0) ws.textContent = `WIN STREAK: ${winStreak}` + (bestWinStreak > winStreak ? `  (BEST: ${bestWinStreak})` : '');
    else if (bestWinStreak > 0) ws.textContent = `BEST WIN STREAK: ${bestWinStreak}`;
    else ws.textContent = '';
  }
}

function refreshDailyDisplay() {
  const wrap = document.getElementById('daily-challenges');
  if (!wrap) return;
  wrap.innerHTML = '';
  for (const c of daily.challenges) {
    const row = document.createElement('div');
    row.className = 'daily-row' + (c.done ? ' done' : '');
    const pct = Math.min(100, (c.progress / c.target) * 100);
    row.innerHTML = `
      <div class="daily-text">${c.label} <span class="daily-prog">${c.progress}/${c.target}</span></div>
      <div class="daily-bar"><div class="daily-fill" style="width:${pct}%"></div></div>
      <div class="daily-reward">+${c.xp} XP · +${c.coins}¢ ${c.done ? '✓' : ''}</div>
    `;
    wrap.appendChild(row);
  }
}

function refreshTotalsDisplay() {
  const el = document.getElementById('career-totals');
  if (!el) return;
  el.innerHTML =
    `<span>MATCHES <b>${totals.matches}</b></span>` +
    `<span>KILLS <b>${totals.kills}</b></span>` +
    `<span>HEADSHOTS <b>${totals.headshots}</b></span>` +
    `<span>MULTIKILLS <b>${totals.multikills}</b></span>`;
}

function commitMatchXp() {
  const sessionXp = game.player.sessionXp || 0;
  const won = game.teamKills[game.player.team] >= game.matchGoal;
  const lost = game.teamKills[game.player.team === 'mash' ? 'russet' : 'mash'] >= game.matchGoal;

  // First-win-of-the-day bonus
  let firstWinBonus = 0;
  if (won) {
    const lastWin = localStorage.getItem(STORE_LAST_WIN_DAY);
    if (lastWin !== dayKey()) {
      firstWinBonus = 500;
      saveStr(STORE_LAST_WIN_DAY, dayKey());
    }
  }

  // Award bonuses (computed on match-end before commit)
  const awardXp = game._awardBonusXp || 0;

  const earned = sessionXp + (won ? 100 : (lost ? 20 : 0)) + firstWinBonus + awardXp;

  if (won) {
    winStreak += 1;
    if (winStreak > bestWinStreak) bestWinStreak = winStreak;
    progressChallenge('win', 1);
  } else if (lost) {
    winStreak = 0;
  }
  saveStr(STORE_WIN_STREAK, winStreak.toString());
  saveStr(STORE_BEST_WIN_STREAK, bestWinStreak.toString());

  totals.matches += 1;
  totals.kills += game.player.kills || 0;
  totals.headshots += game.player.matchStats?.headshots || 0;
  totals.multikills += game.player.matchStats?.multikills || 0;
  writeJson(STORE_TOTALS, totals);

  if (earned > 0) {
    const prevLevel = levelInfo(totalXP).level;
    totalXP += earned;
    localStorage.setItem(STORE_XP, totalXP.toString());
    const newLevel = levelInfo(totalXP).level;
    if (newLevel > prevLevel) {
      game.announceStreak(`LEVEL UP — LVL ${newLevel}`, '#5effb8', 5);
    }
  }
  refreshLevelDisplay();
  refreshDailyDisplay();
  refreshTotalsDisplay();
  return { earned, firstWinBonus, awardXp };
}

refreshLevelDisplay();
refreshDailyDisplay();
refreshTotalsDisplay();

const nameInput = document.getElementById('player-name-input');
nameInput.value = savedName;
const startBtn = document.getElementById('start-btn');
const respawnBtn = document.getElementById('respawn-btn');

let selectedWeapon = savedWeapon;
game.player.setLoadout(selectedWeapon);
game.player.switchWeapon(selectedWeapon);
if (savedName.trim()) game.player.name = savedName.trim();

// Persistent wallet — coins carry over from match to match until spent in the
// shop. Replaces the plain `coins` field with a getter/setter that auto-saves
// to localStorage and mirrors into the active account. Loaded from storage so
// returning players keep whatever they had.
let _coins = parseInt(localStorage.getItem(STORE_COINS) || '0', 10) || 0;
Object.defineProperty(game.player, 'coins', {
  configurable: true,
  enumerable: true,
  get: () => _coins,
  set: (v) => {
    _coins = Math.max(0, Math.floor(v) || 0);
    localStorage.setItem(STORE_COINS, String(_coins));
    Auth.syncActive();
  },
});

function weaponBlurb(w) {
  const parts = [`${w.damage} dmg`, `${w.magSize} mag`, `${w.reloadTime}s reload`];
  if (w.scope) parts.push('scope');
  if ((w.pellets || 1) > 1) parts.push(`${w.pellets} pellets`);
  if (w.auto) parts.push('auto');
  if (w.explosionRadius) parts.push('boom');
  return parts.join(' · ');
}

function buildPicker(containerId, onPick) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  for (const k of PRIMARY_KEYS) {
    const w = WEAPONS[k];
    const m = masteryForWeapon(k);
    const tierBadge = m.name
      ? `<div class="wp-tier" style="color:${m.color};border-color:${m.glow}">★ ${m.name.toUpperCase()}</div>`
      : '';
    const nextTier = MASTERY_TIERS.slice().reverse().find(t => t.min > m.kills);
    const progressBar = nextTier
      ? `<div class="wp-mastery"><div class="wp-mastery-bar"><div style="width:${Math.min(100, (m.kills / nextTier.min) * 100)}%"></div></div><span>${m.kills}/${nextTier.min}</span></div>`
      : `<div class="wp-mastery"><span style="color:${m.color}">${m.kills} kills · MAX TIER</span></div>`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'weapon-pick' + (m.name ? ` tier-${m.name.toLowerCase()}` : '');
    btn.dataset.key = k;
    btn.innerHTML = `
      ${tierBadge}
      <div class="wp-name">${w.name}</div>
      <div class="wp-stats">${weaponBlurb(w)}</div>
      <div class="wp-desc">${w.description || ''}</div>
      ${progressBar}
    `;
    btn.addEventListener('click', () => onPick(k));
    container.appendChild(btn);
  }
  return container;
}

function highlight(containerId, key) {
  const c = document.getElementById(containerId);
  for (const child of c.children) {
    child.classList.toggle('selected', child.dataset.key === key);
  }
}

function pickWeapon(key) {
  selectedWeapon = key;
  game.player.setLoadout(key);
  game.player.switchWeapon(key);
  saveStr(STORE_WEAPON, key);
  highlight('start-weapon-picker', key);
  highlight('death-weapon-picker', key);
  startBtn.disabled = false;
}

buildPicker('start-weapon-picker', pickWeapon);
buildPicker('death-weapon-picker', pickWeapon);
highlight('start-weapon-picker', selectedWeapon);
highlight('death-weapon-picker', selectedWeapon);
startBtn.disabled = false;

function commitName() {
  // Logged-in users can't rename — account username is authoritative.
  if (Auth.isLoggedIn()) {
    const u = Auth.getActive();
    nameInput.value = u;
    game.player.name = u;
    return;
  }
  const v = nameInput.value.trim();
  if (v) {
    game.player.name = v;
    saveStr(STORE_NAME, v);
  } else {
    game.player.name = 'You';
    localStorage.removeItem(STORE_NAME);
    Auth.syncActive();
  }
}
nameInput.addEventListener('input', commitName);
nameInput.addEventListener('keydown', (e) => {
  if (e.code === 'Enter' && !startBtn.disabled) startBtn.click();
});

// ---- Map picker (Classic vs Custom Voxel) ----
// Persisted to localStorage so the user's choice survives page reloads.
const STORE_MAP_CHOICE = 'spudshockers.mapchoice';
let mapChoice = localStorage.getItem(STORE_MAP_CHOICE) || 'classic';
function applyMapChoiceHighlight() {
  document.querySelectorAll('#map-picker .map-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.map === mapChoice);
  });
}
document.querySelectorAll('#map-picker .map-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    mapChoice = btn.dataset.map || 'classic';
    localStorage.setItem(STORE_MAP_CHOICE, mapChoice);
    applyMapChoiceHighlight();
  });
});
applyMapChoiceHighlight();

startBtn.addEventListener('click', async () => {
  commitName();
  // If the user picked a custom voxel map, try to load it before starting.
  // We do this BEFORE hiding the start screen so a load failure can show
  // a hint inline instead of dumping the player into a half-loaded match.
  if (mapChoice === 'custom') {
    startBtn.disabled = true;
    startBtn.textContent = 'LOADING MAP…';
    const ok = await game.loadVoxMap('maps/custom.vox');
    if (!ok) {
      startBtn.disabled = false;
      startBtn.textContent = 'START MASHING';
      const hint = document.querySelector('.map-hint');
      if (hint) {
        hint.innerHTML = '<b style="color:#ff5e3a">Could not load maps/custom.vox.</b> ' +
          'Make sure the file exists. Build one in MagicaVoxel and save as <code>maps/custom.vox</code>.';
      }
      return;
    }
    startBtn.textContent = 'START MASHING';
  }
  document.getElementById('start-screen').style.display = 'none';
  game.start();
});

// ---- Account UI (sign in / sign up / guest / logout) ----
// All persistence is handled by src/auth.js. After any state change we re-read
// localStorage to refresh the rest of the start screen (XP, mastery, totals,
// coins) so the user instantly sees their new account's saved progress.
const acctStatusText = document.getElementById('account-status-text');
const acctStatusCoins = document.getElementById('account-status-coins');
const acctSigninBtn  = document.getElementById('acct-signin-btn');
const acctSignupBtn  = document.getElementById('acct-signup-btn');
const acctGuestBtn   = document.getElementById('acct-guest-btn');
const acctExportBtn  = document.getElementById('acct-export-btn');
const acctImportBtn  = document.getElementById('acct-import-btn');
const acctLogoutBtn  = document.getElementById('acct-logout-btn');
const acctForm       = document.getElementById('acct-form');
const acctUsername   = document.getElementById('acct-username');
const acctPassword   = document.getElementById('acct-password');
const acctSubmit     = document.getElementById('acct-form-submit');
const acctCancel     = document.getElementById('acct-form-cancel');
const acctStatus     = document.getElementById('acct-form-status');

let acctFormMode = null; // 'signin' | 'signup' | null

function refreshAccountUI() {
  if (Auth.isLoggedIn()) {
    const u = Auth.getActive();
    acctStatusText.textContent = `LOGGED IN AS ${u}`;
    acctStatusText.className = 'logged-in';
    acctSigninBtn.style.display = 'none';
    acctSignupBtn.style.display = 'none';
    acctGuestBtn.style.display  = 'none';
    acctExportBtn.style.display = '';
    acctImportBtn.style.display = '';
    acctLogoutBtn.style.display = '';
    nameInput.value = u;
    nameInput.disabled = true;
    nameInput.title = 'Username comes from your account';
  } else if (Auth.isGuest()) {
    const guestName = localStorage.getItem(STORE_NAME) || randomGuestName();
    acctStatusText.textContent = `GUEST · ${guestName} · progress will not be saved`;
    acctStatusText.className = 'guest';
    acctSigninBtn.style.display = '';
    acctSignupBtn.style.display = '';
    acctGuestBtn.style.display  = 'none';
    acctExportBtn.style.display = 'none';
    acctImportBtn.style.display = '';
    acctLogoutBtn.style.display = 'none';
    nameInput.value = guestName;
    nameInput.disabled = true;
    nameInput.title = 'Guests get a random name';
  } else {
    acctStatusText.textContent = `Not signed in — sign up to save progress, or play as guest`;
    acctStatusText.className = '';
    acctSigninBtn.style.display = '';
    acctSignupBtn.style.display = '';
    acctGuestBtn.style.display  = '';
    acctExportBtn.style.display = 'none';
    acctImportBtn.style.display = '';
    acctLogoutBtn.style.display = 'none';
    nameInput.disabled = false;
    nameInput.title = '';
  }
  const c = parseInt(localStorage.getItem(STORE_COINS) || '0', 10) || 0;
  acctStatusCoins.innerHTML = `WALLET: <span class="coin-amt">${c}¢</span>`;
}

function openAcctForm(mode) {
  acctFormMode = mode;
  acctForm.style.display = 'flex';
  acctStatus.textContent = '';
  acctStatus.className = 'acct-status-line';
  acctUsername.value = '';
  acctPassword.value = '';
  acctSubmit.textContent = mode === 'signup' ? 'CREATE ACCOUNT' : 'SIGN IN';
  acctUsername.focus();
}
function closeAcctForm() {
  acctFormMode = null;
  acctForm.style.display = 'none';
  acctStatus.textContent = '';
}

acctSigninBtn.addEventListener('click', () => openAcctForm('signin'));
acctSignupBtn.addEventListener('click', () => openAcctForm('signup'));
acctCancel.addEventListener('click', closeAcctForm);

acctGuestBtn.addEventListener('click', () => {
  if (Auth.isLoggedIn()) return;
  // Confirm before wiping any anonymous (pre-account) progress
  const hasProgress = parseInt(localStorage.getItem(STORE_XP) || '0', 10) > 0
                   || parseInt(localStorage.getItem(STORE_COINS) || '0', 10) > 0;
  if (hasProgress && !confirm('Playing as guest will wipe your current unsaved progress (XP, coins, mastery). Sign up first to keep it. Continue as guest?')) {
    return;
  }
  Auth.startGuest();
  reloadProgressFromStorage();
  refreshAccountUI();
});

acctLogoutBtn.addEventListener('click', () => {
  if (!Auth.isLoggedIn()) return;
  if (!confirm('Log out? Your progress is safely saved to the account.')) return;
  Auth.logout();
  reloadProgressFromStorage();
  refreshAccountUI();
});

// Export — produces a long base64-ish code containing username + password hash
// + progress. User copies it and pastes it into IMPORT on the other site
// (localhost ↔ Netlify) to recreate the account there. Required because
// localStorage is per-origin, so accounts can't auto-sync between sites.
acctExportBtn.addEventListener('click', async () => {
  const code = Auth.exportActive();
  if (!code) { alert('Sign in first, then EXPORT.'); return; }
  try {
    await navigator.clipboard.writeText(code);
    alert('Account code copied to clipboard!\n\nOpen the other site (e.g. Netlify) and click IMPORT to paste it.\n\nYour password is preserved — sign in with the same password after importing.');
  } catch (_) {
    // Clipboard API can fail on insecure contexts; show the code so user can copy manually
    prompt('Copy this account code, then click IMPORT on the other site and paste it:', code);
  }
});

// Import — accepts the code produced by EXPORT. Recreates the account locally
// (including the same password hash, so the same password still works) and
// signs the user in immediately.
acctImportBtn.addEventListener('click', async () => {
  const code = prompt('Paste your account code (starts with SPUDACCT-):');
  if (!code) return;
  try {
    let username;
    try {
      username = Auth.importCode(code);
    } catch (e) {
      if (e.code === 'exists') {
        if (!confirm('An account with that username already exists on this site. Overwrite it with the imported one? (This replaces the local account\'s progress with the imported account\'s progress.)')) return;
        username = Auth.importCode(code, { overwrite: true });
      } else {
        throw e;
      }
    }
    reloadProgressFromStorage();
    refreshAccountUI();
    alert(`Imported ${username} successfully. You are now signed in with the same password as the original.`);
  } catch (err) {
    alert('Import failed: ' + (err.message || 'unknown error'));
  }
});

async function submitAcctForm() {
  const u = acctUsername.value.trim();
  const p = acctPassword.value;
  if (!u || !p) { acctStatus.textContent = 'enter username and password'; return; }
  acctSubmit.disabled = true;
  try {
    if (acctFormMode === 'signup') {
      await Auth.signup(u, p);
      acctStatus.className = 'acct-status-line ok';
      acctStatus.textContent = `account created — welcome, ${u}!`;
    } else {
      await Auth.login(u, p);
      acctStatus.className = 'acct-status-line ok';
      acctStatus.textContent = `signed in as ${u}`;
    }
    reloadProgressFromStorage();
    refreshAccountUI();
    setTimeout(closeAcctForm, 700);
  } catch (err) {
    acctStatus.className = 'acct-status-line';
    acctStatus.textContent = (err && err.message) || 'something went wrong';
  } finally {
    acctSubmit.disabled = false;
  }
}
acctSubmit.addEventListener('click', submitAcctForm);
acctPassword.addEventListener('keydown', (e) => { if (e.code === 'Enter') submitAcctForm(); });
acctUsername.addEventListener('keydown', (e) => { if (e.code === 'Enter') acctPassword.focus(); });

// Re-read every persistent stat from localStorage and push it into the live
// in-memory variables + UI. Called after login/signup/logout/guest so the
// start screen reflects the account that was just activated.
function reloadProgressFromStorage() {
  totalXP        = parseInt(localStorage.getItem(STORE_XP) || '0', 10) || 0;
  winStreak      = parseInt(localStorage.getItem(STORE_WIN_STREAK) || '0', 10) || 0;
  bestWinStreak  = parseInt(localStorage.getItem(STORE_BEST_WIN_STREAK) || '0', 10) || 0;
  mastery        = readJson(STORE_MASTERY, {});
  totals         = readJson(STORE_TOTALS, { matches: 0, kills: 0, headshots: 0, multikills: 0 });
  daily          = rollDailyChallenges();
  _coins         = parseInt(localStorage.getItem(STORE_COINS) || '0', 10) || 0;
  game.totals    = totals;
  const nm       = localStorage.getItem(STORE_NAME) || '';
  if (nm) game.player.name = nm;
  const w        = localStorage.getItem(STORE_WEAPON);
  if (w && WEAPONS[w] && w !== 'spudgun') {
    selectedWeapon = w;
    game.player.setLoadout(selectedWeapon);
    game.player.switchWeapon(selectedWeapon);
  }
  refreshLevelDisplay();
  refreshDailyDisplay();
  refreshTotalsDisplay();
  // Force rebuild of weapon pickers so mastery tiers refresh
  buildPicker('start-weapon-picker', pickWeapon);
  buildPicker('death-weapon-picker', pickWeapon);
  highlight('start-weapon-picker', selectedWeapon);
  highlight('death-weapon-picker', selectedWeapon);
}

refreshAccountUI();

respawnBtn.addEventListener('click', () => {
  game.respawn();
});

game.onMatchEnd = () => {
  // Compute awards before committing XP so the bonus rolls in.
  const awards = computeAwards(game);
  game._awardBonusXp = awards.reduce((s, a) => s + a.xp, 0);

  const result = commitMatchXp();
  const info = levelInfo(totalXP);
  const stats = document.getElementById('match-end-stats');
  let line = '';
  if (result.earned > 0) line += `+${result.earned} XP  ·  LVL ${info.level}`;
  if (result.firstWinBonus > 0) line += (line ? '  ·  ' : '') + `FIRST WIN OF DAY  +${result.firstWinBonus} XP`;
  if (winStreak > 1) line += (line ? '  ·  ' : '') + `WIN STREAK ${winStreak}`;
  if (line) stats.insertAdjacentHTML('beforeend', `<div class="end-stats-row">${line}</div>`);

  // Render awards
  renderAwards(awards);

  // Refresh start-screen weapon picker so mastery progress is visible next match
  buildPicker('start-weapon-picker', pickWeapon);
  buildPicker('death-weapon-picker', pickWeapon);
  highlight('start-weapon-picker', selectedWeapon);
  highlight('death-weapon-picker', selectedWeapon);
};

function computeAwards(game) {
  const allEntities = [game.player, ...game.bots];
  const awards = [];
  const ms = game.player.matchStats || {};

  // SHARPSHOOTER — highest accuracy (>= 5 shots fired to qualify)
  if (ms.shotsFired >= 5) {
    const acc = (ms.shotsHit / ms.shotsFired) * 100;
    if (acc >= 35) awards.push({ name: 'SHARPSHOOTER', detail: `${acc.toFixed(0)}% accuracy`, xp: 30 });
  }
  // HOT STREAK — peak streak >= 5
  if ((game.player.bestStreak || 0) >= 5) {
    awards.push({ name: 'HOT STREAK', detail: `${game.player.bestStreak} kill streak`, xp: 30 });
  }
  // HEADHUNTER — most headshots
  if ((ms.headshots || 0) >= 3) {
    awards.push({ name: 'HEADHUNTER', detail: `${ms.headshots} headshots`, xp: 35 });
  }
  // BERSERKER — multikills
  if ((ms.multikills || 0) >= 2) {
    awards.push({ name: 'BERSERKER', detail: `${ms.multikills} multikills`, xp: 35 });
  }
  // UNTOUCHABLE — low damage taken
  if ((ms.damageTaken || 0) < 200 && game.player.kills >= 5) {
    awards.push({ name: 'UNTOUCHABLE', detail: `only ${Math.round(ms.damageTaken)} dmg taken`, xp: 40 });
  }
  // SPECIAL CASTER — used T specials
  if ((ms.specialsUsed || 0) >= 3) {
    awards.push({ name: 'SPECIAL CASTER', detail: `${ms.specialsUsed} specials used`, xp: 25 });
  }
  // KILLSTREAK KING — triggered killstreak rewards
  if ((ms.killstreaksTriggered || 0) >= 2) {
    awards.push({ name: 'KILLSTREAK KING', detail: `${ms.killstreaksTriggered} streak rewards`, xp: 35 });
  }
  // LOOT GOBLIN — picked up multiple loot drops
  if ((ms.lootGrabbed || 0) >= 3) {
    awards.push({ name: 'LOOT GOBLIN', detail: `${ms.lootGrabbed} loot drops`, xp: 25 });
  }
  // MVP — most kills, always last so it ranks first visually
  const sorted = allEntities.slice().sort((a, b) => b.kills - a.kills);
  if (sorted[0] === game.player && game.player.kills > 0) {
    awards.unshift({ name: 'MVP', detail: `${game.player.kills} kills, top of the board`, xp: 50 });
  }
  return awards;
}

function renderAwards(awards) {
  const wrap = document.getElementById('match-end-awards');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!awards.length) return;
  wrap.style.display = 'flex';
  awards.forEach((a, i) => {
    const div = document.createElement('div');
    div.className = 'award-card';
    div.innerHTML = `
      <div class="award-name">${a.name}</div>
      <div class="award-detail">${a.detail}</div>
      <div class="award-xp">+${a.xp} XP</div>
    `;
    wrap.appendChild(div);
    setTimeout(() => div.classList.add('shown'), 200 + i * 180);
  });
}

document.getElementById('new-match-btn').addEventListener('click', () => {
  document.getElementById('match-end-awards').innerHTML = '';
  document.getElementById('match-end-awards').style.display = 'none';
  game.newMatch();
});

document.getElementById('shop-btn-hud').addEventListener('click', () => {
  game.openShop();
});

document.getElementById('chat-btn-hud').addEventListener('click', () => {
  game.player.openChat();
});

document.getElementById('dad-btn-hud').addEventListener('click', () => {
  game.toggleDadMode();
});

// ---- Multiplayer lobby UI ----
const mpHostBtn = document.getElementById('mp-host-btn');
const mpJoinBtn = document.getElementById('mp-join-btn');
const mpHostBox = document.getElementById('mp-host-box');
const mpJoinBox = document.getElementById('mp-join-box');
const mpConnectedBox = document.getElementById('mp-connected-box');
const mpHostCodeEl = document.getElementById('mp-host-code');
const mpJoinInput = document.getElementById('mp-join-input');
const mpJoinConfirm = document.getElementById('mp-join-confirm');
const mpJoinStatus = document.getElementById('mp-join-status');

function setMpBoxes(active) {
  mpHostBox.style.display = active === 'host' ? 'block' : 'none';
  mpJoinBox.style.display = active === 'join' ? 'block' : 'none';
  mpConnectedBox.style.display = active === 'connected' ? 'block' : 'none';
  mpHostBtn.classList.toggle('active', active === 'host' || active === 'host-connected');
  mpJoinBtn.classList.toggle('active', active === 'join' || active === 'join-connected');
}

mpHostBtn.addEventListener('click', async () => {
  setMpBoxes('host');
  mpHostCodeEl.textContent = '...';
  const mp = new Multiplayer(game);
  mp.onConnect((info) => {
    if (info.code && !info.peer) {
      mpHostCodeEl.textContent = info.code;
      renderShareLink(info.code);
    }
    if (info.peer) {
      // Dad joined — set up multiplayer and drop straight into the game so
      // both peers are spawned in the world by the time the data channel is
      // exchanging state. Without this the host would still be on the start
      // screen and dad's view would show an empty arena (host never ticks).
      setMpBoxes('connected');
      game.setupMultiplayer(mp, 'host');
      autoStartGameOnConnect();
    }
  });
  try {
    await mp.host();
  } catch (err) {
    const m = (err && (err.message || err.type)) || '';
    mpHostCodeEl.textContent = m === 'host-timeout' ? 'timed out — retry' : 'failed — retry';
    console.error(err);
  }
});

// Build a "click and you're in" share URL with ?join=CODE so the user can
// just paste it to dad. Auto-handles both start-screen and in-game flows.
function renderShareLink(code) {
  const wrap = document.getElementById('mp-host-box');
  if (!wrap) return;
  let row = document.getElementById('mp-share-link-row');
  if (!row) {
    row = document.createElement('div');
    row.id = 'mp-share-link-row';
    row.className = 'mp-hint';
    row.style.marginTop = '6px';
    wrap.appendChild(row);
  }
  const url = `${location.origin}${location.pathname}?join=${code}`;
  row.innerHTML = `LINK: <a href="${url}" id="mp-share-link" style="color:#5effb8">${url}</a> <button type="button" id="mp-copy-link" style="margin-left:6px;padding:2px 8px">COPY</button>`;
  const copyBtn = document.getElementById('mp-copy-link');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      navigator.clipboard?.writeText(url);
      copyBtn.textContent = 'COPIED!';
      setTimeout(() => { copyBtn.textContent = 'COPY'; }, 1500);
    });
  }
}

function renderIngameShareLink(code) {
  const wrap = document.getElementById('mp-ingame-host-box');
  if (!wrap) return;
  let row = document.getElementById('mp-ingame-share-link-row');
  if (!row) {
    row = document.createElement('div');
    row.id = 'mp-ingame-share-link-row';
    row.className = 'mp-hint';
    row.style.marginTop = '6px';
    wrap.appendChild(row);
  }
  const url = `${location.origin}${location.pathname}?join=${code}`;
  row.innerHTML = `LINK: <a href="${url}" style="color:#5effb8;word-break:break-all">${url}</a> <button type="button" id="mp-ingame-copy-link" style="margin-left:6px;padding:2px 8px">COPY</button>`;
  const copyBtn = document.getElementById('mp-ingame-copy-link');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      navigator.clipboard?.writeText(url);
      copyBtn.textContent = 'COPIED!';
      setTimeout(() => { copyBtn.textContent = 'COPY'; }, 1500);
    });
  }
}

// Auto-join when the page is opened via ?join=CODE
const _params = new URLSearchParams(location.search);
const _autoJoinCode = (_params.get('join') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
if (_autoJoinCode.length === 4) {
  // Defer one tick so all DOM listeners are attached
  setTimeout(() => {
    setMpBoxes('join');
    mpJoinInput.value = _autoJoinCode;
    mpJoinConfirm.click();
  }, 50);
}

mpJoinBtn.addEventListener('click', () => {
  setMpBoxes('join');
  mpJoinInput.focus();
});

mpJoinInput.addEventListener('input', () => {
  mpJoinInput.value = mpJoinInput.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
});
mpJoinInput.addEventListener('keydown', (e) => {
  if (e.code === 'Enter') mpJoinConfirm.click();
});

// Game mode toggle — pickable before host/join AND inside the connected panel.
// Both the start-screen button and the in-game modal button reflect the same
// game.gameMode state, and either can flip it.
const mpModeBtn = document.getElementById('mp-mode-btn');
const mpIngameModeBtn = document.getElementById('mp-ingame-mode-btn');
function setModeBtnLook(btn) {
  if (!btn) return;
  if (game.gameMode === '1v1') {
    btn.classList.add('mode-1v1');
    btn.textContent = '1V1 · FIRST TO 5';
  } else {
    btn.classList.remove('mode-1v1');
    btn.textContent = 'TEAM · FIRST TO 30';
  }
}
function refreshAllModeBtns() {
  setModeBtnLook(mpModeBtn);
  setModeBtnLook(mpIngameModeBtn);
  // Reflect connection state on the HUD "PLAY DAD" button too
  const hudBtn = document.getElementById('mp-btn-hud');
  if (hudBtn) {
    const live = !!(game.multiplayer && game.multiplayer.connected);
    hudBtn.classList.toggle('connected', live);
    hudBtn.textContent = live ? 'DAD ONLINE' : 'PLAY DAD';
  }
}
function toggleMode() {
  const next = game.gameMode === '1v1' ? 'team' : '1v1';
  game.setGameMode(next);
  refreshAllModeBtns();
}
if (mpModeBtn) mpModeBtn.addEventListener('click', toggleMode);
if (mpIngameModeBtn) mpIngameModeBtn.addEventListener('click', toggleMode);
setInterval(refreshAllModeBtns, 500);
refreshAllModeBtns();

function describeJoinError(err) {
  const msg = (err && (err.message || err.type)) || '';
  if (msg === 'peer-unavailable') return 'no host with that code — ask dad to rehost';
  if (msg === 'join-timeout')     return 'timed out — ask dad to refresh & rehost';
  if (msg === 'network')          return 'network error — check your internet';
  if (msg === 'disconnected')     return 'signaling dropped — try again';
  return 'connect failed — check the code or rehost';
}

// Drop the player into the running game the moment we have a connection.
// Called on both sides as soon as the peer link is up so:
//   - the joiner doesn't have to click START MASHING after entering a code
//   - the host who set up from the start screen doesn't sit there waiting
//     for dad to finish his own START click
// If the game is already running (e.g. they hosted from in-game) this is a
// no-op apart from hiding the start screen.
function autoStartGameOnConnect() {
  commitName();
  const startScreen = document.getElementById('start-screen');
  if (startScreen && startScreen.style.display !== 'none') {
    startScreen.style.display = 'none';
  }
  // Clear any blocking overlays so the joiner spawns directly into the match
  // even if they were sitting on a death screen / match-end screen.
  const deathScreen = document.getElementById('death-screen');
  if (deathScreen && deathScreen.style.display !== 'none') deathScreen.style.display = 'none';
  const matchEndScreen = document.getElementById('match-end-screen');
  if (matchEndScreen && matchEndScreen.style.display !== 'none') matchEndScreen.style.display = 'none';
  if (!game.running) {
    game.start();
  } else if (game.player && game.player.dead) {
    // Already running but stuck dead on a death screen — respawn instantly.
    game.respawn();
  }
  // Pointer lock requires a recent user gesture in some browsers, but the
  // click that triggered this path counts. Failure here is fine — the canvas
  // click listener will reclaim it on the next click.
  try { if (!document.pointerLockElement && canvas) canvas.requestPointerLock(); } catch (_) {}
}

mpJoinConfirm.addEventListener('click', async () => {
  const code = mpJoinInput.value.trim().toUpperCase();
  if (code.length < 4) {
    mpJoinStatus.textContent = 'enter 4-letter code';
    return;
  }
  mpJoinStatus.textContent = 'connecting…';
  const mp = new Multiplayer(game);
  // Stream multiplayer's own log messages into the visible status line so a
  // stuck join shows ICE state instead of a frozen "connecting…". The user
  // can tell us what the last log was if it never completes.
  mp.onLog((line) => {
    if (mp.connected) return;
    mpJoinStatus.textContent = String(line);
  });
  mp.onConnect((info) => {
    if (info.peer) {
      setMpBoxes('connected');
      game.setupMultiplayer(mp, 'client');
      autoStartGameOnConnect();
    }
  });
  try {
    await mp.join(code);
  } catch (err) {
    mpJoinStatus.textContent = describeJoinError(err);
    console.error(err);
  }
});

// ---- In-game host/join overlay (HUD button "PLAY DAD") ----
// Lets the user host or join from the middle of an active match, so a friend
// can be pulled into the live game. Reuses the same Multiplayer class as the
// start-screen lobby.
const mpModal       = document.getElementById('mp-ingame-modal');
const mpBtnHud      = document.getElementById('mp-btn-hud');
const mpModalClose  = document.getElementById('mp-ingame-close');
const mpInHost      = document.getElementById('mp-ingame-host-btn');
const mpInJoin      = document.getElementById('mp-ingame-join-btn');
const mpInHostBox   = document.getElementById('mp-ingame-host-box');
const mpInJoinBox   = document.getElementById('mp-ingame-join-box');
const mpInConnBox   = document.getElementById('mp-ingame-connected-box');
const mpInHostCode  = document.getElementById('mp-ingame-host-code');
const mpInJoinInput = document.getElementById('mp-ingame-join-input');
const mpInJoinGo    = document.getElementById('mp-ingame-join-confirm');
const mpInJoinStat  = document.getElementById('mp-ingame-join-status');

function openMpIngame() {
  if (!mpModal) return;
  mpModal.classList.add('open');
  // Already connected? Skip the host/join buttons and show the connected box.
  if (game.multiplayer && game.multiplayer.connected) {
    mpInHostBox.style.display = 'none';
    mpInJoinBox.style.display = 'none';
    mpInConnBox.style.display = 'block';
  } else {
    mpInHostBox.style.display = 'none';
    mpInJoinBox.style.display = 'none';
    mpInConnBox.style.display = 'none';
  }
  if (document.pointerLockElement) document.exitPointerLock();
}
function closeMpIngame() {
  if (!mpModal) return;
  mpModal.classList.remove('open');
}
if (mpBtnHud)     mpBtnHud.addEventListener('click', openMpIngame);
if (mpModalClose) mpModalClose.addEventListener('click', closeMpIngame);

if (mpInHost) {
  mpInHost.addEventListener('click', async () => {
    mpInHostBox.style.display = 'block';
    mpInJoinBox.style.display = 'none';
    mpInConnBox.style.display = 'none';
    mpInHostCode.textContent = '...';
    // If a previous session exists, dispose it first
    if (game.multiplayer) { try { game.multiplayer.dispose(); } catch (_) {} }
    const mp = new Multiplayer(game);
    mp.onConnect((info) => {
      if (info.code && !info.peer) {
        mpInHostCode.textContent = info.code;
        renderIngameShareLink(info.code);
      }
      if (info.peer) {
        mpInHostBox.style.display = 'none';
        mpInJoinBox.style.display = 'none';
        mpInConnBox.style.display = 'block';
        game.setupMultiplayer(mp, 'host');
        // Sync world for the freshly-joined client by resetting the match,
        // then close the modal and reclaim pointer lock so the host is back
        // in the action immediately. The client's auto-start drops them in
        // on their side at the same moment.
        if (game.newMatch) game.newMatch();
        closeMpIngame();
        try { if (!document.pointerLockElement && canvas) canvas.requestPointerLock(); } catch (_) {}
      }
    });
    try { await mp.host(); }
    catch (err) {
      const m = (err && (err.message || err.type)) || '';
      mpInHostCode.textContent = m === 'host-timeout' ? 'timed out — retry' : 'failed — retry';
      console.error(err);
    }
  });
}

if (mpInJoin) {
  mpInJoin.addEventListener('click', () => {
    mpInJoinBox.style.display = 'block';
    mpInHostBox.style.display = 'none';
    mpInConnBox.style.display = 'none';
    mpInJoinInput.focus();
  });
}

if (mpInJoinInput) {
  mpInJoinInput.addEventListener('input', () => {
    mpInJoinInput.value = mpInJoinInput.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  });
  mpInJoinInput.addEventListener('keydown', (e) => {
    if (e.code === 'Enter') mpInJoinGo.click();
  });
}

if (mpInJoinGo) {
  mpInJoinGo.addEventListener('click', async () => {
    const code = mpInJoinInput.value.trim().toUpperCase();
    if (code.length < 4) { mpInJoinStat.textContent = 'enter 4-letter code'; return; }
    mpInJoinStat.textContent = 'connecting…';
    if (game.multiplayer) { try { game.multiplayer.dispose(); } catch (_) {} }
    const mp = new Multiplayer(game);
    mp.onLog((line) => { if (!mp.connected) mpInJoinStat.textContent = String(line); });
    mp.onConnect((info) => {
      if (info.peer) {
        mpInJoinBox.style.display = 'none';
        mpInHostBox.style.display = 'none';
        mpInConnBox.style.display = 'block';
        game.setupMultiplayer(mp, 'client');
        closeMpIngame();
        autoStartGameOnConnect();
      }
    });
    try { await mp.join(code); }
    catch (err) { mpInJoinStat.textContent = describeJoinError(err); console.error(err); }
  });
}

// ESC closes the in-game MP modal
document.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && mpModal && mpModal.classList.contains('open')) {
    closeMpIngame();
  }
});

// Click on the chat-input wrap re-focuses the input — protects against any
// browser quirk where focus drifts off after pointer-lock release.
const chatWrapEl = document.getElementById('chat-input-wrap');
const chatInputEl = document.getElementById('chat-input');
if (chatWrapEl && chatInputEl) {
  chatWrapEl.addEventListener('click', () => chatInputEl.focus());
}

// DAD player 2 input — arrow keys to move/turn, "/" to shoot (held), "." jump,
// "," reload. Keys are written to game.dadKeys; bot.manualUpdate reads them.
// F8 toggles dad mode on/off.
const DAD_KEY_CODES = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Slash', 'Period', 'Comma',
]);
document.addEventListener('keydown', (e) => {
  if (e.code === 'F8') {
    e.preventDefault();
    game.toggleDadMode();
    return;
  }
  // Don't capture dad keys while player is typing in chat
  if (game.player && game.player.chatOpen) return;
  if (DAD_KEY_CODES.has(e.code)) {
    e.preventDefault();
    game.dadKeys[e.code] = true;
  }
});
document.addEventListener('keyup', (e) => {
  if (DAD_KEY_CODES.has(e.code)) game.dadKeys[e.code] = false;
});

// Music controls — M mutes, slider sets volume, mute button toggles. Track
// name shows the currently-playing file (sans .mp3 / dashes for readability).
const musicWidget = document.getElementById('music-widget');
const muteBtn = document.getElementById('music-mute');
const volSlider = document.getElementById('music-vol');
const trackLabel = document.getElementById('music-track');

function syncMusicUI() {
  if (!game.bgm) return;
  volSlider.value = String(game.bgm.userVolume);
  muteBtn.classList.toggle('muted', game.bgm.muted);
  const t = game.bgm.currentTrackName || '';
  const pretty = t.replace(/\.mp3$/i, '').replace(/[-_]+/g, ' ').toUpperCase();
  trackLabel.textContent = pretty;
}
syncMusicUI();

volSlider.addEventListener('input', () => {
  if (game.bgm) game.bgm.setUserVolume(parseFloat(volSlider.value));
  syncMusicUI();
});
muteBtn.addEventListener('click', () => {
  if (game.bgm) game.bgm.toggleMute();
  syncMusicUI();
});
document.addEventListener('keydown', (e) => {
  if (game.player && game.player.chatOpen) return;
  if (e.code === 'KeyM') {
    if (game.bgm) game.bgm.toggleMute();
    syncMusicUI();
  }
});
// Poll the BGM for the active track so the label updates after crossfades
setInterval(syncMusicUI, 500);

document.addEventListener('click', (e) => {
  if (e.target.closest('button')) return;
  if (e.target.closest('input')) return;
  if (e.target.closest('#shop-modal.open')) return;
  if (e.target.closest('#mp-ingame-modal.open')) return;
  if (e.target.closest('#match-end-screen[style*="flex"]')) return;
  if (game.shop && game.shop.isOpen()) return;
  if (game.matchOver) return;
  if (mpModal && mpModal.classList.contains('open')) return;
  if (!document.pointerLockElement && game.running && !game.player.dead) {
    canvas.requestPointerLock();
  }
});

window.__game = game;
