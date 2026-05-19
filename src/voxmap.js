// MagicaVoxel (.vox) map loader for Spud Shockers.
//
// Workflow:
//   1. Build a map in MagicaVoxel (free, https://ephtracy.github.io/)
//   2. Use specific palette slots as markers (see MARKER_* below)
//   3. Save .vox → drop into the maps/ folder
//   4. Pick it from the start-screen MAP dropdown
//
// Produced output (from loadVoxMap):
//   - mesh:       a single merged THREE.Mesh ready to add to the scene
//   - obstacles:  AABB list compatible with arena.obstacles (player/bot collision)
//   - spawns:     { mash: [...], russet: [...] } from marker voxels
//   - pickups:    array of {x,y,z} from marker voxels
//   - bounds:     {width, depth, height} in world meters
//   - voxelSize:  meters per voxel (default 0.5)
//
// Coordinate mapping:
//   MagicaVoxel is Z-up (X-east, Y-north, Z-up).
//   Our game world is Y-up. We map MV Z → world Y (height), MV Y → world Z.
//   Maps are centered horizontally on the world origin.

import * as THREE from 'three';
import { VOXLoader } from 'three/addons/loaders/VOXLoader.js';

// Reserved palette indices — voxels painted with these slots become markers
// (not rendered, not collidable). User must avoid using these slots for
// actual visuals in their .vox file.
const MARKER_MASH    = 255;   // mash team spawn
const MARKER_RUSSET  = 254;   // russet team spawn
const MARKER_PICKUP  = 253;   // ammo/health pickup spawn
const MARKERS = new Set([MARKER_MASH, MARKER_RUSSET, MARKER_PICKUP]);

export async function loadVoxMap(url, opts = {}) {
  const voxelSize = opts.voxelSize ?? 0.5;     // meters per voxel
  const groundY   = opts.groundY   ?? 0;       // world Y where the bottom of the grid sits

  // Async-load the .vox file using three's built-in VOXLoader. Returns an
  // array of chunks; for our use case we expect a single chunk (one MV model).
  const loader = new VOXLoader();
  const chunks = await new Promise((resolve, reject) => {
    loader.load(url, resolve, undefined, reject);
  });
  if (!chunks || chunks.length === 0) {
    throw new Error('vox file contained no chunks: ' + url);
  }
  const chunk = chunks[0];
  const { size, data, palette } = chunk;
  const W = size.x, D = size.y, H = size.z;

  // Flat grid for cache-friendly lookup. Index = x + y*W + z*W*D.
  const idxFlat = (x, y, z) => x + y * W + z * W * D;
  const grid = new Uint8Array(W * D * H);

  const spawns = { mash: [], russet: [] };
  const pickups = [];

  // First pass: write voxels into grid, extract markers as world-space points.
  for (let i = 0; i < data.length; i += 4) {
    const vx = data[i];
    const vy = data[i + 1];
    const vz = data[i + 2];
    const pi = data[i + 3];
    if (MARKERS.has(pi)) {
      const wx = (vx - W / 2 + 0.5) * voxelSize;
      const wy = groundY + (vz + 0.5) * voxelSize;
      const wz = (vy - D / 2 + 0.5) * voxelSize;
      if (pi === MARKER_MASH)   spawns.mash.push({ x: wx, y: wy, z: wz });
      if (pi === MARKER_RUSSET) spawns.russet.push({ x: wx, y: wy, z: wz });
      if (pi === MARKER_PICKUP) pickups.push({ x: wx, y: wy, z: wz });
      continue;                  // markers don't go in the solid grid
    }
    grid[idxFlat(vx, vy, vz)] = pi;
  }

  // ---- Build merged visual mesh ----
  // For each solid voxel, emit only the 6 faces NOT adjacent to another solid
  // voxel. This kills internal faces (huge tri count saver) and gives the
  // classic blocky low-poly look. Vertex colors come straight from the palette.
  const positions = [];
  const colors    = [];
  const normals   = [];
  const indices   = [];
  let vCount = 0;

  // Six cube faces in voxel-local space, plus their world-space normal.
  // The world normal already accounts for the MV→game axis swap (MV Z→world Y).
  // Vertex ordering is CCW when viewed from the outside, so default winding
  // gives outward normals.
  const FACES = [
    // +X face
    { d: [+1, 0, 0], n: [+1, 0, 0], v: [[1,0,0],[1,0,1],[1,1,1],[1,1,0]] },
    // -X face
    { d: [-1, 0, 0], n: [-1, 0, 0], v: [[0,1,0],[0,1,1],[0,0,1],[0,0,0]] },
    // +Y face (MV Y → world Z, +Y in MV is "north")
    { d: [0, +1, 0], n: [0, 0, +1], v: [[1,1,0],[1,1,1],[0,1,1],[0,1,0]] },
    // -Y face
    { d: [0, -1, 0], n: [0, 0, -1], v: [[0,0,0],[0,0,1],[1,0,1],[1,0,0]] },
    // +Z face (MV Z → world Y, this is the top of a voxel)
    { d: [0, 0, +1], n: [0, +1, 0], v: [[0,0,1],[0,1,1],[1,1,1],[1,0,1]] },
    // -Z face (bottom)
    { d: [0, 0, -1], n: [0, -1, 0], v: [[1,0,0],[1,1,0],[0,1,0],[0,0,0]] },
  ];

  const isSolidVoxel = (x, y, z) => {
    if (x < 0 || y < 0 || z < 0 || x >= W || y >= D || z >= H) return false;
    return grid[idxFlat(x, y, z)] !== 0;
  };

  const tmpColor = new THREE.Color();
  for (let z = 0; z < H; z++) {
    for (let y = 0; y < D; y++) {
      for (let x = 0; x < W; x++) {
        const pi = grid[idxFlat(x, y, z)];
        if (pi === 0) continue;
        // Palette entry is ARGB stored little-endian as 0xAABBGGRR.
        const argb = palette[pi] >>> 0;
        const r = ((argb >> 0)  & 0xff) / 255;
        const g = ((argb >> 8)  & 0xff) / 255;
        const b = ((argb >> 16) & 0xff) / 255;
        tmpColor.setRGB(r, g, b, THREE.SRGBColorSpace);
        for (const f of FACES) {
          if (isSolidVoxel(x + f.d[0], y + f.d[1], z + f.d[2])) continue;
          const base = vCount;
          for (const v of f.v) {
            // Voxel-local cube corner (each axis is 0..1)
            const vxw = x + v[0];
            const vyw = y + v[1];
            const vzw = z + v[2];
            // Center horizontally on world origin; raise by groundY vertically.
            const wx = (vxw - W / 2) * voxelSize;
            const wy = groundY + vzw * voxelSize;
            const wz = (vyw - D / 2) * voxelSize;
            positions.push(wx, wy, wz);
            normals.push(f.n[0], f.n[1], f.n[2]);
            colors.push(tmpColor.r, tmpColor.g, tmpColor.b);
            vCount++;
          }
          indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        }
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal',   new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('color',    new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  // ---- Build obstacle AABBs for player/bot collision ----
  // Greedy x-axis runs: for each (y, z) row, merge consecutive solid voxels
  // into one AABB. Cuts box count by 3-5× on typical structures vs. one box
  // per voxel, without the complexity of full 3D greedy meshing.
  const obstacles = [];
  const covered = new Uint8Array(grid.length);
  for (let z = 0; z < H; z++) {
    for (let y = 0; y < D; y++) {
      let x = 0;
      while (x < W) {
        const idx = idxFlat(x, y, z);
        if (grid[idx] === 0 || covered[idx]) { x++; continue; }
        let runEnd = x;
        while (
          runEnd < W &&
          grid[idxFlat(runEnd, y, z)] !== 0 &&
          !covered[idxFlat(runEnd, y, z)]
        ) {
          covered[idxFlat(runEnd, y, z)] = 1;
          runEnd++;
        }
        const length = runEnd - x;
        obstacles.push({
          x: (x - W / 2) * voxelSize,
          y: groundY + z * voxelSize,
          z: (y - D / 2) * voxelSize,
          w: length * voxelSize,
          h: voxelSize,
          d: voxelSize,
        });
        x = runEnd;
      }
    }
  }

  return {
    mesh,
    obstacles,
    spawns,
    pickups,
    bounds: { width: W * voxelSize, depth: D * voxelSize, height: H * voxelSize },
    voxelSize,
    voxelGrid: { W, D, H, data: grid, voxelSize, groundY },
  };
}

// Convenience: probe whether a single .vox file exists at this URL. Used by
// the start-screen map picker to filter out missing files quietly.
export async function voxMapExists(url) {
  try {
    const r = await fetch(url, { method: 'HEAD' });
    return r.ok;
  } catch (_) {
    return false;
  }
}
