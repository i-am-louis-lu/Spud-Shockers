// Tiny Web Audio SFX bank — mostly synthesized, plus a small MP3 sample bank
// for gunshot / grenade / knife. Lazy-init on user gesture (start button)
// since browsers block audio before that.

// Per-weapon playback-rate map for the shared gunshot sample. Faster guns get
// higher pitch + faster decay, slower guns get a heavier, deeper boom.
const GUN_PLAYBACK_RATES = {
  spudgun:     1.15,
  fryer:       1.35,   // full-auto, light & snappy
  hashbrowner: 0.85,   // shotgun thud
  masher:      0.75,   // big double-barrel boom
  spudling:    1.55,   // SMG, very fast/pingy
  boomstick:   0.65,   // sniper — slow, deep
};

export class SFX {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.sampleGain = null;
    this.buffers = {};          // name -> AudioBuffer
    this._loadStarted = false;
    this._lastSampleAt = {};    // name -> ctx.currentTime of last play (cheap throttle)
  }

  ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      this._kickoffSampleLoad();
      return;
    }
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    this.ctx = new Ctor();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.2;       // was 0.4 — halved overall synth SFX
    this.masterGain.connect(this.ctx.destination);
    // Separate gain stage for MP3 samples (gunshot/grenade/knife/impact/death).
    // Halved from 0.85 -> 0.42 so the gunshot doesn't blow out speakers during
    // sustained full-auto fire.
    this.sampleGain = this.ctx.createGain();
    this.sampleGain.gain.value = 0.42;
    this.sampleGain.connect(this.ctx.destination);
    this._kickoffSampleLoad();
  }

  _kickoffSampleLoad() {
    if (this._loadStarted) return;
    this._loadStarted = true;
    const files = {
      gunshot: 'sounds/gunshot.mp3',
      grenade: 'sounds/grenade.mp3',
      knife:   'sounds/knife.mp3',
      impact:  'sounds/impact.mp3',
      death:   'sounds/death.mp3',
      reload:  'sounds/reload.mp3',
    };
    for (const [key, url] of Object.entries(files)) {
      fetch(url)
        .then((r) => r.arrayBuffer())
        .then((buf) => new Promise((res, rej) => this.ctx.decodeAudioData(buf, res, rej)))
        .then((decoded) => { this.buffers[key] = decoded; })
        .catch((err) => console.warn('[sfx] failed to load', url, err));
    }
  }

  // Play one of the MP3 samples with an optional playback rate (pitch+speed).
  // Cheap throttle stops e.g. spudling spamming 17 overlapping shots/sec from
  // shredding speakers.
  playSample(name, { rate = 1, gain = 1, minGapMs = 0 } = {}) {
    if (!this.ctx) return;
    const buf = this.buffers[name];
    if (!buf) return;
    const now = this.ctx.currentTime;
    if (minGapMs > 0) {
      const last = this._lastSampleAt[name] || 0;
      if ((now - last) * 1000 < minGapMs) return;
      this._lastSampleAt[name] = now;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    if (gain !== 1) {
      const g = this.ctx.createGain();
      g.gain.value = gain;
      src.connect(g);
      g.connect(this.sampleGain);
    } else {
      src.connect(this.sampleGain);
    }
    src.start(now);
  }

  // Play the shared gunshot sample for a given weapon key. Looks up the
  // weapon-specific playback rate from GUN_PLAYBACK_RATES. distGain = 1.0
  // means full volume (used for the local player). Bots pass a smaller gain
  // based on distance from the camera.
  gunshot(weaponKey, distGain = 1.0) {
    if (distGain <= 0.02) return;
    const rate = GUN_PLAYBACK_RATES[weaponKey] ?? 1.0;
    // Gain dropped 0.95 → 0.55 — gunfire was drowning out the music and the
    // reload sample, especially during sustained full-auto fire.
    this.playSample('gunshot', { rate, gain: 0.55 * distGain, minGapMs: 35 });
  }
  // Grenade launcher fire / impact thump
  grenadeBoom(rate = 1.0, distGain = 1.0) {
    if (distGain <= 0.02) return;
    this.playSample('grenade', { rate, gain: 1.0 * distGain, minGapMs: 60 });
  }
  // Knife stab — short stab sample
  knifeStab(distGain = 1.0) {
    if (distGain <= 0.02) return;
    this.playSample('knife', { rate: 1.0, gain: 1.0 * distGain, minGapMs: 40 });
  }

  // Reload — plays the loaded reload mp3 ONCE, time-stretched (via playback
  // rate) to perfectly match `targetSec`. No looping, so it never repeats
  // itself even on long reloads. Pitch drops on longer reloads as a side
  // effect (rate < 1), which actually sells the "long, deliberate" feel.
  reloadSample(targetSec, gain = 1.6) {
    if (!this.ctx) return null;
    const buf = this.buffers.reload;
    if (!buf) return null;
    if (this._reloadSrc) {
      try { this._reloadSrc.stop(); } catch (_) {}
      this._reloadSrc = null;
    }
    const now = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = false;
    // Exact fit: natural-duration / target-duration = playback rate. Clamp
    // softly so the pitch doesn't get extreme on edge cases.
    const natural = buf.duration;
    const rawRate = natural / Math.max(0.1, targetSec);
    src.playbackRate.value = Math.max(0.35, Math.min(2.2, rawRate));
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    g.connect(this.sampleGain);
    src.start(now);
    src.onended = () => { if (this._reloadSrc === src) this._reloadSrc = null; };
    this._reloadSrc = src;
    return src;
  }

  // Explicit stop — call when reload is cancelled (weapon swap, death) so
  // the looped reload sound doesn't keep playing.
  reloadSampleStop() {
    if (this._reloadSrc) {
      try { this._reloadSrc.stop(); } catch (_) {}
      this._reloadSrc = null;
    }
  }

  // Convenience: distance-attenuated gunshot for non-local shooters. Audible
  // out to ~60m, half-volume at ~25m.
  gunshotAt(weaponKey, distance) {
    const gain = Math.max(0, 1 - distance / 60);
    this.gunshot(weaponKey, gain * gain);   // square falloff for a punchy near-field feel
  }
  grenadeBoomAt(distance, rate = 0.95) {
    const gain = Math.max(0, 1 - distance / 80);
    this.grenadeBoom(rate, gain * gain);
  }
  knifeStabAt(distance) {
    const gain = Math.max(0, 1 - distance / 25);
    this.knifeStab(gain * gain);
  }

  // Bullet impact on a potato — short wet thud. Rate jittered a touch so
  // rapid hits don't sound like one tone.
  bulletImpact(distGain = 1.0) {
    if (distGain <= 0.02) return;
    this.playSample('impact', { rate: 0.95 + Math.random() * 0.2, gain: 0.85 * distGain, minGapMs: 25 });
  }
  bulletImpactAt(distance) {
    const gain = Math.max(0, 1 - distance / 55);
    this.bulletImpact(gain * gain);
  }
  // Potato dying — longer splat/groan
  potatoDeath(distGain = 1.0) {
    if (distGain <= 0.02) return;
    this.playSample('death', { rate: 0.92 + Math.random() * 0.15, gain: 0.95 * distGain, minGapMs: 50 });
  }
  potatoDeathAt(distance) {
    const gain = Math.max(0, 1 - distance / 70);
    this.potatoDeath(gain * gain);
  }

  // One-shot oscillator with attack-decay envelope.
  beep(freq, duration, type = 'square', vol = 0.3, freqEnd = null) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (freqEnd != null) osc.frequency.exponentialRampToValueAtTime(freqEnd, t + duration);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  // Player landed a shot on an enemy — short bright blip.
  hit() { this.beep(900, 0.05, 'square', 0.35, 1500); }

  // Player killed someone — two-tone rising chime.
  kill() {
    this.beep(660, 0.09, 'square', 0.45, 990);
    setTimeout(() => this.beep(990, 0.14, 'square', 0.5, 1480), 70);
  }

  // Player took damage — short low thud.
  damage() { this.beep(180, 0.12, 'sawtooth', 0.45, 90); }

  // Player triggered a special move — three-tone fanfare.
  special() {
    this.beep(440, 0.08, 'square', 0.35);
    setTimeout(() => this.beep(660, 0.08, 'square', 0.4), 60);
    setTimeout(() => this.beep(880, 0.16, 'square', 0.45, 1320), 130);
  }

  // Killstreak announcement — escalating fanfare based on streak length.
  streak(level = 2) {
    const freqs = [
      [600, 800],                         // 2: double
      [600, 800, 1100],                   // 3: triple
      [550, 800, 1100, 1400],             // 5: frenzy
      [500, 700, 1000, 1400, 1800],       // 7: domination
      [440, 660, 880, 1320, 1760, 2100],  // 10+: unstoppable
    ];
    const idx = level >= 10 ? 4 : level >= 7 ? 3 : level >= 5 ? 2 : level >= 3 ? 1 : 0;
    const seq = freqs[idx];
    seq.forEach((f, i) => setTimeout(() => this.beep(f, 0.14, 'square', 0.45), i * 70));
  }

  // Match win — triumphant arpeggio.
  win() {
    [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => this.beep(f, 0.18, 'square', 0.5), i * 110));
  }

  // Match loss — descending sad trombone-ish.
  lose() {
    [400, 350, 300, 240].forEach((f, i) => setTimeout(() => this.beep(f, 0.22, 'sawtooth', 0.4), i * 140));
  }

  // Killstreak reward triggered — bigger, brighter than streak fanfare.
  killstreak() {
    [600, 900, 1200, 1500, 1800, 2200].forEach((f, i) =>
      setTimeout(() => this.beep(f, 0.16, 'square', 0.5), i * 65));
  }

  // Frenzy event begins — rising sweep.
  frenzy() {
    this.beep(440, 0.45, 'sawtooth', 0.4, 1320);
    setTimeout(() => this.beep(880, 0.25, 'square', 0.5), 380);
  }

  // Daily challenge complete — celebratory chime.
  challenge() {
    [784, 988, 1318, 1568].forEach((f, i) =>
      setTimeout(() => this.beep(f, 0.16, 'triangle', 0.5), i * 80));
  }

  // Headshot — sharp bright ping with downward sweep.
  headshot() { this.beep(2400, 0.07, 'square', 0.45, 1200); }

  // Kill-confirmed — descending two-tone "ding-dong" to distinguish from hits.
  killConfirm() {
    this.beep(1600, 0.06, 'square', 0.40, 1100);
    setTimeout(() => this.beep(1200, 0.10, 'square', 0.40, 900), 55);
  }

  // Low-ammo click — soft tick (called when mag drops to ≤25%).
  lowAmmo() { this.beep(520, 0.04, 'triangle', 0.22, 380); }

  // Airdrop incoming — descending whistle followed by thunk.
  airdrop() {
    this.beep(1800, 0.18, 'sine', 0.30, 600);
    setTimeout(() => this.beep(360, 0.12, 'square', 0.40, 240), 150);
  }

  // Soft lock acquired — two quick chirps.
  lockOn() {
    this.beep(1400, 0.05, 'square', 0.35, 1900);
    setTimeout(() => this.beep(1900, 0.06, 'square', 0.35, 2300), 50);
  }
  // Lock released
  lockOff() { this.beep(800, 0.06, 'sine', 0.25, 500); }

  // Player opened chat box — soft pop
  chatOpen() { this.beep(620, 0.05, 'sine', 0.18, 820); }
  // Outgoing chat sent — bubble pop
  chatSend() { this.beep(900, 0.04, 'triangle', 0.22, 1200); }
  // Incoming chat from a bot — very subtle click
  chatPing() { this.beep(1100, 0.02, 'sine', 0.08); }

  // Push-through / comeback rally — escalating triumph
  rally() {
    [330, 440, 550, 660].forEach((f, i) =>
      setTimeout(() => this.beep(f, 0.16, 'sawtooth', 0.35, f * 1.5), i * 80));
  }
}
