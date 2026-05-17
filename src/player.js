import * as THREE from 'three';
import { WEAPONS, BASE_FOV } from './weapons.js';
import { makePotato } from './potato.js';
import { TEAM_COLORS } from './arena.js';
import { getModel as getGunModel, isLoaded as gunIsLoaded, preloadAllGuns, loadGun, GUN_TUNING } from './gunmodels.js';

// Per-weapon ADS (right-click) pose. Every gun shares the same overall
// concept — gun travels to screen center, rises to eye level, pulls toward
// the camera, with a slow lerp and delayed FOV pull-in so the motion reads
// before the zoom commits. Per-weapon variations tilt the gun slightly for
// flavor (pistol high-and-near, masher cracked-up, tossor barrel-up, etc.).
//
// Shared target values (override per-weapon when needed):
//   targetX: -0.42  — cancels gun's normal +0.42 right offset → centered
//   targetY:  0.18  — gun rises to eye level (camera centerline)
//   targetZ:  0.15  — pulls the gun back into the camera ("eye in the gun")
//   rate:      6    — slow lerp so the motion is visible, not snappy
//   fovEase:   3    — pow(adsAmount,3) → FOV holds wide for most of the
//                     animation, then snaps in at the end
const ADS_POSES = {
  // targetY lowered well below crosshair (was 0.18 — that lifted the gun
  // right into the screen center and the crosshair sat inside the receiver).
  // Sniper keeps a slightly higher value since the scope sits above the barrel.
  // targetY unified across non-sniper guns so the crosshair-to-gun distance
  // matches the user's reference screenshot of the tossor.
  spudgun:     { targetX: -0.42, targetY: 0.08, targetZ: 0.12, tiltX:  0.04, tiltY: 0, tiltZ: -0.04, rate: 7,   fovEase: 3 },
  fryer:       { targetX: -0.42, targetY: 0.08, targetZ: 0.12, tiltX:  0.02, tiltY: 0, tiltZ:  0.0,  rate: 6.5, fovEase: 3 },
  hashbrowner: { targetX: -0.42, targetY: 0.08, targetZ: 0.12, tiltX: -0.02, tiltY: 0, tiltZ: -0.03, rate: 6,   fovEase: 3.2 },
  masher:      { targetX: -0.42, targetY: 0.08, targetZ: 0.12, tiltX:  0.08, tiltY: 0, tiltZ: -0.05, rate: 5.5, fovEase: 3.4 },
  spudling:    { targetX: -0.42, targetY: 0.20, targetZ: 0.12, tiltX:  0.02, tiltY: 0, tiltZ: -0.03, rate: 7.5, fovEase: 3 },
  boomstick:   { targetX: -0.42, targetY: 0.12, targetZ: 0.15, tiltX:  0.0,  tiltY: 0, tiltZ:  0.0,  rate: 5.5, fovEase: 4 },
  tossor:      { targetX: -0.42, targetY: 0.08, targetZ: 0.12, tiltX: -0.10, tiltY: 0, tiltZ:  0.0,  rate: 6,   fovEase: 3.2 },
};

// Per-weapon reload choreography. Each style returns position + rotation
// deltas for the viewmodel AND a "mag prop" sub-state describing where the
// little cartridge cube should be drawn (or null/hidden). Every function
// returns to the neutral pose at p=0 AND p=1 so the gun doesn't get stuck.
//
// Choreography (most guns share this 4-phase structure):
//   0.00–0.20  PRESENT  — gun tilts forward to expose the mag well
//   0.20–0.40  EJECT    — old mag falls out (cartridge prop drops away)
//   0.40–0.70  INSERT   — new mag rises into the well and clicks in
//   0.70–1.00  COCK     — gun racks/charges and returns to ready
//
// The break-action guns (masher / tossor) substitute "hinge open" for the
// mag-swap phase since they don't have detachable mags.
const RELOAD_ANIMS = {
  // ----- Pistol — mag drop, mag insert, slide pull -----
  spudgun: (p) => {
    const present = p < 0.20 ? p / 0.20 : (p < 1 ? 1 : 0);
    const tilt = -0.45 * Math.sin(Math.PI * p);             // tilt forward & back, returns to 0
    const slide = p > 0.70 ? Math.sin(Math.PI * (p - 0.70) / 0.30) : 0; // slide pull during cock
    const dy = -0.10 * Math.sin(Math.PI * p);
    const dz = 0.06 * Math.sin(Math.PI * p) - 0.10 * slide;
    let mag = null;
    if (p >= 0.20 && p < 0.40) {
      // Old mag falling out
      const t = (p - 0.20) / 0.20;
      mag = { x: 0.35, y: -0.30 - 0.40 * t, z: -0.40, visible: t < 0.95 };
    } else if (p >= 0.40 && p < 0.70) {
      // New mag rising into well
      const t = (p - 0.40) / 0.30;
      mag = { x: 0.35, y: -0.65 + 0.35 * t, z: -0.40, visible: true };
    }
    return { dx: 0, dy, dz, rx: tilt, ry: 0, rz: 0, mag };
  },
  // ----- AR — mag swap + charging handle pull -----
  fryer: (p) => {
    const tilt = -0.35 * Math.sin(Math.PI * p);
    const cock = p > 0.75 ? Math.sin(Math.PI * (p - 0.75) / 0.25) : 0;
    const ry = -0.18 * Math.sin(Math.PI * p) + 0.20 * cock;
    const dx = 0.04 * Math.sin(Math.PI * p) + 0.06 * cock;
    const dy = -0.08 * Math.sin(Math.PI * p);
    let mag = null;
    if (p >= 0.20 && p < 0.42) {
      const t = (p - 0.20) / 0.22;
      mag = { x: 0.40, y: -0.32 - 0.45 * t, z: -0.42, visible: t < 0.95 };
    } else if (p >= 0.42 && p < 0.70) {
      const t = (p - 0.42) / 0.28;
      mag = { x: 0.40, y: -0.70 + 0.38 * t, z: -0.42, visible: true };
    }
    return { dx, dy, dz: 0, rx: tilt, ry, rz: 0, mag };
  },
  // ----- Pump shotgun — pump twice, no mag prop (shells in tube) -----
  hashbrowner: (p) => {
    const pump = Math.sin(p * Math.PI * 2);  // -1 .. +1 .. -1 .. +1 .. 0 (returns)
    const dz = 0.18 * pump;
    const rx = -0.12 * Math.sin(Math.PI * p);
    const dy = 0.02 * pump;
    return { dx: 0, dy, dz, rx, ry: 0, rz: 0, mag: null };
  },
  // ----- Double-barrel — break open, eject shells, insert shells, snap shut -----
  masher: (p) => {
    // open: 0..0.30 ramp up, 0.30..0.70 hold, 0.70..1.0 ramp down (snap close)
    let open;
    if (p < 0.30) open = p / 0.30;
    else if (p < 0.70) open = 1;
    else open = 1 - (p - 0.70) / 0.30;
    // Break action pivots the gun DOWN around the barrel hinge.
    const rx = -1.10 * open;
    const dz = -0.05 * open;
    const dy = -0.08 * open;
    // Two shells fly down + out during the open hold
    let mag = null;
    if (p >= 0.30 && p < 0.55) {
      const t = (p - 0.30) / 0.25;
      mag = { x: 0.42, y: -0.30 - 0.50 * t, z: -0.30, visible: t < 0.95 };
    } else if (p >= 0.55 && p < 0.70) {
      // New shells slide in
      const t = (p - 0.55) / 0.15;
      mag = { x: 0.42, y: -0.55 + 0.25 * t, z: -0.40, visible: true };
    }
    return { dx: 0, dy, dz, rx, ry: 0, rz: 0, mag };
  },
  // ----- SMG — fast mag swap + bolt slap -----
  spudling: (p) => {
    const tilt = -0.30 * Math.sin(Math.PI * p);
    const slap = p > 0.75 ? Math.sin(Math.PI * (p - 0.75) / 0.25) : 0;
    const dx = 0.05 * slap;
    const dy = -0.09 * Math.sin(Math.PI * p);
    let mag = null;
    if (p >= 0.15 && p < 0.40) {
      const t = (p - 0.15) / 0.25;
      mag = { x: 0.40, y: -0.30 - 0.45 * t, z: -0.40, visible: t < 0.95 };
    } else if (p >= 0.40 && p < 0.70) {
      const t = (p - 0.40) / 0.30;
      mag = { x: 0.40, y: -0.68 + 0.36 * t, z: -0.40, visible: true };
    }
    return { dx, dy, dz: 0, rx: tilt, ry: 0, rz: 0, mag };
  },
  // ----- Sniper — DROP DOWN then HOP up and down in place -----
  // Phase 1 (0–0.15): drop down + tilt nose-down quickly.
  // Phase 2 (0.15–0.85): 3 hop cycles while held low.
  // Phase 3 (0.85–1.0): rise back up to ready.
  boomstick: (p) => {
    let dy, rx;
    if (p < 0.15) {
      const t = p / 0.15;
      const e = t * t;            // ease-in
      dy = -0.22 * e;
      rx = -0.38 * e;
    } else if (p < 0.85) {
      const t = (p - 0.15) / 0.70;
      const hop = Math.sin(t * Math.PI * 6) * 0.08;  // 3 full hop cycles
      const hopTilt = Math.sin(t * Math.PI * 6) * 0.06;
      dy = -0.22 + hop;
      rx = -0.38 + hopTilt;
    } else {
      const t = (p - 0.85) / 0.15;
      const e = 1 - (1 - t) * (1 - t);  // ease-out
      dy = -0.22 * (1 - e);
      rx = -0.38 * (1 - e);
    }
    return { dx: 0, dy, dz: 0, rx, ry: 0, rz: 0, mag: null };
  },
  // ----- Grenade launcher — break cylinder open sideways, swap drum, close -----
  tossor: (p) => {
    let open;
    if (p < 0.25) open = p / 0.25;
    else if (p < 0.70) open = 1;
    else open = 1 - (p - 0.70) / 0.30;
    // Rotate around Z (barrel axis) — cylinder hinges out to the side
    const rz = -1.20 * open;
    const dx = 0.05 * open;
    let mag = null;
    if (p >= 0.30 && p < 0.55) {
      // Round/cylinder shell ejecting
      const t = (p - 0.30) / 0.25;
      mag = { x: 0.55, y: -0.20 - 0.40 * t, z: -0.30, visible: t < 0.95 };
    } else if (p >= 0.55 && p < 0.70) {
      const t = (p - 0.55) / 0.15;
      mag = { x: 0.55, y: -0.55 + 0.30 * t, z: -0.30, visible: true };
    }
    return { dx, dy: -0.04 * open, dz: 0, rx: 0, ry: 0, rz, mag };
  },
};

// Kick off GLB loads as soon as the module is parsed. Player constructor will
// swap to the real model whenever it's ready; until then the procedural box
// keeps the viewmodel from being empty.
preloadAllGuns().catch((err) => console.warn('gun model load failed', err));

// Build a soft radial-gradient texture for muzzle flash + smoke. `smoke=true`
// produces a more diffuse, less concentrated falloff so the smoke quad reads
// as a cloud rather than a hot spark.
function makeRadialFlashTexture(smoke = false) {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  if (smoke) {
    g.addColorStop(0.0, 'rgba(255,255,255,0.75)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.30)');
    g.addColorStop(1.0, 'rgba(255,255,255,0.0)');
  } else {
    g.addColorStop(0.0, 'rgba(255,255,255,1.0)');
    g.addColorStop(0.25, 'rgba(255,240,170,0.95)');
    g.addColorStop(0.55, 'rgba(255,170,60,0.55)');
    g.addColorStop(1.0, 'rgba(255,60,0,0.0)');
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

const SPEED = 8;
const SPRINT_MULT = 1.55;
const GRAVITY = 28;
const JUMP_VEL = 9.5;
const PLAYER_RADIUS = 0.42;
const EYE_HEIGHT = 1.6;
const HEAD_OFFSET = 0.25;
const STEP_HEIGHT = 0.6;
const REGEN_DELAY = 4.0;
const REGEN_RATE = 1; // hp per second when out of combat (slow drip)
const SPAWN_INVULN = 2.5;

export class Player {
  constructor(game) {
    this.game = game;
    this.team = 'mash';
    const spawnList = game.arena.teamSpawns[this.team];
    const sp = spawnList[Math.floor(Math.random() * spawnList.length)];
    this.position = new THREE.Vector3(sp.x, sp.y + EYE_HEIGHT - 0.85, sp.z);
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.onGround = true;
    this.health = 150;
    this.maxHealth = 150;
    this.baseMaxHealth = 150;
    this.dead = false;
    this.spawnInvuln = SPAWN_INVULN;
    this.timeSinceDamage = 0;
    this.coins = 0;
    this.kills = 0;
    this.streak = 0;
    this.sessionXp = 0;
    this.lastKiller = null; // { ref, time } for revenge tracking
    this.name = 'You';
    // Player participates in the global chat as a first-class speaker.
    this.personality = 'player';
    this.persona = { color: '#ffffff' };
    // Chat input modal state. While open, all game keys are suppressed in this
    // file's keydown handler so the typed letters don't trigger weapon swaps.
    this.chatOpen = false;
    // Soft target-lock: holds a Bot reference. Tied to the F key.
    this.lockedTarget = null;
    this.buffs = {};
    // Per-match stats — drives end-of-match awards and daily challenges
    this.matchStats = this.makeMatchStats();

    // recoil that adds to camera pitch/yaw — decays over time
    this.recoilPitch = 0;
    this.recoilYaw = 0;

    this.loadoutWeapon = 'spudgun';
    this.loadout = [this.loadoutWeapon, 'spudgun', 'knife'];
    this.currentWeapon = this.loadout[0];
    this.ammo = {};
    for (const k of this.loadout) {
      this.ammo[k] = { mag: WEAPONS[k].magSize, reserve: WEAPONS[k].reserve };
    }
    this.sentryActive = false;
    this.sentryCooldown = 0;
    this.shakeTime = 0;
    this.shakeAmt = 0;
    // Special-move state (T key per-weapon move)
    this.specialCooldowns = {};      // weaponKey → seconds remaining
    this.specialMod = null;          // single-use modifier for next fire(): { type, ... }
    this.specialQueue = null;        // burst-style auto-fire: { remaining, gap, timer, spread }
    this.hotBarrelTimer = 0;         // SMG fire-rate buff duration
    this.fireCooldown = 0;
    this.reloading = false;
    this.reloadTimer = 0;
    this.muzzleKick = 0;
    this.bobPhase = 0;
    this.ads = false;
    this.adsAmount = 0; // 0 = hipfire, 1 = full ADS
    // Knife right-click speed burst (kept on the knife class only)
    this._knifeDashCooldown = 0;
    // Slide — C key while sprinting, 0.65s active, 1.5s cooldown.
    // Slide-hop: press Space mid-slide for a boosted jump (parkour combo).
    this.slideCooldown = 0;
    this.slideTimer = 0;
    this.slideDirX = 0;
    this.slideDirZ = 0;
    this.slideEyeDip = 0;

    // face toward arena center
    this.yaw = this.team === 'mash' ? 0 : Math.PI;

    this.keys = {};
    this.mouseDown = false;

    // Third-person body — lives on layer 2 so it's INVISIBLE to the player's
    // own first-person camera (which renders layers 0+1) but VISIBLE to any
    // secondary cameras (DAD's split-screen view, future remote spectator
    // cameras). Special "leader" design: gold crown + star aura + team cape.
    this.bodyMesh = makePotato({ size: 1.8, color: 0xd9a86b });
    this.bodyMesh.traverse((o) => o.layers.set(2));
    // Team-color hat (kept as a field so we can recolor it on team switch)
    const teamCol = TEAM_COLORS[this.team] || 0xc23a3a;
    this.bodyHat = new THREE.Mesh(
      new THREE.CylinderGeometry(0.4, 0.55, 0.25, 12),
      new THREE.MeshBasicMaterial({ color: teamCol }),
    );
    this.bodyHat.position.y = 1.18;
    this.bodyHat.layers.set(2);
    this.bodyMesh.add(this.bodyHat);
    // Golden leader crown — taller, ringed, with 5 spikes
    const crownGroup = new THREE.Group();
    const crownBand = new THREE.Mesh(
      new THREE.CylinderGeometry(0.36, 0.36, 0.18, 14),
      new THREE.MeshStandardMaterial({ color: 0xffd700, metalness: 0.85, roughness: 0.2, emissive: 0x553a16, emissiveIntensity: 0.45 }),
    );
    crownGroup.add(crownBand);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const spike = new THREE.Mesh(
        new THREE.ConeGeometry(0.08, 0.28, 6),
        new THREE.MeshStandardMaterial({ color: 0xffd700, metalness: 0.85, roughness: 0.2, emissive: 0x553a16, emissiveIntensity: 0.5 }),
      );
      spike.position.set(Math.cos(a) * 0.34, 0.22, Math.sin(a) * 0.34);
      crownGroup.add(spike);
      const gem = new THREE.Mesh(
        new THREE.SphereGeometry(0.045, 8, 6),
        new THREE.MeshBasicMaterial({ color: 0xff5e3a }),
      );
      gem.position.copy(spike.position);
      gem.position.y -= 0.18;
      crownGroup.add(gem);
    }
    crownGroup.position.y = 1.55;
    crownGroup.traverse((o) => o.layers.set(2));
    this.bodyMesh.add(crownGroup);
    this.bodyCrown = crownGroup;
    // Team-color cape behind shoulders — flat plane, semi-transparent
    this.bodyCape = new THREE.Mesh(
      new THREE.PlaneGeometry(1.05, 1.45),
      new THREE.MeshBasicMaterial({ color: teamCol, side: THREE.DoubleSide, transparent: true, opacity: 0.92 }),
    );
    this.bodyCape.position.set(0, 0.05, -0.32);
    this.bodyCape.layers.set(2);
    this.bodyMesh.add(this.bodyCape);
    // Big star aura on the ground under the player so they're recognizable from afar
    const auraStarGeo = new THREE.RingGeometry(1.8, 2.3, 5);
    const auraStarMat = new THREE.MeshBasicMaterial({ color: 0xffd700, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false });
    this.bodyAura = new THREE.Mesh(auraStarGeo, auraStarMat);
    this.bodyAura.rotation.x = -Math.PI / 2;
    this.bodyAura.layers.set(2);
    this.bodyMesh.add(this.bodyAura);
    game.scene.add(this.bodyMesh);
    // Make P2 (DAD) camera see layer 2 so dad can see the player's body
    if (game.camera2) game.camera2.layers.enable(2);

    this.viewmodel = new THREE.Group();
    // Procedural fallback box — sits under the real GLB until it loads. When
    // a GLB is ready, _swapGunModel() hides this and attaches the loaded model.
    this.gunMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, 0.18, 0.55),
      new THREE.MeshStandardMaterial({ color: 0x8b5a2b, roughness: 0.7 })
    );
    this.gunMesh.position.set(0.32, -0.28, -0.55);
    this.gunMesh.rotation.y = -0.05;
    this.viewmodel.add(this.gunMesh);
    // gunHolder is what we swap children on. It hosts the loaded GLB and the
    // muzzle effects so they all kick/recoil together.
    this.gunHolder = new THREE.Group();
    this.viewmodel.add(this.gunHolder);
    this.activeGunModel = null;   // currently-mounted GLB clone (or null)

    // Reload prop — a small "ammo cartridge" mesh that animates in/out during
    // reloads to sell the magazine-swap action. Hidden by default; the reload
    // animation moves + shows it for specific phases. Each gun's animation
    // controls where the cartridge appears (mag well location varies).
    const magMat = new THREE.MeshStandardMaterial({ color: 0xffce5e, emissive: 0x4a3a0a, roughness: 0.45, metalness: 0.4 });
    this.reloadMag = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.10, 0.05), magMat);
    this.reloadMag.visible = false;
    this.viewmodel.add(this.reloadMag);

    // --- Muzzle flash stack ---
    // 1) Sprite-style billboarded flash: a radial-gradient additive disc that
    //    pops to full size for ~50ms then vanishes. Reads as a hot burst.
    const flashTex = makeRadialFlashTexture();
    this.muzzleFlash = new THREE.Mesh(
      new THREE.PlaneGeometry(0.6, 0.6),
      new THREE.MeshBasicMaterial({
        map: flashTex,
        color: 0xfff0a0,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.muzzleFlash.renderOrder = 50;
    this.gunHolder.add(this.muzzleFlash);
    // 2) PointLight — lights up the gun + nearby walls for one frame. Cheap.
    this.muzzleLight = new THREE.PointLight(0xfff0a0, 0, 6, 2);
    this.gunHolder.add(this.muzzleLight);
    // 3) Smoke puff — small fading quad that drifts forward + up
    const smokeTex = makeRadialFlashTexture(true);
    this.muzzleSmoke = new THREE.Mesh(
      new THREE.PlaneGeometry(0.4, 0.4),
      new THREE.MeshBasicMaterial({
        map: smokeTex,
        color: 0xb8b0a0,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
    );
    this.muzzleSmoke.renderOrder = 49;
    this.gunHolder.add(this.muzzleSmoke);
    // Legacy `muzzle` sphere reference kept for any external code; positioned
    // off-screen and invisible.
    this.muzzle = this.muzzleFlash;
    // Per-frame animation state for the new effects
    this._flashTimer = 0;
    this._smokeTimer = 0;
    this._smokeOffsetY = 0;
    this._smokeOffsetZ = 0;
    // Knife swing animation timer (0..1 over swing duration)
    this._knifeSwing = 0;
    // Knife right-click dash — burst of speed with cooldown
    this._knifeDashCooldown = 0;
    // Sentry tripod base — only visible while sentry mode is active
    this.sentryBase = new THREE.Group();
    const tripodMat = new THREE.MeshStandardMaterial({ color: 0x2a2018, roughness: 0.85 });
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.06, 0.34, 8), tripodMat);
    post.position.set(0.32, -0.45, -0.55);
    this.sentryBase.add(post);
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 0.04, 12), tripodMat);
    plate.position.set(0.32, -0.62, -0.55);
    this.sentryBase.add(plate);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.22, 6), tripodMat);
      leg.position.set(0.32 + Math.cos(a) * 0.12, -0.7, -0.55 + Math.sin(a) * 0.12);
      leg.rotation.x = Math.sin(a) * 0.45;
      leg.rotation.z = -Math.cos(a) * 0.45;
      this.sentryBase.add(leg);
    }
    this.sentryBase.visible = false;
    this.viewmodel.add(this.sentryBase);
    game.camera.add(this.viewmodel);
    game.scene.add(game.camera);

    // Try to mount the real GLB for the starting weapon. If it isn't loaded
    // yet, _swapGunModel will retry when the load resolves.
    this._swapGunModel(this.currentWeapon);

    // First-person Mixamo arms — see _tryInitFpsArms(). All state lives here
    // so a missing/failed character.js module doesn't trip any other code.
    this.fpsArms = null;
    this.fpsArmsMixer = null;
    this.fpsArmsActions = null;
    this._fpsArmsBusy = false;        // reentrancy guard for the async init
    this._fpsArmsReloadActive = false;
    this._fpsArmsStabActive = false;
    this._fpsArmsStabTimer = 0;        // counts down during knife stab anim
    this._tryInitFpsArms();
    // Dev positioning tool — F9 to toggle. Lets the user dial in arms + gun
    // offsets in-game and log the final values to console.
    this._setupDevPanel();

    this.setupInput();
  }

  // Dynamic-imports character.js and stands up an FPS-view skinned arm rig.
  // Returns immediately on any failure; the game keeps running with just the
  // procedural gun viewmodel. Safe to call repeatedly — re-entrancy guard
  // prevents kicking off multiple parallel inits.
  _tryInitFpsArms() {
    if (this.fpsArms || this._fpsArmsBusy) return;
    this._fpsArmsBusy = true;
    (async () => {
      try {
        const mod = await import('./character.js');
        if (!mod.isCharacterReady || !mod.isCharacterReady()) {
          this._fpsArmsBusy = false;
          return;   // not ready yet — we'll retry next frame
        }
        // Light peach/skin tone. armsOnly enables a shader vertex mask in
        // character.js that discards everything not weighted to the
        // shoulder→arm→forearm→hand chain, so torso/head/legs vanish.
        const bundle = await mod.makeCharacter({ tint: 0xe8c6a4, armsOnly: true });
        if (!bundle || !bundle.mesh) {
          this._fpsArmsBusy = false;
          return;
        }
        // Initial rough position — character looks vaguely toward the camera
        // with arms forward. Real alignment happens after we add to viewmodel.
        bundle.mesh.position.set(0, -1.65, -0.2);
        bundle.mesh.rotation.y = Math.PI;
        bundle.mesh.traverse((o) => o.layers.set(1));
        this.viewmodel.add(bundle.mesh);
        // Now measure where the RIGHT hand bone landed in viewmodel-local
        // coords, and slide the whole character so the hand lines up with
        // the gun viewmodel's resting position. Skipping the math guesswork
        // about Mixamo's coordinate conventions.
        this.viewmodel.updateMatrixWorld(true);
        bundle.mesh.updateMatrixWorld(true);
        let rightHand = null;
        bundle.mesh.traverse((o) => {
          if (rightHand) return;
          if (o.isBone && /RightHand$/.test(o.name || '')) rightHand = o;
        });
        if (rightHand) {
          // Slightly above the gunMesh resting position so the wrist + part
          // of the forearm have headroom in the viewport — otherwise the
          // bottom of the screen clips the hand off.
          const GUN_POS = new THREE.Vector3(0.32, -0.20, -0.55);
          const handWorld = new THREE.Vector3();
          rightHand.getWorldPosition(handWorld);
          this.viewmodel.worldToLocal(handWorld);
          const delta = GUN_POS.clone().sub(handWorld);
          bundle.mesh.position.add(delta);
          this.fpsArmsRightHand = rightHand;
        }
        // Sync the dev-panel sliders so toggling F9 doesn't teleport the
        // arms back to the defaults the moment you touch a slider.
        if (this._devState) {
          this._devState.armsX = bundle.mesh.position.x;
          this._devState.armsY = bundle.mesh.position.y;
          this._devState.armsZ = bundle.mesh.position.z;
          this._devState.armsRotY = bundle.mesh.rotation.y;
          this._devState.armsScale = bundle.mesh.scale.x;
          this._syncDevSliders();
        }
        this.fpsArms = bundle.mesh;
        this.fpsArmsMixer = bundle.mixer;
        this.fpsArmsActions = bundle.actions;
        // Neutral grip = frame 0 of the reloading clip (hands forward on weapon)
        const rel = this.fpsArmsActions?.reloading;
        if (rel) {
          rel.setLoop(THREE.LoopOnce, 1);
          rel.clampWhenFinished = true;
          rel.reset();
          rel.timeScale = 0;
          rel.play();
        }
      } catch (err) {
        console.warn('[player] FPS arms init failed', err);
      } finally {
        this._fpsArmsBusy = false;
      }
    })();
  }

  // In-game positioning tool for the FPS arms and gun. Toggle with F9.
  // Renders a slider panel — drag the sliders, watch the model update live,
  // hit COPY to grab the values so I can bake them in as defaults.
  _setupDevPanel() {
    if (this._devPanel) return;
    this._devMode = false;
    this._gunDevOffset = new THREE.Vector3();
    // State for sliders — defaults match the initial values set elsewhere
    this._devState = {
      armsX: 0, armsY: -1.65, armsZ: -0.2,
      armsRotY: Math.PI,
      armsScale: 0.011,
      gunX: 0, gunY: 0, gunZ: 0,
    };
    const panel = document.createElement('div');
    panel.id = 'fps-dev-panel';
    panel.style.cssText = [
      'position:fixed', 'top:10px', 'right:10px', 'z-index:9999',
      'background:rgba(0,0,0,0.85)', 'color:#5effb8',
      'font:11px/1.5 monospace', 'padding:10px 12px', 'border-radius:8px',
      'display:none', 'border:1px solid #5effb8',
      'min-width:380px',
    ].join(';');
    panel.innerHTML = `
      <div style="font-weight:bold;margin-bottom:6px;border-bottom:1px solid #5effb8;padding-bottom:4px">
        F9 DEV MODE — arms/gun positioner
      </div>
      <div data-row="armsX"></div>
      <div data-row="armsY"></div>
      <div data-row="armsZ"></div>
      <div data-row="armsRotY"></div>
      <div data-row="armsScale"></div>
      <div style="height:6px"></div>
      <div data-row="gunX"></div>
      <div data-row="gunY"></div>
      <div data-row="gunZ"></div>
      <div style="margin-top:8px;text-align:center">
        <button id="dev-copy" style="background:#5effb8;color:#000;border:0;padding:4px 12px;font-family:monospace;cursor:pointer;border-radius:4px">COPY VALUES</button>
        <button id="dev-reset" style="background:#444;color:#5effb8;border:1px solid #5effb8;padding:4px 8px;font-family:monospace;cursor:pointer;border-radius:4px;margin-left:6px">RESET</button>
      </div>
      <div id="dev-status" style="margin-top:6px;font-size:10px;opacity:0.7;text-align:center;min-height:14px"></div>
    `;
    document.body.appendChild(panel);
    this._devPanel = panel;

    const sliderRows = {
      armsX:     { label: 'Arms X',    min: -0.6, max: 0.6,  step: 0.001 },
      armsY:     { label: 'Arms Y',    min: -2.4, max: 0,    step: 0.002 },
      armsZ:     { label: 'Arms Z',    min: -0.8, max: 0.4,  step: 0.001 },
      armsRotY:  { label: 'Arms RotY', min: 0,    max: 6.30, step: 0.005 },
      armsScale: { label: 'Arms Scale',min: 0.001,max: 0.025,step: 0.0002 },
      gunX:      { label: 'Gun  X off',min: -0.02, max: 0.02, step: 0.0001 },
      gunY:      { label: 'Gun  Y off',min: -0.02, max: 0.02, step: 0.0001 },
      gunZ:      { label: 'Gun  Z off',min: -0.02, max: 0.02, step: 0.0001 },
    };
    for (const [key, cfg] of Object.entries(sliderRows)) {
      const row = panel.querySelector(`[data-row="${key}"]`);
      const val = this._devState[key];
      row.innerHTML = `
        <label style="display:flex;align-items:center;gap:6px">
          <span style="display:inline-block;width:78px">${cfg.label}</span>
          <input type="range" min="${cfg.min}" max="${cfg.max}" step="${cfg.step}" value="${val}" data-key="${key}" data-role="slider" style="flex:1">
          <input type="number" min="${cfg.min}" max="${cfg.max}" step="${cfg.step}" value="${(+val).toFixed(4)}" data-key="${key}" data-role="number" style="width:74px;background:#000;color:#5effb8;border:1px solid #5effb8;font-family:monospace;font-size:11px;padding:1px 4px">
        </label>
      `;
    }
    panel.addEventListener('input', (e) => {
      const tgt = e.target;
      if (tgt.tagName !== 'INPUT') return;
      const key = tgt.dataset.key;
      if (!key) return;
      const v = parseFloat(tgt.value);
      if (isNaN(v)) return;
      this._devState[key] = v;
      // Keep the slider and the number input synced — whichever one was
      // touched, mirror the value to the other.
      panel.querySelectorAll(`input[data-key="${key}"]`).forEach((other) => {
        if (other !== tgt) other.value = v;
      });
      this._applyDevState();
    });
    panel.querySelector('#dev-copy').addEventListener('click', () => {
      const s = this._devState;
      const out =
`Arms position: (${s.armsX.toFixed(3)}, ${s.armsY.toFixed(3)}, ${s.armsZ.toFixed(3)})
Arms rotation Y: ${s.armsRotY.toFixed(3)}
Arms scale: ${s.armsScale.toFixed(4)}
Gun offset: (${s.gunX.toFixed(3)}, ${s.gunY.toFixed(3)}, ${s.gunZ.toFixed(3)})`;
      try { navigator.clipboard.writeText(out); } catch (_) {}
      console.log(out);
      const status = panel.querySelector('#dev-status');
      if (status) {
        status.textContent = 'Copied! Paste back in chat.';
        setTimeout(() => { status.textContent = ''; }, 2000);
      }
    });
    panel.querySelector('#dev-reset').addEventListener('click', () => {
      Object.assign(this._devState, {
        armsX: 0, armsY: -1.65, armsZ: -0.2,
        armsRotY: Math.PI, armsScale: 0.011,
        gunX: 0, gunY: 0, gunZ: 0,
      });
      this._syncDevSliders();
      this._applyDevState();
    });

    document.addEventListener('keydown', (e) => {
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
      if (this.chatOpen) return;
      if (e.code === 'F9') {
        e.preventDefault();
        this._devMode = !this._devMode;
        panel.style.display = this._devMode ? 'block' : 'none';
        if (this._devMode && document.pointerLockElement) document.exitPointerLock();
      }
    });
  }

  _applyDevState() {
    const s = this._devState;
    if (this.fpsArms) {
      this.fpsArms.position.set(s.armsX, s.armsY, s.armsZ);
      this.fpsArms.rotation.y = s.armsRotY;
      this.fpsArms.scale.setScalar(s.armsScale);
    }
    this._gunDevOffset.set(s.gunX, s.gunY, s.gunZ);
  }

  // Reflect current _devState values back into both the slider and the
  // number-input DOM nodes so the UI stays consistent with anything that
  // mutates _devState programmatically (e.g. the auto-align init pass
  // setting the post-shift position, or the RESET button).
  _syncDevSliders() {
    if (!this._devPanel) return;
    this._devPanel.querySelectorAll('input[data-key]').forEach((inp) => {
      const k = inp.dataset.key;
      if (this._devState[k] != null) inp.value = this._devState[k];
    });
  }

  _updateDevPanel() { /* sliders update themselves, nothing to do per-frame */ }

  // Kick off the knife stab animation. Uses crossFadeFrom on the running
  // reload (neutral grip) action so the arms MORPH into the stab pose
  // instead of teleporting into it — the "hand from nowhere" complaint.
  _triggerFpsStab() {
    const stab = this.fpsArmsActions?.stabbing;
    const reload = this.fpsArmsActions?.reloading;
    if (!stab) return;
    const clip = stab.getClip();
    if (!clip) return;
    stab.reset();
    stab.setLoop(THREE.LoopOnce, 1);
    stab.clampWhenFinished = true;
    stab.timeScale = 1.0;
    stab.enabled = true;
    stab.setEffectiveTimeScale(1);
    stab.setEffectiveWeight(1);
    stab.play();
    // crossFadeFrom: smoothly blend from the neutral reload into the stab
    if (reload && reload.isRunning && reload.isRunning()) {
      stab.crossFadeFrom(reload, 0.12, true);
    }
    this._fpsArmsStabActive = true;
    this._fpsArmsStabTimer = clip.duration / Math.max(0.1, stab.timeScale);
  }

  setupInput() {
    const chatInput = document.getElementById('chat-input');
    const chatWrap = document.getElementById('chat-input-wrap');

    document.addEventListener('keydown', (e) => {
      if (this.dead) return;
      // Don't intercept keys until the game is actually running — start screen
      // still has its own Enter handler for the START button.
      if (!this.game.running && !this.chatOpen) return;
      // If the chat input is open, only handle Enter/Escape here. Letter keys
      // go straight into the input field (browser handles since input is
      // focused).
      if (this.chatOpen) {
        if (e.code === 'Enter') {
          e.preventDefault();
          const text = (chatInput && chatInput.value || '').trim();
          if (text) {
            // Tag the player message and push to global chat
            if (this.game.addChatMessage) this.game.addChatMessage(this, text);
            if (this.game.sfx && this.game.sfx.chatSend) this.game.sfx.chatSend();
            // Multiplayer: relay to peer so dad sees the message too
            if (this.game.multiplayer && this.game.multiplayer.connected) {
              this.game.multiplayer.sendEvent({ kind: 'chat', text });
            }
          }
          this.closeChat();
        } else if (e.code === 'Escape') {
          e.preventDefault();
          this.closeChat();
        }
        // Stop propagation so the document-level Y/B/etc handlers below never see
        // letter keys while typing.
        e.stopPropagation();
        return;
      }
      this.keys[e.code] = true;
      if (e.code === 'Digit1') this.switchWeapon(this.loadout[0]);
      if (e.code === 'Digit2') this.switchWeapon(this.loadout[1]);
      if (e.code === 'Digit3') this.switchWeapon(this.loadout[2]);
      if (e.code === 'KeyR') this.reload();
      if (e.code === 'F2') {
        // Screenshot — saves a PNG of the current canvas.
        e.preventDefault();
        const canvas = this.game.renderer?.domElement;
        if (canvas) {
          canvas.toBlob((blob) => {
            if (!blob) return;
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `spudshockers_${Date.now()}.png`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
          }, 'image/png');
        }
      }
      if (e.code === 'KeyB') this.game.toggleShop();
      if (e.code === 'KeyP') this.toggleSentry();
      if (e.code === 'KeyT') this.triggerSpecial();
      if (e.code === 'KeyC') this.trySlide();
      if (e.code === 'KeyF') this.toggleLockTarget();
      if (e.code === 'KeyY' || e.code === 'Enter') {
        e.preventDefault();
        this.openChat();
      }
    });
    document.addEventListener('keyup', (e) => {
      if (this.chatOpen) return;
      this.keys[e.code] = false;
    });
    document.addEventListener('mousedown', (e) => {
      if (this.chatOpen) return;
      if (!document.pointerLockElement) return;
      if (e.button === 0) this.mouseDown = true;
      if (e.button === 2) {
        // Knife repurposes right-click as a short speed dash buff instead of ADS
        if (this.currentWeapon === 'knife') {
          this._triggerKnifeDash();
        } else {
          this.ads = true;
        }
      }
    });
    document.addEventListener('mouseup', (e) => {
      if (this.chatOpen) return;
      if (e.button === 0) this.mouseDown = false;
      if (e.button === 2) this.ads = false;
    });
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('mousemove', (e) => {
      if (this.chatOpen) return;
      if (document.pointerLockElement) {
        const sens = this.ads ? 0.0011 : 0.0022;
        this.yaw -= e.movementX * sens;
        this.pitch -= e.movementY * sens;
        this.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.pitch));
      }
    });
  }

  openChat() {
    if (this.chatOpen || this.dead || this.game.matchOver) return;
    if (this.game.shop && this.game.shop.isOpen()) return;
    if (!this.game.running) return;
    const wrap = document.getElementById('chat-input-wrap');
    const input = document.getElementById('chat-input');
    if (!wrap || !input) return;
    this.chatOpen = true;
    // Release every held key so the player doesn't keep walking while typing
    this.keys = {};
    this.mouseDown = false;
    this.ads = false;
    const wasLocked = document.pointerLockElement === this.game.canvas;
    if (wasLocked && document.exitPointerLock) document.exitPointerLock();
    wrap.classList.add('open');
    input.value = '';
    // Focus the input reliably. Pointer-lock release is async, so a single
    // setTimeout(0) sometimes lands before the browser releases focus from the
    // canvas. We re-try across several frames + listen for pointerlockchange.
    const tryFocus = () => {
      input.focus();
      if (document.activeElement !== input) {
        // Click the input as a fallback to force focus on quirky browsers
        try { input.click(); input.focus(); } catch (_) {}
      }
    };
    requestAnimationFrame(tryFocus);
    setTimeout(tryFocus, 30);
    setTimeout(tryFocus, 120);
    const onLockChange = () => {
      tryFocus();
      document.removeEventListener('pointerlockchange', onLockChange);
    };
    if (wasLocked) document.addEventListener('pointerlockchange', onLockChange);
    if (this.game.sfx && this.game.sfx.chatOpen) this.game.sfx.chatOpen();
  }

  closeChat() {
    const wrap = document.getElementById('chat-input-wrap');
    const input = document.getElementById('chat-input');
    if (wrap) wrap.classList.remove('open');
    if (input) input.value = '';
    this.chatOpen = false;
    // Re-engage pointer lock so the player can play again
    if (this.game && this.game.canvas && !this.game.matchOver && !this.dead) {
      setTimeout(() => {
        try { this.game.canvas.requestPointerLock(); } catch (_) {}
      }, 0);
    }
  }

  // F key: pick the best enemy in front of crosshair as the soft-lock target.
  // Pressing F again or after the target dies releases the lock.
  toggleLockTarget() {
    if (this.lockedTarget) {
      this.lockedTarget = null;
      this.game.lockTarget = null;
      if (this.game.sfx && this.game.sfx.lockOff) this.game.sfx.lockOff();
      return;
    }
    const aim = new THREE.Vector3(
      -Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * Math.cos(this.pitch),
    );
    let best = null, bestScore = Infinity;
    for (const b of this.game.bots) {
      if (b.dead || b.team === this.team) continue;
      const to = new THREE.Vector3().subVectors(b.position, this.position);
      const dist = to.length();
      if (dist > 90 || dist < 1) continue;
      to.normalize();
      const dot = to.dot(aim);
      if (dot < 0.86) continue; // ~30° cone in front
      // Prefer closer + better-centered targets
      const score = dist * (1 - (dot - 0.86) * 4);
      if (score < bestScore) { bestScore = score; best = b; }
    }
    if (best) {
      this.lockedTarget = best;
      this.game.lockTarget = best;
      if (this.game.sfx && this.game.sfx.lockOn) this.game.sfx.lockOn();
    } else {
      if (this.game.sfx && this.game.sfx.lockOff) this.game.sfx.lockOff();
    }
  }

  // Reassign team mid-game (used when joining multiplayer). Updates color-tinted
  // body parts and respawns at one of the new team's spawn points.
  setTeam(newTeam) {
    if (newTeam !== 'mash' && newTeam !== 'russet') return;
    this.team = newTeam;
    const col = TEAM_COLORS[newTeam] || 0xc23a3a;
    if (this.bodyHat && this.bodyHat.material) this.bodyHat.material.color.setHex(col);
    if (this.bodyCape && this.bodyCape.material) this.bodyCape.material.color.setHex(col);
    this.yaw = newTeam === 'mash' ? 0 : Math.PI;
    const spawns = this.game.arena.teamSpawns[newTeam];
    if (spawns && spawns.length) {
      const sp = spawns[Math.floor(Math.random() * spawns.length)];
      this.position.set(sp.x, sp.y + 1.6 - 0.85, sp.z);
    }
    this.velocity.set(0, 0, 0);
  }

  setLoadout(name) {
    if (!WEAPONS[name]) return;
    this.loadoutWeapon = name;
    this.loadout = [name, 'spudgun', 'knife'];
  }

  makeMatchStats() {
    return {
      shotsFired: 0,
      shotsHit: 0,
      headshots: 0,
      damageTaken: 0,
      multikills: 0,
      specialsUsed: 0,
      lootGrabbed: 0,
      killstreaksTriggered: 0,
      killsByWeapon: {},
    };
  }
  resetMatchStats() { this.matchStats = this.makeMatchStats(); }

  switchWeapon(name) {
    if (!WEAPONS[name] || name === this.currentWeapon) return;
    if (this.sentryActive) this.toggleSentry();
    if (this.reloading) { this.reloading = false; this.reloadTimer = 0; if (this.game?.sfx?.reloadSampleStop) this.game.sfx.reloadSampleStop(); }
    // Cancel any in-progress special so it doesn't carry over to the new weapon
    this.specialMod = null;
    this.specialQueue = null;
    this.hotBarrelTimer = 0;
    this.currentWeapon = name;
    if (!this.ammo[name]) {
      this.ammo[name] = { mag: WEAPONS[name].magSize, reserve: WEAPONS[name].reserve };
    }
    this.fireCooldown = 0.25;
    // Tint the procedural fallback so SOMETHING shows during the GLB load
    if (this.gunMesh && this.gunMesh.material) {
      this.gunMesh.material.color.setHex(WEAPONS[name].viewmodelColor);
    }
    this._swapGunModel(name);
  }

  // Kick off the muzzle-flash / smoke / point-light burst. Called from every
  // path that sets muzzleKick=1 (normal fire, burst, melee). For melee we
  // start the knife-slash arc instead of the flash so a swung knife doesn't
  // emit a gunshot light.
  _triggerMuzzleFx(isMelee) {
    if (isMelee) {
      this._knifeSwing = 1;
      this._triggerFpsStab();
      return;
    }
    this._flashTimer = 0.06;
    this._smokeTimer = 0.5;
    this._smokeOffsetY = 0;
    this._smokeOffsetZ = 0;
    if (this.muzzleLight) this.muzzleLight.intensity = 4;
    // Random roll on the flash plane so consecutive shots don't look identical
    if (this.muzzleFlash) this.muzzleFlash.rotation.z = Math.random() * Math.PI * 2;
  }

  // Mount the loaded GLB for `weaponKey` onto `gunHolder`, and reposition the
  // muzzle-flash stack to the per-weapon barrel-tip offset. If the GLB isn't
  // ready yet, kick off a load and retry once it resolves — the procedural
  // fallback box stays visible in the meantime so the player isn't holding
  // nothing.
  _swapGunModel(weaponKey) {
    const cfg = GUN_TUNING[weaponKey];
    if (!cfg) return;
    // Drop whatever was mounted before
    if (this.activeGunModel) {
      this.gunHolder.remove(this.activeGunModel);
      this.activeGunModel.traverse((o) => {
        if (o.isMesh) {
          if (o.geometry) o.geometry.dispose && o.geometry.dispose();
          if (o.material) o.material.dispose && o.material.dispose();
        }
      });
      this.activeGunModel = null;
    }
    if (!gunIsLoaded(weaponKey)) {
      // Not ready — show the fallback box, async-load, retry on settle.
      if (this.gunMesh) this.gunMesh.visible = true;
      loadGun(weaponKey).then(() => {
        // Guard: weapon may have changed by the time the GLB resolves
        if (this.currentWeapon === weaponKey) this._swapGunModel(weaponKey);
      }).catch(() => {});
      return;
    }
    const model = getGunModel(weaponKey);
    if (!model) return;
    this.gunHolder.add(model);
    this.activeGunModel = model;
    if (this.gunMesh) this.gunMesh.visible = false;
    // If the GLB ships embedded animations (e.g. the sniper has a real reload
    // animation), build an AnimationMixer rooted at the cloned scene so we
    // can play those clips later. We pick the first clip that names "reload"
    // (case-insensitive) and fall back to the first available clip.
    this.gunMixer = null;
    this.gunReloadAction = null;
    const animRoot = model.userData?.animRoot;
    const clips = model.userData?.animations || [];
    if (animRoot && clips.length > 0) {
      this.gunMixer = new THREE.AnimationMixer(animRoot);
      const reloadClip = clips.find((c) => /reload/i.test(c.name || '')) || clips[0];
      if (reloadClip) {
        this.gunReloadAction = this.gunMixer.clipAction(reloadClip);
        this.gunReloadAction.setLoop(THREE.LoopOnce);
        this.gunReloadAction.clampWhenFinished = true;
      }
    }
    // Move muzzle-flash stack to the barrel tip in gunHolder-local space.
    // The `muzzleOffset` is authored in WORLD-scale (camera) coords, so it
    // sits at the actual tip regardless of the GLB's internal scale.
    const [mx, my, mz] = cfg.muzzleOffset;
    if (this.muzzleFlash) this.muzzleFlash.position.set(mx, my, mz);
    if (this.muzzleLight) this.muzzleLight.position.set(mx, my, mz);
    if (this.muzzleSmoke) this.muzzleSmoke.position.set(mx, my, mz);
  }

  _triggerKnifeDash() {
    if (this.dead || this._knifeDashCooldown > 0) return;
    // 1.7× move speed for 1.5s; reuses the existing speed-buff plumbing
    this.buffs.speed = { mult: 1.7, timer: 1.5 };
    this._knifeDashCooldown = 4;
    if (this.game.sfx?.special) this.game.sfx.special();
  }

  // Called when player presses R with no reserve ammo. Drops a single
  // emergency ammo crate near them once per life so reload-button-mashing
  // never leads to a dead end. Resets to false on respawn.
  _requestEmergencyAmmo() {
    if (this._emergencyAmmoUsed) {
      if (this.game?.hud?.addPickupMessage) {
        this.game.hud.addPickupMessage('NO AMMO — find a crate');
      }
      if (this.game?.sfx?.lowAmmo) this.game.sfx.lowAmmo();
      return;
    }
    this._emergencyAmmoUsed = true;
    if (this.game?.spawnEmergencyAmmoCrate) {
      this.game.spawnEmergencyAmmoCrate(this);
    }
  }

  trySlide() {
    if (this.slideCooldown > 0 || this.slideTimer > 0 || this.dead) return;
    if (!this.onGround) return;
    const sprinting = (this.keys.ShiftLeft || this.keys.ShiftRight) && !this.ads && !this.sentryActive;
    if (!sprinting) return;
    // Slide direction is the current move input; fall back to facing dir if idle
    const forward = -Math.sin(this.yaw);
    const forwardZ = -Math.cos(this.yaw);
    const right = Math.cos(this.yaw);
    const rightZ = -Math.sin(this.yaw);
    let dx = 0, dz = 0;
    if (this.keys.KeyW) { dx += forward; dz += forwardZ; }
    if (this.keys.KeyS) { dx -= forward; dz -= forwardZ; }
    if (this.keys.KeyD) { dx += right;   dz += rightZ; }
    if (this.keys.KeyA) { dx -= right;   dz -= rightZ; }
    if (dx === 0 && dz === 0) { dx = forward; dz = forwardZ; }
    const m = Math.hypot(dx, dz) || 1;
    this.slideDirX = dx / m;
    this.slideDirZ = dz / m;
    this.slideTimer = 0.65;
    // Slope tracking — used to extend slide time and add a speed kicker when
    // the player descends elevation mid-slide (ramps, stairs, mega-hill cliffs).
    this._slideStartY = this.position.y;
    this._prevSlideY = this.position.y;
    if (this.game.sfx.special) this.game.sfx.special();
  }

  triggerSpecial() {
    const w = WEAPONS[this.currentWeapon];
    if (!w.special) return;
    if ((this.specialCooldowns[this.currentWeapon] || 0) > 0) return;
    if (this.reloading) return;
    if (this.specialQueue) return; // already mid-burst
    const a = this.ammo[this.currentWeapon];
    const sp = w.special;
    if (this.matchStats) this.matchStats.specialsUsed++;
    if (this.game.progressChallenge) this.game.progressChallenge('specials', 1);

    if (sp.kind === 'burst') {
      if (!a.mag) return;
      const shots = Math.min(sp.shots, a.mag);
      this.specialQueue = { remaining: shots, gap: sp.gap, timer: 0, spread: sp.spread };
    } else if (sp.kind === 'slug') {
      if (!a.mag) return;
      this.specialMod = { type: 'slug', damage: sp.damage, projectileSize: sp.projectileSize };
    } else if (sp.kind === 'hotBarrel') {
      this.hotBarrelTimer = sp.duration;
    } else if (sp.kind === 'steady') {
      if (!a.mag) return;
      this.specialMod = { type: 'steady' };
    } else if (sp.kind === 'fan') {
      if (!a.mag) return;
      this.specialMod = { type: 'fan', count: sp.count, spread: sp.spread };
    } else {
      return;
    }
    this.specialCooldowns[this.currentWeapon] = sp.cooldown;
    this.game.hud.addPickupMessage(`${sp.name}!`);
    this.game.sfx.special();
  }

  toggleSentry() {
    if (this.currentWeapon !== 'spudling') return;
    const w = WEAPONS.spudling;
    const a = this.ammo.spudling;
    if (this.sentryActive) {
      this.sentryActive = false;
      this.sentryCooldown = 15;
      a.mag = Math.min(a.mag, w.magSize);
      this.sentryBase.visible = false;
    } else {
      if (this.sentryCooldown > 0) return;
      this.sentryActive = true;
      a.mag = w.magSize * 2; // 2x mag, can't reload while planted
      if (this.reloading) { this.reloading = false; this.reloadTimer = 0; if (this.game?.sfx?.reloadSampleStop) this.game.sfx.reloadSampleStop(); }
      this.sentryBase.visible = true;
    }
  }

  reload() {
    if (this.sentryActive) return; // no reloads while planted
    const w = WEAPONS[this.currentWeapon];
    const a = this.ammo[this.currentWeapon];
    if (w.melee) return;
    if (this.reloading || a.mag === w.magSize) return;
    if (a.reserve === 0) {
      // Out of reserve — call in an emergency ammo crate the first time per
      // life so you're never stuck pressing R with nothing happening.
      this._requestEmergencyAmmo();
      return;
    }
    this.reloading = true;
    const reloadMult = this.buffs.reload?.mult ?? 1;
    const ksReloadMult = this.game.killstreakEffects?.reloadBoost?.mult ?? 1;
    const frenzy = this.game.frenzy;
    if (frenzy && frenzy.id === 'instaReload') {
      // Frenzy: instant reload — bypass timer entirely
      const need = w.magSize - a.mag;
      const give = Math.min(need, a.reserve);
      a.mag += give;
      a.reserve -= give;
      this.reloading = false;
      this.reloadTimer = 0;
      return;
    }
    this.reloadTimer = w.reloadTime * reloadMult * ksReloadMult;
    // Reload animation runs across this same duration (see updateViewmodel).
    this._reloadTotal = this.reloadTimer;
    // Play the reload sample stretched to match the actual reload duration.
    if (this.game.sfx && this.game.sfx.reloadSample) {
      this.game.sfx.reloadSample(this.reloadTimer);
    }
    // If this weapon uses an embedded keyframed reload animation (e.g. the
    // CC-BY sniper), play it via the AnimationMixer scaled to fit the
    // configured reload duration.
    const cfg = GUN_TUNING[this.currentWeapon];
    if (cfg?.useEmbeddedReload && this.gunMixer && this.gunReloadAction) {
      const clip = this.gunReloadAction.getClip();
      this.gunReloadAction.reset();
      this.gunReloadAction.timeScale = clip.duration / Math.max(0.1, this.reloadTimer);
      this.gunReloadAction.play();
    }
  }

  tickBuffs(dt) {
    for (const k of Object.keys(this.buffs)) {
      const b = this.buffs[k];
      if (b.timer != null) {
        b.timer -= dt;
        if (b.timer <= 0) delete this.buffs[k];
      }
    }
  }

  applyBuff(type, opts) {
    if (type === 'speed')      this.buffs.speed = { mult: opts.mult, timer: opts.duration };
    if (type === 'reload')     this.buffs.reload = { mult: opts.mult, timer: opts.duration };
    if (type === 'damage')     this.buffs.damage = { mult: opts.mult, timer: opts.duration };
    if (type === 'multishot')  this.buffs.multishot = { add: opts.add, timer: opts.duration };
    if (type === 'health') {
      this.maxHealth = this.baseMaxHealth + opts.add;
      this.health = this.maxHealth;
    }
    if (type === 'ammo') {
      const cur = this.currentWeapon;
      const w = WEAPONS[cur];
      this.ammo[cur].reserve = Math.max(this.ammo[cur].reserve, w.reserve);
      this.ammo[cur].mag = w.magSize;
      if (this.reloading) { this.reloading = false; this.reloadTimer = 0; if (this.game?.sfx?.reloadSampleStop) this.game.sfx.reloadSampleStop(); }
    }
  }

  awardKill(victim) {
    this.kills++;
    this.streak = (this.streak || 0) + 1;
    if (this.streak > (this.bestStreak || 0)) this.bestStreak = this.streak;
    const now = performance.now() / 1000;
    if (now - (this.lastKillTime || 0) < 3.0) this.multiKill = (this.multiKill || 1) + 1;
    else this.multiKill = 1;
    this.lastKillTime = now;
    if (this.matchStats) {
      this.matchStats.killsByWeapon[this.currentWeapon] = (this.matchStats.killsByWeapon[this.currentWeapon] || 0) + 1;
    }
    if (this.game.bumpMastery) this.game.bumpMastery(this.currentWeapon, 1);
    if (this.game.progressChallenge) {
      this.game.progressChallenge('kills', 1);
      this.game.progressChallenge('weapon', 1, { weapon: this.currentWeapon });
      this.game.progressChallenge('streak', this.streak, { absolute: true });
      // New: air-kill (kill while airborne) + longshot (kill from 25m+)
      if (!this.onGround) this.game.progressChallenge('air_kills', 1);
      if (victim && victim.position) {
        const d = this.position.distanceTo(victim.position);
        if (d >= 25) this.game.progressChallenge('longshot', 1);
      }
    }

    let bonus = 12;
    let xpEarned = 10;
    let banner = null, bannerColor = '#ffce5e', bannerLevel = 1;

    // Streak (consecutive without dying) — coin bonus, lower-priority banner
    let streakBanner = null, streakColor = '#ffce5e', streakLevel = this.streak;
    if (this.streak === 2)                                  streakBanner = 'DOUBLE MASH';
    else if (this.streak === 3) { bonus += 5;  streakBanner = 'TRIPLE MASH  +5¢';   streakColor = '#ff8a3c'; }
    else if (this.streak === 5) { bonus += 10; streakBanner = 'MASH FRENZY  +10¢';  streakColor = '#ff5e3a'; }
    else if (this.streak === 7) { bonus += 15; streakBanner = 'DOMINATING  +15¢';   streakColor = '#c45eff'; }
    else if (this.streak >= 10 && this.streak % 2 === 0) { bonus += 25; streakBanner = `UNSTOPPABLE x${this.streak}  +25¢`; streakColor = '#5effb8'; }

    // Multi-kill (rapid succession) — higher-priority banner
    if (this.multiKill === 2)      { bonus += 8;  banner = 'DOUBLE KILL  +8¢';   bannerColor = '#ffce5e'; bannerLevel = 2; }
    else if (this.multiKill === 3) { bonus += 15; banner = 'TRIPLE KILL  +15¢';  bannerColor = '#ff8a3c'; bannerLevel = 3; }
    else if (this.multiKill === 4) { bonus += 25; banner = 'QUAD KILL  +25¢';    bannerColor = '#ff5e3a'; bannerLevel = 4; }
    else if (this.multiKill >= 5)  { bonus += 40; banner = `${this.multiKill}× OVERKILL  +40¢`; bannerColor = '#5effb8'; bannerLevel = 5; this.game.triggerSlowMo(0.32, 0.55); }
    if (this.multiKill === 2) {
      if (this.matchStats) this.matchStats.multikills++;
      if (this.game.progressChallenge) this.game.progressChallenge('multikills', 1);
    }

    // Bounty kill — top-killing bot
    if (this.game.bountyTarget && victim === this.game.bountyTarget) {
      bonus += 30;
      xpEarned += 15;
      banner = 'BOUNTY CLAIMED  +30¢';
      bannerColor = '#ffd700';
      bannerLevel = 4;
      this.game.bountyTarget = null;
      if (victim.bountyCrown) victim.bountyCrown.visible = false;
    }

    // Revenge — kill your last killer within 10 seconds of dying to them
    if (this.lastKiller && this.lastKiller.ref === victim) {
      const elapsed = performance.now() / 1000 - this.lastKiller.time;
      if (elapsed < 10) {
        bonus += 15;
        xpEarned += 5;
        banner = 'REVENGE!  +15¢';
        bannerColor = '#ff5e3a';
        bannerLevel = 3;
      }
      this.lastKiller = null;
    }

    // First blood is now awarded centrally by game._maybeFirstBlood() the
    // moment ANY kill is credited (bot, dad, or local). The coin/XP bonus is
    // applied directly to the player there; nothing to do here.

    // Frenzy multipliers
    const fr = this.game.frenzy;
    if (fr) {
      if (fr.id === 'doubleCoin') bonus *= 2;
      if (fr.id === 'doubleXp')   xpEarned *= 2;
      if (fr.id === 'overheal')   this.health = Math.min(this.maxHealth + 30, this.health + 30);
    }

    this.coins += bonus;
    this.sessionXp = (this.sessionXp || 0) + xpEarned;
    // Include the bot's combat archetype so the player can read who they
     // beat ("a SNIPER", "a RUSHER", etc.) — small flavor + intel cue.
    const arch = victim?.archetype ? victim.archetype.toUpperCase() : null;
    const victimLabel = arch ? `${victim.name || 'a spud'} (${arch})` : (victim.name || 'a spud');
    this.game.hud.addKillMessage(`You mashed ${victimLabel}  +${bonus}¢`);
    // Killstreak rewards check (after streak/multikill bookkeeping is done)
    if (this.game.triggerKillstreaks) this.game.triggerKillstreaks(this);
    if (banner) this.game.announceStreak(banner, bannerColor, bannerLevel);
    else if (streakBanner) this.game.announceStreak(streakBanner, streakColor, streakLevel);
    if (victim && victim.position) {
      this.game.spawnDamageNumber(victim.position, bonus, 'coin');
      this.game.spawnDamageNumber(victim.position, xpEarned, 'xp');
    }
    this.game.sfx.kill();
    // Distinct kill-confirmed ding so the player gets a clear audio reward
    // separate from the visceral "kill" splash sample.
    if (this.game.sfx.killConfirm) this.game.sfx.killConfirm();
  }

  update(dt) {
    if (this.dead) {
      this.game.camera.position.copy(this.position);
      return;
    }

    // Drop the lock if the target died or switched teams (shouldn't happen, but
    // keeps the HUD honest).
    if (this.lockedTarget && (this.lockedTarget.dead || this.lockedTarget.team === this.team)) {
      this.lockedTarget = null;
      this.game.lockTarget = null;
    }

    const w = WEAPONS[this.currentWeapon];
    const adsTarget = this.ads ? 1 : 0;
    // Per-weapon ADS lerp rate (defined in ADS_POSES). Heavy guns lerp slower
    // for that weighty feel, light guns snap to ADS.
    const adsPose = ADS_POSES[this.currentWeapon];
    const adsRate = adsPose?.rate ?? 12;
    this.adsAmount += (adsTarget - this.adsAmount) * Math.min(1, dt * adsRate);

    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const move = new THREE.Vector3();
    if (this.keys.KeyW) move.add(forward);
    if (this.keys.KeyS) move.sub(forward);
    if (this.keys.KeyD) move.add(right);
    if (this.keys.KeyA) move.sub(right);
    if (move.lengthSq() > 0) move.normalize();

    const sprinting = (this.keys.ShiftLeft || this.keys.ShiftRight) && !this.ads && !this.sentryActive;
    let speedMult = 1;
    if (sprinting) speedMult = SPRINT_MULT;
    if (this.game.frenzy?.id === 'speedDemon') speedMult *= 1.35;
    // Per-weapon hipfire speed: lighter guns (knife/pistol/SMG) move faster,
    // heavier ones (sniper/grenade-launcher) slower. ADS layers `zoomMoveMult`
    // on top.
    speedMult *= w.moveSpeedMult ?? 1.0;
    if (this.ads) speedMult *= w.zoomMoveMult ?? 0.6;
    if (this.buffs.speed) speedMult *= this.buffs.speed.mult;
    if (this.game.killstreakEffects?.speedBoost) speedMult *= this.game.killstreakEffects.speedBoost.mult;
    // Kill-aura passive buff: +12% speed once the player has 5+ kills this match
    if (this.auraActive) speedMult *= 1.12;
    if (this.sentryActive) speedMult = 0; // sentry mode = locked in place
    if (this.sentryCooldown > 0) this.sentryCooldown = Math.max(0, this.sentryCooldown - dt);
    if (this.hotBarrelTimer > 0) this.hotBarrelTimer = Math.max(0, this.hotBarrelTimer - dt);
    for (const k in this.specialCooldowns) {
      if (this.specialCooldowns[k] > 0) {
        this.specialCooldowns[k] = Math.max(0, this.specialCooldowns[k] - dt);
      }
    }
    const speed = SPEED * speedMult;
    this.velocity.x = move.x * speed;
    this.velocity.z = move.z * speed;
    if (this._knifeDashCooldown > 0) this._knifeDashCooldown = Math.max(0, this._knifeDashCooldown - dt);
    // Slide override — slick floor effect with light steering. Slide-hop (jump
    // mid-slide) gives a boosted vertical kick + shorter cooldown.
    if (this.slideCooldown > 0) this.slideCooldown = Math.max(0, this.slideCooldown - dt);
    if (this.slideTimer > 0) {
      this.slideTimer -= dt;
      // Slope: descending frames refund slide time so going down a ramp keeps
      // momentum instead of decaying out before you reach the bottom.
      if (this._prevSlideY != null && this._prevSlideY - this.position.y > 0.04) {
        this.slideTimer += dt * 0.8;
      }
      this._prevSlideY = this.position.y;

      // Speed decays smoothly from 2.4x at start to ~1.0x at end
      const t = Math.max(0, Math.min(1, 1 - this.slideTimer / 0.65));
      let speedFactor = 2.4 - t * 1.4;
      // Speed kicker proportional to total elevation dropped since slide start
      const drop = (this._slideStartY ?? this.position.y) - this.position.y;
      if (drop > 0.2) speedFactor = Math.min(3.5, speedFactor + drop * 0.22);

      // Allow small steering input so it's not totally rails
      let sx = this.slideDirX + move.x * 0.18;
      let sz = this.slideDirZ + move.z * 0.18;
      const sm = Math.hypot(sx, sz) || 1;
      this.slideDirX = sx / sm; this.slideDirZ = sz / sm;
      this.velocity.x = this.slideDirX * SPEED * speedFactor;
      this.velocity.z = this.slideDirZ * SPEED * speedFactor;
      // Slide-hop: pressing Space while sliding ends the slide with a boosted jump
      if (this.keys.Space && this.onGround) {
        this.velocity.y = JUMP_VEL * 1.12;
        this.onGround = false;
        this.slideTimer = 0;
        this.slideCooldown = 0.6;
      } else if (this.slideTimer <= 0) {
        this.slideCooldown = 1.5;
      }
    }

    // Ladder check — overlapping a ladder zone disables gravity and lets W/S
    // climb up/down. We attach when the foot is between the ground and just
    // above the ladder top so the player can step onto the platform.
    let onLadder = false;
    const foot = this.position.y - EYE_HEIGHT;
    for (const lad of this.game.arena.ladders || []) {
      if (Math.abs(this.position.x - lad.x) < lad.w / 2 + PLAYER_RADIUS &&
          Math.abs(this.position.z - lad.z) < lad.d / 2 + PLAYER_RADIUS &&
          foot >= -0.2 && foot <= lad.top + 0.5) {
        onLadder = true;
        break;
      }
    }

    if (onLadder) {
      const climbSpeed = 3.0;
      if (this.keys.KeyW)      this.velocity.y = climbSpeed;
      else if (this.keys.KeyS) this.velocity.y = -climbSpeed;
      else if (this.keys.Space) this.velocity.y = climbSpeed;
      else                      this.velocity.y = 0;
    } else {
      if (this.keys.Space && this.onGround) {
        this.velocity.y = JUMP_VEL * (this.game.frenzy?.id === 'lowGrav' ? 1.35 : 1);
        this.onGround = false;
      }
      const gravMult = this.game.frenzy?.id === 'lowGrav' ? 0.45 : 1;
      this.velocity.y -= GRAVITY * gravMult * dt;
    }

    // XZ movement with collision + auto-step. Sub-step when displacement is
    // larger than ~0.4m so we never tunnel through thin walls at high speed.
    const stepAxis = (axis, dispTotal) => {
      const steps = Math.max(1, Math.ceil(Math.abs(dispTotal) / 0.4));
      const inc = dispTotal / steps;
      for (let i = 0; i < steps; i++) {
        if (axis === 'x') this.position.x += inc;
        else this.position.z += inc;
        this.resolveCollisionsXZ(axis);
      }
    };
    stepAxis('x', this.velocity.x * dt);
    stepAxis('z', this.velocity.z * dt);

    // Y movement with vertical collision (floors / ceilings)
    this.position.y += this.velocity.y * dt;
    this.resolveCollisionsY();

    // arena bounds
    const B = this.game.arena.bounds;
    this.position.x = Math.max(-B + PLAYER_RADIUS, Math.min(B - PLAYER_RADIUS, this.position.x));
    this.position.z = Math.max(-B + PLAYER_RADIUS, Math.min(B - PLAYER_RADIUS, this.position.z));

    // health regen
    this.timeSinceDamage += dt;
    if (this.timeSinceDamage > REGEN_DELAY && this.health < this.maxHealth) {
      this.health = Math.min(this.maxHealth, this.health + REGEN_RATE * dt);
    }

    // Low-HP heartbeat overlay/sound — engages under 25% of max
    this.game.setLowHp(this.health > 0 && this.health < this.maxHealth * 0.25);

    this.tickBuffs(dt);

    if (this.spawnInvuln > 0) this.spawnInvuln -= dt;

    // recoil decay (springs back to zero)
    const recoilRecover = (w.recoilRecover ?? 5);
    const k = Math.min(1, dt * recoilRecover);
    this.recoilPitch -= this.recoilPitch * k;
    this.recoilYaw -= this.recoilYaw * k;

    // weapon timing
    this.fireCooldown -= dt;
    this.muzzleKick = Math.max(0, this.muzzleKick - dt * 6);
    // Crosshair kick — fast decay so it pops & snaps back
    this.crosshairKick = Math.max(0, (this.crosshairKick || 0) - dt * 6.5);

    // FPS arms — lazy retry init (cheap until success), then a tiny state
    // machine: stab overlay > reload anim > neutral grip pose (frame 0 of
    // the reload clip, paused).
    if (!this.fpsArms) this._tryInitFpsArms();
    if (this.fpsArmsActions) {
      const reloadAct = this.fpsArmsActions.reloading;
      const stabAct = this.fpsArmsActions.stabbing;
      if (this._fpsArmsStabActive) {
        this._fpsArmsStabTimer -= dt;
        if (this._fpsArmsStabTimer <= 0) {
          this._fpsArmsStabActive = false;
          // Snap the neutral reload action back to frame 0, paused, then
          // cross-fade FROM the stab so we morph back to the grip pose
          // rather than teleporting.
          if (reloadAct) {
            reloadAct.reset();
            reloadAct.setLoop(THREE.LoopOnce, 1);
            reloadAct.clampWhenFinished = true;
            reloadAct.timeScale = 0;
            reloadAct.setEffectiveWeight(1);
            reloadAct.enabled = true;
            reloadAct.play();
            if (stabAct) reloadAct.crossFadeFrom(stabAct, 0.15, true);
          } else if (stabAct) {
            stabAct.weight = 0;
          }
        }
      }
      if (reloadAct && !this._fpsArmsStabActive) {
        if (this.reloading && !this._fpsArmsReloadActive) {
          this._fpsArmsReloadActive = true;
          const targetSec = Math.max(0.2, this._reloadTotal || this.reloadTimer || 1);
          const clip = reloadAct.getClip();
          reloadAct.reset();
          reloadAct.weight = 1;
          reloadAct.timeScale = clip ? clip.duration / targetSec : 1;
          reloadAct.play();
        } else if (!this.reloading && this._fpsArmsReloadActive) {
          this._fpsArmsReloadActive = false;
          reloadAct.reset();
          reloadAct.timeScale = 0;
          reloadAct.play();
        }
      }
      if (this.fpsArmsMixer) this.fpsArmsMixer.update(dt);
    }

    if (this.reloading) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) {
        const a = this.ammo[this.currentWeapon];
        const need = w.magSize - a.mag;
        const give = Math.min(need, a.reserve);
        a.mag += give;
        a.reserve -= give;
        this.reloading = false;
      }
    } else if (this.specialQueue && this.fireCooldown <= 0) {
      // Auto-fire the queued burst (Quick Fire, Sizzle Burst) regardless of mouse state
      const a = this.ammo[this.currentWeapon];
      this.specialQueue.timer -= dt;
      if (this.specialQueue.timer <= 0 && a.mag > 0) {
        this.fire({ spread: this.specialQueue.spread });
        a.mag -= 1;
        this.specialQueue.remaining -= 1;
        this.specialQueue.timer = this.specialQueue.gap;
        this.muzzleKick = 1;
        this._triggerMuzzleFx(false);
        if (this.specialQueue.remaining <= 0 || a.mag === 0) {
          this.specialQueue = null;
          if (a.mag === 0 && a.reserve > 0 && !this.sentryActive) this.reload();
        }
      } else if (a.mag === 0) {
        this.specialQueue = null;
      }
    } else if (this.mouseDown && this.fireCooldown <= 0 && document.pointerLockElement) {
      const a = this.ammo[this.currentWeapon];
      if (w.melee) {
        this.meleeStrike();
        this.fireCooldown = w.fireRate;
        this.muzzleKick = 1;
        this._triggerMuzzleFx(true);
        this.mouseDown = false;
      } else if (a.mag > 0) {
        this.fire();
        a.mag -= 1;
        const sentryMult = this.sentryActive ? 0.25 : 1;
        const hotMult = this.hotBarrelTimer > 0 ? 0.5 : 1;
        const frenzyFireMult = this.game.frenzy?.id === 'fastFire' ? (1 / 1.5) : 1;
        this.fireCooldown = w.fireRate * sentryMult * hotMult * frenzyFireMult;
        this.muzzleKick = 1;
        this._triggerMuzzleFx(false);
        if (!w.auto) this.mouseDown = false;
        // Low-ammo tick: fires once when mag hits the 25% threshold.
        const lowThreshold = Math.max(1, Math.ceil(w.magSize * 0.25));
        if (a.mag === lowThreshold && this.game.sfx?.lowAmmo) this.game.sfx.lowAmmo();
        if (a.mag === 0 && a.reserve > 0 && !this.sentryActive) this.reload();
      } else if (a.reserve > 0 && !this.sentryActive) {
        this.reload();
      }
    }

    // FOV interpolation — slide widens FOV briefly for a "speed lines" feel.
    // Per-weapon `fovEase` exponent delays the FOV pull-in so the gun's pose
    // animation reads first; higher exponent = the zoom holds off longer.
    const slideFovBoost = this.slideTimer > 0 ? 8 : 0;
    const fovExp = adsPose?.fovEase ?? 1.0;
    const fovAmt = Math.pow(this.adsAmount, fovExp);
    const targetFOV = THREE.MathUtils.lerp(BASE_FOV + slideFovBoost, w.zoomFOV ?? BASE_FOV, fovAmt);
    if (Math.abs(this.game.camera.fov - targetFOV) > 0.05) {
      this.game.camera.fov = targetFOV;
      this.game.camera.updateProjectionMatrix();
    }

    // camera + viewmodel bob
    this.game.camera.position.copy(this.position);
    // Slide camera dip — lowers POV during a slide, springs back when done
    const slideDipTarget = this.slideTimer > 0 ? 0.7 : 0;
    this.slideEyeDip += (slideDipTarget - this.slideEyeDip) * Math.min(1, dt * 14);
    this.game.camera.position.y -= this.slideEyeDip;
    if (move.lengthSq() > 0 && this.onGround) {
      this.bobPhase += dt * (sprinting ? 14 : 9);
    }
    const bobAmt = 1 - this.adsAmount;
    const bobY = Math.sin(this.bobPhase) * 0.025 * bobAmt;
    const bobX = Math.cos(this.bobPhase * 0.5) * 0.015 * bobAmt;
    // Per-weapon kick scalar — bigger guns rock harder. Falls back to 1 so
    // weapons that haven't set kickAmt keep their old feel.
    const kickScale = 1 + (w.kickAmt || 0.1) * 2.2;
    // Per-weapon ADS pose (see ADS_POSES). Each gun gets a unique presentation
    // — pistol high-and-near, AR centered, shotgun braced into shoulder,
    // double-barrel cracked-up, SMG quick-snap, sniper eye-into-scope,
    // grenade launcher lifted-with-tilt.
    const adsTargetX = adsPose?.targetX ?? 0;
    const adsTargetY = adsPose?.targetY ?? -0.12;
    const adsTargetZ = adsPose?.targetZ ?? -0.25;
    let vmX = THREE.MathUtils.lerp(bobX, adsTargetX, this.adsAmount);
    let vmY = THREE.MathUtils.lerp(bobY - this.muzzleKick * 0.10 * kickScale, adsTargetY - this.muzzleKick * 0.05, this.adsAmount);
    let vmZ = THREE.MathUtils.lerp(-this.muzzleKick * 0.08 * kickScale, adsTargetZ, this.adsAmount);
    // Recoil rotation: gun tilts up and adds a tiny twist so it feels heavy.
    // ADS tilt is layered on top so the gun also tilts/yaws/rolls into pose.
    let vmRotX = -this.muzzleKick * 0.38 * kickScale + (adsPose?.tiltX ?? 0) * this.adsAmount;
    let vmRotY = (adsPose?.tiltY ?? 0) * this.adsAmount;
    let vmRotZ = Math.sin(this.muzzleKick * 6) * 0.05 * kickScale + (adsPose?.tiltZ ?? 0) * this.adsAmount;
    // Reload animation — for weapons with an embedded keyframed clip the
    // AnimationMixer handles everything; otherwise fall back to the
    // procedural per-weapon choreography + cartridge prop.
    const cfgRel = GUN_TUNING[this.currentWeapon];
    const useEmbedded = !!cfgRel?.useEmbeddedReload && this.gunMixer;
    if (useEmbedded) {
      // Drive the mixer regardless of `this.reloading` so any clamp-at-end
      // pose holds correctly. dt is passed in via the outer update loop.
      this.gunMixer.update(dt);
      this.reloadMag.visible = false;
    } else if (this.reloading && this._reloadTotal > 0) {
      const p = 1 - Math.max(0, this.reloadTimer / this._reloadTotal);
      const style = RELOAD_ANIMS[this.currentWeapon];
      if (style) {
        const d = style(Math.min(1, p));
        vmX += d.dx; vmY += d.dy; vmZ += d.dz;
        vmRotX += d.rx; vmRotY += d.ry; vmRotZ += d.rz;
        if (d.mag && d.mag.visible) {
          this.reloadMag.visible = true;
          this.reloadMag.position.set(d.mag.x, d.mag.y, d.mag.z);
        } else {
          this.reloadMag.visible = false;
        }
      } else {
        this.reloadMag.visible = false;
      }
    } else {
      if (this.reloadMag.visible) this.reloadMag.visible = false;
    }
    this.viewmodel.position.set(vmX, vmY, vmZ);
    this.gunMesh.position.x = THREE.MathUtils.lerp(0.32, 0.0, this.adsAmount);
    this.gunMesh.position.y = THREE.MathUtils.lerp(-0.28, -0.18, this.adsAmount);
    // Dev-mode gun offset — added on top of the existing per-frame writes so
    // ADS/recoil keep working. Stays at zero unless the user nudges it via F9.
    if (this._gunDevOffset) {
      this.gunMesh.position.x += this._gunDevOffset.x;
      this.gunMesh.position.y += this._gunDevOffset.y;
      this.gunMesh.position.z += this._gunDevOffset.z;
      if (this.gunHolder) {
        this.gunHolder.position.x += this._gunDevOffset.x;
        this.gunHolder.position.y += this._gunDevOffset.y;
        this.gunHolder.position.z += this._gunDevOffset.z;
      }
    }
    this.viewmodel.rotation.x = vmRotX;
    this.viewmodel.rotation.y = vmRotY;
    this.viewmodel.rotation.z = vmRotZ;
    this._updateDevPanel();
    this.viewmodel.visible = !(w.scope && this.adsAmount > 0.88);

    // --- Muzzle flash animation ---
    // Flash decays over its allotted time, scaling up as it fades for an
    // explosive "puff" feel. PointLight intensity tracks the same curve so
    // walls within ~6m get a single-frame lighting kick.
    if (this._flashTimer > 0) {
      this._flashTimer = Math.max(0, this._flashTimer - dt);
      const t = this._flashTimer / 0.06;          // 1 → 0
      const inv = 1 - t;
      if (this.muzzleFlash && this.muzzleFlash.material) {
        this.muzzleFlash.material.opacity = t * 0.95;
        const s = 0.7 + inv * 1.1;
        this.muzzleFlash.scale.set(s, s, s);
      }
      if (this.muzzleLight) this.muzzleLight.intensity = t * 4;
    } else {
      if (this.muzzleFlash && this.muzzleFlash.material) this.muzzleFlash.material.opacity = 0;
      if (this.muzzleLight) this.muzzleLight.intensity = 0;
    }
    // Smoke puff: drifts up + forward and fades over 0.5s
    if (this._smokeTimer > 0) {
      this._smokeTimer = Math.max(0, this._smokeTimer - dt);
      const t = this._smokeTimer / 0.5;            // 1 → 0
      const inv = 1 - t;
      this._smokeOffsetY += dt * 0.4;              // drift up
      this._smokeOffsetZ -= dt * 0.15;             // drift forward (camera looks -Z)
      if (this.muzzleSmoke && this.muzzleSmoke.material) {
        // Smoke sits at base muzzleOffset + drift; keep the X locked
        const base = (GUN_TUNING[this.currentWeapon] || {}).muzzleOffset || [0, 0, 0];
        this.muzzleSmoke.position.set(base[0], base[1] + this._smokeOffsetY, base[2] + this._smokeOffsetZ);
        this.muzzleSmoke.material.opacity = t * 0.5;
        const s = 0.8 + inv * 1.4;
        this.muzzleSmoke.scale.set(s, s, s);
      }
    } else if (this.muzzleSmoke && this.muzzleSmoke.material) {
      this.muzzleSmoke.material.opacity = 0;
    }

    // --- Knife slash arc ---
    // _knifeSwing runs from 1 → 0 over ~0.45s in three readable phases:
    //   0.00–0.25  wind-up: blade pulls up-and-back across the body
    //   0.25–0.55  strike:  blade snaps diagonally down-and-across the screen
    //   0.55–1.00  recovery: blade glides back to neutral
    // Pitch + yaw + roll + thrust are coordinated so the slash reads as a real
    // diagonal arc rather than a generic forward poke.
    if (this._knifeSwing > 0) {
      this._knifeSwing = Math.max(0, this._knifeSwing - dt * 2.2);
      if (this.currentWeapon === 'knife' && this.gunHolder) {
        const p = 1 - this._knifeSwing; // 0 → 1
        let pitch = 0, yaw = 0, roll = 0, thrustZ = 0, thrustX = 0, thrustY = 0;
        if (p < 0.25) {
          // Wind-up — ease in. Blade rises up-left, slight back-pull.
          const k = p / 0.25;
          const e = k * k;
          pitch = 0.55 * e;          // tip up
          yaw   = -0.40 * e;          // pull across to the left
          roll  = -0.25 * e;
          thrustZ = 0.06 * e;         // pull toward camera
          thrustX = -0.05 * e;
          thrustY = 0.04 * e;
        } else if (p < 0.55) {
          // Strike — fast accelerating sweep down-right past neutral.
          const k = (p - 0.25) / 0.30;
          const e = 1 - Math.pow(1 - k, 3); // ease-out cubic
          pitch = 0.55 + (-1.55) * e;     // sweep down past neutral
          yaw   = -0.40 + 0.85 * e;       // sweep across to the right
          roll  = -0.25 + 0.85 * e;       // rotate the blade through the cut
          thrustZ = 0.06 + (-0.32) * e;   // lunge forward
          thrustX = -0.05 + 0.10 * e;
          thrustY = 0.04 + (-0.10) * e;
        } else {
          // Recovery — ease back to neutral.
          const k = (p - 0.55) / 0.45;
          const e = 1 - Math.pow(1 - k, 2);
          pitch = -1.00 * (1 - e);
          yaw   =  0.45 * (1 - e);
          roll  =  0.60 * (1 - e);
          thrustZ = -0.26 * (1 - e);
          thrustX =  0.05 * (1 - e);
          thrustY = -0.06 * (1 - e);
        }
        this.gunHolder.rotation.x = pitch;
        this.gunHolder.rotation.y = yaw;
        this.gunHolder.rotation.z = roll;
        this.gunHolder.position.x = thrustX;
        this.gunHolder.position.y = thrustY;
        this.gunHolder.position.z = thrustZ;
      }
    } else if (this.gunHolder && this.currentWeapon === 'knife') {
      this.gunHolder.rotation.x = 0;
      this.gunHolder.rotation.y = 0;
      this.gunHolder.rotation.z = 0;
      this.gunHolder.position.x = 0;
      this.gunHolder.position.y = 0;
      this.gunHolder.position.z = 0;
    }

    let shakePitch = 0, shakeYaw = 0;
    if (this.shakeTime > 0) {
      this.shakeTime -= dt;
      const decay = Math.max(0, this.shakeTime / 0.55);
      shakePitch = (Math.random() - 0.5) * this.shakeAmt * decay;
      shakeYaw = (Math.random() - 0.5) * this.shakeAmt * decay;
    }

    this.game.camera.rotation.order = 'YXZ';
    this.game.camera.rotation.y = this.yaw + this.recoilYaw + shakeYaw;
    this.game.camera.rotation.x = this.pitch + this.recoilPitch + shakePitch;

    // Third-person body — tracks player position + facing. Crown spins, aura
    // pulses so the player is hyper-visible to anyone watching from outside.
    if (this.bodyMesh) {
      this.bodyMesh.position.set(this.position.x, this.position.y - EYE_HEIGHT, this.position.z);
      this.bodyMesh.rotation.y = this.yaw + Math.PI;       // face same direction as camera
      if (this.bodyCrown) this.bodyCrown.rotation.y += dt * 2.4;
      if (this.bodyAura) {
        const t = performance.now() * 0.005;
        this.bodyAura.rotation.z += dt * 0.9;
        this.bodyAura.material.opacity = 0.45 + 0.25 * Math.sin(t);
      }
      // Hide the body when dead so the corpse doesn't float around
      this.bodyMesh.visible = !this.dead;
    }
  }

  resolveCollisionsXZ(axis) {
    const foot = this.position.y - EYE_HEIGHT;
    const head = this.position.y + HEAD_OFFSET;
    for (const obs of this.game.arena.obstacles) {
      const obsTop = obs.y + obs.h;
      const obsBot = obs.y;
      if (obsBot >= head || obsTop <= foot) continue;

      const dx = this.position.x - obs.x - obs.w / 2;
      const dz = this.position.z - obs.z - obs.d / 2;
      const cx = obs.x + obs.w / 2;
      const cz = obs.z + obs.d / 2;
      const ddx = this.position.x - cx;
      const ddz = this.position.z - cz;
      const halfW = obs.w / 2 + PLAYER_RADIUS;
      const halfD = obs.d / 2 + PLAYER_RADIUS;
      if (Math.abs(ddx) >= halfW || Math.abs(ddz) >= halfD) continue;

      // try auto-step: top is within STEP_HEIGHT above current foot
      const stepUp = obsTop - foot;
      if (stepUp > 0 && stepUp <= STEP_HEIGHT && this.velocity.y <= 0.5) {
        // verify head clearance: no obstacle blocks at the new height
        const newEyeY = obsTop + EYE_HEIGHT;
        let blocked = false;
        for (const o2 of this.game.arena.obstacles) {
          if (o2 === obs) continue;
          const o2Top = o2.y + o2.h;
          const o2Bot = o2.y;
          if (o2Top <= obsTop + 0.01) continue;
          if (o2Bot >= newEyeY + HEAD_OFFSET) continue;
          if (
            Math.abs(this.position.x - (o2.x + o2.w / 2)) < o2.w / 2 + PLAYER_RADIUS &&
            Math.abs(this.position.z - (o2.z + o2.d / 2)) < o2.d / 2 + PLAYER_RADIUS
          ) {
            blocked = true; break;
          }
        }
        if (!blocked) {
          this.position.y = newEyeY;
          this.velocity.y = 0;
          this.onGround = true;
          continue;
        }
      }

      if (axis === 'x') {
        this.position.x = cx + Math.sign(ddx || 1) * halfW;
        this.velocity.x = 0;
      } else {
        this.position.z = cz + Math.sign(ddz || 1) * halfD;
        this.velocity.z = 0;
      }
    }
  }

  resolveCollisionsY() {
    const foot = this.position.y - EYE_HEIGHT;
    const head = this.position.y + HEAD_OFFSET;

    if (this.velocity.y <= 0) {
      // falling — find highest obstacle top below foot+small whose XZ overlaps
      let groundY = 0;
      for (const obs of this.game.arena.obstacles) {
        const cx = obs.x + obs.w / 2;
        const cz = obs.z + obs.d / 2;
        if (Math.abs(this.position.x - cx) >= obs.w / 2 + PLAYER_RADIUS) continue;
        if (Math.abs(this.position.z - cz) >= obs.d / 2 + PLAYER_RADIUS) continue;
        const obsTop = obs.y + obs.h;
        if (obsTop <= foot + 0.05 && obsTop > groundY) groundY = obsTop;
      }
      const targetEye = groundY + EYE_HEIGHT;
      if (this.position.y < targetEye) {
        this.position.y = targetEye;
        this.velocity.y = 0;
        this.onGround = true;
      } else {
        this.onGround = false;
      }
    } else {
      // rising — bonk on ceilings
      for (const obs of this.game.arena.obstacles) {
        const cx = obs.x + obs.w / 2;
        const cz = obs.z + obs.d / 2;
        if (Math.abs(this.position.x - cx) >= obs.w / 2 + PLAYER_RADIUS) continue;
        if (Math.abs(this.position.z - cz) >= obs.d / 2 + PLAYER_RADIUS) continue;
        const obsBot = obs.y;
        const obsTop = obs.y + obs.h;
        if (obsBot < head && obsTop > head && obsBot >= this.position.y) {
          this.position.y = obsBot - HEAD_OFFSET - 0.01;
          this.velocity.y = Math.min(0, this.velocity.y);
          return;
        }
      }
      this.onGround = false;
    }
  }

  fire(overrides = {}) {
    const w = WEAPONS[this.currentWeapon];
    if (this.matchStats) this.matchStats.shotsFired++;
    this._shotPendingHit = true;
    // Shot SFX — tossor (grenade launcher) uses the dedicated grenade sample;
    // everything else shares the gunshot sample, pitched per-weapon.
    if (this.game.sfx) {
      if (this.currentWeapon === 'tossor') {
        this.game.sfx.grenadeBoom(0.95);
      } else {
        this.game.sfx.gunshot(this.currentWeapon);
      }
    }
    // shoot where the camera is actually pointing (so recoil pulls aim off)
    const aimYaw = this.yaw + this.recoilYaw;
    const aimPitch = this.pitch + this.recoilPitch;
    const dir = new THREE.Vector3(
      -Math.sin(aimYaw) * Math.cos(aimPitch),
      Math.sin(aimPitch),
      -Math.cos(aimYaw) * Math.cos(aimPitch)
    );
    // Spawn projectile at the actual barrel tip in world space (the muzzleFlash
    // marker sits at cfg.muzzleOffset on the gunHolder). Falls back to a point
    // 0.6m in front of the player if the marker isn't ready yet.
    let muzzlePos;
    if (this.muzzleFlash) {
      this.muzzleFlash.updateMatrixWorld(true);
      muzzlePos = new THREE.Vector3();
      this.muzzleFlash.getWorldPosition(muzzlePos);
    } else {
      muzzlePos = this.position.clone().addScaledVector(dir, 0.6);
    }
    const ksDmgMult = this.game.killstreakEffects?.dmgBoost?.mult ?? 1;
    // Kill-aura passive: +15% damage once 5+ kills this match (scales with kills)
    const auraDmgMult = this.auraActive ? 1.15 + Math.min(0.20, ((this.kills || 5) - 5) * 0.02) : 1;
    const damageMult = (this.buffs.damage?.mult ?? 1) * (this.sentryActive ? 2 : 1) * ksDmgMult * auraDmgMult;
    const extraPellets = this.buffs.multishot?.add ?? 0;

    // Resolve special-move modifier for this single shot
    const mod = this.specialMod;
    let pellets = (w.pellets || 1) + extraPellets;
    let damage = w.damage * damageMult;
    let projectileSize = w.projectileSize;
    let spread = (overrides.spread != null)
      ? overrides.spread
      : (this.ads ? (w.adsSpread ?? w.spread * 0.25) : w.spread);
    let skipSniperFx = false;
    // Global recoil reduction — felt too punchy at the previous values.
    let recoilMult = (this.ads ? 0.45 : 1) * 0.8;

    if (mod) {
      if (mod.type === 'slug') {
        pellets = 1;
        damage = mod.damage * damageMult;
        if (mod.projectileSize) projectileSize = mod.projectileSize;
        spread = 0;
      } else if (mod.type === 'fan') {
        pellets = mod.count;
        spread = mod.spread;
      } else if (mod.type === 'steady') {
        skipSniperFx = true;
        spread = 0;
        recoilMult *= 0.25;
      }
      this.specialMod = null;
    }

    for (let i = 0; i < pellets; i++) {
      const d = dir.clone();
      if (spread > 0) {
        d.x += (Math.random() - 0.5) * spread * 2;
        d.y += (Math.random() - 0.5) * spread * 2;
        d.z += (Math.random() - 0.5) * spread * 2;
        d.normalize();
      }
      this.game.spawnProjectile({
        ownerEntity: 'player',
        ownerTeam: this.team,
        position: muzzlePos,
        velocity: d.multiplyScalar(w.projectileSpeed),
        damage,
        size: projectileSize,
        gravity: w.gravity || 0,
        explosionRadius: w.explosionRadius || 0,
        impactExplode: !!w.impactExplode,
        fuse: w.fuse,
        color: w.projectileColor,
      });
    }
    // apply recoil — ADS reduces it
    this.recoilPitch += (w.recoilPitch || 0) * recoilMult;
    this.recoilYaw += (Math.random() - 0.5) * 2 * (w.recoilYaw || 0) * recoilMult;

    // Per-shot screen shake (in addition to per-weapon kick). ADS halves it.
    const shakeBase = (w.shakeAmt || 0) * (this.ads ? 0.4 : 1);
    if (shakeBase > 0) {
      this.shakeTime = Math.max(this.shakeTime, 0.12);
      this.shakeAmt = Math.max(this.shakeAmt, shakeBase);
    }

    // Crosshair kick — HUD reads this for a brief outward bloom + scale-up
    this.crosshairKick = Math.min(1, (this.crosshairKick || 0) + (w.kickAmt || 0.05) * (this.ads ? 0.6 : 1.0));

    // Sniper-only: huge flash + screen shake + extra recoil to kill quickscoping
    if (this.currentWeapon === 'boomstick' && !skipSniperFx) {
      this.game.flashSniperBlind();
      this.shakeTime = 0.55;
      this.shakeAmt = 0.22;
      this.recoilPitch += 0.32;
      this.recoilYaw += (Math.random() - 0.5) * 0.18;
    }
  }

  meleeStrike() {
    const w = WEAPONS.knife;
    if (this.game.sfx && this.game.sfx.knifeStab) this.game.sfx.knifeStab();
    const aimYaw = this.yaw + this.recoilYaw;
    const aimPitch = this.pitch + this.recoilPitch;
    const dir = new THREE.Vector3(
      -Math.sin(aimYaw) * Math.cos(aimPitch),
      Math.sin(aimPitch),
      -Math.cos(aimYaw) * Math.cos(aimPitch)
    );
    const damageMult = this.buffs.damage?.mult ?? 1;
    let bestTarget = null;
    let bestDist = Infinity;
    for (const bot of this.game.bots) {
      if (bot.dead || bot.team === this.team) continue;
      const toEnt = new THREE.Vector3().subVectors(bot.position, this.position);
      const dist = toEnt.length();
      if (dist > w.range + bot.radius) continue;
      toEnt.normalize();
      if (toEnt.dot(dir) < 0.55) continue;
      if (dist < bestDist) { bestDist = dist; bestTarget = bot; }
    }
    if (bestTarget) {
      const wasAlive = !bestTarget.dead;
      const dmg = w.damage * damageMult;
      bestTarget.damage(dmg, 'player');
      this.game.flashHitMarker();
      if (wasAlive) {
        const kind = bestTarget.dead ? 'kill' : 'crit';
        this.game.spawnDamageNumber(bestTarget.position, dmg, kind);
      }
      // Knife landed — wet-thud impact, plus death splat if it killed them
      if (this.game.sfx) {
        this.game.sfx.bulletImpactAt(this.position.distanceTo(bestTarget.position));
        if (wasAlive && bestTarget.dead) {
          this.game.sfx.potatoDeathAt(this.position.distanceTo(bestTarget.position));
        }
      }
    }
  }

  damage(amount, attacker) {
    if (this.dead) return;
    if (this.spawnInvuln > 0) return;
    if (this.game.killstreakEffects?.invuln) return;
    this.health -= amount;
    if (this.matchStats) this.matchStats.damageTaken += amount;
    this.timeSinceDamage = 0;
    this.game.flashDamage();
    this.game.sfx.damage();
    // Take-hit shake — scales with damage. Capped so a barrage doesn't blind the player.
    const hitShake = Math.min(0.18, 0.05 + amount * 0.0025);
    this.shakeTime = Math.max(this.shakeTime, 0.22);
    this.shakeAmt = Math.max(this.shakeAmt, hitShake);
    if (attacker && attacker.position && this.game.registerDamageDirection) {
      this.game.registerDamageDirection(attacker.position);
    }
    if (this.health <= 0) {
      this.health = 0;
      this.dead = true;
      this.streak = 0;
      if (this.game.sfx && this.game.sfx.potatoDeath) this.game.sfx.potatoDeath();
      // Tag the killer for revenge bonus next kill
      if (attacker && typeof attacker === 'object' && !attacker.dead) {
        this.lastKiller = { ref: attacker, time: performance.now() / 1000 };
      } else {
        this.lastKiller = null;
      }
      // Multiplayer: tell the peer they killed us (so they get the kill banner)
      if (this.game.multiplayer && this.game.multiplayer.connected) {
        const killerIsRemote = attacker === this.game.remotePlayer;
        this.game.multiplayer.sendEvent({
          kind: 'died',
          killerIsPlayer: killerIsRemote,
          killerName: this.name || 'You',
        });
      }
      this.game.onPlayerDeath(attacker);
    }
  }

  respawn() {
    this.maxHealth = this.baseMaxHealth;
    this.health = this.maxHealth;
    this.dead = false;
    this.spawnInvuln = SPAWN_INVULN;
    this._emergencyAmmoUsed = false;
    const sp = this.game.arena.teamSpawns[this.team];
    const choice = sp[Math.floor(Math.random() * sp.length)];
    this.position.set(choice.x, choice.y + EYE_HEIGHT - 0.85, choice.z);
    // face toward arena center so player isn't staring at the back wall
    this.yaw = this.team === 'mash' ? 0 : Math.PI;
    this.pitch = 0;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.velocity.set(0, 0, 0);
    this.loadout = [this.loadoutWeapon, 'spudgun', 'knife'];
    this.ammo = {};
    for (const k of this.loadout) {
      this.ammo[k] = { mag: WEAPONS[k].magSize, reserve: WEAPONS[k].reserve };
    }
    this.currentWeapon = this.loadout[0];
    if (this.gunMesh && this.gunMesh.material) {
      this.gunMesh.material.color.setHex(WEAPONS[this.currentWeapon].viewmodelColor);
    }
    this._swapGunModel(this.currentWeapon);
    this.reloading = false;
    this.fireCooldown = 0;
    this.timeSinceDamage = 0;
    this.ads = false;
    this.adsAmount = 0;
    this.buffs = {};
    this.sentryActive = false;
    this.sentryCooldown = 0;
    this.sentryBase.visible = false;
    this.shakeTime = 0;
    this.shakeAmt = 0;
    this.specialCooldowns = {};
    this.specialMod = null;
    this.specialQueue = null;
    this.hotBarrelTimer = 0;
    this.dashCooldown = 0;
    this.dashTimer = 0;
    this._knifeDashCooldown = 0;
    this.slideCooldown = 0;
    this.slideTimer = 0;
    this.slideEyeDip = 0;
    // Multiplayer: tell the peer we're alive again
    if (this.game.multiplayer && this.game.multiplayer.connected) {
      this.game.multiplayer.sendEvent({
        kind: 'respawn',
        health: this.health,
        maxHealth: this.maxHealth,
      });
    }
    // coins and kills persist between respawns
  }
}
