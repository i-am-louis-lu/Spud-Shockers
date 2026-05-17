// Mixamo character loader. We deliberately do NOT static-import this module
// from main.js — instead main.js dynamic-imports it inside a try/catch so
// that if ANYTHING in here fails (a missing GLB, a broken import URL, an API
// shape that changed in three.js, etc.) the start screen still boots and the
// player can still play the game with the procedural gun viewmodel.
//
// Pipeline used to produce assets/character/*.glb:
//   assimp export <name>.fbx /tmp/out.glb
//   npx @gltf-transform/cli resize /tmp/out.glb /tmp/small.glb --width 32 --height 32
//   npx @gltf-transform/cli optimize /tmp/small.glb assets/character/<name>.glb --compress meshopt
//
// Each GLB ships the same skinned mesh and one animation clip. We use the
// Walking file's scene as the template (cloned per instance via SkeletonUtils)
// and pull just the AnimationClips from the others.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Mixamo characters are modelled in centimeters; scale down to meters.
const MIXAMO_SCALE = 0.011;

const FILES = {
  walking:    'assets/character/mx_Walking.glb',
  jumping:    'assets/character/mx_Jumping_Down.glb',
  sliding:    'assets/character/mx_Running_Slide.glb',
  reloading:  'assets/character/mx_Reloading.glb',
  stabbing:   'assets/character/mx_Stabbing.glb',
  pistolWalk: 'assets/character/mx_Pistol_Walk.glb',
};

let _template = null;
let _clips = {};
let _loadPromise = null;
let _ready = false;
let _error = null;

export function isCharacterReady() { return _ready; }
export function getCharacterError() { return _error; }

// Returns a promise that resolves to true on success, false on any failure.
// Never throws. main.js can call this and ignore the result safely.
export function preloadCharacter() {
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    try {
      // Try to enable Meshopt compression decoding. If the URL/import fails,
      // the GLBs we ship won't load — but rather than break everything, we
      // just bail out gracefully and the game runs without skinned arms.
      let meshoptDecoder = null;
      try {
        const mod = await import('three/addons/libs/meshopt_decoder.module.js');
        meshoptDecoder = mod.MeshoptDecoder;
      } catch (err) {
        console.warn('[character] meshopt decoder unavailable, skipping character load', err);
        _error = err;
        return false;
      }

      const loader = new GLTFLoader();
      if (meshoptDecoder) loader.setMeshoptDecoder(meshoptDecoder);

      const results = {};
      for (const [name, url] of Object.entries(FILES)) {
        try {
          results[name] = await loader.loadAsync(url);
        } catch (err) {
          console.warn('[character] failed to load', url, err);
        }
      }
      if (!results.walking) {
        console.warn('[character] base mesh (walking) failed to load — aborting character system');
        return false;
      }
      _template = results.walking.scene;
      _template.traverse((o) => {
        if (o.isMesh || o.isSkinnedMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
          o.frustumCulled = false;   // skinned bbox is unreliable
        }
      });
      for (const [name, gltf] of Object.entries(results)) {
        const clip = gltf?.animations?.[0];
        if (clip) {
          clip.name = name;
          _clips[name] = clip;
        }
      }
      _ready = true;
      return true;
    } catch (err) {
      console.warn('[character] preload failed', err);
      _error = err;
      return false;
    }
  })();
  return _loadPromise;
}

// Custom-shader vertex mask. Walks the skinned mesh's skeleton, picks out the
// arm-chain bones, and injects a tiny snippet into the material shader that
// discards any vertex whose skin-weight to those arm bones is below a small
// threshold. End result: the chest / hips / legs vanish entirely while the
// shoulders + arms + hands stay fully visible, with no bone scaling required.
// Wrapped in try/catch — if the shader hook breaks, the character just looks
// like the full body (no discard) which is the old behavior.
function applyArmsOnlyMask(skinnedMesh, {
  // Default: BOTH arm chains. The dev positioning panel lets the player
  // place the arms so both hands grip the gun naturally.
  armsRegex = /(Shoulder|Arm|ForeArm|Hand)/,
  // Threshold 0.55 means a vertex must have MAJORITY skin weight to arm
  // bones to survive the mask. At 0.3 the chest near the shoulders was
  // bleeding through because those vertices have ~30-40% shoulder weight.
  threshold = 0.55,
} = {}) {
  try {
    const skel = skinnedMesh.skeleton;
    if (!skel || !skel.bones) return;
    const armIdx = [];
    skel.bones.forEach((b, i) => {
      const n = b?.name || '';
      // "Arm" matches both Arm and ForeArm. Hand matches Hand + finger bones.
      if (armsRegex.test(n)) armIdx.push(i);
    });
    if (armIdx.length === 0) return;
    const MAX = Math.max(armIdx.length, 64);
    const armArr = new Array(MAX).fill(-1);
    armIdx.forEach((v, i) => { armArr[i] = v; });
    const mat = skinnedMesh.material;
    if (!mat) return;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.armBoneIndices = { value: armArr };
      shader.uniforms.numArmBones = { value: armIdx.length };
      shader.vertexShader =
        `varying float vArmWeight;\n` +
        `uniform int armBoneIndices[${MAX}];\n` +
        `uniform int numArmBones;\n` +
        shader.vertexShader.replace(
          '#include <skinning_vertex>',
          `#include <skinning_vertex>
           float armWt = 0.0;
           for (int i = 0; i < ${MAX}; i++) {
             if (i >= numArmBones) break;
             int idx = armBoneIndices[i];
             if (int(skinIndex.x) == idx) armWt += skinWeight.x;
             if (int(skinIndex.y) == idx) armWt += skinWeight.y;
             if (int(skinIndex.z) == idx) armWt += skinWeight.z;
             if (int(skinIndex.w) == idx) armWt += skinWeight.w;
           }
           vArmWeight = armWt;`,
        );
      shader.fragmentShader =
        `varying float vArmWeight;\n` +
        shader.fragmentShader.replace(
          'void main() {',
          `void main() { if (vArmWeight < ${threshold.toFixed(3)}) discard;`,
        );
    };
    mat.needsUpdate = true;
  } catch (err) {
    console.warn('[character] arms-only shader mask failed', err);
  }
}

// Returns { mesh, mixer, actions, play } for a fresh clone, or null if the
// character system isn't ready. Never throws.
// Default tint is a light skin/peach tone — the Mixamo character's original
// textures got stripped during the FBX→GLB optimization (we resize textures
// to 32x32 to keep the bundle small), so we substitute a flat material that
// reads as "skin" rather than the old brown.
export async function makeCharacter({ tint = 0xe8c6a4, armsOnly = false } = {}) {
  if (!_ready || !_template) return null;
  try {
    // SkeletonUtils lives at /utils/SkeletonUtils.js — dynamic-import so a
    // missing URL doesn't break the static graph.
    const { clone: cloneSkinned } = await import('three/addons/utils/SkeletonUtils.js');
    const mesh = cloneSkinned(_template);
    mesh.scale.setScalar(MIXAMO_SCALE);
    mesh.traverse((o) => {
      if (o.isMesh || o.isSkinnedMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        o.frustumCulled = false;
        o.material = new THREE.MeshLambertMaterial({ color: tint });
        // Arms-only mode (FPS view) — discard non-arm vertices in the shader
        // so head/chest/legs disappear cleanly without breaking the skeleton.
        if (armsOnly && o.isSkinnedMesh) {
          applyArmsOnlyMask(o);
        }
      }
    });
    const mixer = new THREE.AnimationMixer(mesh);
    const actions = {};
    for (const [name, clip] of Object.entries(_clips)) {
      actions[name] = mixer.clipAction(clip);
    }
    const current = { name: null };
    function play(name, { loop = true, timeScale = 1, fadeMs = 150 } = {}) {
      const next = actions[name];
      if (!next) return;
      next.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
      next.clampWhenFinished = !loop;
      next.timeScale = timeScale;
      if (current.name === name) return;
      const prev = current.name ? actions[current.name] : null;
      next.reset().fadeIn(fadeMs / 1000).play();
      if (prev) prev.fadeOut(fadeMs / 1000);
      current.name = name;
    }
    return { mesh, mixer, actions, play, current };
  } catch (err) {
    console.warn('[character] makeCharacter failed', err);
    return null;
  }
}
