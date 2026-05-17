// Loads the real GLB gun assets and exposes a synchronous getModel(weaponKey)
// that returns a fresh THREE.Group cloned from the cached source. Each gun has
// per-weapon tuning (position offset, rotation, scale) so it sits naturally in
// the first-person viewmodel — GLB authoring conventions vary, so we can't
// rely on a single transform.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';

// weaponKey -> { file, scale, position [x,y,z], rotation [x,y,z], muzzleOffset [x,y,z] }
// Tuned for the camera-attached viewmodel (camera looks down -Z, +Y is up).
// muzzleOffset is the LOCAL position of the barrel tip on the gun group so
// muzzle flash + projectile origin land at the actual end of the barrel.
// Loader normalizes each GLB to 1 unit max-dim, so `scale` here = the gun's
// on-screen length in METERS. Most GLBs were authored with their barrel along
// model +X (rotation y=π/2 makes +X → world -Z = forward). Masher's barrel is
// along model -Z (no Y rotation needed). Knife's blade is along model +Y
// (rotation x=-π/2 makes +Y → world -Z = forward).
export const GUN_TUNING = {
  spudgun: {
    file: 'Pistol.glb',
    scale: 0.22,
    position: [0.42, -0.20, -0.35],
    rotation: [0, Math.PI / 2, 0],
    // CYBER PINK — magenta body, cyan accents, white highlights
    skin: { color: 0xff3a8a, accent: 0x3affff, accent2: 0xfff5ff, emissive: 0x4a0a2a, metalness: 0.75, roughness: 0.25 },
    muzzleOffset: [0.42, -0.16, -0.48],
  },
  // `modelScale` is an OPTIONAL per-axis stretch in MODEL space (applied
  // before cfg.rotation). Use it to thicken a gun without lengthening it —
  // e.g., for a model whose barrel is along +X, set `[1, 2.5, 2.5]` to leave
  // length alone but make the body/height ~2.5× chunkier. Defaults to [1,1,1].
  fryer: {
    // Scar-H by Kristian M (Poly Pizza, CC-BY).
    file: 'Scar-H.glb',
    scale: 0.34,
    position: [0.42, -0.22, -0.42],
    // Scar-H's native barrel is along model +X — yaw +90° around Y to point
    // it down world -Z (forward / toward enemies, away from camera).
    rotation: [0, Math.PI / 2, 0],
    roll: 0,
    modelScale: [1, 2.6, 2.6],
    // DESERT TIGER — emerald teal body, hot-orange accents, gold highlights
    skin: { color: 0x2aaad4, accent: 0xff5e3a, accent2: 0xffd97a, emissive: 0x0a2a3a, metalness: 0.6, roughness: 0.30 },
    muzzleOffset: [0.42, -0.18, -0.62],
  },
  hashbrowner: {
    file: 'Shotgun.glb',
    scale: 0.36,
    position: [0.42, -0.22, -0.42],
    rotation: [0, Math.PI / 2, 0],
    roll: 0,
    modelScale: [1, 2.6, 2.6],
    // ROYAL GOLD — gold body, deep purple accents, ivory highlights
    skin: { color: 0xffce3a, accent: 0x6a1aff, accent2: 0xfff0c0, emissive: 0x4a3a0a, metalness: 0.9, roughness: 0.20 },
    muzzleOffset: [0.42, -0.18, -0.64],
  },
  masher: {
    file: 'Shotgun Double Barrel.glb',
    scale: 0.36,
    position: [0.42, -0.22, -0.40],
    rotation: [0, 0, 0],
    roll: Math.PI / 2,
    modelScale: [2.6, 2.6, 1],
    // CHERRY CARNIVAL — crimson body + ice-blue + bone-white + gold + charcoal
    skin: { color: 0xff3a4a, accent: 0x4aeaff, accent2: 0xfff5e0, accent3: 0xffce3a, accent4: 0x2a2030, emissive: 0x4a0a14, metalness: 0.65, roughness: 0.25 },
    muzzleOffset: [0.42, -0.16, -0.62],
  },
  spudling: {
    file: 'Shotgun Auto West.glb',
    scale: 0.50,
    position: [0.42, -0.32, -0.45],
    rotation: [0, 0, 0],
    roll: 0,
    modelScale: [1, 1, 1],
    // ELECTRIC BLUE — sapphire body, neon-orange accents, white highlights
    skin: { color: 0x3a8aff, accent: 0xffa84a, accent2: 0xeaf5ff, emissive: 0x0a2a5a, metalness: 0.75, roughness: 0.22 },
    muzzleOffset: [0.42, -0.10, -0.62],
  },
  boomstick: {
    file: 'Precision Rifle Chassis.glb',
    scale: 0.45,
    position: [0.42, -0.22, -0.45],
    // Precision Rifle GLB's native barrel is along model -Z, so identity
    // rotation already puts the barrel along world -Z (forward).
    rotation: [0, 0, 0],
    roll: 0,
    modelScale: [2.6, 2.6, 1],
    // AURORA PURPLE — violet body, neon-green accents, lavender highlights
    skin: { color: 0xa43aff, accent: 0x5eff8a, accent2: 0xe0c4ff, emissive: 0x2a0a4a, metalness: 0.7, roughness: 0.25 },
    muzzleOffset: [0.42, -0.18, -0.70],
  },
  tossor: {
    file: 'Grenade Launcher v3.glb',
    scale: 0.75,
    position: [0.42, -0.22, -0.45],
    // Reset to identity — we'll figure out the barrel axis empirically by
    // inspecting the model's bounding box (logged to console on load).
    rotation: [0, 0, 0],
    roll: Math.PI / 2,
    modelScale: [1, 1, 1],
    // TOXIC RAVE — orange body + electric-violet + lemon + cyan + lime
    skin: { color: 0xff8a1a, accent: 0xb52aff, accent2: 0xfff05e, accent3: 0x2aeaff, accent4: 0x6eff2a, emissive: 0x4a2a05, metalness: 0.6, roughness: 0.25 },
    muzzleOffset: [0.42, -0.14, -0.62],
  },
  knife: {
    file: 'Kabar.glb',
    scale: 0.20,
    position: [0.32, -0.15, -0.30],
    // 180° around Y — model's native blade pointed toward the camera (+Z);
    // this flips it to point forward (-Z, away from player).
    rotation: [0, Math.PI, 0],
    muzzleOffset: [0.32, -0.05, -0.42],
  },
};

const _cache = new Map();      // weaponKey -> THREE.Group (template)
const _loading = new Map();    // weaponKey -> Promise resolving when loaded
const _loader = new GLTFLoader();
const _textureCache = new Map(); // url -> THREE.Texture
const _texLoader = new THREE.TextureLoader();
const _exrLoader = new EXRLoader();

// Load a texture once and cache it. EXR files (used by PolyHaven for normal +
// roughness maps) need the EXRLoader; JPG/PNG use the default loader. The
// `kind` flag drives colorSpace + linear-vs-sRGB handling so diffuse looks
// correct and normal/roughness maps stay linear.
function loadTextureCached(url, kind = 'diffuse') {
  if (_textureCache.has(url)) return _textureCache.get(url);
  const isExr = url.toLowerCase().endsWith('.exr');
  const loader = isExr ? _exrLoader : _texLoader;
  const tex = loader.load(url);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  if (kind === 'diffuse') {
    tex.colorSpace = THREE.SRGBColorSpace;
  } else {
    // Normal/roughness/metalness/etc. must stay in linear space.
    tex.colorSpace = THREE.NoColorSpace;
  }
  _textureCache.set(url, tex);
  return tex;
}

// Resolve a texture-set name like 'blue_metal_plate' into the full file paths
// following the PolyHaven 4k naming convention. Return an object of maps.
function resolveTextureSet(setName, size = '4k') {
  const base = 'assets/textures/' + setName + '_';
  return {
    map:          loadTextureCached(base + 'diff_' + size + '.jpg',  'diffuse'),
    normalMap:    loadTextureCached(base + 'nor_gl_' + size + '.exr', 'data'),
    roughnessMap: loadTextureCached(base + 'rough_' + size + '.exr',  'data'),
  };
}

// Kick off loading every gun GLB in parallel at boot. Returns a promise that
// resolves when ALL guns are loaded. Callers can also use getModel(key) which
// returns null until that specific gun is ready.
export function preloadAllGuns(basePath = 'assets/guns/') {
  const keys = Object.keys(GUN_TUNING);
  return Promise.all(keys.map((k) => loadGun(k, basePath)));
}

export function loadGun(weaponKey, basePath = 'assets/guns/') {
  if (_cache.has(weaponKey)) return Promise.resolve(_cache.get(weaponKey));
  if (_loading.has(weaponKey)) return _loading.get(weaponKey);
  const cfg = GUN_TUNING[weaponKey];
  if (!cfg) return Promise.reject(new Error('no tuning for ' + weaponKey));
  const url = basePath + cfg.file;
  const p = new Promise((resolve, reject) => {
    _loader.load(
      url,
      (gltf) => {
        const scene = gltf.scene;
        // Force materials that survive in our scene's lighting. Some authors
        // mark assets emissive=0 with very low roughness — looks black under
        // our ambient setup. We bump emissive a hair and ensure double-side.
        let meshCount = 0;
        scene.traverse((o) => {
          if (o.isMesh) {
            meshCount++;
            o.castShadow = false;
            o.receiveShadow = false;
            if (!o.material) {
              o.material = new THREE.MeshStandardMaterial({ color: 0x4a3a2a, roughness: 0.6, metalness: 0.2 });
            } else {
              o.material.side = THREE.DoubleSide;
              // Force opaque — some authoring pipelines export materials with
              // transparent=true and 0 opacity for "this should be hidden",
              // which makes the whole gun invisible.
              o.material.transparent = false;
              if ('opacity' in o.material && o.material.opacity < 0.5) o.material.opacity = 1;
              if ('metalness' in o.material && o.material.metalness > 0.9) {
                o.material.metalness = 0.7;
              }
              // Some GLBs ship near-black base colors that vanish in our ambient
              // setup (tossor / grenade launcher). Lift very dark colors so the
              // gun is visible without changing materials that already read OK.
              if (o.material.color) {
                const c = o.material.color;
                if (c.r + c.g + c.b < 0.15) {
                  c.setRGB(0.29, 0.23, 0.16);
                }
              }
              if ('emissive' in o.material) {
                o.material.emissive = new THREE.Color(0x111111);
              }
            }
          }
        });
        // Stash animation clips on the scene so getModel can return them
        // alongside the cloned mesh (used by per-weapon reload anims).
        scene.userData.animations = gltf.animations || [];
        const clipNames = scene.userData.animations.map((c) => c.name);
        // Log the raw bounding box dimensions so we can identify which axis
        // the model's longest extent (typically the barrel) runs along.
        scene.updateMatrixWorld(true);
        const _bb = new THREE.Box3().setFromObject(scene);
        const _sz = _bb.getSize(new THREE.Vector3());
        const _meshNames = [];
        scene.traverse((o) => { if (o.isMesh) _meshNames.push(o.name || '?'); });
        console.log('[gun] loaded', weaponKey, url, 'meshes:', meshCount, 'clips:', clipNames,
                    'bbox size XYZ:', _sz.x.toFixed(2), _sz.y.toFixed(2), _sz.z.toFixed(2),
                    'meshNames:', _meshNames);
        _cache.set(weaponKey, scene);
        resolve(scene);
      },
      undefined,
      (err) => { console.error('[gun] failed to load', weaponKey, url, err); reject(err); },
    );
  });
  _loading.set(weaponKey, p);
  return p;
}

// Get a fresh clone of the loaded gun model, wrapped in a group transformed
// per the tuning table. Returns null if the gun isn't loaded yet — callers
// should fall back to the procedural placeholder in that case.
export function getModel(weaponKey) {
  const tpl = _cache.get(weaponKey);
  if (!tpl) return null;
  const cfg = GUN_TUNING[weaponKey];
  // Skinned meshes need SkeletonUtils.clone to preserve the bones-to-mesh
  // bindings; the default Object3D.clone() loses the skeleton reference and
  // the gun ends up rendered at origin/zero-size (invisible).
  let hasSkinned = false;
  tpl.traverse((o) => { if (o.isSkinnedMesh) hasSkinned = true; });
  const clone = hasSkinned ? skeletonClone(tpl) : tpl.clone(true);
  // Clone materials so a per-weapon tint never leaks back into the source asset.
  clone.traverse((o) => {
    if (o.isMesh && o.material) o.material = o.material.clone();
  });
  // Optional per-weapon tint override — for guns whose stock materials are
  // too dark/black to read against our scene.
  if (cfg.tint != null) {
    clone.traverse((o) => {
      if (o.isMesh && o.material && o.material.color) {
        o.material.color.setHex(cfg.tint);
      }
    });
  }
  // Procedural "skin" — vivid Fortnite-style colored materials with a small
  // emissive glow. Zero loading cost (no texture files), and the aggressive
  // opacity reset below also fixes ghost-rendered skinned meshes.
  if (cfg.skin) {
    const sk = cfg.skin;
    // Build the palette of THREE.Color objects so we can apply them as vertex
    // colors on geometry that ships as a single mesh.
    const palette = [sk.color];
    if (sk.accent  != null) palette.push(sk.accent);
    if (sk.accent2 != null) palette.push(sk.accent2);
    if (sk.accent3 != null) palette.push(sk.accent3);
    if (sk.accent4 != null) palette.push(sk.accent4);
    const paletteColors = palette.map((h) => new THREE.Color(h));
    // Compute the overall bbox of the cloned model so vertex-color zones can
    // be assigned based on each vertex's relative position. Skinned meshes
    // need this to reflect the rest pose, so we walk meshes' geometry bboxes.
    const skinBBox = new THREE.Box3();
    clone.traverse((o) => {
      if (o.isMesh && o.geometry) {
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        const gb = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
        skinBBox.union(gb);
      }
    });
    const bbSize = skinBBox.getSize(new THREE.Vector3());
    const bbMin = skinBBox.min;
    const longestAxis = (bbSize.x >= bbSize.y && bbSize.x >= bbSize.z) ? 'x' : (bbSize.y >= bbSize.z ? 'y' : 'z');
    // Stable per-mesh color assignment: hash the mesh name (or fall back to
    // visit index) so the same model always gets the same coloring pattern.
    let visit = 0;
    clone.traverse((o) => {
      if (o.isMesh && o.material) {
        // Wipe any prior texture maps so the skin color isn't multiplied by
        // whatever the GLB shipped with.
        o.material.map = null;
        o.material.normalMap = null;
        o.material.roughnessMap = null;
        o.material.metalnessMap = null;
        o.material.alphaMap = null;
        // Pick a palette slot. Start from the visit index so colors rotate
        // even when mesh names are generic, then let known part-name hints
        // override (mag/grip → 1, trigger/sight → 2, barrel → 3, scope → 4).
        let slot = palette.length > 1 ? (visit % palette.length) : 0;
        const name = (o.name || '').toLowerCase();
        if (palette.length > 1 && name) {
          if (name.includes('mag') || name.includes('grip') || name.includes('stock')) {
            slot = 1 % palette.length;
          } else if (name.includes('trig') || name.includes('safety') || name.includes('rail')) {
            slot = 2 % palette.length;
          } else if (name.includes('barrel') || name.includes('muzzle') || name.includes('suppres')) {
            slot = 3 % palette.length;
          } else if (name.includes('sight') || name.includes('scope') || name.includes('bolt') || name.includes('handle')) {
            slot = 4 % palette.length;
          }
        }
        if (o.material.color) o.material.color.setHex(palette[slot]);
        if ('emissive' in o.material && sk.emissive != null) {
          // Accent meshes get a slightly stronger emissive lift than the body.
          const emHex = slot === 0 ? sk.emissive : 0x2a2a2a;
          o.material.emissive.setHex(emHex);
        }
        if ('roughness' in o.material && sk.roughness != null) o.material.roughness = sk.roughness;
        if ('metalness' in o.material && sk.metalness != null) o.material.metalness = sk.metalness;
        // Bake per-vertex colors so even guns that ship as a single mesh get
        // multi-color regions. Each vertex picks a palette slot based on
        // where it sits along the gun's longest axis (typically the barrel).
        // Vertices very close to band boundaries get BLACK so the colors look
        // layered with crisp dark outlines between them.
        if (o.geometry && o.geometry.attributes.position && paletteColors.length > 1) {
          const BLACK = new THREE.Color(0x0a0a0a);
          const posAttr = o.geometry.attributes.position;
          const colorArr = new Float32Array(posAttr.count * 3);
          const tmpV = new THREE.Vector3();
          for (let i = 0; i < posAttr.count; i++) {
            tmpV.fromBufferAttribute(posAttr, i).applyMatrix4(o.matrixWorld);
            const axisVal = tmpV[longestAxis] - bbMin[longestAxis];
            const axisSize = bbSize[longestAxis] || 1;
            const tNorm = Math.max(0, Math.min(0.9999, axisVal / axisSize));
            const vBias = (tmpV.y - bbMin.y) / (bbSize.y || 1);
            const blended = (tNorm * 0.75 + vBias * 0.25);
            const scaled = blended * paletteColors.length;
            const idx = Math.floor(scaled);
            // Position within the current band, 0..1.
            const bandPos = scaled - idx;
            let c;
            // First/last 6% of every band → black outline. Creates fine dark
            // dividers between the palette colors.
            if (bandPos < 0.06 || bandPos > 0.94) {
              c = BLACK;
            } else {
              c = paletteColors[Math.min(paletteColors.length - 1, idx)];
            }
            colorArr[i * 3]     = c.r;
            colorArr[i * 3 + 1] = c.g;
            colorArr[i * 3 + 2] = c.b;
          }
          o.geometry.setAttribute('color', new THREE.BufferAttribute(colorArr, 3));
          o.material.vertexColors = true;
          // White base so the per-vertex colors aren't multiplied down.
          if (o.material.color) o.material.color.setHex(0xffffff);
        }
        // Force fully-opaque + write to depth so skinned meshes (e.g. spudling)
        // can't render as ghosts when the GLB ships transparent=true.
        o.material.transparent = false;
        o.material.opacity = 1.0;
        o.material.alphaTest = 0;
        o.material.depthWrite = true;
        o.material.depthTest = true;
        o.material.needsUpdate = true;
        visit++;
      }
    });
  } else if (cfg.textureSet) {
    // Legacy PBR texture-set path (kept for fallback).
    const maps = resolveTextureSet(cfg.textureSet);
    clone.traverse((o) => {
      if (o.isMesh && o.material) {
        o.material.map = maps.map;
        o.material.normalMap = maps.normalMap;
        o.material.roughnessMap = maps.roughnessMap;
        if (o.material.color) o.material.color.setHex(0xffffff);
        if ('roughness' in o.material) o.material.roughness = 1.0;
        if ('metalness' in o.material) o.material.metalness = 0.4;
        if ('emissive' in o.material) o.material.emissive = new THREE.Color(0x202020);
        o.material.transparent = false;
        o.material.opacity = 1.0;
        o.material.needsUpdate = true;
      }
    });
  }
  // Normalize each GLB to a 1-unit longest dimension, then recenter in its
  // bounding box. After this, the wrap-level `scale` value equals the gun's
  // on-screen length in meters regardless of how the GLB was authored (some
  // ship at meter scale, others at centimeter or arbitrary scale).
  // For skinned models, Box3.setFromObject includes bone positions which can
  // extend well beyond the visible mesh — that made the gun normalize to a
  // tiny fraction of its real size. Build the bbox from the mesh GEOMETRIES
  // only (transformed by their world matrix) so skeletons don't distort it.
  clone.updateMatrixWorld(true);
  const bbox1 = new THREE.Box3();
  let bboxFromGeom = false;
  clone.traverse((o) => {
    if (o.isMesh && o.geometry) {
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      const gb = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
      bbox1.union(gb);
      bboxFromGeom = true;
    }
  });
  if (!bboxFromGeom) bbox1.setFromObject(clone);
  const size = bbox1.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  // Optional per-axis chunkiness in MODEL space. Lets us fatten width/height
  // without changing length — long guns look skinny otherwise because the
  // GLBs are authored at realistic rifle aspect ratios (~10:1).
  const ms = cfg.modelScale || [1, 1, 1];
  clone.scale.set((1 / maxDim) * ms[0], (1 / maxDim) * ms[1], (1 / maxDim) * ms[2]);
  clone.updateMatrixWorld(true);
  const bbox2 = new THREE.Box3();
  let bbox2FromGeom = false;
  clone.traverse((o) => {
    if (o.isMesh && o.geometry && o.geometry.boundingBox) {
      const gb = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
      bbox2.union(gb);
      bbox2FromGeom = true;
    }
  });
  if (!bbox2FromGeom) bbox2.setFromObject(clone);
  const center = bbox2.getCenter(new THREE.Vector3());
  clone.position.sub(center);
  const wrap = new THREE.Group();
  wrap.add(clone);
  wrap.position.set(...cfg.position);
  wrap.rotation.set(...cfg.rotation);
  // Optional roll around the world-forward axis (gunHolder is identity-rotated
  // at setup time, so world -Z is the barrel direction after cfg.rotation).
  // Positive `roll` = clockwise viewed from the camera.
  if (cfg.roll) {
    wrap.rotateOnWorldAxis(new THREE.Vector3(0, 0, -1), cfg.roll);
  }
  wrap.scale.setScalar(cfg.scale);
  // Pass along the GLB's animation clips + the cloned root so the player can
  // bind an AnimationMixer for reload-anim playback. We pass `clone` (not
  // `wrap`) because animations target the original scene's node names.
  wrap.userData = {
    weaponKey,
    muzzleOffset: cfg.muzzleOffset,
    animations: tpl.userData.animations || [],
    animRoot: clone,
  };
  return wrap;
}

export function isLoaded(weaponKey) { return _cache.has(weaponKey); }
