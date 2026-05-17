import * as THREE from 'three';
import { Player } from './player.js';
import { Bot, BUDDY_TYPES, UNIQUE_BUDDY_TYPES } from './bot.js';
import { Projectile } from './projectile.js';
import { Arena } from './arena.js';
import { HUD } from './hud.js';
import { Pickup } from './pickup.js';
import { Shop } from './shop.js';
import { NavGrid } from './pathfinding.js';
import { SFX } from './sfx.js';
import { BGM } from './bgm.js';
import { BASE_FOV, WEAPONS as WEAPONS_REF } from './weapons.js';
import { Multiplayer, RemotePlayer, RemoteBot } from './multiplayer.js';

// Re-export Bot under an alias so killstreak ally spawning can use it without
// a circular-import dance — the runtime resolves it via the import above.
const BotRef = Bot;

const MATCH_GOAL = 30;

// Killstreak rewards — triggered as the player's streak crosses each threshold
// without dying. Each one is an active world effect on top of the banner/SFX.
const KILLSTREAKS = [
  { count: 3,  name: 'SPUD PULSE',   color: '#5effb8', detail: '+30 HP · 4s damage boost' },
  { count: 4,  name: 'AIRDROP',      color: '#a4d8ff', detail: 'rare loot crate at your feet' },
  { count: 5,  name: 'RESUPPLY',     color: '#ffce5e', detail: 'full ammo + 50¢' },
  { count: 7,  name: 'TATER STORM',  color: '#ff8a3c', detail: 'aerial bombardment ahead' },
  { count: 10, name: 'MASH MODE',    color: '#ffd700', detail: '6s 2× dmg + speed' },
  { count: 15, name: 'GOLDEN SPUD',  color: '#fff5a0', detail: '8s godmode' },
  { count: 20, name: 'LEGENDARY',    color: '#ff5e3a', detail: 'spawn 4 sentry allies' },
];

// FRENZY events — rotate every 60-90s, each runs 22s. Spices up every match
// so no two feel the same.
const FRENZY_EVENTS = [
  { id: 'doubleCoin', name: 'DOUBLE COIN', color: '#ffce5e', detail: '2× coin rewards' },
  { id: 'doubleXp',   name: 'DOUBLE XP',   color: '#a4d8ff', detail: '2× XP from kills' },
  { id: 'lowGrav',    name: 'LOW GRAVITY', color: '#5effb8', detail: 'jump higher, float' },
  { id: 'overheal',   name: 'OVERHEAL',    color: '#ff5e3a', detail: 'kills give +30 HP' },
  { id: 'headhunter', name: 'HEADHUNTER',  color: '#ff8a3c', detail: 'headshots × 2 dmg' },
  { id: 'instaReload',name: 'HOT BARREL',  color: '#ffd97a', detail: 'instant reloads' },
  { id: 'fastFire',   name: 'BULLET STORM',color: '#ff5e3a', detail: '1.5× fire rate' },
  { id: 'speedDemon', name: 'SPEED DEMON', color: '#5effb8', detail: '1.35× move speed' },
];

// Tiny class for floating world-space text (damage numbers, +coin popups).
// Pos lives in world coords, gets re-projected to screen each frame.
class Floater {
  constructor(game, pos, text, opts = {}) {
    this.game = game;
    this.pos = pos.clone();
    this.maxLife = opts.life ?? 0.9;
    this.life = this.maxLife;
    this.vy = opts.vy ?? 1.7;
    this.dead = false;
    this.el = document.createElement('div');
    this.el.className = `floater ${opts.cls || ''}`;
    if (opts.color) this.el.style.color = opts.color;
    this.el.textContent = text;
    document.getElementById('hud').appendChild(this.el);
  }
  update(dt) {
    this.life -= dt;
    if (this.life <= 0) { this.kill(); return; }
    this.pos.y += this.vy * dt;
    const v = this.pos.clone().project(this.game.camera);
    if (v.z > 1 || v.z < -1) { this.el.style.opacity = '0'; return; }
    const sx = (v.x * 0.5 + 0.5) * window.innerWidth;
    const sy = (-v.y * 0.5 + 0.5) * window.innerHeight;
    this.el.style.left = sx + 'px';
    this.el.style.top = sy + 'px';
    const t = this.life / this.maxLife;
    this.el.style.opacity = t < 0.25 ? (t / 0.25).toFixed(2) : '1';
    const scale = 1 + (1 - t) * 0.35;
    this.el.style.transform = `translate(-50%, -50%) scale(${scale})`;
  }
  kill() {
    if (this.dead) return;
    this.dead = true;
    this.el.remove();
  }
}

// Short-lived burst of spud-chunk particles at a hit point. Cheap: a single
// InstancedMesh isn't worth the bookkeeping for ~10 particles, so we just use
// plain Meshes that animate position + opacity and remove themselves.
class HitBurst {
  constructor(game, worldPos, isCrit) {
    this.game = game;
    this.life = 0.9;
    this.maxLife = this.life;
    this.dead = false;
    this.group = new THREE.Group();
    this.group.position.copy(worldPos);
    this.parts = [];
    const count = isCrit ? 24 : 16;
    const baseColor = isCrit ? 0xff3a1a : 0xffd97a;
    // Mix two sizes so the burst reads as a chunky explosion, not uniform dust.
    for (let i = 0; i < count; i++) {
      const big = Math.random() < 0.35;
      const s = big ? 0.16 : 0.10;
      const geo = new THREE.BoxGeometry(s, s, s);
      const mat = new THREE.MeshBasicMaterial({ color: baseColor, transparent: true });
      const m = new THREE.Mesh(geo, mat);
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const speed = 4.5 + Math.random() * 4.5;
      m.userData.vel = new THREE.Vector3(
        Math.sin(phi) * Math.cos(theta) * speed,
        Math.abs(Math.cos(phi)) * speed * 0.9 + 2.5,
        Math.sin(phi) * Math.sin(theta) * speed,
      );
      m.userData.spin = new THREE.Vector3(
        (Math.random() - 0.5) * 18,
        (Math.random() - 0.5) * 18,
        (Math.random() - 0.5) * 18,
      );
      this.group.add(m);
      this.parts.push(m);
    }
    // Big additive flash sprite at the impact point — sells the "hit" instantly
    // even from a distance. Fades out faster than the chunks.
    const flashGeo = new THREE.PlaneGeometry(1.2, 1.2);
    const flashMat = new THREE.MeshBasicMaterial({
      color: isCrit ? 0xffa050 : 0xfff0a0,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.flash = new THREE.Mesh(flashGeo, flashMat);
    // Billboard once toward the player — it's short-lived enough to skip
    // per-frame relookat.
    if (game.player) this.flash.lookAt(game.player.position);
    this.flashLife = 0.22;
    this.group.add(this.flash);
    game.scene.add(this.group);
  }
  update(dt) {
    this.life -= dt;
    if (this.life <= 0) { this.kill(); return; }
    const t = this.life / this.maxLife;
    for (const m of this.parts) {
      m.position.x += m.userData.vel.x * dt;
      m.position.y += m.userData.vel.y * dt;
      m.position.z += m.userData.vel.z * dt;
      m.userData.vel.y -= 9 * dt;          // gravity
      m.rotation.x += m.userData.spin.x * dt;
      m.rotation.y += m.userData.spin.y * dt;
      m.rotation.z += m.userData.spin.z * dt;
      m.material.opacity = t < 0.4 ? (t / 0.4) : 1;
    }
    if (this.flash) {
      this.flashLife -= dt;
      const ft = Math.max(0, this.flashLife / 0.22);
      this.flash.material.opacity = ft;
      const fs = 1 + (1 - ft) * 1.5;
      this.flash.scale.setScalar(fs);
    }
  }
  kill() {
    if (this.dead) return;
    this.dead = true;
    for (const m of this.parts) {
      m.geometry.dispose();
      m.material.dispose();
    }
    if (this.flash) {
      this.flash.geometry.dispose();
      this.flash.material.dispose();
    }
    this.group.parent?.remove(this.group);
  }
}

export class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.05, 320);
    // Player 2 (DAD) camera — only used when split-screen dad mode is active.
    // P1 camera sees layer 0 (default) AND layer 1 (DAD's mesh) so dad is
    // visible from P1's view. P2 camera only sees layer 0 — its own potato
    // body is on layer 1 so P2's first-person view doesn't render the inside
    // of the mesh.
    this.camera2 = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.05, 320);
    this.camera.layers.enable(1);
    // Camera2 stays on default (layer 0 only)
    this.dadActive = false;
    this.dadBot = null;
    this.dadKeys = {};
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.clock = new THREE.Clock();

    const sun = new THREE.DirectionalLight(0xfff1d6, 1.15);
    sun.position.set(60, 80, 40);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -70;
    sun.shadow.camera.right = 70;
    sun.shadow.camera.top = 70;
    sun.shadow.camera.bottom = -70;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 220;
    sun.shadow.bias = -0.0005;
    this.scene.add(sun);
    this.scene.add(new THREE.AmbientLight(0xb8c8e0, 0.45));
    this.scene.add(new THREE.HemisphereLight(0xc8d8ff, 0x5a4a3a, 0.55));

    this.arena = new Arena(this.scene);
    this.navGrid = new NavGrid(this.arena, 1);
    this.sfx = new SFX();
    this.bgm = new BGM();
    this.player = new Player(this);
    // Player1's viewmodel (gun in front of camera) should only render for the
    // main camera, not for DAD's camera2. Layer 1 is enabled on main camera
    // above; camera2 stays on layer 0 so the viewmodel is invisible from
    // dad's view (where it would just be a gun floating at the player's
    // position).
    if (this.player.viewmodel) this.player.viewmodel.traverse((o) => o.layers.set(1));
    this.hud = new HUD(this);
    this.shop = new Shop(this);
    this.bots = [];
    this.projectiles = [];
    this.floaters = [];
    this.hitBursts = [];
    this.airdrops = [];
    this.firstBloodTaken = false;
    this.pickups = this.arena.pickupSpawns.map((s) => new Pickup(this, s.type, s.position));
    this.matchGoal = MATCH_GOAL;
    this.matchOver = false;
    this.teamKills = { mash: 0, russet: 0 };
    // Final scoreboard would otherwise show only currently-alive bots, so a
    // bot that scored 4 kills then died and got replaced shows as 0 on the
    // end card. We snapshot each bot at death-time and merge those rows into
    // the match-end leaderboard so AI contributions actually surface.
    this.deadBotRoster = [];
    this.botSpawnTimer = 1.5;
    this.maxBots = 29; // 15 per team (1 player + 14 mash bots vs 15 russet bots)

    // Shared per-team intel: enemy_id -> { pos, time }. Bots with LOS write
    // their target's position; teammates read it for coordinated attacks
    // and flanking approaches.
    this.teamIntel = { mash: new Map(), russet: new Map() };
    this.running = false;
    this.paused = false;

    // Frenzy event scheduler
    this.frenzy = null;          // { id, name, color, detail, timer } when active
    this.nextFrenzyTimer = 35;   // seconds until first frenzy
    this.matchTime = 0;

    // Damage direction indicators — { angle, life }
    this.dmgIndicators = [];

    // Active killstreak effects on the player (reward state, not banners)
    this.killstreakEffects = {};
    // Track which thresholds we've already triggered for the current streak
    this.killstreakTriggered = new Set();

    // Slow-mo (cinematic moments): scales dt for a fraction of a second
    this.timeScale = 1;
    this.timeScaleTarget = 1;
    this.slowMoTimer = 0;

    // Global chat (both teams visible). usedChatLines is a rolling set of the
    // last few lines so two bots don't speak the same wording back-to-back.
    this.chatMessages = [];
    this._chatId = 0;
    this.usedChatLines = new Set();
    this._chatDedupQueue = [];
    // Last chat event for reply-tracking — set whenever a bot emits chat with
    // an event tag. Teammates use this to react instead of monologuing.
    this.lastChatEvent = null;

    // Target lock-on state — set by player.tryToggleLock(). When non-null,
    // HUD draws a corner reticle around target and projectiles can soft-track.
    this.lockTarget = null;
    this.lockAcquired = 0; // 0..1 acquisition strength (smoothes UI)

    // Multiplayer (PeerJS, lazy-created by main.js when host/join clicked).
    // While connected, this.remotePlayer holds a RemotePlayer entity that
    // projectile collision treats just like a Bot. On the CLIENT side we ALSO
    // disable local AI/spawning and mirror the HOST's bots into remoteBots.
    this.multiplayer = null;
    this.remotePlayer = null;
    this.remoteBots = new Map();    // id -> RemoteBot (client-only)
    this.isMpClient = false;        // true if we're the joiner (not authoritative)
    this.isMpHost = false;          // true if we're the host (authoritative for bots)
    this._botsSnapshotTimer = 0;
    // 'team' (default — 30 kills, 28 bots) or '1v1' (no bots, first to 5)
    this.gameMode = 'team';

    // Comeback/push-through: when a team is far behind in score, they get
    // a speed/fire-rate buff so they can break out of their keep. Recomputed
    // every ~1s in the loop.
    this.pushThroughTeam = null;
    this._momentumTimer = 0;

    // Player kill-aura — a big ring at the player's feet that persists for the
    // rest of the match once they hit 5 cumulative kills (doesn't reset on
    // death). Sized large so the player can see it in their peripheral vision
    // from first-person.
    const auraGeo = new THREE.RingGeometry(2.4, 3.2, 48);
    const auraMat = new THREE.MeshBasicMaterial({
      color: 0xffd700, transparent: true, opacity: 0,
      depthWrite: false, side: THREE.DoubleSide,
    });
    this.playerAura = new THREE.Mesh(auraGeo, auraMat);
    this.playerAura.rotation.x = -Math.PI / 2;
    this.playerAura.visible = false;
    this.scene.add(this.playerAura);
    // Inner pulse for extra visibility
    const auraInnerGeo = new THREE.RingGeometry(1.4, 1.9, 48);
    const auraInnerMat = new THREE.MeshBasicMaterial({
      color: 0xff8a3c, transparent: true, opacity: 0,
      depthWrite: false, side: THREE.DoubleSide,
    });
    this.playerAuraInner = new THREE.Mesh(auraInnerGeo, auraInnerMat);
    this.playerAuraInner.rotation.x = -Math.PI / 2;
    this.playerAuraInner.visible = false;
    this.scene.add(this.playerAuraInner);

    // Player combo — chained hits build a damage multiplier
    this.combo = 0;
    this.comboTimer = 0;

    window.addEventListener('resize', () => this.onResize());
  }

  start() {
    this.canvas.requestPointerLock();
    this.player.mouseDown = false;
    this.running = true;
    this.sfx.ensure();
    if (this.bgm) this.bgm.start();
    this.clock.start();
    this.loop();
  }

  announceStreak(text, color, level) {
    let el = document.getElementById('streak-banner');
    if (!el) {
      el = document.createElement('div');
      el.id = 'streak-banner';
      document.getElementById('hud').appendChild(el);
    }
    el.textContent = text;
    el.style.color = color;
    el.style.transition = 'none';
    el.style.opacity = '1';
    el.style.transform = 'translate(-50%, 0) scale(1.15)';
    // Force reflow then animate
    void el.offsetWidth;
    el.style.transition = 'opacity 0.6s, transform 0.6s';
    clearTimeout(this._streakTimer);
    this._streakTimer = setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translate(-50%, -10px) scale(0.95)';
    }, 1300);
    this.sfx.streak(level);
  }

  loop() {
    if (!this.running) return;
    requestAnimationFrame(() => this.loop());
    const rawDt = Math.min(this.clock.getDelta(), 0.05);
    // Slow-mo lerp toward target scale, then apply to world dt
    this.timeScale += (this.timeScaleTarget - this.timeScale) * Math.min(1, rawDt * 8);
    if (this.slowMoTimer > 0) {
      this.slowMoTimer -= rawDt;
      if (this.slowMoTimer <= 0) this.timeScaleTarget = 1;
    }
    const dt = rawDt * this.timeScale;
    // Combo timeout — decays after 1.6s without a hit
    if (this.combo > 0) {
      this.comboTimer -= rawDt;
      if (this.comboTimer <= 0) this.combo = 0;
    }

    const tickWorld = !this.paused && !this.matchOver && !this.shop.isOpen();
    if (tickWorld) {
      this.player.update(dt);
      // Host runs full AI. Client SKIPS bot AI — host is authoritative.
      if (!this.isMpClient) {
        for (const bot of this.bots) bot.update(dt);
      }
      // Client renders received bot snapshots
      if (this.isMpClient) {
        for (const rb of this.remoteBots.values()) rb.update(dt);
      }
      if (this.remotePlayer) this.remotePlayer.update(dt);
      for (const p of this.projectiles) p.update(dt);
      for (const pk of this.pickups) pk.update(dt);
      this.updateAirdrops(dt);
      this.bots = this.bots.filter((b) => !b.dead);
      this.projectiles = this.projectiles.filter((p) => !p.dead);
      this.pickups = this.pickups.filter((pk) => !pk._disposed);
      // Broadcast our state to the peer
      this._tickMultiplayer();
      // Host: periodically broadcast bot snapshot at ~10Hz
      if (this.isMpHost) {
        this._botsSnapshotTimer -= dt;
        if (this._botsSnapshotTimer <= 0) {
          this._broadcastBotsSnapshot();
          this._botsSnapshotTimer = 0.1;
        }
      }
    }

    // Floaters tick even while shop is open so they fade smoothly when paused
    for (const f of this.floaters) f.update(dt);
    this.floaters = this.floaters.filter((f) => !f.dead);

    // Hit-burst particles tick on their own simple timeline (also fade through
    // shop-pause so the visual completes cleanly).
    for (const b of this.hitBursts) b.update(dt);
    this.hitBursts = this.hitBursts.filter((b) => !b.dead);

    if (tickWorld) {

      // Client does not spawn bots — host is authoritative for the bot world.
      if (!this.isMpClient) {
        this.botSpawnTimer -= dt;
        if (this.botSpawnTimer <= 0 && this.bots.length < this.maxBots && !this.player.dead) {
          this.spawnBot();
          this.botSpawnTimer = 2.0 + Math.random() * 1.0;
        }
      }
      // DAD auto-respawn — 3.5s after death, same as a normal player would wait
      if (this.dadActive && (!this.dadBot || this.dadBot.dead)) {
        this._dadRespawnTimer = (this._dadRespawnTimer ?? 3.5) - dt;
        if (this._dadRespawnTimer <= 0) {
          this.spawnDadBot();
          this._dadRespawnTimer = null;
        }
      } else {
        this._dadRespawnTimer = null;
      }
      this._bountyTimer = (this._bountyTimer || 0) - dt;
      if (this._bountyTimer <= 0) {
        this.updateBounty();
        this._bountyTimer = 0.7;
      }

      // Momentum / push-through detection. When a team is far behind in score
      // OR their bots are pinned on their own half, mark them as the "rally"
      // team — bot.js reads game.pushThroughTeam to apply speed/fire buffs.
      this._momentumTimer -= dt;
      if (this._momentumTimer <= 0) {
        this.updateMomentum();
        this._momentumTimer = 0.9;
      }

      // Frenzy event scheduling — only the host rolls new frenzies. Client
      // mirrors via botsSnapshot so both sides agree on the event.
      this.matchTime += dt;
      if (!this.isMpClient) {
        if (this.frenzy) {
          this.frenzy.timer -= dt;
          if (this.frenzy.timer <= 0) this.endFrenzy();
        } else {
          this.nextFrenzyTimer -= dt;
          if (this.nextFrenzyTimer <= 0) this.startFrenzy();
        }
      } else if (this.frenzy) {
        this.frenzy.timer -= dt;
        // Client doesn't endFrenzy locally — host's snapshot will clear it
      }

      // Decay damage-direction indicators
      for (const d of this.dmgIndicators) d.life -= dt;
      this.dmgIndicators = this.dmgIndicators.filter((d) => d.life > 0);

      // Active killstreak effect timers
      this.tickKillstreakEffects(dt);
    }

    // Low-HP heartbeat tone — synced with the CSS pulse
    if (this._lowHpActive && tickWorld && !this.player.dead) {
      this._heartbeatTimer = (this._heartbeatTimer || 0) - dt;
      if (this._heartbeatTimer <= 0) {
        this.sfx.beep(85, 0.18, 'sine', 0.35, 55);
        this._heartbeatTimer = 0.85;
      }
    }

    // Player kill-aura — tied to lifetime match kills, NOT streak. Once player
    // hits 5 kills in a match, the aura sticks (kills don't reset on death) so
    // the player keeps the buff for the rest of the match. Adds passive
    // damage+speed buffs (applied in player.js update + fire).
    if (this.playerAura && this.player && !this.player.dead) {
      const k = this.player.kills || 0;
      const active = k >= 5;
      // First-activation announcement — fired once per match when the aura
      // first turns on, so the player notices the buff is live.
      if (active && !this._auraAnnounced) {
        this._auraAnnounced = true;
        this.announceStreak('★ KILL AURA ACTIVE  +15% DMG +12% SPD', '#ffd700', 5);
        if (this.sfx && this.sfx.killstreak) this.sfx.killstreak();
      }
      this.player.auraActive = active;
      if (active) {
        this.playerAura.visible = true;
        this.playerAuraInner.visible = true;
        const intensity = Math.min(1, (k - 4) / 10); // 5→0.1 .. 14+→1
        const t = performance.now() * 0.008;
        const pulse = 0.55 + 0.25 * Math.sin(t);
        const pulse2 = 0.55 + 0.25 * Math.sin(t + 1.3);
        this.playerAura.material.opacity = 0.55 + 0.4 * pulse;
        this.playerAuraInner.material.opacity = 0.45 + 0.4 * pulse2;
      } else {
        this.playerAura.visible = false;
        this.playerAuraInner.visible = false;
      }
      const fy = this.player.position.y - 1.5; // ground level under player
      this.playerAura.position.set(this.player.position.x, fy + 0.04, this.player.position.z);
      this.playerAuraInner.position.set(this.player.position.x, fy + 0.05, this.player.position.z);
      this.playerAura.rotation.z += rawDt * 1.2;
      this.playerAuraInner.rotation.z -= rawDt * 1.5;
      // Toggle HUD glow class so the player gets visible feedback first-person
      const hudEl = document.getElementById('hud');
      if (hudEl) hudEl.classList.toggle('aura-active', active);
    } else {
      if (this.playerAura) this.playerAura.visible = false;
      if (this.playerAuraInner) this.playerAuraInner.visible = false;
      if (this.player) this.player.auraActive = false;
      const hudEl = document.getElementById('hud');
      if (hudEl) hudEl.classList.remove('aura-active');
    }

    // Duck BGM during shop (idempotent — BGM.setDuck early-exits if unchanged)
    if (this.bgm) this.bgm.setDuck(this.shop.isOpen() ? 0.25 : 1.0);

    this.hud.update();
    this.renderSplit();
  }

  renderSplit() {
    const r = this.renderer;
    const W = window.innerWidth;
    const H = window.innerHeight;
    if (this.dadActive && this.dadBot && !this.dadBot.dead) {
      r.setScissorTest(true);
      // Top half — Player 1 view
      r.setViewport(0, H / 2, W, H / 2);
      r.setScissor(0, H / 2, W, H / 2);
      r.render(this.scene, this.camera);
      // Bottom half — DAD view
      r.setViewport(0, 0, W, H / 2);
      r.setScissor(0, 0, W, H / 2);
      r.render(this.scene, this.camera2);
      r.setScissorTest(false);
      r.setViewport(0, 0, W, H);
    } else {
      r.setScissorTest(false);
      r.setViewport(0, 0, W, H);
      r.render(this.scene, this.camera);
    }
  }

  // Pick the trailing team and mark them as the "rally" team if the gap is
  // wide enough or they're pinned in their own half. Emits a one-time chat
  // line + SFX cue when the rally first activates.
  updateMomentum() {
    const tk = this.teamKills;
    const diff = Math.abs(tk.mash - tk.russet);
    let trailing = null;
    if (diff >= 4) trailing = tk.mash < tk.russet ? 'mash' : 'russet';

    // Also: if average alive-bot Z position is deep in your own half, rally.
    if (!trailing) {
      const sumZ = { mash: 0, russet: 0 };
      const ct = { mash: 0, russet: 0 };
      for (const b of this.bots) {
        if (b.dead) continue;
        sumZ[b.team] += b.position.z;
        ct[b.team] += 1;
      }
      // mash home is +z, russet home is -z. If mash avg z > 60 (pinned at keep)
      // and russet has more board presence, mash is cornered.
      if (ct.mash > 2 && ct.russet > 2) {
        const mAvg = sumZ.mash / ct.mash;
        const rAvg = sumZ.russet / ct.russet;
        if (mAvg > 55 && rAvg > -20) trailing = 'mash';
        else if (rAvg < -55 && mAvg < 20) trailing = 'russet';
      }
    }

    if (trailing !== this.pushThroughTeam) {
      this.pushThroughTeam = trailing;
      if (trailing) {
        // Emit a rally call from a random bot on that team
        const rally = this.bots.find((b) => !b.dead && b.team === trailing);
        if (rally && rally.emitChat) {
          rally.lastChatTime = 0;
          rally.emitChat('pushThrough');
        }
        if (this.sfx && this.sfx.rally) this.sfx.rally();
      }
    }
  }

  spawnBot() {
    // pick the team with fewer alive bots (player counts toward mash)
    let mashAlive = this.player.team === 'mash' && !this.player.dead ? 1 : 0;
    let russetAlive = this.player.team === 'russet' && !this.player.dead ? 1 : 0;
    for (const b of this.bots) {
      if (b.dead) continue;
      if (b.team === 'mash') mashAlive++; else russetAlive++;
    }
    const team = mashAlive <= russetAlive ? 'mash' : 'russet';
    const spawnList = this.arena.teamSpawns[team];
    const sp = spawnList[Math.floor(Math.random() * spawnList.length)];
    const bot = new Bot(this, sp.clone(), team);
    this.bots.push(bot);
    // Buddy pairing — find an unpaired teammate, pair them up. New bots tend to
    // partner with the most-recently-spawned solo bot, so squads form on the fly.
    // Each pair gets a buddyType (couple / bestfriends / rivals / mentor / wwII_vet)
    // that flavors their chat lines. wwII_vet — "that one guy" — is intentionally
    // capped at one active pair across the whole match so it stays iconic.
    const solos = this.bots.filter((b) => b !== bot && !b.dead && b.team === team && !b.buddy);
    if (solos.length > 0) {
      const partner = solos[solos.length - 1];
      bot.buddy = partner;
      partner.buddy = bot;
      // Roll a buddy type, re-rolling if it'd duplicate a UNIQUE flavor that
      // already has an active pair (wwII_vet, pirates, detectives, astronauts
      // are the "one guy" archetypes — capped to keep them iconic).
      const taken = new Set(
        this.bots.filter((b) => !b.dead && b.buddyType && UNIQUE_BUDDY_TYPES.has(b.buddyType))
                 .map((b) => b.buddyType)
      );
      let typeKey = 'bestfriends';
      for (let attempt = 0; attempt < 8; attempt++) {
        const total = BUDDY_TYPES.reduce((s, t) => s + t.weight, 0);
        let r = Math.random() * total;
        for (const t of BUDDY_TYPES) { r -= t.weight; if (r <= 0) { typeKey = t.key; break; } }
        if (!UNIQUE_BUDDY_TYPES.has(typeKey) || !taken.has(typeKey)) break;
      }
      if (UNIQUE_BUDDY_TYPES.has(typeKey) && taken.has(typeKey)) typeKey = 'bestfriends';
      bot.buddyType = typeKey;
      partner.buddyType = typeKey;
    }
    bot.emitChat('spawn');
  }

  // Push a chat line to the global chat HUD. Capped at 16 entries; HUD removes
  // them visually after a few seconds. Tracks the wording in a rolling dedup
  // set so bots avoid repeating each other's lines while they're still visible.
  addChatMessage(speaker, text) {
    if (!text) return;
    this.chatMessages = this.chatMessages || [];
    const isPlayer = speaker === this.player;
    const entry = {
      id: ++this._chatId || (this._chatId = 1),
      name: speaker.name || 'Spud',
      team: speaker.team,
      personality: speaker.personality || (isPlayer ? 'player' : 'quiet'),
      color: (speaker.persona && speaker.persona.color) || (isPlayer ? '#ffffff' : '#fff'),
      text,
      time: performance.now(),
      fromPlayer: isPlayer,
    };
    this.chatMessages.push(entry);
    if (this.chatMessages.length > 16) this.chatMessages.shift();
    // Dedup queue — remember the lowercased key for ~8 seconds (drop after 6
    // entries) so the same wording doesn't appear back-to-back across the team.
    const k = (text || '').toLowerCase().replace(/[.!?,…<>:\-]/g, '').replace(/\s+/g, ' ').trim();
    if (k) {
      this.usedChatLines.add(k);
      this._chatDedupQueue.push(k);
      if (this._chatDedupQueue.length > 8) {
        const old = this._chatDedupQueue.shift();
        this.usedChatLines.delete(old);
      }
    }
    if (this.hud && this.hud.renderChat) this.hud.renderChat(entry);
    if (this.sfx && !isPlayer && this.sfx.chatPing) this.sfx.chatPing();
  }

  spawnProjectile(opts) {
    this.projectiles.push(new Projectile(this, opts));
  }

  spawnExplosion(pos, radius, color = 0xff8a3c) {
    const geo = new THREE.SphereGeometry(radius * 0.5, 14, 10);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8 });
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(pos);
    this.scene.add(m);

    const light = new THREE.PointLight(color, 4, radius * 4);
    light.position.copy(pos);
    this.scene.add(light);

    let t = 0;
    const dur = 0.45;
    const tick = () => {
      t += 1 / 60;
      const k = t / dur;
      m.scale.setScalar(0.5 + k * 2.2);
      mat.opacity = (1 - k) * 0.85;
      light.intensity = (1 - k) * 4;
      if (k < 1) requestAnimationFrame(tick);
      else {
        this.scene.remove(m);
        this.scene.remove(light);
        geo.dispose();
        mat.dispose();
      }
    };
    tick();
  }

  creditTeamKill(attacker, victim) {
    // attacker may be 'player', the player object, or a Bot
    let team = null;
    if (attacker === 'player' || attacker === this.player) team = this.player.team;
    else if (attacker && typeof attacker === 'object' && attacker.team) team = attacker.team;
    if (!team) {
      // suicide / environmental — credit the opposing team so the match still progresses
      team = victim?.team === 'mash' ? 'russet' : 'mash';
    }
    this.teamKills[team] = (this.teamKills[team] || 0) + 1;
  }

  // Fires once per match on the FIRST kill of the round, regardless of who
  // scored it (local player, dad/remote, or any bot). If the local player got
  // the kill they keep the +20¢/+10XP bonus they had under the old per-player
  // gate; otherwise we just announce who took it so the banner still plays.
  _maybeFirstBlood(attacker) {
    if (this.firstBloodTaken) return;
    this.firstBloodTaken = true;
    let attackerName = 'Someone';
    let isLocalPlayer = false;
    if (attacker === 'player' || attacker === this.player) {
      attackerName = this.player.name || 'You';
      isLocalPlayer = true;
    } else if (attacker === this.remotePlayer) {
      attackerName = (this.remotePlayer && this.remotePlayer.name) || 'DAD';
    } else if (attacker && typeof attacker === 'object' && attacker.name) {
      attackerName = attacker.name;
    }
    if (isLocalPlayer) {
      this.player.coins += 20;
      this.player.sessionXp = (this.player.sessionXp || 0) + 10;
      this.announceStreak('FIRST BLOOD!  +20¢', '#ff5e3a', 4);
    } else {
      this.announceStreak(`FIRST BLOOD — ${String(attackerName).toUpperCase()}`, '#ff5e3a', 4);
    }
  }

  onBotKilled(victim, attacker) {
    this._maybeFirstBlood(attacker);
    this.creditTeamKill(attacker, victim);
    // Snapshot the victim's stats so the end-card leaderboard remembers them
    if (victim && victim.kills > 0) {
      this.deadBotRoster.push({
        name: victim.name,
        team: victim.team,
        skill: victim.skill,
        kills: victim.kills,
        dead: true,
      });
    }
    // Multiplayer relay (host only): tell the client about every bot death
    // so their RemoteBot mirror updates + they get a kill banner if it was them.
    if (this.isMpHost && this.multiplayer && this.multiplayer.connected) {
      const attackerIsClient = attacker === this.remotePlayer;
      this.multiplayer.sendEvent({
        kind: 'botKilled',
        botId: victim.id,
        victimName: victim.name,
        attackerIsClient,
      });
      // If client killed this bot, also award them a kill credit on host side
      if (attackerIsClient && this.remotePlayer) {
        this.remotePlayer.kills = (this.remotePlayer.kills || 0) + 1;
      }
    }
    if (attacker === 'player' || attacker === this.player) {
      this.player.awardKill(victim);
    } else if (attacker && typeof attacker === 'object' && 'kills' in attacker && !attacker.dead) {
      attacker.kills++;
      attacker.streak = (attacker.streak || 0) + 1;
      this.hud.addBotKillMessage(attacker.name, victim.name);
      // If this kill avenges the attacker's downed buddy, fire the avenged
      // line instead of the generic kill line — and tell their teammate they
      // also get a buddy-kill cheer.
      if (attacker.avengeTarget === victim && attacker.emitChat) {
        attacker.emitChat('avenged');
        attacker.avengeTarget = null;
      } else if (attacker.emitChat) {
        attacker.emitChat('kill');
      }
      // Buddy of the attacker (alive teammate) cheers the kill
      if (attacker.buddy && !attacker.buddy.dead && attacker.buddy.buddyType) {
        // Independent cooldown so the cheer doesn't get squelched by kill line
        if (Math.random() < 0.5) attacker.buddy.emitChat('buddyKill');
      }
      // Most-Wanted threshold — when a bot crosses 4 kills, they call attention
      if (attacker.kills === 4 && attacker.emitChat) attacker.emitChat('bounty');
      // Aura threshold — the 5-streak aura first lights up; bot taunts about it
      if (attacker.streak === 5 && attacker.emitChat) {
        attacker.lastChatTime = 0;
        attacker.emitChat('taunt');
      }
    } else {
      this.hud.addKillMessage(`${victim.name} got mashed.`);
    }
    this.checkMatchEnd();
  }

  onPlayerDeath(attacker) {
    this._maybeFirstBlood(attacker);
    this.setLowHp(false);
    this.resetKillstreak();
    this.creditTeamKill(attacker, this.player);
    if (attacker && typeof attacker === 'object' && 'kills' in attacker && !attacker.dead) {
      attacker.kills++;
      attacker.streak = (attacker.streak || 0) + 1;
      this.hud.addBotKillMessage(attacker.name, 'You');
    }
    document.exitPointerLock();
    let killer = 'the world';
    if (attacker && typeof attacker === 'object' && attacker.name) {
      const arch = attacker.archetype ? ` · ${attacker.archetype.toUpperCase()}` : '';
      killer = `${attacker.name}${arch}`;
    } else if (attacker === 'player' || attacker === this.player) killer = 'yourself';
    document.getElementById('final-score').innerHTML =
      `<div class="death-killer">Mashed by <b>${killer}</b></div>` +
      `<div class="death-stats">Kills: ${this.player.kills} · Streak peak: ${this.player.bestStreak || 0} · Coins: ${this.player.coins}</div>`;
    document.getElementById('death-screen').style.display = 'flex';
    this.checkMatchEnd();
  }

  // Spawn a floating damage number anchored at a world position.
  // amount: number (will be rounded), kind: 'hit' | 'crit' | 'kill' | 'coin' | 'xp'
  spawnDamageNumber(worldPos, amount, kind = 'hit') {
    if (this.floaters.length > 40) {
      // cap to avoid runaway DOM growth on big explosions
      this.floaters[0].kill();
      this.floaters.shift();
    }
    let text;
    if (kind === 'coin') text = `+${amount}¢`;
    else if (kind === 'xp') text = `+${amount} XP`;
    else if (kind === 'headshot') text = 'HEADSHOT';
    else text = Math.ceil(amount).toString();
    let color = '#ffd97a';
    if (kind === 'crit') color = '#ff8a3c';
    else if (kind === 'kill') color = '#ff5e3a';
    else if (kind === 'coin') color = '#5effb8';
    else if (kind === 'xp') color = '#a4d8ff';
    else if (kind === 'headshot') color = '#ff3a3a';
    const pos = worldPos.clone();
    pos.y += 1.0;
    pos.x += (Math.random() - 0.5) * 0.4;
    // XP floats further/longer to layer above coin
    const f = new Floater(this, pos, text, {
      color,
      cls: kind === 'kill' ? 'floater-kill'
        : kind === 'headshot' ? 'floater-headshot'
        : (kind === 'coin' || kind === 'xp' ? 'floater-coin' : ''),
      life: kind === 'kill' ? 1.1 : kind === 'headshot' ? 1.0 : (kind === 'coin' ? 1.1 : (kind === 'xp' ? 1.4 : 0.8)),
      vy: kind === 'xp' ? 2.1 : kind === 'headshot' ? 2.4 : 1.5,
    });
    this.floaters.push(f);
  }

  // Refresh which bot wears the bounty crown — top-killing bot with ≥2 kills.
  updateBounty() {
    let top = null;
    let topKills = 1;
    for (const b of this.bots) {
      if (b.dead) continue;
      if (b.kills > topKills) { topKills = b.kills; top = b; }
    }
    if (top !== this.bountyTarget) {
      this.bountyTarget = top;
      for (const b of this.bots) {
        if (b.bountyCrown) b.bountyCrown.visible = (b === top);
      }
    } else if (top) {
      // Re-assert visibility in case crown was hidden by death/respawn etc.
      if (top.bountyCrown && !top.bountyCrown.visible) top.bountyCrown.visible = true;
    }
  }

  // Toggle the low-HP overlay + start/stop the heartbeat tone.
  setLowHp(active) {
    if (active === this._lowHpActive) return;
    this._lowHpActive = active;
    document.getElementById('hud').classList.toggle('low-hp', active);
    this._heartbeatTimer = 0;
  }

  checkMatchEnd() {
    if (this.matchOver) return;
    // F9 dev mode → infinite match. Keeps the player from being kicked to the
    // match-end screen mid-tuning. Set by player._setupDevPanel() based on
    // whether the dev panel is open.
    if (this.devInfinite) return;
    if (this.teamKills.mash >= this.matchGoal || this.teamKills.russet >= this.matchGoal) {
      this.matchOver = true;
      const winningTeam = this.teamKills.mash >= this.matchGoal ? 'mash' : 'russet';
      const won = winningTeam === this.player.team;
      // Longer cinematic slow-mo so the winning kill actually breathes
      this.triggerSlowMo(0.2, 2.6);
      // Big banner announcement fades up over the slow-mo; final card appears
      // after the slo-mo wraps so the cut feels intentional, not abrupt.
      const teamName = winningTeam === 'mash' ? 'TEAM MASH' : 'TEAM RUSSET';
      const color = won ? '#5effb8' : '#ff7a3a';
      this.announceStreak(`${teamName} WINS`, color, 8);
      setTimeout(() => this.announceStreak(won ? 'VICTORY' : 'DEFEAT', color, 6), 600);
      setTimeout(() => this.showMatchEnd(winningTeam), 2400);
      return;
    }
  }

  showMatchEnd(winningTeam) {
    document.exitPointerLock();
    const won = winningTeam === this.player.team;
    if (won) this.sfx.win(); else this.sfx.lose();
    if (this.bgm) this.bgm.skip();
    const teamName = winningTeam === 'mash' ? 'TEAM MASH' : 'TEAM RUSSET';
    document.getElementById('match-end-title').textContent = won ? `${teamName} WINS!` : `${teamName} WINS`;
    // Include dead bots' final kills so the end card shows the AI's actual
    // contribution, not just the survivors who happen to be alive at the end.
    const all = [this.player, ...this.bots, ...this.deadBotRoster].sort((a, b) => b.kills - a.kills);
    const mvp = all[0];
    const playerStreak = this.player.bestStreak || 0;
    document.getElementById('match-end-stats').innerHTML =
      `<div>MASH ${this.teamKills.mash} · RUSSET ${this.teamKills.russet}</div>` +
      `<div class="end-stats-row">MVP <b>${mvp.name}</b> (${mvp.kills} kills)  ·  Your streak peak: <b>${playerStreak}</b>  ·  Coins: <b>${this.player.coins}</b></div>`;
    const board = document.getElementById('match-end-board');
    board.innerHTML = '';
    for (const e of all) {
      const row = document.createElement('div');
      row.className = 'leader-row team-' + e.team + (e === this.player ? ' me' : '') + (e === mvp ? ' mvp' : '');
      const skill = e === this.player ? '' : ` · S${e.skill}`;
      const tag = e === mvp ? '<span class="mvp-tag">MVP</span> ' : '';
      row.innerHTML = `<span>${tag}${e.name}${skill}</span><span>${e.kills}</span>`;
      board.appendChild(row);
    }
    document.getElementById('match-end-screen').style.display = 'flex';
    if (this.onMatchEnd) this.onMatchEnd(winningTeam);
  }

  // ----- Killstreak rewards -----
  triggerKillstreaks(player) {
    const streak = player.streak || 0;
    for (const ks of KILLSTREAKS) {
      if (streak >= ks.count && !this.killstreakTriggered.has(ks.count)) {
        this.killstreakTriggered.add(ks.count);
        this.applyKillstreak(ks, player);
        if (player.matchStats) player.matchStats.killstreaksTriggered = (player.matchStats.killstreaksTriggered || 0) + 1;
        this.progressChallenge && this.progressChallenge('killstreak', 1);
      }
    }
  }

  applyKillstreak(ks, player) {
    this.announceStreak(`${ks.name} — ${ks.detail}`, ks.color, 5);
    if (this.sfx.killstreak) this.sfx.killstreak();
    if (ks.count === 3) {
      // Spud Pulse — heal + 4s damage 1.5×
      player.health = Math.min(player.maxHealth, player.health + 30);
      this.killstreakEffects.dmgBoost = { mult: 1.5, timer: 4 };
    } else if (ks.count === 4) {
      // AIRDROP — drop a visible crate from the sky onto a marked ground spot
      // ~14m in front of the player, with a beacon so allies and enemies can
      // see it falling. Loot spawns when the crate touches down.
      this.spawnAirdrop(player);
    } else if (ks.count === 5) {
      // Resupply — full ammo + coins
      const cur = player.currentWeapon;
      const w = WEAPONS_REF[cur];
      const a = player.ammo[cur];
      a.mag = w.magSize;
      a.reserve = Math.max(a.reserve, w.reserve);
      player.coins += 50;
      this.spawnDamageNumber(player.position, 50, 'coin');
      // also instant reload any other weapons in loadout
      for (const k of player.loadout) {
        if (k === cur) continue;
        const ww = WEAPONS_REF[k];
        if (!ww) continue;
        const aa = player.ammo[k];
        if (aa) { aa.mag = ww.magSize; aa.reserve = Math.max(aa.reserve, ww.reserve); }
      }
    } else if (ks.count === 7) {
      // Tater Storm — aerial bombardment in front of player
      this.taterStorm(player);
    } else if (ks.count === 10) {
      // Mash Mode — 6s of 2× damage + speed + reload
      this.killstreakEffects.dmgBoost = { mult: 2.0, timer: 6 };
      this.killstreakEffects.speedBoost = { mult: 1.35, timer: 6 };
      this.killstreakEffects.reloadBoost = { mult: 0.4, timer: 6 };
      this.killstreakEffects.glow = { color: '#ffd700', timer: 6 };
    } else if (ks.count === 15) {
      // GOLDEN SPUD — 8s of full god mode
      this.killstreakEffects.invuln = { timer: 8 };
      this.killstreakEffects.dmgBoost = { mult: 3.0, timer: 8 };
      this.killstreakEffects.speedBoost = { mult: 1.5, timer: 8 };
      this.killstreakEffects.glow = { color: '#fff5a0', timer: 8 };
      player.health = player.maxHealth;
    } else if (ks.count === 20) {
      // LEGENDARY — spawn 4 friendly sentries (just bots on player team) at player position
      this.spawnLegendaryAllies(player);
    }
  }

  tickKillstreakEffects(dt) {
    for (const k of Object.keys(this.killstreakEffects)) {
      const e = this.killstreakEffects[k];
      if (e.timer != null) {
        e.timer -= dt;
        if (e.timer <= 0) delete this.killstreakEffects[k];
      }
    }
    // Reflect on hud
    const hud = document.getElementById('hud');
    if (hud) {
      hud.classList.toggle('streak-glow', !!this.killstreakEffects.glow);
      hud.classList.toggle('streak-invuln', !!this.killstreakEffects.invuln);
    }
  }

  resetKillstreak() {
    this.killstreakTriggered = new Set();
    this.killstreakEffects = {};
    const hud = document.getElementById('hud');
    if (hud) {
      hud.classList.remove('streak-glow');
      hud.classList.remove('streak-invuln');
    }
  }

  // AIRDROP — physical falling crate with a parachute and a ground beacon.
  // Aims ~14m ahead of the player and slightly above ground so it can't clip
  // into walls (best-effort, no raycast). When it lands, spawns a real
  // ephemeral rare-loot Pickup at the impact point.
  spawnAirdrop(player) {
    const facing = new THREE.Vector3(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
    const ground = player.position.clone().addScaledVector(facing, 14);
    ground.y = 0.4;

    const crateGroup = new THREE.Group();
    const crate = new THREE.Mesh(
      new THREE.BoxGeometry(1.1, 1.1, 1.1),
      new THREE.MeshStandardMaterial({ color: 0xb86a2e, roughness: 0.75, metalness: 0.1 }),
    );
    crate.castShadow = true;
    crateGroup.add(crate);
    // Yellow caution stripe so it pops against the sky
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(1.16, 0.22, 1.16),
      new THREE.MeshBasicMaterial({ color: 0xffd24a }),
    );
    crateGroup.add(stripe);
    // Parachute — open cone above the crate
    const chute = new THREE.Mesh(
      new THREE.ConeGeometry(1.9, 1.7, 14, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xff8a3c,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.95,
      }),
    );
    chute.position.y = 1.65;
    crateGroup.add(chute);
    // Cords from crate corners to chute apex (suggestion of rigging)
    const cordMat = new THREE.LineBasicMaterial({ color: 0x402010 });
    const corners = [
      [ 0.55, 0.55,  0.55], [-0.55, 0.55,  0.55],
      [ 0.55, 0.55, -0.55], [-0.55, 0.55, -0.55],
    ];
    for (const c of corners) {
      const g = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(c[0], c[1], c[2]),
        new THREE.Vector3(0, 1.55, 0),
      ]);
      crateGroup.add(new THREE.Line(g, cordMat));
    }
    crateGroup.position.set(ground.x, 28, ground.z);
    this.scene.add(crateGroup);

    // Ground beacon — translucent cylinder from ground up so everyone can see
    // exactly where the drop is heading.
    const beacon = new THREE.Mesh(
      new THREE.CylinderGeometry(0.65, 0.65, 30, 16, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xffd24a,
        transparent: true,
        opacity: 0.22,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    beacon.position.set(ground.x, 15, ground.z);
    this.scene.add(beacon);
    // Landing ring on the ground
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.5, 2.2, 36),
      new THREE.MeshBasicMaterial({
        color: 0xffd24a,
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(ground.x, 0.06, ground.z);
    this.scene.add(ring);

    this.airdrops.push({
      crateGroup, beacon, ring,
      y: 28,
      vy: -2,           // small initial drop speed, parachute keeps it slow
      targetY: 0.55,    // crate body sits ~0.55 above ground
      targetPos: ground.clone(),
      age: 0,
    });

    this.announceStreak('AIRDROP INBOUND — grab the crate', '#a4d8ff', 5);
    if (this.sfx && this.sfx.airdrop) this.sfx.airdrop();
  }

  updateAirdrops(dt) {
    if (!this.airdrops || !this.airdrops.length) return;
    for (let i = this.airdrops.length - 1; i >= 0; i--) {
      const a = this.airdrops[i];
      a.age += dt;
      // Parachute drag: gravity pulls, drag clamps terminal velocity at -5 m/s
      a.vy -= 7 * dt;
      if (a.vy < -5) a.vy = -5;
      a.y += a.vy * dt;
      // Visual feedback — beacon/ring pulse so you can see incoming drop
      const pulse = 0.55 + 0.30 * Math.sin(a.age * 6);
      a.ring.material.opacity = pulse;
      a.beacon.material.opacity = 0.18 + 0.12 * Math.sin(a.age * 4);
      // Gentle parachute sway
      a.crateGroup.rotation.z = Math.sin(a.age * 1.6) * 0.10;
      a.crateGroup.rotation.x = Math.sin(a.age * 1.3) * 0.06;

      if (a.y <= a.targetY) {
        // Touchdown — replace visuals with the actual loot pickup
        const pos = a.targetPos.clone();
        pos.y = 1.0;
        const pk = new Pickup(this, 'loot', pos, { tier: 'rare', ephemeral: true });
        this.pickups.push(pk);
        this._disposeAirdropVisuals(a);
        this.airdrops.splice(i, 1);
        // Landing thump + small dust burst
        if (this.sfx?.grenadeBoom) this.sfx.grenadeBoom(0.55, 0.55);
        this.spawnExplosion(pos.clone(), 0.8, 0xffd24a);
        continue;
      }
      a.crateGroup.position.y = a.y;
    }
  }

  // Emergency ammo — one per life. Drops a static ammo crate ~5m in front of
  // the player so they have something to grab right away when their reserve
  // ran dry. Crate vanishes after pickup (ephemeral) so it doesn't litter the
  // map across rounds.
  spawnEmergencyAmmoCrate(player) {
    const facing = new THREE.Vector3(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
    const pos = player.position.clone().addScaledVector(facing, 5);
    pos.y = Math.max(pos.y - 0.4, 0.5);
    const pk = new Pickup(this, 'ammo', pos, { ephemeral: true });
    this.pickups.push(pk);
    if (this.hud && this.hud.addPickupMessage) {
      this.hud.addPickupMessage('AMMO CRATE INCOMING — grab it');
    }
    if (this.sfx && this.sfx.airdrop) this.sfx.airdrop();
  }

  _disposeAirdropVisuals(a) {
    this.scene.remove(a.crateGroup);
    this.scene.remove(a.beacon);
    this.scene.remove(a.ring);
    a.crateGroup.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    a.beacon.geometry.dispose(); a.beacon.material.dispose();
    a.ring.geometry.dispose(); a.ring.material.dispose();
  }

  taterStorm(player) {
    const aim = new THREE.Vector3(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
    const center = player.position.clone().addScaledVector(aim, 18);
    center.y = 28; // start high
    let count = 0;
    const drop = () => {
      if (count >= 12) return;
      count++;
      const offset = new THREE.Vector3(
        (Math.random() - 0.5) * 22,
        0,
        (Math.random() - 0.5) * 22,
      );
      const pos = center.clone().add(offset);
      this.spawnProjectile({
        ownerEntity: 'player',
        ownerTeam: player.team,
        position: pos,
        velocity: new THREE.Vector3(0, -45, 0),
        damage: 70,
        size: 0.22,
        gravity: 18,
        explosionRadius: 4.5,
        impactExplode: true,
        color: 0xff8a3c,
      });
      setTimeout(drop, 110 + Math.random() * 90);
    };
    drop();
  }

  spawnLegendaryAllies(player) {
    // Spawn 4 friendly bots tagged "ALLY" near the player. They'll fight on the
    // player's team, share team color, and despawn naturally on death.
    const positions = [
      [3, 0, 0], [-3, 0, 0], [0, 0, 3], [0, 0, -3],
    ];
    for (const off of positions) {
      const pos = player.position.clone().add(new THREE.Vector3(off[0], -1, off[2]));
      // Lazy import — Bot is referenced at top of file
      const ally = new BotRef(this, pos, player.team);
      ally.name = 'ALLY ' + ally.name;
      ally.skill = 3;
      ally.profile = ally.profile;
      this.bots.push(ally);
    }
  }

  // ----- FRENZY -----
  startFrenzy() {
    const choice = FRENZY_EVENTS[Math.floor(Math.random() * FRENZY_EVENTS.length)];
    this.frenzy = { ...choice, timer: 22 };
    this.announceFrenzy(choice);
    if (this.sfx.frenzy) this.sfx.frenzy();
  }

  endFrenzy() {
    this.frenzy = null;
    this.nextFrenzyTimer = 60 + Math.random() * 30; // 60-90s gap
    const banner = document.getElementById('frenzy-banner');
    if (banner) banner.classList.remove('shown');
  }

  announceFrenzy(ev) {
    let banner = document.getElementById('frenzy-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'frenzy-banner';
      document.getElementById('hud').appendChild(banner);
    }
    banner.style.color = ev.color;
    banner.innerHTML = `<div class="frenzy-title">FRENZY: ${ev.name}</div><div class="frenzy-detail">${ev.detail}</div>`;
    banner.classList.add('shown');
  }

  // Called by player.damage() when an attacker exists in world space.
  registerDamageDirection(attackerPos) {
    if (!attackerPos || !this.player) return;
    const dx = attackerPos.x - this.player.position.x;
    const dz = attackerPos.z - this.player.position.z;
    if (dx * dx + dz * dz < 0.01) return;
    // Angle relative to player's facing (yaw). 0 = front, +PI = behind.
    const worldAngle = Math.atan2(dx, dz);   // yaw convention used in player
    let rel = worldAngle - this.player.yaw;
    while (rel >  Math.PI) rel -= Math.PI * 2;
    while (rel < -Math.PI) rel += Math.PI * 2;
    this.dmgIndicators.push({ angle: rel, life: 1.4 });
    // cap to 6
    if (this.dmgIndicators.length > 6) this.dmgIndicators.shift();
  }

  // ----- Cinematic slow-mo + combo -----
  triggerSlowMo(scale = 0.35, duration = 0.6) {
    this.timeScaleTarget = scale;
    this.slowMoTimer = duration;
  }

  bumpCombo() {
    this.combo = Math.min(20, (this.combo || 0) + 1);
    this.comboTimer = 1.6;
  }

  comboMultiplier() {
    // 1.0 baseline, +5% per stack (capped at +50%)
    return 1 + Math.min(this.combo, 10) * 0.05;
  }

  flashDamage() {
    let d = document.querySelector('.damage-flash');
    if (!d) {
      d = document.createElement('div');
      d.className = 'damage-flash';
      document.getElementById('hud').appendChild(d);
    }
    d.style.opacity = '1';
    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => (d.style.opacity = '0'), 120);
  }

  flashSniperBlind() {
    let f = document.getElementById('sniper-flash');
    if (!f) {
      f = document.createElement('div');
      f.id = 'sniper-flash';
      document.getElementById('hud').appendChild(f);
    }
    f.style.transition = 'none';
    f.style.opacity = '1';
    clearTimeout(this._sniperFlashTimer);
    this._sniperFlashTimer = setTimeout(() => {
      f.style.transition = 'opacity 0.45s';
      f.style.opacity = '0';
    }, 80);
  }

  spawnHitBurst(worldPos, isCrit = false) {
    if (this.hitBursts.length > 24) {
      this.hitBursts[0].kill();
      this.hitBursts.shift();
    }
    this.hitBursts.push(new HitBurst(this, worldPos, isCrit));
  }

  flashHitMarker(variant = 'hit') {
    const hud = document.getElementById('hud');
    let h = document.querySelector('.hit-marker');
    if (!h) {
      h = document.createElement('div');
      h.className = 'hit-marker';
      hud.appendChild(h);
    }
    h.classList.remove('hit-marker-crit', 'hit-marker-hit');
    h.classList.add('hit-marker-' + variant);
    h.style.transition = 'none';
    h.style.opacity = '1';
    h.style.transform = `translate(-50%, -50%) scale(${variant === 'crit' ? 2.2 : 1.7})`;
    // Hit-confirm addon: 4-arm diagonal "X" overlay + expanding ring. Built
    // once and reused; we re-trigger by toggling opacity + scale each hit.
    let x = document.querySelector('.hit-marker-x');
    if (!x) {
      x = document.createElement('div');
      x.className = 'hit-marker-x';
      for (const side of ['t', 'b', 'l', 'r']) {
        const a = document.createElement('div');
        a.className = 'arm ' + side;
        x.appendChild(a);
      }
      hud.appendChild(x);
    }
    x.classList.toggle('crit', variant === 'crit');
    x.style.transition = 'none';
    x.style.opacity = '1';
    x.style.transform = `translate(-50%, -50%) rotate(45deg) scale(${variant === 'crit' ? 2.4 : 1.9})`;
    let r = document.querySelector('.hit-marker-ring');
    if (!r) {
      r = document.createElement('div');
      r.className = 'hit-marker-ring';
      hud.appendChild(r);
    }
    r.classList.toggle('crit', variant === 'crit');
    r.style.transition = 'none';
    r.style.opacity = '0.9';
    r.style.transform = 'translate(-50%, -50%) scale(0.4)';
    // Force reflow so the next transition picks up from this state.
    void r.offsetWidth;
    clearTimeout(this._hitTimer);
    this._hitTimer = setTimeout(() => {
      h.style.transition = 'opacity 0.55s, transform 0.55s';
      h.style.opacity = '0';
      h.style.transform = 'translate(-50%, -50%) scale(1)';
      x.style.transition = 'opacity 0.55s, transform 0.55s';
      x.style.opacity = '0';
      x.style.transform = 'translate(-50%, -50%) rotate(45deg) scale(1)';
      r.style.transition = 'opacity 0.65s, transform 0.65s';
      r.style.opacity = '0';
      r.style.transform = `translate(-50%, -50%) scale(${variant === 'crit' ? 2.8 : 2.2})`;
    }, 120);
    this.sfx.hit();
  }

  openShop() {
    if (this.player.dead || this.matchOver) return;
    this.shop.open();
  }

  toggleShop() {
    if (this.shop.isOpen()) this.shop.close();
    else this.openShop();
  }

  respawn() {
    this.player.respawn();
    document.getElementById('death-screen').style.display = 'none';
    this.canvas.requestPointerLock();
  }

  newMatch(fromPeer = false) {
    // Debounce double-fires (e.g. both peers click NEW MATCH simultaneously
    // and each side receives the other's echo right after starting their own).
    const now = performance.now();
    if (now - (this._lastNewMatchAt || 0) < 1500) return;
    this._lastNewMatchAt = now;
    // Multiplayer: tell the peer we hit NEW MATCH so they restart with us
    // and we stay on the same server. fromPeer=true skips the echo back.
    if (!fromPeer && this.multiplayer && this.multiplayer.connected) {
      this.multiplayer.sendEvent({ kind: 'newMatch' });
    }
    this.player.respawn();
    // Coins persist across matches (wallet is saved in localStorage by main.js).
    // Reset only the per-match counters below.
    this.player.kills = 0;
    this.player.streak = 0;
    this.player.bestStreak = 0;
    this.player.multiKill = 0;
    this.player.lastKillTime = 0;
    this.player.sessionXp = 0;
    this.player.lastKiller = null;
    this.bountyTarget = null;
    for (const bot of this.bots) {
      this.scene.remove(bot.mesh);
      this.scene.remove(bot.healthBarBg);
      this.scene.remove(bot.healthBarFill);
      if (bot.aura) this.scene.remove(bot.aura);
      if (bot.auraInner) this.scene.remove(bot.auraInner);
    }
    this.bots = [];
    // If DAD mode is on, the wipe above removed him too — respawn fresh.
    if (this.dadActive) {
      this.dadBot = null;
      this._dadRespawnTimer = 0.5;
    }
    for (const p of this.projectiles) p.kill();
    this.projectiles = [];
    // Drop any ephemeral loot pickups; reset the rest.
    for (const pk of this.pickups) {
      if (pk.ephemeral) {
        if (!pk._disposed) { pk._disposed = true; pk.dispose(); }
      } else {
        pk.taken = false;
        pk.mesh.visible = true;
      }
    }
    this.pickups = this.pickups.filter((pk) => !pk._disposed);
    // Any airdrops mid-flight when the match resets get cleaned up too
    if (this.airdrops) {
      for (const a of this.airdrops) this._disposeAirdropVisuals(a);
      this.airdrops = [];
    }
    this.matchOver = false;
    this.teamKills = { mash: 0, russet: 0 };
    this.deadBotRoster = [];
    this.botSpawnTimer = 1.5;
    this.firstBloodTaken = false;
    this.frenzy = null;
    this.nextFrenzyTimer = 35;
    this.matchTime = 0;
    this.dmgIndicators = [];
    this.resetKillstreak();
    this.pushThroughTeam = null;
    this._momentumTimer = 0;
    this.lockTarget = null;
    this._auraAnnounced = false;
    if (this.player) this.player.lockedTarget = null;
    // Reset remote player health bar; keep connection alive across matches
    if (this.remotePlayer) {
      this.remotePlayer.health = this.remotePlayer.maxHealth;
      this.remotePlayer.dead = false;
      this.remotePlayer.kills = 0;
    }
    // Clear out any stale RemoteBots so the next host snapshot starts fresh
    if (this.remoteBots && this.remoteBots.size > 0) {
      for (const rb of this.remoteBots.values()) rb.dispose();
      this.remoteBots.clear();
    }
    this.chatMessages = [];
    this.usedChatLines = new Set();
    this._chatDedupQueue = [];
    this.lastChatEvent = null;
    if (this.hud && this.hud.chatLog) this.hud.chatLog.innerHTML = '';
    if (this.hud && this.hud.nametags) {
      for (const t of this.hud.nametags.values()) t.root.remove();
      this.hud.nametags.clear();
    }
    if (this.player.matchStats) this.player.resetMatchStats();
    const fb = document.getElementById('frenzy-banner');
    if (fb) fb.classList.remove('shown');
    for (const f of this.floaters) f.kill();
    this.floaters = [];
    document.getElementById('death-screen').style.display = 'none';
    document.getElementById('match-end-screen').style.display = 'none';
    this.canvas.requestPointerLock();
  }

  onResize() {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const halfAspect = W / (H / 2);
    if (this.dadActive) {
      this.camera.aspect = halfAspect;
      this.camera2.aspect = halfAspect;
    } else {
      this.camera.aspect = W / H;
    }
    this.camera.updateProjectionMatrix();
    this.camera2.aspect = halfAspect;
    this.camera2.updateProjectionMatrix();
    this.renderer.setSize(W, H);
  }

  // Set the active game mode. 'team' = default 30-kill bot mode. '1v1' = no
  // bots, first to 5 kills wins. Syncs over multiplayer so both peers agree.
  setGameMode(mode, fromPeer = false) {
    if (mode !== 'team' && mode !== '1v1') return;
    this.gameMode = mode;
    if (mode === '1v1') {
      this.maxBots = 0;
      this.matchGoal = 5;
      // Wipe any existing bots immediately
      for (const bot of this.bots) {
        this.scene.remove(bot.mesh);
        if (bot.healthBarBg) this.scene.remove(bot.healthBarBg);
        if (bot.healthBarFill) this.scene.remove(bot.healthBarFill);
        if (bot.aura) this.scene.remove(bot.aura);
        if (bot.auraInner) this.scene.remove(bot.auraInner);
      }
      this.bots = [];
      for (const rb of this.remoteBots.values()) rb.dispose();
      this.remoteBots.clear();
    } else {
      this.maxBots = 29;
      this.matchGoal = 30;
    }
    // Update the HUD goal label
    const tsGoal = document.getElementById('ts-goal');
    if (tsGoal) tsGoal.textContent = `to ${this.matchGoal}`;
    if (!fromPeer && this.multiplayer && this.multiplayer.connected) {
      this.multiplayer.sendEvent({ kind: 'modeChange', mode });
    }
  }

  // ---- Multiplayer wiring ----
  // Called by main.js after multiplayer connect succeeds. role='host' makes
  // the local player team mash and the remote russet; role='client' flips it.
  setupMultiplayer(mp, role) {
    this.multiplayer = mp;
    this.isMpHost = role === 'host';
    this.isMpClient = role === 'client';
    const localTeam = role === 'host' ? 'mash' : 'russet';
    const remoteTeam = localTeam === 'mash' ? 'russet' : 'mash';
    // Switch the local player to the assigned team if it differs
    if (this.player.team !== localTeam) this.player.setTeam(localTeam);
    // Spawn the remote player representation
    if (this.remotePlayer) { this.remotePlayer.dispose(); this.remotePlayer = null; }
    this.remotePlayer = new RemotePlayer(this, remoteTeam, 'DAD');
    // CLIENT: wipe local bots (host is authoritative). RemoteBots will be
    // spawned from incoming snapshot.
    if (this.isMpClient) {
      for (const bot of this.bots) {
        this.scene.remove(bot.mesh);
        if (bot.healthBarBg) this.scene.remove(bot.healthBarBg);
        if (bot.healthBarFill) this.scene.remove(bot.healthBarFill);
        if (bot.aura) this.scene.remove(bot.aura);
        if (bot.auraInner) this.scene.remove(bot.auraInner);
      }
      this.bots = [];
    }
    // Hook events
    mp.onState((s) => { if (this.remotePlayer) this.remotePlayer.applyState(s); });
    mp.onEvent((ev) => this._handleMpEvent(ev));
    mp.onDisconnect(() => {
      this.announceStreak('★ DAD DISCONNECTED', '#ff5e3a', 5);
      if (this.remotePlayer) { this.remotePlayer.dispose(); this.remotePlayer = null; }
      for (const rb of this.remoteBots.values()) rb.dispose();
      this.remoteBots.clear();
      this.isMpClient = false;
      this.isMpHost = false;
    });
    // Host: immediately push current world state to the freshly-joined client
    // so they don't see an empty arena until the next 10Hz snapshot tick. Also
    // tells them the active game mode so 1v1 vs team is synced from frame 1.
    if (this.isMpHost) {
      try { mp.sendEvent({ kind: 'modeChange', mode: this.gameMode }); } catch (_) {}
      // _broadcastBotsSnapshot guards on isMpHost+connected; call directly.
      this._broadcastBotsSnapshot();
    }
    this.announceStreak('★ DAD JOINS THE FIGHT (ONLINE)', '#ff5ec8', 5);
  }

  _handleMpEvent(ev) {
    if (!ev || !ev.kind) return;
    if (ev.kind === 'hit') {
      // Peer says they hit our local player — apply damage to ourselves
      const attacker = this.remotePlayer; // attribute kill to the remote
      this.player.damage(ev.amount || 0, attacker);
    } else if (ev.kind === 'died') {
      // Peer died — if we killed them, award the kill locally
      if (this.remotePlayer) {
        this.remotePlayer.dead = true;
        this.remotePlayer.health = 0;
      }
      if (ev.killerIsPlayer) {
        this.player.awardKill(this.remotePlayer);
      }
    } else if (ev.kind === 'respawn') {
      if (this.remotePlayer) {
        this.remotePlayer.dead = false;
        this.remotePlayer.health = ev.health || 150;
        this.remotePlayer.maxHealth = ev.maxHealth || 150;
      }
    } else if (ev.kind === 'chat') {
      // Render dad's chat message in the global chat log
      if (this.remotePlayer && ev.text) {
        this.addChatMessage(this.remotePlayer, ev.text);
      }
    } else if (ev.kind === 'hitBot' && this.isMpHost) {
      // Client (dad) shot one of our authoritative bots. Apply damage on host.
      const bot = this.bots.find((b) => b.id === ev.botId);
      if (bot && !bot.dead) {
        bot.damage(ev.amount || 0, this.remotePlayer);
      }
    } else if (ev.kind === 'botKilled' && this.isMpClient) {
      // Host tells us a bot died. If we killed it, award the kill locally.
      const rb = this.remoteBots.get(ev.botId);
      if (rb) { rb.dead = true; rb.health = 0; }
      if (ev.attackerIsClient) {
        const proxy = rb || { name: ev.victimName || 'a spud', position: rb?.position, kills: 0 };
        this.player.awardKill(proxy);
      } else if (ev.victimName) {
        // Bot-on-bot or DAD killed by host's player
        this.hud.addKillMessage(`${ev.victimName} got mashed.`);
      }
    } else if (ev.kind === 'botsSnapshot' && this.isMpClient) {
      // Host's authoritative world state — sync our RemoteBots to match
      this._applyBotsSnapshot(ev);
    } else if (ev.kind === 'newMatch') {
      // Peer hit NEW MATCH — reset our world too so we stay on the same server.
      // Close the match-end screen if we hadn't clicked through yet.
      const endScreen = document.getElementById('match-end-screen');
      if (endScreen) endScreen.style.display = 'none';
      const deathScreen = document.getElementById('death-screen');
      if (deathScreen) deathScreen.style.display = 'none';
      this.newMatch(true);
    } else if (ev.kind === 'modeChange') {
      // Peer toggled 1v1 mode — apply locally without echoing
      this.setGameMode(ev.mode, true);
    }
  }

  // Build & broadcast a snapshot of all alive bots + world meta (frenzy, score).
  // Called on the host at ~10Hz. Client mirrors this to keep both views in sync.
  _broadcastBotsSnapshot() {
    if (!this.multiplayer || !this.multiplayer.connected || !this.isMpHost) return;
    const bots = [];
    for (const b of this.bots) {
      if (b.dead) continue;
      bots.push({
        id: b.id,
        team: b.team,
        x: b.position.x,
        y: b.position.y,
        z: b.position.z,
        yaw: b.mesh ? b.mesh.rotation.y : 0,
        health: b.health,
        maxHealth: b.maxHealth,
        kills: b.kills,
        name: b.name,
        weapon: b.weaponKey,
        personality: b.personality,
        dead: false,
      });
    }
    this.multiplayer.sendEvent({
      kind: 'botsSnapshot',
      bots,
      teamKills: { mash: this.teamKills.mash, russet: this.teamKills.russet },
      frenzy: this.frenzy ? { id: this.frenzy.id, name: this.frenzy.name, color: this.frenzy.color, detail: this.frenzy.detail, timer: this.frenzy.timer } : null,
    });
  }

  // Receive a snapshot from the host. Add/update/remove remote bots so the
  // client's view matches the host's authoritative state.
  _applyBotsSnapshot(ev) {
    const seen = new Set();
    for (const snap of (ev.bots || [])) {
      seen.add(snap.id);
      let rb = this.remoteBots.get(snap.id);
      if (!rb) {
        rb = new RemoteBot(this, snap);
        this.remoteBots.set(snap.id, rb);
      } else {
        rb.applyState(snap);
      }
    }
    // Remove RemoteBots that are no longer in the snapshot (dead/despawned)
    for (const [id, rb] of this.remoteBots) {
      if (!seen.has(id)) {
        rb.dispose();
        this.remoteBots.delete(id);
      }
    }
    // Mirror team kills + frenzy so HUD shows the right numbers
    if (ev.teamKills) {
      this.teamKills.mash = ev.teamKills.mash;
      this.teamKills.russet = ev.teamKills.russet;
    }
    if (ev.frenzy && !this.frenzy) {
      this.frenzy = ev.frenzy;
      this.announceFrenzy(ev.frenzy);
    } else if (ev.frenzy && this.frenzy) {
      this.frenzy.timer = ev.frenzy.timer;     // refresh countdown
      this.frenzy.id = ev.frenzy.id;
    } else if (!ev.frenzy && this.frenzy) {
      this.endFrenzy();
    }
  }

  // Called every frame while multiplayer is live — broadcasts our state.
  // y is sent as body-center (matches how bots store position).
  _tickMultiplayer() {
    if (!this.multiplayer || !this.multiplayer.connected) return;
    const p = this.player;
    this.multiplayer.sendState({
      x: p.position.x,
      y: p.position.y - 0.75,           // eye Y → body center (foot + 0.85)
      z: p.position.z,
      yaw: p.yaw,
      health: p.health,
      maxHealth: p.maxHealth,
      kills: p.kills || 0,
      name: p.name || 'You',
      weapon: p.currentWeapon,
      dead: !!p.dead,
    });
  }

  toggleDadMode() {
    if (this.dadActive) this.deactivateDad();
    else this.activateDad();
  }

  activateDad() {
    if (this.dadActive) return;
    if (!this.running || this.matchOver) return;
    this.dadActive = true;
    this.spawnDadBot();
    this.onResize();
    const btn = document.getElementById('dad-btn-hud');
    if (btn) { btn.textContent = '× DAD [F8]'; btn.classList.add('on'); }
    const help = document.getElementById('dad-help');
    if (help) help.style.display = 'block';
    const split = document.getElementById('split-divider');
    if (split) split.style.display = 'block';
    this.announceStreak('★ DAD JOINS THE FIGHT', '#ff5ec8', 5);
    if (this.sfx && this.sfx.killstreak) this.sfx.killstreak();
  }

  spawnDadBot() {
    // Always spawn on the team OPPOSITE the player so they're noticeable
    // enemies. If a previous DAD bot exists (dead corpse), clean it up.
    if (this.dadBot) {
      this.scene.remove(this.dadBot.mesh);
      if (this.dadBot.healthBarBg) this.scene.remove(this.dadBot.healthBarBg);
      if (this.dadBot.healthBarFill) this.scene.remove(this.dadBot.healthBarFill);
      if (this.dadBot.aura) this.scene.remove(this.dadBot.aura);
      if (this.dadBot.auraInner) this.scene.remove(this.dadBot.auraInner);
      this.bots = this.bots.filter((b) => b !== this.dadBot);
    }
    const dadTeam = this.player.team === 'mash' ? 'russet' : 'mash';
    const spawnList = this.arena.teamSpawns[dadTeam];
    const sp = spawnList[Math.floor(Math.random() * spawnList.length)].clone();
    const dad = new Bot(this, sp, dadTeam);
    dad.manual = true;
    dad.name = 'DAD';
    dad.skill = 3;
    dad.maxHealth = 150;
    dad.health = 150;
    // Face toward arena center
    dad.yaw = dadTeam === 'mash' ? 0 : Math.PI;
    // Hide DAD's potato body (and props) from his own first-person camera by
    // moving them to layer 1. Main camera has both layers enabled.
    dad.mesh.traverse((o) => o.layers.set(1));
    if (dad.healthBarBg) dad.healthBarBg.layers.set(1);
    if (dad.healthBarFill) dad.healthBarFill.layers.set(1);
    if (dad.aura) dad.aura.layers.set(1);
    if (dad.auraInner) dad.auraInner.layers.set(1);
    // Crank DAD's aura — much bigger and brighter than normal hot-streak rings
    if (dad.aura) {
      dad.aura.scale.set(2.0, 2.0, 1);
      dad.aura.material.color.setHex(0xff5ec8);
      dad.aura.material.opacity = 0.9;
    }
    if (dad.auraInner) {
      dad.auraInner.scale.set(2.0, 2.0, 1);
      dad.auraInner.material.color.setHex(0x5effe6);
      dad.auraInner.material.opacity = 0.85;
    }
    // Big visible crown so even from afar dad is the obvious "other player"
    if (dad.bountyCrown) {
      dad.bountyCrown.visible = true;
      dad.bountyCrown.material.color.setHex(0xff5ec8);
      dad.bountyCrown.scale.set(1.6, 1.6, 1.6);
    }
    // Recolor the team hat hot-pink for distinctiveness
    if (dad.teamHat) dad.teamHat.material.color.setHex(0xff5ec8);
    this.bots.push(dad);
    this.dadBot = dad;
  }

  deactivateDad() {
    if (this.dadBot) {
      // Remove DAD from the world
      this.scene.remove(this.dadBot.mesh);
      if (this.dadBot.healthBarBg) this.scene.remove(this.dadBot.healthBarBg);
      if (this.dadBot.healthBarFill) this.scene.remove(this.dadBot.healthBarFill);
      if (this.dadBot.aura) this.scene.remove(this.dadBot.aura);
      if (this.dadBot.auraInner) this.scene.remove(this.dadBot.auraInner);
      this.bots = this.bots.filter((b) => b !== this.dadBot);
    }
    this.dadBot = null;
    this.dadActive = false;
    this.dadKeys = {};
    this.onResize();
    const btn = document.getElementById('dad-btn-hud');
    if (btn) { btn.textContent = '+ DAD [F8]'; btn.classList.remove('on'); }
    const help = document.getElementById('dad-help');
    if (help) help.style.display = 'none';
    const split = document.getElementById('split-divider');
    if (split) split.style.display = 'none';
  }
}
