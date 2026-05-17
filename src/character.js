// Mixamo character loader. The four GLBs in assets/character/ are converted
// from FBX (Mixamo export) via `assimp export` + `gltf-transform optimize
// --compress meshopt`, with textures resized to 32x32 (we replace materials
// at runtime so we don't need the original textures). Together they're ~1.9MB.
//
// Each GLB ships the *same* skinned mesh plus one animation clip. We use the
// Walking file's scene as the template (cloned per instance via SkeletonUtils),
// and extract just the AnimationClip from the others.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

// Mixamo characters are modelled in centimeters; bring them down to meters
// (and match the game's roughly-1.5m potato scale).
const MIXAMO_SCALE = 0.011;

const FILES = {
  walking:   'assets/character/mx_Walking.glb',
  jumping:   'assets/character/mx_Jumping_Down.glb',
  sliding:   'assets/character/mx_Running_Slide.glb',
  reloading: 'assets/character/mx_Reloading.glb',
};

let _template = null;          // the base scene we clone from
let _clips = {};               // name -> AnimationClip
let _loadPromise = null;
let _ready = false;

export function isCharacterReady() { return _ready; }

export function preloadCharacter() {
  if (_loadPromise) return _loadPromise;
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  _loadPromise = (async () => {
    const out = {};
    for (const [name, url] of Object.entries(FILES)) {
      try {
        out[name] = await loader.loadAsync(url);
      } catch (err) {
        console.warn('[character] failed to load', url, err);
      }
    }
    if (out.walking) {
      _template = out.walking.scene;
      // Ensure all meshes inside cast/receive shadows by default
      _template.traverse((o) => {
        if (o.isMesh || o.isSkinnedMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
          o.frustumCulled = false;   // skinned bounds are notoriously wonky
        }
      });
    }
    for (const [name, gltf] of Object.entries(out)) {
      const clip = gltf.animations?.[0];
      if (clip) {
        clip.name = name;
        _clips[name] = clip;
      }
    }
    _ready = !!_template;
    return _ready;
  })();
  return _loadPromise;
}

// Returns { mesh, mixer, actions, play(name), playOnce(name, fadeMs) } for a
// freshly-cloned instance. Returns null if the character hasn't loaded yet —
// caller should fall back to its old mesh.
export function makeCharacter({ tint = 0xd1a36a } = {}) {
  if (!_ready || !_template) return null;
  const mesh = cloneSkinned(_template);
  mesh.scale.setScalar(MIXAMO_SCALE);
  // Strip Mixamo's textures — they were resized to 32x32 to keep the GLB
  // tiny, so they look like garbage anyway. Replace every material with a
  // single tinted lambert. We split body color from clothes/etc later if
  // we feel like it; for now everything gets the same wash.
  mesh.traverse((o) => {
    if (o.isMesh || o.isSkinnedMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      o.frustumCulled = false;
      o.material = new THREE.MeshLambertMaterial({ color: tint });
    }
  });
  const mixer = new THREE.AnimationMixer(mesh);
  const actions = {};
  for (const [name, clip] of Object.entries(_clips)) {
    actions[name] = mixer.clipAction(clip);
  }
  // Walking is our default / idle (timeScale will be zeroed for true idle)
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
}
