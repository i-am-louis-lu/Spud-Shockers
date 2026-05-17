// 2D nav grid with ground-height awareness so bots can climb stairs.
// Cells store the highest walkable surface (any obstacle.y == 0 with top below ~3.5).
// Walkable means: head clearance for a 1.7m bot above the ground height.

const STEP_LIMIT = 0.65;       // max delta between adjacent cells
const BOT_HEIGHT = 1.7;        // clearance required above ground
const MAX_GROUND = 5.0;        // ignore obstacles taller than this (roofs)

export class NavGrid {
  constructor(arena, cellSize = 1) {
    this.cellSize = cellSize;
    this.bounds = arena.bounds;
    this.cols = Math.ceil((arena.bounds * 2) / cellSize);
    this.rows = this.cols;
    this.heights = new Float32Array(this.cols * this.rows);
    this.walkable = new Uint8Array(this.cols * this.rows);
    this.compute(arena);
  }

  cellToWorld(c, r) {
    return [
      c * this.cellSize - this.bounds + this.cellSize / 2,
      r * this.cellSize - this.bounds + this.cellSize / 2,
    ];
  }

  worldToCell(x, z) {
    return [
      Math.floor((x + this.bounds) / this.cellSize),
      Math.floor((z + this.bounds) / this.cellSize),
    ];
  }

  inBounds(c, r) {
    return c >= 0 && c < this.cols && r >= 0 && r < this.rows;
  }

  idx(c, r) { return r * this.cols + c; }

  getHeightAt(x, z) {
    const [c, r] = this.worldToCell(x, z);
    if (!this.inBounds(c, r)) return 0;
    return this.heights[this.idx(c, r)];
  }

  compute(arena) {
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const [wx, wz] = this.cellToWorld(c, r);
        // walkable surface top — max obstacle top whose XZ overlaps cell, with obs.y == 0 (or near)
        let groundTop = 0;
        let blocked = false;
        for (const obs of arena.obstacles) {
          const cx = obs.x + obs.w / 2;
          const cz = obs.z + obs.d / 2;
          // Tight bounds for walkable-surface detection so we don't
          // teleport ground heights onto cells next to low cover.
          if (Math.abs(wx - cx) >= obs.w / 2 + 0.05) continue;
          if (Math.abs(wz - cz) >= obs.d / 2 + 0.05) continue;
          const top = obs.y + obs.h;
          if (obs.y < 0.05 && top <= MAX_GROUND && top > groundTop) {
            groundTop = top;
          }
        }
        // clearance: any obstacle whose Y range covers (groundTop, groundTop + BOT_HEIGHT)?
        let clearanceBlocked = false;
        for (const obs of arena.obstacles) {
          const cx = obs.x + obs.w / 2;
          const cz = obs.z + obs.d / 2;
          if (Math.abs(wx - cx) >= obs.w / 2 + 0.45) continue;
          if (Math.abs(wz - cz) >= obs.d / 2 + 0.45) continue;
          const obsTop = obs.y + obs.h;
          const obsBot = obs.y;
          if (obsTop <= groundTop + 0.05) continue; // it IS the ground
          if (obsBot < groundTop + BOT_HEIGHT - 0.1) {
            clearanceBlocked = true;
            break;
          }
        }
        const i = this.idx(c, r);
        this.heights[i] = groundTop;
        this.walkable[i] = clearanceBlocked ? 0 : 1;
      }
    }
  }

  // straight-line walkability test (used for path smoothing)
  losClear(ax, az, bx, bz) {
    const dx = bx - ax, dz = bz - az;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const steps = Math.max(2, Math.ceil(dist / (this.cellSize * 0.5)));
    let lastH = this.getHeightAt(ax, az);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = ax + dx * t;
      const z = az + dz * t;
      const [c, r] = this.worldToCell(x, z);
      if (!this.inBounds(c, r)) return false;
      const idx = this.idx(c, r);
      if (!this.walkable[idx]) return false;
      const h = this.heights[idx];
      if (Math.abs(h - lastH) > STEP_LIMIT) return false;
      lastH = h;
    }
    return true;
  }

  findPath(startX, startZ, endX, endZ) {
    const [sc, sr] = this.worldToCell(startX, startZ);
    let [ec, er] = this.worldToCell(endX, endZ);
    if (!this.inBounds(sc, sr)) return null;
    if (!this.inBounds(ec, er)) return null;
    if (sc === ec && sr === er) return [{ x: endX, z: endZ, y: this.heights[this.idx(ec, er)] }];

    // if end cell unwalkable, find nearest walkable
    if (!this.walkable[this.idx(ec, er)]) {
      let best = null, bestD = Infinity;
      for (let dr = -3; dr <= 3; dr++) {
        for (let dc = -3; dc <= 3; dc++) {
          const c = ec + dc, r = er + dr;
          if (!this.inBounds(c, r)) continue;
          if (!this.walkable[this.idx(c, r)]) continue;
          const d = dc * dc + dr * dr;
          if (d < bestD) { bestD = d; best = [c, r]; }
        }
      }
      if (!best) return null;
      [ec, er] = best;
    }

    const cameFrom = new Map();
    const gScore = new Map();
    const startKey = this.idx(sc, sr);
    const endKey = this.idx(ec, er);
    gScore.set(startKey, 0);

    // simple binary-heap-free open list (fine for grids this size)
    const open = [{ f: this.heuristic(sc, sr, ec, er), c: sc, r: sr }];
    const closed = new Uint8Array(this.cols * this.rows);
    let iter = 0;
    const maxIter = 20000;

    while (open.length > 0 && iter++ < maxIter) {
      // pop lowest f
      let best = 0;
      for (let i = 1; i < open.length; i++) if (open[i].f < open[best].f) best = i;
      const cur = open.splice(best, 1)[0];
      const key = this.idx(cur.c, cur.r);
      if (closed[key]) continue;
      closed[key] = 1;
      if (key === endKey) {
        const path = [];
        let k = key;
        while (k !== startKey) {
          const cc = k % this.cols;
          const rr = Math.floor(k / this.cols);
          const [wx, wz] = this.cellToWorld(cc, rr);
          path.unshift({ x: wx, z: wz, y: this.heights[k] });
          k = cameFrom.get(k);
        }
        return this.smooth(path);
      }
      const curH = this.heights[key];
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nc = cur.c + dc, nr = cur.r + dr;
          if (!this.inBounds(nc, nr)) continue;
          const nKey = this.idx(nc, nr);
          if (closed[nKey] || !this.walkable[nKey]) continue;
          const dh = this.heights[nKey] - curH;
          if (Math.abs(dh) > STEP_LIMIT) continue;
          if (dr !== 0 && dc !== 0) {
            // diagonal corner squeeze
            if (!this.walkable[this.idx(cur.c + dc, cur.r)]) continue;
            if (!this.walkable[this.idx(cur.c, cur.r + dr)]) continue;
          }
          const moveCost = (dr !== 0 && dc !== 0) ? 1.41 : 1.0;
          const tg = (gScore.get(key) ?? Infinity) + moveCost + Math.abs(dh) * 1.5;
          if (tg >= (gScore.get(nKey) ?? Infinity)) continue;
          cameFrom.set(nKey, key);
          gScore.set(nKey, tg);
          const f = tg + this.heuristic(nc, nr, ec, er);
          open.push({ f, c: nc, r: nr });
        }
      }
    }
    return null;
  }

  smooth(path) {
    if (path.length <= 2) return path;
    const out = [path[0]];
    let i = 0;
    while (i < path.length - 1) {
      let j = path.length - 1;
      // find furthest j with line-of-sight
      while (j > i + 1) {
        if (this.losClear(path[i].x, path[i].z, path[j].x, path[j].z)) break;
        j--;
      }
      out.push(path[j]);
      i = j;
    }
    return out;
  }

  heuristic(c1, r1, c2, r2) {
    const dx = Math.abs(c2 - c1);
    const dz = Math.abs(r2 - r1);
    return Math.max(dx, dz) + 0.41 * Math.min(dx, dz);
  }
}
