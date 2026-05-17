import * as THREE from 'three';

const POTATO_COLORS = [0xc47a3d, 0xb8693a, 0xd08a4a, 0xa05828, 0x9d6033];

export function makePotato({ color, size = 1, eyes = true } = {}) {
  const group = new THREE.Group();
  const c = color ?? POTATO_COLORS[Math.floor(Math.random() * POTATO_COLORS.length)];

  const geo = new THREE.SphereGeometry(0.5, 18, 14);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const bump = Math.sin(x * 6 + y * 3) * Math.cos(z * 5) * 0.04;
    pos.setX(i, x * (1.0 + bump));
    pos.setY(i, y * 1.45 + bump * 0.5);
    pos.setZ(i, z * (1.0 + bump));
  }
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    color: c,
    roughness: 0.92,
    flatShading: false,
  });
  const body = new THREE.Mesh(geo, mat);
  body.scale.setScalar(size);
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  // dark "eye" spots that real potatoes have
  const spotMat = new THREE.MeshBasicMaterial({ color: 0x4a2c1a });
  for (let i = 0; i < 6; i++) {
    const spot = new THREE.Mesh(new THREE.SphereGeometry(0.045 * size, 6, 4), spotMat);
    const theta = Math.random() * Math.PI * 2;
    const phi = (Math.random() * 0.8 + 0.1) * Math.PI;
    spot.position.set(
      Math.sin(phi) * Math.cos(theta) * 0.5 * size,
      Math.cos(phi) * 0.72 * size,
      Math.sin(phi) * Math.sin(theta) * 0.5 * size
    );
    group.add(spot);
  }

  if (eyes) {
    const eyeWhite = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const pupil = new THREE.MeshBasicMaterial({ color: 0x111111 });
    for (const sx of [-1, 1]) {
      const w = new THREE.Mesh(new THREE.SphereGeometry(0.13 * size, 10, 8), eyeWhite);
      w.position.set(sx * 0.18 * size, 0.22 * size, 0.42 * size);
      group.add(w);
      const p = new THREE.Mesh(new THREE.SphereGeometry(0.07 * size, 8, 6), pupil);
      p.position.set(sx * 0.18 * size, 0.22 * size, 0.52 * size);
      group.add(p);
    }
    // angry brow
    const browMat = new THREE.MeshBasicMaterial({ color: 0x2a1a0a });
    for (const sx of [-1, 1]) {
      const brow = new THREE.Mesh(new THREE.BoxGeometry(0.16 * size, 0.04 * size, 0.04 * size), browMat);
      brow.position.set(sx * 0.18 * size, 0.36 * size, 0.5 * size);
      brow.rotation.z = sx * 0.4;
      group.add(brow);
    }
  }

  return group;
}
