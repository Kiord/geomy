import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import { PLYExporter } from 'three/examples/jsm/exporters/PLYExporter.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { MeshBVH } from 'three-mesh-bvh';

import { app, updateEnvironmentUsage } from '../app.js';
import { HistoryStack } from '../core/HistoryStack.js';
import {
  LANDMARK_COLORS,
  landmarkCursorDescriptor,
  landmarkMarkerRadiusForObjects,
  makeLandmarkLabelSprite,
  makeLandmarkSphere,
} from '../landmarks/landmarkVisuals.js';
import { GEOMY_VERSION } from '../version.js';
import { downloadBlob } from '../util.js';
import { downloadNpy, parseBundleArrays, readArrayBundle } from '../io/numpyBundle.js';
import { loadCanonicalOBJFile } from '../io/objCanonicalLoader.js';
import {
  MeshComponentIndex,
  TemporaryVisualizationState,
  clamp,
  collectHitVertexIndices,
  ensureColorAttribute,
  getCanonicalPositionAttribute,
  getCanonicalVertexCount,
  getMeshLabel,
  isTextInputTarget,
  roundNumber,
  setVertexColor,
  vectorPayload,
} from './meshTaskUtils.js';
import '../css/meshRigidAlign.css';

const TASK_RENDER_OVERRIDE = 'mesh-rigid-align';
const STACK_LIMIT = 100;
const DEFAULT_BRUSH_RADIUS = 0.04;
const MIN_BRUSH_RADIUS = 0.005;
const MAX_BRUSH_RADIUS = 0.3;
const DEFAULT_SAMPLE_LIMIT = 2500;
const DEFAULT_TARGET_LIMIT = 8000;
const MAX_ICP_ITERATIONS = 80;
const DEFAULT_LANDMARK_BLEND = 0;
const DISPLAY_MODES = ['source', 'target', 'both'];
const INTERACTION_MODES = ['paint', 'landmark'];

const TARGET_INCLUDED_COLOR = new THREE.Color('#58d68d');
const TARGET_EXCLUDED_COLOR = new THREE.Color('#5f6975');
const SOURCE_INCLUDED_COLOR = new THREE.Color('#4aa3ff');
const SOURCE_EXCLUDED_COLOR = new THREE.Color('#6b5a64');
const DISPLAY_REFRESH_CONTROL_IDS = ['geo-vertices', 'geo-edges', 'geo-faces', 'viz-normals'];

const loaders = {
  gltf: new GLTFLoader(),
  glb: new GLTFLoader(),
  stl: new STLLoader(),
  ply: new PLYLoader(),
};

let active = false;
let brushRadius = DEFAULT_BRUSH_RADIUS;
let interactionMode = 'paint';
let displayMode = 'both';
let painting = null;
let draggingLandmark = null;
let selectedLandmarkSide = null;
let selectedLandmarkIndex = -1;
let cursorIndicatorEl = null;
let viewControlsSuppressed = false;
let viewControlsPreviousEnabled = true;
let suppressedControls = null;
let targetObject = null;
let sourceObject = null;
let alignRoot = null;
let previousCurrentObject = null;
let targetFileName = '';
let sourceFileName = '';
let sourceInitialMatrix = null;
let targetInitialMatrix = null;
let landmarkGroup = null;
let targetComponentIndex = new MeshComponentIndex();
let sourceComponentIndex = new MeshComponentIndex();
let vizState = new TemporaryVisualizationState();
let lastResult = null;
let nextLandmarkId = 1;
let sourceLandmarks = [];
let targetLandmarks = [];
let landmarkBlend = DEFAULT_LANDMARK_BLEND;
let alignAllowScale = true;
let alignAllowRotation = true;
let alignAllowTranslation = true;
let targetSelections = new WeakMap();
let sourceSelections = new WeakMap();
let hiddenStandardObject = null;
let hiddenStandardObjectWasVisible = true;
let hiddenStandardObjectParent = null;
let hiddenStandardObjectIndex = -1;
let previousVertexCountText = null;
let rigidDropOverlayState = null;
let alignLights = [];
let allowMirroring = true;
let distanceHeatmap = false;
let taskWireframe = false;
let taskBackfaceCulling = false;
let landmarkScale = 1.0;
let labelScale = 1.0;
const sideDistanceBvhCache = {
  source: null,
  target: null,
};
const HEATMAP_SAMPLE_LIMIT = 12000;
const HEATMAP_DISTANCE_PERCENTILE = 0.95;
const HEATMAP_COLORS = [
  { at: 0.00, color: new THREE.Color('#313695') },
  { at: 0.25, color: new THREE.Color('#74add1') },
  { at: 0.50, color: new THREE.Color('#ffffbf') },
  { at: 0.75, color: new THREE.Color('#f46d43') },
  { at: 1.00, color: new THREE.Color('#a50026') },
];
const heatmapColorTemp = new THREE.Color();
const heatmapFieldCache = {
  source: null,
  target: null,
};

const history = new HistoryStack({ limit: STACK_LIMIT });

function smoothImportedGeometry(geometry) {
  if (!geometry?.attributes?.position) return geometry;

  // Keep rigid-align mesh vertices as imported. Selections, landmarks,
  // masks, exports, and correspondence data must see stable vertex indices.
  // Only add normals when missing; this does not change vertex count/order.
  if (!geometry.attributes.normal) {
    geometry.computeVertexNormals?.();
  }

  geometry.computeBoundingBox?.();
  geometry.computeBoundingSphere?.();
  return geometry;
}

function prepareObjectGeometry(object) {
  object?.traverse?.(child => {
    if (!child.isMesh || !child.geometry) return;

    const original = child.geometry;
    const prepared = smoothImportedGeometry(original);
    if (prepared && prepared !== original) {
      child.geometry = prepared;
      original.dispose?.();
    }
  });

  return object;
}


const cursorState = {
  x: 0,
  y: 0,
  clientX: 0,
  clientY: 0,
  hasPointerPosition: false,
  inViewport: false,
  alt: false,
  shift: false,
  ctrlOrMeta: false,
};

// ── Generic helpers ───────────────────────────────────────────────

function getViewportRect() {
  return app.dom.viewport.getBoundingClientRect();
}

function focusViewportForKeys() {
  const canvas = app.renderer?.domElement;
  if (!canvas) return;

  canvas.setAttribute('tabindex', '0');
  canvas.style.outline = 'none';
  canvas.focus({ preventScroll: true });
}

function sideLabel(side) {
  return side === 'source' ? 'Source' : 'Target';
}

function safeFilename(value, fallback = 'mesh') {
  const safe = String(value || fallback)
    .trim()
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();

  return safe || fallback;
}

function getObjectForSide(side) {
  return side === 'source' ? sourceObject : targetObject;
}

function getMeshesForSide(side) {
  const root = getObjectForSide(side);
  const meshes = [];

  root?.traverse?.(object => {
    if (object.isMesh && object.geometry?.attributes?.position) {
      meshes.push(object);
    }
  });

  return meshes;
}

function getSelectionStore(side) {
  return side === 'source' ? sourceSelections : targetSelections;
}

function getComponentIndex(side) {
  return side === 'source' ? sourceComponentIndex : targetComponentIndex;
}

function getSideColors(side) {
  return side === 'source'
    ? { included: SOURCE_INCLUDED_COLOR, excluded: SOURCE_EXCLUDED_COLOR }
    : { included: TARGET_INCLUDED_COLOR, excluded: TARGET_EXCLUDED_COLOR };
}

function isSideVisible(side) {
  return displayMode === 'both' || displayMode === side;
}

function makeTaskMaterial(side) {
  const material = new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: taskBackfaceCulling ? THREE.FrontSide : THREE.DoubleSide,
    flatShading: true,
    transparent: false,
    opacity: 1,
    depthTest: true,
    depthWrite: true,
    wireframe: taskWireframe,
  });

  material.name = `geomy-rigid-align-${side}-lambert-material`;
  material.toneMapped = false;
  material.userData.meshRigidAlignSide = side;
  return material;
}

function getMaterialList(material) {
  if (!material) return [];
  return Array.isArray(material) ? material : [material];
}

function cloneMaterialOrArray(material) {
  if (!material) return material;
  return Array.isArray(material)
    ? material.map(mat => mat?.clone?.() || mat)
    : material.clone?.() || material;
}

function disposeMaterialOrArray(material) {
  getMaterialList(material).forEach(mat => mat?.dispose?.());
}

function clearDistanceFieldCache(side = null) {
  if (side === 'source' || side === 'target') {
    heatmapFieldCache[side] = null;
    return;
  }

  heatmapFieldCache.source = null;
  heatmapFieldCache.target = null;
}

function clearSideDistanceBvh(side) {
  // Distances for both visible sides depend on both mesh surfaces. Clear them
  // even when the BVH was not built yet.
  clearDistanceFieldCache();

  const cached = sideDistanceBvhCache[side];
  if (!cached) return;

  if (cached.geometry?.boundsTree === cached.bvh) {
    cached.geometry.boundsTree = null;
  }

  cached.geometry?.dispose?.();
  sideDistanceBvhCache[side] = null;
}

function disposeObject3D(object, { disposeGeometry = true, disposeMaterial = true } = {}) {
  object?.traverse?.(child => {
    if (disposeGeometry) child.geometry?.dispose?.();
    if (disposeMaterial && child.material) disposeMaterialOrArray(child.material);
  });
}

function makeMergedRootLocalGeometry(side) {
  const root = getObjectForSide(side);
  if (!root) return null;

  root.updateMatrixWorld(true);
  const rootInverse = root.matrixWorld.clone().invert();
  const positions = [];
  const indices = [];
  const localPoint = new THREE.Vector3();
  const matrix = new THREE.Matrix4();
  const meshes = getMeshesForSide(side);

  meshes.forEach(mesh => {
    const position = mesh.geometry?.attributes?.position;
    if (!position) return;

    mesh.updateMatrixWorld(true);
    matrix.copy(rootInverse).multiply(mesh.matrixWorld);

    const vertexOffset = positions.length / 3;
    for (let i = 0; i < position.count; i++) {
      localPoint.fromBufferAttribute(position, i).applyMatrix4(matrix);
      positions.push(localPoint.x, localPoint.y, localPoint.z);
    }

    const index = mesh.geometry.index;
    if (index) {
      for (let i = 0; i < index.count; i++) {
        indices.push(vertexOffset + index.getX(i));
      }
    } else {
      for (let i = 0; i < position.count; i++) {
        indices.push(vertexOffset + i);
      }
    }
  });

  if (positions.length < 9 || indices.length < 3) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices.length > 65535 ? indices : new Uint16Array(indices));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  return geometry;
}

function getSideDistanceBvh(side) {
  const root = getObjectForSide(side);
  if (!root) return null;

  const cached = sideDistanceBvhCache[side];
  if (cached?.root === root) return cached;

  clearSideDistanceBvh(side);

  const geometry = makeMergedRootLocalGeometry(side);
  if (!geometry) return null;

  try {
    const bvh = new MeshBVH(geometry, { verbose: false });
    geometry.boundsTree = bvh;

    sideDistanceBvhCache[side] = {
      root,
      geometry,
      bvh,
      matrixWorld: new THREE.Matrix4(),
      matrixWorldInverse: new THREE.Matrix4(),
      queryLocal: new THREE.Vector3(),
      closestLocal: { point: new THREE.Vector3() },
      closestWorld: new THREE.Vector3(),
    };

    return sideDistanceBvhCache[side];
  } catch (error) {
    console.warn(`Failed to build ${side} distance BVH for rigid-align heatmap:`, error);
    geometry.dispose();
    return null;
  }
}

function setRootMatrix(root, matrix) {
  if (!root || !matrix) return;

  root.matrix.copy(matrix);
  root.matrix.decompose(root.position, root.quaternion, root.scale);
  root.updateMatrixWorld(true);
}

function matrixArray(value) {
  if (!value) return null;

  if (value.isMatrix4) {
    return value.toArray().map(roundNumber);
  }

  if (value.matrix?.isMatrix4) {
    value.updateMatrix?.();
    return value.matrix.toArray().map(roundNumber);
  }

  return null;
}

function sourceAssetToTargetAssetMatrix() {
  if (!sourceObject || !targetObject) return null;

  sourceObject.updateMatrix?.();
  targetObject.updateMatrix?.();

  return targetObject.matrix.clone().invert().multiply(sourceObject.matrix);
}

function updateTaskVertexCount() {
  const total = ['source', 'target'].reduce((sum, side) => (
    sum + getMeshesForSide(side).reduce((sideSum, mesh) => (
      sideSum + (mesh.geometry?.attributes?.position?.count || 0)
    ), 0)
  ), 0);

  if (app.dom?.vertexCount) {
    app.dom.vertexCount.textContent = total ? `${total.toLocaleString()} align verts` : '';
  }
}

function hideStandardLoadedObject() {
  const object = app.currentObject;
  if (!object || object === alignRoot || object === sourceObject || object === targetObject) return;

  if (hiddenStandardObject !== object) {
    restoreStandardLoadedObject();
    hiddenStandardObject = object;
    hiddenStandardObjectWasVisible = object.visible !== false;
    hiddenStandardObjectParent = object.parent || null;
    hiddenStandardObjectIndex = hiddenStandardObjectParent
      ? hiddenStandardObjectParent.children.indexOf(object)
      : -1;
  }

  object.visible = false;

  // Visibility on the root should be enough, but detaching the single-task
  // mesh makes rigid-align's Source/Target scene ownership unambiguous and
  // prevents stale meshes/helpers from rendering while this task is active.
  if (object.parent) {
    object.removeFromParent();
  }
}

function restoreStandardLoadedObject() {
  if (hiddenStandardObject) {
    if (hiddenStandardObjectParent && hiddenStandardObject.parent !== hiddenStandardObjectParent) {
      const insertAt = Math.max(0, Math.min(hiddenStandardObjectIndex, hiddenStandardObjectParent.children.length));
      hiddenStandardObjectParent.add(hiddenStandardObject);

      if (insertAt < hiddenStandardObjectParent.children.length - 1) {
        hiddenStandardObjectParent.children.splice(hiddenStandardObjectParent.children.length - 1, 1);
        hiddenStandardObjectParent.children.splice(insertAt, 0, hiddenStandardObject);
      }
    }

    hiddenStandardObject.visible = hiddenStandardObjectWasVisible;
  }

  hiddenStandardObject = null;
  hiddenStandardObjectWasVisible = true;
  hiddenStandardObjectParent = null;
  hiddenStandardObjectIndex = -1;
}

function ensureAlignRoot() {
  if (alignRoot?.parent) return alignRoot;

  alignRoot = new THREE.Group();
  alignRoot.name = 'mesh-rigid-align-root';
  app.scene.add(alignRoot);
  return alignRoot;
}

function setRigidCurrentObject() {
  ensureAlignRoot();

  if (app.currentObject !== alignRoot) {
    previousCurrentObject = app.currentObject || previousCurrentObject;
    app.currentObject = alignRoot;
  }
}

function restoreRigidCurrentObject() {
  if (app.currentObject === alignRoot) {
    app.currentObject = previousCurrentObject || null;
  }

  previousCurrentObject = null;
}

function refreshGeometryInspectionHelpers() {
  DISPLAY_REFRESH_CONTROL_IDS.forEach(id => {
    const checkbox = document.getElementById(id);
    if (checkbox?.checked) {
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
}

function captureRigidDropOverlayState() {
  if (rigidDropOverlayState || !app.dom?.dropOverlay || !app.dom?.dropMessage) return;

  rigidDropOverlayState = {
    display: app.dom.dropOverlay.style.display,
    messageHtml: app.dom.dropMessage.innerHTML,
    messagePointerEvents: app.dom.dropMessage.style.pointerEvents,
  };
}

function updateRigidDropOverlay() {
  if (!active || !app.dom?.dropOverlay || !app.dom?.dropMessage) return;

  captureRigidDropOverlayState();

  if (sourceObject && targetObject) {
    app.dom.dropOverlay.style.display = 'none';
    return;
  }

  const missing = !sourceObject && !targetObject
    ? 'source and target meshes'
    : (!sourceObject ? 'source mesh' : 'target mesh');

  app.dom.dropMessage.innerHTML = `Load ${missing}<br><small>Use the Mesh Rigid Align buttons in the left panel</small>`;
  app.dom.dropMessage.style.pointerEvents = 'none';
  app.dom.dropOverlay.style.display = 'flex';
}

function restoreRigidDropOverlay() {
  if (!rigidDropOverlayState || !app.dom?.dropOverlay || !app.dom?.dropMessage) return;

  app.dom.dropOverlay.style.display = rigidDropOverlayState.display;
  app.dom.dropMessage.innerHTML = rigidDropOverlayState.messageHtml;
  app.dom.dropMessage.style.pointerEvents = rigidDropOverlayState.messagePointerEvents;
  rigidDropOverlayState = null;
}

function ensureAlignLights() {
  alignLights = alignLights.filter(light => light?.parent);

  if (alignLights.length) {
    alignLights.forEach(light => { light.visible = active; });
    return alignLights;
  }

  const hemi = new THREE.HemisphereLight(0xffffff, 0x303060, 1.7);
  hemi.name = 'geomy-rigid-align-hemi-light';

  const key = new THREE.DirectionalLight(0xffffff, 2.1);
  key.name = 'geomy-rigid-align-key-light';
  key.position.set(2.5, 3.5, 4.0);

  const fill = new THREE.DirectionalLight(0xffffff, 0.55);
  fill.name = 'geomy-rigid-align-fill-light';
  fill.position.set(-2.5, 1.2, -2.0);

  alignLights = [hemi, key, fill];
  alignLights.forEach(light => {
    light.visible = active;
    app.scene.add(light);
  });

  return alignLights;
}

function setAlignLightsVisible(visible) {
  alignLights.forEach(light => {
    light.visible = visible;
  });
}

// ── Selection and snapshots ───────────────────────────────────────

function getSelection(mesh, side) {
  const vertexCount = getCanonicalVertexCount(mesh);
  if (!vertexCount) return null;

  const store = getSelectionStore(side);
  let selection = store.get(mesh);

  if (!selection || selection.length !== vertexCount) {
    selection = new Uint8Array(vertexCount);
    selection.fill(1);
    store.set(mesh, selection);
  }

  return selection;
}

function countSelection(mesh, side) {
  const selection = getSelection(mesh, side);
  if (!selection) return { included: 0, total: 0 };

  let included = 0;
  for (let i = 0; i < selection.length; i++) {
    if (selection[i]) included += 1;
  }

  return { included, total: selection.length };
}

function countSideSelection(side) {
  let included = 0;
  let total = 0;

  getMeshesForSide(side).forEach(mesh => {
    const stats = countSelection(mesh, side);
    included += stats.included;
    total += stats.total;
  });

  return { included, total };
}

function setSelectionForIndices(mesh, side, indices, included) {
  const selection = getSelection(mesh, side);
  if (!selection) return false;

  const value = included ? 1 : 0;
  let changed = false;

  indices.forEach(index => {
    if (index < 0 || index >= selection.length) return;
    if (selection[index] === value) return;
    selection[index] = value;
    changed = true;
  });

  if (changed) updateMeshColors(mesh, side);
  return changed;
}

function resetSelection(side, value = 1) {
  getMeshesForSide(side).forEach(mesh => {
    const selection = getSelection(mesh, side);
    if (!selection) return;
    selection.fill(value ? 1 : 0);
    updateMeshColors(mesh, side);
  });
}

function invertSelection(side) {
  getMeshesForSide(side).forEach(mesh => {
    const selection = getSelection(mesh, side);
    if (!selection) return;

    for (let i = 0; i < selection.length; i++) {
      selection[i] = selection[i] ? 0 : 1;
    }

    updateMeshColors(mesh, side);
  });
}

function invertActiveSelection() {
  const side = editableSideFromDisplay();
  if (!side) {
    alert('Show Source or Target before inverting the active alignment region.');
    return false;
  }

  return commit(`invert ${side} alignment region`, () => invertSelection(side));
}

function selectionSnapshot(side) {
  return getMeshesForSide(side).map(mesh => {
    const selection = getSelection(mesh, side);
    const excluded = [];

    if (selection) {
      for (let i = 0; i < selection.length; i++) {
        if (!selection[i]) excluded.push(i);
      }
    }

    return {
      meshUuid: mesh.uuid,
      meshName: getMeshLabel(mesh),
      vertexCount: selection?.length || 0,
      excluded,
    };
  });
}

function restoreSelectionSnapshot(side, snapshot) {
  const meshes = getMeshesForSide(side);
  const byUuid = new Map(meshes.map(mesh => [mesh.uuid, mesh]));
  const byName = new Map(meshes.map(mesh => [getMeshLabel(mesh), mesh]));

  snapshot.forEach(entry => {
    const mesh = byUuid.get(entry.meshUuid) || byName.get(entry.meshName);
    const selection = mesh ? getSelection(mesh, side) : null;
    if (!selection) return;

    selection.fill(1);
    (entry.excluded || []).forEach(index => {
      if (index >= 0 && index < selection.length) selection[index] = 0;
    });
    updateMeshColors(mesh, side);
  });
}

function serializeLandmark(landmark) {
  if (!landmark) return null;

  return {
    id: landmark.id,
    local: landmark.local ? vectorPayload(landmark.local) : null,
  };
}

function vectorFromPayload(payload) {
  if (!payload) return null;
  const x = Number(payload.x);
  const y = Number(payload.y);
  const z = Number(payload.z);
  return [x, y, z].every(Number.isFinite) ? new THREE.Vector3(x, y, z) : null;
}

function deserializeLandmark(data) {
  if (!data) return null;

  const id = Number.isInteger(data.id) ? data.id : nextLandmarkId++;
  const local = vectorFromPayload(data.local);
  if (!local) return null;

  return { id, local };
}

function makeSnapshot() {
  return {
    target: selectionSnapshot('target'),
    source: selectionSnapshot('source'),
    sourceLandmarks: sourceLandmarks.map(serializeLandmark),
    targetLandmarks: targetLandmarks.map(serializeLandmark),
    selectedLandmarkSide,
    selectedLandmarkIndex,
    landmarkScale,
    labelScale,
    landmarkBlend: roundNumber(landmarkBlend),
    alignAllowScale,
    alignAllowRotation,
    alignAllowTranslation,
    nextLandmarkId,
    sourceMatrix: matrixArray(sourceObject),
    targetMatrix: matrixArray(targetObject),
    displayMode,
    allowMirroring,
    distanceHeatmap,
    lastResult,
  };
}

function snapshotKey(snapshot) {
  return JSON.stringify(snapshot);
}

function restoreSnapshot(snapshot) {
  if (snapshot.targetMatrix && targetObject) {
    setRootMatrix(targetObject, new THREE.Matrix4().fromArray(snapshot.targetMatrix));
  }

  if (snapshot.sourceMatrix && sourceObject) {
    setRootMatrix(sourceObject, new THREE.Matrix4().fromArray(snapshot.sourceMatrix));
  }

  clearDistanceFieldCache();

  restoreSelectionSnapshot('target', snapshot.target || []);
  restoreSelectionSnapshot('source', snapshot.source || []);

  sourceLandmarks = trimTrailingEmptyLandmarks((snapshot.sourceLandmarks || []).map(deserializeLandmark));
  targetLandmarks = trimTrailingEmptyLandmarks((snapshot.targetLandmarks || []).map(deserializeLandmark));
  landmarkBlend = clamp(Number(snapshot.landmarkBlend ?? DEFAULT_LANDMARK_BLEND) || 0, 0, 1);
  alignAllowScale = snapshot.alignAllowScale !== false;
  alignAllowRotation = snapshot.alignAllowRotation !== false;
  alignAllowTranslation = snapshot.alignAllowTranslation !== false;
  nextLandmarkId = snapshot.nextLandmarkId || (
    Math.max(
      0,
      ...sourceLandmarks.filter(Boolean).map(landmark => landmark.id),
      ...targetLandmarks.filter(Boolean).map(landmark => landmark.id)
    ) + 1
  );
  lastResult = snapshot.lastResult || null;
  selectedLandmarkSide = snapshot.selectedLandmarkSide || null;
  selectedLandmarkIndex = Number.isInteger(snapshot.selectedLandmarkIndex) ? snapshot.selectedLandmarkIndex : -1;
  landmarkScale = clamp(Number(snapshot.landmarkScale) || 1, 0.25, 6);
  labelScale = clamp(Number(snapshot.labelScale) || 1, 0.25, 6);
  displayMode = DISPLAY_MODES.includes(snapshot.displayMode) ? snapshot.displayMode : displayMode;
  allowMirroring = snapshot.allowMirroring !== false;
  distanceHeatmap = !!snapshot.distanceHeatmap;

  updateAllColors();
  updateMeshVisibility();
  rebuildLandmarkMarkers();
  renderPanel();
}

function pushUndoSnapshot(snapshot) {
  history.record(snapshot);
}

function commit(label, mutate) {
  const before = makeSnapshot();
  mutate();
  const after = makeSnapshot();

  if (snapshotKey(before) === snapshotKey(after)) {
    updatePanelStats();
    renderLandmarkList();
    return false;
  }

  pushUndoSnapshot(before);
  updatePanelStats();
  renderLandmarkList();
  updateStackButtons();
  return true;
}

function undo() {
  if (history.canUndo && history.undo(makeSnapshot(), restoreSnapshot)) {
    updateStackButtons();
  }
}

function redo() {
  if (history.canRedo && history.redo(makeSnapshot(), restoreSnapshot)) {
    updateStackButtons();
  }
}

function clearHistory() {
  history.clear();
  updateStackButtons();
}

// ── Render mode ──────────────────────────────────────────────────

function updateMeshColors(mesh, side) {
  if (distanceHeatmap && sourceObject && targetObject) return;

  const selection = getSelection(mesh, side);
  const colorAttribute = ensureColorAttribute(mesh);
  if (!selection || !colorAttribute) return;

  const colors = getSideColors(side);

  for (let i = 0; i < selection.length; i++) {
    setVertexColor(colorAttribute, i, selection[i] ? colors.included : colors.excluded);
  }

  colorAttribute.needsUpdate = true;
}

function updateAllColors() {
  if (applyDistanceHeatmapColors()) return;

  getMeshesForSide('target').forEach(mesh => updateMeshColors(mesh, 'target'));
  getMeshesForSide('source').forEach(mesh => updateMeshColors(mesh, 'source'));
}

function applySideMaterials(side) {
  getMeshesForSide(side).forEach(mesh => {
    getSelection(mesh, side);
    updateMeshColors(mesh, side);

    const current = mesh.material;
    if (!mesh.userData.geomyRigidOriginalMaterial) {
      mesh.userData.geomyRigidOriginalMaterial = cloneMaterialOrArray(current);
    } else {
      disposeMaterialOrArray(current);
    }

    mesh.material = makeTaskMaterial(side);
    mesh.renderOrder = side === 'source' ? 20 : 10;
  });

  applyTaskDisplaySettings();
  updateMeshVisibility();
}

function applyTaskDisplaySettings() {
  const materialSide = taskBackfaceCulling ? THREE.FrontSide : THREE.DoubleSide;

  ['source', 'target'].forEach(side => {
    getMeshesForSide(side).forEach(mesh => {
      getMaterialList(mesh.material).forEach(material => {
        material.wireframe = taskWireframe;
        material.side = materialSide;
        material.transparent = false;
        material.opacity = 1;
        material.depthWrite = true;
        material.needsUpdate = true;
      });
    });
  });
}

function updateMaterialOpacityForSide(side) {
  getMeshesForSide(side).forEach(mesh => {
    getMaterialList(mesh.material).forEach(material => {
      material.transparent = false;
      material.opacity = 1;
      material.depthWrite = true;
      material.needsUpdate = true;
    });
  });
}

function updateMeshVisibility() {
  if (alignRoot) alignRoot.visible = active;
  if (targetObject) targetObject.visible = active && isSideVisible('target');
  if (sourceObject) sourceObject.visible = active && isSideVisible('source');

  updateMaterialOpacityForSide('target');
  updateMaterialOpacityForSide('source');
  rebuildLandmarkMarkers();
  updateDisplayButtons();
  updateRigidDropOverlay();
  refreshGeometryInspectionHelpers();
}


function syncTaskDisplaySettingsFromVizPanel() {
  taskWireframe = !!document.getElementById('viz-wireframe')?.checked;
  taskBackfaceCulling = !!document.getElementById('viz-cull')?.checked;
}

function forceRigidOpacityControls() {
  const slider = document.getElementById('viz-opacity');
  const label = document.getElementById('opacity-val');

  if (slider) slider.value = '100';
  if (label) label.textContent = '100%';

  applyTaskDisplaySettings();
}

function enterTaskRenderMode() {
  app.renderOverride = TASK_RENDER_OVERRIDE;
  syncTaskDisplaySettingsFromVizPanel();
  forceRigidOpacityControls();

  if (app.scene) {
    app.scene.environment = null;
  }

  ensureAlignLights();
  setAlignLightsVisible(true);
  vizState.setMaterialPanelHidden(true);
  vizState.setSmoothShadingDisabled(true);
}

function exitTaskRenderMode() {
  if (app.renderOverride === TASK_RENDER_OVERRIDE) {
    app.renderOverride = null;
  }

  setAlignLightsVisible(false);
  vizState.restore();
  updateEnvironmentUsage();
}

function setDisplayMode(mode, { commitChange = false } = {}) {
  if (!DISPLAY_MODES.includes(mode) || displayMode === mode) return;

  const applyMode = () => {
    displayMode = mode;

    if (displayMode === 'both') {
      painting = null;
      draggingLandmark = null;
    }

    updateMeshVisibility();
    if (distanceHeatmap) updateAllColors();
    updateCursorIndicator();
  };

  if (commitChange) {
    commit('change align display mode', applyMode);
  } else {
    applyMode();
  }
}

function cycleDisplayMode() {
  const index = DISPLAY_MODES.indexOf(displayMode);
  setDisplayMode(DISPLAY_MODES[(index + 1) % DISPLAY_MODES.length], { commitChange: true });
}

function updateDisplayButtons() {
  document.querySelectorAll('[data-mesh-rigid-view]').forEach(button => {
    button.classList.toggle('active', button.dataset.meshRigidView === displayMode);
  });
}

function updateDistanceCheckbox() {
  const input = document.getElementById('mesh-rigid-distance-heatmap');
  if (input) input.checked = !!distanceHeatmap;
}

function setDistanceHeatmap(show, { commitChange = true } = {}) {
  const next = !!show;
  if (distanceHeatmap === next) {
    updateDistanceCheckbox();
    return;
  }

  const apply = () => {
    distanceHeatmap = next;
    updateAllColors();
    updateDistanceCheckbox();
  };

  if (commitChange) {
    commit(next ? 'show distance heatmap' : 'hide distance heatmap', apply);
  } else {
    apply();
  }
}

function setInteractionMode(mode) {
  if (!INTERACTION_MODES.includes(mode)) return;

  interactionMode = mode;
  if (mode !== 'landmark') {
    draggingLandmark = null;
  }

  updateInteractionButtons();
  updateCursorIndicator();
}

function updateInteractionButtons() {
  document.querySelectorAll('[data-mesh-rigid-mode]').forEach(button => {
    button.classList.toggle('active', button.dataset.meshRigidMode === interactionMode);
  });
}

// ── Mesh loading ─────────────────────────────────────────────────

function normalizeObjectToUnitBox(object) {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const scale = Number.isFinite(maxDim) && maxDim > 0 ? 1.5 / maxDim : 1;

  object.scale.setScalar(scale);
  object.position.sub(center.multiplyScalar(scale));
  object.updateMatrixWorld(true);
}

async function objectFromFile(file, side) {
  const ext = file.name.split('.').pop().toLowerCase();

  if (ext === 'obj') {
    return prepareObjectGeometry(await loadCanonicalOBJFile(file));
  }

  const loader = loaders[ext];
  if (!loader) throw new Error(`Unsupported ${side} mesh: .${ext}`);

  const url = URL.createObjectURL(file);

  try {
    if (ext === 'gltf' || ext === 'glb') {
      const gltf = await loader.loadAsync(url);
      return gltf.scene;
    }

    const geometry = smoothImportedGeometry(await loader.loadAsync(url));
    return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: '#e0e0e0', roughness: 0.4, metalness: 0.1 }));
  } finally {
    URL.revokeObjectURL(url);
  }
}

function clearLandmarks() {
  sourceLandmarks = [];
  targetLandmarks = [];
  landmarkBlend = DEFAULT_LANDMARK_BLEND;
  nextLandmarkId = 1;
  selectedLandmarkSide = null;
  selectedLandmarkIndex = -1;
  clearLandmarkMarkers();
}

function clearSide(side) {
  const object = getObjectForSide(side);

  if (object) {
    object.removeFromParent();
    disposeObject3D(object, { disposeGeometry: true, disposeMaterial: true });
  }
  clearSideDistanceBvh(side);

  if (side === 'source') {
    sourceObject = null;
    sourceFileName = '';
    sourceInitialMatrix = null;
    sourceSelections = new WeakMap();
    sourceComponentIndex.reset();
  } else {
    targetObject = null;
    targetFileName = '';
    targetInitialMatrix = null;
    targetSelections = new WeakMap();
    targetComponentIndex.reset();
  }

  clearLandmarks();
  lastResult = null;
  updateTaskVertexCount();
  updateMeshVisibility();
  updatePanelStats();
}

async function loadSideFile(side, file) {
  if (!file) return;

  try {
    clearSide(side);

    const object = await objectFromFile(file, side);
    normalizeObjectToUnitBox(object);
    object.name = `${sideLabel(side)}: ${file.name}`;
    object.traverse(child => {
      if (child.isMesh) child.renderOrder = side === 'source' ? 20 : 10;
    });

    ensureAlignRoot().add(object);
    setRigidCurrentObject();

    if (side === 'source') {
      sourceObject = object;
      sourceFileName = file.name;
      sourceObject.updateMatrix();
      sourceInitialMatrix = sourceObject.matrix.clone();
    } else {
      targetObject = object;
      targetFileName = file.name;
      targetObject.updateMatrix();
      targetInitialMatrix = targetObject.matrix.clone();
    }

    hideStandardLoadedObject();
    applySideMaterials(side);
    updateAllColors();
    updateTaskVertexCount();
    setDisplayMode(side);
    clearHistory();
    renderPanel();
  } catch (error) {
    console.error(`Failed to load ${side} mesh:`, error);
    alert(error?.message || `Failed to load ${side} mesh.`);
  } finally {
    const input = document.getElementById(`mesh-rigid-${side}-file`);
    if (input) input.value = '';
  }
}

function resetSourceTransform() {
  if (!sourceObject) return false;

  return commit('reset source transform', () => {
    const initial = sourceInitialMatrix?.clone?.() || new THREE.Matrix4();
    setRootMatrix(sourceObject, initial);
    clearDistanceFieldCache();
    lastResult = null;
    updateAllColors();
    rebuildLandmarkMarkers();
  });
}

function resetTargetTransform() {
  if (!targetObject) return false;

  return commit('reset target transform', () => {
    const initial = targetInitialMatrix?.clone?.() || new THREE.Matrix4();
    setRootMatrix(targetObject, initial);
    clearDistanceFieldCache();
    lastResult = null;
    updateAllColors();
    rebuildLandmarkMarkers();
  });
}

function applyDeltaToSource(deltaMatrix) {
  if (!sourceObject) return;

  sourceObject.applyMatrix4(deltaMatrix);
  sourceObject.updateMatrixWorld(true);
  clearDistanceFieldCache();
}

// ── Picking and painting ──────────────────────────────────────────

function raycastSide(event, side, { requireVisible = true } = {}) {
  const object = getObjectForSide(side);
  if (!object || (requireVisible && !isSideVisible(side))) return [];

  const rect = getViewportRect();
  const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  const y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(x, y), app.camera);
  return raycaster.intersectObject(object, true)
    .filter(hit => hit.object?.isMesh)
    .map(hit => ({ hit, side }));
}

function hitFromEvent(event, forcedSide = null) {
  const candidates = forcedSide
    ? raycastSide(event, forcedSide, { requireVisible: false })
    : DISPLAY_MODES.flatMap(side => (isSideVisible(side) ? raycastSide(event, side) : []));

  candidates.sort((a, b) => a.hit.distance - b.hit.distance);
  return candidates[0] || null;
}

function paintHit(hitInfo, mode, included) {
  const hit = hitInfo?.hit;
  const side = hitInfo?.side;
  if (!hit?.object?.isMesh || !side) return false;

  const indices = collectHitVertexIndices(hit, {
    mode,
    brushRadius,
    componentIndex: getComponentIndex(side),
  });

  return setSelectionForIndices(hit.object, side, indices, included);
}

function paintFromEvent(event, mode = 'brush', included = true) {
  const side = editableSideFromDisplay();
  if (!side) return false;

  const hitInfo = hitFromEvent(event, side);
  return hitInfo ? paintHit(hitInfo, mode, included) : false;
}

function preventTaskEvent(event) {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation?.();
}

function beginPainting(event, mode, included) {
  painting = {
    mode,
    included,
    pointerId: event.pointerId,
    before: makeSnapshot(),
    changed: false,
  };

  painting.changed = paintFromEvent(event, mode, included) || painting.changed;
}

function updatePainting(event) {
  if (!painting || painting.pointerId !== event.pointerId) return;
  preventTaskEvent(event);
  painting.changed = paintFromEvent(event, painting.mode, painting.included) || painting.changed;
}

function finishPaintingGesture(event) {
  if (!painting || painting.pointerId !== event.pointerId) return;
  preventTaskEvent(event);

  const before = painting.before;
  const changed = painting.changed;
  painting = null;

  if (changed && snapshotKey(before) !== snapshotKey(makeSnapshot())) {
    pushUndoSnapshot(before);
    updateStackButtons();
  }

  updatePanelStats();
}

// ── Cursor affordances ────────────────────────────────────────────

function ensureCursorIndicator() {
  const viewport = app.dom?.viewport;
  if (!viewport) return null;

  if (cursorIndicatorEl?.parentElement === viewport) return cursorIndicatorEl;

  cursorIndicatorEl?.remove?.();
  cursorIndicatorEl = document.createElement('div');
  cursorIndicatorEl.className = 'mesh-rigid-cursor-indicator is-hidden';
  cursorIndicatorEl.setAttribute('aria-hidden', 'true');
  viewport.appendChild(cursorIndicatorEl);
  return cursorIndicatorEl;
}

function setCanvasCursor(cursor = '') {
  if (app.renderer?.domElement) app.renderer.domElement.style.cursor = cursor;
}

function hideCursorIndicator(indicator = cursorIndicatorEl) {
  if (!indicator) return;
  indicator.className = 'mesh-rigid-cursor-indicator is-hidden';
  indicator.innerHTML = '';
  indicator.style.transform = '';
  indicator.style.width = '';
  indicator.style.height = '';
}

function editableSideFromDisplay() {
  return displayMode === 'source' || displayMode === 'target' ? displayMode : null;
}

function isEditingDisabledByDisplay() {
  return !editableSideFromDisplay();
}

function shouldSuppressViewControls() {
  const paintModifierActive = interactionMode === 'paint' && (cursorState.alt || cursorState.shift);
  const landmarkModifierActive = interactionMode === 'landmark' && (cursorState.alt || cursorState.shift || cursorState.ctrlOrMeta);

  return !!(
    active &&
    app.controls &&
    cursorState.inViewport &&
    (painting || draggingLandmark || (!isEditingDisabledByDisplay() && (paintModifierActive || landmarkModifierActive)))
  );
}

function restoreViewControls() {
  if (!viewControlsSuppressed) return;
  if (suppressedControls) suppressedControls.enabled = viewControlsPreviousEnabled;
  viewControlsSuppressed = false;
  suppressedControls = null;
  viewControlsPreviousEnabled = true;
}

function updateViewControlsSuppression() {
  const controls = app.controls;
  const shouldSuppress = shouldSuppressViewControls();

  if (!shouldSuppress) {
    restoreViewControls();
    return;
  }

  if (suppressedControls && suppressedControls !== controls) {
    suppressedControls.enabled = viewControlsPreviousEnabled;
    viewControlsSuppressed = false;
    suppressedControls = null;
  }

  if (!viewControlsSuppressed) {
    suppressedControls = controls;
    viewControlsPreviousEnabled = controls.enabled !== false;
    viewControlsSuppressed = true;
  }

  controls.enabled = false;
}

function screenBrushRadius() {
  if (!app.camera || !cursorState.inViewport) return 28;

  const rect = getViewportRect();
  const target = app.controls?.target || new THREE.Vector3();
  const distance = app.camera.position.distanceTo(target) || 2;
  const fov = (app.camera.fov || 55) * Math.PI / 180;
  const worldHeight = 2 * Math.tan(fov / 2) * distance;
  return clamp((brushRadius / worldHeight) * rect.height, 6, 180);
}

function updateCursorIndicator() {
  const indicator = ensureCursorIndicator();
  updateViewControlsSuppression();

  if (!active || !cursorState.inViewport || isEditingDisabledByDisplay()) {
    hideCursorIndicator(indicator);
    setCanvasCursor('');
    return;
  }

  if (interactionMode === 'landmark') {
    const descriptor = landmarkCursorDescriptor({
      dragging: !!draggingLandmark,
      state: cursorState,
    });

    if (!descriptor) {
      hideCursorIndicator(indicator);
      setCanvasCursor('');
      return;
    }

    setCanvasCursor(descriptor.cursor);
    indicator.innerHTML = descriptor.html;
    indicator.className = `landmark-cursor-indicator ${descriptor.className}`;
    indicator.style.width = '';
    indicator.style.height = '';
    indicator.style.left = '0';
    indicator.style.top = '0';
    indicator.style.transform = `translate(${cursorState.x + 14}px, ${cursorState.y + 14}px)`;
    return;
  }

  if (interactionMode !== 'paint' || (!cursorState.alt && !cursorState.shift)) {
    hideCursorIndicator(indicator);
    setCanvasCursor('');
    return;
  }

  const radius = screenBrushRadius();
  const className = cursorState.shift
    ? 'mesh-rigid-cursor-indicator is-component'
    : 'mesh-rigid-cursor-indicator';

  setCanvasCursor('crosshair');
  indicator.innerHTML = '';
  indicator.className = className;
  indicator.style.transform = '';
  indicator.style.width = `${radius * 2}px`;
  indicator.style.height = `${radius * 2}px`;
  indicator.style.left = `${cursorState.x}px`;
  indicator.style.top = `${cursorState.y}px`;
}

function syncCursorFromEvent(event) {
  if (!event) return;

  const rect = getViewportRect();
  cursorState.clientX = event.clientX;
  cursorState.clientY = event.clientY;
  cursorState.x = event.clientX - rect.left;
  cursorState.y = event.clientY - rect.top;
  cursorState.hasPointerPosition = true;
  cursorState.inViewport = (
    cursorState.x >= 0 &&
    cursorState.y >= 0 &&
    cursorState.x <= rect.width &&
    cursorState.y <= rect.height
  );
  cursorState.alt = !!event.altKey;
  cursorState.shift = !!event.shiftKey;
  cursorState.ctrlOrMeta = !!(event.ctrlKey || event.metaKey);
  updateCursorIndicator();
}

function syncCursorModifiersFromKeyEvent(event) {
  if (!event) return;

  cursorState.alt = event.getModifierState ? event.getModifierState('Alt') : !!event.altKey;
  cursorState.shift = event.getModifierState ? event.getModifierState('Shift') : !!event.shiftKey;
  cursorState.ctrlOrMeta = event.getModifierState
    ? (event.getModifierState('Control') || event.getModifierState('Meta'))
    : !!(event.ctrlKey || event.metaKey);

  // Some browsers report modifier state inconsistently on the keyup event
  // for the released modifier itself. Force that key off so the landmark/paint
  // cursor toast disappears immediately when the modifier is released.
  if (event.type === 'keyup') {
    if (event.key === 'Alt') cursorState.alt = false;
    if (event.key === 'Shift') cursorState.shift = false;
    if (event.key === 'Control' || event.key === 'Meta') cursorState.ctrlOrMeta = false;
  } else if (event.type === 'keydown') {
    if (event.key === 'Alt') cursorState.alt = true;
    if (event.key === 'Shift') cursorState.shift = true;
    if (event.key === 'Control' || event.key === 'Meta') cursorState.ctrlOrMeta = true;
  }

  updateCursorIndicator();
}

function resetCursorIndicator({ remove = false } = {}) {
  cursorState.alt = false;
  cursorState.shift = false;
  cursorState.ctrlOrMeta = false;
  cursorState.inViewport = false;
  setCanvasCursor('');
  restoreViewControls();
  draggingLandmark = null;

  if (!cursorIndicatorEl) return;
  if (remove) {
    cursorIndicatorEl.remove();
    cursorIndicatorEl = null;
  } else {
    hideCursorIndicator(cursorIndicatorEl);
  }
}

function refreshPreviewAtCursor() {
  updateCursorIndicator();
}

// ── Landmarks ────────────────────────────────────────────────────

function nonEmptyLandmarkCount(side) {
  return getLandmarkList(side).filter(Boolean).length;
}

function compactLandmarks(landmarks) {
  return landmarks.filter(Boolean);
}

function trimTrailingEmptyLandmarks(landmarks) {
  // Keep the historical helper name for snapshots/import paths, but rigid-align
  // landmark lists are compact per side: deleting S1 makes the old S2 become S1.
  return compactLandmarks(landmarks);
}

function firstOpenLandmarkIndex(side) {
  return getLandmarkList(side).length;
}

function getWorldLandmark(side, index) {
  const root = getObjectForSide(side);
  const landmark = side === 'source' ? sourceLandmarks[index] : targetLandmarks[index];
  if (!root || !landmark?.local) return null;

  return root.localToWorld(landmark.local.clone());
}

function completeLandmarkPairs({ validate = false } = {}) {
  if (!sourceObject || !targetObject) return [];

  const sourceCount = nonEmptyLandmarkCount('source');
  const targetCount = nonEmptyLandmarkCount('target');

  if (validate && (sourceCount || targetCount) && sourceCount !== targetCount) {
    return [];
  }

  const count = Math.max(sourceLandmarks.length, targetLandmarks.length);
  const pairs = [];

  for (let i = 0; i < count; i++) {
    const source = getWorldLandmark('source', i);
    const target = getWorldLandmark('target', i);
    if (!source || !target) continue;

    pairs.push({
      source,
      target,
      index: i,
    });
  }

  if (validate && pairs.length !== sourceCount) return [];

  return pairs;
}

function landmarkPairsAreUsable({ requireMinimum = true } = {}) {
  const sourceCount = nonEmptyLandmarkCount('source');
  const targetCount = nonEmptyLandmarkCount('target');
  if (sourceCount !== targetCount) return false;
  if (requireMinimum && sourceCount < 3) return false;
  return completeLandmarkPairs({ validate: true }).length === sourceCount;
}

function effectiveLandmarkBlend({ requireMinimum = true } = {}) {
  if (!landmarkPairsAreUsable({ requireMinimum })) return 0;
  return clamp(Number(landmarkBlend) || 0, 0, 1);
}

function coerceLandmarkBlendForCurrentLandmarks() {
  if (!landmarkPairsAreUsable({ requireMinimum: true })) {
    landmarkBlend = 0;
  }
}

function getLandmarkList(side) {
  return side === 'source' ? sourceLandmarks : targetLandmarks;
}

function setLandmarkList(side, landmarks) {
  if (side === 'source') {
    sourceLandmarks = landmarks;
  } else {
    targetLandmarks = landmarks;
  }
}

function isLandmarkSelected(side, index) {
  return selectedLandmarkSide === side && selectedLandmarkIndex === index;
}

function setSelectedLandmark(side, index, { toggle = true } = {}) {
  if (!getLandmarkList(side)[index]) {
    selectedLandmarkSide = null;
    selectedLandmarkIndex = -1;
  } else if (toggle && isLandmarkSelected(side, index)) {
    selectedLandmarkSide = null;
    selectedLandmarkIndex = -1;
  } else {
    selectedLandmarkSide = side;
    selectedLandmarkIndex = index;
  }

  rebuildLandmarkMarkers();
  renderLandmarkList();
}

function replaceLandmarkLocal(side, index, local) {
  const root = getObjectForSide(side);
  const landmarks = getLandmarkList(side).slice();
  const previous = landmarks[index];

  if (!root || !local || !previous) return false;

  landmarks[index] = {
    id: previous.id,
    local: local.clone(),
  };

  setLandmarkList(side, trimTrailingEmptyLandmarks(landmarks));
  return true;
}

function updateLandmarkFromEvent(side, index, event) {
  const root = getObjectForSide(side);
  const hitInfo = hitFromEvent(event, side);
  if (!hitInfo?.hit || !root || !getLandmarkList(side)[index]) return false;

  return replaceLandmarkLocal(side, index, root.worldToLocal(hitInfo.hit.point.clone()));
}

function beginLandmarkDrag(event, side, index) {
  if (!getLandmarkList(side)[index]) return false;

  draggingLandmark = {
    side,
    index,
    pointerId: event.pointerId,
    before: makeSnapshot(),
    changed: false,
  };

  setSelectedLandmark(side, index, { toggle: false });
  return true;
}

function updateLandmarkDrag(event) {
  if (!draggingLandmark || draggingLandmark.pointerId !== event.pointerId) return;

  preventTaskEvent(event);

  const changed = updateLandmarkFromEvent(
    draggingLandmark.side,
    draggingLandmark.index,
    event
  );

  if (!changed) return;

  draggingLandmark.changed = true;
  rebuildLandmarkMarkers();
  renderLandmarkList();
}

function finishLandmarkDrag(event) {
  if (!draggingLandmark || draggingLandmark.pointerId !== event.pointerId) return;

  preventTaskEvent(event);

  const before = draggingLandmark.before;
  const changed = draggingLandmark.changed;
  draggingLandmark = null;

  if (changed && snapshotKey(before) !== snapshotKey(makeSnapshot())) {
    pushUndoSnapshot(before);
    updateStackButtons();
  }

  updatePanelStats();
}

function swapLandmarks(side, a, b) {
  const landmarks = getLandmarkList(side);
  if (a < 0 || b < 0 || a === b || !landmarks[a] || !landmarks[b]) return false;

  return commit(`swap ${side} landmarks`, () => {
    const next = landmarks.slice();
    [next[a], next[b]] = [next[b], next[a]];
    setLandmarkList(side, trimTrailingEmptyLandmarks(next));
    selectedLandmarkSide = null;
    selectedLandmarkIndex = -1;
    rebuildLandmarkMarkers();
  });
}

function scaleLandmarkVisuals(factor) {
  landmarkScale = clamp(landmarkScale * factor, 0.25, 6);
  labelScale = clamp(labelScale * factor, 0.25, 6);
  rebuildLandmarkMarkers();
}

function placeLandmarkFromEvent(side, event, index = null) {
  const root = getObjectForSide(side);
  const hitInfo = hitFromEvent(event, side);
  if (!hitInfo?.hit || !root) return false;

  const nextIndex = Number.isInteger(index) ? index : firstOpenLandmarkIndex(side);

  return commit(`place ${side} landmark`, () => {
    const landmarks = getLandmarkList(side).slice();
    landmarks[nextIndex] = {
      id: nextLandmarkId++,
      local: root.worldToLocal(hitInfo.hit.point.clone()),
    };
    setLandmarkList(side, trimTrailingEmptyLandmarks(landmarks));
    selectedLandmarkSide = side;
    selectedLandmarkIndex = nextIndex;
    rebuildLandmarkMarkers();
  });
}

function projectWorldToScreen(point) {
  const rect = getViewportRect();
  const projected = point.clone().project(app.camera);
  if (projected.z < -1 || projected.z > 1) return null;

  return {
    x: rect.left + (projected.x + 1) * rect.width * 0.5,
    y: rect.top + (-projected.y + 1) * rect.height * 0.5,
  };
}

function landmarkIndexFromEvent(side, event, radiusPx = 22) {
  let bestIndex = -1;
  let bestDistanceSq = radiusPx * radiusPx;

  getLandmarkList(side).forEach((landmark, index) => {
    if (!landmark) return;
    const world = getWorldLandmark(side, index);
    const screen = world ? projectWorldToScreen(world) : null;
    if (!screen) return;

    const dx = screen.x - event.clientX;
    const dy = screen.y - event.clientY;
    const distanceSq = dx * dx + dy * dy;

    if (distanceSq <= bestDistanceSq) {
      bestDistanceSq = distanceSq;
      bestIndex = index;
    }
  });

  return bestIndex;
}

function removeNearestLandmarkFromEvent(side, event) {
  const index = landmarkIndexFromEvent(side, event);
  if (index < 0) return false;
  return removeLandmark(side, index);
}

function removeLandmark(side, index) {
  if (!getLandmarkList(side)[index]) return false;

  return commit(`remove ${side} landmark`, () => {
    const landmarks = getLandmarkList(side).slice();
    landmarks.splice(index, 1);
    setLandmarkList(side, compactLandmarks(landmarks));

    if (selectedLandmarkSide === side) {
      if (selectedLandmarkIndex === index) {
        selectedLandmarkSide = null;
        selectedLandmarkIndex = -1;
      } else if (selectedLandmarkIndex > index) {
        selectedLandmarkIndex -= 1;
      }
    }

    rebuildLandmarkMarkers();
  });
}

function landmarkMarkerRadius() {
  const visibleObjects = [];
  if (isSideVisible('target')) visibleObjects.push(targetObject);
  if (isSideVisible('source')) visibleObjects.push(sourceObject);
  return landmarkMarkerRadiusForObjects(visibleObjects, landmarkScale);
}

function makeRigidLandmarkLabel(text, position, color, radius) {
  return makeLandmarkLabelSprite({
    text,
    position,
    color,
    radius,
    labelScale,
    depthTest: true,
    renderOrder: 10043,
  });
}

function makeLandmarkLine(a, b) {
  const geometry = new THREE.BufferGeometry().setFromPoints([a, b]);
  return new THREE.Line(
    geometry,
    new THREE.LineBasicMaterial({
      color: LANDMARK_COLORS.line,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.85,
      toneMapped: false,
    })
  );
}

function clearLandmarkMarkers() {
  if (!landmarkGroup) return;

  disposeObject3D(landmarkGroup);
  landmarkGroup.removeFromParent();
  landmarkGroup = null;
}

function rebuildLandmarkMarkers() {
  clearLandmarkMarkers();
  if (!active) return;

  const hasVisibleTarget = isSideVisible('target');
  const hasVisibleSource = isSideVisible('source');

  if (!hasVisibleTarget && !hasVisibleSource) return;

  const maxRows = Math.max(sourceLandmarks.length, targetLandmarks.length);
  if (!maxRows) return;

  const radius = landmarkMarkerRadius();
  landmarkGroup = new THREE.Group();
  landmarkGroup.name = 'rigid-align-landmarks';
  landmarkGroup.renderOrder = 10040;
  landmarkGroup.frustumCulled = false;
  app.scene.add(landmarkGroup);

  for (let index = 0; index < maxRows; index++) {
    const targetPoint = getWorldLandmark('target', index);
    const sourcePoint = getWorldLandmark('source', index);

    if (hasVisibleTarget && targetPoint) {
      const selected = isLandmarkSelected('target', index);
      const color = selected ? LANDMARK_COLORS.selected : LANDMARK_COLORS.default;
      const marker = makeLandmarkSphere({
        color,
        radius,
        selected,
        depthTest: true,
        renderOrder: 10042,
      });
      marker.position.copy(targetPoint);
      landmarkGroup.add(marker);
      landmarkGroup.add(makeRigidLandmarkLabel(`T${index + 1}`, targetPoint, color, radius));
    }

    if (hasVisibleSource && sourcePoint) {
      const selected = isLandmarkSelected('source', index);
      const color = selected ? LANDMARK_COLORS.selected : LANDMARK_COLORS.default;
      const marker = makeLandmarkSphere({
        color,
        radius,
        selected,
        depthTest: true,
        renderOrder: 10042,
      });
      marker.position.copy(sourcePoint);
      landmarkGroup.add(marker);
      landmarkGroup.add(makeRigidLandmarkLabel(`S${index + 1}`, sourcePoint, color, radius));
    }

    if (displayMode === 'both' && targetPoint && sourcePoint) {
      const line = makeLandmarkLine(sourcePoint, targetPoint);
      line.renderOrder = 10040;
      line.frustumCulled = false;
      landmarkGroup.add(line);
    }
  }
}

// ── Alignment core ────────────────────────────────────────────────

class PointKdNode {
  constructor(points, indices, depth = 0) {
    if (!indices.length) return;

    const axis = depth % 3;
    indices.sort((a, b) => points[a].getComponent(axis) - points[b].getComponent(axis));
    const mid = Math.floor(indices.length / 2);

    this.index = indices[mid];
    this.point = points[this.index];
    this.axis = axis;
    this.left = mid > 0 ? new PointKdNode(points, indices.slice(0, mid), depth + 1) : null;
    this.right = mid + 1 < indices.length ? new PointKdNode(points, indices.slice(mid + 1), depth + 1) : null;
  }

  nearest(query, best) {
    if (!this.point) return best;

    const distanceSq = query.distanceToSquared(this.point);
    if (distanceSq < best.distanceSq) best = { index: this.index, point: this.point, distanceSq };

    const delta = query.getComponent(this.axis) - this.point.getComponent(this.axis);
    const first = delta <= 0 ? this.left : this.right;
    const second = delta <= 0 ? this.right : this.left;

    if (first) best = first.nearest(query, best);
    if (second && delta * delta < best.distanceSq) best = second.nearest(query, best);

    return best;
  }

  nearestK(query, bestList, limit) {
    if (!this.point || limit <= 0) return bestList;

    const distanceSq = query.distanceToSquared(this.point);
    insertNearestCandidate(bestList, { index: this.index, point: this.point, distanceSq }, limit);

    const delta = query.getComponent(this.axis) - this.point.getComponent(this.axis);
    const first = delta <= 0 ? this.left : this.right;
    const second = delta <= 0 ? this.right : this.left;

    if (first) first.nearestK(query, bestList, limit);

    const worst = bestList.length < limit ? Infinity : bestList[bestList.length - 1].distanceSq;
    if (second && delta * delta < worst) second.nearestK(query, bestList, limit);

    return bestList;
  }
}

function insertNearestCandidate(bestList, candidate, limit) {
  let insertAt = bestList.findIndex(item => candidate.distanceSq < item.distanceSq);
  if (insertAt < 0) insertAt = bestList.length;
  if (insertAt >= limit) return;

  bestList.splice(insertAt, 0, candidate);
  if (bestList.length > limit) bestList.pop();
}

class PointKdTree {
  constructor(points) {
    this.points = points;
    this.root = points.length ? new PointKdNode(points, points.map((_, index) => index)) : null;
  }

  nearest(query) {
    if (!this.root) return null;
    return this.root.nearest(query, { index: -1, point: null, distanceSq: Infinity });
  }

  nearestK(query, limit = 8) {
    if (!this.root) return [];
    return this.root.nearestK(query, [], Math.max(1, Math.floor(limit)));
  }
}

function sampleArray(items, limit) {
  if (!Number.isFinite(limit) || limit <= 0 || items.length <= limit) return items.slice();

  const step = items.length / limit;
  const sampled = [];
  for (let i = 0; i < limit; i++) sampled.push(items[Math.floor(i * step)]);
  return sampled;
}

function collectIncludedWorldPoints(side, limit = Infinity) {
  const points = [];
  const world = new THREE.Vector3();

  getMeshesForSide(side).forEach(mesh => {
    const position = getCanonicalPositionAttribute(mesh);
    const selection = getSelection(mesh, side);
    if (!position || !selection) return;

    mesh.updateMatrixWorld(true);
    for (let i = 0; i < position.count; i++) {
      if (!selection[i]) continue;
      points.push(world.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld).clone());
    }
  });

  return sampleArray(points, limit);
}



function makeSurfaceDistanceSampler(side) {
  const entry = getSideDistanceBvh(side);
  if (!entry?.root) return null;

  entry.root.updateMatrixWorld(true);
  entry.matrixWorld.copy(entry.root.matrixWorld);
  entry.matrixWorldInverse.copy(entry.root.matrixWorld).invert();
  return entry;
}

function nearestSurfaceDistanceSq(pointWorld, sampler, maxDistance = Infinity) {
  if (!sampler?.bvh) return Infinity;

  sampler.queryLocal.copy(pointWorld).applyMatrix4(sampler.matrixWorldInverse);

  const maxThreshold = Number.isFinite(maxDistance) && maxDistance > 0
    ? maxDistance
    : Infinity;

  const result = sampler.bvh.closestPointToPoint(
    sampler.queryLocal,
    sampler.closestLocal,
    0,
    maxThreshold
  );

  if (!result?.point) return Infinity;

  sampler.closestWorld.copy(result.point).applyMatrix4(sampler.matrixWorld);
  return pointWorld.distanceToSquared(sampler.closestWorld);
}

function heatmapColorInto(t, target) {
  const x = clamp(t, 0, 1);

  for (let i = 1; i < HEATMAP_COLORS.length; i++) {
    if (x > HEATMAP_COLORS[i].at) continue;
    const prev = HEATMAP_COLORS[i - 1];
    const next = HEATMAP_COLORS[i];
    const local = (x - prev.at) / Math.max(1e-8, next.at - prev.at);
    return target.copy(prev.color).lerp(next.color, local);
  }

  return target.copy(HEATMAP_COLORS[HEATMAP_COLORS.length - 1].color);
}

function meshSupportsFastFaceHeatmap(mesh) {
  const position = mesh.geometry?.attributes?.position;
  return !!position && !mesh.geometry.index && position.count >= 3;
}

function heatmapSampleStride(count) {
  return Math.max(1, Math.ceil(count / HEATMAP_SAMPLE_LIMIT));
}

function computeNonIndexedFaceDistanceField(mesh, sampler, distanceSamples) {
  const position = mesh.geometry?.attributes?.position;

  if (!position || !sampler) return new Float32Array(0);

  const triangleCount = Math.floor(position.count / 3);
  const distances = new Float32Array(triangleCount);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const center = new THREE.Vector3();
  const sampleStride = heatmapSampleStride(triangleCount);

  mesh.updateMatrixWorld(true);

  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex++) {
    const vertexIndex = triangleIndex * 3;
    a.fromBufferAttribute(position, vertexIndex).applyMatrix4(mesh.matrixWorld);
    b.fromBufferAttribute(position, vertexIndex + 1).applyMatrix4(mesh.matrixWorld);
    c.fromBufferAttribute(position, vertexIndex + 2).applyMatrix4(mesh.matrixWorld);
    center.copy(a).add(b).add(c).multiplyScalar(1 / 3);

    const distanceSq = nearestSurfaceDistanceSq(center, sampler);
    const distance = Number.isFinite(distanceSq) ? Math.sqrt(distanceSq) : Infinity;
    distances[triangleIndex] = distance;

    if (Number.isFinite(distance) && triangleIndex % sampleStride === 0) {
      distanceSamples.push(distance);
    }
  }

  return distances;
}

function computeVertexDistanceField(mesh, sampler, distanceSamples) {
  const position = mesh.geometry?.attributes?.position;

  if (!position || !sampler) return new Float32Array(0);

  const distances = new Float32Array(position.count);
  const worldPoint = new THREE.Vector3();
  const sampleStride = heatmapSampleStride(position.count);

  mesh.updateMatrixWorld(true);

  for (let i = 0; i < position.count; i++) {
    worldPoint.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
    const distanceSq = nearestSurfaceDistanceSq(worldPoint, sampler);
    const distance = Number.isFinite(distanceSq) ? Math.sqrt(distanceSq) : Infinity;
    distances[i] = distance;

    if (Number.isFinite(distance) && i % sampleStride === 0) {
      distanceSamples.push(distance);
    }
  }

  return distances;
}

function computeMeshDistanceField(mesh, sampler, distanceSamples) {
  if (meshSupportsFastFaceHeatmap(mesh)) {
    return {
      mode: 'face',
      distances: computeNonIndexedFaceDistanceField(mesh, sampler, distanceSamples),
    };
  }

  return {
    mode: 'vertex',
    distances: computeVertexDistanceField(mesh, sampler, distanceSamples),
  };
}

function heatmapMatrixKey(root) {
  if (!root) return 'none';

  root.updateMatrixWorld(true);
  return root.matrixWorld.elements
    .map(value => Number(value).toPrecision(12))
    .join(',');
}

function heatmapFieldCacheKey(side) {
  const otherSide = side === 'source' ? 'target' : 'source';
  const sideRoot = getObjectForSide(side);
  const otherRoot = getObjectForSide(otherSide);

  return [
    side,
    sideRoot?.uuid || 'none',
    otherRoot?.uuid || 'none',
    heatmapMatrixKey(sideRoot),
    heatmapMatrixKey(otherRoot),
  ].join('|');
}

function distanceFieldEntriesForSide(side, sampler, distanceSamples) {
  const key = heatmapFieldCacheKey(side);
  const cached = heatmapFieldCache[side];

  if (cached?.key === key) {
    distanceSamples.push(...cached.samples);
    return cached.entries;
  }

  const samples = [];
  const entries = getMeshesForSide(side).map(mesh => ({
    side,
    mesh,
    field: computeMeshDistanceField(mesh, sampler, samples),
  }));

  heatmapFieldCache[side] = { key, entries, samples };
  distanceSamples.push(...samples);
  return entries;
}

function colorMeshFromDistanceField(mesh, field, maxDistance) {
  const position = mesh.geometry?.attributes?.position;
  const colorAttribute = ensureColorAttribute(mesh);
  const distances = field?.distances || new Float32Array(0);

  if (!position || !colorAttribute || !distances.length) return 0;

  if (field.mode === 'face') {
    const triangleCount = Math.min(distances.length, Math.floor(position.count / 3));
    for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex++) {
      const distance = distances[triangleIndex];
      const value = Number.isFinite(distance) ? distance / maxDistance : 1;
      const color = heatmapColorInto(value, heatmapColorTemp);
      const vertexIndex = triangleIndex * 3;
      setVertexColor(colorAttribute, vertexIndex, color);
      setVertexColor(colorAttribute, vertexIndex + 1, color);
      setVertexColor(colorAttribute, vertexIndex + 2, color);
    }
  } else {
    for (let index = 0; index < distances.length; index++) {
      const distance = distances[index];
      const value = Number.isFinite(distance) ? distance / maxDistance : 1;
      setVertexColor(colorAttribute, index, heatmapColorInto(value, heatmapColorTemp));
    }
  }

  colorAttribute.needsUpdate = true;
  getMaterialList(mesh.material).forEach(material => {
    if (!material) return;
    material.vertexColors = true;
    material.needsUpdate = true;
  });
  return position.count;
}

function sidesNeedingHeatmapColors() {
  return ['source', 'target'].filter(side => isSideVisible(side));
}

function applyDistanceHeatmapColors() {
  if (!distanceHeatmap || !sourceObject || !targetObject) return false;

  const sidesToColor = sidesNeedingHeatmapColors();
  const sourceSampler = sidesToColor.includes('target') ? makeSurfaceDistanceSampler('source') : null;
  const targetSampler = sidesToColor.includes('source') ? makeSurfaceDistanceSampler('target') : null;
  const samplerBySide = {
    source: targetSampler,
    target: sourceSampler,
  };

  if (sidesToColor.some(side => !samplerBySide[side])) return false;

  const byMesh = [];
  const distanceSamples = [];

  sidesToColor.forEach(side => {
    byMesh.push(...distanceFieldEntriesForSide(side, samplerBySide[side], distanceSamples));
  });

  if (!distanceSamples.length) return false;

  distanceSamples.sort((a, b) => a - b);
  const qIndex = Math.min(distanceSamples.length - 1, Math.floor(distanceSamples.length * HEATMAP_DISTANCE_PERCENTILE));
  const q = distanceSamples[qIndex];
  const maxDistance = Math.max(q, distanceSamples[distanceSamples.length - 1] * 0.05, 1e-8);

  byMesh.forEach(({ mesh, field }) => {
    colorMeshFromDistanceField(mesh, field, maxDistance);
  });

  return true;
}

function determinant3(m) {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  );
}

function inverseTranspose3(m) {
  const det = determinant3(m);
  if (Math.abs(det) <= 1e-14) return null;

  const invDet = 1 / det;

  // Return inverse(m)^T directly.
  return [
    [
      (m[1][1] * m[2][2] - m[1][2] * m[2][1]) * invDet,
      (m[1][2] * m[2][0] - m[1][0] * m[2][2]) * invDet,
      (m[1][0] * m[2][1] - m[1][1] * m[2][0]) * invDet,
    ],
    [
      (m[0][2] * m[2][1] - m[0][1] * m[2][2]) * invDet,
      (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * invDet,
      (m[0][1] * m[2][0] - m[0][0] * m[2][1]) * invDet,
    ],
    [
      (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * invDet,
      (m[0][2] * m[1][0] - m[0][0] * m[1][2]) * invDet,
      (m[0][0] * m[1][1] - m[0][1] * m[1][0]) * invDet,
    ],
  ];
}

function polarOrthogonalFactor3(matrix) {
  let maxAbs = 0;

  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      maxAbs = Math.max(maxAbs, Math.abs(matrix[row][col]));
    }
  }

  if (maxAbs <= 1e-14) return null;

  let current = matrix.map(row => row.map(value => value / maxAbs));

  for (let iter = 0; iter < 30; iter++) {
    const invT = inverseTranspose3(current);
    if (!invT) return null;

    let delta = 0;
    const next = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];

    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        next[row][col] = 0.5 * (current[row][col] + invT[row][col]);
        delta = Math.max(delta, Math.abs(next[row][col] - current[row][col]));
      }
    }

    current = next;
    if (delta < 1e-10) break;
  }

  return current;
}

function matrix4FromLinearAndTranslation(linear, translation) {
  const matrix = new THREE.Matrix4();

  matrix.set(
    linear[0][0], linear[0][1], linear[0][2], translation.x,
    linear[1][0], linear[1][1], linear[1][2], translation.y,
    linear[2][0], linear[2][1], linear[2][2], translation.z,
    0, 0, 0, 1
  );

  return matrix;
}

function applyLinear3ToVector(linear, vector) {
  return new THREE.Vector3(
    linear[0][0] * vector.x + linear[0][1] * vector.y + linear[0][2] * vector.z,
    linear[1][0] * vector.x + linear[1][1] * vector.y + linear[1][2] * vector.z,
    linear[2][0] * vector.x + linear[2][1] * vector.y + linear[2][2] * vector.z
  );
}

function solveOrthogonalTransform(sourcePoints, targetPoints, weights = null) {
  const count = Math.min(sourcePoints.length, targetPoints.length);
  if (count < 3) return null;

  const sourceCentroid = new THREE.Vector3();
  const targetCentroid = new THREE.Vector3();
  let weightSum = 0;

  for (let i = 0; i < count; i++) {
    const weight = Math.max(0, weights?.[i] ?? 1);
    if (weight <= 0) continue;
    sourceCentroid.addScaledVector(sourcePoints[i], weight);
    targetCentroid.addScaledVector(targetPoints[i], weight);
    weightSum += weight;
  }

  if (weightSum <= Number.EPSILON) return null;

  sourceCentroid.multiplyScalar(1 / weightSum);
  targetCentroid.multiplyScalar(1 / weightSum);

  const h = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];

  for (let i = 0; i < count; i++) {
    const weight = Math.max(0, weights?.[i] ?? 1);
    if (weight <= 0) continue;

    const p = sourcePoints[i].clone().sub(sourceCentroid);
    const q = targetPoints[i].clone().sub(targetCentroid);

    h[0][0] += weight * q.x * p.x;
    h[0][1] += weight * q.x * p.y;
    h[0][2] += weight * q.x * p.z;
    h[1][0] += weight * q.y * p.x;
    h[1][1] += weight * q.y * p.y;
    h[1][2] += weight * q.y * p.z;
    h[2][0] += weight * q.z * p.x;
    h[2][1] += weight * q.z * p.y;
    h[2][2] += weight * q.z * p.z;
  }

  const orthogonal = polarOrthogonalFactor3(h);
  if (!orthogonal) return null;

  const transformedSourceCentroid = applyLinear3ToVector(orthogonal, sourceCentroid);
  const translation = targetCentroid.clone().sub(transformedSourceCentroid);

  return matrix4FromLinearAndTranslation(orthogonal, translation);
}

function dominantEigenVector4(matrix) {
  let vector = [1, 0, 0, 0];

  for (let iter = 0; iter < 32; iter++) {
    const next = [0, 0, 0, 0];

    for (let row = 0; row < 4; row++) {
      next[row] =
        matrix[row][0] * vector[0] +
        matrix[row][1] * vector[1] +
        matrix[row][2] * vector[2] +
        matrix[row][3] * vector[3];
    }

    const length = Math.hypot(next[0], next[1], next[2], next[3]) || 1;
    vector = next.map(value => value / length);
  }

  return vector;
}

function matrix3FromMatrix4(matrix) {
  const e = matrix.elements;
  return [
    [e[0], e[4], e[8]],
    [e[1], e[5], e[9]],
    [e[2], e[6], e[10]],
  ];
}

function identityLinear3() {
  return [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
}

function scaledLinear3(linear, scale) {
  return linear.map(row => row.map(value => value * scale));
}

function solveRigidTransform(
  sourcePoints,
  targetPoints,
  weights = null,
  {
    allowReflection = false,
    allowScale = false,
    allowRotation = true,
    allowTranslation = true,
  } = {}
) {
  const count = Math.min(sourcePoints.length, targetPoints.length);
  if (count < 3) return null;

  const sourceCentroid = new THREE.Vector3();
  const targetCentroid = new THREE.Vector3();
  let weightSum = 0;

  for (let i = 0; i < count; i++) {
    const weight = Math.max(0, weights?.[i] ?? 1);
    if (weight <= 0) continue;
    sourceCentroid.addScaledVector(sourcePoints[i], weight);
    targetCentroid.addScaledVector(targetPoints[i], weight);
    weightSum += weight;
  }

  if (weightSum <= Number.EPSILON) return null;

  sourceCentroid.multiplyScalar(1 / weightSum);
  targetCentroid.multiplyScalar(1 / weightSum);

  let linear = identityLinear3();

  if (allowRotation) {
    if (allowReflection) {
      const reflected = solveOrthogonalTransform(sourcePoints, targetPoints, weights);
      if (reflected) {
        linear = matrix3FromMatrix4(reflected);
      }
    } else {
      let sxx = 0, sxy = 0, sxz = 0;
      let syx = 0, syy = 0, syz = 0;
      let szx = 0, szy = 0, szz = 0;

      for (let i = 0; i < count; i++) {
        const weight = Math.max(0, weights?.[i] ?? 1);
        if (weight <= 0) continue;

        const p = sourcePoints[i].clone().sub(sourceCentroid);
        const q = targetPoints[i].clone().sub(targetCentroid);

        sxx += weight * p.x * q.x;
        sxy += weight * p.x * q.y;
        sxz += weight * p.x * q.z;
        syx += weight * p.y * q.x;
        syy += weight * p.y * q.y;
        syz += weight * p.y * q.z;
        szx += weight * p.z * q.x;
        szy += weight * p.z * q.y;
        szz += weight * p.z * q.z;
      }

      const trace = sxx + syy + szz;
      const n = [
        [trace, syz - szy, szx - sxz, sxy - syx],
        [syz - szy, sxx - syy - szz, sxy + syx, szx + sxz],
        [szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy],
        [sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz],
      ];

      const q = dominantEigenVector4(n);
      const rotation = new THREE.Quaternion(q[1], q[2], q[3], q[0]).normalize();
      const rotationMatrix = new THREE.Matrix4().makeRotationFromQuaternion(rotation);
      linear = matrix3FromMatrix4(rotationMatrix);
    }
  }

  let scale = 1;

  if (allowScale) {
    let numerator = 0;
    let denominator = 0;

    for (let i = 0; i < count; i++) {
      const weight = Math.max(0, weights?.[i] ?? 1);
      if (weight <= 0) continue;

      const p = sourcePoints[i].clone().sub(sourceCentroid);
      const q = targetPoints[i].clone().sub(targetCentroid);
      const rp = applyLinear3ToVector(linear, p);

      numerator += weight * rp.dot(q);
      denominator += weight * p.lengthSq();
    }

    if (denominator > Number.EPSILON) {
      scale = numerator / denominator;
      if (!allowReflection) scale = Math.max(1e-8, scale);
      if (!Number.isFinite(scale) || Math.abs(scale) <= 1e-8) scale = 1;
    }
  }

  const scaledLinear = scaledLinear3(linear, scale);
  const transformedSourceCentroid = applyLinear3ToVector(scaledLinear, sourceCentroid);
  const translation = allowTranslation
    ? targetCentroid.clone().sub(transformedSourceCentroid)
    : new THREE.Vector3();

  return matrix4FromLinearAndTranslation(scaledLinear, translation);
}

function pairRms(sourcePoints, targetPoints, transform = null) {
  const count = Math.min(sourcePoints.length, targetPoints.length);
  if (!count) return Infinity;

  let total = 0;
  const point = new THREE.Vector3();

  for (let i = 0; i < count; i++) {
    point.copy(sourcePoints[i]);
    if (transform) point.applyMatrix4(transform);
    total += point.distanceToSquared(targetPoints[i]);
  }

  return Math.sqrt(total / count);
}

function initialLandmarkAlignment(pairs, transformOptions = {}) {
  if (pairs.length < 3) return false;

  const sourcePoints = pairs.map(pair => pair.source);
  const targetPoints = pairs.map(pair => pair.target);
  const transform = solveRigidTransform(sourcePoints, targetPoints, null, transformOptions);
  if (!transform) return false;

  applyDeltaToSource(transform);
  return true;
}

function validateLandmarkAlignmentPairs() {
  const sourceLandmarkCount = nonEmptyLandmarkCount('source');
  const targetLandmarkCount = nonEmptyLandmarkCount('target');

  if (sourceLandmarkCount !== targetLandmarkCount) {
    throw new Error(`Landmark alignment requires the same number of source and target landmarks (${sourceLandmarkCount} source / ${targetLandmarkCount} target).`);
  }

  if (sourceLandmarkCount < 3) {
    throw new Error('Landmark-only rigid alignment needs at least 3 source/target landmark pairs.');
  }

  const pairs = completeLandmarkPairs({ validate: true });

  if (pairs.length !== sourceLandmarkCount) {
    throw new Error('Landmark alignment requires complete source/target landmarks at matching row indices. Fill or remove incomplete rows before aligning.');
  }

  return pairs;
}

function runLandmarkOnlyAlignment(transformOptions = {}) {
  if (!sourceObject || !targetObject) {
    throw new Error('Load both a source mesh and a target mesh before alignment.');
  }

  const pairs = validateLandmarkAlignmentPairs();
  const sourcePoints = pairs.map(pair => pair.source);
  const targetPoints = pairs.map(pair => pair.target);
  const transform = solveRigidTransform(sourcePoints, targetPoints, null, transformOptions);

  if (!transform) {
    throw new Error('Could not solve a stable landmark-only rigid transform. Check that the landmark pairs are not degenerate.');
  }

  const rms = pairRms(sourcePoints, targetPoints, transform);
  applyDeltaToSource(transform);
  rebuildLandmarkMarkers();

  return {
    mode: 'landmarks',
    iterations: 0,
    pairsUsed: pairs.length,
    targetPoints: 0,
    sourcePoints: 0,
    landmarks: pairs.length,
    mirroring: !!transformOptions.allowReflection,
    allowScale: !!transformOptions.allowScale,
    allowRotation: transformOptions.allowRotation !== false,
    allowTranslation: transformOptions.allowTranslation !== false,
    rms,
    matrix: matrixArray(sourceObject),
  };
}

function transformOptionsFromValues({ allowReflection = allowMirroring } = {}) {
  return {
    allowReflection,
    allowScale: !!alignAllowScale,
    allowRotation: alignAllowRotation !== false,
    allowTranslation: alignAllowTranslation !== false,
  };
}

function normalizePairGroupWeights(icpCount, landmarkCount, blend) {
  const landmarkShare = clamp(Number(blend) || 0, 0, 1);
  const icpShare = 1 - landmarkShare;
  const icpWeight = icpCount > 0 ? icpShare / icpCount : 0;
  const landmarkWeight = landmarkCount > 0 ? landmarkShare / landmarkCount : 0;

  return { icpWeight, landmarkWeight };
}

function runIcpAlignment(options = {}) {
  if (!sourceObject || !targetObject) {
    throw new Error('Load both a source mesh and a target mesh before alignment.');
  }

  const transformOptions = transformOptionsFromValues({ allowReflection: !!options.allowReflection });
  const blend = effectiveLandmarkBlend({ requireMinimum: true });

  if (blend >= 0.999) {
    return {
      ...runLandmarkOnlyAlignment(transformOptions),
      landmarkBlend: 1,
    };
  }

  const iterations = clamp(Math.floor(options.iterations || 25), 1, MAX_ICP_ITERATIONS);
  const sampleLimit = clamp(Math.floor(options.sampleLimit || DEFAULT_SAMPLE_LIMIT), 50, 50000);
  const targetLimit = clamp(Math.floor(options.targetLimit || DEFAULT_TARGET_LIMIT), 100, 100000);
  const outlierRatio = clamp(Number(options.outlierRatio ?? 0.1), 0, 0.95);
  const keepRatio = 1 - outlierRatio;
  let landmarkWarmStart = false;
  let landmarkCountUsed = 0;

  if (blend > 0) {
    const warmStartPairs = completeLandmarkPairs({ validate: true });
    landmarkCountUsed = warmStartPairs.length;

    // Robustness: ICP nearest-neighbor matches are only meaningful once the
    // source is in the target basin. Seed with the landmark Kabsch/similarity
    // solution, then let the blended ICP objective refine it.
    landmarkWarmStart = initialLandmarkAlignment(warmStartPairs, transformOptions);
    if (landmarkWarmStart) rebuildLandmarkMarkers();
  }

  const targetPoints = collectIncludedWorldPoints('target', targetLimit);
  if (targetPoints.length < 3) throw new Error('Target alignment region needs at least 3 included vertices.');

  let finalRms = Infinity;
  let pairsUsed = 0;
  let icpPairsUsed = 0;
  const kdTree = new PointKdTree(targetPoints);

  for (let iter = 0; iter < iterations; iter++) {
    const sourcePoints = collectIncludedWorldPoints('source', sampleLimit);
    if (sourcePoints.length < 3) throw new Error('Source alignment region needs at least 3 included vertices.');

    const candidates = [];
    sourcePoints.forEach(source => {
      const nearest = kdTree.nearest(source);
      if (nearest?.point) {
        candidates.push({
          source,
          target: nearest.point,
          distanceSq: nearest.distanceSq,
          kind: 'icp',
        });
      }
    });

    if (candidates.length < 3) throw new Error('ICP could not find enough nearest-neighbor pairs.');

    candidates.sort((a, b) => a.distanceSq - b.distanceSq);
    const keepCount = Math.max(3, Math.floor(candidates.length * keepRatio));
    const keptIcp = candidates.slice(0, keepCount);
    const kept = keptIcp.slice();
    const landmarkPairs = blend > 0 ? completeLandmarkPairs({ validate: true }) : [];
    landmarkCountUsed = landmarkPairs.length;

    landmarkPairs.forEach(pair => kept.push({
      source: pair.source,
      target: pair.target,
      distanceSq: pair.source.distanceToSquared(pair.target),
      kind: 'landmark',
    }));

    const { icpWeight, landmarkWeight } = normalizePairGroupWeights(
      keptIcp.length,
      landmarkPairs.length,
      blend
    );

    const fitSource = kept.map(pair => pair.source);
    const fitTarget = kept.map(pair => pair.target);
    const weights = kept.map(pair => (pair.kind === 'landmark' ? landmarkWeight : icpWeight));
    const delta = solveRigidTransform(fitSource, fitTarget, weights, transformOptions);
    if (!delta) break;

    applyDeltaToSource(delta);
    rebuildLandmarkMarkers();
    finalRms = pairRms(fitSource, fitTarget, delta);
    pairsUsed = kept.length;
    icpPairsUsed = keptIcp.length;

    if (finalRms < 1e-7) break;
  }

  return {
    mode: blend > 0 ? 'icp+landmarks' : 'icp',
    iterations,
    pairsUsed,
    icpPairsUsed,
    targetPoints: targetPoints.length,
    sourcePoints: collectIncludedWorldPoints('source', sampleLimit).length,
    landmarks: landmarkCountUsed,
    landmarkBlend: blend,
    landmarkWarmStart,
    mirroring: !!transformOptions.allowReflection,
    allowScale: !!transformOptions.allowScale,
    allowRotation: transformOptions.allowRotation !== false,
    allowTranslation: transformOptions.allowTranslation !== false,
    outlierRatio,
    rms: finalRms,
    matrix: matrixArray(sourceObject),
  };
}

function alignSource() {
  const iterationsInput = document.getElementById('mesh-rigid-iterations');
  const samplesInput = document.getElementById('mesh-rigid-samples');
  const outlierInput = document.getElementById('mesh-rigid-outliers');
  const allowMirrorInput = document.getElementById('mesh-rigid-allow-mirror');

  try {
    syncAlignmentOptionsFromPanel();

    commit('rigid align', () => {
      lastResult = runIcpAlignment({
        iterations: Number(iterationsInput?.value) || 25,
        sampleLimit: Number(samplesInput?.value) || DEFAULT_SAMPLE_LIMIT,
        targetLimit: Math.max(DEFAULT_TARGET_LIMIT, Number(samplesInput?.value) * 3 || DEFAULT_TARGET_LIMIT),
        outlierRatio: (Number(outlierInput?.value) || 10) / 100,
        allowReflection: allowMirrorInput?.checked === true,
      });
      allowMirroring = allowMirrorInput?.checked === true;
      updateAllColors();
      setDisplayMode('both');
    });
  } catch (error) {
    console.error('Rigid alignment failed:', error);
    alert(error?.message || 'Rigid alignment failed.');
  }

  rebuildLandmarkMarkers();
  renderAlignmentResult();
}


// ── Import / export ───────────────────────────────────────────────

function readJSONFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      try {
        resolve(JSON.parse(String(reader.result || '')));
      } catch (error) {
        reject(error);
      }
    };

    reader.onerror = () => reject(new Error(`Failed to read ${file?.name || 'JSON file'}.`));
    reader.readAsText(file);
  });
}

function parseMaskIndexList(value, vertexCount) {
  if (!Array.isArray(value)) return { selected: new Set(), skipped: 0, valid: false };

  const selected = new Set();
  let skipped = 0;

  value.forEach(raw => {
    const index = Number(raw);
    if (!Number.isInteger(index) || index < 0 || index >= vertexCount) {
      skipped += 1;
      return;
    }
    selected.add(index);
  });

  return { selected, skipped, valid: true };
}

function getTriangleCount(mesh) {
  const position = mesh?.geometry?.attributes?.position;
  if (!position) return 0;

  return mesh.geometry.index
    ? Math.floor(mesh.geometry.index.count / 3)
    : Math.floor(position.count / 3);
}

function findSideMeshForMaskEntry(side, entry, entryIndex) {
  const meshes = getMeshesForSide(side);
  if (!entry) return meshes.length === 1 ? meshes[0] : null;

  if (entry.meshUuid) {
    const byUuid = meshes.find(mesh => mesh.uuid === entry.meshUuid);
    if (byUuid) return byUuid;
  }

  if (entry.meshName) {
    const byName = meshes.find(mesh => getMeshLabel(mesh) === entry.meshName || mesh.parent?.name === entry.meshName);
    if (byName) return byName;
  }

  const explicitIndex = Number(entry.meshIndex);
  if (Number.isInteger(explicitIndex) && meshes[explicitIndex]) return meshes[explicitIndex];

  return meshes[entryIndex] || (meshes.length === 1 ? meshes[0] : null);
}

function addMaskEntryToSelection(side, entry, entryIndex, selectionByMesh) {
  const mesh = findSideMeshForMaskEntry(side, entry, entryIndex);
  const vertexCount = mesh?.geometry?.attributes?.position?.count || 0;
  const source = entry?.selectedVertexIndices || entry?.selectedVertices;

  if (!mesh || !vertexCount || !Array.isArray(source)) {
    return { matched: false, skipped: Array.isArray(source) ? source.length : 0 };
  }

  const parsed = parseMaskIndexList(source, vertexCount);
  if (!parsed.valid) return { matched: false, skipped: 0 };

  let selected = selectionByMesh.get(mesh);
  if (!selected) {
    selected = new Set();
    selectionByMesh.set(mesh, selected);
  }

  parsed.selected.forEach(index => selected.add(index));
  return { matched: true, skipped: parsed.skipped };
}

function parseMaskPayloadForSide(payload, side) {
  const meshes = getMeshesForSide(side);
  if (!meshes.length) throw new Error(`Load a ${side} mesh before importing a mask.`);

  const selectionByMesh = new Map();
  let skipped = 0;

  if (Array.isArray(payload)) {
    if (meshes.length !== 1) throw new Error('A bare vertex-index array can only be imported for a single-mesh side.');
    const parsed = parseMaskIndexList(payload, getCanonicalVertexCount(meshes[0]));
    selectionByMesh.set(meshes[0], parsed.selected);
    skipped += parsed.skipped;
  } else if (!payload?.mask && (Array.isArray(payload?.selectedVertexIndices) || Array.isArray(payload?.selectedVertices))) {
    if (meshes.length !== 1) throw new Error('A single selectedVertexIndices list can only be imported for a single-mesh side.');
    const source = payload.selectedVertexIndices || payload.selectedVertices;
    const parsed = parseMaskIndexList(source, getCanonicalVertexCount(meshes[0]));
    selectionByMesh.set(meshes[0], parsed.selected);
    skipped += parsed.skipped;
  } else if (payload?.mask && Array.isArray(payload.mask?.meshes)) {
    payload.mask.meshes.forEach((entry, index) => {
      const result = addMaskEntryToSelection(side, entry, index, selectionByMesh);
      skipped += result.skipped;
    });
  } else if (Array.isArray(payload?.masks)) {
    const activeIndex = clamp(Number(payload.activeMaskIndex) || 0, 0, Math.max(0, payload.masks.length - 1));
    const activeMask = payload.masks[activeIndex];

    if (Array.isArray(activeMask?.meshes)) {
      activeMask.meshes.forEach((entry, index) => {
        const result = addMaskEntryToSelection(side, entry, index, selectionByMesh);
        skipped += result.skipped;
      });
    } else {
      payload.masks.forEach((entry, index) => {
        const result = addMaskEntryToSelection(side, entry, index, selectionByMesh);
        skipped += result.skipped;
      });
    }
  } else {
    throw new Error('This JSON does not contain mesh mask data.');
  }

  if (!selectionByMesh.size) throw new Error(`No valid mask entries matched the ${side} mesh.`);
  return { selectionByMesh, skipped };
}

function applyMaskSelectionToSide(side, selectionByMesh) {
  resetSelection(side, 0);

  selectionByMesh.forEach((selected, mesh) => {
    const selection = getSelection(mesh, side);
    if (!selection) return;

    selected.forEach(index => {
      if (index >= 0 && index < selection.length) selection[index] = 1;
    });
    updateMeshColors(mesh, side);
  });
}

function maskExportPayloadForSide(side) {
  const meshes = getMeshesForSide(side);
  const perMesh = meshes.map((mesh, meshIndex) => {
    const selection = getSelection(mesh, side);
    const selectedVertexIndices = [];

    if (selection) {
      for (let index = 0; index < selection.length; index++) {
        if (selection[index]) selectedVertexIndices.push(index);
      }
    }

    return {
      meshIndex,
      meshUuid: mesh.uuid,
      meshName: getMeshLabel(mesh),
      vertexCount: mesh.geometry?.attributes?.position?.count || 0,
      triangleCount: getTriangleCount(mesh),
      selectedVertexIndices,
    };
  });

  return {
    id: 1,
    name: `${sideLabel(side)} alignment region`,
    selectedVertexCount: perMesh.reduce((sum, entry) => sum + entry.selectedVertexIndices.length, 0),
    meshes: perMesh,
  };
}

function exportMaskForSide(side) {
  const meshes = getMeshesForSide(side);
  if (!meshes.length) return alert(`Load a ${side} mesh before exporting its mask.`);

  const mask = maskExportPayloadForSide(side);
  const payload = {
    format: 'geomy-mesh-mask',
    version: GEOMY_VERSION,
    coordinateSpace: 'mesh-vertex-index',
    selectedColor: `#${getSideColors(side).included.getHexString()}`,
    unselectedColor: `#${getSideColors(side).excluded.getHexString()}`,
    brushRadius,
    mask,
  };

  const stem = side === 'source' ? sourceFileName : targetFileName;
  downloadBlob(
    JSON.stringify(payload, null, 2),
    `rigid-align-${side}-mask-${safeFilename(stem, side)}.json`,
    'application/json'
  );
}

async function importMaskFileForSide(side, file) {
  if (!file) return;

  try {
    const payload = await readJSONFile(file);
    const result = parseMaskPayloadForSide(payload, side);

    commit(`import ${side} alignment mask`, () => {
      applyMaskSelectionToSide(side, result.selectionByMesh);
    });

    if (result.skipped > 0) {
      alert(`Imported ${side} mask. Skipped ${result.skipped} invalid vertex entr${result.skipped === 1 ? 'y' : 'ies'}.`);
    }
  } catch (error) {
    console.error(`Failed to import ${side} alignment mask:`, error);
    alert(error?.message || `Failed to import ${side} mask.`);
  } finally {
    const input = document.getElementById(`mesh-rigid-${side}-mask-file`);
    if (input) input.value = '';
  }
}

function vectorFromLandmarkPayload(data) {
  const candidates = [
    data?.worldPosition,
    data?.position,
    data?.point,
    Array.isArray(data) ? data : null,
  ];

  for (const value of candidates) {
    if (!value) continue;

    if (Array.isArray(value) && value.length >= 3) {
      const x = Number(value[0]);
      const y = Number(value[1]);
      const z = Number(value[2]);
      if ([x, y, z].every(Number.isFinite)) return new THREE.Vector3(x, y, z);
    } else if (typeof value === 'object') {
      const x = Number(value.x);
      const y = Number(value.y);
      const z = Number(value.z);
      if ([x, y, z].every(Number.isFinite)) return new THREE.Vector3(x, y, z);
    }
  }

  return null;
}

function parseLandmarkPayloadForSide(payload, side) {
  const root = getObjectForSide(side);
  if (!root) throw new Error(`Load a ${side} mesh before importing landmarks.`);

  const source = Array.isArray(payload)
    ? payload
    : (Array.isArray(payload?.landmarks) ? payload.landmarks : null);

  if (!source) throw new Error('This JSON does not contain a landmarks array.');

  const landmarks = [];
  let skipped = 0;
  let maxId = 0;

  source.forEach((entry, index) => {
    const world = vectorFromLandmarkPayload(entry);
    if (!world) {
      skipped += 1;
      return;
    }

    const id = Number.isInteger(Number(entry?.id)) && Number(entry.id) > 0
      ? Number(entry.id)
      : nextLandmarkId + index;

    maxId = Math.max(maxId, id);
    landmarks.push({
      id,
      local: root.worldToLocal(world.clone()),
    });
  });

  if (!landmarks.length) throw new Error('No valid landmarks were found in the JSON file.');

  return { landmarks, skipped, maxId };
}

async function importLandmarksForSide(side, file) {
  if (!file) return;

  try {
    const payload = await readJSONFile(file);
    const result = parseLandmarkPayloadForSide(payload, side);

    commit(`import ${side} landmarks`, () => {
      setLandmarkList(side, result.landmarks);
      nextLandmarkId = Math.max(nextLandmarkId, result.maxId + 1);

      selectedLandmarkSide = null;
      selectedLandmarkIndex = -1;
      rebuildLandmarkMarkers();
    });

    if (result.skipped > 0) {
      alert(`Imported ${result.landmarks.length} ${side} landmark(s). Skipped ${result.skipped} invalid entr${result.skipped === 1 ? 'y' : 'ies'}.`);
    }
  } catch (error) {
    console.error(`Failed to import ${side} landmarks:`, error);
    alert(error?.message || `Failed to import ${side} landmarks.`);
  } finally {
    const input = document.getElementById(`mesh-rigid-${side}-landmarks-file`);
    if (input) input.value = '';
  }
}

function landmarkExportEntry(side, landmark, rowIndex, exportIndex) {
  const world = getWorldLandmark(side, rowIndex);
  const mesh = getMeshesForSide(side)[0] || null;

  return {
    index: exportIndex,
    id: landmark.id,
    name: `${sideLabel(side)} Landmark ${exportIndex + 1}`,
    snapMode: 'triangle',
    worldPosition: vectorPayload(world),
    snap: {
      type: 'triangle',
      meshUuid: mesh?.uuid ?? null,
      meshName: mesh ? getMeshLabel(mesh) : null,
      faceIndex: null,
      vertexIndices: null,
      barycentric: null,
    },
  };
}

function exportLandmarksForSide(side) {
  const landmarks = getLandmarkList(side);
  const entries = [];

  landmarks.forEach((landmark, rowIndex) => {
    if (!landmark) return;
    const world = getWorldLandmark(side, rowIndex);
    if (!world) return;
    entries.push(landmarkExportEntry(side, landmark, rowIndex, entries.length));
  });

  if (!entries.length) return alert(`No ${side} landmarks to export.`);

  const payload = {
    format: 'geomy-landmarks',
    version: GEOMY_VERSION,
    coordinateSpaces: {
      absolute: 'world',
      triangle: 'mesh-face-barycentric',
      vertex: 'mesh-vertex-index',
      edge: 'mesh-edge-two-point-barycentric',
    },
    landmarks: entries,
  };

  const stem = side === 'source' ? sourceFileName : targetFileName;
  downloadBlob(
    JSON.stringify(payload, null, 2),
    `rigid-align-${side}-landmarks-${safeFilename(stem, side)}.json`,
    'application/json'
  );
}


function exportTransformNpy() {
  const matrix = sourceAssetToTargetAssetMatrix();
  if (!matrix) return alert('Load source and target meshes before exporting the transform.');

  downloadNpy(
    new Float32Array(matrix.toArray()),
    [4, 4],
    'float32',
    'rigid-align-source-to-target.npy'
  );
}

function exportTransformByFormat(format) {
  if (format === 'npy') exportTransformNpy();
  else exportTransformJSON();
}

function restoreOriginalMaterialsForExport(cloneRoot, originalRoot) {
  const originalMeshes = [];
  originalRoot?.traverse?.(mesh => {
    if (mesh.isMesh) originalMeshes.push(mesh);
  });

  let meshIndex = 0;
  cloneRoot?.traverse?.(mesh => {
    if (!mesh.isMesh) return;

    const originalMesh = originalMeshes[meshIndex++];
    const originalMaterial = originalMesh?.userData?.geomyRigidOriginalMaterial || originalMesh?.material;
    if (!originalMaterial) return;

    mesh.material = cloneMaterialOrArray(originalMaterial);
    // Object3D.clone serializes userData through JSON, which turns stored
    // Material/Color instances into plain objects. Do not let exporters see those.
    delete mesh.userData.geomyRigidOriginalMaterial;
  });
}

function cloneTransformedSourceForExport() {
  if (!sourceObject) return null;

  const sourceToTarget = sourceAssetToTargetAssetMatrix();
  if (!sourceToTarget) return null;

  const clone = sourceObject.clone(true);
  restoreOriginalMaterialsForExport(clone, sourceObject);
  setRootMatrix(clone, sourceToTarget);
  clone.updateMatrixWorld(true);
  return clone;
}

function exportTransformedSourceMesh(format = 'obj') {
  if (!sourceObject) return alert('Load a source mesh first.');
  const name = sourceFileName ? sourceFileName.replace(/\.[^.]+$/, '') : 'source-mesh';
  const clone = cloneTransformedSourceForExport();
  if (!clone) return alert('Load source and target meshes before exporting the aligned source.');

  const base = `rigid-align-${safeFilename(name)}-transformed`;
  const exporterFormat = String(format || 'glb').toLowerCase();

  if (exporterFormat === 'glb' || exporterFormat === 'gltf') {
    const exporter = new GLTFExporter();
    exporter.parse(
      clone,
      result => {
        if (result instanceof ArrayBuffer) {
          downloadBlob(result, `${base}.glb`, 'model/gltf-binary');
        } else {
          downloadBlob(JSON.stringify(result, null, 2), `${base}.gltf`, 'model/gltf+json');
        }
      },
      error => {
        console.error('Failed to export aligned source mesh:', error);
        alert(error?.message || 'Failed to export aligned source mesh.');
      },
      { binary: exporterFormat === 'glb' }
    );
    return;
  }

  if (exporterFormat === 'ply') {
    const exporter = new PLYExporter();
    exporter.parse(clone, result => {
      const blobType = result instanceof ArrayBuffer ? 'application/octet-stream' : 'text/plain';
      downloadBlob(result, `${base}.ply`, blobType);
    }, { binary: false });
    return;
  }

  if (exporterFormat === 'stl') {
    const result = new STLExporter().parse(clone, { binary: false });
    downloadBlob(result, `${base}.stl`, 'model/stl');
    return;
  }

  const text = new OBJExporter().parse(clone);
  downloadBlob(text, `${base}.obj`, 'text/plain');
}

function sessionExportPayload() {
  return {
    type: 'geomy.meshRigidAlign.session',
    version: GEOMY_VERSION,
    sourceFileName,
    targetFileName,
    createdAt: new Date().toISOString(),
    snapshot: makeSnapshot(),
  };
}

function transformExportPayload() {
  return {
    type: 'geomy.meshRigidAlign.transform',
    version: GEOMY_VERSION,
    sourceFileName,
    targetFileName,
    createdAt: new Date().toISOString(),
    sourceToTargetMatrix: matrixArray(sourceAssetToTargetAssetMatrix()),
    allowMirroring,
    landmarkBlend: effectiveLandmarkBlend({ requireMinimum: true }),
    alignOptions: {
      allowScale: alignAllowScale,
      allowRotation: alignAllowRotation !== false,
      allowTranslation: alignAllowTranslation !== false,
      allowReflection: allowMirroring,
    },
    lastResult,
    landmarkPairs: completeLandmarkPairs().map(pair => ({
      source: vectorPayload(pair.source),
      target: vectorPayload(pair.target),
      index: pair.index,
    })),
  };
}

function exportTransformJSON() {
  if (!sourceObject) return;

  const payload = transformExportPayload();
  const name = sourceFileName ? sourceFileName.replace(/\.[^.]+$/, '') : 'source-mesh';
  downloadBlob(JSON.stringify(payload, null, 2), `rigid-align-${name}.json`, 'application/json');
}

function exportSessionJSON() {
  downloadBlob(JSON.stringify(sessionExportPayload(), null, 2), 'rigid-align-session.json', 'application/json');
}

async function importSessionFile(file) {
  if (!file) return;

  try {
    const payload = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        try { resolve(JSON.parse(String(reader.result || ''))); }
        catch (error) { reject(error); }
      };
      reader.onerror = () => reject(new Error('Failed to read the rigid alignment session file.'));
      reader.readAsText(file);
    });

    const snapshot = payload.snapshot || payload;
    restoreSnapshot(snapshot);
    clearHistory();
  } catch (error) {
    console.error('Failed to import rigid alignment session:', error);
    alert(error?.message || 'Failed to import rigid alignment session.');
  } finally {
    const input = document.getElementById('mesh-rigid-import-file');
    if (input) input.value = '';
  }
}

function syncAlignmentOptionsFromPanel() {
  const blendInput = document.getElementById('mesh-rigid-landmark-blend');
  const scaleInput = document.getElementById('mesh-rigid-allow-scale');
  const rotationInput = document.getElementById('mesh-rigid-allow-rotation');
  const translationInput = document.getElementById('mesh-rigid-allow-translation');
  const mirrorInput = document.getElementById('mesh-rigid-allow-mirror');

  landmarkBlend = clamp(Number(blendInput?.value ?? landmarkBlend * 100) / 100, 0, 1);
  alignAllowScale = !!scaleInput?.checked;
  alignAllowRotation = rotationInput?.checked !== false;
  alignAllowTranslation = translationInput?.checked !== false;
  allowMirroring = !!mirrorInput?.checked;
  coerceLandmarkBlendForCurrentLandmarks();
}

function updateLandmarkBlendControls() {
  const input = document.getElementById('mesh-rigid-landmark-blend');
  const label = document.getElementById('mesh-rigid-landmark-blend-val');
  const hint = document.getElementById('mesh-rigid-landmark-blend-hint');
  const landmarksUsable = landmarkPairsAreUsable({ requireMinimum: true });

  if (!landmarksUsable) {
    landmarkBlend = 0;
  }

  const value = Math.round(effectiveLandmarkBlend({ requireMinimum: true }) * 100);

  if (input) {
    input.disabled = !landmarksUsable;
    input.value = String(value);
    input.title = landmarksUsable
      ? '0% = ICP only; 100% = landmark-only Kabsch/similarity solve.'
      : 'Add the same number of source and target landmarks (at least 3) to enable landmark supervision.';
  }

  if (label) label.textContent = `${value}%`;
  if (hint) {
    hint.textContent = landmarksUsable
      ? '0% uses only ICP matches; 100% uses only corresponding landmarks; middle values balance both match groups.'
      : 'Landmark balance is forced to 0% until source and target have the same complete landmark count (at least 3).';
  }
}

// ── UI ────────────────────────────────────────────────────────────

function readyLandmarkCount() {
  return completeLandmarkPairs().length;
}

function landmarkCountHint() {
  const sourceCount = nonEmptyLandmarkCount('source');
  const targetCount = nonEmptyLandmarkCount('target');

  if (!sourceCount && !targetCount) return '0 ready / 0';
  if (sourceCount !== targetCount) return `${readyLandmarkCount()} ready; ${sourceCount} source / ${targetCount} target`;
  return `${readyLandmarkCount()} ready / ${Math.max(sourceCount, targetCount)}`;
}

function renderLandmarkList() {
  const list = document.getElementById('mesh-rigid-landmark-list');
  if (!list) return;

  const sourceCount = nonEmptyLandmarkCount('source');
  const targetCount = nonEmptyLandmarkCount('target');
  const completeCount = completeLandmarkPairs().length;
  const maxRows = Math.max(sourceLandmarks.length, targetLandmarks.length);

  list.classList.toggle('is-imbalanced', sourceCount !== targetCount || completeCount !== sourceCount);

  if (!maxRows) {
    list.innerHTML = '<div class="info-row">No landmarks yet.<br>Use Landmark mode on Source or Target view. Matching row indices form supervision pairs.</div>';
    return;
  }

  function renderCell(side, index) {
    const landmark = getLandmarkList(side)[index];
    const ready = !!landmark;
    const selected = ready && isLandmarkSelected(side, index);
    const short = side === 'source' ? 'S' : 'T';

    if (!ready) {
      return `
        <div class="mesh-rigid-landmark-cell missing" data-landmark-cell="${side}" data-landmark-index="${index}">
          <span class="mesh-rigid-badge">${short}${index + 1}</span>
          <span class="mesh-rigid-landmark-placeholder">missing</span>
        </div>
      `;
    }

    return `
      <div class="mesh-rigid-landmark-cell ${selected ? 'selected' : ''}" data-landmark-cell="${side}" data-landmark-index="${index}">
        <button type="button" class="btn btn-mini" data-landmark-select-${side}="${index}" title="Select ${side} landmark ${index + 1}">
          <span class="mesh-rigid-badge ready">${short}${index + 1}</span>
        </button>
        <button type="button" class="btn btn-mini btn-danger" data-landmark-delete-${side}="${index}" title="Remove ${side} landmark ${index + 1}">×</button>
      </div>
    `;
  }

  list.innerHTML = `
    <div class="mesh-rigid-landmark-table">
      <div class="mesh-rigid-landmark-head">Source</div>
      <div class="mesh-rigid-landmark-head">Target</div>
      ${Array.from({ length: maxRows }, (_, index) => {
        const rowClass = sourceLandmarks[index] && targetLandmarks[index] ? '' : ' incomplete';

        return `
          <div class="mesh-rigid-landmark-row${rowClass}" data-landmark-index="${index}">
            ${renderCell('source', index)}
            ${renderCell('target', index)}
          </div>
        `;
      }).join('')}
    </div>
  `;

  list.querySelectorAll('[data-landmark-select-source]').forEach(button => {
    button.addEventListener('click', () => setSelectedLandmark('source', Number(button.dataset.landmarkSelectSource)));
  });

  list.querySelectorAll('[data-landmark-select-target]').forEach(button => {
    button.addEventListener('click', () => setSelectedLandmark('target', Number(button.dataset.landmarkSelectTarget)));
  });

  list.querySelectorAll('[data-landmark-delete-source]').forEach(button => {
    button.addEventListener('click', () => removeLandmark('source', Number(button.dataset.landmarkDeleteSource)));
  });

  list.querySelectorAll('[data-landmark-delete-target]').forEach(button => {
    button.addEventListener('click', () => removeLandmark('target', Number(button.dataset.landmarkDeleteTarget)));
  });
}

function updateStackButtons() {
  const undoBtn = document.getElementById('mesh-rigid-undo');
  const redoBtn = document.getElementById('mesh-rigid-redo');
  if (undoBtn) undoBtn.disabled = !history.canUndo;
  if (redoBtn) redoBtn.disabled = !history.canRedo;
}

function updatePanelStats() {
  const targetStats = countSideSelection('target');
  const sourceStats = countSideSelection('source');

  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  setText('mesh-rigid-target-count', targetStats.total ? `${targetStats.included.toLocaleString()} / ${targetStats.total.toLocaleString()}` : '—');
  setText('mesh-rigid-source-count', sourceStats.total ? `${sourceStats.included.toLocaleString()} / ${sourceStats.total.toLocaleString()}` : '—');
  setText('mesh-rigid-landmark-count', landmarkCountHint());
  setText('mesh-rigid-source-name', sourceFileName || 'No source mesh');
  setText('mesh-rigid-target-name', targetFileName || 'No target mesh');
  updateLandmarkBlendControls();
  renderAlignmentResult();
  updateStackButtons();
  updateDisplayButtons();
  updateInteractionButtons();
}

function renderAlignmentResult() {
  const el = document.getElementById('mesh-rigid-result');
  if (!el) return;

  if (!lastResult) {
    el.textContent = 'Run alignment to see results.';
    return;
  }

  const rms = Number.isFinite(lastResult.rms) ? lastResult.rms.toExponential(3) : '—';
  const mirror = lastResult.mirroring ? '; mirroring allowed' : '';
  const transformFlags = `; ${lastResult.allowScale ? 'scale' : 'no scale'}, ${lastResult.allowRotation ? 'rotation' : 'no rotation'}, ${lastResult.allowTranslation ? 'translation' : 'no translation'}`;

  if (lastResult.mode === 'landmarks') {
    el.textContent = `Landmark-only RMS ${rms}; ${lastResult.landmarks} landmark pair(s)${transformFlags}${mirror}.`;
    return;
  }

  const outliers = Number.isFinite(lastResult.outlierRatio)
    ? `; ${Math.round(lastResult.outlierRatio * 100)}% outliers rejected from painted ICP matches`
    : '';
  const blend = Number.isFinite(lastResult.landmarkBlend)
    ? `; ${Math.round(lastResult.landmarkBlend * 100)}% landmark balance`
    : '';
  const warmStart = lastResult.landmarkWarmStart ? '; landmark warm start' : '';
  el.textContent = `ICP RMS ${rms}; ${lastResult.pairsUsed.toLocaleString()} total pair(s) (${(lastResult.icpPairsUsed || 0).toLocaleString()} ICP); ${lastResult.iterations} iterations; ${lastResult.landmarks} landmark pair(s)${blend}${warmStart}${outliers}${transformFlags}${mirror}.`;
}

function renderPanel() {
  const content = app.dom.taskContent;
  if (!content) return;

  content.innerHTML = `
    <div class="task-heading">
      <h3>Mesh Rigid Align</h3>
      <span class="task-help" tabindex="0" data-tip="Load a source and target mesh. Use Space to cycle Source, Target, Both. Source/Target view is edit mode; Both view is inspect-only. Paint: Alt left/right includes/excludes, Shift handles components, Alt+wheel changes brush. Landmark: Alt left/right adds/removes, Ctrl-drag moves, Shift selects/swaps, any modifier+wheel scales.">?</span>
    </div>

    <div class="section-title">Meshes</div>
    <div class="mesh-rigid-grid">
      <button class="btn" id="mesh-rigid-source-btn">Load Source</button>
      <button class="btn" id="mesh-rigid-target-btn">Load Target</button>
    </div>
    <input type="file" id="mesh-rigid-source-file" class="mesh-rigid-file-input" accept=".obj,.stl,.ply,.glb,.gltf">
    <input type="file" id="mesh-rigid-target-file" class="mesh-rigid-file-input" accept=".obj,.stl,.ply,.glb,.gltf">
    <div class="mesh-rigid-option-group" style="margin-top:6px;">
      <div class="mesh-rigid-stat"><span>Source</span><span id="mesh-rigid-source-name">${sourceFileName || 'No source mesh'}</span></div>
      <div class="mesh-rigid-stat"><span>Target</span><span id="mesh-rigid-target-name">${targetFileName || 'No target mesh'}</span></div>
    </div>

    <div class="section-title section-title-with-help">
      <span>Display</span>
      <span class="section-help" tabindex="0" data-tip="Press Space to cycle Source, Target, and Both. Distance heatmap colors each mesh by point-to-surface distance to the other mesh.">?</span>
    </div>
    <label class="checkbox-label" style="margin-top:6px;"><input type="checkbox" id="mesh-rigid-distance-heatmap" ${distanceHeatmap ? 'checked' : ''}> Distance heatmap</label>

    <div class="section-title section-title-with-help">
      <span>Interaction</span>
      <span class="section-help" tabindex="0" data-tip="Camera controls stay active unless you hold the task modifier for the selected mode.">?</span>
    </div>
    <div class="btn-row mesh-rigid-mode-buttons">
      <button class="btn" data-mesh-rigid-mode="paint">Paint</button>
      <button class="btn" data-mesh-rigid-mode="landmark">Landmark</button>
    </div>

    <div class="section-title section-title-with-help">
      <span>Paint region</span>
      <span class="section-help" tabindex="0" data-tip="Paint mode: show Source or Target, then Alt+left/right-drag includes/excludes vertices. Shift+left/right applies include/exclude to the connected component. Alt+wheel resizes the brush. Disabled in Both view.">?</span>
    </div>
    <div class="mesh-rigid-option-group">
      <span class="mesh-rigid-slider-label">Brush</span>
      <div class="range-row">
        <input type="range" id="mesh-rigid-brush" min="${MIN_BRUSH_RADIUS}" max="${MAX_BRUSH_RADIUS}" step="0.001" value="${brushRadius}">
        <span class="range-val" id="mesh-rigid-brush-val">${brushRadius.toFixed(3)}</span>
      </div>
      <button class="btn btn-full" id="mesh-rigid-invert-active" style="margin-top:6px;">Invert active mesh region</button>
      <div class="mesh-rigid-compact-actions" style="margin-top:6px;">
        <button class="btn btn-mini" id="mesh-rigid-source-mask">Import source mask</button>
        <button class="btn btn-mini" id="mesh-rigid-target-mask">Import target mask</button>
        <button class="btn btn-mini" id="mesh-rigid-source-mask-export">Export source mask</button>
        <button class="btn btn-mini" id="mesh-rigid-target-mask-export">Export target mask</button>
      </div>
      <input type="file" id="mesh-rigid-source-mask-file" class="mesh-rigid-file-input" accept="application/json,.json">
      <input type="file" id="mesh-rigid-target-mask-file" class="mesh-rigid-file-input" accept="application/json,.json">
    </div>

    <div class="section-title">Stats</div>
    <div class="mesh-rigid-option-group">
      <div class="mesh-rigid-stat"><span>Target included</span><span id="mesh-rigid-target-count">—</span></div>
      <div class="mesh-rigid-stat"><span>Source included</span><span id="mesh-rigid-source-count">—</span></div>
      <div class="mesh-rigid-stat"><span>Landmarks</span><span id="mesh-rigid-landmark-count">0 ready / 0</span></div>
    </div>

    <div class="section-title section-title-with-help">
      <span>Landmarks</span>
      <span class="section-help" tabindex="0" data-tip="Landmark mode: Alt+left/right adds/removes, Ctrl+left-drag moves nearest landmark, Shift+left selects, Shift+right swaps with selected, any modifier+wheel rescales markers. Disabled in Both view.">?</span>
    </div>
    <div class="mesh-rigid-compact-actions" style="margin-top:6px;">
      <button class="btn btn-mini" id="mesh-rigid-source-landmarks-import">Import source LM</button>
      <button class="btn btn-mini" id="mesh-rigid-target-landmarks-import">Import target LM</button>
      <button class="btn btn-mini" id="mesh-rigid-source-landmarks-export">Export source LM</button>
      <button class="btn btn-mini" id="mesh-rigid-target-landmarks-export">Export target LM</button>
    </div>
    <input type="file" id="mesh-rigid-source-landmarks-file" class="mesh-rigid-file-input" accept="application/json,.json">
    <input type="file" id="mesh-rigid-target-landmarks-file" class="mesh-rigid-file-input" accept="application/json,.json">
    <div id="mesh-rigid-landmark-list" class="mesh-rigid-landmark-list"></div>

    <div class="section-title section-title-with-help">
      <span>Alignment</span>
      <span class="section-help" tabindex="0" data-tip="Landmark weight blends landmark constraints with painted ICP. 100% landmarks uses only landmark pairs. Adjust outlier rejection for ICP matching.">?</span>
    </div>
    <div class="mesh-rigid-option-group">
      <span class="mesh-rigid-slider-label">Landmark weight</span>
      <div class="range-row">
        <input type="range" id="mesh-rigid-landmark-blend" min="0" max="100" value="${Math.round(effectiveLandmarkBlend({ requireMinimum: true }) * 100)}">
        <span class="range-val" id="mesh-rigid-landmark-blend-val">${Math.round(effectiveLandmarkBlend({ requireMinimum: true }) * 100)}%</span>
      </div>
      <label class="checkbox-label"><input type="checkbox" id="mesh-rigid-allow-scale" ${alignAllowScale ? 'checked' : ''}> Allow scale</label>
      <label class="checkbox-label"><input type="checkbox" id="mesh-rigid-allow-rotation" ${alignAllowRotation !== false ? 'checked' : ''}> Allow rotation</label>
      <label class="checkbox-label"><input type="checkbox" id="mesh-rigid-allow-translation" ${alignAllowTranslation !== false ? 'checked' : ''}> Allow translation</label>
      <label class="checkbox-label"><input type="checkbox" id="mesh-rigid-allow-mirror" ${allowMirroring ? 'checked' : ''}> Allow mirroring/reflection</label>
      <div class="material-row">
        <label>Iter.</label>
        <input type="number" id="mesh-rigid-iterations" value="25" min="1" max="${MAX_ICP_ITERATIONS}" step="1">
      </div>
      <div class="material-row">
        <label>Samples</label>
        <input type="number" id="mesh-rigid-samples" value="${DEFAULT_SAMPLE_LIMIT}" min="50" max="50000" step="50">
      </div>
      <span class="mesh-rigid-slider-label">Outliers</span>
      <div class="range-row">
        <input type="range" id="mesh-rigid-outliers" min="0" max="95" value="10">
        <span class="range-val" id="mesh-rigid-outliers-val">10%</span>
      </div>
      <button class="btn btn-export btn-full" id="mesh-rigid-align">Run Align</button>
      <div class="mesh-rigid-result" id="mesh-rigid-result">Run alignment to see results.</div>
    </div>

    <div class="section-title section-title-with-help">
      <span>History / I/O</span>
      <span class="section-help" tabindex="0" data-tip="Save/load sessions and export transforms. Reset buttons restore source or target transforms.">?</span>
    </div>
    <div class="btn-row" style="margin-top:6px;">
      <button class="btn" id="mesh-rigid-reset-source">Reset Source</button>
      <button class="btn" id="mesh-rigid-reset-target">Reset Target</button>
    </div>
    <div class="material-row" style="margin-top:6px;">
      <label>Transform</label>
      <select id="mesh-rigid-transform-format">
        <option value="npy">Numpy (.npy)</option>
        <option value="json">JSON</option>
      </select>
      <button class="btn btn-mini" id="mesh-rigid-export-transform">Export</button>
    </div>
    <div class="material-row" style="margin-top:6px;">
      <label>Source</label>
      <select id="mesh-rigid-source-format">
        <option value="glb">GLB</option>
        <option value="gltf">GLTF</option>
        <option value="obj">OBJ</option>
        <option value="ply">PLY</option>
        <option value="stl">STL</option>
      </select>
      <button class="btn btn-mini" id="mesh-rigid-export-source">Export</button>
    </div>
    <div class="btn-row" style="margin-top:6px;">
      <button class="btn" id="mesh-rigid-export-session">Save Session</button>
      <button class="btn" id="mesh-rigid-import-session">Load Session</button>
    </div>
    <input type="file" id="mesh-rigid-import-file" class="mesh-rigid-file-input" accept="application/json,.json">
  `;

  bindPanelEvents();
  updatePanelStats();
  renderLandmarkList();
  renderAlignmentResult();
}

function bindPanelEvents() {
  document.getElementById('mesh-rigid-source-btn')?.addEventListener('click', () => document.getElementById('mesh-rigid-source-file')?.click());
  document.getElementById('mesh-rigid-target-btn')?.addEventListener('click', () => document.getElementById('mesh-rigid-target-file')?.click());

  document.getElementById('mesh-rigid-source-file')?.addEventListener('change', event => loadSideFile('source', event.target.files?.[0]));
  document.getElementById('mesh-rigid-target-file')?.addEventListener('change', event => loadSideFile('target', event.target.files?.[0]));

  document.querySelectorAll('[data-mesh-rigid-view]').forEach(button => {
    button.addEventListener('click', () => {
      setDisplayMode(button.dataset.meshRigidView, { commitChange: true });
      focusViewportForKeys();
    });
  });

  document.querySelectorAll('[data-mesh-rigid-mode]').forEach(button => {
    button.addEventListener('click', () => {
      setInteractionMode(button.dataset.meshRigidMode);
      focusViewportForKeys();
    });
  });

  document.getElementById('mesh-rigid-distance-heatmap')?.addEventListener('change', event => {
    setDistanceHeatmap(event.target.checked, { commitChange: true });
    focusViewportForKeys();
  });

  const brushInput = document.getElementById('mesh-rigid-brush');
  const brushVal = document.getElementById('mesh-rigid-brush-val');
  brushInput?.addEventListener('input', () => {
    brushRadius = clamp(Number(brushInput.value) || DEFAULT_BRUSH_RADIUS, MIN_BRUSH_RADIUS, MAX_BRUSH_RADIUS);
    if (brushVal) brushVal.textContent = brushRadius.toFixed(3);
    refreshPreviewAtCursor();
  });

  const outlierInput = document.getElementById('mesh-rigid-outliers');
  const outlierVal = document.getElementById('mesh-rigid-outliers-val');
  outlierInput?.addEventListener('input', () => {
    if (outlierVal) outlierVal.textContent = `${outlierInput.value}%`;
  });

  document.getElementById('mesh-rigid-invert-active')?.addEventListener('click', invertActiveSelection);
  document.getElementById('mesh-rigid-source-mask')?.addEventListener('click', () => document.getElementById('mesh-rigid-source-mask-file')?.click());
  document.getElementById('mesh-rigid-target-mask')?.addEventListener('click', () => document.getElementById('mesh-rigid-target-mask-file')?.click());
  document.getElementById('mesh-rigid-source-mask-export')?.addEventListener('click', () => exportMaskForSide('source'));
  document.getElementById('mesh-rigid-target-mask-export')?.addEventListener('click', () => exportMaskForSide('target'));
  document.getElementById('mesh-rigid-source-mask-file')?.addEventListener('change', event => importMaskFileForSide('source', event.target.files?.[0]));
  document.getElementById('mesh-rigid-target-mask-file')?.addEventListener('change', event => importMaskFileForSide('target', event.target.files?.[0]));

  document.getElementById('mesh-rigid-source-landmarks-import')?.addEventListener('click', () => document.getElementById('mesh-rigid-source-landmarks-file')?.click());
  document.getElementById('mesh-rigid-target-landmarks-import')?.addEventListener('click', () => document.getElementById('mesh-rigid-target-landmarks-file')?.click());
  document.getElementById('mesh-rigid-source-landmarks-export')?.addEventListener('click', () => exportLandmarksForSide('source'));
  document.getElementById('mesh-rigid-target-landmarks-export')?.addEventListener('click', () => exportLandmarksForSide('target'));
  document.getElementById('mesh-rigid-source-landmarks-file')?.addEventListener('change', event => importLandmarksForSide('source', event.target.files?.[0]));
  document.getElementById('mesh-rigid-target-landmarks-file')?.addEventListener('change', event => importLandmarksForSide('target', event.target.files?.[0]));

  document.getElementById('mesh-rigid-landmark-blend')?.addEventListener('input', event => {
    landmarkBlend = clamp(Number(event.target.value) / 100, 0, 1);
    updateLandmarkBlendControls();
  });

  ['scale', 'rotation', 'translation'].forEach(name => {
    document.getElementById(`mesh-rigid-allow-${name}`)?.addEventListener('change', syncAlignmentOptionsFromPanel);
  });

  document.getElementById('mesh-rigid-allow-mirror')?.addEventListener('change', event => {
    allowMirroring = !!event.target.checked;
  });

  document.getElementById('mesh-rigid-align')?.addEventListener('click', alignSource);
  document.getElementById('mesh-rigid-reset-source')?.addEventListener('click', resetSourceTransform);
  document.getElementById('mesh-rigid-reset-target')?.addEventListener('click', resetTargetTransform);
  document.getElementById('mesh-rigid-export-transform')?.addEventListener('click', () => exportTransformByFormat(document.getElementById('mesh-rigid-transform-format')?.value || 'npy'));
  document.getElementById('mesh-rigid-export-session')?.addEventListener('click', exportSessionJSON);
  document.getElementById('mesh-rigid-export-source')?.addEventListener('click', () => exportTransformedSourceMesh(document.getElementById('mesh-rigid-source-format')?.value || 'glb'));
  document.getElementById('mesh-rigid-import-session')?.addEventListener('click', () => document.getElementById('mesh-rigid-import-file')?.click());
  document.getElementById('mesh-rigid-import-file')?.addEventListener('change', event => importSessionFile(event.target.files?.[0]));
  updateInteractionButtons();
}

// ── Events ────────────────────────────────────────────────────────

function focusViewportFromPointer(event) {
  if (!active || isTextInputTarget(event.target)) return;
  focusViewportForKeys();
}

function onPointerDown(event) {
  if (!active) return;
  syncCursorFromEvent(event);

  const isLeft = event.button === 0;
  const isRight = event.button === 2;
  const editSide = editableSideFromDisplay();

  if (!editSide) return;

  if (interactionMode === 'landmark' && (event.ctrlKey || event.metaKey) && isLeft) {
    const index = landmarkIndexFromEvent(editSide, event);
    preventTaskEvent(event);
    focusViewportForKeys();
    if (index >= 0) beginLandmarkDrag(event, editSide, index);
    updateCursorIndicator();
    return;
  }

  if (interactionMode === 'landmark' && event.shiftKey && (isLeft || isRight)) {
    const index = landmarkIndexFromEvent(editSide, event);
    preventTaskEvent(event);
    focusViewportForKeys();

    if (isLeft) {
      if (index >= 0) setSelectedLandmark(editSide, index);
    } else if (selectedLandmarkSide === editSide && selectedLandmarkIndex >= 0 && index >= 0) {
      swapLandmarks(editSide, selectedLandmarkIndex, index);
    }

    updateCursorIndicator();
    return;
  }

  if (interactionMode === 'landmark' && event.altKey && !event.shiftKey && (isLeft || isRight)) {
    preventTaskEvent(event);
    focusViewportForKeys();
    if (isLeft) {
      placeLandmarkFromEvent(editSide, event);
    } else {
      removeNearestLandmarkFromEvent(editSide, event);
    }
    updateCursorIndicator();
    return;
  }

  if (interactionMode === 'paint' && !event.altKey && event.shiftKey && (isLeft || isRight)) {
    preventTaskEvent(event);
    focusViewportForKeys();
    commit(`${isLeft ? 'include' : 'exclude'} ${editSide} connected component`, () => {
      paintFromEvent(event, 'component', isLeft);
    });
    updateCursorIndicator();
    return;
  }

  if (interactionMode === 'paint' && event.altKey && (isLeft || isRight)) {
    preventTaskEvent(event);
    focusViewportForKeys();
    beginPainting(event, 'brush', isLeft);
  }
}

function onPointerMove(event) {
  if (!active) return;
  syncCursorFromEvent(event);
  updateLandmarkDrag(event);
  updatePainting(event);
}

function onPointerUp(event) {
  if (!active) return;
  syncCursorFromEvent(event);
  finishLandmarkDrag(event);
  finishPaintingGesture(event);
  updateCursorIndicator();
}

function onContextMenu(event) {
  if (!active) return;
  const taskModifierActive = !isEditingDisabledByDisplay() && (
    (interactionMode === 'paint' && (event.altKey || event.shiftKey)) ||
    (interactionMode === 'landmark' && (event.altKey || event.shiftKey || event.ctrlKey || event.metaKey))
  );

  if (painting || draggingLandmark || taskModifierActive) preventTaskEvent(event);
}

function onWheel(event) {
  if (!active || isEditingDisabledByDisplay()) return;

  if (interactionMode === 'landmark' && (event.altKey || event.shiftKey || event.ctrlKey || event.metaKey)) {
    preventTaskEvent(event);
    const factor = event.deltaY < 0 ? 1.08 : 1 / 1.08;
    scaleLandmarkVisuals(factor);
    return;
  }

  if (interactionMode !== 'paint' || !event.altKey) return;

  preventTaskEvent(event);
  const factor = event.deltaY < 0 ? 1.08 : 1 / 1.08;
  brushRadius = clamp(brushRadius * factor, MIN_BRUSH_RADIUS, MAX_BRUSH_RADIUS);
  const input = document.getElementById('mesh-rigid-brush');
  const label = document.getElementById('mesh-rigid-brush-val');
  if (input) input.value = String(brushRadius);
  if (label) label.textContent = brushRadius.toFixed(3);
  refreshPreviewAtCursor();
}

function onKeyDown(event) {
  if (!active) return;
  syncCursorModifiersFromKeyEvent(event);
  if (isTextInputTarget(event.target)) return;

  const key = event.key.toLowerCase();
  const mod = event.ctrlKey || event.metaKey;

  if (mod && key === 'z' && !event.shiftKey) {
    preventTaskEvent(event);
    undo();
  } else if ((mod && key === 'y') || (mod && event.shiftKey && key === 'z')) {
    preventTaskEvent(event);
    redo();
  } else if (key === 'escape') {
    preventTaskEvent(event);
    selectedLandmarkSide = null;
    selectedLandmarkIndex = -1;
    painting = null;
    draggingLandmark = null;
    rebuildLandmarkMarkers();
    renderLandmarkList();
    updateCursorIndicator();
  } else if (event.code === 'Space') {
    preventTaskEvent(event);
    cycleDisplayMode();
  }
}

function onKeyUp(event) {
  if (!active) return;
  syncCursorModifiersFromKeyEvent(event);

  if (event.code === 'Space' && !isTextInputTarget(event.target)) {
    preventTaskEvent(event);
  }
}

function onWindowBlur() {
  painting = null;
  resetCursorIndicator();
}

function onPointerLeave() {
  if (painting) return;
  cursorState.inViewport = false;
  updateCursorIndicator();
}

function bindViewportEvents() {
  app.dom?.viewport?.addEventListener('pointerdown', focusViewportFromPointer, true);
  app.renderer.domElement.addEventListener('pointerdown', onPointerDown, true);
  app.renderer.domElement.addEventListener('pointermove', onPointerMove, true);
  app.renderer.domElement.addEventListener('pointerup', onPointerUp, true);
  app.renderer.domElement.addEventListener('pointerleave', onPointerLeave, true);
  app.renderer.domElement.addEventListener('contextmenu', onContextMenu, true);
  app.renderer.domElement.addEventListener('wheel', onWheel, { capture: true, passive: false });

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onWindowBlur);
}

function unbindViewportEvents() {
  app.dom?.viewport?.removeEventListener('pointerdown', focusViewportFromPointer, true);
  app.renderer?.domElement?.removeEventListener('pointerdown', onPointerDown, true);
  app.renderer?.domElement?.removeEventListener('pointermove', onPointerMove, true);
  app.renderer?.domElement?.removeEventListener('pointerup', onPointerUp, true);
  app.renderer?.domElement?.removeEventListener('pointerleave', onPointerLeave, true);
  app.renderer?.domElement?.removeEventListener('contextmenu', onContextMenu, true);
  app.renderer?.domElement?.removeEventListener('wheel', onWheel, true);

  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
  window.removeEventListener('blur', onWindowBlur);
}

// ── Task lifecycle ────────────────────────────────────────────────

function resetForExternalFileLoad() {
  hideStandardLoadedObject();
  setRigidCurrentObject();
  renderPanel();
  updateTaskVertexCount();
  updateRigidDropOverlay();
  refreshGeometryInspectionHelpers();
}

function recenterFromEvent(event) {
  const hitInfo = hitFromEvent(event);
  if (!hitInfo?.hit) return false;

  app.controls.target.copy(hitInfo.hit.point);
  app.controls.update();
  return true;
}

export const meshRigidAlignTask = {
  id: 'rigidAlign',
  capabilities: {
    usesGlobalMesh: false,
    usesTaskMeshLoader: false,
    acceptsSharedMeshLoad: false,
  },

  activate() {
    active = true;
    previousVertexCountText = app.dom?.vertexCount?.textContent ?? '';
    hideStandardLoadedObject();
    setRigidCurrentObject();
    enterTaskRenderMode();
    renderPanel();
    updateMeshVisibility();
    updateAllColors();
    bindViewportEvents();
    ensureCursorIndicator();
    updateTaskVertexCount();
    updateRigidDropOverlay();
    refreshGeometryInspectionHelpers();
    focusViewportForKeys();
  },

  deactivate() {
    active = false;
    unbindViewportEvents();
    resetCursorIndicator({ remove: true });
    clearLandmarkMarkers();
    if (alignRoot) alignRoot.visible = false;
    if (targetObject) targetObject.visible = false;
    if (sourceObject) sourceObject.visible = false;
    refreshGeometryInspectionHelpers();
    exitTaskRenderMode();
    restoreRigidDropOverlay();
    restoreRigidCurrentObject();
    restoreStandardLoadedObject();
    refreshGeometryInspectionHelpers();
    if (app.dom?.vertexCount && previousVertexCountText !== null) {
      app.dom.vertexCount.textContent = previousVertexCountText;
    }
  },

  onFileLoaded() {
    resetForExternalFileLoad();
  },

  onDblClick(event) {
    return recenterFromEvent(event);
  },

  onVizWireframe(show) {
    taskWireframe = !!show;
    applyTaskDisplaySettings();
  },

  onVizBackfaceCulling(show) {
    taskBackfaceCulling = !!show;
    applyTaskDisplaySettings();
  },

  onVizOpacity() {
    forceRigidOpacityControls();
  },
};

