import * as THREE from 'three';
import { app } from '../app.js';
import { getCanonicalPositionAttribute, getCanonicalData } from '../tasks/meshTaskUtils.js';
import { getMeshSymmetry, symmetryPairs } from '../io/vertexSymmetry.js';

const GEOMETRY_MARKER_RADIUS = 0.002;
const DEFAULT_GEOMETRY_COLORS = Object.freeze({
  vertices: '#ff5c8a',
  edges: '#32b67a',
  faces: '#8b7cf6',
  symmetry: '#00bcd4',
  symmetryLeft: '#ff3333',
  symmetryRight: '#2f80ff',
  symmetrySelf: '#ffffff',
  symmetryPlane: '#ffffff',
});

let vertexGroup = null;
let edgeGroup = null;
let faceGroup = null;
let symmetryGroup = null;

const settings = {
  vertices: { show: false, color: DEFAULT_GEOMETRY_COLORS.vertices },
  edges: { show: false, color: DEFAULT_GEOMETRY_COLORS.edges },
  faces: { show: false, color: DEFAULT_GEOMETRY_COLORS.faces },
  symmetry: { show: false, color: DEFAULT_GEOMETRY_COLORS.symmetry },
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

function clearSymmetry() {
  if (!symmetryGroup) return;

  disposeGroup(symmetryGroup);
  symmetryGroup.removeFromParent();
  symmetryGroup = null;
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

function makeMarkerMaterial(color) {
  const mat = new THREE.MeshBasicMaterial({
    color,
    depthTest: true,
    depthWrite: false,
  });

  mat.depthFunc = THREE.LessEqualDepth;
  return mat;
}

function makePlaneMaterial(color) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.18,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

function makeLineMaterial(color) {
  const mat = new THREE.LineBasicMaterial({
    color,
    depthTest: true,
    depthWrite: false,
  });

  mat.depthFunc = THREE.LessEqualDepth;
  return mat;
}

function makeMarkerInstances(pos, localToWorld, indices, color, radiusScale = 1.8) {
  if (!indices.length) return null;

  const geometry = new THREE.SphereGeometry(1, 8, 6);
  const material = makeMarkerMaterial(color);
  const markers = new THREE.InstancedMesh(geometry, material, indices.length);
  const dummy = new THREE.Object3D();

  markers.renderOrder = 1002;

  indices.forEach((index, i) => {
    dummy.position.copy(new THREE.Vector3().fromBufferAttribute(pos, index).applyMatrix4(localToWorld));
    dummy.scale.setScalar(GEOMETRY_MARKER_RADIUS * radiusScale);
    dummy.updateMatrix();
    markers.setMatrixAt(i, dummy.matrix);
  });

  markers.instanceMatrix.needsUpdate = true;
  return markers;
}

function addSymmetryPlane(mesh, pos, symmetry, localToWorld) {
  if (!symmetry.plane) return;

  const box = new THREE.Box3();
  for (let i = 0; i < pos.count; i++) {
    box.expandByPoint(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(localToWorld));
  }

  const size = box.getSize(new THREE.Vector3()).length();
  if (!Number.isFinite(size) || size <= 0) return;

  const localPoint = new THREE.Vector3(...symmetry.plane.point).applyMatrix4(localToWorld);
  const localNormalEnd = new THREE.Vector3(
    symmetry.plane.point[0] + symmetry.plane.normal[0],
    symmetry.plane.point[1] + symmetry.plane.normal[1],
    symmetry.plane.point[2] + symmetry.plane.normal[2]
  ).applyMatrix4(localToWorld);
  const worldNormal = localNormalEnd.sub(localPoint).normalize();

  const geometry = new THREE.PlaneGeometry(size * 0.72, size * 0.72);
  const plane = new THREE.Mesh(geometry, makePlaneMaterial(DEFAULT_GEOMETRY_COLORS.symmetryPlane));
  plane.position.copy(localPoint);
  plane.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), worldNormal);
  plane.renderOrder = 998;
  symmetryGroup.add(plane);
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

    const pos = getCanonicalPositionAttribute(mesh);
    if (!pos) return;

    const localToWorld = mesh.matrixWorld.clone();
    const geometry = new THREE.SphereGeometry(1, 6, 4);
    const material = makeMarkerMaterial(settings.vertices.color);
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

    const canonical = getCanonicalData(mesh);
    let edgesGeometry = null;

    if (canonical?.positions && canonical?.faces) {
      const points = [];
      const seen = new Set();

      for (let i = 0; i < canonical.faces.length; i += 3) {
        const tri = [canonical.faces[i], canonical.faces[i + 1], canonical.faces[i + 2]];
        [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]].forEach(([a, b]) => {
          const key = a < b ? `${a}|${b}` : `${b}|${a}`;
          if (seen.has(key)) return;
          seen.add(key);

          points.push(
            canonical.positions[a * 3],
            canonical.positions[a * 3 + 1],
            canonical.positions[a * 3 + 2],
            canonical.positions[b * 3],
            canonical.positions[b * 3 + 1],
            canonical.positions[b * 3 + 2],
          );
        });
      }

      edgesGeometry = new THREE.BufferGeometry();
      edgesGeometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    } else {
      edgesGeometry = new THREE.EdgesGeometry(mesh.geometry, 0);
    }

    const material = makeLineMaterial(settings.edges.color);
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

    const pos = getCanonicalPositionAttribute(mesh);
    if (!pos) return;

    const canonical = getCanonicalData(mesh);
    const idx = canonical?.faces ? null : mesh.geometry.index;
    const faces = canonical?.faces || null;
    const localToWorld = mesh.matrixWorld.clone();
    const triCount = faces ? faces.length / 3 : (idx ? idx.count / 3 : pos.count / 3);
    const centers = [];

    for (let t = 0; t < triCount; t++) {
      const a = faces ? faces[t * 3] : (idx ? idx.getX(t * 3) : t * 3);
      const b = faces ? faces[t * 3 + 1] : (idx ? idx.getX(t * 3 + 1) : t * 3 + 1);
      const c = faces ? faces[t * 3 + 2] : (idx ? idx.getX(t * 3 + 2) : t * 3 + 2);

      const va = new THREE.Vector3().fromBufferAttribute(pos, a).applyMatrix4(localToWorld);
      const vb = new THREE.Vector3().fromBufferAttribute(pos, b).applyMatrix4(localToWorld);
      const vc = new THREE.Vector3().fromBufferAttribute(pos, c).applyMatrix4(localToWorld);

      centers.push(va.add(vb).add(vc).multiplyScalar(1 / 3));
    }

    if (!centers.length) return;

    const geometry = new THREE.SphereGeometry(1, 6, 4);
    const material = makeMarkerMaterial(settings.faces.color);
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

function hasVisibleSymmetry() {
  let found = false;
  app.currentObject?.traverse(mesh => {
    if (mesh.isMesh && isVisibleInCurrentHierarchy(mesh) && getMeshSymmetry(mesh)) found = true;
  });
  return found;
}

function updateSymmetryControl() {
  const symmetryCheck = document.getElementById('geo-symmetry');
  if (!symmetryCheck) return;

  const available = hasVisibleSymmetry();
  symmetryCheck.disabled = !available;
  symmetryCheck.closest('label')?.classList.toggle('is-disabled', !available);
  symmetryCheck.title = available ? 'Show symmetry pairs and self-symmetric vertices.' : 'Load a vertex symmetry mapping in a task panel first.';

  if (!available) {
    symmetryCheck.checked = false;
    settings.symmetry.show = false;
    clearSymmetry();
  }
}

function buildSymmetry() {
  clearSymmetry();
  updateSymmetryControl();

  if (!settings.symmetry.show || !app.currentObject) return;

  symmetryGroup = new THREE.Group();
  symmetryGroup.name = 'geo-symmetry';
  symmetryGroup.renderOrder = 1000;
  app.scene.add(symmetryGroup);

  app.currentObject.traverse(mesh => {
    if (!mesh.isMesh || !isVisibleInCurrentHierarchy(mesh)) return;

    const pos = getCanonicalPositionAttribute(mesh);
    const symmetry = symmetryPairs(mesh);
    if (!pos || (!symmetry.pairs.length && !symmetry.self.length)) return;

    const localToWorld = mesh.matrixWorld.clone();
    const linePoints = [];
    const leftVertices = new Set();
    const rightVertices = new Set();

    symmetry.pairs.forEach(pair => {
      const a = new THREE.Vector3().fromBufferAttribute(pos, pair.a).applyMatrix4(localToWorld);
      const b = new THREE.Vector3().fromBufferAttribute(pos, pair.b).applyMatrix4(localToWorld);
      linePoints.push(a.x, a.y, a.z, b.x, b.y, b.z);
    });

    symmetry.leftToRight.forEach(({ source, target }) => {
      leftVertices.add(source);
      rightVertices.add(target);
    });

    addSymmetryPlane(mesh, pos, symmetry, localToWorld);

    if (linePoints.length) {
      const lineGeometry = new THREE.BufferGeometry();
      lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(linePoints, 3));
      const lines = new THREE.LineSegments(lineGeometry, makeLineMaterial(settings.symmetry.color));
      lines.renderOrder = 1000;
      symmetryGroup.add(lines);
    }

    const leftMarkers = makeMarkerInstances(pos, localToWorld, Array.from(leftVertices), DEFAULT_GEOMETRY_COLORS.symmetryLeft, 1.7);
    const rightMarkers = makeMarkerInstances(pos, localToWorld, Array.from(rightVertices), DEFAULT_GEOMETRY_COLORS.symmetryRight, 1.7);
    const selfMarkers = makeMarkerInstances(pos, localToWorld, symmetry.self, DEFAULT_GEOMETRY_COLORS.symmetrySelf, 2.0);

    if (leftMarkers) symmetryGroup.add(leftMarkers);
    if (rightMarkers) symmetryGroup.add(rightMarkers);
    if (selfMarkers) symmetryGroup.add(selfMarkers);
  });
}

function rebuildAll() {
  buildVertices();
  buildEdges();
  buildFaces();
  buildSymmetry();
}

function clearAll() {
  clearVertices();
  clearEdges();
  clearFaces();
  clearSymmetry();
}

function applyGeometryColor(kind, color) {
  const fallback = DEFAULT_GEOMETRY_COLORS[kind] || DEFAULT_GEOMETRY_COLORS.vertices;
  const next = color || fallback;

  if (!settings[kind]) return;

  settings[kind].color = next;

  if (kind === 'vertices') setGroupMaterialsColor(vertexGroup, next);
  if (kind === 'edges') setGroupMaterialsColor(edgeGroup, next);
  if (kind === 'faces') setGroupMaterialsColor(faceGroup, next);
  if (kind === 'symmetry') setGroupMaterialsColor(symmetryGroup, next);
}

// ── Init ──
export function initGeometryInspection() {
  const vertCheck = document.getElementById('geo-vertices');
  const edgeCheck = document.getElementById('geo-edges');
  const faceCheck = document.getElementById('geo-faces');
  const symmetryCheck = document.getElementById('geo-symmetry');
  const vertColorInput = document.getElementById('geo-vertices-color');
  const edgeColorInput = document.getElementById('geo-edges-color');
  const faceColorInput = document.getElementById('geo-faces-color');

  vertColorInput?.addEventListener('input', () => {
    applyGeometryColor('vertices', vertColorInput.value);
  });

  edgeColorInput?.addEventListener('input', () => {
    applyGeometryColor('edges', edgeColorInput.value);
  });

  faceColorInput?.addEventListener('input', () => {
    applyGeometryColor('faces', faceColorInput.value);
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

  symmetryCheck?.addEventListener('change', () => {
    settings.symmetry.show = symmetryCheck.checked;
    scheduleRebuild();
  });

  window.addEventListener('geomy:symmetry-changed', () => {
    updateSymmetryControl();
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
      if (symmetryCheck) symmetryCheck.checked = false;
      if (vertColorInput) vertColorInput.value = DEFAULT_GEOMETRY_COLORS.vertices;
      if (edgeColorInput) edgeColorInput.value = DEFAULT_GEOMETRY_COLORS.edges;
      if (faceColorInput) faceColorInput.value = DEFAULT_GEOMETRY_COLORS.faces;

      settings.vertices.show = false;
      settings.edges.show = false;
      settings.faces.show = false;
      settings.symmetry.show = false;
      settings.vertices.color = DEFAULT_GEOMETRY_COLORS.vertices;
      settings.edges.color = DEFAULT_GEOMETRY_COLORS.edges;
      settings.faces.color = DEFAULT_GEOMETRY_COLORS.faces;
      settings.symmetry.color = DEFAULT_GEOMETRY_COLORS.symmetry;
      updateSymmetryControl();
    },

    // Kept as a no-op because main.js calls this every frame.
    updateAllLabels() {},
  };
}
