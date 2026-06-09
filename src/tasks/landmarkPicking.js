import * as THREE from 'three';
import { app } from '../app.js';
import { HistoryStack } from '../core/HistoryStack.js';
import { CursorIndicator } from '../interaction/CursorIndicator.js';
import { ModifierState } from '../interaction/ModifierState.js';
import { ViewControlsSuppression } from '../interaction/ViewControlsSuppression.js';
import { ViewportFocusManager } from '../interaction/ViewportFocusManager.js';
import {
  LANDMARK_COLORS,
  landmarkCursorDescriptor,
  landmarkMarkerRadiusForObject,
  makeLandmarkLabelSprite,
  makeLandmarkSphere,
} from '../landmarks/landmarkVisuals.js';
import { GEOMY_VERSION } from '../version.js';
import { raycast, downloadBlob } from '../util.js';
import { downloadArrayBundle, jsonEntry, npyEntry, parseBundleArrays, readArrayBundle } from '../io/numpyBundle.js';
import { canonicalTriangleVertexIndicesFromHit, canonicalVertexWorldPosition, getCanonicalPositionAttribute, rootLocalPointFromWorld, worldPointFromRootLocal } from './meshTaskUtils.js';
import '../css/landmarkPicking.css';

const COLORS = LANDMARK_COLORS;

const SNAP_MODES = ['triangle', 'vertex', 'edge'];
const PICK_RADIUS_PX = 18;
const STACK_LIMIT = 100;

let landmarks = [];
let markersGroup = null;
let selectedIndex = -1;
let nextLandmarkId = 1;
let active = false;

// Scale controls
let landmarkScale = 1.0;   // multiplies the sphere radius
let labelScale = 1.0;      // multiplies the text size independently

// Preview / highlight state
let previewSphere = null;
let hoveredLandmarkIndex = -1;

const settings = {
  snapMode: 'triangle',
};

const history = new HistoryStack({ limit: STACK_LIMIT });
let dragging = null;
let swapFlashObject = null;
const cursorState = new ModifierState({
  getViewport: () => app.dom?.viewport,
});
const cursorIndicator = new CursorIndicator({
  getViewport: () => app.dom?.viewport,
  getCanvas: () => app.renderer?.domElement,
  baseClassName: 'landmark-cursor-indicator',
  position: ({ x, y }) => `translate(${x}px, ${y}px)`,
});
const viewControlsSuppression = new ViewControlsSuppression({
  getControls: () => app.controls,
});
const viewportFocus = new ViewportFocusManager({
  getCanvas: () => app.renderer?.domElement,
  getViewport: () => app.dom?.viewport,
});

// ── Utilities ─────────────────────────────────────────────────────

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getViewportRect() {
  return app.dom.viewport.getBoundingClientRect();
}

// ── Cursor indicator ──────────────────────────────────────────────

function shouldSuppressViewControls() {
  return !!(
    active &&
    app.controls &&
    (dragging || (
      cursorState.inViewport &&
      (cursorState.alt || cursorState.shift || cursorState.ctrlOrMeta)
    ))
  );
}

function cursorDescriptor() {
  return landmarkCursorDescriptor({ dragging: !!dragging, state: cursorState });
}

function updateCursorIndicator() {
  const descriptor = cursorDescriptor();

  viewControlsSuppression.update(shouldSuppressViewControls());

  cursorIndicator.update({
    active,
    state: cursorState,
    descriptor,
    offsetX: 14,
    offsetY: 14,
  });
}

function resetCursorIndicator({ remove = false } = {}) {
  cursorState.reset();
  viewControlsSuppression.restore();

  if (previewSphere) {
    previewSphere.removeFromParent();
    disposeObject3D(previewSphere);
    previewSphere = null;
  }
  if (hoveredLandmarkIndex >= 0) {
    restoreMarkerColor(hoveredLandmarkIndex);
    hoveredLandmarkIndex = -1;
  }

  cursorIndicator.reset({ remove });
}

function clearAltPreview() {
  if (previewSphere) previewSphere.visible = false;

  if (hoveredLandmarkIndex >= 0) {
    restoreMarkerColor(hoveredLandmarkIndex);
    hoveredLandmarkIndex = -1;
  }
}

function syncCursorFromEvent(event) {
  if (!cursorState.syncFromPointerEvent(event)) return;

  // ── Alt preview: placement ghost + delete hover ──
  if (active && cursorState.alt && cursorState.inViewport) {
    const hits = raycast(event);
    const snap = hits.length ? snapFromHit(hits[0], settings.snapMode) : null;

    if (snap) {
      const radius = getMarkerRadius();
      if (!previewSphere) {
        previewSphere = createPreviewSphere();
        ensureMarkers().add(previewSphere);
      }
      previewSphere.position.copy(snap.position);
      previewSphere.scale.setScalar(radius);
      previewSphere.visible = true;
    } else if (previewSphere) {
      previewSphere.visible = false;
    }

    const newHover = landmarkIndexFromEvent(event);
    if (newHover !== hoveredLandmarkIndex) {
      if (hoveredLandmarkIndex >= 0) restoreMarkerColor(hoveredLandmarkIndex);
      hoveredLandmarkIndex = newHover;
      if (hoveredLandmarkIndex >= 0) setMarkerColor(hoveredLandmarkIndex, '#ff0000');
    }
  } else {
    clearAltPreview();
  }

  updateCursorIndicator();
}

function syncCursorModifiersFromKeyEvent(event) {
  if (!cursorState.syncFromKeyEvent(event, { allowHoverFallback: event?.type === 'keydown' })) return;

  if (!cursorState.alt || !cursorState.inViewport) {
    clearAltPreview();
  }

  updateCursorIndicator();
}

function markCursorOutsideViewport() {
  cursorState.markOutsideViewport();
  clearAltPreview();
  updateCursorIndicator();
}

function isTextInputTarget(target) {
  if (!target) return false;
  const tag = target.tagName?.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

function safeName(index) {
  return `Landmark ${index + 1}`;
}

// ── Landmark creation / serialisation ─────────────────────────────

function makeLandmarkFromSnap(snap) {
  const id = nextLandmarkId++;
  return {
    id,
    createdAt: id,
    name: `Landmark ${id}`,
    position: snap.position.clone(),
    snapMode: snap.snapMode,
    binding: snap.binding,
  };
}

function cloneBinding(binding) {
  if (!binding) return null;
  return JSON.parse(JSON.stringify(binding));
}

function serializeLandmark(landmark) {
  return {
    id: landmark.id,
    createdAt: landmark.createdAt,
    name: landmark.name,
    position: landmark.position.toArray(),
    snapMode: landmark.snapMode,
    binding: cloneBinding(landmark.binding),
  };
}

function deserializeLandmark(data) {
  return {
    id: data.id,
    createdAt: data.createdAt ?? data.id,
    name: data.name || `Landmark ${data.id}`,
    position: new THREE.Vector3().fromArray(data.position || [0, 0, 0]),
    snapMode: data.snapMode || 'triangle',
    binding: cloneBinding(data.binding),
  };
}

function makeSnapshot() {
  return {
    landmarks: landmarks.map(serializeLandmark),
    selectedIndex,
    nextLandmarkId,
  };
}

function snapshotKey(snapshot) {
  return JSON.stringify(snapshot);
}

function restoreSnapshot(snapshot) {
  landmarks = snapshot.landmarks.map(deserializeLandmark);
  selectedIndex = clamp(snapshot.selectedIndex ?? -1, -1, landmarks.length - 1);
  nextLandmarkId = snapshot.nextLandmarkId || (Math.max(0, ...landmarks.map(l => l.id)) + 1);
  rebuildMarkers();
  renderList();
}

function pushUndoSnapshot(snapshot) {
  history.record(snapshot);
}

function commit(label, mutate) {
  const before = makeSnapshot();
  mutate();
  const after = makeSnapshot();

  if (snapshotKey(before) === snapshotKey(after)) {
    renderList();
    return false;
  }

  pushUndoSnapshot(before);
  rebuildMarkers();
  renderList();
  return true;
}

function undo() {
  if (history.canUndo) {
    history.undo(makeSnapshot(), restoreSnapshot);
  }
}

function redo() {
  if (history.canRedo) {
    history.redo(makeSnapshot(), restoreSnapshot);
  }
}

function disposeObject3D(object) {
  object.traverse(child => {
    child.geometry?.dispose?.();
    if (child.material) {
      [].concat(child.material).forEach(material => {
        material.map?.dispose?.();
        material.dispose?.();
      });
    }
  });
}

// ── Markers ────────────────────────────────────────────────────────

function ensureMarkers() {
  if (!markersGroup) {
    markersGroup = new THREE.Group();
    markersGroup.name = 'landmarks';
    markersGroup.renderOrder = 10000;
    app.scene.add(markersGroup);
  }
  markersGroup.visible = active;
  bringMarkersToFront();
  return markersGroup;
}

function bringMarkersToFront() {
  if (!markersGroup || markersGroup.parent !== app.scene) return;
  const children = app.scene.children;
  if (children[children.length - 1] === markersGroup) return;
  app.scene.remove(markersGroup);
  app.scene.add(markersGroup);
}

function getMarkerRadius() {
  return landmarkMarkerRadiusForObject(app.currentObject, landmarkScale);
}

function createLabelSprite(text, position, color) {
  return makeLandmarkLabelSprite({
    text,
    position,
    color,
    radius: getMarkerRadius(),
    labelScale,
    depthTest: true,
    renderOrder: 10002,
  });
}

function rebuildMarkers() {
  const group = ensureMarkers();
  group.children.forEach(disposeObject3D);
  group.clear();
  swapFlashObject = null;
  // re-adding preview sphere after clear
  previewSphere = null;

  landmarks.forEach((landmark, index) => {
    const isSelected = index === selectedIndex;
    const isLastCreated = landmark.createdAt === Math.max(...landmarks.map(l => l.createdAt));
    const color = isSelected ? COLORS.selected : (isLastCreated ? COLORS.last : COLORS.default);

    const radius = getMarkerRadius();
    const sphere = makeLandmarkSphere({
      color,
      radius,
      selected: isSelected,
      depthTest: true,
      renderOrder: 10001,
      userData: { landmarkIndex: index },
    });

    sphere.position.copy(landmark.position);
    group.add(sphere);
    group.add(createLabelSprite(String(index + 1), landmark.position, color));
  });
}

// ── Preview / highlight helpers ────────────────────────────────────

function createPreviewSphere() {
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 12),
    new THREE.MeshBasicMaterial({
      color: 0x00ffcc,
      transparent: true,
      opacity: 0.35,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
    })
  );
  sphere.renderOrder = 10000;
  sphere.frustumCulled = false;
  sphere.name = 'preview-sphere';
  return sphere;
}

function findMarkerSphere(index) {
  const group = ensureMarkers();
  for (const child of group.children) {
    if (child.isMesh && child.userData.landmarkIndex === index) {
      return child;
    }
  }
  return null;
}

function setMarkerColor(index, color) {
  const sphere = findMarkerSphere(index);
  if (sphere) sphere.material.color.set(color);
}

function restoreMarkerColor(index) {
  if (index < 0 || index >= landmarks.length) return;
  const isSelected = index === selectedIndex;
  const isLastCreated = landmarks[index]?.createdAt === Math.max(...landmarks.map(l => l.createdAt));
  const color = isSelected ? COLORS.selected : (isLastCreated ? COLORS.last : COLORS.default);
  setMarkerColor(index, color);
}

// ── Projection & picking ───────────────────────────────────────────

function projectLandmarkToScreen(landmark) {
  const rect = getViewportRect();
  const projected = landmark.position.clone().project(app.camera);
  if (projected.z < -1 || projected.z > 1) return null;
  return {
    x: rect.left + (projected.x + 1) * rect.width * 0.5,
    y: rect.top + (-projected.y + 1) * rect.height * 0.5,
  };
}

function landmarkIndexFromEvent(event, radiusPx = PICK_RADIUS_PX) {
  let bestIndex = -1;
  let bestDistanceSq = radiusPx * radiusPx;

  landmarks.forEach((landmark, index) => {
    const screen = projectLandmarkToScreen(landmark);
    if (!screen) return;

    const dx = screen.x - event.clientX;
    const dy = screen.y - event.clientY;
    const distSq = dx * dx + dy * dy;

    if (distSq <= bestDistanceSq) {
      bestDistanceSq = distSq;
      bestIndex = index;
    }
  });
  return bestIndex;
}

// (Rest of the geometry helpers unchanged – closestPointOnSegment, barycentricFromPoint, roundExportNumber, etc.)

function closestPointOnSegment(point, a, b) {
  const ab = b.clone().sub(a);
  const denom = ab.lengthSq();
  if (denom <= Number.EPSILON) {
    return { point: a.clone(), t: 0 };
  }
  const t = clamp(point.clone().sub(a).dot(ab) / denom, 0, 1);
  return { point: a.clone().add(ab.multiplyScalar(t)), t };
}

function barycentricFromPoint(point, a, b, c) {
  const v0 = b.clone().sub(a);
  const v1 = c.clone().sub(a);
  const v2 = point.clone().sub(a);

  const d00 = v0.dot(v0);
  const d01 = v0.dot(v1);
  const d11 = v1.dot(v1);
  const d20 = v2.dot(v0);
  const d21 = v2.dot(v1);
  const denom = d00 * d11 - d01 * d01;

  if (Math.abs(denom) <= Number.EPSILON) {
    return { a: 1, b: 0, c: 0 };
  }

  const v = (d11 * d20 - d01 * d21) / denom;
  const w = (d00 * d21 - d01 * d20) / denom;
  const u = 1 - v - w;
  return { a: u, b: v, c: w };
}

function roundExportNumber(value) {
  return Number(Number(value).toFixed(10));
}

function makeBaseBinding(hit, snapMode, point) {
  const localPoint = hit.object?.worldToLocal
    ? hit.object.worldToLocal(point.clone())
    : null;
  return {
    snapMode,
    meshUuid: hit.object?.uuid ?? null,
    meshName: hit.object?.name || hit.object?.parent?.name || hit.object?.type || 'mesh',
    faceIndex: hit.faceIndex ?? null,
    localPosition: localPoint
      ? { x: localPoint.x, y: localPoint.y, z: localPoint.z }
      : null,
  };
}

function makeTriangleBinding(hit, point, vertexIndices, triangleWorld) {
  const bary = barycentricFromPoint(point, triangleWorld.a, triangleWorld.b, triangleWorld.c);
  return {
    ...makeBaseBinding(hit, 'triangle', point),
    vertexIndices,
    barycentric: {
      a: roundExportNumber(bary.a),
      b: roundExportNumber(bary.b),
      c: roundExportNumber(bary.c),
    },
  };
}

function makeVertexBinding(hit, point, vertexIndex) {
  return {
    ...makeBaseBinding(hit, 'vertex', point),
    vertexIndex,
  };
}

function makeEdgeBinding(hit, point, edgeVertexIndices, t) {
  return {
    ...makeBaseBinding(hit, 'edge', point),
    vertexIndices: edgeVertexIndices,
    t: roundExportNumber(t),
    barycentric: {
      a: roundExportNumber(1 - t),
      b: roundExportNumber(t),
    },
  };
}

function triangleDataFromHit(hit) {
  const mesh = hit.object;
  const position = getCanonicalPositionAttribute(mesh);
  const face = hit.face;

  if (!mesh || !position || !face) return null;

  const vertexIndices = canonicalTriangleVertexIndicesFromHit(hit);
  if (!vertexIndices) return null;

  const local = vertexIndices.map(index => new THREE.Vector3().fromBufferAttribute(position, index));
  const world = local.map(point => point.clone().applyMatrix4(mesh.matrixWorld));

  return {
    vertexIndices,
    world: {
      a: world[0],
      b: world[1],
      c: world[2],
    },
  };
}

function snapFromHit(hit, snapMode = settings.snapMode) {
  if (!hit) return null;

  const triangle = triangleDataFromHit(hit);
  const fallbackPosition = hit.point.clone();

  if (!triangle) {
    return {
      position: fallbackPosition,
      snapMode,
      binding: makeBaseBinding(hit, snapMode, fallbackPosition),
    };
  }

  if (snapMode === 'vertex') {
    const candidates = [
      { point: triangle.world.a, vertexIndex: triangle.vertexIndices[0] },
      { point: triangle.world.b, vertexIndex: triangle.vertexIndices[1] },
      { point: triangle.world.c, vertexIndex: triangle.vertexIndices[2] },
    ];
    let best = candidates[0];
    let bestDistance = hit.point.distanceToSquared(best.point);
    candidates.slice(1).forEach(candidate => {
      const distance = hit.point.distanceToSquared(candidate.point);
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    });
    const position = best.point.clone();
    return {
      position,
      snapMode,
      binding: makeVertexBinding(hit, position, best.vertexIndex),
    };
  }

  if (snapMode === 'edge') {
    const edgeCandidates = [
      { ...closestPointOnSegment(hit.point, triangle.world.a, triangle.world.b), vertexIndices: [triangle.vertexIndices[0], triangle.vertexIndices[1]] },
      { ...closestPointOnSegment(hit.point, triangle.world.b, triangle.world.c), vertexIndices: [triangle.vertexIndices[1], triangle.vertexIndices[2]] },
      { ...closestPointOnSegment(hit.point, triangle.world.c, triangle.world.a), vertexIndices: [triangle.vertexIndices[2], triangle.vertexIndices[0]] },
    ];
    let best = edgeCandidates[0];
    let bestDistance = hit.point.distanceToSquared(best.point);
    edgeCandidates.slice(1).forEach(candidate => {
      const distance = hit.point.distanceToSquared(candidate.point);
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    });
    const position = best.point.clone();
    return {
      position,
      snapMode,
      binding: makeEdgeBinding(hit, position, best.vertexIndices, best.t),
    };
  }

  const position = hit.point.clone();
  return {
    position,
    snapMode: 'triangle',
    binding: makeTriangleBinding(hit, position, triangle.vertexIndices, triangle.world),
  };
}

function snapFromEvent(event) {
  const hits = raycast(event);
  if (!hits.length) return null;
  return snapFromHit(hits[0], settings.snapMode);
}

// (Rest of the file – import/export, UI controls, … – unchanged until we reach the new parts)
// I will include the rest of the file as it was, but with the new slider logic and toggle selection.

// ── Mesh helpers ───────────────────────────────────────────────────

function getMeshLabel(mesh) {
  return mesh?.name || mesh?.parent?.name || mesh?.type || 'mesh';
}

function getCurrentMeshes() {
  const meshes = [];
  app.currentObject?.traverse(object => {
    if (object.isMesh && object.geometry?.attributes?.position) {
      meshes.push(object);
    }
  });
  return meshes;
}

function findMeshForImportedSnap(snap) {
  if (!snap) return null;
  const meshes = getCurrentMeshes();
  if (!meshes.length) return null;

  if (snap?.meshUuid) {
    const byUuid = meshes.find(mesh => mesh.uuid === snap.meshUuid);
    if (byUuid) return byUuid;
  }
  if (snap?.meshName) {
    const byName = meshes.find(mesh => getMeshLabel(mesh) === snap.meshName || mesh.parent?.name === snap.meshName);
    if (byName) return byName;
  }
  return meshes.length === 1 ? meshes[0] : null;
}

function toInteger(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function vertexWorldPosition(mesh, vertexIndex) {
  const index = toInteger(vertexIndex);
  if (index === null) return null;
  return canonicalVertexWorldPosition(mesh, index);
}

function vectorFromImportedPosition(value) {
  if (!value) return null;
  if (Array.isArray(value) && value.length >= 3) {
    const x = Number(value[0]), y = Number(value[1]), z = Number(value[2]);
    if ([x, y, z].every(Number.isFinite)) return new THREE.Vector3(x, y, z);
  }
  if (typeof value === 'object') {
    const x = Number(value.x), y = Number(value.y), z = Number(value.z);
    if ([x, y, z].every(Number.isFinite)) return new THREE.Vector3(x, y, z);
  }
  return null;
}

function assetPositionFromWorld(position) {
  return rootLocalPointFromWorld(app.currentObject, position) || position?.clone?.() || null;
}

function worldPositionFromAsset(position) {
  return worldPointFromRootLocal(app.currentObject, position) || position?.clone?.() || null;
}

function fallbackPositionFromImportedLandmark(data, absoluteSpace = 'asset-local') {
  const assetPosition = vectorFromImportedPosition(data.assetPosition)
    || vectorFromImportedPosition(data.localPosition);
  if (assetPosition) return worldPositionFromAsset(assetPosition);

  const legacyPosition = vectorFromImportedPosition(data.worldPosition)
    || vectorFromImportedPosition(data.position)
    || vectorFromImportedPosition(data);

  if (!legacyPosition) return null;

  return absoluteSpace === 'world'
    ? legacyPosition
    : worldPositionFromAsset(legacyPosition);
}

function importedSnapMode(data) {
  const mode = data?.snap?.type || data?.snap?.snapMode || data?.binding?.snapMode || data?.snapMode;
  return SNAP_MODES.includes(mode) ? mode : 'triangle';
}

function bindingFromImportedSnap(snap, snapMode, position, mesh = null) {
  if (!snap && !mesh) return null;

  const localPoint = mesh?.worldToLocal
    ? mesh.worldToLocal(position.clone())
    : vectorFromImportedPosition(snap?.localPosition);

  const binding = {
    snapMode,
    meshUuid: snap?.meshUuid ?? mesh?.uuid ?? null,
    meshName: snap?.meshName ?? getMeshLabel(mesh),
    localPosition: localPoint
      ? { x: localPoint.x, y: localPoint.y, z: localPoint.z }
      : null,
  };

  if (snapMode === 'triangle') {
    binding.faceIndex = snap?.faceIndex ?? null;
    binding.vertexIndices = Array.isArray(snap?.vertexIndices) ? snap.vertexIndices.map(toInteger) : null;
    binding.barycentric = snap?.barycentric ? {
      a: roundExportNumber(Number(snap.barycentric.a) || 0),
      b: roundExportNumber(Number(snap.barycentric.b) || 0),
      c: roundExportNumber(Number(snap.barycentric.c) || 0),
    } : null;
  } else if (snapMode === 'vertex') {
    binding.vertexIndex = toInteger(snap?.vertexIndex);
  } else if (snapMode === 'edge') {
    binding.vertexIndices = Array.isArray(snap?.vertexIndices) ? snap.vertexIndices.slice(0, 2).map(toInteger) : null;
    binding.t = Number.isFinite(Number(snap?.t)) ? roundExportNumber(Number(snap.t)) : null;
    binding.barycentric = snap?.barycentric ? {
      a: roundExportNumber(Number(snap.barycentric.a) || 0),
      b: roundExportNumber(Number(snap.barycentric.b) || 0),
    } : null;
  }

  return binding;
}

function positionFromImportedSnap(snap, snapMode, fallbackPosition) {
  const mesh = findMeshForImportedSnap(snap);

  if (mesh && snapMode === 'triangle' && Array.isArray(snap?.vertexIndices) && snap.vertexIndices.length >= 3 && snap.barycentric) {
    const a = vertexWorldPosition(mesh, snap.vertexIndices[0]);
    const b = vertexWorldPosition(mesh, snap.vertexIndices[1]);
    const c = vertexWorldPosition(mesh, snap.vertexIndices[2]);

    if (a && b && c) {
      const wa = Number(snap.barycentric.a) || 0;
      const wb = Number(snap.barycentric.b) || 0;
      const wc = Number(snap.barycentric.c) || 0;
      const position = a.multiplyScalar(wa).add(b.multiplyScalar(wb)).add(c.multiplyScalar(wc));
      return {
        position,
        binding: bindingFromImportedSnap(snap, snapMode, position, mesh),
      };
    }
  }

  if (mesh && snapMode === 'vertex') {
    const position = vertexWorldPosition(mesh, snap?.vertexIndex);
    if (position) {
      return {
        position,
        binding: bindingFromImportedSnap(snap, snapMode, position, mesh),
      };
    }
  }

  if (mesh && snapMode === 'edge' && Array.isArray(snap?.vertexIndices) && snap.vertexIndices.length >= 2) {
    const a = vertexWorldPosition(mesh, snap.vertexIndices[0]);
    const b = vertexWorldPosition(mesh, snap.vertexIndices[1]);
    if (a && b) {
      const t = Number.isFinite(Number(snap.t))
        ? clamp(Number(snap.t), 0, 1)
        : clamp(Number(snap?.barycentric?.b ?? 0), 0, 1);
      const position = a.multiplyScalar(1 - t).add(b.multiplyScalar(t));
      return {
        position,
        binding: bindingFromImportedSnap(snap, snapMode, position, mesh),
      };
    }
  }

  const position = fallbackPosition || new THREE.Vector3();
  return {
    position,
    binding: bindingFromImportedSnap(snap, snapMode, position, mesh),
  };
}

function normalizeImportedLandmark(data, importedIndex, fallbackId, absoluteSpace = 'asset-local') {
  if (!data || typeof data !== 'object') return null;

  const snap = data.snap || data.binding || null;
  const snapMode = importedSnapMode(data);
  const fallbackPosition = fallbackPositionFromImportedLandmark(data, absoluteSpace);
  const resolved = positionFromImportedSnap(snap, snapMode, fallbackPosition);

  if (!resolved.position || !Number.isFinite(resolved.position.x) || !Number.isFinite(resolved.position.y) || !Number.isFinite(resolved.position.z)) {
    return null;
  }

  const importedId = toInteger(data.id);
  const id = importedId !== null && importedId > 0 ? importedId : fallbackId;

  return {
    id,
    createdAt: importedIndex + 1,
    name: data.name || safeName(importedIndex),
    position: resolved.position.clone(),
    snapMode,
    binding: resolved.binding,
  };
}

function parseLandmarkPayload(payload) {
  const source = Array.isArray(payload)
    ? payload
    : (Array.isArray(payload?.landmarks) ? payload.landmarks : null);

  if (!source) {
    throw new Error('This JSON does not contain a landmarks array.');
  }

  const absoluteSpace = Array.isArray(payload)
    ? 'asset-local'
    : (payload?.coordinateSpaces?.absolute || 'asset-local');

  let nextId = 1;
  let skipped = 0;
  const imported = [];

  source.forEach((entry, index) => {
    const landmark = normalizeImportedLandmark(entry, index, nextId, absoluteSpace);
    if (!landmark) {
      skipped += 1;
      return;
    }
    imported.push(landmark);
    nextId = Math.max(nextId, landmark.id + 1);
  });

  if (!imported.length) {
    throw new Error('No valid landmarks were found in the JSON file.');
  }

  return { landmarks: imported, skipped };
}

function refreshLandmarksForCurrentMesh() {
  if (!landmarks.length || !app.currentObject) return false;

  app.currentObject.updateMatrixWorld?.(true);
  let changed = false;

  landmarks.forEach(landmark => {
    if (!landmark.binding) return;

    const beforePosition = landmark.position.clone();
    const beforeBinding = JSON.stringify(landmark.binding || null);
    const snapMode = SNAP_MODES.includes(landmark.snapMode) ? landmark.snapMode : importedSnapMode(landmark);
    const resolved = positionFromImportedSnap(landmark.binding, snapMode, landmark.position);

    if (!resolved?.position) return;

    landmark.position.copy(resolved.position);
    landmark.snapMode = snapMode;

    if (resolved.binding) {
      landmark.binding = resolved.binding;
    }

    const moved = beforePosition.distanceToSquared(landmark.position) > 1e-18;
    const rebound = beforeBinding !== JSON.stringify(landmark.binding || null);
    if (moved || rebound) changed = true;
  });

  return changed;
}

function importJSONFile(file) {
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const payload = JSON.parse(String(reader.result || ''));
      const result = parseLandmarkPayload(payload);

      if (landmarks.length && !window.confirm('Replace current landmarks with imported landmarks?')) {
        return;
      }

      commit('import landmarks', () => {
        landmarks = result.landmarks;
        selectedIndex = -1;
        nextLandmarkId = Math.max(0, ...landmarks.map(landmark => landmark.id)) + 1;
      });

      if (result.skipped > 0) {
        alert(`Imported ${result.landmarks.length} landmark(s). Skipped ${result.skipped} invalid entr${result.skipped === 1 ? 'y' : 'ies'}.`);
      }
    } catch (error) {
      console.error('Failed to import landmarks:', error);
      alert(error?.message || 'Failed to import landmarks JSON.');
    } finally {
      const input = document.getElementById('landmark-import-file');
      if (input) input.value = '';
    }
  };
  reader.onerror = () => {
    alert('Failed to read the landmarks JSON file.');
    const input = document.getElementById('landmark-import-file');
    if (input) input.value = '';
  };
  reader.readAsText(file);
}

// ── Selection (with toggle) ────────────────────────────────────────

function setSelectedIndex(index) {
  if (index >= 0 && index < landmarks.length) {
    // Toggle: if already selected, deselect
    if (selectedIndex === index) {
      selectedIndex = -1;
    } else {
      selectedIndex = index;
    }
  } else {
    selectedIndex = -1;
  }
  rebuildMarkers();
  renderList();
}

// ── Landmark manipulation ──────────────────────────────────────────

function addLandmarkFromEvent(event) {
  const snap = snapFromEvent(event);
  if (!snap) return false;

  return commit('add landmark', () => {
    const landmark = makeLandmarkFromSnap(snap);
    landmarks.push(landmark);
    selectedIndex = -1;
  });
}

function removeLandmarkAt(index) {
  if (index < 0 || index >= landmarks.length) return false;

  return commit('remove landmark', () => {
    landmarks.splice(index, 1);
    if (selectedIndex === index) {
      selectedIndex = -1;
    } else if (selectedIndex > index) {
      selectedIndex -= 1;
    }
  });
}

function removeLastPlaced() {
  if (!landmarks.length) return false;
  let index = 0;
  let bestCreatedAt = landmarks[0].createdAt;
  landmarks.forEach((landmark, candidateIndex) => {
    if (landmark.createdAt > bestCreatedAt) {
      bestCreatedAt = landmark.createdAt;
      index = candidateIndex;
    }
  });
  return removeLandmarkAt(index);
}

function clearAll({ resetStacks = false } = {}) {
  if (!landmarks.length) {
    selectedIndex = -1;
    rebuildMarkers();
    renderList();
    return;
  }

  if (resetStacks) {
    landmarks = [];
    selectedIndex = -1;
    history.clear();
    rebuildMarkers();
    renderList();
    return;
  }

  commit('clear all', () => {
    landmarks = [];
    selectedIndex = -1;
  });
}

function flashSwapSegment(start, end) {
  if (!start || !end) return;
  const group = ensureMarkers();

  if (swapFlashObject) {
    disposeObject3D(swapFlashObject);
    swapFlashObject.removeFromParent();
    swapFlashObject = null;
  }

  const geometry = new THREE.BufferGeometry().setFromPoints([start, end]);
  const material = new THREE.LineBasicMaterial({
    color: COLORS.selected,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.95,
    toneMapped: false,
  });

  const line = new THREE.Line(geometry, material);
  line.name = 'landmark-swap-flash';
  line.renderOrder = 10050;
  line.frustumCulled = false;
  swapFlashObject = line;
  group.add(line);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (swapFlashObject !== line) return;
      disposeObject3D(line);
      line.removeFromParent();
      swapFlashObject = null;
    });
  });
}

function swapLandmarks(a, b) {
  if (a < 0 || b < 0 || a >= landmarks.length || b >= landmarks.length || a === b) return false;

  const start = landmarks[a].position.clone();
  const end = landmarks[b].position.clone();

  const changed = commit('swap landmark positions', () => {
    const aPosition = landmarks[a].position.clone();
    const aSnapMode = landmarks[a].snapMode;
    const aBinding = cloneBinding(landmarks[a].binding);

    landmarks[a].position.copy(landmarks[b].position);
    landmarks[a].snapMode = landmarks[b].snapMode;
    landmarks[a].binding = cloneBinding(landmarks[b].binding);

    landmarks[b].position.copy(aPosition);
    landmarks[b].snapMode = aSnapMode;
    landmarks[b].binding = aBinding;

    selectedIndex = -1;
  });

  if (changed) {
    flashSwapSegment(start, end);
  }
  return changed;
}

function moveLandmark(fromIndex, toIndex) {
  if (fromIndex < 0 || toIndex < 0 || fromIndex >= landmarks.length || toIndex >= landmarks.length || fromIndex === toIndex) return false;

  return commit('reorder landmarks', () => {
    const [landmark] = landmarks.splice(fromIndex, 1);
    landmarks.splice(toIndex, 0, landmark);

    if (selectedIndex === fromIndex) {
      selectedIndex = toIndex;
    } else if (fromIndex < selectedIndex && selectedIndex <= toIndex) {
      selectedIndex -= 1;
    } else if (toIndex <= selectedIndex && selectedIndex < fromIndex) {
      selectedIndex += 1;
    }
  });
}

function renameLandmark(index, name) {
  if (index < 0 || index >= landmarks.length) return false;
  const nextName = name.trim() || safeName(index);
  if (landmarks[index].name === nextName) return false;

  return commit('rename landmark', () => {
    landmarks[index].name = nextName;
  });
}

function setSnapMode(mode) {
  if (!SNAP_MODES.includes(mode)) return;
  settings.snapMode = mode;
  document.querySelectorAll('input[name="landmark-snap-mode"]').forEach(input => {
    input.checked = input.value === mode;
  });
}

// ── Event handlers (pointer, keyboard, wheel) ───────────────────────

function preventTaskEvent(event) {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation?.();
}

function beginDrag(event, index) {
  dragging = {
    index,
    pointerId: event.pointerId,
    before: makeSnapshot(),
    moved: false,
  };
}

function updateDrag(event) {
  if (!dragging || dragging.pointerId !== event.pointerId) return;
  preventTaskEvent(event);

  const snap = snapFromEvent(event);
  if (!snap) return;

  const landmark = landmarks[dragging.index];
  if (!landmark) return;

  landmark.position.copy(snap.position);
  landmark.snapMode = snap.snapMode;
  landmark.binding = snap.binding;
  dragging.moved = true;

  rebuildMarkers();
  renderList();
}

function endDrag(event) {
  if (!dragging || dragging.pointerId !== event.pointerId) return;
  preventTaskEvent(event);

  const before = dragging.before;
  dragging = null;

  const after = makeSnapshot();
  if (snapshotKey(before) !== snapshotKey(after)) {
    pushUndoSnapshot(before);
  }

  renderList();
}

function onPointerDown(event) {
  if (!active) return;
  syncCursorFromEvent(event);

  const isLeft = event.button === 0;
  const isRight = event.button === 2;
  const hasTaskModifier = event.altKey || event.shiftKey || event.ctrlKey || event.metaKey;

  if (isLeft && event.altKey) {
    preventTaskEvent(event);
    addLandmarkFromEvent(event);
    return;
  }

  if (isLeft && (event.ctrlKey || event.metaKey)) {
    const index = landmarkIndexFromEvent(event);
    preventTaskEvent(event);
    if (index >= 0) {
      beginDrag(event, index);
      updateCursorIndicator();
    }
    return;
  }

  if (isLeft && event.shiftKey) {
    const index = landmarkIndexFromEvent(event);
    preventTaskEvent(event);
    if (index >= 0) {
      setSelectedIndex(index);
    }
    return;
  }

  if (isRight && event.altKey) {
    preventTaskEvent(event);
    removeLandmarkAt(landmarkIndexFromEvent(event));
    return;
  }

  if (isRight && event.shiftKey) {
    preventTaskEvent(event);
    const targetIndex = landmarkIndexFromEvent(event);
    if (selectedIndex >= 0 && targetIndex >= 0) {
      swapLandmarks(selectedIndex, targetIndex);
    }
    return;
  }

  if (hasTaskModifier) {
    preventTaskEvent(event);
  }
}

function onPointerMove(event) {
  if (!active) return;
  syncCursorFromEvent(event);
  updateDrag(event);
}

function onPointerUp(event) {
  if (!active) return;
  syncCursorFromEvent(event);
  endDrag(event);
  updateCursorIndicator();
}

function onContextMenu(event) {
  if (!active) return;
  if (event.altKey || event.shiftKey || event.ctrlKey || event.metaKey || dragging) {
    preventTaskEvent(event);
  }
}

function onKeyUp(event) {
  if (!active) return;
  syncCursorModifiersFromKeyEvent(event);
}

function onWindowBlur() {
  resetCursorIndicator();
}

function onKeyDown(event) {
  if (!active) return;
  syncCursorModifiersFromKeyEvent(event);
  if (isTextInputTarget(event.target)) return;

  const key = event.key.toLowerCase();
  const isUndo = (event.ctrlKey || event.metaKey) && !event.shiftKey && key === 'z';
  const isRedo = (event.ctrlKey || event.metaKey) && (key === 'y' || (event.shiftKey && key === 'z'));

  if (isUndo) {
    preventTaskEvent(event);
    undo();
    return;
  }
  if (isRedo) {
    preventTaskEvent(event);
    redo();
    return;
  }
  if (event.key === 'Backspace' || event.key === '\\') {
    preventTaskEvent(event);
    removeLastPlaced();
    return;
  }
  if (key === 't') {
    preventTaskEvent(event);
    setSnapMode('triangle');
  } else if (key === 'v') {
    preventTaskEvent(event);
    setSnapMode('vertex');
  } else if (key === 'e') {
    preventTaskEvent(event);
    setSnapMode('edge');
  }
}

function hasScaleWheelModifier(event) {
  return !!(event.altKey || event.shiftKey || event.ctrlKey || event.metaKey);
}

function onWheel(event) {
  if (!active) return;
  if (!hasScaleWheelModifier(event)) return;

  event.preventDefault();
  event.stopPropagation();

  const delta = Math.sign(event.deltaY) * -0.1;
  const newScale = clamp(landmarkScale + delta, 0.2, 5.0);

  if (newScale !== landmarkScale) {
    landmarkScale = newScale;
    const slider = document.getElementById('landmark-scale');
    const label = document.getElementById('landmark-scale-val');
    if (slider) slider.value = landmarkScale;
    if (label) label.textContent = landmarkScale.toFixed(1);
    rebuildMarkers();
  }
}

// ── Bind / unbind ───────────────────────────────────────────────────

function bindViewportEvents() {
  const canvas = app.renderer.domElement;
  const viewport = app.dom.viewport;

  viewportFocus.prepare();
  cursorIndicator.ensure();

  viewport.addEventListener('pointerdown', viewportFocus.focus, true);
  canvas.addEventListener('pointerdown', onPointerDown, true);
  canvas.addEventListener('pointerenter', syncCursorFromEvent, true);
  canvas.addEventListener('pointerleave', markCursorOutsideViewport, true);
  canvas.addEventListener('contextmenu', onContextMenu, true);
  canvas.addEventListener('wheel', onWheel, { passive: false, capture: true });
  document.addEventListener('pointermove', onPointerMove, true);
  document.addEventListener('pointerup', onPointerUp, true);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', onWindowBlur);
}

function unbindViewportEvents() {
  const canvas = app.renderer?.domElement;
  const viewport = app.dom?.viewport;

  viewport?.removeEventListener('pointerdown', viewportFocus.focus, true);
  canvas?.removeEventListener('pointerdown', onPointerDown, true);
  canvas?.removeEventListener('pointerenter', syncCursorFromEvent, true);
  canvas?.removeEventListener('pointerleave', markCursorOutsideViewport, true);
  canvas?.removeEventListener('contextmenu', onContextMenu, true);
  canvas?.removeEventListener('wheel', onWheel, true);
  document.removeEventListener('pointermove', onPointerMove, true);
  document.removeEventListener('pointerup', onPointerUp, true);
  window.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('keyup', onKeyUp, true);
  window.removeEventListener('blur', onWindowBlur);

  resetCursorIndicator({ remove: true });
}


async function readLandmarkImportPayload(file) {
  const lower = String(file?.name || '').toLowerCase();
  if (lower.endsWith('.npz') || lower.endsWith('.zip')) {
    const entries = await readArrayBundle(file);
    const arrays = parseBundleArrays(entries);
    return landmarkPayloadFromArrays(arrays);
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try { resolve(JSON.parse(String(reader.result || ''))); }
      catch (error) { reject(error); }
    };
    reader.onerror = () => reject(new Error(`Failed to read ${file?.name || 'landmark file'}.`));
    reader.readAsText(file);
  });
}

function arrayByName(arrays, name) {
  return arrays.get(name) || arrays.get(`landmarks/${name}`) || arrays.get(name.replace(/^landmarks\//, ''));
}

function baryArrayValue(bary, row, col) {
  return Number(bary?.data?.[row * 3 + col] ?? 0);
}

function simplexArrayValue(simplex, row, col) {
  return Number(simplex?.data?.[row * 3 + col] ?? -1);
}

function landmarkPayloadFromArrays(arrays) {
  const simplex = arrayByName(arrays, 'simplex.npy');
  const bary = arrayByName(arrays, 'barycentric.npy');
  const counts = arrayByName(arrays, 'simplex_vertex_count.npy');
  const xyz = arrayByName(arrays, 'world_xyz.npy');
  if (!simplex || !bary || !counts) throw new Error('Landmark bundle needs simplex.npy, barycentric.npy, and simplex_vertex_count.npy.');

  const meshes = getCurrentMeshes();
  if (!meshes.length) throw new Error('Load a mesh before importing landmark arrays.');
  const mesh = meshes[0];
  mesh.updateMatrixWorld?.(true);
  const positionAttr = mesh.geometry?.attributes?.position;
  if (!positionAttr) throw new Error('Current mesh has no vertex positions.');

  const L = counts.shape?.[0] || 0;
  const imported = [];
  for (let i = 0; i < L; i++) {
    const n = clamp(Number(counts.data[i]) || 0, 0, 3);
    if (n < 1) continue;

    const ids = [simplexArrayValue(simplex, i, 0), simplexArrayValue(simplex, i, 1), simplexArrayValue(simplex, i, 2)];
    const weights = [baryArrayValue(bary, i, 0), baryArrayValue(bary, i, 1), baryArrayValue(bary, i, 2)];
    if (ids.slice(0, n).some(id => !Number.isInteger(id) || id < 0 || id >= positionAttr.count)) continue;

    let position = null;
    const v0 = vertexWorldPosition(mesh, ids[0]);
    if (n === 1) {
      position = v0;
    } else {
      position = new THREE.Vector3();
      for (let k = 0; k < n; k++) {
        const v = vertexWorldPosition(mesh, ids[k]);
        if (v) position.add(v.multiplyScalar(Number.isFinite(weights[k]) ? weights[k] : (k === 0 ? 1 : 0)));
      }
    }

    if (!position && xyz?.data?.length >= (i + 1) * 3) {
      position = new THREE.Vector3(xyz.data[i * 3], xyz.data[i * 3 + 1], xyz.data[i * 3 + 2]);
    }
    if (!position) continue;

    const snap = n === 1
      ? { type: 'vertex', meshUuid: mesh.uuid, meshName: getMeshLabel(mesh), vertexIndex: ids[0] }
      : {
          type: n === 2 ? 'edge' : 'triangle',
          meshUuid: mesh.uuid,
          meshName: getMeshLabel(mesh),
          vertexIndices: ids.slice(0, n),
          barycentric: n === 2
            ? { a: weights[0], b: weights[1] }
            : { a: weights[0], b: weights[1], c: weights[2] },
          t: n === 2 ? weights[1] : undefined,
        };

    imported.push({
      index: i,
      id: i + 1,
      name: `Landmark ${i + 1}`,
      snapMode: snap.type,
      worldPosition: { x: position.x, y: position.y, z: position.z },
      snap,
    });
  }

  return {
    format: 'geomy-landmarks',
    version: GEOMY_VERSION,
    coordinateSpaces: { absolute: 'world' },
    landmarks: imported,
  };
}

function landmarkArrayExportEntries() {
  const L = landmarks.length;
  const simplex = new Int32Array(L * 3);
  const bary = new Float32Array(L * 3);
  const counts = new Int32Array(L);
  const xyz = new Float32Array(L * 3);
  simplex.fill(-1);

  landmarks.forEach((landmark, i) => {
    const binding = landmark.binding || {};
    const type = binding.snapMode || landmark.snapMode;
    const pos = landmark.position || new THREE.Vector3();
    xyz[i * 3] = pos.x;
    xyz[i * 3 + 1] = pos.y;
    xyz[i * 3 + 2] = pos.z;

    if (type === 'vertex' && Number.isInteger(binding.vertexIndex)) {
      counts[i] = 1;
      simplex[i * 3] = binding.vertexIndex;
      bary[i * 3] = 1;
    } else if (type === 'edge' && Array.isArray(binding.vertexIndices) && binding.vertexIndices.length >= 2) {
      const t = Number.isFinite(Number(binding.t)) ? Number(binding.t) : Number(binding.barycentric?.b ?? 0);
      counts[i] = 2;
      simplex[i * 3] = Number(binding.vertexIndices[0]) || 0;
      simplex[i * 3 + 1] = Number(binding.vertexIndices[1]) || 0;
      bary[i * 3] = 1 - t;
      bary[i * 3 + 1] = t;
    } else if (type === 'triangle' && Array.isArray(binding.vertexIndices) && binding.vertexIndices.length >= 3) {
      counts[i] = 3;
      simplex[i * 3] = Number(binding.vertexIndices[0]) || 0;
      simplex[i * 3 + 1] = Number(binding.vertexIndices[1]) || 0;
      simplex[i * 3 + 2] = Number(binding.vertexIndices[2]) || 0;
      bary[i * 3] = Number(binding.barycentric?.a ?? 0);
      bary[i * 3 + 1] = Number(binding.barycentric?.b ?? 0);
      bary[i * 3 + 2] = Number(binding.barycentric?.c ?? 0);
    } else {
      counts[i] = 0;
    }
  });

  return [
    npyEntry('simplex.npy', simplex, [L, 3], 'int32'),
    npyEntry('barycentric.npy', bary, [L, 3], 'float32'),
    npyEntry('simplex_vertex_count.npy', counts, [L], 'int32'),
    npyEntry('world_xyz.npy', xyz, [L, 3], 'float32'),
    jsonEntry('metadata.json', {
      format: 'geomy-landmarks-numpy',
      version: GEOMY_VERSION,
      arrays: {
        simplex: 'int32[L,3]',
        barycentric: 'float32[L,3]',
        simplex_vertex_count: 'int32[L]',
        world_xyz: 'float32[L,3]',
      },
    }),
  ];
}

function exportLandmarksArrayBundle(extension = 'npz') {
  if (!landmarks.length) return alert('No landmarks.');
  const ext = extension === 'zip' ? 'zip' : 'npz';
  downloadArrayBundle(landmarkArrayExportEntries(), `landmarks.${ext}`);
}

function exportLandmarksByFormat(format) {
  if (format === 'npz' || format === 'zip') exportLandmarksArrayBundle(format);
  else exportJSON();
}

async function importLandmarkFile(file) {
  if (!file) return;
  try {
    const payload = await readLandmarkImportPayload(file);
    const absoluteSpace = payload?.coordinateSpaces?.absolute || payload?.coordinateSpace || 'asset-local';
    const imported = (payload?.landmarks || []).map((entry, index) => normalizeImportedLandmark(entry, index, nextLandmarkId + index, absoluteSpace)).filter(Boolean);
    if (!imported.length) throw new Error('No valid landmarks found.');
    commit('import landmarks', () => {
      landmarks = imported;
      nextLandmarkId = Math.max(nextLandmarkId, Math.max(0, ...landmarks.map(l => l.id)) + 1);
      selectedIndex = -1;
      rebuildMarkers();
    });
  } catch (error) {
    console.error('Failed to import landmarks:', error);
    alert(error?.message || 'Failed to import landmarks.');
  } finally {
    const input = document.getElementById('landmark-import-file');
    if (input) input.value = '';
  }
}


// ── Export ──────────────────────────────────────────────────────────

function absoluteExportData(landmark, index) {
  const assetPosition = assetPositionFromWorld(landmark.position) || landmark.position;

  return {
    index,
    id: landmark.id,
    name: landmark.name,
    snapMode: landmark.snapMode,
    assetPosition: {
      x: assetPosition.x,
      y: assetPosition.y,
      z: assetPosition.z,
    },
    // Kept for older imports, but now intentionally stores asset-local coordinates.
    worldPosition: {
      x: assetPosition.x,
      y: assetPosition.y,
      z: assetPosition.z,
    },
  };
}

function snapExportData(landmark) {
  const binding = landmark.binding || {};
  const type = binding.snapMode || landmark.snapMode;
  const base = {
    type,
    meshUuid: binding.meshUuid ?? null,
    meshName: binding.meshName ?? null,
  };

  if (type === 'triangle') {
    return {
      ...base,
      faceIndex: binding.faceIndex ?? null,
      vertexIndices: binding.vertexIndices || null,
      barycentric: binding.barycentric || null,
    };
  }
  if (type === 'vertex') {
    return {
      ...base,
      vertexIndex: binding.vertexIndex ?? null,
    };
  }
  if (type === 'edge') {
    return {
      ...base,
      vertexIndices: binding.vertexIndices || null,
      barycentric: binding.barycentric || null,
      t: binding.t ?? null,
    };
  }
  return base;
}

function exportJSON() {
  if (!landmarks.length) return alert('No landmarks.');

  const payload = {
    format: 'geomy-landmarks',
    version: GEOMY_VERSION,
    coordinateSpaces: {
      absolute: 'asset-local',
      triangle: 'mesh-face-barycentric',
      vertex: 'mesh-vertex-index',
      edge: 'mesh-edge-two-point-barycentric',
    },
    landmarks: landmarks.map((landmark, index) => ({
      ...absoluteExportData(landmark, index),
      snap: snapExportData(landmark),
    })),
  };

  downloadBlob(JSON.stringify(payload, null, 2), 'landmarks.json', 'application/json');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function updateStackButtons() {
  const undoButton = document.getElementById('btn-landmark-undo');
  const redoButton = document.getElementById('btn-landmark-redo');
  if (undoButton) undoButton.disabled = !history.canUndo;
  if (redoButton) redoButton.disabled = !history.canRedo;
}

function renderList() {
  const list = document.getElementById('pick-list');
  if (!list) return;

  updateStackButtons();

  if (!landmarks.length) {
    list.innerHTML = `
      <div class="info-row">
        Alt + left click to place<br>
        <small>Use T / V / E to change snap mode.</small>
      </div>`;
    return;
  }

  list.innerHTML = landmarks.map((landmark, index) => {
    const isSelected = index === selectedIndex;
    const isLastCreated = landmark.createdAt === Math.max(...landmarks.map(l => l.createdAt));
    const classes = [
      'pick-row',
      'landmark-row',
      isSelected ? 'selected' : '',
      isLastCreated ? 'highlight' : '',
    ].filter(Boolean).join(' ');

    return `
      <div class="${classes}" data-idx="${index}" draggable="true">
        <span class="drag-handle" title="Drag to reorder">⋮⋮</span>
        <span class="idx" title="Landmark order">#${index + 1}</span>
        <input class="landmark-name" data-idx="${index}" value="${escapeHtml(landmark.name)}" title="Landmark name">
        <span class="snap-badge" title="Snap mode">${landmark.snapMode[0].toUpperCase()}</span>
        <button class="btn-del" data-idx="${index}" title="Delete landmark">✕</button>
      </div>`;
  }).join('');

  // Event listeners for list items (same as before, but with setSelectedIndex toggle effect)
  list.querySelectorAll('.landmark-row').forEach(row => {
    const index = parseInt(row.dataset.idx, 10);

    row.addEventListener('click', event => {
      if (event.target.closest('input,button')) return;
      setSelectedIndex(index);
    });

    row.addEventListener('dragstart', event => {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(index));
      row.classList.add('dragging');
    });

    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      list.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    });

    row.addEventListener('dragover', event => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      row.classList.add('drag-over');
    });

    row.addEventListener('dragleave', () => {
      row.classList.remove('drag-over');
    });

    row.addEventListener('drop', event => {
      event.preventDefault();
      row.classList.remove('drag-over');
      const fromIndex = parseInt(event.dataTransfer.getData('text/plain'), 10);
      moveLandmark(fromIndex, index);
    });
  });

  list.querySelectorAll('.landmark-name').forEach(input => {
    input.addEventListener('click', event => event.stopPropagation());
    input.addEventListener('change', () => {
      renameLandmark(parseInt(input.dataset.idx, 10), input.value);
    });
  });

  list.querySelectorAll('.btn-del').forEach(button => {
    button.addEventListener('click', event => {
      event.stopPropagation();
      removeLandmarkAt(parseInt(button.dataset.idx, 10));
    });
  });
}

function renderPanel() {
  app.dom.taskContent.innerHTML = `
    <div class="task-heading">
      <h3>Landmark Picking</h3>
      <span class="task-help" tabindex="0" data-tip="Camera controls stay unchanged. Alt+left places; Shift+left selects; Ctrl+left-drag moves; Alt+right deletes; Shift+right swaps with selected; Backspace removes last; any modifier+wheel scales; Ctrl+Z/Y undo/redo.">?</span>
    </div>

    <div class="section-title">Edit</div>
    <div class="task-edit-compact">
      <button id="btn-clear" class="btn btn-danger">Clear all</button>
    </div>

    <div class="section-title">Snap next place / drag</div>
    <div class="landmark-option-group">
      <label class="radio-label"><input type="radio" name="landmark-snap-mode" value="triangle" checked> Triangle <span class="keycap">T</span></label>
      <label class="radio-label"><input type="radio" name="landmark-snap-mode" value="vertex"> Vertex <span class="keycap">V</span></label>
      <label class="radio-label"><input type="radio" name="landmark-snap-mode" value="edge"> Edge <span class="keycap">E</span></label>
    </div>

    <div class="section-title">Landmark Scale</div>
    <div class="range-row">
      <input type="range" id="landmark-scale" min="0.2" max="5" step="0.1" value="${landmarkScale}">
      <span class="range-val" id="landmark-scale-val">${landmarkScale.toFixed(1)}</span>
    </div>


    <div class="section-title">Landmarks</div>
    <div id="pick-list" class="pick-list landmark-list"></div>

    <div class="section-title section-title-with-help">
      <span>Export</span>
      <span class="section-help" tabindex="0" data-tip="Imports/exports absolute world positions plus triangle, vertex, and edge snap bindings.">?</span>
    </div>
    <div class="material-row landmark-io-row">
      <label>Format</label>
      <select id="landmark-io-format">
        <option value="npz">Numpy (NPZ)</option>
        <option value="zip">Numpy (ZIP)</option>
        <option value="json">JSON</option>
      </select>
      <span></span>
    </div>
    <div class="btn-row landmark-io-row">
      <button id="btn-import-json" class="btn">Import</button>
      <button id="btn-json" class="btn btn-export">Export</button>
    </div>
    <input id="landmark-import-file" class="landmark-file-input" type="file" accept=".json,.npz,.zip,application/json,application/zip">
  `;

  // Snap mode radios
  document.querySelectorAll('input[name="landmark-snap-mode"]').forEach(input => {
    input.checked = input.value === settings.snapMode;
    input.addEventListener('change', () => {
      if (input.checked) setSnapMode(input.value);
    });
  });

  // Undo / redo / clear
  document.getElementById('btn-clear')?.addEventListener('click', () => {
    if (window.confirm('Are you sure?')) clearAll();
  });

  // Import / export
  const importInput = document.getElementById('landmark-import-file');
  document.getElementById('btn-import-json')?.addEventListener('click', () => {
    importInput?.click();
  });
  importInput?.addEventListener('change', () => {
    importLandmarkFile(importInput.files?.[0]);
  });
  document.getElementById('btn-json')?.addEventListener('click', () => {
    exportLandmarksByFormat(document.getElementById('landmark-io-format')?.value || 'json');
  });

  // Landmark scale slider
  const scaleSlider = document.getElementById('landmark-scale');
  const scaleVal = document.getElementById('landmark-scale-val');
  scaleSlider?.addEventListener('input', () => {
    landmarkScale = parseFloat(scaleSlider.value);
    if (scaleVal) scaleVal.textContent = landmarkScale.toFixed(1);
    rebuildMarkers();
  });

  // Label scale slider
  const labelScaleSlider = document.getElementById('label-scale');
  const labelScaleVal = document.getElementById('label-scale-val');
  labelScaleSlider?.addEventListener('input', () => {
    labelScale = parseFloat(labelScaleSlider.value);
    if (labelScaleVal) labelScaleVal.textContent = labelScale.toFixed(1);
    rebuildMarkers();
  });

  renderList();
}

// ── Exported task object ────────────────────────────────────────────

export const landmarkPickingTask = {
  id: 'landmark',

  onDblClick() {
    return false;
  },

  activate() {
    active = true;
    ensureMarkers();
    renderPanel();
    rebuildMarkers();
    bindViewportEvents();
  },

  deactivate() {
    active = false;
    dragging = null;
    viewControlsSuppression.restore();
    unbindViewportEvents();

    if (markersGroup) {
      markersGroup.visible = false;
    }
    if (previewSphere) {
      previewSphere.removeFromParent();
      disposeObject3D(previewSphere);
      previewSphere = null;
    }
    app.dom.taskContent.innerHTML = '';
  },

  onFileLoaded() {
    refreshLandmarksForCurrentMesh();
    selectedIndex = -1;
    nextLandmarkId = Math.max(nextLandmarkId, Math.max(0, ...landmarks.map(landmark => landmark.id)) + 1);
    rebuildMarkers();
    renderList();
  },
};
