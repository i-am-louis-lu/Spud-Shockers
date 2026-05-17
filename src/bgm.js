// Background music — shuffles through phonk tracks in music/, crossfades on
// track end, ducks during the shop, skips on match end. Volume + mute persist
// across sessions via localStorage. Uses two HTMLAudioElements (A/B) to allow
// proper crossfade without dropping a beat.

const TRACKS = [
  'dia-delicia.mp3',
  'gigachad-theme.mp3',
  'heavenly-jumpstyle.mp3',
  'montagem-rugada.mp3',
  'montagem-supersonic.mp3',
  'montagem-xonada.mp3',
  'murder-in-my-mind.mp3',
];

const FADE_MS = 1500;
const STORE_VOL = 'spudshockers.bgmvol';
const STORE_MUTE = 'spudshockers.bgmmute';

function shuffled(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export class BGM {
  constructor() {
    this.tracks = TRACKS;
    this.queue = shuffled(this.tracks);
    this.queueIdx = 0;
    this.audioA = this._makeAudio();
    this.audioB = this._makeAudio();
    this.current = this.audioA;
    this.next = this.audioB;
    const v = parseFloat(localStorage.getItem(STORE_VOL) || '0.45');
    this.userVolume = isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.45;
    this.muted = localStorage.getItem(STORE_MUTE) === '1';
    this.duck = 1;
    this.started = false;
    this._crossfading = false;
    this._tickInterval = null;
    this.currentTrackName = '';
  }

  _makeAudio() {
    const a = new Audio();
    a.preload = 'auto';
    a.volume = 0;
    return a;
  }

  _nextTrack() {
    if (this.queueIdx >= this.queue.length) {
      this.queue = shuffled(this.tracks);
      this.queueIdx = 0;
    }
    return this.queue[this.queueIdx++];
  }

  start() {
    if (this.started) return;
    this.started = true;
    this._playNext(this.current);
    this._tickInterval = setInterval(() => this._tick(), 250);
  }

  _playNext(audio) {
    const track = this._nextTrack();
    this.currentTrackName = track;
    audio.src = `music/${track}`;
    audio.currentTime = 0;
    audio.volume = this._targetVol();
    const p = audio.play();
    if (p && p.catch) p.catch(() => {/* autoplay blocked — first user gesture will retry */});
  }

  _tick() {
    if (!this.started) return;
    const cur = this.current;
    if (!cur || cur.paused) return;
    if (!isFinite(cur.duration) || cur.duration <= 0) return;
    const remaining = cur.duration - cur.currentTime;
    if (remaining > 0 && remaining < FADE_MS / 1000 && !this._crossfading) {
      this._crossfadeToNext();
    }
  }

  skip() {
    if (!this.started) return;
    this._crossfadeToNext();
  }

  _crossfadeToNext() {
    if (this._crossfading) return;
    this._crossfading = true;
    this._playNext(this.next);
    this.next.volume = 0;
    const startVol = this._targetVol();
    const startTime = performance.now();
    const from = this.current;
    const to = this.next;
    const fade = () => {
      const t = Math.min(1, (performance.now() - startTime) / FADE_MS);
      // Apply current target each frame so mid-fade duck/mute changes feel live
      const tgt = this._targetVol();
      from.volume = Math.max(0, startVol * (1 - t));
      to.volume = Math.max(0, tgt * t);
      if (t >= 1) {
        from.pause();
        from.currentTime = 0;
        this.current = to;
        this.next = from;
        this._crossfading = false;
        return;
      }
      requestAnimationFrame(fade);
    };
    requestAnimationFrame(fade);
  }

  _targetVol() {
    return this.muted ? 0 : this.userVolume * this.duck;
  }

  setUserVolume(v) {
    this.userVolume = Math.max(0, Math.min(1, v));
    localStorage.setItem(STORE_VOL, String(this.userVolume));
    this._applyVolume();
  }

  setDuck(d) {
    if (d === this.duck) return;
    this.duck = d;
    this._applyVolume();
  }

  toggleMute() {
    this.muted = !this.muted;
    localStorage.setItem(STORE_MUTE, this.muted ? '1' : '0');
    this._applyVolume();
    return this.muted;
  }

  _applyVolume() {
    if (this._crossfading) return;
    if (this.current) this.current.volume = this._targetVol();
  }
}
