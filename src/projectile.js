import * as THREE from 'three';

const PLAYER_HIT_RADIUS = 0.55;

export class Projectile {
  constructor(game, opts) {
    this.game = game;
    this.position = opts.position.clone();
    this.velocity = opts.velocity.clone();
    this.damage = opts.damage;
    // ownerEntity: a Bot instance or 'player' (string).
    this.ownerEntity = opts.ownerEntity ?? opts.owner ?? 'player';
    // ownerTeam used for friendly-fire prevention. Default to player's team if owner is 'player'.
    this.ownerTeam = opts.ownerTeam
      ?? (this.ownerEntity === 'player' ? game.player.team : this.ownerEntity?.team)
      ?? 'mash';
    this.size = opts.size;
    this.gravity = opts.gravity || 0;
    this.explosionRadius = opts.explosionRadius || 0;
    this.impactExplode = !!opts.impactExplode;
    this.fuse = opts.fuse || 0;
    this.timedFuse = (opts.fuse || 0) > 0;
    this.life = 5;
    this.dead = false;

    const geo = new THREE.SphereGeometry(this.size, 10, 8);
    geo.scale(1, 1.3, 1);
    const mat = new THREE.MeshStandardMaterial({
      color: opts.color || 0xffce5e,
      emissive: opts.color || 0xffce5e,
      emissiveIntensity: 0.25,
      roughness: 0.7,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.position.copy(this.position);
    this.mesh.rotation.set(Math.random(), Math.random(), Math.random());
    game.scene.add(this.mesh);
    this.spinAxis = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
  }

  update(dt) {
    this.life -= dt;
    if (this.life <= 0) { this.kill(); return; }

    if (this.timedFuse) {
      this.fuse -= dt;
      if (this.fuse <= 0) { this.explode(); return; }
    }

    // gravity applies once per frame
    this.velocity.y -= this.gravity * dt;
    this.mesh.rotateOnAxis(this.spinAxis, dt * 8);

    // swept stepping: split fast moves to prevent tunneling
    const totalDist = this.velocity.length() * dt;
    const stepLimit = Math.max(this.size * 1.2, 0.3);
    const subSteps = Math.max(1, Math.ceil(totalDist / stepLimit));
    const subDt = dt / subSteps;

    for (let s = 0; s < subSteps; s++) {
      this.position.addScaledVector(this.velocity, subDt);

      let hit = this.checkCollisions();
      if (hit === 'kill') return;
      if (hit) {
        if (this.timedFuse) {
          if (hit === 'ground') this.velocity.y *= -0.4;
          if (hit === 'wall') { this.velocity.x *= -0.5; this.velocity.z *= -0.5; }
          this.velocity.multiplyScalar(0.7);
        } else if (this.explosionRadius > 0) {
          this.explode();
          return;
        } else {
          // Surface impact thud — same sample as flesh hits, just quieter and
          // attenuated by distance from the camera.
          if (this.game.sfx && this.game.player) {
            const dist = this.position.distanceTo(this.game.player.position);
            const gain = Math.max(0, 1 - dist / 50);
            this.game.sfx.bulletImpact(gain * gain * 0.7);
          }
          this.kill();
          return;
        }
      }
    }
    this.mesh.position.copy(this.position);
  }

  // Returns: false (no hit), 'ground', 'wall', or 'kill' (already disposed)
  checkCollisions() {
    let hitType = false;

    if (this.position.y < this.size) {
      this.position.y = this.size;
      hitType = 'ground';
    }

    const B = this.game.arena.bounds;
    if (Math.abs(this.position.x) > B - this.size) {
      this.position.x = Math.sign(this.position.x) * (B - this.size);
      this.velocity.x *= -1;
      hitType = 'wall';
    }
    if (Math.abs(this.position.z) > B - this.size) {
      this.position.z = Math.sign(this.position.z) * (B - this.size);
      this.velocity.z *= -1;
      hitType = 'wall';
    }

    for (const obs of this.game.arena.obstacles) {
      const cx = obs.x + obs.w / 2;
      const cz = obs.z + obs.d / 2;
      const dx = this.position.x - cx;
      const dz = this.position.z - cz;
      const dy = this.position.y - obs.y;
      if (
        Math.abs(dx) < obs.w / 2 + this.size &&
        Math.abs(dz) < obs.d / 2 + this.size &&
        dy > -this.size &&
        dy < obs.h + this.size
      ) {
        hitType = 'wall';
        break;
      }
    }

    // entity hits — anyone that isn't the owner and isn't on the same team
    const player = this.game.player;
    const isPlayerOwner = this.ownerEntity === 'player' || this.ownerEntity === player;

    if (!isPlayerOwner && !player.dead && player.team !== this.ownerTeam) {
      const pc = player.position.clone();
      pc.y -= 0.4;
      if (pc.distanceTo(this.position) < PLAYER_HIT_RADIUS + this.size) {
        return this.handleEntityHit(player);
      }
    }

    for (const bot of this.game.bots) {
      if (bot.dead) continue;
      if (bot === this.ownerEntity) continue;
      if (bot.team === this.ownerTeam) continue;
      if (bot.position.distanceTo(this.position) < bot.radius + this.size) {
        return this.handleEntityHit(bot);
      }
    }

    // Remote-mirrored host bots (client-only). Damage is relayed to host via
    // hitBot event; host applies it authoritatively.
    if (this.game.remoteBots && this.game.remoteBots.size > 0) {
      for (const rb of this.game.remoteBots.values()) {
        if (rb.dead) continue;
        if (rb.team === this.ownerTeam) continue;
        if (rb.position.distanceTo(this.position) < rb.radius + this.size) {
          return this.handleEntityHit(rb);
        }
      }
    }

    // Remote multiplayer player — same hit interface as a Bot. Damage is
    // relayed to the peer via remote.damage() (sendEvent).
    const remote = this.game.remotePlayer;
    if (remote && !remote.dead && remote.team !== this.ownerTeam && remote !== this.ownerEntity) {
      if (remote.position.distanceTo(this.position) < remote.radius + this.size) {
        return this.handleEntityHit(remote);
      }
    }

    return hitType;
  }

  handleEntityHit(entity) {
    if (entity.spawnInvuln > 0) {
      // pass through entities still in spawn protection
      return false;
    }
    if (this.timedFuse) {
      this.velocity.multiplyScalar(-0.5);
      return false;
    }
    if (this.explosionRadius > 0) {
      this.explode();
      return 'kill';
    }
    // Headshot: projectile y is in upper third of entity
    const isHeadshot = (this.position.y - entity.position.y) > 0.45;
    let dmg = this.damage;
    const ownerIsPlayer = this.ownerEntity === 'player' || this.ownerEntity === this.game.player;
    if (isHeadshot) dmg *= 1.5;
    // Frenzy "headhunter" doubles headshot damage further
    if (isHeadshot && this.game.frenzy?.id === 'headhunter') dmg *= 2.0;
    // Player combo multiplier
    if (ownerIsPlayer) {
      dmg *= this.game.comboMultiplier();
      this.game.bumpCombo();
    }

    const wasAlive = !entity.dead;
    this.dealDamage(entity, dmg);
    // Bullet-impact thud — louder near the camera. Skip if entity is the local
    // player (their take-damage SFX already plays in player.damage()).
    if (this.game.sfx && this.game.player && entity !== this.game.player) {
      const dist = entity.position.distanceTo(this.game.player.position);
      this.game.sfx.bulletImpactAt(dist);
    }
    // Potato dying — fires when this hit was lethal. Player-death is handled
    // separately so we get the splat regardless of who pulled the trigger.
    if (wasAlive && entity.dead && this.game.sfx && this.game.player && entity !== this.game.player) {
      const dist = entity.position.distanceTo(this.game.player.position);
      this.game.sfx.potatoDeathAt(dist);
    }
    if (ownerIsPlayer) {
      this.game.flashHitMarker(isHeadshot ? 'crit' : 'hit');
      // Spud-chunk burst at the impact point — owner-only so it celebrates
      // YOUR hits, not bot-on-bot crossfire (which would be visual noise).
      this.game.spawnHitBurst(this.position, isHeadshot);
      const killed = wasAlive && entity.dead;
      const kind = killed ? 'kill' : (isHeadshot ? 'crit' : (dmg >= 60 ? 'crit' : 'hit'));
      this.game.spawnDamageNumber(entity.position, dmg, kind);
      // Hit-stop: a tiny pause on confirmed kill so the brain registers the moment.
      // Skipped for the multi-kill threshold which already does its own slow-mo.
      if (killed && (this.game.player.multiKill || 1) < 5) {
        this.game.triggerSlowMo(0.18, 0.07);
      }
      // Track shot accuracy — first projectile of a fire() counts as a hit on the trigger pull
      const player = this.game.player;
      if (player._shotPendingHit && player.matchStats) {
        player._shotPendingHit = false;
        player.matchStats.shotsHit++;
      }
      if (isHeadshot) {
        if (player.matchStats) player.matchStats.headshots++;
        if (this.game.progressChallenge) this.game.progressChallenge('headshots', 1);
        const pos = entity.position.clone(); pos.y += 0.6;
        this.game.spawnDamageNumber(pos, 'HEADSHOT', 'headshot');
        this.game.sfx.headshot && this.game.sfx.headshot();
      }
    }
    this.kill();
    return 'kill';
  }

  dealDamage(entity, dmg) {
    entity.damage(dmg, this.ownerEntity);
  }

  explode() {
    if (this.dead) return;
    const r = this.explosionRadius;
    const ownerIsPlayer = this.ownerEntity === 'player' || this.ownerEntity === this.game.player;
    if (this.game.sfx && this.game.player) {
      const dist = this.position.distanceTo(this.game.player.position);
      this.game.sfx.grenadeBoomAt(dist, 0.8);
    }

    const player = this.game.player;
    if (!player.dead && player.spawnInvuln <= 0) {
      const dp = player.position.distanceTo(this.position);
      if (dp < r) {
        const sameTeam = player.team === this.ownerTeam && !ownerIsPlayer;
        if (!sameTeam) {
          const f = 1 - dp / r;
          const selfMult = ownerIsPlayer ? 0.35 : 1;
          const dmg = this.damage * f * selfMult;
          player.damage(dmg, this.ownerEntity);
        }
      }
    }

    let killedSomeone = false;
    const damageTargets = [...this.game.bots];
    if (this.game.remoteBots) damageTargets.push(...this.game.remoteBots.values());
    if (this.game.remotePlayer && !this.game.remotePlayer.dead) damageTargets.push(this.game.remotePlayer);
    for (const bot of damageTargets) {
      if (bot.dead) continue;
      if (bot.spawnInvuln > 0) continue;
      const isSelf = bot === this.ownerEntity;
      const sameTeam = !isSelf && bot.team === this.ownerTeam;
      if (sameTeam) continue;
      const d = bot.position.distanceTo(this.position);
      if (d < r) {
        const f = 1 - d / r;
        const dmg = isSelf ? this.damage * f * 0.35 : this.damage * f;
        const wasAlive = !bot.dead;
        bot.damage(dmg, this.ownerEntity);
        if (wasAlive && bot.dead && this.game.sfx && this.game.player) {
          const dDist = bot.position.distanceTo(this.game.player.position);
          this.game.sfx.potatoDeathAt(dDist);
        }
        if (wasAlive && bot.dead && ownerIsPlayer) killedSomeone = true;
        if (ownerIsPlayer && wasAlive) {
          const kind = bot.dead ? 'kill' : (dmg >= 60 ? 'crit' : 'hit');
          this.game.spawnDamageNumber(bot.position, dmg, kind);
        }
      }
    }
    if (killedSomeone) this.game.flashHitMarker();

    this.game.spawnExplosion(this.position, r);
    this.kill();
  }

  kill() {
    if (this.dead) return;
    this.dead = true;
    this.game.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
