import * as THREE from 'three';
import { joinRoom } from 'trystero/torrent';
import { makePotato } from './potato.js';
import { TEAM_COLORS } from './arena.js';

// Two-player WebRTC multiplayer over Trystero (BitTorrent tracker signaling).
// Both browsers run their own world simulation (bots, projectiles, pickups);
// only player position/state and damage events sync over the wire. The bot
// world intentionally diverges between clients — that's the cost of zero
// authoritative server. Player-vs-player works because hits are relayed:
//   1. Local projectile hits remote player's representation -> sendEvent('hit')
//   2. Remote browser receives 'hit', applies damage to their real player
//   3. If real player dies, broadcast 'died' so local awards the kill
//
// Why Trystero instead of PeerJS: PeerJS's public signaling server is a single
// point of failure that often accepts the host registration but never gets the
// ICE answer back to the joiner — symptom is "connecting…" hanging for 30s+.
// Trystero uses multiple BitTorrent tracker WebSockets as a signaling fan-out,
// so the room rendezvous is far more reliable for a no-server setup.

// 30s hard timeout on join — if no peer shows up in the room by then, fail with
// a friendly error rather than spinning forever.
const JOIN_TIMEOUT_MS = 30000;

const TRYSTERO_CONFIG = { appId: 'spud-shockers-mp' };

export class Multiplayer {
  constructor(game) {
    this.game = game;
    this.room = null;
    this.peerId = null;
    this.role = null;          // 'host' | 'client'
    this.code = null;
    this.connected = false;
    this.lastSendTime = 0;
    this.sendIntervalMs = 50;  // 20Hz position sync
    this.onConnectListeners = [];
    this.onStateListeners = [];
    this.onEventListeners = [];
    this.onDisconnectListeners = [];
    this.onLogListeners = [];
    this.remote = null;
    this._sendStateFn = null;
    this._sendEventFn = null;
  }

  // Host generates a 4-letter code, joins the room with it, and waits for the
  // joiner. Resolves immediately with the code (signaling-server "open" has no
  // analog in Trystero — joining a room is synchronous from this side, peers
  // appear over the network).
  async host() {
    if (this.room) this.dispose();
    this.role = 'host';
    const code = this._makeCode();
    this.code = code;
    try {
      this._joinRoom(code);
      this._log('hosting room ' + code);
      this._fire(this.onConnectListeners, { role: 'host', code, ready: true, peer: false });
      return code;
    } catch (err) {
      this._log('host error: ' + (err && err.message));
      throw err;
    }
  }

  // Join an existing room by code. Resolves when a peer is detected in the
  // room (i.e. the host is reachable + data channel opened). Rejects on
  // timeout if no one shows up.
  async join(code) {
    if (this.room) this.dispose();
    this.role = 'client';
    this.code = code.toUpperCase();
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        this._log('join timeout — no host responded');
        reject(new Error('join-timeout'));
      }, JOIN_TIMEOUT_MS);
      try {
        this._joinRoom(this.code, () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve();
        });
        this._log('searching for room ' + this.code + '…');
      } catch (err) {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(err);
        }
      }
    });
  }

  // Shared setup: join a Trystero room, wire up actions (state, event), and
  // fire onConnect when a peer appears. onPeerFound is the join() promise
  // resolver — fires the first time a peer joins so join() can return.
  _joinRoom(code, onPeerFound) {
    const roomName = 'spudshockers-' + code;
    this.room = joinRoom(TRYSTERO_CONFIG, roomName);

    const [sendState, getState] = this.room.makeAction('state');
    const [sendEvent, getEvent] = this.room.makeAction('event');
    this._sendStateFn = sendState;
    this._sendEventFn = sendEvent;
    getState((data) => this._fire(this.onStateListeners, data));
    getEvent((data) => this._fire(this.onEventListeners, data));

    this.room.onPeerJoin((id) => {
      this.peerId = id;
      this.connected = true;
      this._log('peer joined: ' + id.slice(0, 8));
      this._fire(this.onConnectListeners, { role: this.role, code: this.code, ready: true, peer: true });
      if (onPeerFound) onPeerFound();
    });

    this.room.onPeerLeave((id) => {
      if (id !== this.peerId) return;
      this.connected = false;
      this.peerId = null;
      this._log('peer left');
      this._fire(this.onDisconnectListeners, {});
    });
  }

  // Per-frame position broadcast. Throttled to sendIntervalMs (20Hz).
  sendState(state) {
    if (!this._sendStateFn || !this.connected) return;
    const now = performance.now();
    if (now - this.lastSendTime < this.sendIntervalMs) return;
    this.lastSendTime = now;
    try { this._sendStateFn(state); } catch (_) {}
  }

  // One-off event (hit, died, chat, etc.). NOT throttled. Reliable + ordered.
  sendEvent(event) {
    if (!this._sendEventFn || !this.connected) return;
    try { this._sendEventFn(event); } catch (_) {}
  }

  dispose() {
    if (this.room) {
      try { this.room.leave(); } catch (_) {}
      this.room = null;
    }
    this._sendStateFn = null;
    this._sendEventFn = null;
    this.connected = false;
    this.peerId = null;
  }

  _makeCode() {
    const chars = 'BCDFGHJKLMNPQRSTVWXYZ';
    let c = '';
    for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
    return c;
  }

  onConnect(fn) { this.onConnectListeners.push(fn); }
  onState(fn) { this.onStateListeners.push(fn); }
  onEvent(fn) { this.onEventListeners.push(fn); }
  onDisconnect(fn) { this.onDisconnectListeners.push(fn); }
  onLog(fn) { this.onLogListeners.push(fn); }
  _log(s) { this._fire(this.onLogListeners, s); }
  _fire(arr, v) { for (const f of arr) { try { f(v); } catch (_) {} } }
}

// Visual + hittable representation of the OTHER player in your scene. Has
// the same interface as a Bot (position, health, damage, dead, kills, name)
// so projectile collision + AI targeting "just works" against it.
export class RemotePlayer {
  constructor(game, team, name) {
    this.game = game;
    this.team = team;
    this.name = name || (team === 'mash' ? 'DAD' : 'DAD');
    this.position = new THREE.Vector3(0, 0.85, team === 'mash' ? 80 : -80);
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.health = 150;             // dad is a tank (matches local DAD mode)
    this.maxHealth = 150;
    this.dead = false;
    this.radius = 0.6;
    this.id = 'remote_' + Math.floor(Math.random() * 1e6);
    this.kills = 0;
    this.skill = 3;
    this.personality = 'rude';
    this.persona = { color: '#ff5ec8' };
    this.spawnInvuln = 0;
    this.lastStateTime = 0;
    this.targetPos = this.position.clone();
    this.targetYaw = 0;
    // Manual flag so bot scoring + targeting can treat us like any entity
    this.weaponKey = 'fryer';
    this.currentWeapon = 'fryer';

    // Build potato body with the KING DAD design — hot-pink crown, cape,
    // huge aura. Same flair as local DAD mode but always visible.
    this.mesh = makePotato({ size: 1.8, color: 0xd9a86b });
    const teamCol = TEAM_COLORS[team] || 0x3a5cc2;
    // Team hat
    const hat = new THREE.Mesh(
      new THREE.CylinderGeometry(0.4, 0.55, 0.25, 12),
      new THREE.MeshBasicMaterial({ color: teamCol }),
    );
    hat.position.y = 1.18;
    this.mesh.add(hat);
    // Hot-pink + cyan crown (mirror of player's gold crown so dad is unmistakable)
    const crownGroup = new THREE.Group();
    const crownMat = new THREE.MeshStandardMaterial({ color: 0xff5ec8, metalness: 0.7, roughness: 0.25, emissive: 0xa02080, emissiveIntensity: 0.55 });
    crownGroup.add(new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.18, 14), crownMat));
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.28, 6), crownMat);
      spike.position.set(Math.cos(a) * 0.34, 0.22, Math.sin(a) * 0.34);
      crownGroup.add(spike);
      const gem = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), new THREE.MeshBasicMaterial({ color: 0x5effe6 }));
      gem.position.copy(spike.position);
      gem.position.y -= 0.18;
      crownGroup.add(gem);
    }
    crownGroup.position.y = 1.55;
    this.mesh.add(crownGroup);
    this.crown = crownGroup;
    // Team cape
    const cape = new THREE.Mesh(
      new THREE.PlaneGeometry(1.05, 1.45),
      new THREE.MeshBasicMaterial({ color: teamCol, side: THREE.DoubleSide, transparent: true, opacity: 0.92 }),
    );
    cape.position.set(0, 0.05, -0.32);
    this.mesh.add(cape);
    // Big star aura
    const auraGeo = new THREE.RingGeometry(1.8, 2.3, 5);
    const auraMat = new THREE.MeshBasicMaterial({ color: 0xff5ec8, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false });
    this.aura = new THREE.Mesh(auraGeo, auraMat);
    this.aura.rotation.x = -Math.PI / 2;
    this.mesh.add(this.aura);
    game.scene.add(this.mesh);

    // Floating health bar + nametag (same pattern as Bot)
    this.healthBarBg = new THREE.Mesh(
      new THREE.PlaneGeometry(1.6, 0.18),
      new THREE.MeshBasicMaterial({ color: 0x2a1a0a, depthTest: false }),
    );
    this.healthBarFill = new THREE.Mesh(
      new THREE.PlaneGeometry(1.5, 0.11),
      new THREE.MeshBasicMaterial({ color: teamCol, depthTest: false }),
    );
    this.healthBarBg.renderOrder = 999;
    this.healthBarFill.renderOrder = 1000;
    game.scene.add(this.healthBarBg);
    game.scene.add(this.healthBarFill);
  }

  // Apply a state message from the peer (their position/yaw/health/etc.)
  applyState(s) {
    this.targetPos.set(s.x, s.y, s.z);
    this.targetYaw = s.yaw || 0;
    if (typeof s.health === 'number') this.health = s.health;
    if (typeof s.maxHealth === 'number') this.maxHealth = s.maxHealth;
    if (typeof s.kills === 'number') this.kills = s.kills;
    if (s.name) this.name = s.name;
    if (s.weapon) { this.weaponKey = s.weapon; this.currentWeapon = s.weapon; }
    if (typeof s.dead === 'boolean') this.dead = s.dead;
    this.lastStateTime = performance.now();
  }

  // Called per-frame; smoothly interpolates the mesh toward the latest target
  // state so movement looks fluid even with 50ms sync intervals.
  update(dt) {
    if (this.dead) {
      this.mesh.visible = false;
      this.healthBarBg.visible = false;
      this.healthBarFill.visible = false;
      return;
    }
    this.mesh.visible = true;
    this.healthBarBg.visible = true;
    this.healthBarFill.visible = true;
    // Velocity = derivative of position (used by bot AI for lead calculation)
    this.velocity.subVectors(this.targetPos, this.position).multiplyScalar(1 / Math.max(0.016, dt));
    this.position.lerp(this.targetPos, Math.min(1, dt * 14));
    this.mesh.position.copy(this.position);
    // Smooth yaw rotation. The peer broadcasts CAMERA yaw, but the potato
    // body model points the opposite direction from the camera (see
    // player.js where bodyMesh.rotation.y = yaw + Math.PI). Mirror that
    // offset here so the remote potato's eyes face the way the peer is
    // actually looking, not the back of its head.
    let dy = this.targetYaw - this.yaw;
    while (dy >  Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    this.yaw += dy * Math.min(1, dt * 12);
    this.mesh.rotation.y = this.yaw + Math.PI;

    if (this.crown) this.crown.rotation.y += dt * 2.6;
    if (this.aura) {
      this.aura.rotation.z += dt * 1.0;
      this.aura.material.opacity = 0.5 + 0.25 * Math.sin(performance.now() * 0.005);
    }

    // Health bar billboard
    const bp = this.position.clone();
    bp.y += 1.7;
    this.healthBarBg.position.copy(bp);
    this.healthBarFill.position.copy(bp);
    this.healthBarBg.lookAt(this.game.camera.position);
    this.healthBarFill.lookAt(this.game.camera.position);
    const pct = Math.max(0, Math.min(1, this.health / this.maxHealth));
    this.healthBarFill.scale.x = pct;
    const teamCol = TEAM_COLORS[this.team] || 0x3a5cc2;
    this.healthBarFill.material.color.setHex(pct > 0.5 ? teamCol : pct > 0.25 ? 0xff8a3c : 0xff3a3a);
  }

  // Called when one of OUR local projectiles hits this remote rep. We don't
  // modify local health (that's a synced field) — instead we relay the damage
  // to the peer who will apply it to their real player.
  damage(amount, attacker) {
    if (this.dead) return;
    if (this.game.multiplayer && this.game.multiplayer.connected) {
      this.game.multiplayer.sendEvent({
        kind: 'hit',
        amount,
        attackerName: this.game.player.name || 'You',
        attackerIsPlayer: attacker === 'player' || attacker === this.game.player,
      });
    }
  }

  dispose() {
    this.game.scene.remove(this.mesh);
    this.game.scene.remove(this.healthBarBg);
    this.game.scene.remove(this.healthBarFill);
    this.mesh.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    if (this.healthBarBg.geometry) this.healthBarBg.geometry.dispose();
    if (this.healthBarBg.material) this.healthBarBg.material.dispose();
    if (this.healthBarFill.geometry) this.healthBarFill.geometry.dispose();
    if (this.healthBarFill.material) this.healthBarFill.material.dispose();
  }
}

// Visual + hittable mirror of a HOST-side bot. The host sends snapshots of
// every alive bot at ~10Hz; the client maintains one RemoteBot per id and
// lerps it toward the latest target state. AI runs ONLY on the host, so both
// sides see the exact same enemy configuration. Projectile collision treats
// RemoteBot just like a Bot — damage to it is relayed back to the host via
// a `hitBot` event, and the host's bot takes the hit authoritatively.
export class RemoteBot {
  constructor(game, snap) {
    this.game = game;
    this.id = snap.id;
    this.team = snap.team;
    this.name = snap.name || 'Spud';
    this.skill = snap.skill || 3;
    this.personality = snap.personality || 'quiet';
    this.persona = { color: '#a4d8ff' };
    this.weaponKey = snap.weapon || 'spudgun';
    this.currentWeapon = this.weaponKey;
    this.health = snap.health || 150;
    this.maxHealth = snap.maxHealth || 150;
    this.dead = !!snap.dead;
    this.kills = snap.kills || 0;
    this.radius = 0.6;
    this.spawnInvuln = 0;
    this.position = new THREE.Vector3(snap.x || 0, snap.y || 0.85, snap.z || 0);
    this.targetPos = this.position.clone();
    this.velocity = new THREE.Vector3();
    this.yaw = snap.yaw || 0;
    this.targetYaw = this.yaw;

    const teamCol = TEAM_COLORS[this.team] || 0x3a5cc2;
    this.mesh = makePotato({ size: 1.5, color: 0xc47a3d });
    const hat = new THREE.Mesh(
      new THREE.CylinderGeometry(0.4, 0.55, 0.25, 12),
      new THREE.MeshBasicMaterial({ color: teamCol }),
    );
    hat.position.y = 1.0;
    this.mesh.add(hat);
    this.mesh.position.copy(this.position);
    game.scene.add(this.mesh);

    this.healthBarBg = new THREE.Mesh(
      new THREE.PlaneGeometry(1.6, 0.18),
      new THREE.MeshBasicMaterial({ color: 0x2a1a0a, depthTest: false }),
    );
    this.healthBarFill = new THREE.Mesh(
      new THREE.PlaneGeometry(1.5, 0.11),
      new THREE.MeshBasicMaterial({ color: teamCol, depthTest: false }),
    );
    this.healthBarBg.renderOrder = 999;
    this.healthBarFill.renderOrder = 1000;
    game.scene.add(this.healthBarBg);
    game.scene.add(this.healthBarFill);
  }

  applyState(s) {
    this.targetPos.set(s.x, s.y, s.z);
    this.targetYaw = s.yaw || 0;
    if (typeof s.health === 'number') this.health = s.health;
    if (typeof s.maxHealth === 'number') this.maxHealth = s.maxHealth;
    if (typeof s.kills === 'number') this.kills = s.kills;
    if (typeof s.dead === 'boolean') this.dead = s.dead;
    if (s.weapon) { this.weaponKey = s.weapon; this.currentWeapon = s.weapon; }
    if (s.name) this.name = s.name;
  }

  update(dt) {
    if (this.dead) {
      this.mesh.visible = false;
      this.healthBarBg.visible = false;
      this.healthBarFill.visible = false;
      return;
    }
    this.mesh.visible = true;
    this.healthBarBg.visible = true;
    this.healthBarFill.visible = true;
    this.velocity.subVectors(this.targetPos, this.position).multiplyScalar(1 / Math.max(0.016, dt));
    this.position.lerp(this.targetPos, Math.min(1, dt * 14));
    this.mesh.position.copy(this.position);
    let dy = this.targetYaw - this.yaw;
    while (dy >  Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    this.yaw += dy * Math.min(1, dt * 12);
    this.mesh.rotation.y = this.yaw;

    const bp = this.position.clone();
    bp.y += 1.7;
    this.healthBarBg.position.copy(bp);
    this.healthBarFill.position.copy(bp);
    this.healthBarBg.lookAt(this.game.camera.position);
    this.healthBarFill.lookAt(this.game.camera.position);
    const pct = Math.max(0, Math.min(1, this.health / this.maxHealth));
    this.healthBarFill.scale.x = pct;
    const teamCol = TEAM_COLORS[this.team] || 0x3a5cc2;
    this.healthBarFill.material.color.setHex(pct > 0.5 ? teamCol : pct > 0.25 ? 0xff8a3c : 0xff3a3a);
  }

  damage(amount, attacker) {
    if (this.dead) return;
    if (this.game.multiplayer && this.game.multiplayer.connected) {
      this.game.multiplayer.sendEvent({
        kind: 'hitBot',
        botId: this.id,
        amount,
        attackerIsPlayer: attacker === 'player' || attacker === this.game.player,
      });
    }
  }

  dispose() {
    this.game.scene.remove(this.mesh);
    this.game.scene.remove(this.healthBarBg);
    this.game.scene.remove(this.healthBarFill);
    this.mesh.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    if (this.healthBarBg.geometry) this.healthBarBg.geometry.dispose();
    if (this.healthBarBg.material) this.healthBarBg.material.dispose();
    if (this.healthBarFill.geometry) this.healthBarFill.geometry.dispose();
    if (this.healthBarFill.material) this.healthBarFill.material.dispose();
  }
}
