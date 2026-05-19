// GLB / glTF map loader for Spud Shockers.
//
// Loads a single .glb or .gltf file and prepares it as the active map:
//   - Adds the model to the scene at world origin
//   - Auto-generates an AABB collision list from each mesh's bounding box
//   - Picks spawn points from the model's bounding extents (default behavior)
//     OR from named child objects "Spawn_Mash" / "Spawn_Russet" if present
//
// The user drops their .glb at maps/custom.glb (or whatever URL is passed)
// and picks "CUSTOM MAP" from the start-screen map picker.
//
// IMPORTANT — this loader does NOT promise perfect collision: irregular meshes
// (slopes, curved surfaces) become axis-aligned bounding boxes, which means
// players may bump invisible edges on diagonals. For the Spud Shockers
// gameplay (FPS arena), this is good enough — the alternative (mesh-bvh
// triangle-perfect collision) is 10× the code and slower at runtime.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export async function loadGlbMap(url, opts = {}) {
  // Optional uniform scale applied to the whole model. Set this when the
  // source asset is authored at a different scale than Spud Shockers'
  // ~1m-per-unit world.
  const scale     = opts.scale     ?? 1.0;
  const yOffset   = opts.yOffset   ?? 0;            // raise/lower whole map
  const centerXZ  = opts.centerXZ  ?? true;         // re-center horizontally
  const padObst   = opts.collisionPadding ?? 0.05;  // shrink AABBs slightly so adjacent boxes don't overlap

  const loader = new GLTFLoader();
  const gltf = await new Promise((resolve, reject) => {
    loader.load(url, resolve, undefined, reject);
  });
  const root = gltf.scene;
  root.scale.setScalar(scale);
  root.updateMatrixWorld(true);

  // Compute world-space AABB of everything so we can re-center the map on
  // the world origin and floor it to y=0. Sketchfab models often arrive
  // off-center or below ground; this normalizes them.
  const fullBox = new THREE.Box3().setFromObject(root);
  const center  = fullBox.getCenter(new THREE.Vector3());
  if (centerXZ) {
    root.position.x -= center.x;
    root.position.z -= center.z;
  }
  // Floor: shift so the lowest point sits at y = yOffset
  root.position.y += (yOffset - fullBox.min.y);
  root.updateMatrixWorld(true);

  // Walk the scene graph collecting AABB obstacles + named spawn points.
  // - Meshes with names starting "Spawn_" (case-insensitive) become spawns
  //   instead of collidables (so map authors can paint colored markers).
  // - Everything else contributes one AABB per mesh.
  const obstacles = [];
  const spawns = { mash: [], russet: [] };
  const pickups = [];
  const tmpBox = new THREE.Box3();

  root.traverse((obj) => {
    if (!obj.isMesh) return;
    obj.castShadow = true;
    obj.receiveShadow = true;
    const name = (obj.name || '').toLowerCase();
    // Re-compute the mesh's bounding box in WORLD coords, accounting for the
    // root's scale + position + rotation.
    obj.updateMatrixWorld(true);
    if (!obj.geometry.boundingBox) obj.geometry.computeBoundingBox();
    tmpBox.copy(obj.geometry.boundingBox).applyMatrix4(obj.matrixWorld);

    if (/^spawn[_-]?mash/.test(name)) {
      const c = tmpBox.getCenter(new THREE.Vector3());
      spawns.mash.push({ x: c.x, y: c.y, z: c.z });
      obj.visible = false;
      return;
    }
    if (/^spawn[_-]?russet/.test(name)) {
      const c = tmpBox.getCenter(new THREE.Vector3());
      spawns.russet.push({ x: c.x, y: c.y, z: c.z });
      obj.visible = false;
      return;
    }
    if (/^pickup/.test(name)) {
      const c = tmpBox.getCenter(new THREE.Vector3());
      pickups.push({ x: c.x, y: c.y, z: c.z });
      obj.visible = false;
      return;
    }

    // Skip degenerate / huge skybox-like meshes (anything > 1000m on a side
    // is probably not a real obstacle — it's a backdrop).
    const size = tmpBox.getSize(new THREE.Vector3());
    if (size.x > 1000 || size.y > 1000 || size.z > 1000) return;
    // Skip flat ground-plane meshes (very thin in Y) — they're floor, the
    // player walks on top via the ground-collision system, not into.
    if (size.y < 0.15) return;

    obstacles.push({
      x: tmpBox.min.x + padObst,
      y: tmpBox.min.y,
      z: tmpBox.min.z + padObst,
      w: Math.max(0.01, size.x - padObst * 2),
      h: size.y,
      d: Math.max(0.01, size.z - padObst * 2),
    });
  });

  // If the map didn't ship with named spawn markers, fall back to a sensible
  // default: 4 spots at each end of the map (north + south side along Z).
  if (spawns.mash.length === 0 || spawns.russet.length === 0) {
    const mapBox = new THREE.Box3().setFromObject(root);
    const mapMin = mapBox.min, mapMax = mapBox.max;
    const midX = (mapMin.x + mapMax.x) / 2;
    const padZ = 6;
    const yFloor = mapMin.y + 1.0;
    if (spawns.mash.length === 0) {
      for (let i = -1; i <= 1; i++) {
        spawns.mash.push({ x: midX + i * 6, y: yFloor, z: mapMax.z - padZ });
      }
    }
    if (spawns.russet.length === 0) {
      for (let i = -1; i <= 1; i++) {
        spawns.russet.push({ x: midX + i * 6, y: yFloor, z: mapMin.z + padZ });
      }
    }
  }

  // Compute spawn-zone AABBs (for anti-spawn-camp logic in Arena)
  const spawnZone = (list) => {
    if (!list.length) return null;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const s of list) {
      if (s.x < minX) minX = s.x; if (s.x > maxX) maxX = s.x;
      if (s.z < minZ) minZ = s.z; if (s.z > maxZ) maxZ = s.z;
    }
    return { minX: minX - 4, maxX: maxX + 4, minZ: minZ - 4, maxZ: maxZ + 4 };
  };

  return {
    root,
    obstacles,
    spawns,
    pickups,
    spawnZones: {
      mash:   spawnZone(spawns.mash),
      russet: spawnZone(spawns.russet),
    },
    bounds: new THREE.Box3().setFromObject(root),
  };
}
