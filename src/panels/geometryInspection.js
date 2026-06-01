import * as THREE from 'three';
import { app } from '../app.js';

const GEOMETRY_MARKER_RADIUS = 0.002;
const DEFAULT_GEOMETRY_COLOR = '#ff8c00';

let vertexGroup = null;
let edgeGroup = null;
let faceGroup = null;

const settings = {
  vertices: { show: false },
  edges: { show: false },
  faces: { show: false },
  color: DEFAULT_GEOMETRY_COLOR,
};

function isVisibleInCurrentHierarchy(object) {
  let cursor = object;

  while (cursor) {
    if (cursor.visible === false) return false;
    if (cursor === app.currentObject) return true;
    cursor = cursor.parent;
  }

  return true;
}

let rebuildPending = false;

function scheduleRebuild() {
  if (rebuildPending) return;

  rebuildPending = true;
  requestAnimationFrame(() => {
    rebuildPending = false;
    rebuildAll();
  });
}

function disposeGroup(group) {
  group.traverse(child => {
    child.geometry?.dispose?.();

    if (child.material) {
      [].concat(child.material).forEach(mat => mat?.dispose?.());
    }
  });
}

function clearVertices() {
  if (!vertexGroup) return;

  disposeGroup(vertexGroup);
  vertexGroup.removeFromParent();
  vertexGroup = null;
}

function clearEdges() {
  if (!edgeGroup) return;

  disposeGroup(edgeGroup);
  edgeGroup.removeFromParent();
  edgeGroup = null;
}

function clearFaces() {
  if (!faceGroup) return;

  disposeGroup(faceGroup);
  faceGroup.removeFromParent();
  faceGroup = null;
}

function setGroupMaterialsColor(group, color) {
  if (!group) return;

  group.traverse(child => {
    if (!child.material) return;

    [].concat(child.material).forEach(mat => {
      if (!mat?.color) return;
      mat.color.set(color);
      mat.needsUpdate = true;
    });
  });
}

function makeMarkerMaterial() {
  const mat = new THREE.MeshBasicMaterial({
    color: settings.color,
    depthTest: true,
    depthWrite: false,
  });

  mat.depthFunc = THREE.LessEqualDepth;
  return mat;
}

function makeLineMaterial() {
  const mat = new THREE.LineBasicMaterial({
    color: settings.color,
    depthTest: true,
    depthWrite: false,
  });

  mat.depthFunc = THREE.LessEqualDepth;
  return mat;
}

function buildVertices() {
  clearVertices();

  if (!settings.vertices.show || !app.currentObject) return;

  vertexGroup = new THREE.Group();
  vertexGroup.name = 'geo-vertices';
  vertexGroup.renderOrder = 999;
  app.scene.add(vertexGroup);

  app.currentObject.traverse(mesh => {
    if (!mesh.isMesh || !isVisibleInCurrentHierarchy(mesh)) return;

    const pos = mesh.geometry?.attributes?.position;
    if (!pos) return;

    const localToWorld = mesh.matrixWorld.clone();
    const geometry = new THREE.SphereGeometry(1, 6, 4);
    const material = makeMarkerMaterial();
    const markers = new THREE.InstancedMesh(geometry, material, pos.count);
    const dummy = new THREE.Object3D();

    markers.renderOrder = 999;

    for (let i = 0; i < pos.count; i++) {
      dummy.position.copy(
        new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(localToWorld)
      );
      dummy.scale.setScalar(GEOMETRY_MARKER_RADIUS);
      dummy.updateMatrix();
      markers.setMatrixAt(i, dummy.matrix);
    }

    markers.instanceMatrix.needsUpdate = true;
    vertexGroup.add(markers);
  });
}

function buildEdges() {
  clearEdges();

  if (!settings.edges.show || !app.currentObject) return;

  edgeGroup = new THREE.Group();
  edgeGroup.name = 'geo-edges';
  edgeGroup.renderOrder = 999;
  app.scene.add(edgeGroup);

  app.currentObject.traverse(mesh => {
    if (!mesh.isMesh || !isVisibleInCurrentHierarchy(mesh) || !mesh.geometry?.attributes?.position) return;

    const edgesGeometry = new THREE.EdgesGeometry(mesh.geometry, 0);
    const material = makeLineMaterial();
    const lines = new THREE.LineSegments(edgesGeometry, material);

    lines.applyMatrix4(mesh.matrixWorld.clone());
    lines.renderOrder = 999;
    edgeGroup.add(lines);
  });
}

function buildFaces() {
  clearFaces();

  if (!settings.faces.show || !app.currentObject) return;

  faceGroup = new THREE.Group();
  faceGroup.name = 'geo-faces';
  faceGroup.renderOrder = 999;
  app.scene.add(faceGroup);

  app.currentObject.traverse(mesh => {
    if (!mesh.isMesh || !isVisibleInCurrentHierarchy(mesh)) return;

    const pos = mesh.geometry?.attributes?.position;
    if (!pos) return;

    const idx = mesh.geometry.index;
    const localToWorld = mesh.matrixWorld.clone();
    const triCount = idx ? idx.count / 3 : pos.count / 3;
    const centers = [];

    for (let t = 0; t < triCount; t++) {
      const a = idx ? idx.getX(t * 3) : t * 3;
      const b = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
      const c = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;

      const va = new THREE.Vector3().fromBufferAttribute(pos, a).applyMatrix4(localToWorld);
      const vb = new THREE.Vector3().fromBufferAttribute(pos, b).applyMatrix4(localToWorld);
      const vc = new THREE.Vector3().fromBufferAttribute(pos, c).applyMatrix4(localToWorld);

      centers.push(va.add(vb).add(vc).multiplyScalar(1 / 3));
    }

    if (!centers.length) return;

    const geometry = new THREE.SphereGeometry(1, 6, 4);
    const material = makeMarkerMaterial();
    const markers = new THREE.InstancedMesh(geometry, material, centers.length);
    const dummy = new THREE.Object3D();

    markers.renderOrder = 999;

    centers.forEach((center, i) => {
      dummy.position.copy(center);
      dummy.scale.setScalar(GEOMETRY_MARKER_RADIUS);
      dummy.updateMatrix();
      markers.setMatrixAt(i, dummy.matrix);
    });

    markers.instanceMatrix.needsUpdate = true;
    faceGroup.add(markers);
  });
}

function rebuildAll() {
  buildVertices();
  buildEdges();
  buildFaces();
}

function clearAll() {
  clearVertices();
  clearEdges();
  clearFaces();
}

function applySharedColor(color) {
  settings.color = color || DEFAULT_GEOMETRY_COLOR;

  setGroupMaterialsColor(vertexGroup, settings.color);
  setGroupMaterialsColor(edgeGroup, settings.color);
  setGroupMaterialsColor(faceGroup, settings.color);
}

// ── Init ──
export function initGeometryInspection() {
  const vertCheck = document.getElementById('geo-vertices');
  const edgeCheck = document.getElementById('geo-edges');
  const faceCheck = document.getElementById('geo-faces');
  const colorInput = document.getElementById('geo-pick-color');

  colorInput?.addEventListener('input', () => {
    applySharedColor(colorInput.value);
  });

  vertCheck?.addEventListener('change', () => {
    settings.vertices.show = vertCheck.checked;
    scheduleRebuild();
  });

  edgeCheck?.addEventListener('change', () => {
    settings.edges.show = edgeCheck.checked;
    scheduleRebuild();
  });

  faceCheck?.addEventListener('change', () => {
    settings.faces.show = faceCheck.checked;
    scheduleRebuild();
  });

  return {
    onFileLoaded() {
      clearAll();
      rebuildAll();
    },

    reset() {
      clearAll();

      if (vertCheck) vertCheck.checked = false;
      if (edgeCheck) edgeCheck.checked = false;
      if (faceCheck) faceCheck.checked = false;
      if (colorInput) colorInput.value = DEFAULT_GEOMETRY_COLOR;

      settings.vertices.show = false;
      settings.edges.show = false;
      settings.faces.show = false;
      settings.color = DEFAULT_GEOMETRY_COLOR;
    },

    // Kept as a no-op because main.js calls this every frame.
    updateAllLabels() {},
  };
}
