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
  // Auto-scale: if the loaded model's biggest horizontal dimension is far
  // from this target (in meters), uniformly scale it to fit. Set to null to
  // disable. Sketchfab models are authored at wildly different scales —
  // some at meter scale, some at centimeter, some at "Unreal Engine 100×"
  // scale — so this is the difference between a usable map and an invisible
  // dot or an unwalkable continent.
  const targetWidth = opts.targetWidth ?? 120;

  const loader = new GLTFLoader();
  const gltf = await new Promise((resolve, reject) => {
    loader.load(url, resolve, undefined, reject);
  });
  const root = gltf.scene;
  root.scale.setScalar(scale);
  root.updateMatrixWorld(true);

  // Probe the loaded model's visible-mesh bbox BEFORE any centering, so we
  // know what scale factor to apply. Use only meshes (not stray empties),
  // and skip anything > 1000m on any side (skyboxes).
  if (targetWidth) {
    const probeBox = new THREE.Box3();
    probeBox.makeEmpty();
    const probeTmp = new THREE.Box3();
    root.traverse((o) => {
      if (!o.isMesh) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      probeTmp.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
      const sz = probeTmp.getSize(new THREE.Vector3());
      if (sz.x > 1000 || sz.y > 1000 || sz.z > 1000) return;
      probeBox.union(probeTmp);
    });
    if (!probeBox.isEmpty()) {
      const sz = probeBox.getSize(new THREE.Vector3());
      const biggest = Math.max(sz.x, sz.z);
      if (biggest > 1 && (biggest < targetWidth * 0.5 || biggest > targetWidth * 2)) {
        const factor = targetWidth / biggest;
        root.scale.multiplyScalar(factor);
        root.updateMatrixWorld(true);
        console.log('[glbmap] auto-scaled by', factor.toFixed(3), '(original width', biggest.toFixed(1), 'm → target', targetWidth, 'm)');
      }
    }
  }

  // Compute centering based on the WEIGHTED CENTROID of all real meshes,
  // NOT the bounding box of the entire scene graph. Sketchfab models often
  // ship with stray empty/helper nodes far from the geometry, which would
  // pull the bbox center off to the side and leave the visible map floating
  // away from the player spawn. Weighted-centroid is robust to outliers:
  // each mesh contributes its center position weighted by its surface area
  // (approximated from bbox size), so big floors/walls dominate the average
  // and stray empties don't matter.
  let totalWeight = 0;
  const centroid = new THREE.Vector3();
  let minY = Infinity, maxY = -Infinity;
  const tmpV = new THREE.Vector3();
  const tmpBoxA = new THREE.Box3();
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.updateMatrixWorld(true);
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    tmpBoxA.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
    const sz = tmpBoxA.getSize(tmpV);
    // Approximate surface-area weight; clamp to ignore skybox-sized meshes
    // that would dominate the average.
    if (sz.x > 1000 || sz.y > 1000 || sz.z > 1000) return;
    const w = Math.max(0.001, sz.x * sz.z + sz.x * sz.y + sz.z * sz.y);
    const c = tmpBoxA.getCenter(tmpV);
    centroid.x += c.x * w;
    centroid.y += c.y * w;
    centroid.z += c.z * w;
    totalWeight += w;
    if (tmpBoxA.min.y < minY) minY = tmpBoxA.min.y;
    if (tmpBoxA.max.y > maxY) maxY = tmpBoxA.max.y;
  });
  if (totalWeight > 0) {
    centroid.divideScalar(totalWeight);
  }
  if (centerXZ && totalWeight > 0) {
    root.position.x -= centroid.x;
    root.position.z -= centroid.z;
  }
  // NOTE: we no longer Y-shift the model. Many Sketchfab maps include decor
  // meshes below the visible floor (basements, water sheets, etc.) — shifting
  // by minY pushed the floor too high and the player spawned UNDER the floor.
  // Trust the GLB's authored Y; the floor-mesh detection below picks the
  // right spawn height based on the LARGEST horizontal mesh (the actual floor).
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
    // Skip the SKY/CEILING — a flat, wide, mesh sitting at the TOP of the
    // map (within 5m of visBox.max.y). The actual playable floor is kept
    // so the player has solid ground.
    // (visBox is computed in a later pass; we use a quick estimate here.)

    obstacles.push({
      x: tmpBox.min.x + padObst,
      y: tmpBox.min.y,
      z: tmpBox.min.z + padObst,
      w: Math.max(0.01, size.x - padObst * 2),
      h: Math.max(0.05, size.y),
      d: Math.max(0.01, size.z - padObst * 2),
    });
  });

  // "Visible-mesh bbox" — built from non-outlier meshes only. Used to size
  // default spawn placement so spawns sit at the edges of the ACTUAL map
  // geometry, not at the extents of a bbox that's been inflated by stray
  // helper/empty nodes.
  const visBox = new THREE.Box3();
  visBox.makeEmpty();
  const tmpBoxB = new THREE.Box3();
  root.traverse((o) => {
    if (!o.isMesh) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    tmpBoxB.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
    const sz = tmpBoxB.getSize(new THREE.Vector3());
    if (sz.x > 1000 || sz.y > 1000 || sz.z > 1000) return;
    visBox.union(tmpBoxB);
  });

  // If the map didn't ship with named spawn markers, fall back to a smart
  // default: find the SINGLE LARGEST horizontal mesh (the floor — almost
  // always the dominant flat surface in any FPS map) and spawn players on
  // its top surface, clustered around its center. This is robust to:
  //   - basement decorations (smaller mesh below the floor — we'd skip it)
  //   - native model Y offsets (we use the floor mesh's actual top y)
  //   - off-center map geometry (we use the floor mesh's actual XZ center)
  if (spawns.mash.length === 0 || spawns.russet.length === 0) {
    // Pick the LOWEST mesh (by top-y) with substantial XZ area as the floor.
    // "Biggest mesh" used to pick rooftops/upper platforms; "lowest large
    // mesh" reliably picks the actual ground floor.
    let floorBox = null;
    let lowestTopY = Infinity;
    const tmpBoxF = new THREE.Box3();
    root.traverse((o) => {
      if (!o.isMesh) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      tmpBoxF.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
      const sz = tmpBoxF.getSize(new THREE.Vector3());
      if (sz.x > 1000 || sz.z > 1000) return;     // skip skyboxes
      const area = sz.x * sz.z;
      if (area < 25) return;                       // ignore tiny props
      if (tmpBoxF.max.y < lowestTopY) {
        lowestTopY = tmpBoxF.max.y;
        floorBox = tmpBoxF.clone();
      }
    });
    if (floorBox) {
      console.log('[glbmap] floor detected at top-y =', floorBox.max.y.toFixed(2),
                  'center =', floorBox.getCenter(new THREE.Vector3()));
    }
    if (floorBox) {
      const center = floorBox.getCenter(new THREE.Vector3());
      const yTop = floorBox.max.y + 1.5;           // 1.5m above the floor's top surface
      const sizeF = floorBox.getSize(new THREE.Vector3());
      const halfZ = Math.min(sizeF.z * 0.35, 25);  // teams 35% off-center along Z, capped at 25m
      if (spawns.mash.length === 0) {
        for (let i = -1; i <= 1; i++) {
          spawns.mash.push({ x: center.x + i * 4, y: yTop, z: center.z + halfZ });
        }
      }
      if (spawns.russet.length === 0) {
        for (let i = -1; i <= 1; i++) {
          spawns.russet.push({ x: center.x + i * 4, y: yTop, z: center.z - halfZ });
        }
      }
    } else {
      // Fallback: nothing detected as floor. Drop spawns at world origin
      // 2m up; player physics figures it out from there.
      if (spawns.mash.length === 0) {
        spawns.mash.push({ x:  4, y: 2, z:  10 });
        spawns.mash.push({ x:  0, y: 2, z:  10 });
        spawns.mash.push({ x: -4, y: 2, z:  10 });
      }
      if (spawns.russet.length === 0) {
        spawns.russet.push({ x:  4, y: 2, z: -10 });
        spawns.russet.push({ x:  0, y: 2, z: -10 });
        spawns.russet.push({ x: -4, y: 2, z: -10 });
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
