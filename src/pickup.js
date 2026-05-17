import * as THREE from 'three';
import { WEAPONS } from './weapons.js';

const PICKUP_RADIUS = 1.7;
const RESPAWN_TIME = 12;

export class Pickup {
  constructor(game, type, position, opts = {}) {
    this.game = game;
    this.type = type;
    this.tier = opts.tier || 'basic';
    this.ephemeral = !!opts.ephemeral;     // loot drops vanish after collect, no respawn
    this.expireAt = this.ephemeral ? performance.now() / 1000 + 14 : 0;
    this.basePos = position.clone();
    this.position = position.clone();
    this.taken = false;
    this.respawnAt = 0;
    this.t = Math.random() * Math.PI * 2;

    this.mesh = this.buildMesh(type);
    this.mesh.position.copy(this.basePos);
    game.scene.add(this.mesh);
  }

  buildMesh(type) {
    const group = new THREE.Group();
    if (type === 'ammo') {
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(0.9, 0.7, 0.9),
        new THREE.MeshStandardMaterial({ color: 0x6b4a2a, roughness: 0.85 })
      );
      box.castShadow = true;
      group.add(box);
      // banding
      const band = new THREE.Mesh(
        new THREE.BoxGeometry(0.95, 0.12, 0.95),
        new THREE.MeshStandardMaterial({ color: 0xffce5e, emissive: 0x553a16, emissiveIntensity: 0.3 })
      );
      group.add(band);
      const label = new THREE.Mesh(
        new THREE.BoxGeometry(0.5, 0.4, 0.96),
        new THREE.MeshBasicMaterial({ color: 0xffce5e })
      );
      label.position.y = 0.05;
      group.add(label);
    } else if (type === 'health') {
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(0.7, 0.7, 0.7),
        new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 })
      );
      box.castShadow = true;
      group.add(box);
      // red cross
      const crossMat = new THREE.MeshBasicMaterial({ color: 0xd62828 });
      const c1 = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.15, 0.72), crossMat);
      const c2 = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.5, 0.72), crossMat);
      group.add(c1); group.add(c2);
      const c3 = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.15, 0.5), crossMat);
      const c4 = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.5, 0.15), crossMat);
      group.add(c3); group.add(c4);
    } else if (type === 'loot') {
      const isRare = this.tier === 'rare';
      const bodyColor = isRare ? 0xfff5a0 : 0x7eddff;
      const emissive = isRare ? 0xffd700 : 0x4a90e2;
      const body = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.3, 0.55, 6, 10),
        new THREE.MeshStandardMaterial({
          color: bodyColor, emissive, emissiveIntensity: 0.7,
          roughness: 0.25, metalness: 0.45,
        })
      );
      body.castShadow = true;
      group.add(body);
      // outer halo sphere for that "you see it from across the map" feel
      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(0.65, 14, 10),
        new THREE.MeshBasicMaterial({ color: emissive, transparent: true, opacity: 0.18 })
      );
      group.add(halo);
      this._loot = { halo, body, isRare };
    } else if (type === 'grenade') {
      // shiny golden potato grenade
      const geo = new THREE.SphereGeometry(0.32, 14, 10);
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        pos.setY(i, y * 1.4);
        pos.setX(i, x * (1 + Math.sin(y * 5) * 0.05));
      }
      geo.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({
        color: 0xf6c265,
        emissive: 0xc47a3d,
        emissiveIntensity: 0.5,
        roughness: 0.3,
        metalness: 0.6,
      });
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;
      group.add(m);
    }

    // glowing ring under pickup
    const ringColor =
      type === 'health' ? 0xff5050 :
      type === 'grenade' ? 0xffce5e :
      type === 'loot' ? (this.tier === 'rare' ? 0xffd700 : 0x4a90e2) :
      0xc47a3d;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 0.95, 24),
      new THREE.MeshBasicMaterial({
        color: ringColor,
        transparent: true,
        opacity: 0.55,
        side: THREE.DoubleSide,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = -0.45;
    group.add(ring);

    return group;
  }

  update(dt) {
    if (this.taken) {
      if (this.ephemeral) {
        // mark for cleanup outside this method (game loop filters dead pickups would be ideal,
        // but pickup list isn't filtered — so dispose here once after a brief grace period)
        if (this._disposed) return;
        if (performance.now() / 1000 > this.respawnAt) {
          this._disposed = true;
          this.dispose();
        }
        return;
      }
      if (performance.now() / 1000 > this.respawnAt) this.respawn();
      return;
    }
    // Ephemeral loot expires after 14s if not collected
    if (this.ephemeral && performance.now() / 1000 > this.expireAt) {
      this._disposed = true;
      this.taken = true;
      this.mesh.visible = false;
      this.dispose();
      return;
    }
    this.t += dt;
    this.mesh.rotation.y = this.t * 1.5;
    this.mesh.position.y = this.basePos.y + Math.sin(this.t * 2.2) * 0.12;
    if (this._loot) {
      const pulse = 1 + Math.sin(this.t * 4.5) * 0.12;
      this._loot.halo.scale.setScalar(pulse);
      this._loot.halo.material.opacity = 0.22 + Math.sin(this.t * 4.5) * 0.08;
    }

    // Magnetism — when the player gets close, the loot drifts toward them.
    // Lower priority for static health/ammo crates (they shouldn't move).
    const playerPos = this.game.player.position.clone();
    playerPos.y -= 0.6;
    const dist = playerPos.distanceTo(this.basePos);
    if (this.ephemeral && dist < 5 && dist > PICKUP_RADIUS) {
      const dir = playerPos.clone().sub(this.basePos);
      dir.y = 0;
      if (dir.lengthSq() > 0.01) {
        dir.normalize();
        const pull = (5 - dist) * 4 * dt; // stronger pull as you get closer
        this.basePos.addScaledVector(dir, pull);
      }
    }
    if (dist < PICKUP_RADIUS) {
      this.collect();
    }
  }

  collect() {
    const p = this.game.player;
    let msg = '';
    if (this.type === 'loot') {
      const isRare = this.tier === 'rare';
      const rolls = isRare
        ? ['xp_big', 'coins_big', 'damage_big', 'speed_big', 'heal_full']
        : ['xp', 'coins', 'damage', 'speed', 'heal', 'reload'];
      const pick = rolls[Math.floor(Math.random() * rolls.length)];
      const tag = isRare ? 'RARE' : 'LOOT';
      switch (pick) {
        case 'xp':         p.sessionXp = (p.sessionXp || 0) + 35; this.game.spawnDamageNumber(p.position, 35, 'xp'); msg = `${tag} · +35 XP`; break;
        case 'coins':      p.coins += 40; this.game.spawnDamageNumber(p.position, 40, 'coin'); msg = `${tag} · +40¢`; break;
        case 'damage':     p.applyBuff('damage', { mult: 1.5, duration: 8 }); msg = `${tag} · 1.5× DAMAGE 8s`; break;
        case 'speed':      p.applyBuff('speed',  { mult: 1.35, duration: 8 }); msg = `${tag} · SPEED 8s`; break;
        case 'reload':     p.applyBuff('reload', { mult: 0.55, duration: 10 }); msg = `${tag} · FAST RELOAD 10s`; break;
        case 'heal':       p.health = Math.min(p.maxHealth, p.health + 60); msg = `${tag} · +60 HP`; break;
        // RARE-only super rolls
        case 'xp_big':     p.sessionXp = (p.sessionXp || 0) + 100; this.game.spawnDamageNumber(p.position, 100, 'xp'); msg = `${tag} · +100 XP`; break;
        case 'coins_big':  p.coins += 120; this.game.spawnDamageNumber(p.position, 120, 'coin'); msg = `${tag} · +120¢`; break;
        case 'damage_big': p.applyBuff('damage', { mult: 2.5, duration: 10 }); msg = `${tag} · 2.5× DAMAGE 10s`; break;
        case 'speed_big':  p.applyBuff('speed',  { mult: 1.6,  duration: 10 }); msg = `${tag} · MASSIVE SPEED 10s`; break;
        case 'heal_full':  p.health = p.maxHealth; p.maxHealth = p.baseMaxHealth + 25; msg = `${tag} · FULL HEAL +25 MAX HP`; break;
      }
      if (p.matchStats) p.matchStats.lootGrabbed++;
      if (this.game.progressChallenge) this.game.progressChallenge('loot', 1);
      this.game.hud.addPickupMessage(msg);
      this.game.sfx.special && this.game.sfx.special();
      this.taken = true;
      // dispose shortly after so the user gets a "gulp" beat
      this.respawnAt = performance.now() / 1000 + 0.2;
      this.mesh.visible = false;
      return;
    }
    if (this.type === 'ammo') {
      const cur = p.currentWeapon;
      const w = WEAPONS[cur];
      const a = p.ammo[cur];
      a.reserve = Math.min(w.reserve * 2, a.reserve + w.magSize * 2);
      msg = `+ammo ${w.name}`;
    } else if (this.type === 'health') {
      if (p.health >= p.maxHealth) return; // don't waste it
      p.health = Math.min(p.maxHealth, p.health + 50);
      msg = '+50 HP';
    } else if (this.type === 'grenade') {
      const a = p.ammo.spudnade;
      const w = WEAPONS.spudnade;
      if (a.reserve >= w.reserve + 2) return; // already full
      a.reserve = Math.min(w.reserve + 2, a.reserve + 1);
      msg = '+1 Spudnade';
    }
    this.game.hud.addPickupMessage(msg);
    this.taken = true;
    this.respawnAt = performance.now() / 1000 + RESPAWN_TIME;
    this.mesh.visible = false;
  }

  respawn() {
    this.taken = false;
    this.mesh.visible = true;
  }

  dispose() {
    this.game.scene.remove(this.mesh);
    this.mesh.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }
}
