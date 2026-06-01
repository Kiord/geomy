import * as THREE from 'three';
import { app } from '../app.js';
import { HistoryStack } from '../core/HistoryStack.js';
import { GEOMY_VERSION } from '../version.js';
import { raycast, downloadBlob } from '../util.js';
import {
  MeshComponentIndex,
  MeshRenderBackup,
  TemporaryVisualizationState,
  clamp,
  collectBrushVertexIndices as collectBrushVertices,
  collectComponentVertexIndices as collectConnectedComponentVertices,
  collectHitVertexIndices as collectHitVertices,
  disposeMaterialOrArray,
  ensureColorAttribute,
  getCurrentMeshes,
  getMeshLabel,
  getTriangleCount,
  getViewportRect,
  isTextInputTarget,
  restoreVisualizationRenderMode as restoreSharedVisualizationRenderMode,
  setVertexColor,
  vectorPayload,
} from './meshTaskUtils.js';
import '../css/meshMasking.css';

const TASK_RENDER_OVERRIDE = 'mesh-mask';
const SELECTED_COLOR = new THREE.Color('#ff3333');
const UNSELECTED_COLOR = new THREE.Color('#2f80ff');
const PREVIEW_SELECT_COLOR = new THREE.Color('#ff9a9a');
const PREVIEW_UNSELECT_COLOR = new THREE.Color('#80b3ff');
const DEFAULT_BRUSH_RADIUS = 0.035;
const MIN_BRUSH_RADIUS = 0.005;
const MAX_BRUSH_RADIUS = 0.25;
const STACK_LIMIT = 100;

let active = false;
let brushRadius = DEFAULT_BRUSH_RADIUS;
let cursorIndicatorEl = null;
let painting = null;
let maskLights = [];
let viewControlsSuppressed = false;
let viewControlsPreviousEnabled = true;
let suppressedControls = null;

let masks = [];
let activeMaskIndex = 0;
let nextMaskId = 1;
const previewedVertices = new Map();
const visualizationState = new TemporaryVisualizationState();
const renderBackup = new MeshRenderBackup({ clearPreview });
const componentIndex = new MeshComponentIndex();
const history = new HistoryStack({ limit: STACK_LIMIT });

const cursorState = {
  x: 0,
  y: 0,
  inViewport: false,
  alt: false,
  shift: false,
  ctrlOrMeta: false,
  hitPoint: null,
  previewCount: 0,
};

function makeMask(name = null) {
  const id = nextMaskId++;

  return {
    id,
    name: name || `Mask ${id}`,
    selectedByMesh: new Map(),
  };
}

function ensureDefaultMask() {
  if (!masks.length) {
    masks.push(makeMask('Mask 1'));
    activeMaskIndex = 0;
  }

  activeMaskIndex = clamp(activeMaskIndex, 0, masks.length - 1);
  return masks[activeMaskIndex];
}

function getActiveMask() {
  return ensureDefaultMask();
}

function getMaskSelection(mask, mesh) {
  if (!mask || !mesh) return new Set();

  let selected = mask.selectedByMesh.get(mesh);
  if (!selected) {
    selected = new Set();
    mask.selectedByMesh.set(mesh, selected);
  }

  return selected;
}

function getMaskSelectedCount(mask = getActiveMask()) {
  return getCurrentMeshes().reduce((sum, mesh) => (
    sum + getMaskSelection(mask, mesh).size
  ), 0);
}

function maskName(mask, fallbackIndex = 0) {
  const name = String(mask?.name || '').trim();
  return name || `Mask ${fallbackIndex + 1}`;
}

function setActiveMaskIndex(index) {
  if (!masks.length) ensureDefaultMask();
  const nextIndex = clamp(Number(index), 0, masks.length - 1);
  if (!Number.isInteger(nextIndex) || nextIndex === activeMaskIndex) return;

  clearPreview();
  activeMaskIndex = nextIndex;
  updateAllColors();
  updatePanelStats();
}

function addMask() {
  return commit('add mask', () => {
    const mask = makeMask();
    masks.push(mask);
    activeMaskIndex = masks.length - 1;
  }, { renderMasks: true });
}

function removeMask(index) {
  if (!masks.length) ensureDefaultMask();
  if (index < 0 || index >= masks.length) return false;

  const isEmpty = getMaskSelectedCount(masks[index]) === 0;
  const name = maskName(masks[index], index);
  if (!isEmpty && !window.confirm(`Remove mask "${name}"?`)) return false;

  return commit('remove mask', () => {
    masks.splice(index, 1);

    if (!masks.length) {
      masks.push(makeMask('Mask 1'));
      activeMaskIndex = 0;
      return;
    }

    if (activeMaskIndex === index) {
      activeMaskIndex = clamp(index, 0, masks.length - 1);
    } else if (activeMaskIndex > index) {
      activeMaskIndex -= 1;
    }
  }, { renderMasks: true });
}

function moveMask(fromIndex, toIndex) {
  if (fromIndex < 0 || toIndex < 0 || fromIndex >= masks.length || toIndex >= masks.length || fromIndex === toIndex) {
    return false;
  }

  return commit('reorder masks', () => {
    const [mask] = masks.splice(fromIndex, 1);
    masks.splice(toIndex, 0, mask);

    if (activeMaskIndex === fromIndex) {
      activeMaskIndex = toIndex;
    } else if (fromIndex < activeMaskIndex && activeMaskIndex <= toIndex) {
      activeMaskIndex -= 1;
    } else if (toIndex <= activeMaskIndex && activeMaskIndex < fromIndex) {
      activeMaskIndex += 1;
    }
  }, { renderMasks: true });
}

function renameMask(index, name) {
  if (index < 0 || index >= masks.length) return false;

  const nextName = String(name || '').trim() || `Mask ${index + 1}`;
  if (masks[index].name === nextName) return false;

  return commit('rename mask', () => {
    masks[index].name = nextName;
  }, { renderMasks: true });
}

function setMaterialPanelHidden(hidden) {
  visualizationState.setMaterialPanelHidden(hidden);
}

function setSmoothShadingForMask(enabled) {
  visualizationState.setSmoothShadingDisabled(enabled);
}
function ensureMaskLights() {
  maskLights = maskLights.filter(light => light?.parent);

  if (maskLights.length) {
    maskLights.forEach(light => { light.visible = active; });
    return maskLights;
  }

  const hemi = new THREE.HemisphereLight(0xffffff, 0x303060, 1.7);
  hemi.name = 'geomy-mask-hemi-light';

  const key = new THREE.DirectionalLight(0xffffff, 2.0);
  key.name = 'geomy-mask-key-light';
  key.position.set(2.0, 3.0, 4.0);

  maskLights = [hemi, key];
  maskLights.forEach(light => {
    light.visible = active;
    app.scene.add(light);
  });

  return maskLights;
}

function setMaskLightsVisible(visible) {
  maskLights.forEach(light => {
    light.visible = visible;
  });
}

function captureRenderBackup(mesh) {
  renderBackup.capture(mesh);
}

function restoreRenderBackup({ disposeOriginals = false } = {}) {
  renderBackup.restore({ disposeOriginals });
}

function restoreVisualizationRenderMode() {
  restoreSharedVisualizationRenderMode(TASK_RENDER_OVERRIDE);
}
function ensureMeshState(mesh, mask = getActiveMask()) {
  return {
    mesh,
    mask,
    selected: getMaskSelection(mask, mesh),
  };
}

function setVertexSelected(state, vertexIndex, selected) {
  const position = state.mesh.geometry?.attributes?.position;
  if (!position || vertexIndex < 0 || vertexIndex >= position.count) return false;

  const wasSelected = state.selected.has(vertexIndex);
  if (wasSelected === selected) return false;

  if (selected) {
    state.selected.add(vertexIndex);
  } else {
    state.selected.delete(vertexIndex);
  }

  const colorAttribute = ensureColorAttribute(state.mesh);
  if (colorAttribute) {
    setVertexColor(colorAttribute, vertexIndex, selected ? SELECTED_COLOR : UNSELECTED_COLOR);
    colorAttribute.needsUpdate = true;
  }

  return true;
}

function updateMeshColors(mesh) {
  const state = ensureMeshState(mesh);
  const position = mesh.geometry?.attributes?.position;
  const colorAttribute = ensureColorAttribute(mesh);

  if (!position || !colorAttribute) return;

  for (let i = 0; i < position.count; i++) {
    setVertexColor(colorAttribute, i, state.selected.has(i) ? SELECTED_COLOR : UNSELECTED_COLOR);
  }

  colorAttribute.needsUpdate = true;
}

function updateAllColors() {
  getCurrentMeshes().forEach(mesh => updateMeshColors(mesh));
}

function clearPreview() {
  previewedVertices.forEach((indices, mesh) => {
    const colorAttribute = ensureColorAttribute(mesh);
    if (!colorAttribute) return;

    const state = ensureMeshState(mesh);
    indices.forEach(index => {
      setVertexColor(colorAttribute, index, state.selected.has(index) ? SELECTED_COLOR : UNSELECTED_COLOR);
    });
    colorAttribute.needsUpdate = true;
  });

  previewedVertices.clear();
  cursorState.previewCount = 0;
}

function getInteractionMode() {
  if (cursorState.alt) return 'brush';
  if (cursorState.shift) return 'component';
  return null;
}

function collectComponentVertexIndices(hit) {
  return collectConnectedComponentVertices(hit, componentIndex);
}

function collectHitVertexIndices(hit, mode = 'brush') {
  return collectHitVertices(hit, { mode, brushRadius, componentIndex });
}

function collectBrushVertexIndices(hit) {
  return collectBrushVertices(hit, brushRadius);
}
function updatePreviewForHit(hit, selected = true, mode = getInteractionMode()) {
  clearPreview();

  const mesh = hit?.object;
  if (!active || !mode || !cursorState.inViewport || !mesh?.isMesh) return;

  const state = ensureMeshState(mesh);
  const colorAttribute = ensureColorAttribute(mesh);
  if (!colorAttribute) return;

  const indices = collectHitVertexIndices(hit, mode);
  if (!indices.length) return;

  if (mode === 'component' && selected === false) {
    cursorState.previewCount = 0;
    return;
  }

  const previewIndices = indices.filter(index => (
    state.selected.has(index) !== selected
  ));

  if (!previewIndices.length) return;

  const previewColor = selected ? PREVIEW_SELECT_COLOR : PREVIEW_UNSELECT_COLOR;
  previewIndices.forEach(index => setVertexColor(colorAttribute, index, previewColor));
  colorAttribute.needsUpdate = true;
  previewedVertices.set(mesh, new Set(previewIndices));
  cursorState.previewCount = previewIndices.length;
}

function makeMaskMaterial() {
  const material = new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    flatShading: true,
    transparent: false,
    opacity: 1,
  });

  material.name = 'geomy-mask-lambert-material';
  material.toneMapped = false;
  return material;
}

function applyMaskRenderMode() {
  app.renderOverride = TASK_RENDER_OVERRIDE;

  if (app.scene) {
    app.scene.environment = null;
  }

  ensureMaskLights();
  setMaskLightsVisible(true);

  getCurrentMeshes().forEach(mesh => {
    captureRenderBackup(mesh);
    ensureMeshState(mesh);
    updateMeshColors(mesh);

    const previousMaterial = mesh.material;
    const originalMaterial = renderBackup.getOriginalMaterial(mesh);
    mesh.material = makeMaskMaterial();

    if (previousMaterial && previousMaterial !== originalMaterial) {
      disposeMaterialOrArray(previousMaterial);
    }
  });
}

function getSelectedCount() {
  return getMaskSelectedCount(getActiveMask());
}

function getTotalVertexCount() {
  return getCurrentMeshes().reduce((sum, mesh) => (
    sum + (mesh.geometry?.attributes?.position?.count || 0)
  ), 0);
}


function updateStackButtons() {
  const undoButton = document.getElementById('btn-mesh-mask-undo');
  const redoButton = document.getElementById('btn-mesh-mask-redo');
  if (undoButton) undoButton.disabled = !history.canUndo;
  if (redoButton) redoButton.disabled = !history.canRedo;
}

function updatePanelStats() {
  const selectedEl = document.getElementById('mesh-mask-selected-count');
  const totalEl = document.getElementById('mesh-mask-total-count');
  const brushEl = document.getElementById('mesh-mask-brush-val');
  const activeMaskEl = document.getElementById('mesh-mask-active-name');
  const maskCountEl = document.getElementById('mesh-mask-count');
  const activeMask = getActiveMask();

  if (selectedEl) {
    selectedEl.textContent = `${getSelectedCount().toLocaleString()} selected`;
  }

  if (totalEl) {
    totalEl.textContent = `${getTotalVertexCount().toLocaleString()} verts`;
  }

  if (brushEl) {
    brushEl.textContent = brushRadius.toFixed(3);
  }

  if (activeMaskEl) {
    activeMaskEl.textContent = maskName(activeMask, activeMaskIndex);
  }

  if (maskCountEl) {
    maskCountEl.textContent = `${masks.length.toLocaleString()} mask${masks.length === 1 ? '' : 's'}`;
  }

  updateMaskListState();
  updateStackButtons();
}

function serializeMaskSnapshot(mask) {
  return {
    id: mask.id,
    name: maskName(mask),
    selections: getCurrentMeshes().map(mesh => ({
      mesh,
      selected: Array.from(getMaskSelection(mask, mesh)).sort((a, b) => a - b),
    })),
  };
}

function makeSnapshot() {
  ensureDefaultMask();

  return {
    activeMaskIndex,
    nextMaskId,
    masks: masks.map(serializeMaskSnapshot),
  };
}

function snapshotKey(snapshot) {
  return JSON.stringify({
    activeMaskIndex: snapshot.activeMaskIndex,
    nextMaskId: snapshot.nextMaskId,
    masks: snapshot.masks.map(mask => ({
      id: mask.id,
      name: mask.name,
      selections: mask.selections.map(entry => ([
        entry.mesh.uuid,
        entry.selected,
      ])),
    })),
  });
}

function restoreSnapshot(snapshot) {
  clearPreview();

  nextMaskId = snapshot.nextMaskId || 1;
  masks = snapshot.masks.map(entry => {
    const mask = {
      id: entry.id,
      name: entry.name,
      selectedByMesh: new Map(),
    };

    entry.selections.forEach(selection => {
      mask.selectedByMesh.set(selection.mesh, new Set(selection.selected));
    });

    return mask;
  });

  if (!masks.length) {
    masks.push(makeMask('Mask 1'));
  }

  activeMaskIndex = clamp(snapshot.activeMaskIndex ?? 0, 0, masks.length - 1);
  nextMaskId = Math.max(nextMaskId, Math.max(0, ...masks.map(mask => mask.id)) + 1);

  renderMaskList();
  updateAllColors();
  updatePanelStats();
}

function pushUndoSnapshot(snapshot) {
  history.record(snapshot);
}

function commit(label, mutate, { renderMasks = false } = {}) {
  const before = makeSnapshot();
  clearPreview();
  mutate();
  ensureDefaultMask();
  const after = makeSnapshot();
  const beforeKey = snapshotKey(before);
  const afterKey = snapshotKey(after);
  const changed = beforeKey !== afterKey;

  if (changed) {
    pushUndoSnapshot(before);
  }

  if (renderMasks) {
    renderMaskList();
  }

  updateAllColors();
  updatePanelStats();
  return changed;
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

function clearHistory() {
  history.clear();
  updateStackButtons();
}

function paintHit(hit, selected, mode = 'brush') {
  const mesh = hit?.object;
  const position = mesh?.geometry?.attributes?.position;
  if (!mesh?.isMesh || !position) return 0;

  const state = ensureMeshState(mesh);
  let changed = 0;

  collectHitVertexIndices(hit, mode).forEach(index => {
    if (setVertexSelected(state, index, selected)) changed += 1;
  });

  if (changed > 0) updatePanelStats();
  return changed;
}

function paintFromEvent(event, selected, mode = 'brush') {
  clearPreview();

  const hits = raycast(event);
  const hit = hits.find(item => item.object?.isMesh && item.object.geometry?.attributes?.position);
  if (!hit) {
    cursorState.hitPoint = null;
    updateCursorIndicator();
    return 0;
  }

  const changed = paintHit(hit, selected, mode);
  cursorState.hitPoint = hit.point.clone();
  updatePreviewForHit(hit, selected, mode);
  updateCursorIndicator();
  return changed;
}

function paintSingleHit(event, selected, mode) {
  const before = makeSnapshot();
  const changed = paintFromEvent(event, selected, mode) > 0;

  if (changed) {
    pushUndoSnapshot(before);
  }

  updatePanelStats();
  updateCursorIndicator();
  return changed;
}

function screenBrushRadius(point) {
  const rect = getViewportRect();
  if (!point || !rect.width || !rect.height) return clamp(brushRadius * 240, 6, 140);

  const cameraRight = new THREE.Vector3().setFromMatrixColumn(app.camera.matrixWorld, 0).normalize();
  const p0 = point.clone().project(app.camera);
  const p1 = point.clone().add(cameraRight.multiplyScalar(brushRadius)).project(app.camera);

  const x0 = (p0.x + 1) * rect.width * 0.5;
  const y0 = (-p0.y + 1) * rect.height * 0.5;
  const x1 = (p1.x + 1) * rect.width * 0.5;
  const y1 = (-p1.y + 1) * rect.height * 0.5;

  const px = Math.hypot(x1 - x0, y1 - y0);
  return clamp(px, 6, Math.max(rect.width, rect.height));
}

function ensureCursorIndicator() {
  const viewport = app.dom?.viewport;
  if (!viewport) return null;

  if (cursorIndicatorEl?.parentElement === viewport) {
    return cursorIndicatorEl;
  }

  cursorIndicatorEl?.remove?.();
  cursorIndicatorEl = document.createElement('div');
  cursorIndicatorEl.className = 'mesh-mask-cursor-indicator is-hidden';
  cursorIndicatorEl.setAttribute('aria-hidden', 'true');
  viewport.appendChild(cursorIndicatorEl);
  return cursorIndicatorEl;
}

function setCanvasCursor(cursor = '') {
  const canvas = app.renderer?.domElement;
  if (canvas) canvas.style.cursor = cursor;
}

function shouldSuppressViewControls() {
  return !!(
    active &&
    app.controls &&
    (painting || (cursorState.inViewport && getInteractionMode()))
  );
}

function restoreViewControls() {
  if (!viewControlsSuppressed) return;

  if (suppressedControls) {
    suppressedControls.enabled = viewControlsPreviousEnabled;
  }

  viewControlsSuppressed = false;
  suppressedControls = null;
  viewControlsPreviousEnabled = true;
}

function updateViewControlsSuppression() {
  const controls = app.controls;
  const shouldSuppress = shouldSuppressViewControls();

  if (!controls || !shouldSuppress) {
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

function updateCursorIndicator() {
  const indicator = ensureCursorIndicator();
  updateViewControlsSuppression();

  const mode = painting?.mode || getInteractionMode();

  if (!active || !cursorState.inViewport || !mode || !indicator) {
    if (indicator) {
      indicator.className = 'mesh-mask-cursor-indicator is-hidden';
      indicator.innerHTML = '';
      indicator.style.width = '';
      indicator.style.height = '';
      indicator.style.transform = '';
    }
    setCanvasCursor('');
    return;
  }

  if (mode === 'component') {
    const countText = cursorState.previewCount
      ? `${cursorState.previewCount.toLocaleString()} new verts`
      : 'hover mesh';
    indicator.className = 'mesh-mask-cursor-indicator is-component';
    indicator.style.width = 'auto';
    indicator.style.height = 'auto';
    indicator.style.transform = `translate(${cursorState.x + 14}px, ${cursorState.y + 14}px)`;
    indicator.innerHTML = `<span>Component</span><small>Shift: LC select · RC unselect · ${countText}</small>`;
    setCanvasCursor('crosshair');
    return;
  }

  const radiusPx = screenBrushRadius(cursorState.hitPoint);
  indicator.className = `mesh-mask-cursor-indicator ${painting?.selected === false ? 'is-remove' : ''}`;
  indicator.innerHTML = '';
  indicator.style.width = `${radiusPx * 2}px`;
  indicator.style.height = `${radiusPx * 2}px`;
  indicator.style.transform = `translate(${cursorState.x}px, ${cursorState.y}px) translate(-50%, -50%)`;
  setCanvasCursor('crosshair');
}

function refreshCursorHitAndPreview(clientX, clientY, selected = (painting?.selected ?? true), mode = (painting?.mode || getInteractionMode())) {
  if (!mode || !cursorState.inViewport) {
    cursorState.hitPoint = null;
    clearPreview();
    return null;
  }

  const hit = raycast({ clientX, clientY }).find(item => (
    item.object?.isMesh && item.object.geometry?.attributes?.position
  ));

  cursorState.hitPoint = hit?.point?.clone?.() || null;
  updatePreviewForHit(hit, selected, mode);
  return hit;
}

function resetCursorIndicator({ remove = false } = {}) {
  cursorState.inViewport = false;
  cursorState.alt = false;
  cursorState.shift = false;
  cursorState.ctrlOrMeta = false;
  cursorState.hitPoint = null;
  cursorState.previewCount = 0;
  painting = null;
  clearPreview();
  setCanvasCursor('');
  restoreViewControls();

  if (!cursorIndicatorEl) return;
  if (remove) {
    cursorIndicatorEl.remove();
    cursorIndicatorEl = null;
  } else {
    cursorIndicatorEl.classList.add('is-hidden');
  }
}

function syncCursorFromEvent(event) {
  if (!event) return;

  const rect = getViewportRect();
  cursorState.x = event.clientX - rect.left;
  cursorState.y = event.clientY - rect.top;
  cursorState.inViewport = (
    cursorState.x >= 0 &&
    cursorState.y >= 0 &&
    cursorState.x <= rect.width &&
    cursorState.y <= rect.height
  );
  cursorState.alt = !!event.altKey;
  cursorState.shift = !!event.shiftKey;
  cursorState.ctrlOrMeta = !!(event.ctrlKey || event.metaKey);

  refreshCursorHitAndPreview(event.clientX, event.clientY);
  updateCursorIndicator();
}

function syncCursorModifiersFromKeyEvent(event) {
  if (!event) return;

  cursorState.alt = !!event.altKey;
  cursorState.shift = !!event.shiftKey;
  cursorState.ctrlOrMeta = !!(event.ctrlKey || event.metaKey);

  if (cursorState.inViewport && getInteractionMode()) {
    const rect = getViewportRect();
    refreshCursorHitAndPreview(rect.left + cursorState.x, rect.top + cursorState.y);
  } else {
    clearPreview();
    cursorState.hitPoint = null;
  }

  updateCursorIndicator();
}

function markCursorOutsideViewport() {
  cursorState.inViewport = false;
  cursorState.hitPoint = null;
  clearPreview();
  updateCursorIndicator();
}

function focusViewportForKeys() {
  const canvas = app.renderer?.domElement;
  if (!canvas) return;

  if (!canvas.hasAttribute('tabindex')) {
    canvas.setAttribute('tabindex', '0');
  }
  canvas.style.outline = 'none';
  canvas.focus?.({ preventScroll: true });
}

function preventTaskEvent(event) {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation?.();
}

function refreshPreviewAtCursor() {
  if (!cursorState.inViewport || !getInteractionMode()) return;

  const rect = getViewportRect();
  refreshCursorHitAndPreview(rect.left + cursorState.x, rect.top + cursorState.y);
}

function setBrushRadius(value) {
  const next = clamp(Number(value), MIN_BRUSH_RADIUS, MAX_BRUSH_RADIUS);
  if (!Number.isFinite(next)) return;

  brushRadius = next;

  const slider = document.getElementById('mesh-mask-brush');
  if (slider) slider.value = String(brushRadius);

  refreshPreviewAtCursor();
  updatePanelStats();
  updateCursorIndicator();
}

function clearMask() {
  return commit('clear mask', () => {
    getCurrentMeshes().forEach(mesh => {
      ensureMeshState(mesh).selected.clear();
    });
  });
}

function invertMask() {
  return commit('invert mask', () => {
    getCurrentMeshes().forEach(mesh => {
      const state = ensureMeshState(mesh);
      const position = mesh.geometry?.attributes?.position;
      if (!position) return;

      const next = new Set();
      for (let i = 0; i < position.count; i++) {
        if (!state.selected.has(i)) next.add(i);
      }
      getActiveMask().selectedByMesh.set(mesh, next);
    });
  });
}

function meshStats(mesh, meshIndex) {
  const position = mesh.geometry?.attributes?.position;
  const localBox = position ? new THREE.Box3().setFromBufferAttribute(position) : new THREE.Box3();
  const worldBox = new THREE.Box3().setFromObject(mesh);
  const state = ensureMeshState(mesh);

  return {
    meshIndex,
    meshUuid: mesh.uuid,
    meshName: getMeshLabel(mesh),
    vertexCount: position?.count || 0,
    triangleCount: getTriangleCount(mesh),
    selectedVertexCount: state.selected.size,
    localBoundingBox: localBox.isEmpty() ? null : {
      min: vectorPayload(localBox.min),
      max: vectorPayload(localBox.max),
      size: vectorPayload(localBox.getSize(new THREE.Vector3())),
    },
    worldBoundingBox: worldBox.isEmpty() ? null : {
      min: vectorPayload(worldBox.min),
      max: vectorPayload(worldBox.max),
      size: vectorPayload(worldBox.getSize(new THREE.Vector3())),
    },
  };
}

function aggregateStats(meshes) {
  const worldBox = app.currentObject ? new THREE.Box3().setFromObject(app.currentObject) : new THREE.Box3();

  return {
    meshCount: meshes.length,
    vertexCount: meshes.reduce((sum, mesh) => sum + (mesh.geometry?.attributes?.position?.count || 0), 0),
    triangleCount: meshes.reduce((sum, mesh) => sum + getTriangleCount(mesh), 0),
    selectedVertexCount: getSelectedCount(),
    maskCount: masks.length,
    activeMaskIndex,
    activeMaskName: maskName(getActiveMask(), activeMaskIndex),
    worldBoundingBox: worldBox.isEmpty() ? null : {
      min: vectorPayload(worldBox.min),
      max: vectorPayload(worldBox.max),
      size: vectorPayload(worldBox.getSize(new THREE.Vector3())),
    },
    meshes: meshes.map(meshStats),
  };
}

function safeFilename(value, fallback = 'mask') {
  const safe = String(value || fallback)
    .trim()
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();

  return safe || fallback;
}

function maskExportPayload(mask, meshes) {
  const perMesh = meshes.map((mesh, meshIndex) => {
    const selectedVertexIndices = Array.from(getMaskSelection(mask, mesh)).sort((a, b) => a - b);

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
    id: mask.id,
    name: maskName(mask, activeMaskIndex),
    selectedVertexCount: perMesh.reduce((sum, entry) => sum + entry.selectedVertexIndices.length, 0),
    meshes: perMesh,
  };
}

function exportJSON() {
  const meshes = getCurrentMeshes();
  if (!meshes.length) return alert('No mesh loaded.');

  const activeMask = getActiveMask();
  const maskPayload = maskExportPayload(activeMask, meshes);

  const payload = {
    format: 'geomy-mesh-mask',
    version: GEOMY_VERSION,
    coordinateSpace: 'mesh-vertex-index',
    selectedColor: `#${SELECTED_COLOR.getHexString()}`,
    unselectedColor: `#${UNSELECTED_COLOR.getHexString()}`,
    brushRadius,
    stats: aggregateStats(meshes),
    mask: maskPayload,
  };

  const filename = `mesh-mask-${safeFilename(maskPayload.name)}.json`;
  downloadBlob(JSON.stringify(payload, null, 2), filename, 'application/json');
}

function parseIndexList(value, vertexCount) {
  if (!Array.isArray(value)) {
    throw new Error('Mask entries must contain a selectedVertexIndices array.');
  }

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

  return { selected, skipped };
}

function findMeshForMask(mask, maskIndex, meshes) {
  if (!mask) return null;

  if (mask.meshUuid) {
    const byUuid = meshes.find(mesh => mesh.uuid === mask.meshUuid);
    if (byUuid) return byUuid;
  }

  if (mask.meshName) {
    const byName = meshes.find(mesh => getMeshLabel(mesh) === mask.meshName || mesh.parent?.name === mask.meshName);
    if (byName) return byName;
  }

  const explicitIndex = Number(mask.meshIndex);
  if (Number.isInteger(explicitIndex) && meshes[explicitIndex]) {
    return meshes[explicitIndex];
  }

  return meshes[maskIndex] || (meshes.length === 1 ? meshes[0] : null);
}

function makeImportedMask(name = null, id = null) {
  const numericId = Number(id);
  const safeId = Number.isInteger(numericId) && numericId > 0
    ? numericId
    : makeImportedMask.nextId++;

  makeImportedMask.nextId = Math.max(makeImportedMask.nextId, safeId + 1);

  return {
    id: safeId,
    name: name || `Imported Mask ${safeId}`,
    selectedByMesh: new Map(),
  };
}

makeImportedMask.nextId = 1;

function assignImportedMesh(mask, meshEntry, meshIndex, meshes) {
  const mesh = findMeshForMask(meshEntry, meshIndex, meshes);
  if (!mesh) {
    return {
      matched: false,
      skipped: Array.isArray(meshEntry?.selectedVertexIndices) ? meshEntry.selectedVertexIndices.length : 1,
    };
  }

  const result = parseIndexList(meshEntry.selectedVertexIndices, mesh.geometry.attributes.position.count);
  mask.selectedByMesh.set(mesh, result.selected);
  return { matched: true, skipped: result.skipped };
}

function parseMaskPayload(payload, sourceName = null) {
  const meshes = getCurrentMeshes();
  if (!meshes.length) throw new Error('Load a mesh before importing masks.');

  const importedMasks = [];
  let skipped = 0;
  makeImportedMask.nextId = Math.max(makeImportedMask.nextId, 1, nextMaskId);

  if (Array.isArray(payload)) {
    if (meshes.length !== 1) {
      throw new Error('A bare vertex-index array can only be imported when one mesh is loaded.');
    }

    const mask = makeImportedMask(sourceName || 'Imported Mask 1');
    const result = parseIndexList(payload, meshes[0].geometry.attributes.position.count);
    mask.selectedByMesh.set(meshes[0], result.selected);
    importedMasks.push(mask);
    skipped += result.skipped;
  } else if (!payload?.mask && (Array.isArray(payload?.selectedVertexIndices) || Array.isArray(payload?.selectedVertices))) {
    if (meshes.length !== 1) {
      throw new Error('A single selectedVertexIndices list can only be imported when one mesh is loaded.');
    }

    const mask = makeImportedMask(payload.name || sourceName || 'Imported Mask 1', payload.id);
    const source = payload.selectedVertexIndices || payload.selectedVertices;
    const result = parseIndexList(source, meshes[0].geometry.attributes.position.count);
    mask.selectedByMesh.set(meshes[0], result.selected);
    importedMasks.push(mask);
    skipped += result.skipped;
  } else if (payload?.mask && Array.isArray(payload.mask?.meshes)) {
    const maskEntry = payload.mask;
    const mask = makeImportedMask(maskEntry.name || payload.name || sourceName || 'Imported Mask 1', maskEntry.id ?? payload.id);

    maskEntry.meshes.forEach((meshEntry, meshIndex) => {
      const result = assignImportedMesh(mask, meshEntry, meshIndex, meshes);
      skipped += result.skipped;
    });

    if (mask.selectedByMesh.size) {
      importedMasks.push(mask);
    }
  } else if (Array.isArray(payload?.masks)) {
    const looksLikeMultiMask = payload.masks.some(mask => Array.isArray(mask?.meshes));

    if (looksLikeMultiMask) {
      payload.masks.forEach((maskEntry, maskIndex) => {
        const mask = makeImportedMask(maskEntry?.name || `${sourceName || 'Imported Mask'} ${maskIndex + 1}`, maskEntry?.id);
        const meshEntries = Array.isArray(maskEntry?.meshes) ? maskEntry.meshes : [];

        meshEntries.forEach((meshEntry, meshIndex) => {
          const result = assignImportedMesh(mask, meshEntry, meshIndex, meshes);
          skipped += result.skipped;
        });

        if (mask.selectedByMesh.size) {
          importedMasks.push(mask);
        }
      });
    } else {
      // Backward compatibility with the previous single-mask export where
      // payload.masks was a per-mesh list, not a list of named masks.
      const mask = makeImportedMask(payload.name || sourceName || 'Imported Mask 1', payload.id);

      payload.masks.forEach((meshEntry, meshIndex) => {
        const result = assignImportedMesh(mask, meshEntry, meshIndex, meshes);
        skipped += result.skipped;
      });

      if (mask.selectedByMesh.size) {
        importedMasks.push(mask);
      }
    }
  } else {
    throw new Error('This JSON does not contain mesh masks.');
  }

  if (!importedMasks.length) {
    throw new Error('No valid mask data matched the current mesh.');
  }

  const payloadActiveIndex = Number(payload?.activeMaskIndex);
  const nextActiveIndex = Number.isInteger(payloadActiveIndex)
    ? clamp(payloadActiveIndex, 0, importedMasks.length - 1)
    : 0;

  return { masks: importedMasks, activeMaskIndex: nextActiveIndex, skipped };
}

function sourceNameFromFile(file, fallback = 'Imported Mask') {
  const name = String(file?.name || fallback).replace(/\.json$/i, '').trim();
  return name || fallback;
}

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

async function importJSONFiles(fileList) {
  const files = Array.from(fileList || []).filter(Boolean);
  if (!files.length) return;

  const importedMasks = [];
  const failures = [];
  let skipped = 0;

  makeImportedMask.nextId = Math.max(1, nextMaskId, Math.max(0, ...masks.map(mask => mask.id)) + 1);

  for (const file of files) {
    try {
      const payload = await readJSONFile(file);
      const result = parseMaskPayload(payload, sourceNameFromFile(file));
      importedMasks.push(...result.masks);
      skipped += result.skipped;
    } catch (error) {
      console.error('Failed to import mesh mask:', file?.name, error);
      failures.push(`${file?.name || 'JSON file'}: ${error?.message || 'failed to import'}`);
    }
  }

  if (importedMasks.length) {
    commit('import mesh masks', () => {
      ensureDefaultMask();
      masks.push(...importedMasks);
      activeMaskIndex = masks.length - importedMasks.length;
      nextMaskId = Math.max(1, Math.max(0, ...masks.map(mask => mask.id)) + 1);
    }, { renderMasks: true });
  }

  const input = document.getElementById('mesh-mask-import-file');
  if (input) input.value = '';

  if (failures.length || skipped > 0) {
    const parts = [];

    if (importedMasks.length) {
      parts.push(`Imported ${importedMasks.length} mask${importedMasks.length === 1 ? '' : 's'}.`);
    }

    if (skipped > 0) {
      parts.push(`Skipped ${skipped} invalid or unmatched entr${skipped === 1 ? 'y' : 'ies'}.`);
    }

    if (failures.length) {
      parts.push(`Failed file${failures.length === 1 ? '' : 's'}:\n${failures.join('\n')}`);
    }

    alert(parts.join('\n\n'));
  } else if (!importedMasks.length) {
    alert('No valid mask data matched the current mesh.');
  }
}

function finishPaintingGesture(event = null) {
  if (!painting) return;

  const before = painting.before;
  const changed = painting.changed || snapshotKey(before) !== snapshotKey(makeSnapshot());
  painting = null;

  if (changed) {
    pushUndoSnapshot(before);
  }

  if (event && cursorState.alt && cursorState.inViewport) {
    refreshCursorHitAndPreview(event.clientX, event.clientY, true);
  }

  updatePanelStats();
  updateCursorIndicator();
}

function onPointerDown(event) {
  if (!active) return;
  syncCursorFromEvent(event);

  const isLeft = event.button === 0;
  const isRight = event.button === 2;
  const wantsComponent = !event.altKey && event.shiftKey;

  if (wantsComponent && (isLeft || isRight)) {
    preventTaskEvent(event);
    focusViewportForKeys();
    paintSingleHit(event, isLeft, 'component');
    return;
  }

  if (event.altKey && (isLeft || isRight)) {
    preventTaskEvent(event);
    painting = {
      pointerId: event.pointerId,
      selected: isLeft,
      mode: 'brush',
      before: makeSnapshot(),
      changed: false,
    };
    focusViewportForKeys();
    updateCursorIndicator();
    painting.changed = paintFromEvent(event, isLeft, 'brush') > 0;
    return;
  }

  if (event.altKey || event.shiftKey) {
    preventTaskEvent(event);
  }
}

function onPointerMove(event) {
  if (!active) return;
  syncCursorFromEvent(event);

  if (painting && painting.pointerId === event.pointerId) {
    preventTaskEvent(event);
    painting.changed = paintFromEvent(event, painting.selected, painting.mode || 'brush') > 0 || painting.changed;
  }
}

function onPointerUp(event) {
  if (!active) return;
  syncCursorFromEvent(event);

  if (painting && painting.pointerId === event.pointerId) {
    preventTaskEvent(event);
    finishPaintingGesture(event);
  }
}

function onContextMenu(event) {
  if (!active) return;
  if (event.altKey || event.shiftKey || painting) preventTaskEvent(event);
}

function onWheel(event) {
  if (!active) return;
  if (!event.altKey) return;

  preventTaskEvent(event);

  const scale = event.deltaY < 0 ? 1.12 : 0.88;
  setBrushRadius(brushRadius * scale);
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
  }
}

function onKeyUp(event) {
  if (!active) return;
  syncCursorModifiersFromKeyEvent(event);
}

function onWindowBlur() {
  resetCursorIndicator();
}

function bindViewportEvents() {
  const canvas = app.renderer.domElement;
  const viewport = app.dom.viewport;

  canvas.setAttribute('tabindex', '0');
  canvas.style.outline = 'none';
  ensureCursorIndicator();

  viewport.addEventListener('pointerdown', focusViewportForKeys, true);
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

  viewport?.removeEventListener('pointerdown', focusViewportForKeys, true);
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

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderMaskList() {
  const list = document.getElementById('mesh-mask-list');
  if (!list) return;

  ensureDefaultMask();

  list.innerHTML = masks.map((mask, index) => {
    const selected = getMaskSelectedCount(mask);
    const classes = [
      'mesh-mask-row',
      index === activeMaskIndex ? 'selected' : '',
    ].filter(Boolean).join(' ');

    return `
      <div class="${classes}" data-idx="${index}" draggable="true">
        <span class="drag-handle" title="Drag to reorder">⋮⋮</span>
        <span class="idx" title="Mask order">#${index + 1}</span>
        <input class="mesh-mask-name" data-idx="${index}" value="${escapeHtml(maskName(mask, index))}" title="Mask name">
        <span class="mesh-mask-row-count" data-mask-count="${index}">${selected.toLocaleString()} selected</span>
        <button class="btn-mask-delete btn-icon" data-idx="${index}" title="Remove mask" aria-label="Remove mask">×</button>
      </div>`;
  }).join('');

  list.querySelectorAll('.mesh-mask-row').forEach(row => {
    const index = parseInt(row.dataset.idx, 10);

    row.addEventListener('click', event => {
      if (event.target.closest('input,button')) return;
      setActiveMaskIndex(index);
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
      moveMask(fromIndex, index);
    });
  });

  list.querySelectorAll('.mesh-mask-name').forEach(input => {
    input.addEventListener('click', event => event.stopPropagation());
    input.addEventListener('change', () => {
      renameMask(parseInt(input.dataset.idx, 10), input.value);
    });
  });

  list.querySelectorAll('.btn-mask-delete').forEach(button => {
    button.addEventListener('click', event => {
      event.stopPropagation();
      removeMask(parseInt(button.dataset.idx, 10));
    });
  });

  updateMaskListState();
}

function updateMaskListState() {
  const list = document.getElementById('mesh-mask-list');
  if (!list) return;

  list.querySelectorAll('.mesh-mask-row').forEach(row => {
    const index = parseInt(row.dataset.idx, 10);
    row.classList.toggle('selected', index === activeMaskIndex);
  });

  list.querySelectorAll('[data-mask-count]').forEach(el => {
    const index = parseInt(el.dataset.maskCount, 10);
    const mask = masks[index];
    if (!mask) return;
    el.textContent = `${getMaskSelectedCount(mask).toLocaleString()} selected`;
  });
}

function renderPanel() {
  ensureDefaultMask();

  app.dom.taskContent.innerHTML = `
    <div class="task-heading">
      <h3>Mesh Masking</h3>
      <span class="task-help" tabindex="0" data-tip="This task uses a Lambert vertex-color view. Hold Alt to paint: left-drag selects, right-drag unselects. Hold Shift for connected components. Alt+wheel changes brush width. Ctrl+Z/Y undo/redo.">?</span>
    </div>

    <div class="section-title">Edit Active Mask</div>
    <div class="task-edit-compact">
      <button id="btn-mesh-mask-clear" class="btn btn-danger">Clear</button>
      <button id="btn-mesh-mask-invert" class="btn">Invert</button>
    </div>

    <div class="section-title">Brush Width (world)</div>
    <div class="range-row">
      <input type="range" id="mesh-mask-brush" min="${MIN_BRUSH_RADIUS}" max="${MAX_BRUSH_RADIUS}" step="0.001" value="${brushRadius}">
      <span class="range-val" id="mesh-mask-brush-val">${brushRadius.toFixed(3)}</span>
    </div>


    <div class="section-title">Masks</div>
    <div class="btn-row mesh-mask-io-row">
      <button id="btn-mesh-mask-add" class="btn">＋ Add Mask</button>
    </div>
    <div id="mesh-mask-list" class="mesh-mask-list"></div>

    <div class="section-title">Active Mask</div>
    <div class="mesh-mask-option-group">
      <div class="mesh-mask-stat"><span>Name</span><span id="mesh-mask-active-name">${escapeHtml(maskName(getActiveMask(), activeMaskIndex))}</span></div>
      <div class="mesh-mask-stat"><span>Selection</span><span id="mesh-mask-selected-count">0 selected</span></div>
      <div class="mesh-mask-stat"><span>Mesh size</span><span id="mesh-mask-total-count">0 verts</span></div>
      <div class="mesh-mask-stat"><span>Masks</span><span id="mesh-mask-count">${masks.length} mask${masks.length === 1 ? '' : 's'}</span></div>
    </div>

    <div class="section-title section-title-with-help">
      <span>Save / Load</span>
      <span class="section-help" tabindex="0" data-tip="Export saves the active mask only. Import can load one or more JSON masks and appends them to the list.">?</span>
    </div>
    <div class="btn-row mesh-mask-io-row">
      <button id="btn-mesh-mask-import" class="btn">Import JSON</button>
      <button id="btn-mesh-mask-export" class="btn btn-export">Export JSON</button>
    </div>
    <input id="mesh-mask-import-file" class="mesh-mask-file-input" type="file" accept=".json,application/json" multiple>
  `;

  const brushSlider = document.getElementById('mesh-mask-brush');
  brushSlider?.addEventListener('input', () => setBrushRadius(brushSlider.value));

  document.getElementById('btn-mesh-mask-add')?.addEventListener('click', addMask);
  document.getElementById('btn-mesh-mask-clear')?.addEventListener('click', () => {
    if (getSelectedCount() === 0 || window.confirm('Clear the active mask?')) clearMask();
  });
  document.getElementById('btn-mesh-mask-invert')?.addEventListener('click', invertMask);
  document.getElementById('btn-mesh-mask-export')?.addEventListener('click', exportJSON);

  const importInput = document.getElementById('mesh-mask-import-file');
  document.getElementById('btn-mesh-mask-import')?.addEventListener('click', () => importInput?.click());
  importInput?.addEventListener('change', () => importJSONFiles(importInput.files));

  renderMaskList();
  updatePanelStats();
}

function resetForNewFile() {
  clearPreview();
  restoreRenderBackup({ disposeOriginals: true });
  componentIndex.reset();
  masks = [];
  activeMaskIndex = 0;
  nextMaskId = 1;
  ensureDefaultMask();
  painting = null;
  clearHistory();
}

export const meshMaskingTask = {
  id: 'mask',

  onDblClick() {
    return false;
  },

  activate() {
    active = true;
    ensureDefaultMask();
    setMaterialPanelHidden(true);
    setSmoothShadingForMask(true);
    renderPanel();
    applyMaskRenderMode();
    bindViewportEvents();
    updatePanelStats();
  },

  deactivate() {
    active = false;
    finishPaintingGesture();
    painting = null;
    unbindViewportEvents();
    restoreViewControls();
    restoreRenderBackup();
    setMaskLightsVisible(false);
    setMaterialPanelHidden(false);
    setSmoothShadingForMask(false);
    restoreVisualizationRenderMode();
    app.dom.taskContent.innerHTML = '';
  },

  onFileLoaded() {
    resetForNewFile();
    if (active) {
      applyMaskRenderMode();
      renderPanel();
    }
  },
};