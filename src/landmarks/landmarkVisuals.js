import * as THREE from 'three';
import '../css/landmarkVisuals.css';

export const LANDMARK_COLORS = {
  default: '#00ffcc',
  selected: '#43a5ff',
  last: '#ffcc00',
  remove: '#ff0000',
  line: '#ffcc00',
};

export function landmarkCursorDescriptor({ dragging = false, state = null } = {}) {
  if (dragging) {
    return {
      className: 'is-ctrl',
      cursor: 'grabbing',
      html: '<span class="cursor-icon">grab</span>',
    };
  }

  if (state?.ctrlOrMeta) {
    return {
      className: 'is-ctrl',
      cursor: 'grab',
      html: '<span class="cursor-icon">grab</span>',
    };
  }

  if (state?.alt) {
    return {
      className: 'is-alt',
      cursor: 'crosshair',
      html: '<span class="cursor-plus">+</span><span class="cursor-separator">/</span><span class="cursor-minus">−</span>',
    };
  }

  if (state?.shift) {
    return {
      className: 'is-shift',
      cursor: 'pointer',
      html: '<span class="cursor-icon">select</span><span class="cursor-separator">⇄</span>',
    };
  }

  return null;
}

export function landmarkMarkerRadiusForBox(box, scale = 1) {
  const size = box?.getSize(new THREE.Vector3()).length();
  const safeScale = Number.isFinite(scale) ? scale : 1;

  if (!Number.isFinite(size) || size <= 0) {
    return 0.012 * safeScale;
  }

  return THREE.MathUtils.clamp(size * 0.008, 0.008, 0.025) * safeScale;
}

export function landmarkMarkerRadiusForObject(object, scale = 1) {
  if (!object) return 0.012 * (Number.isFinite(scale) ? scale : 1);
  return landmarkMarkerRadiusForBox(new THREE.Box3().setFromObject(object), scale);
}

export function landmarkMarkerRadiusForObjects(objects, scale = 1) {
  const box = new THREE.Box3();
  let hasObject = false;

  objects.filter(Boolean).forEach(object => {
    box.expandByObject(object);
    hasObject = true;
  });

  return hasObject
    ? landmarkMarkerRadiusForBox(box, scale)
    : landmarkMarkerRadiusForObject(null, scale);
}

export function makeLandmarkSphere({
  color = LANDMARK_COLORS.default,
  radius = 1,
  selected = false,
  depthTest = true,
  renderOrder = 10001,
  userData = null,
} = {}) {
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(selected ? radius * 1.35 : radius, 24, 16),
    new THREE.MeshBasicMaterial({
      color,
      depthTest,
      depthWrite: false,
      depthFunc: THREE.LessEqualDepth,
      transparent: false,
      toneMapped: false,
    })
  );

  sphere.renderOrder = renderOrder;
  sphere.frustumCulled = false;

  if (userData) {
    Object.assign(sphere.userData, userData);
  }

  return sphere;
}

export function makeLandmarkLabelSprite({
  text,
  position,
  color = LANDMARK_COLORS.default,
  radius = 1,
  labelScale = 1,
  depthTest = true,
  renderOrder = 10002,
} = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 64;

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = 'bold 30px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 7;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
  ctx.strokeText(text, 64, 32);
  ctx.fillStyle = color;
  ctx.fillText(text, 64, 32);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  const material = new THREE.SpriteMaterial({
    map: texture,
    depthTest,
    depthWrite: false,
    transparent: true,
    toneMapped: false,
  });

  const textRadius = radius * (Number.isFinite(labelScale) ? labelScale : 1);
  const sprite = new THREE.Sprite(material);
  sprite.position.copy(position).add(new THREE.Vector3(0, textRadius * 2.8, 0));
  sprite.scale.set(textRadius * 7.0, textRadius * 3.5, 1);
  sprite.renderOrder = renderOrder;
  sprite.frustumCulled = false;
  return sprite;
}
