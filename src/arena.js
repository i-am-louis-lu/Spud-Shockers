import * as THREE from 'three';

// Banner colors used by HUD/projectiles. Mash = red banner faction, Russet = blue.
export const TEAM_COLORS = {
  mash: 0xc23a3a,
  russet: 0x3a5cc2,
};
// Trim/stone shade used for team-tinted accents
export const TEAM_TINTS = {
  mash: 0x6e2828,
  russet: 0x28386e,
};

const SPAWN_GUARD = 6;

// Step height limit — must stay <= player STEP_HEIGHT (0.6) and <= NavGrid STEP_LIMIT (0.65)
const STEP_H = 0.55;

// Material palette (cached by color so we share materials across many meshes)
const _matCache = new Map();
function mat(color, opts = {}) {
  const key = color + (opts.flat ? '_f' : '') + (opts.basic ? '_b' : '');
  if (_matCache.has(key)) return _matCache.get(key);
  const m = opts.basic
    ? new THREE.MeshBasicMaterial({ color })
    : new THREE.MeshLambertMaterial({ color, flatShading: !!opts.flat });
  _matCache.set(key, m);
  return m;
}

// Themed color palette
const C = {
  stone:      0x8f8d83,
  stoneLight: 0xa9a69b,
  stoneDark:  0x5e5b53,
  mortar:     0x4a4842,
  wood:       0x8a5a32,
  woodMid:    0x6b3e1d,
  woodDark:   0x40250f,
  thatch:     0xc8a558,
  thatchDark: 0x9a7838,
  hay:        0xd6a64a,
  grass:      0x4f8c3a,
  grassMid:   0x5fa048,
  grassDark:  0x3d7028,
  dirt:       0x7a5a3a,
  dirtDark:   0x5c4228,
  trunk:      0x4a2e1a,
  foliage1:   0x2a5a30,
  foliage2:   0x346a3a,
  boulder:    0xa39f93,
  boulderDk:  0x807c70,
  banner:     0x9a2a2a, // generic red — overridden per team
  flagpole:   0x3a2418,
  iron:       0x2a2a2e,
  torch:      0xff8830,
  sky:        0xa6c8e0,
  mountain:   0x6b7d8e, // distant silhouette
};

export class Arena {
  constructor(scene) {
    this.scene = scene;
    this.bounds = 100; // playable area is bounds*2 on each side
    this.obstacles = [];
    this.ladders = [];
    this.pickupSpawns = [];
    this.teamSpawns = { mash: [], russet: [] };
    this.teamSpawnZones = { mash: null, russet: null };
    this.build();
  }

  // --- low-level helpers ---

  // Solid axis-aligned obstacle (collidable + pathable)
  addBox(x, y, z, w, h, d, color = C.stone) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color));
    m.position.set(x + w / 2, y + h / 2, z + d / 2);
    m.castShadow = true;
    m.receiveShadow = true;
    this.scene.add(m);
    this.obstacles.push({ x, y, z, w, h, d, mesh: m });
    return m;
  }

  // Decorative mesh — added to scene only, NOT to obstacles (no collision)
  addDecor(mesh, { cast = true, recv = true } = {}) {
    mesh.castShadow = cast;
    mesh.receiveShadow = recv;
    this.scene.add(mesh);
    return mesh;
  }

  // Crenellated parapet on top of a wall segment (alternating merlons + gaps).
  // Wall lies along the longer of (w, d). Merlons are decorative — not obstacles.
  addMerlons(x, y, z, w, d, color = C.stoneLight) {
    const along = w >= d ? 'x' : 'z';
    const length = along === 'x' ? w : d;
    const thickness = along === 'x' ? d : w;
    const merlonW = 0.7;
    const gap = 0.5;
    const period = merlonW + gap;
    const count = Math.max(1, Math.floor(length / period));
    const totalUsed = count * merlonW + (count - 1) * gap;
    const startOff = (length - totalUsed) / 2;
    for (let i = 0; i < count; i++) {
      const off = startOff + i * period;
      const mx = along === 'x' ? x + off : x;
      const mz = along === 'z' ? z + off : z;
      const mw = along === 'x' ? merlonW : thickness;
      const md = along === 'z' ? merlonW : thickness;
      const m = new THREE.Mesh(new THREE.BoxGeometry(mw, 0.55, md), mat(color));
      m.position.set(mx + mw / 2, y + 0.275, mz + md / 2);
      m.castShadow = true;
      m.receiveShadow = true;
      this.scene.add(m);
    }
  }

  // --- main build ---

  build() {
    this.scene.background = new THREE.Color(C.sky);
    this.scene.fog = new THREE.Fog(C.sky, 110, 300);

    this.buildGround();
    this.buildDistantMountains();
    this.buildPerimeter();

    // Castle keeps at each end (door faces center) — UNCHANGED, spawn points
    this.buildCastleKeep('mash', 0, 88);
    this.buildCastleKeep('russet', 0, -88);

    // Central stepped hill — flat-top, climbable, no ruined-tower walls
    this.buildWatchtowerHill(0, 0);

    // Flanking ladder towers — kept (they have ladders), visuals simplified
    this.buildSquareTower(62, 0, 4.5, 6.5);
    this.buildSquareTower(-62, 0, 5.0, 5.5);

    // Tall walled outposts (ladder-only access to the top) — UNCHANGED
    this.buildOutpost(32, 32);
    this.buildOutpost(-44, -36);
    this.buildOutpost(44, 44);
    this.buildOutpost(-32, 28);
    this.buildOutpost(36, -40);

    // Simplified cover blocks (replaces tavern / archer platform / stone huts).
    // Single-box bodies — solid cover, no interiors, no roofs. Pickups for
    // these spots are relocated to ground level.
    this.buildBlock(32, -32, 8, 3.0, 8, C.wood);
    this.buildBlock(-36, 36, 8, 2.6, 8, C.wood);
    this.buildBlock(-44, -44, 6, 2.4, 5, C.stone);
    this.buildBlock(48, -20, 6, 2.4, 5, C.stone);
    this.buildBlock(-48, 20, 6, 2.4, 5, C.stone);

    // Low one-tier hill blocks (outer ring) — were 8 stepped hills, now 4 flat
    this.buildLowMound(-68, 32, 7);
    this.buildLowMound(70, -34, 6);
    this.buildLowMound(-22, -58, 6);
    this.buildLowMound(24, 58, 6);

    // Mid-field cover (already lightweight — pruned slightly)
    this.buildMidCover();

    // Battlefield content additions
    this.buildSideFort(-55, -55, 'n');
    this.buildSideFort( 55,  55, 's');
    this.buildSteepPeak(-80,  35);
    this.buildSteepPeak( 80, -35);
    this.buildRidge(-25,  55, 15, 1);
    this.buildRidge( 25, -55, 15, 1);
    this.placeSandbags();
    this.placeTankTraps();
    this.placeFences();
    this.placeSpikes();

    // Multi-tier climbable mega-hills — high-ground sniping perches at ~6m
    this.buildMegaHill( 78,  70);
    this.buildMegaHill(-78, -70);
    // High-ground crossings — four solid raised catwalks split across each
    // mid-field band so the central spawn corridor stays clear at x=0.
    this.buildCatwalk(18,  18, 18);   // N-east bridge
    this.buildCatwalk(18, -18, 18);   // N-west bridge
    this.buildCatwalk(-18, 18, 18);   // S-east bridge
    this.buildCatwalk(-18,-18, 18);   // S-west bridge

    // Decoration — counts trimmed for perf
    this.scatterTrees();
    this.scatterBoulders();
    this.placeBanners();

    // Pickups — heights match the new structure tops. Former 2nd-floor /
    // platform pickups dropped to ground since those buildings are now solid.
    this.pickupSpawns = [
      { type: 'health',  position: new THREE.Vector3(0, 3.4, 0) },     // watchtower top
      { type: 'ammo',    position: new THREE.Vector3(62, 7.4, 0) },    // east tower top
      { type: 'ammo',    position: new THREE.Vector3(-62, 6.4, 0) },   // west tower top
      { type: 'health',  position: new THREE.Vector3(32, 6.5, 32) },   // outpost top
      { type: 'health',  position: new THREE.Vector3(-44, 6.5, -36) }, // outpost top
      { type: 'grenade', position: new THREE.Vector3(-36, 0.6, 30) },  // near south wood block
      { type: 'grenade', position: new THREE.Vector3(36, 0.6, -26) },  // near north wood block
      { type: 'ammo',    position: new THREE.Vector3(0, 0.6, 26) },
      { type: 'ammo',    position: new THREE.Vector3(0, 0.6, -26) },
      { type: 'health',  position: new THREE.Vector3(28, 0.6, -28) },
      { type: 'ammo',    position: new THREE.Vector3(-28, 0.6, 28) },
      // High-ground perches on the mega-hills + catwalks
      { type: 'health',  position: new THREE.Vector3( 78, 7.3,  70) }, // east mega-hill peak
      { type: 'health',  position: new THREE.Vector3(-78, 7.3, -70) }, // west mega-hill peak
      { type: 'ammo',    position: new THREE.Vector3( 18, 4.5,  18) }, // N-east catwalk center
      { type: 'ammo',    position: new THREE.Vector3(-18, 4.5,  18) }, // N-west catwalk center
      { type: 'ammo',    position: new THREE.Vector3( 18, 4.5, -18) }, // S-east catwalk center
      { type: 'ammo',    position: new THREE.Vector3(-18, 4.5, -18) }, // S-west catwalk center
    ];
  }

  // Single solid cover block — replaces multi-mesh tavern / platforms / huts.
  buildBlock(cx, cz, w, h, d, color = C.stone) {
    this.addBox(cx - w / 2, 0, cz - d / 2, w, h, d, color);
  }

  // Single-tier hill — replaces the previous multi-step buildHill.
  buildLowMound(cx, cz, r) {
    const h = STEP_H * 2;
    this.addBox(cx - r, 0, cz - r, r * 2, h, r * 2, C.grassMid);
  }

  // --- terrain ---

  buildGround() {
    // Base grass plane with subtle vertex-color variation
    const seg = 48;
    const geo = new THREE.PlaneGeometry(this.bounds * 2, this.bounds * 2, seg, seg);
    const colors = new Float32Array(geo.attributes.position.count * 3);
    const base = new THREE.Color(C.grass);
    const alt = new THREE.Color(C.grassMid);
    const dark = new THREE.Color(C.grassDark);
    for (let i = 0; i < geo.attributes.position.count; i++) {
      const r = Math.random();
      const c = r < 0.18 ? dark : r < 0.55 ? base : alt;
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const ground = new THREE.Mesh(
      geo,
      new THREE.MeshLambertMaterial({ vertexColors: true })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // Worn dirt patches near high-traffic areas
    for (let i = 0; i < 20; i++) {
      const r = 1.0 + Math.random() * 2.4;
      const patch = new THREE.Mesh(
        new THREE.CircleGeometry(r, 10),
        mat(Math.random() < 0.5 ? C.dirt : C.dirtDark)
      );
      patch.rotation.x = -Math.PI / 2;
      patch.position.set(
        (Math.random() - 0.5) * 1.7 * this.bounds,
        0.012,
        (Math.random() - 0.5) * 1.7 * this.bounds
      );
      patch.receiveShadow = true;
      this.scene.add(patch);
    }

    // Cobblestone path stripe between the two keeps
    const pathW = 3.5;
    const path = new THREE.Mesh(
      new THREE.PlaneGeometry(pathW, this.bounds * 1.5),
      mat(0x7d756a)
    );
    path.rotation.x = -Math.PI / 2;
    path.position.set(0, 0.014, 0);
    path.receiveShadow = true;
    this.scene.add(path);
  }

  buildDistantMountains() {
    // Ring of low-poly cones around the perimeter, outside the playable area
    const ringR = 165;
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2 + Math.random() * 0.1;
      const rJ = ringR + (Math.random() - 0.5) * 30;
      const x = Math.cos(angle) * rJ;
      const z = Math.sin(angle) * rJ;
      const h = 18 + Math.random() * 22;
      const r = 14 + Math.random() * 10;
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(r, h, 5 + Math.floor(Math.random() * 2)),
        mat(Math.random() < 0.5 ? C.mountain : 0x586a7d, { flat: true })
      );
      cone.position.set(x, h / 2 - 2, z);
      cone.rotation.y = Math.random() * Math.PI;
      this.addDecor(cone, { cast: false, recv: false });
    }
  }

  buildPerimeter() {
    // Stone curtain wall around the playable area, with battlements on top
    const wallH = 5.5;
    const t = 1.6;
    const b = this.bounds;

    // Four wall slabs — trimmed at the ends by the corner-tower width so
    // wall AABBs don't overlap corner-tower AABBs. Overlapping boxes were
    // causing players to get pushed back and forth at the corners (glitchy
    // collision resolution).
    const cornerW = 3;
    const slabs = [
      [-b + cornerW, -b - t / 2, b * 2 - cornerW * 2, t],          // north (z = -b)
      [-b + cornerW,  b - t / 2, b * 2 - cornerW * 2, t],          // south (z = +b)
      [-b - t / 2, -b + cornerW, t, b * 2 - cornerW * 2],          // west
      [ b - t / 2, -b + cornerW, t, b * 2 - cornerW * 2],          // east
    ];
    for (const [x, z, w, d] of slabs) {
      this.addBox(x, 0, z, w, wallH, d, C.stone);
      // merlons on top — long axis follows the wall
      this.addMerlons(x, wallH, z, w, d, C.stoneLight);
    }

    // Corner watchtowers (taller than the wall, with merlons). Now flush with
    // the trimmed wall ends so there's no overlapping AABB at the corners.
    const corners = [[-b, -b], [b - cornerW, -b], [-b, b - cornerW], [b - cornerW, b - cornerW]];
    for (const [cx, cz] of corners) {
      this.addBox(cx, 0, cz, cornerW, 7, cornerW, C.stoneDark);
      this.addBox(cx - 0.2, 7, cz - 0.2, cornerW + 0.4, 0.3, cornerW + 0.4, C.stone); // overhang lip
      this.addMerlons(cx - 0.2, 7.3, cz - 0.2, cornerW + 0.4, cornerW + 0.4, C.stoneLight);
    }
  }

  // --- castle keep (team spawn) ---

  buildCastleKeep(team, cx, cz) {
    const accent = TEAM_COLORS[team];
    const trim = TEAM_TINTS[team];
    const stone = C.stone;
    const stoneL = C.stoneLight;

    const w = 18, d = 12, h = 5, t = 0.9;
    const minX = cx - w / 2, maxX = cx + w / 2;
    const minZ = cz - d / 2, maxZ = cz + d / 2;

    // Door faces the arena center
    const doorOnLowZ = cz > 0;
    const frontZ = doorOnLowZ ? minZ : maxZ - t;
    const backZ = doorOnLowZ ? maxZ - t : minZ;
    const frontFaceZ = doorOnLowZ ? minZ : maxZ;

    // Curtain walls
    this.addBox(minX, 0, backZ, w, h, t, stone);                   // back
    this.addBox(minX, 0, minZ, t, h, d, stone);                    // west
    this.addBox(maxX - t, 0, minZ, t, h, d, stone);                // east

    // Front wall with gatehouse arch
    const doorW = 3.6;
    const sideW = (w - doorW) / 2;
    this.addBox(minX, 0, frontZ, sideW, h, t, stone);
    this.addBox(cx + doorW / 2, 0, frontZ, sideW, h, t, stone);
    this.addBox(cx - doorW / 2, h - 1.2, frontZ, doorW, 1.2, t, stone); // gate header

    // Battlements on all four walls
    this.addMerlons(minX, h, backZ, w, t, stoneL);
    this.addMerlons(minX, h, minZ, t, d, stoneL);
    this.addMerlons(maxX - t, h, minZ, t, d, stoneL);
    this.addMerlons(minX, h, frontZ, sideW, t, stoneL);
    this.addMerlons(cx + doorW / 2, h, frontZ, sideW, t, stoneL);

    // Four corner towers, taller than the curtain
    const towerS = 2.0, towerH = 7.5;
    const corners = [
      [minX - 0.2, minZ - 0.2],
      [maxX + 0.2 - towerS, minZ - 0.2],
      [minX - 0.2, maxZ + 0.2 - towerS],
      [maxX + 0.2 - towerS, maxZ + 0.2 - towerS],
    ];
    for (const [tx, tz] of corners) {
      this.addBox(tx, 0, tz, towerS, towerH, towerS, C.stoneDark);
      this.addBox(tx - 0.15, towerH, tz - 0.15, towerS + 0.3, 0.3, towerS + 0.3, stoneL);
      this.addMerlons(tx - 0.15, towerH + 0.3, tz - 0.15, towerS + 0.3, towerS + 0.3, stoneL);
    }

    // Gatehouse pillars flanking the door — DECORATIVE only. They sat right in
    // the choke point bots take through the gate and were causing wedge bugs.
    const ghW = 1.2, ghH = 6.5;
    const ghOutZ = doorOnLowZ ? frontFaceZ - ghW - 0.05 : frontFaceZ + 0.05;
    const ghLeft = new THREE.Mesh(new THREE.BoxGeometry(ghW, ghH, ghW), mat(C.stoneDark));
    ghLeft.position.set(cx - doorW / 2 - ghW / 2, ghH / 2, ghOutZ + ghW / 2);
    this.addDecor(ghLeft);
    const ghRight = new THREE.Mesh(new THREE.BoxGeometry(ghW, ghH, ghW), mat(C.stoneDark));
    ghRight.position.set(cx + doorW / 2 + ghW / 2, ghH / 2, ghOutZ + ghW / 2);
    this.addDecor(ghRight);

    // Banner cloth hanging on the back wall (decorative — inside face)
    const bannerW = 2.4, bannerH = 3.0;
    const bannerZ = doorOnLowZ ? maxZ - t - 0.05 : minZ + t + 0.05;
    const bannerMesh = new THREE.Mesh(
      new THREE.BoxGeometry(bannerW, bannerH, 0.05),
      mat(accent)
    );
    bannerMesh.position.set(cx, h - bannerH / 2 + 0.1, bannerZ);
    this.addDecor(bannerMesh);
    const trimMesh = new THREE.Mesh(
      new THREE.BoxGeometry(bannerW + 0.2, 0.18, 0.06),
      mat(trim)
    );
    trimMesh.position.set(cx, h - 0.05, bannerZ);
    this.addDecor(trimMesh);

    // Flag pole near a back corner, with a flag in team color
    const poleX = cx - w / 2 + 1.0;
    const poleZ = doorOnLowZ ? maxZ - 1.0 : minZ + 1.0;
    const poleH = 9.5;
    const poleMesh = new THREE.Mesh(new THREE.BoxGeometry(0.16, poleH, 0.16), mat(C.flagpole));
    poleMesh.position.set(poleX, poleH / 2, poleZ);
    this.addDecor(poleMesh);
    const flag = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.2, 0.08), mat(accent));
    flag.position.set(poleX + 1.08, poleH - 0.8, poleZ);
    this.addDecor(flag);

    // Interior baffle: blocks straight LOS from door into spawn area
    const baffleZ = doorOnLowZ ? cz + 0.5 : cz - 1.0;
    this.addBox(cx - 4, 0, baffleZ, 8, h - 0.6, 0.5, C.stoneDark);

    // Spawn points — 5 per team: back-corner-left, back-left, back-center,
    // back-right, back-corner-right. All behind the baffle so they're safe.
    const backY = doorOnLowZ ? maxZ - 1.8 : minZ + 1.8;
    this.teamSpawns[team] = [
      new THREE.Vector3(cx - 7.5, 0.85, backY),
      new THREE.Vector3(cx - 4,   0.85, backY),
      new THREE.Vector3(cx,       0.85, backY),
      new THREE.Vector3(cx + 4,   0.85, backY),
      new THREE.Vector3(cx + 7.5, 0.85, backY),
    ];

    // (Hay bales and interior crates removed — they were snagging bot pathing
    // out of the keep door.)

    // Signage ridge in team color above the gate (interior side)
    this.addBox(minX + 1.5, h - 0.25, doorOnLowZ ? minZ + t : maxZ - t - 0.15, w - 3, 0.18, 0.15, accent);

    // Wall torch sconces on the front wall (decorative + small point light glow)
    this.addTorch(cx - doorW / 2 - 1.2, 3.4, frontFaceZ + (doorOnLowZ ? -0.25 : 0.25));
    this.addTorch(cx + doorW / 2 + 1.2, 3.4, frontFaceZ + (doorOnLowZ ? -0.25 : 0.25));

    // Anti-spawn-camp zone (slightly bigger than the keep, with a forward buffer)
    const zoneSide = 1.0;
    const zoneFront = SPAWN_GUARD;
    this.teamSpawnZones[team] = {
      minX: minX - zoneSide,
      maxX: maxX + zoneSide,
      minZ: doorOnLowZ ? minZ - zoneFront : minZ - zoneSide,
      maxZ: doorOnLowZ ? maxZ + zoneSide : maxZ + zoneFront,
    };
  }

  // --- center: stepped hill + ruined watchtower ---

  buildWatchtowerHill(cx, cz) {
    // 3-tier stepped hill (was 5 tiers + ruined walls + merlons + flag pole).
    // Each step is STEP_H tall so the player walks up. Pickup sits on the
    // flat top at ~STEP_H * 5 (≈ 2.75m).
    const tiers = [
      { w: 14, h: STEP_H * 2, color: C.grassMid },
      { w: 9,  h: STEP_H * 4, color: C.grass },
      { w: 5,  h: STEP_H * 5, color: C.stone },
    ];
    for (const t of tiers) {
      this.addBox(cx - t.w / 2, 0, cz - t.w / 2, t.w, t.h, t.w, t.color);
    }
  }

  // --- flanking towers ---

  buildSquareTower(cx, cz, sideHalf, height) {
    // Simplified — single stone column + flat top lip, ladder up south face.
    // Was: column + lip + 3 merlon sides + 3 arrow slits + optional balcony +
    // ivy band (~12 meshes). Now: 2 boxes + ladder.
    const s = sideHalf;
    this.addBox(cx - s, 0, cz - s, s * 2, height, s * 2, C.stone);
    this.addBox(cx - s - 0.2, height, cz - s - 0.2, s * 2 + 0.4, 0.3, s * 2 + 0.4, C.stoneLight);
    this.addLadder(cx, cz + s + 0.22, height + 0.3);
  }

  // --- tall walled outpost (solid stone-and-wood block, ladder-only access) ---

  buildOutpost(cx, cz) {
    const half = 2.5;
    const h = 5.5;
    // Solid stone base — bots can't path onto it (h > NavGrid MAX_GROUND)
    this.addBox(cx - half, 0, cz - half, half * 2, h, half * 2, C.stoneDark);
    // Wooden timber band visually breaks up the block
    const bandY = 2.6;
    const bandH = 0.18;
    const beamThk = 0.04;
    const beam = (x, y, z, w, h, d, c) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(c));
      m.position.set(x + w / 2, y + h / 2, z + d / 2);
      this.addDecor(m);
    };
    beam(cx - half - beamThk, bandY, cz - half - beamThk, half * 2 + beamThk * 2, bandH, beamThk, C.woodDark);
    beam(cx - half - beamThk, bandY, cz + half,             half * 2 + beamThk * 2, bandH, beamThk, C.woodDark);
    beam(cx - half - beamThk, bandY, cz - half - beamThk, beamThk, bandH, half * 2 + beamThk * 2, C.woodDark);
    beam(cx + half,             bandY, cz - half - beamThk, beamThk, bandH, half * 2 + beamThk * 2, C.woodDark);

    // Decorative lip overhang on top — NOT collidable (was blocking ladder exit)
    const lipMesh = new THREE.Mesh(
      new THREE.BoxGeometry(half * 2 + 0.5, 0.3, half * 2 + 0.5),
      mat(C.stoneLight)
    );
    lipMesh.position.set(cx, h + 0.15, cz);
    this.addDecor(lipMesh);

    // Battlements (merlons) sit directly on the block top — leaves a south gap
    const lipS = half;
    const lipY = h;
    this.addMerlons(cx - lipS, lipY, cz - lipS,            lipS * 2, 0.4, C.stoneLight);            // north
    this.addMerlons(cx - lipS, lipY, cz - lipS,            0.4, lipS * 2, C.stoneLight);            // west
    this.addMerlons(cx + lipS - 0.4, lipY, cz - lipS,      0.4, lipS * 2, C.stoneLight);            // east
    // partial south merlons leaving a 1.5m gap centered on the ladder for the player to step over
    const southZ = cz + lipS - 0.4;
    const gap = 1.5;
    const sideW = (lipS * 2 - gap) / 2;
    this.addMerlons(cx - lipS, lipY, southZ, sideW, 0.4, C.stoneLight);
    this.addMerlons(cx + gap / 2, lipY, southZ, sideW, 0.4, C.stoneLight);

    // Ladder on the south face
    this.addLadder(cx, cz + half + 0.22, h);

    // Banner pole on the top platform (decorative)
    const poleH = 2.2;
    const poleM = new THREE.Mesh(new THREE.BoxGeometry(0.12, poleH, 0.12), mat(C.flagpole));
    poleM.position.set(cx - 1.2, h + poleH / 2, cz - 1.2);
    this.addDecor(poleM);
    const flag = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.7, 0.05), mat(0xc8a558));
    flag.position.set(cx - 0.6, h + poleH - 0.5, cz - 1.2);
    this.addDecor(flag);
  }

  // --- ladder ---

  addLadder(cx, cz, top) {
    // Vertical climb zone — player.js detects overlap with this AABB
    const w = 1.0, d = 0.5;
    this.ladders.push({ x: cx, z: cz, w, d, top });

    // Visual: two side rails + horizontal rungs
    const railW = 0.07, railD = 0.07;
    const railSpan = w - 0.1;
    const railH = top + 0.3;
    for (const sx of [-railSpan / 2, railSpan / 2]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(railW, railH, railD), mat(C.woodDark));
      m.position.set(cx + sx, railH / 2, cz);
      this.addDecor(m);
    }
    const rungCount = Math.max(2, Math.floor(top / 0.42));
    for (let i = 1; i <= rungCount; i++) {
      const y = (i / (rungCount + 0.3)) * top;
      const rung = new THREE.Mesh(new THREE.BoxGeometry(railSpan, 0.07, 0.07), mat(C.wood));
      rung.position.set(cx, y, cz);
      this.addDecor(rung);
    }
  }

  // Mid-field cover — pruned from 18 to 10 blocks. Each block is still one
  // mesh; spread roughly symmetrically across the four quadrants for cover.
  buildMidCover() {
    const blocks = [
      [-18, 44, 3, 1.6, 3, C.stone],
      [ 18, 44, 3, 1.6, 3, C.stone],
      [-18,-44, 3, 1.6, 3, C.stone],
      [ 18,-44, 3, 1.6, 3, C.stone],
      [-44, 16, 2, 1.6, 4, C.stoneDark],
      [ 44, 16, 2, 1.6, 4, C.stoneDark],
      [-44,-16, 2, 1.6, 4, C.stoneDark],
      [ 44,-16, 2, 1.6, 4, C.stoneDark],
      [-24, 0,  2, 1.4, 5, C.wood],
      [ 24, 0,  2, 1.4, 5, C.wood],
    ];
    for (const [x, z, w, h, d, c] of blocks) {
      this.addBox(x - w / 2, 0, z - d / 2, w, h, d, c);
    }
  }

  // --- battlefield content ---

  // U-shape stone fort (3 walls + opening), inner dirt firing-step, flag pole.
  // openSide is the cardinal where the opening points: n=+z, s=-z, e=+x, w=-x.
  buildSideFort(cx, cz, openSide) {
    const half = 4, t = 0.6, h = 2.4;
    if (openSide !== 's') this.addBox(cx - half,     0, cz - half,         half * 2, h, t,        C.stone); // -z wall
    if (openSide !== 'n') this.addBox(cx - half,     0, cz + half - t,     half * 2, h, t,        C.stone); // +z wall
    if (openSide !== 'w') this.addBox(cx - half,     0, cz - half,         t,        h, half * 2, C.stone); // -x wall
    if (openSide !== 'e') this.addBox(cx + half - t, 0, cz - half,         t,        h, half * 2, C.stone); // +x wall

    // Inner dirt firing step (climbable: 0.55m == STEP_H)
    this.addBox(cx - 2, 0, cz - 2, 4, STEP_H, 4, C.dirt);

    // Flag pole in a back corner (diagonally opposite the opening)
    const cornerMap = {
      n: [-half + 1.0, -half + 1.0],
      s: [ half - 1.0,  half - 1.0],
      e: [-half + 1.0, -half + 1.0],
      w: [ half - 1.0, -half + 1.0],
    };
    const [pdx, pdz] = cornerMap[openSide] || cornerMap.n;
    const poleH = 4.5;
    const pole = new THREE.Mesh(new THREE.BoxGeometry(0.14, poleH, 0.14), mat(C.flagpole));
    pole.position.set(cx + pdx, poleH / 2, cz + pdz);
    this.addDecor(pole);
    const flag = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.85, 0.05), mat(C.banner));
    flag.position.set(cx + pdx + 0.77, poleH - 0.7, cz + pdz);
    this.addDecor(flag);
  }

  // Tall narrow peak — flat-shaded cone with a 4x4 box for collision approx
  buildSteepPeak(cx, cz) {
    const h = 13, r = 2.6;
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(r, h, 5),
      mat(C.stoneDark, { flat: true })
    );
    cone.position.set(cx, h / 2, cz);
    cone.rotation.y = Math.random() * Math.PI;
    this.addDecor(cone);
    this.addBox(cx - 2, 0, cz - 2, 4, 4, 4, C.stoneDark);
  }

  // Single low ridge — a long thin solid block, 1.6m tall
  buildRidge(cx, cz, w, d) {
    this.addBox(cx - w / 2, 0, cz - d / 2, w, 1.6, d, C.stone);
  }

  placeSandbags() {
    const spots = [[10, 60], [-10, -60], [15, 70], [-15, -70], [40, -15], [-40, 15]];
    for (const [x, z] of spots) {
      this.addBox(x - 1.5, 0, z - 0.6, 3, 0.8, 1.2, C.hay);
    }
  }

  placeTankTraps() {
    const spots = [[0, 78], [0, -78], [25, 72], [-25, -72], [60, 30], [-60, -30]];
    for (const [x, z] of spots) this.addTankTrap(x, z);
  }

  // 3-beam cheval de frise — DECOR only, no collision
  addTankTrap(cx, cz) {
    const len = 2.6, thk = 0.18;
    const rots = [
      [0,           0, Math.PI / 4],
      [0,           0, -Math.PI / 4],
      [Math.PI / 4, 0, 0],
    ];
    for (const [rx, ry, rz] of rots) {
      const beam = new THREE.Mesh(new THREE.BoxGeometry(thk, len, thk), mat(C.woodDark));
      beam.position.set(cx, len * 0.45, cz);
      beam.rotation.set(rx, ry, rz);
      this.addDecor(beam);
    }
  }

  placeFences() {
    const segs = [
      [-78,  14, -78, -14],
      [ 78,  14,  78, -14],
      [-30,  78, -10,  78],
      [ 10, -78,  30, -78],
    ];
    for (const [x1, z1, x2, z2] of segs) this.addFenceSegment(x1, z1, x2, z2);
  }

  // 2-rail wooden fence with posts every ~2.5m — DECOR only
  addFenceSegment(x1, z1, x2, z2) {
    const dx = x2 - x1, dz = z2 - z1;
    const len = Math.hypot(dx, dz);
    const ang = -Math.atan2(dz, dx);
    const cx = (x1 + x2) / 2, cz = (z1 + z2) / 2;
    for (const yRail of [0.5, 1.1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(len, 0.08, 0.06), mat(C.woodDark));
      rail.position.set(cx, yRail, cz);
      rail.rotation.y = ang;
      this.addDecor(rail);
    }
    const postCount = Math.max(2, Math.floor(len / 2.5) + 1);
    for (let i = 0; i < postCount; i++) {
      const t = i / (postCount - 1);
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.4, 0.12), mat(C.woodDark));
      post.position.set(x1 + dx * t, 0.7, z1 + dz * t);
      this.addDecor(post);
    }
  }

  placeSpikes() {
    const spots = [[-5, 80], [5, 80], [-5, -80], [5, -80], [-55, 0], [55, 0]];
    for (const [x, z] of spots) this.addSpikeCluster(x, z);
  }

  // 5 wood-dark spike cones in a small ring — DECOR only
  addSpikeCluster(cx, cz) {
    for (let i = 0; i < 5; i++) {
      const angle = (i / 5) * Math.PI * 2 + Math.random() * 0.3;
      const r = 0.4 + Math.random() * 0.3;
      const h = 0.6 + Math.random() * 0.3;
      const spike = new THREE.Mesh(
        new THREE.ConeGeometry(0.15, h, 4),
        mat(C.woodDark, { flat: true })
      );
      spike.position.set(cx + Math.cos(angle) * r, h / 2, cz + Math.sin(angle) * r);
      spike.rotation.y = Math.random() * Math.PI;
      this.addDecor(spike);
    }
  }

  // Multi-tier stepped pyramid. Keeps the same 6.6m peak as before (health
  // pickup spawns at y=7.3 on top) but with a WIDER tread per tier so the
  // player can actually walk up the sides without getting wedged. Also uses
  // hollow rings (4 side walls per tier) instead of fully nested solid boxes
  // so the corners stop chugging on overdraw.
  buildMegaHill(cx, cz) {
    const tiers = 12;
    const baseR = 14.4;   // up from 9.6 — wider base, wider tread
    const tread = 1.2;    // up from 0.78 — comfortable foothold per step
    for (let i = 0; i < tiers; i++) {
      const rOuter = baseR - i * tread;
      const rInner = baseR - (i + 1) * tread;
      const h = STEP_H * (i + 1);
      const color = i < 4 ? C.grassMid : i < 8 ? C.grass : i < 11 ? C.stone : C.stoneDark;
      if (i === tiers - 1 || rInner < 0.4) {
        // Solid top cap so the perch is walkable
        this.addBox(cx - rOuter, 0, cz - rOuter, rOuter * 2, h, rOuter * 2, color);
      } else {
        // Hollow ring of 4 side walls — no overlap with inner tiers, far less
        // overdraw than 12 fully nested boxes. North/south are full-width,
        // east/west fill the inner span so corners aren't double-covered.
        const wallW = rOuter - rInner;
        this.addBox(cx - rOuter, 0, cz + rInner, rOuter * 2, h, wallW, color);
        this.addBox(cx - rOuter, 0, cz - rOuter, rOuter * 2, h, wallW, color);
        this.addBox(cx + rInner, 0, cz - rInner, wallW, h, rInner * 2, color);
        this.addBox(cx - rOuter, 0, cz - rInner, wallW, h, rInner * 2, color);
      }
    }
  }

  // Raised crossing bridge — solid stone hill capped with a plank deck so
  // bots can path right across it. Stepped ramps on each end. Deck centered
  // at (xCenter, cz) with X-extent of `length`; underside is solid (no
  // walking under). Use multiple short bridges with xCenter offsets to keep
  // the central spawn corridor clear.
  buildCatwalk(cz, xCenter, length) {
    const rampSteps = 7;                        // exact step count
    const stepH = STEP_H;                       // 0.55m per step — matches player STEP_HEIGHT
    const deckHeight = rampSteps * stepH;       // 3.85m — under NavGrid MAX_GROUND so bots can walk it
    const deckW = 4.4;                          // wide enough that two bots can pass
    const halfLen = length / 2;
    const rampLen = 7.0;
    const rampStepLen = rampLen / rampSteps;
    const deckMinX = xCenter - halfLen;
    const deckMaxX = xCenter + halfLen;

    // Solid stone deck — one ground-resting box so NavGrid treats the top as
    // navigable terrain. Bots will path right onto the bridge.
    this.addBox(deckMinX, 0, cz - deckW / 2, length, deckHeight, deckW, C.stone);

    // Wood plank skin on top — purely visual, doesn't affect collision/nav
    const plank = new THREE.Mesh(
      new THREE.BoxGeometry(length, 0.14, deckW),
      mat(C.wood),
    );
    plank.position.set(xCenter, deckHeight + 0.07, cz);
    this.addDecor(plank);

    // Stepped ramps on each end (matches step height so player STEP_HEIGHT auto-climbs)
    for (let i = 0; i < rampSteps; i++) {
      const sH = stepH * (i + 1);
      const xEastStart = deckMaxX + rampLen - rampStepLen * (i + 1);
      this.addBox(xEastStart, 0, cz - deckW / 2, rampStepLen, sH, deckW, C.dirt);
      const xWestStart = deckMinX - rampLen + rampStepLen * i;
      this.addBox(xWestStart, 0, cz - deckW / 2, rampStepLen, sH, deckW, C.dirt);
    }

    // Decorative railings — DECOR only, doesn't block fall-off but provides visual
    for (const zSide of [cz - deckW / 2, cz + deckW / 2 - 0.06]) {
      const rail = new THREE.Mesh(
        new THREE.BoxGeometry(length, 0.06, 0.06),
        mat(C.woodDark)
      );
      rail.position.set(xCenter, deckHeight + 0.85, zSide + 0.03);
      this.addDecor(rail);
      const postCount = Math.floor(length / 3) + 1;
      for (let i = 0; i < postCount; i++) {
        const px = deckMinX + (i / (postCount - 1)) * length;
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.9, 0.1), mat(C.woodDark));
        post.position.set(px, deckHeight + 0.5, zSide + 0.03);
        this.addDecor(post);
      }
    }

    // Expose high-ground perch points so AI can pick the catwalk as a waypoint
    if (!this.highGroundPerches) this.highGroundPerches = [];
    this.highGroundPerches.push({ x: xCenter, z: cz, y: deckHeight + 0.07 });
  }

  // --- decoration ---

  scatterTrees() {
    // Conifers around the outer ring; avoid clustering near key buildings/spawns
    const trees = [];
    const isClear = (x, z) => {
      // keep trees out of the central spawn corridor and away from existing obstacles
      if (Math.abs(x) < 4 && Math.abs(z) > 70) return false; // spawn corridor
      for (const o of this.obstacles) {
        const ox = o.x + o.w / 2, oz = o.z + o.d / 2;
        const dx = x - ox, dz = z - oz;
        if (Math.abs(dx) < o.w / 2 + 1.6 && Math.abs(dz) < o.d / 2 + 1.6) return false;
      }
      // spread out
      for (const [tx, tz] of trees) {
        if ((tx - x) ** 2 + (tz - z) ** 2 < 25) return false;
      }
      return true;
    };
    let placed = 0, tries = 0;
    while (placed < 15 && tries < 300) {
      tries++;
      const x = (Math.random() - 0.5) * 1.85 * this.bounds;
      const z = (Math.random() - 0.5) * 1.85 * this.bounds;
      if (Math.abs(x) > this.bounds - 4 || Math.abs(z) > this.bounds - 4) continue;
      if (!isClear(x, z)) continue;
      trees.push([x, z]);
      placed++;
      this.addTree(x, z);
    }
  }

  addTree(x, z) {
    // Trees are now PURE DECORATION — no collision. Was blocking bot LOS and
    // letting players walk through foliage in inconsistent ways.
    const trunkH = 1.2 + Math.random() * 0.9;
    const trunkR = 0.22;
    const trunk = new THREE.Mesh(
      new THREE.BoxGeometry(trunkR * 2, trunkH, trunkR * 2),
      mat(C.trunk)
    );
    trunk.position.set(x, trunkH / 2, z);
    this.addDecor(trunk);

    const cones = 2 + (Math.random() < 0.5 ? 1 : 0);
    for (let i = 0; i < cones; i++) {
      const r = 1.5 - i * 0.35;
      const h = 1.6 - i * 0.25;
      const c = i % 2 === 0 ? C.foliage1 : C.foliage2;
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(r, h, 6),
        mat(c, { flat: true })
      );
      cone.position.set(x, trunkH + 0.5 + i * 0.95, z);
      cone.rotation.y = Math.random() * Math.PI;
      this.addDecor(cone);
    }
  }

  scatterBoulders() {
    // Boulders only along the outer rim — never in the central battlefield where
    // they'd snag bot pathing. Pre-defined spots with small jitter.
    const spots = [
      [-82,  60], [ 82, -60],
      [-82, -65], [ 82,  65],
      [-60,  82], [ 60, -82],
      [ 38,  82], [-38, -82],
      [-15,  78], [ 15, -78],
    ];
    for (const [bx, bz] of spots) {
      const x = bx + (Math.random() - 0.5) * 4;
      const z = bz + (Math.random() - 0.5) * 4;
      // Reject if the spot is too close to any existing obstacle
      let blocked = false;
      for (const o of this.obstacles) {
        const ox = o.x + o.w / 2, oz = o.z + o.d / 2;
        if (Math.abs(x - ox) < o.w / 2 + 1.5 && Math.abs(z - oz) < o.d / 2 + 1.5) {
          blocked = true; break;
        }
      }
      if (blocked) continue;
      const r = 0.55 + Math.random() * 0.35; // smaller than before
      this.addBox(x - r, 0, z - r, r * 2, r * 1.2, r * 2, C.boulder);
      this.addDecor(this.makeBoulder(x, 0, z, r));
    }
  }

  makeBoulder(x, y, z, r) {
    const geo = new THREE.IcosahedronGeometry(r, 0);
    // jitter vertices for organic shape
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
      pos.setXYZ(
        i,
        px * (1 + (Math.random() - 0.5) * 0.18),
        py * (1 + (Math.random() - 0.5) * 0.18),
        pz * (1 + (Math.random() - 0.5) * 0.18),
      );
    }
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, mat(Math.random() < 0.5 ? C.boulder : C.boulderDk, { flat: true }));
    m.position.set(x, y + r * 0.7, z);
    m.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    return m;
  }

  placeBanners() {
    // Decorative banner poles at perimeter corners (flag in alternating colors)
    const spots = [
      [-90, -90, TEAM_COLORS.russet],
      [ 90, -90, TEAM_COLORS.russet],
      [-90,  90, TEAM_COLORS.mash],
      [ 90,  90, TEAM_COLORS.mash],
    ];
    for (const [x, z, color] of spots) {
      const pole = new THREE.Mesh(new THREE.BoxGeometry(0.18, 5.5, 0.18), mat(C.flagpole));
      pole.position.set(x, 2.75, z);
      this.addDecor(pole);
      const flag = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.1, 0.06), mat(color));
      flag.position.set(x + 0.95, 4.6, z);
      this.addDecor(flag);
    }
  }

  addTorch(x, y, z) {
    // Wooden bracket
    const bracket = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 0.5), mat(C.woodDark));
    bracket.position.set(x, y, z);
    this.addDecor(bracket);
    // Flame ball (emissive-ish via MeshBasicMaterial). Point-light dropped —
    // each dynamic light forces an extra shader pass on every nearby mesh.
    const flame = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), mat(C.torch, { basic: true }));
    flame.position.set(x, y + 0.3, z);
    this.addDecor(flame, { cast: false, recv: false });
  }
}
