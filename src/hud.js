import { WEAPONS, WEAPON_ORDER } from './weapons.js';

const BUFF_LABELS = {
  speed: 'SPD',
  reload: 'RLD',
  damage: 'DMG',
  multishot: 'MUL',
};

// SVG reticles for ADS — each lives in a -30 -30 60 60 viewBox.
// .shadow renders first as a black stroke for contrast against bright backgrounds.
const ADS_RETICLES = {
  // Pistol — front sight blade boxed by rear sight ears (notch)
  'iron-post': `
    <svg viewBox="-30 -30 60 60" xmlns="http://www.w3.org/2000/svg">
      <g class="shadow">
        <rect x="-1.4" y="-13" width="2.8" height="12"/>
        <rect x="-15" y="2.6" width="12" height="3"/>
        <rect x="3" y="2.6" width="12" height="3"/>
        <rect x="-15" y="2.6" width="3" height="9.5"/>
        <rect x="12" y="2.6" width="3" height="9.5"/>
      </g>
      <rect class="fill" x="-1.4" y="-13" width="2.8" height="12"/>
      <rect class="fill" x="-15" y="2.6" width="12" height="3"/>
      <rect class="fill" x="3" y="2.6" width="12" height="3"/>
      <rect class="fill" x="-15" y="2.6" width="3" height="9.5"/>
      <rect class="fill" x="12" y="2.6" width="3" height="9.5"/>
    </svg>
  `,
  // Assault rifle — chevron + dot inside a thin reflex ring
  'red-dot': `
    <svg viewBox="-30 -30 60 60" xmlns="http://www.w3.org/2000/svg">
      <circle class="shadow" cx="0" cy="0" r="14"/>
      <path class="shadow" d="M -6 1.5 L 0 -4.5 L 6 1.5" stroke-linecap="round" stroke-linejoin="round"/>
      <circle class="stroke" cx="0" cy="0" r="14" stroke-width="1.7"/>
      <path class="stroke" d="M -6 1.5 L 0 -4.5 L 6 1.5" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
      <circle class="dot" cx="0" cy="0" r="1.5"/>
    </svg>
  `,
  // Pump shotgun — 4 inward-facing arcs framing the spread + tiny center dot
  'shotgun-arcs': `
    <svg viewBox="-30 -30 60 60" xmlns="http://www.w3.org/2000/svg">
      <g class="shadow">
        <path d="M -9 -17 A 19 19 0 0 1 9 -17"/>
        <path d="M 9 17 A 19 19 0 0 1 -9 17"/>
        <path d="M -17 -9 A 19 19 0 0 0 -17 9"/>
        <path d="M 17 -9 A 19 19 0 0 1 17 9"/>
      </g>
      <g class="stroke" stroke-width="2.2" stroke-linecap="round">
        <path d="M -9 -17 A 19 19 0 0 1 9 -17"/>
        <path d="M 9 17 A 19 19 0 0 1 -9 17"/>
        <path d="M -17 -9 A 19 19 0 0 0 -17 9"/>
        <path d="M 17 -9 A 19 19 0 0 1 17 9"/>
      </g>
      <circle class="fill" cx="0" cy="0" r="1.3"/>
    </svg>
  `,
  // Double-barrel — left & right parens hugging a center bead
  'rib-bead': `
    <svg viewBox="-30 -30 60 60" xmlns="http://www.w3.org/2000/svg">
      <g class="shadow" stroke-linecap="round">
        <path d="M -11 -8 Q -18 0 -11 8"/>
        <path d="M 11 -8 Q 18 0 11 8"/>
      </g>
      <g class="stroke" stroke-width="2.4" stroke-linecap="round">
        <path d="M -11 -8 Q -18 0 -11 8"/>
        <path d="M 11 -8 Q 18 0 11 8"/>
      </g>
      <circle class="fill" cx="0" cy="0" r="2.4"/>
    </svg>
  `,
  // SMG — holographic style: red dot with 4 corner ticks
  'holo': `
    <svg viewBox="-30 -30 60 60" xmlns="http://www.w3.org/2000/svg">
      <g class="shadow" stroke-linecap="round" stroke-linejoin="round">
        <path d="M -11 -7 L -11 -11 L -7 -11"/>
        <path d="M 7 -11 L 11 -11 L 11 -7"/>
        <path d="M -11 7 L -11 11 L -7 11"/>
        <path d="M 7 11 L 11 11 L 11 7"/>
      </g>
      <g class="stroke" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <path d="M -11 -7 L -11 -11 L -7 -11"/>
        <path d="M 7 -11 L 11 -11 L 11 -7"/>
        <path d="M -11 7 L -11 11 L -7 11"/>
        <path d="M 7 11 L 11 11 L 11 7"/>
      </g>
      <circle class="dot" cx="0" cy="0" r="1.7"/>
    </svg>
  `,
  // Grenade launcher — leaf sight: tall mast with stacked range hashes
  'leaf': `
    <svg viewBox="-30 -30 60 60" xmlns="http://www.w3.org/2000/svg">
      <g class="shadow">
        <rect x="-0.9" y="-15" width="1.8" height="30"/>
        <rect x="-8" y="-1.3" width="16" height="2.6"/>
        <rect x="-4.5" y="-7" width="9" height="1.7"/>
        <rect x="-3" y="-12" width="6" height="1.5"/>
        <rect x="-6" y="5" width="12" height="1.7"/>
        <rect x="-15" y="-0.7" width="6" height="1.4"/>
        <rect x="9" y="-0.7" width="6" height="1.4"/>
      </g>
      <rect class="fill" x="-0.9" y="-15" width="1.8" height="30"/>
      <rect class="fill" x="-8" y="-1.3" width="16" height="2.6"/>
      <rect class="fill" x="-4.5" y="-7" width="9" height="1.7"/>
      <rect class="fill" x="-3" y="-12" width="6" height="1.5"/>
      <rect class="fill" x="-6" y="5" width="12" height="1.7"/>
      <rect class="fill" x="-15" y="-0.7" width="6" height="1.4"/>
      <rect class="fill" x="9" y="-0.7" width="6" height="1.4"/>
    </svg>
  `,
};

export class HUD {
  constructor(game) {
    this.game = game;
    this.healthFill = document.getElementById('health-fill');
    this.healthText = document.getElementById('health-text');
    this.weaponName = document.getElementById('weapon-name');
    this.ammoText = document.getElementById('ammo');
    this.killFeed = document.getElementById('kill-feed');
    this.weaponList = document.getElementById('weapon-list');
    this.scope = document.getElementById('scope-overlay');
    this.crosshair = document.getElementById('crosshair');
    this.reloadBar = document.getElementById('reload-bar');
    this.reloadFill = document.getElementById('reload-fill');
    this.coinDisplay = document.getElementById('coin-display');
    this.killsDisplay = document.getElementById('kills-display');
    this.xpDisplay = document.getElementById('xp-display');
    this.leaderboard = document.getElementById('leaderboard');
    this.buffBar = document.getElementById('buff-bar');
    this.tsMash = document.getElementById('ts-mash');
    this.tsRusset = document.getElementById('ts-russet');
    this.tsGoal = document.getElementById('ts-goal');
    this.streakChip = document.getElementById('streak-chip');
    this.frenzyTimer = null;
    this.dmgDirLayer = this.makeDmgDirLayer();
    this.chatLog = document.getElementById('chat-log');
    this.comboMeter = document.getElementById('combo-meter');
    this.slideChip = document.getElementById('slide-chip');
    this.nametagLayer = document.getElementById('nametag-layer');
    this.lockonTarget = document.getElementById('lockon-target');
    this.lockonInfo = document.getElementById('lockon-info');
    this.momentumChip = document.getElementById('momentum-chip');
    // Pool of reusable nametag divs keyed by entity id ('bot_<n>' or 'player')
    this.nametags = new Map();
    this._lastMomentum = null;
    this.buildWeaponList();
  }

  renderChat(entry) {
    if (!this.chatLog) return;
    const div = document.createElement('div');
    const cls = ['chat-msg', 'team-' + entry.team, 'persona-' + entry.personality];
    if (entry.fromPlayer) cls.push('from-player');
    div.className = cls.join(' ');
    const tag = entry.team === 'mash' ? 'MASH' : 'RUSSET';
    const safeText = String(entry.text).replace(/[&<>]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
    div.innerHTML =
      `<span class="chat-team-tag">[${tag}]</span>` +
      `<span class="chat-name" style="color:${entry.color}">${entry.name}:</span> ${safeText}`;
    this.chatLog.appendChild(div);
    while (this.chatLog.children.length > 8) this.chatLog.firstChild.remove();
    setTimeout(() => {
      div.style.transition = 'opacity 0.6s';
      div.style.opacity = '0';
      setTimeout(() => div.remove(), 700);
    }, 6500);
  }

  makeDmgDirLayer() {
    let layer = document.getElementById('dmg-dir-layer');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'dmg-dir-layer';
      document.getElementById('hud').appendChild(layer);
    }
    return layer;
  }

  buildWeaponList() {
    this.weaponList.innerHTML = '';
    const loadout = this.game.player.loadout;
    this._lastLoadoutKey = loadout.join('|');
    loadout.forEach((k, i) => {
      const slot = document.createElement('div');
      slot.className = 'weapon-slot';
      slot.dataset.key = k;
      slot.textContent = `${i + 1} ${WEAPONS[k].name}`;
      this.weaponList.appendChild(slot);
    });
  }

  update() {
    const p = this.game.player;
    const pct = (p.health / p.maxHealth) * 100;
    this.healthFill.style.width = pct + '%';
    this.healthText.textContent = Math.ceil(p.health);
    this.healthFill.style.background =
      pct > 50 ? 'linear-gradient(90deg,#c47a3d,#ffce5e)' :
      pct > 25 ? 'linear-gradient(90deg,#c47a3d,#ff8a3c)' :
                 'linear-gradient(90deg,#8a2222,#ff3a3a)';

    const w = WEAPONS[p.currentWeapon];
    const a = p.ammo[p.currentWeapon];
    let suffix = p.reloading ? ' [RELOADING]' : '';
    if (p.currentWeapon === 'spudling') {
      if (p.sentryActive) suffix += ' [SENTRY]';
      else if (p.sentryCooldown > 0) suffix += ` [P: ${p.sentryCooldown.toFixed(1)}s]`;
      else suffix += ' [P=SENTRY]';
    }
    if (w.special) {
      const cd = p.specialCooldowns[p.currentWeapon] || 0;
      const active = !!p.specialQueue || !!p.specialMod || (w.special.kind === 'hotBarrel' && p.hotBarrelTimer > 0);
      if (active) {
        if (w.special.kind === 'hotBarrel') suffix += ` [${w.special.name} ${p.hotBarrelTimer.toFixed(1)}s]`;
        else suffix += ` [${w.special.name}!]`;
      } else if (cd > 0) {
        suffix += ` [T: ${cd.toFixed(1)}s]`;
      } else {
        suffix += ` [T=${w.special.name}]`;
      }
    }
    this.weaponName.textContent = w.name + suffix;
    this.ammoText.textContent = w.melee ? '—' : `${a.mag} / ${a.reserve}`;

    this.coinDisplay.textContent = `${p.coins}¢`;
    this.killsDisplay.textContent = `K ${p.kills}`;
    if (this.xpDisplay) this.xpDisplay.textContent = `+${p.sessionXp || 0} XP`;
    if (this.tsMash) this.tsMash.textContent = this.game.teamKills.mash;
    if (this.tsRusset) this.tsRusset.textContent = this.game.teamKills.russet;
    if (this.tsGoal) this.tsGoal.textContent = `to ${this.game.matchGoal}`;

    const loadoutKey = p.loadout.join('|');
    if (loadoutKey !== this._lastLoadoutKey) this.buildWeaponList();
    for (const slot of this.weaponList.children) {
      slot.classList.toggle('active', slot.dataset.key === p.currentWeapon);
    }

    // Hold off the scope overlay until the gun has nearly finished its
    // approach animation, so the eye-into-scope motion reads smoothly.
    const scopeOn = !!w.scope && p.adsAmount > 0.88;
    this.scope.classList.toggle('active', scopeOn);
    const isAds = p.adsAmount > 0.4 && !scopeOn;
    const xKey = scopeOn
      ? null
      : (isAds && w.adsCrosshair)
        ? `ads-${w.adsCrosshair}`
        : (w.crosshair || 'dot');
    if (xKey === null) {
      this.crosshair.style.opacity = '0';
    } else {
      this.crosshair.style.opacity = '1';
      if (xKey !== this._lastCrosshair) {
        this._lastCrosshair = xKey;
        if (xKey.startsWith('ads-')) {
          const key = xKey.slice(4);
          this.crosshair.className = 'has-svg';
          this.crosshair.innerHTML = ADS_RETICLES[key] || '';
        } else {
          this.crosshair.className = `x-${xKey}`;
          this.crosshair.innerHTML = '';
        }
      }
      // Crosshair kick — scales the reticle outward briefly when firing
      const kick = (p.crosshairKick || 0);
      const s = 1 + kick * 0.85;
      this.crosshair.style.transform = `translate(-50%, -50%) scale(${s.toFixed(2)})`;
      this.crosshair.style.filter =
        `drop-shadow(0 0 ${(2 + kick * 6).toFixed(1)}px rgba(0,0,0,0.95))` +
        (kick > 0.05 ? ` drop-shadow(0 0 ${(kick * 12).toFixed(1)}px rgba(255,140,60,${(kick * 0.9).toFixed(2)}))` : '');
    }

    if (p.reloading) {
      const reloadMult = p.buffs.reload?.mult ?? 1;
      const k = 1 - p.reloadTimer / (w.reloadTime * reloadMult);
      this.reloadBar.style.opacity = '1';
      this.reloadFill.style.width = (k * 100) + '%';
    } else {
      this.reloadBar.style.opacity = '0';
    }

    this.updateLeaderboard();
    this.updateBuffs(p);
    this.updateStreakChip(p);
    this.updateFrenzyTimer();
    this.updateDamageDirections();
    this.updateCombo();
    this.updateSlideChip(p);
    this.updateNametags();
    this.updateLockOn();
    this.updateMomentumChip();
  }

  // Reuse a pool of nametag divs, one per visible bot. Names hide if the bot
  // is off-screen or behind the camera.
  updateNametags() {
    if (!this.nametagLayer) return;
    const cam = this.game.camera;
    const W = window.innerWidth, H = window.innerHeight;
    const seen = new Set();
    const allBots = this.game.isMpClient && this.game.remoteBots
      ? [...this.game.remoteBots.values()]
      : this.game.bots;
    for (const bot of allBots) {
      if (bot.dead) continue;
      const key = 'bot_' + bot.id;
      seen.add(key);
      let tag = this.nametags.get(key);
      if (!tag) {
        tag = {
          root: document.createElement('div'),
          nameEl: document.createElement('span'),
          streakEl: document.createElement('span'),
          hpBar: document.createElement('span'),
          hpFill: document.createElement('span'),
        };
        tag.root.className = 'nametag team-' + bot.team + (bot.team !== this.game.player.team ? ' enemy' : '');
        tag.nameEl.className = 'nt-name';
        tag.streakEl.className = 'nt-streak';
        tag.hpBar.className = 'nt-hpbar';
        tag.hpFill.className = 'nt-hpfill';
        tag.hpBar.appendChild(tag.hpFill);
        tag.root.appendChild(tag.nameEl);
        tag.root.appendChild(tag.streakEl);
        tag.root.appendChild(tag.hpBar);
        this.nametagLayer.appendChild(tag.root);
        this.nametags.set(key, tag);
      }
      // Project bot world pos to screen
      const wp = bot.position.clone();
      wp.y += 1.95;
      const v = wp.project(cam);
      if (v.z > 1) { tag.root.style.display = 'none'; continue; }
      const sx = (v.x * 0.5 + 0.5) * W;
      const sy = (-v.y * 0.5 + 0.5) * H;
      if (sx < -50 || sx > W + 50 || sy < -50 || sy > H + 50) {
        tag.root.style.display = 'none';
        continue;
      }
      tag.root.style.display = 'block';
      tag.root.style.left = sx + 'px';
      tag.root.style.top = sy + 'px';
      tag.nameEl.textContent = bot.name;
      // Streak chip — shows current (resets-on-death) streak, not cumulative kills
      const botStreak = bot.streak || 0;
      if (botStreak >= 5) {
        tag.streakEl.style.display = 'inline-block';
        tag.streakEl.textContent = `🔥${botStreak}`;
      } else {
        tag.streakEl.style.display = 'none';
      }
      const pct = Math.max(0, Math.min(1, bot.health / bot.maxHealth));
      tag.hpFill.style.width = (pct * 100) + '%';
    }
    // Recycle: remove tags whose owners no longer exist
    for (const [k, t] of this.nametags) {
      if (!seen.has(k)) {
        t.root.remove();
        this.nametags.delete(k);
      }
    }
  }

  updateLockOn() {
    const lock = this.game.lockTarget;
    if (!this.lockonTarget) return;
    if (!lock || lock.dead) {
      this.lockonTarget.classList.remove('shown', 'locked');
      return;
    }
    const wp = lock.position.clone();
    wp.y += 0.8;
    const v = wp.project(this.game.camera);
    if (v.z > 1) {
      this.lockonTarget.classList.remove('shown');
      return;
    }
    const sx = (v.x * 0.5 + 0.5) * window.innerWidth;
    const sy = (-v.y * 0.5 + 0.5) * window.innerHeight;
    this.lockonTarget.classList.add('shown', 'locked');
    this.lockonTarget.style.left = sx + 'px';
    this.lockonTarget.style.top = sy + 'px';
    if (this.lockonInfo) {
      const pct = Math.max(0, Math.round((lock.health / lock.maxHealth) * 100));
      this.lockonInfo.textContent = `▶ ${lock.name}  HP ${pct}%`;
    }
  }

  updateMomentumChip() {
    if (!this.momentumChip) return;
    const t = this.game.pushThroughTeam;
    if (t !== this._lastMomentum) {
      this._lastMomentum = t;
      this.momentumChip.classList.remove('push-mash', 'push-russet');
      if (t) {
        this.momentumChip.classList.add('shown', 'push-' + t);
        const name = t === 'mash' ? 'TEAM MASH' : 'TEAM RUSSET';
        this.momentumChip.textContent = `⚡ ${name} RALLY — PUSHING THROUGH`;
      } else {
        this.momentumChip.classList.remove('shown');
      }
    }
  }

  updateCombo() {
    if (!this.comboMeter) return;
    const c = this.game.combo || 0;
    if (c < 2) { this.comboMeter.style.opacity = '0'; return; }
    this.comboMeter.style.opacity = '1';
    const mult = (1 + Math.min(c, 10) * 0.05).toFixed(2);
    const pct = Math.min(100, (this.game.comboTimer / 1.6) * 100);
    this.comboMeter.innerHTML =
      `<div class="combo-stack">×${c}<span class="combo-mult"> ${mult}× DMG</span></div>` +
      `<div class="combo-bar"><div class="combo-fill" style="width:${pct}%"></div></div>`;
  }

  updateSlideChip(p) {
    if (!this.slideChip) return;
    if (p.slideTimer > 0) {
      this.slideChip.classList.remove('ready');
      this.slideChip.textContent = 'C SLIDE!';
    } else if (p.slideCooldown > 0) {
      this.slideChip.classList.remove('ready');
      this.slideChip.textContent = `C SLIDE ${p.slideCooldown.toFixed(1)}s`;
    } else {
      this.slideChip.classList.add('ready');
      this.slideChip.textContent = 'C SLIDE';
    }
  }

  updateStreakChip(p) {
    if (!this.streakChip) return;
    const s = p.streak || 0;
    if (s <= 0) {
      this.streakChip.style.opacity = '0';
      return;
    }
    this.streakChip.style.opacity = '1';
    // find the next killstreak threshold
    const next = [3, 5, 7, 10, 15, 20].find((n) => s < n);
    const labels = { 3: 'PULSE', 5: 'RESUPPLY', 7: 'TATER STORM', 10: 'MASH MODE', 15: 'GOLDEN SPUD', 20: 'LEGENDARY' };
    if (next) {
      this.streakChip.innerHTML = `<b>${s}</b> streak <span class="ks-next">→ ${next} ${labels[next]}</span>`;
    } else {
      this.streakChip.innerHTML = `<b>${s}</b> streak <span class="ks-next ks-max">MAX</span>`;
    }
  }

  updateFrenzyTimer() {
    const banner = document.getElementById('frenzy-banner');
    if (!banner) return;
    const fr = this.game.frenzy;
    if (!fr) {
      banner.classList.remove('shown');
      return;
    }
    const detailEl = banner.querySelector('.frenzy-detail');
    if (detailEl) detailEl.textContent = `${fr.detail}  ·  ${fr.timer.toFixed(1)}s`;
  }

  updateDamageDirections() {
    if (!this.dmgDirLayer) return;
    const inds = this.game.dmgIndicators || [];
    // Reuse pool of child elements
    while (this.dmgDirLayer.children.length < inds.length) {
      const arrow = document.createElement('div');
      arrow.className = 'dmg-arrow';
      this.dmgDirLayer.appendChild(arrow);
    }
    while (this.dmgDirLayer.children.length > inds.length) {
      this.dmgDirLayer.lastChild.remove();
    }
    for (let i = 0; i < inds.length; i++) {
      const ind = inds[i];
      const el = this.dmgDirLayer.children[i];
      // angle = relative to forward, in radians; rotate the arrow around screen center
      const deg = (ind.angle * 180) / Math.PI;
      el.style.transform = `translate(-50%, -50%) rotate(${deg}deg)`;
      el.style.opacity = (Math.min(1, ind.life / 1.4)).toFixed(2);
    }
  }

  updateLeaderboard() {
    const liveBots = this.game.isMpClient && this.game.remoteBots
      ? [...this.game.remoteBots.values()].filter((b) => !b.dead)
      : this.game.bots.filter((b) => !b.dead);
    const entries = [this.game.player, ...liveBots];
    if (this.game.remotePlayer && !this.game.remotePlayer.dead) entries.push(this.game.remotePlayer);
    entries.sort((a, b) => b.kills - a.kills);
    const top = entries.slice(0, 7);
    this.leaderboard.innerHTML = '';
    for (const e of top) {
      const row = document.createElement('div');
      row.className = 'lb-row team-' + e.team + (e === this.game.player ? ' me' : '');
      const stars = e === this.game.player ? '' : ` <span class="lb-skill">${'★'.repeat(e.skill)}</span>`;
      row.innerHTML = `<span class="lb-name">${e.name}${stars}</span><span class="lb-k">${e.kills}</span>`;
      this.leaderboard.appendChild(row);
    }
  }

  updateBuffs(p) {
    this.buffBar.innerHTML = '';
    for (const k in p.buffs) {
      const b = p.buffs[k];
      if (b.timer == null) continue;
      const div = document.createElement('div');
      div.className = 'buff-chip';
      div.textContent = `${BUFF_LABELS[k] || k} ${b.timer.toFixed(1)}s`;
      this.buffBar.appendChild(div);
    }
  }

  addKillMessage(msg) {
    this.pushFeed(msg, 'kill-msg');
  }

  addBotKillMessage(killer, victim) {
    this.pushFeed(`${killer} → ${victim}`, 'kill-msg bot-kill');
  }

  addPickupMessage(msg) {
    this.pushFeed(msg, 'kill-msg pickup-msg');
  }

  pushFeed(msg, cls) {
    const div = document.createElement('div');
    div.className = cls;
    div.textContent = msg;
    this.killFeed.appendChild(div);
    setTimeout(() => {
      div.style.transition = 'opacity 0.3s';
      div.style.opacity = '0';
      setTimeout(() => div.remove(), 300);
    }, 3000);
  }
}
