// Local-only account system. Accounts live in localStorage with SHA-256
// hashed passwords + per-account random salt. This is NOT real security
// (anyone with file-system or devtools access can read localStorage), but it
// keeps passwords out of plaintext and is the strongest we can do without a
// backend server. Good enough for "dad won't see my password if he peeks".

const STORE_ACCOUNTS    = 'spudshockers.accounts';
const STORE_ACTIVE_USER = 'spudshockers.activeUser';
const STORE_GUEST_MODE  = 'spudshockers.guestMode';

// Live-progress keys: copied INTO an account on signup, OUT of an account on
// login, and overwritten ↔ wiped on logout/guest. Keep this list in sync with
// every persistent stat main.js touches, or that stat won't follow the user.
export const PROGRESS_KEYS = [
  'spudshockers.name',
  'spudshockers.weapon',
  'spudshockers.xp',
  'spudshockers.winstreak',
  'spudshockers.bestwinstreak',
  'spudshockers.mastery',
  'spudshockers.daily',
  'spudshockers.lastwinday',
  'spudshockers.totals',
  'spudshockers.coins',
];

async function hashPw(password, salt) {
  const enc = new TextEncoder();
  const buf = enc.encode(salt + ':' + password);
  const h = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function readAccounts() {
  try { return JSON.parse(localStorage.getItem(STORE_ACCOUNTS) || '{}') || {}; }
  catch { return {}; }
}
function writeAccounts(a) {
  localStorage.setItem(STORE_ACCOUNTS, JSON.stringify(a));
}

function snapshotProgress() {
  const s = {};
  for (const k of PROGRESS_KEYS) {
    const v = localStorage.getItem(k);
    if (v !== null) s[k] = v;
  }
  return s;
}

function restoreProgress(s) {
  for (const k of PROGRESS_KEYS) {
    if (s && k in s) localStorage.setItem(k, s[k]);
    else localStorage.removeItem(k);
  }
}

const GUEST_NAMES = [
  'Spudling', 'TaterTot', 'FreshFry', 'Mashy', 'YamYam', 'ChipMonk',
  'Hashbrown', 'SpiceFry', 'BakedOne', 'TaterTrot', 'Curly', 'WedgeBoy',
  'PotatoPete', 'TaterFury', 'SpudRogue', 'ChipShot', 'FryGuy', 'TaterKing',
];
export function randomGuestName() {
  const n = GUEST_NAMES[Math.floor(Math.random() * GUEST_NAMES.length)];
  return n + Math.floor(Math.random() * 900 + 100);
}

export const Auth = {
  getActive() { return localStorage.getItem(STORE_ACTIVE_USER) || ''; },
  isGuest()   { return localStorage.getItem(STORE_GUEST_MODE) === '1' && !this.getActive(); },
  isLoggedIn(){ return !!this.getActive(); },
  listUsers() { return Object.keys(readAccounts()); },
  exists(username) { return !!readAccounts()[username.trim()]; },

  // Sign up — snapshots whatever progress is currently in localStorage into the
  // new account so the player's pre-account play is preserved. Then marks them
  // logged in so subsequent progress writes follow the account.
  async signup(username, password) {
    username = (username || '').trim();
    if (!username)            throw new Error('username required');
    if (username.length > 14) throw new Error('username too long (max 14)');
    if (!password || password.length < 4) throw new Error('password must be 4+ chars');
    const accounts = readAccounts();
    if (accounts[username]) throw new Error('username already taken');
    const salt = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const passwordHash = await hashPw(password, salt);
    accounts[username] = { passwordHash, salt, data: snapshotProgress(), createdAt: Date.now() };
    writeAccounts(accounts);
    localStorage.setItem(STORE_ACTIVE_USER, username);
    localStorage.removeItem(STORE_GUEST_MODE);
    localStorage.setItem('spudshockers.name', username);
    return username;
  },

  // Sign in — verifies the password, then overwrites live keys with the
  // account's saved snapshot so the UI immediately reflects their progress.
  async login(username, password) {
    username = (username || '').trim();
    const accounts = readAccounts();
    const acct = accounts[username];
    if (!acct) throw new Error('no account with that name');
    const hash = await hashPw(password, acct.salt);
    if (hash !== acct.passwordHash) throw new Error('wrong password');
    restoreProgress(acct.data || {});
    localStorage.setItem(STORE_ACTIVE_USER, username);
    localStorage.removeItem(STORE_GUEST_MODE);
    localStorage.setItem('spudshockers.name', username);
    return username;
  },

  // Called after every progress change to mirror live state into the account.
  // Cheap (one JSON.stringify of ~10 keys) and idempotent.
  syncActive() {
    const u = this.getActive();
    if (!u) return;
    const accounts = readAccounts();
    if (!accounts[u]) return;
    accounts[u].data = snapshotProgress();
    writeAccounts(accounts);
  },

  // Guest mode: wipe live progress, assign a random spud-themed name. Setting
  // STORE_GUEST_MODE makes the next page load wipe again, so a guest's session
  // never persists across refresh (matches "doesn't save progress").
  startGuest() {
    restoreProgress({});
    localStorage.removeItem(STORE_ACTIVE_USER);
    localStorage.setItem(STORE_GUEST_MODE, '1');
    const guestName = randomGuestName();
    localStorage.setItem('spudshockers.name', guestName);
    return guestName;
  },

  logout() {
    return this.startGuest();
  },

  // Export the active account as a portable text code. Includes username,
  // passwordHash, salt, and progress data so importing on another origin
  // (e.g. Netlify) recreates the account 1:1. Base64 keeps it copy/paste safe.
  // Returns null if no user is active.
  exportActive() {
    const u = this.getActive();
    if (!u) return null;
    const accounts = readAccounts();
    const acct = accounts[u];
    if (!acct) return null;
    const payload = {
      v: 1,
      username: u,
      passwordHash: acct.passwordHash,
      salt: acct.salt,
      createdAt: acct.createdAt || Date.now(),
      data: acct.data || {},
    };
    const json = JSON.stringify(payload);
    // btoa needs latin1; encode UTF-8 first
    const b64 = btoa(unescape(encodeURIComponent(json)));
    return 'SPUDACCT-' + b64;
  },

  // Import a code produced by exportActive(). If overwrite is false and the
  // username already exists locally, throws — caller can prompt the user.
  // After import, the imported account becomes the active user.
  importCode(code, { overwrite = false } = {}) {
    if (!code) throw new Error('paste an account code');
    code = code.trim();
    if (!code.startsWith('SPUDACCT-')) throw new Error('not a valid account code');
    let payload;
    try {
      const json = decodeURIComponent(escape(atob(code.slice('SPUDACCT-'.length))));
      payload = JSON.parse(json);
    } catch (_) {
      throw new Error('account code is corrupted');
    }
    if (!payload.username || !payload.passwordHash || !payload.salt) {
      throw new Error('account code is missing fields');
    }
    const accounts = readAccounts();
    if (accounts[payload.username] && !overwrite) {
      const e = new Error('account already exists on this site');
      e.code = 'exists';
      throw e;
    }
    accounts[payload.username] = {
      passwordHash: payload.passwordHash,
      salt: payload.salt,
      createdAt: payload.createdAt || Date.now(),
      data: payload.data || {},
    };
    writeAccounts(accounts);
    // Mark imported account as active and restore its progress to live keys
    restoreProgress(payload.data || {});
    localStorage.setItem(STORE_ACTIVE_USER, payload.username);
    localStorage.removeItem(STORE_GUEST_MODE);
    localStorage.setItem('spudshockers.name', payload.username);
    return payload.username;
  },

  // Run once on page load — restore account state if logged in, or re-wipe if
  // returning as a guest. Does NOT touch progress for "anonymous" users
  // (never signed up, never chose guest) so legacy single-player progress
  // is preserved until they make a choice.
  bootstrap() {
    const active = this.getActive();
    if (active) {
      const accounts = readAccounts();
      if (accounts[active]) {
        restoreProgress(accounts[active].data || {});
        localStorage.setItem('spudshockers.name', active);
        return { state: 'logged-in', user: active };
      }
      // Stale active user — account was deleted. Fall through to anonymous.
      localStorage.removeItem(STORE_ACTIVE_USER);
    }
    if (localStorage.getItem(STORE_GUEST_MODE) === '1') {
      const guestName = this.startGuest();
      return { state: 'guest', user: guestName };
    }
    return { state: 'anonymous', user: localStorage.getItem('spudshockers.name') || '' };
  },
};
