import * as THREE from 'three';
import { app } from '../app.js';
import { HistoryStack } from '../core/HistoryStack.js';
import { GEOMY_VERSION } from '../version.js';
import { raycast, downloadBlob } from '../util.js';
import { downloadArrayBundle, jsonEntry, npyEntry, parseBundleArrays, readArrayBundle } from '../io/numpyBundle.js';
import {
  BrushSphereIndicator,
  MeshComponentIndex,
  MeshRenderBackup,
  TemporaryVisualizationState,
  clamp,
  collectHitVertexIndices as collectHitVertices,
  disposeMaterialOrArray as disposeMaterial,
  ensureColorAttribute as colorAttributeFor,
  getCanonicalVertexCount,
  getCurrentMeshes as meshes,
  getMeshLabel as meshName,
  getTriangleCount as triangleCount,
  isTextInputTarget,
  restoreVisualizationRenderMode as restoreSharedVisualizationRenderMode,
  setVertexColor as setColor,
} from './meshTaskUtils.js';
import {
  collectPrecomputedGeodesicBrushVertexIndices,
  geodesicBrushMemoryEstimateBytes,
  geodesicBrushStatus,
  precomputeGeodesicBrush,
} from './geodesicBrushLut.js';
import '../css/meshMasking.css';
import '../css/meshSegmentation.css';

const TASK_RENDER_OVERRIDE = 'mesh-segmentation';
const NONE = 0;
const NONE_COLOR = new THREE.Color('#788395');
const CLEAR_PREVIEW_COLOR = new THREE.Color('#d8dee9');
const DEFAULT_BRUSH_RADIUS = 28;
const MIN_BRUSH_RADIUS = 2;
const MAX_BRUSH_RADIUS = 220;
const STACK_LIMIT = 100;

let active = false;
let brushRadius = DEFAULT_BRUSH_RADIUS;
let useGeodesicBrush = false;
let geodesicBrushRequestId = 0;
let regions = [];
let activeRegionIndex = 0;
let nextRegionId = 1;
let painting = null;
let cursorIndicatorEl = null;
let brushSphereIndicator = null;
let lights = [];
let controlsSuppressed = false;
let controlsPreviousEnabled = true;
let suppressedControls = null;

const assignmentsByMesh = new Map();
const previewedVertices = new Map();
const visualizationState = new TemporaryVisualizationState();
const renderBackup = new MeshRenderBackup({ clearPreview, disposeMaterial });
const componentIndex = new MeshComponentIndex();
const history = new HistoryStack({ limit: STACK_LIMIT });

const cursor = {
  x: 0,
  y: 0,
  inViewport: false,
  alt: false,
  shift: false,
  hitPoint: null,
  previewCount: 0,
};

let colorEditState = null;

const REGION_COLOR_POOL = [
  '#0072b2',
  '#d55e00',
  '#009e73',
  '#cc79a7',
  '#e69f00',
  '#56b4e9',
  '#f0e442',
  '#332288',
  '#882255',
  '#44aa99',
  '#117733',
  '#aa4499',
];

function normalizeColor(value, fallback = '#888888') {
  const raw = String(value || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toLowerCase();
  if (/^[0-9a-f]{6}$/i.test(raw)) return `#${raw.toLowerCase()}`;
  return fallback;
}

function defaultRegionColor(regionId) {
  const poolIndex = regionId - 1;

  if (poolIndex >= 0 && poolIndex < REGION_COLOR_POOL.length) {
    return REGION_COLOR_POOL[poolIndex];
  }

  const color = new THREE.Color();
  color.setHSL(((regionId * 0.618033988749895) % 1 + 1) % 1, 0.72, 0.56);
  return `#${color.getHexString()}`;
}

function makeRegion(name = null, color = null, id = null) {
  const explicitId = Number(id);
  const regionId = Number.isInteger(explicitId) && explicitId > 0 ? explicitId : nextRegionId++;
  nextRegionId = Math.max(nextRegionId, regionId + 1);

  return {
    id: regionId,
    name: name || `Region ${regionId}`,
    color: normalizeColor(color || defaultRegionColor(regionId)),
  };
}

function ensureRegion() {
  if (!regions.length) {
    regions.push(makeRegion('Region 1'));
    activeRegionIndex = 0;
  }

  activeRegionIndex = clamp(activeRegionIndex, 0, regions.length - 1);
  return regions[activeRegionIndex];
}

function activeRegion() {
  return ensureRegion();
}

function regionName(region, index = 0) {
  return String(region?.name || '').trim() || `Region ${index + 1}`;
}

function regionById(id) {
  return regions.find(region => region.id === id) || null;
}

function colorForRegionId(regionId) {
  if (regionId === NONE) return NONE_COLOR;
  const region = regionById(regionId);
  return region ? new THREE.Color(region.color) : NONE_COLOR;
}

function assignmentFor(mesh) {
  const vertexCount = getCanonicalVertexCount(mesh);
  if (!mesh || !vertexCount) return null;

  let assignment = assignmentsByMesh.get(mesh);
  if (!assignment || assignment.length !== vertexCount) {
    const next = new Int32Array(vertexCount);
    if (assignment) next.set(assignment.slice(0, Math.min(assignment.length, next.length)));
    assignment = next;
    assignmentsByMesh.set(mesh, assignment);
  }

  return assignment;
}

function repaintMesh(mesh) {
  const assignment = assignmentFor(mesh);
  const color = colorAttributeFor(mesh);
  if (!assignment || !color) return;

  for (let i = 0; i < assignment.length; i++) {
    setColor(color, i, colorForRegionId(assignment[i]));
  }

  color.needsUpdate = true;
}

function repaintAll() {
  meshes().forEach(repaintMesh);
}

function totalVertexCount() {
  return meshes().reduce((sum, mesh) => sum + getCanonicalVertexCount(mesh), 0);
}

function assignedVertexCount() {
  let count = 0;

  meshes().forEach(mesh => {
    const assignment = assignmentFor(mesh);
    if (!assignment) return;

    for (let i = 0; i < assignment.length; i++) {
      if (assignment[i] !== NONE) count += 1;
    }
  });

  return count;
}

function regionVertexCount(region = activeRegion()) {
  const id = region?.id;
  if (!id) return 0;
  let count = 0;

  meshes().forEach(mesh => {
    const assignment = assignmentFor(mesh);
    if (!assignment) return;

    for (let i = 0; i < assignment.length; i++) {
      if (assignment[i] === id) count += 1;
    }
  });

  return count;
}

function clearPreview() {
  previewedVertices.forEach((indices, mesh) => {
    const assignment = assignmentFor(mesh);
    const color = colorAttributeFor(mesh);
    if (!assignment || !color) return;

    indices.forEach(index => setColor(color, index, colorForRegionId(assignment[index])));
    color.needsUpdate = true;
  });

  previewedVertices.clear();
  cursor.previewCount = 0;
}

function setMaterialPanelHidden(hidden) {
  visualizationState.setMaterialPanelHidden(hidden);
}

function setSmoothShadingForTask(enabled) {
  visualizationState.setSmoothShadingDisabled(enabled);
}
function ensureLights() {
  lights = lights.filter(light => light?.parent);
  if (lights.length) {
    lights.forEach(light => { light.visible = active; });
    return;
  }

  const hemi = new THREE.HemisphereLight(0xffffff, 0x303060, 1.7);
  const key = new THREE.DirectionalLight(0xffffff, 2.0);
  hemi.name = 'geomy-segmentation-hemi-light';
  key.name = 'geomy-segmentation-key-light';
  key.position.set(2, 3, 4);
  lights = [hemi, key];
  lights.forEach(light => {
    light.visible = active;
    app.scene.add(light);
  });
}

function setLightsVisible(visible) {
  lights.forEach(light => { light.visible = visible; });
}

function makeSegmentationMaterial() {
  const material = new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    flatShading: true,
  });

  material.name = 'geomy-segmentation-lambert-material';
  material.toneMapped = false;
  return material;
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
function applyRenderMode() {
  app.renderOverride = TASK_RENDER_OVERRIDE;
  if (app.scene) app.scene.environment = null;

  ensureLights();
  setLightsVisible(true);

  meshes().forEach(mesh => {
    captureRenderBackup(mesh);
    assignmentFor(mesh);
    repaintMesh(mesh);

    const previous = mesh.material;
    const original = renderBackup.getOriginalMaterial(mesh);
    mesh.material = makeSegmentationMaterial();
    if (previous && previous !== original) disposeMaterial(previous);
  });
}

function hitIndices(hit, mode) {
  if (mode === 'brush' && useGeodesicBrush) {
    const geodesic = collectPrecomputedGeodesicBrushVertexIndices(hit, brushRadius);
    if (geodesic !== null) return geodesic;
  }

  return collectHitVertices(hit, { mode, brushRadius, componentIndex, screenSpace: true });
}
function applyRegionToVertex(mesh, index, regionId) {
  const assignment = assignmentFor(mesh);
  if (!assignment || index < 0 || index >= assignment.length || assignment[index] === regionId) return false;

  assignment[index] = regionId;
  const color = colorAttributeFor(mesh);
  if (color) {
    setColor(color, index, colorForRegionId(regionId));
    color.needsUpdate = true;
  }
  return true;
}

function previewHit(hit, regionId, mode) {
  clearPreview();

  const mesh = hit?.object;
  if (!active || !mode || !cursor.inViewport || !mesh?.isMesh) return;

  const assignment = assignmentFor(mesh);
  const color = colorAttributeFor(mesh);
  if (!assignment || !color) return;

  const indices = hitIndices(hit, mode).filter(index => assignment[index] !== regionId);
  if (!indices.length) return;

  const previewColor = regionId === NONE
    ? CLEAR_PREVIEW_COLOR
    : colorForRegionId(regionId).lerp(new THREE.Color('#ffffff'), 0.35);

  indices.forEach(index => setColor(color, index, previewColor));
  color.needsUpdate = true;
  previewedVertices.set(mesh, new Set(indices));
  cursor.previewCount = indices.length;
}

function assignHit(hit, regionId, mode) {
  const mesh = hit?.object;
  if (!mesh?.isMesh || !mesh.geometry?.attributes?.position) return 0;

  let changed = 0;
  hitIndices(hit, mode).forEach(index => {
    if (applyRegionToVertex(mesh, index, regionId)) changed += 1;
  });
  if (changed) updatePanelStats();
  return changed;
}

function raycastMesh(event) {
  return raycast(event).find(hit => hit.object?.isMesh && hit.object.geometry?.attributes?.position) || null;
}

function assignFromEvent(event, regionId, mode) {
  clearPreview();
  const hit = raycastMesh(event);
  if (!hit) {
    cursor.hitPoint = null;
    updateCursor();
    return 0;
  }

  const changed = assignHit(hit, regionId, mode);
  cursor.hitPoint = hit.point.clone();
  previewHit(hit, regionId, mode);
  updateCursor();
  return changed;
}

function sparseAssignments(mesh) {
  const assignment = assignmentFor(mesh);
  const assigned = [];
  if (!assignment) return assigned;

  for (let i = 0; i < assignment.length; i++) {
    if (assignment[i] !== NONE) assigned.push([i, assignment[i]]);
  }
  return assigned;
}

function snapshot() {
  ensureRegion();
  return {
    activeRegionIndex,
    nextRegionId,
    regions: regions.map(region => ({ id: region.id, name: regionName(region), color: region.color })),
    assignments: meshes().map(mesh => ({ mesh, assigned: sparseAssignments(mesh) })),
  };
}

function snapshotKey(data) {
  return JSON.stringify({
    activeRegionIndex: data.activeRegionIndex,
    nextRegionId: data.nextRegionId,
    regions: data.regions,
    assignments: data.assignments.map(entry => [entry.mesh.uuid, entry.assigned]),
  });
}

function restoreSnapshot(data) {
  clearPreview();
  nextRegionId = data.nextRegionId || 1;
  regions = data.regions.map(region => makeRegion(region.name, region.color, region.id));
  if (!regions.length) regions.push(makeRegion('Region 1'));

  assignmentsByMesh.clear();
  data.assignments.forEach(entry => {
    const count = entry.mesh?.geometry?.attributes?.position?.count || 0;
    if (!count) return;
    const assignment = new Int32Array(count);
    entry.assigned.forEach(([rawIndex, rawRegionId]) => {
      const index = Number(rawIndex);
      const regionId = Number(rawRegionId);
      if (Number.isInteger(index) && index >= 0 && index < count && regionById(regionId)) {
        assignment[index] = regionId;
      }
    });
    assignmentsByMesh.set(entry.mesh, assignment);
  });

  activeRegionIndex = clamp(data.activeRegionIndex ?? 0, 0, regions.length - 1);
  nextRegionId = Math.max(nextRegionId, Math.max(0, ...regions.map(region => region.id)) + 1);
  renderRegionList();
  repaintAll();
  updatePanelStats();
}

function pushUndo(data) {
  history.record(data);
}

function commit(label, mutate, { renderRegions = false } = {}) {
  const before = snapshot();
  clearPreview();
  mutate();
  ensureRegion();

  const changed = snapshotKey(before) !== snapshotKey(snapshot());
  if (changed) {
    pushUndo(before);
  }

  if (renderRegions) renderRegionList();
  repaintAll();
  updatePanelStats();
  return changed;
}

function undo() {
  if (history.canUndo) {
    history.undo(snapshot(), restoreSnapshot);
  }
}

function redo() {
  if (history.canRedo) {
    history.redo(snapshot(), restoreSnapshot);
  }
}

function clearHistory() {
  history.clear();
  updateStackButtons();
}

function buttonRegionId(isLeft) {
  return isLeft ? activeRegion().id : NONE;
}

function assignOne(event, regionId, mode) {
  const before = snapshot();
  const changed = assignFromEvent(event, regionId, mode) > 0;
  if (changed) {
    pushUndo(before);
  }
  updatePanelStats();
  return changed;
}

function finishPainting(event = null) {
  if (!painting) return;

  const before = painting.before;
  const regionId = painting.regionId;
  const changed = painting.changed || snapshotKey(before) !== snapshotKey(snapshot());
  painting = null;

  if (changed) {
    pushUndo(before);
  }

  if (event && cursor.alt && cursor.inViewport) {
    refreshHover(event.clientX, event.clientY, regionId, 'brush');
  }

  updatePanelStats();
  updateCursor();
}

function interactionMode() {
  if (cursor.alt) return 'brush';
  if (cursor.shift) return 'component';
  return null;
}

function screenBrushRadius() {
  const rect = app.dom.viewport.getBoundingClientRect();
  return clamp(brushRadius, MIN_BRUSH_RADIUS, Math.max(MIN_BRUSH_RADIUS, rect.width || MAX_BRUSH_RADIUS, rect.height || MAX_BRUSH_RADIUS));
}

function ensureCursor() {
  const viewport = app.dom?.viewport;
  if (!viewport) return null;
  if (cursorIndicatorEl?.parentElement === viewport) return cursorIndicatorEl;

  cursorIndicatorEl?.remove?.();
  cursorIndicatorEl = document.createElement('div');
  cursorIndicatorEl.className = 'mesh-mask-cursor-indicator mesh-seg-cursor-indicator is-hidden';
  cursorIndicatorEl.setAttribute('aria-hidden', 'true');
  viewport.appendChild(cursorIndicatorEl);
  return cursorIndicatorEl;
}


function ensureBrushSphereIndicator() {
  if (!brushSphereIndicator) {
    brushSphereIndicator = new BrushSphereIndicator({ name: 'mesh-seg-brush-sphere' });
  }
  return brushSphereIndicator;
}

function hideBrushSphereIndicator({ dispose = false } = {}) {
  if (!brushSphereIndicator) return;
  if (dispose) {
    brushSphereIndicator.dispose();
    brushSphereIndicator = null;
  } else {
    brushSphereIndicator.hide();
  }
}

function setCanvasCursor(value = '') {
  const canvas = app.renderer?.domElement;
  if (canvas) canvas.style.cursor = value;
}

function restoreControls() {
  if (!controlsSuppressed) return;
  if (suppressedControls) suppressedControls.enabled = controlsPreviousEnabled;
  controlsSuppressed = false;
  controlsPreviousEnabled = true;
  suppressedControls = null;
}

function updateControlsSuppression() {
  const controls = app.controls;
  const shouldSuppress = active && controls && (painting || (cursor.inViewport && interactionMode()));
  if (!controls || !shouldSuppress) {
    restoreControls();
    return;
  }

  if (suppressedControls && suppressedControls !== controls) {
    suppressedControls.enabled = controlsPreviousEnabled;
    controlsSuppressed = false;
  }

  if (!controlsSuppressed) {
    suppressedControls = controls;
    controlsPreviousEnabled = controls.enabled !== false;
    controlsSuppressed = true;
  }

  controls.enabled = false;
}

function updateCursor() {
  const indicator = ensureCursor();
  updateControlsSuppression();

  const mode = painting?.mode || interactionMode();
  const regionId = painting?.regionId ?? activeRegion().id;
  if (!active || !cursor.inViewport || !mode || !indicator) {
    if (indicator) {
      indicator.className = 'mesh-mask-cursor-indicator mesh-seg-cursor-indicator is-hidden';
      indicator.innerHTML = '';
      indicator.style.width = '';
      indicator.style.height = '';
      indicator.style.transform = '';
    }
    hideBrushSphereIndicator();
    setCanvasCursor('');
    return;
  }

  if (mode === 'component') {
    const action = regionId === NONE ? 'clear' : 'assign';
    const count = cursor.previewCount ? `${cursor.previewCount.toLocaleString()} changing verts` : 'hover mesh';
    indicator.className = 'mesh-mask-cursor-indicator mesh-seg-cursor-indicator is-component';
    indicator.style.width = 'auto';
    indicator.style.height = 'auto';
    indicator.style.transform = `translate(${cursor.x + 14}px, ${cursor.y + 14}px)`;
    indicator.innerHTML = `<span>Component</span><small>Shift: LC assign · RC clear · ${action} · ${count}</small>`;
    hideBrushSphereIndicator();
    setCanvasCursor('crosshair');
    return;
  }

  const radiusPx = screenBrushRadius();

  if (useGeodesicBrush) {
    hideBrushSphereIndicator();
    indicator.className = `mesh-mask-cursor-indicator mesh-seg-cursor-indicator ${regionId === NONE ? 'is-remove' : ''}`;
    indicator.innerHTML = '';
    indicator.style.width = `${radiusPx * 2}px`;
    indicator.style.height = `${radiusPx * 2}px`;
    indicator.style.transform = `translate(${cursor.x}px, ${cursor.y}px) translate(-50%, -50%)`;
    setCanvasCursor('crosshair');
    return;
  }

  const radiusWorld = screenRadiusToWorldRadius({ point: cursor.hitPoint }, radiusPx);
  indicator.className = 'mesh-mask-cursor-indicator mesh-seg-cursor-indicator is-hidden';
  indicator.innerHTML = '';
  indicator.style.width = '';
  indicator.style.height = '';
  indicator.style.transform = '';
  ensureBrushSphereIndicator().set(cursor.hitPoint, radiusWorld, { remove: regionId === NONE });
  setCanvasCursor('crosshair');
}

function refreshHover(clientX, clientY, regionId = (painting?.regionId ?? activeRegion().id), mode = (painting?.mode || interactionMode())) {
  if (!mode || !cursor.inViewport) {
    cursor.hitPoint = null;
    clearPreview();
    return null;
  }

  const hit = raycastMesh({ clientX, clientY });
  cursor.hitPoint = hit?.point?.clone?.() || null;
  previewHit(hit, regionId, mode);
  return hit;
}

function syncCursor(event) {
  if (!event) return;

  const rect = app.dom.viewport.getBoundingClientRect();
  cursor.x = event.clientX - rect.left;
  cursor.y = event.clientY - rect.top;
  cursor.inViewport = cursor.x >= 0 && cursor.y >= 0 && cursor.x <= rect.width && cursor.y <= rect.height;
  cursor.alt = !!event.altKey;
  cursor.shift = !!event.shiftKey;

  refreshHover(event.clientX, event.clientY);
  updateCursor();
}

function syncModifiers(event) {
  if (!event) return;
  cursor.alt = !!event.altKey;
  cursor.shift = !!event.shiftKey;

  if (cursor.inViewport && interactionMode()) {
    const rect = app.dom.viewport.getBoundingClientRect();
    refreshHover(rect.left + cursor.x, rect.top + cursor.y);
  } else {
    cursor.hitPoint = null;
    clearPreview();
  }

  updateCursor();
}

function markOutside() {
  cursor.inViewport = false;
  cursor.hitPoint = null;
  clearPreview();
  updateCursor();
}

function resetCursor({ remove = false } = {}) {
  cursor.inViewport = false;
  cursor.alt = false;
  cursor.shift = false;
  cursor.hitPoint = null;
  cursor.previewCount = 0;
  painting = null;
  clearPreview();
  setCanvasCursor('');
  restoreControls();
  hideBrushSphereIndicator({ dispose: remove });

  if (!cursorIndicatorEl) return;
  if (remove) {
    cursorIndicatorEl.remove();
    cursorIndicatorEl = null;
  } else {
    cursorIndicatorEl.classList.add('is-hidden');
  }
}

function setBrushRadius(value) {
  const next = clamp(Number(value), MIN_BRUSH_RADIUS, MAX_BRUSH_RADIUS);
  if (!Number.isFinite(next)) return;

  brushRadius = next;
  const slider = document.getElementById('mesh-seg-brush');
  if (slider) slider.value = String(Math.round(brushRadius));

  if (cursor.inViewport && interactionMode()) {
    const rect = app.dom.viewport.getBoundingClientRect();
    refreshHover(rect.left + cursor.x, rect.top + cursor.y);
  }
  updatePanelStats();
  updateCursor();
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${Math.ceil(mb).toLocaleString()} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

function updateGeodesicBrushStatus() {
  const statusEl = document.getElementById('mesh-seg-geodesic-status');
  const progressEl = document.getElementById('mesh-seg-geodesic-progress');
  if (!statusEl && !progressEl) return;

  const status = geodesicBrushStatus(meshes());
  const percent = Math.round((status.progress || 0) * 100);
  const activeLabel = useGeodesicBrush
    ? (status.ready ? status.label : `${status.label} · screen brush until ready`)
    : 'Screen brush active';

  if (statusEl) statusEl.textContent = activeLabel;
  if (progressEl) {
    progressEl.value = percent;
    progressEl.style.display = status.building ? 'block' : 'none';
  }
}

async function setUseGeodesicBrush(value) {
  const nextEnabled = !!value;
  const requestId = ++geodesicBrushRequestId;
  const checkbox = document.getElementById('mesh-seg-geodesic-brush');

  useGeodesicBrush = nextEnabled;
  if (checkbox) checkbox.checked = useGeodesicBrush;
  updateGeodesicBrushStatus();
  if (cursor.inViewport && interactionMode()) {
    const rect = app.dom.viewport.getBoundingClientRect();
    refreshHover(rect.left + cursor.x, rect.top + cursor.y);
  }
  updateCursor();

  if (!nextEnabled) return;

  const currentMeshes = meshes();
  if (!currentMeshes.length) {
    alert('Load a mesh before enabling the geodesic brush.');
    if (requestId === geodesicBrushRequestId) {
      useGeodesicBrush = false;
      if (checkbox) checkbox.checked = false;
      updateGeodesicBrushStatus();
    }
    return;
  }

  try {
    const ok = await precomputeGeodesicBrush(currentMeshes, {
      confirmLarge(totalVertices) {
        const bytes = geodesicBrushMemoryEstimateBytes(totalVertices);
        return window.confirm(`This mesh has ${totalVertices.toLocaleString()} vertices. All-pairs geodesic precompute can take a while and needs about ${formatBytes(bytes)} for the LUT. Continue?`);
      },
      onProgress: updateGeodesicBrushStatus,
    });

    if (requestId !== geodesicBrushRequestId) return;
    if (!ok) {
      useGeodesicBrush = false;
      if (checkbox) checkbox.checked = false;
    }
  } catch (error) {
    console.error(error);
    if (requestId === geodesicBrushRequestId) {
      useGeodesicBrush = false;
      if (checkbox) checkbox.checked = false;
      alert(error?.message || 'Geodesic brush precompute failed.');
    }
  } finally {
    if (requestId === geodesicBrushRequestId) {
      updateGeodesicBrushStatus();
      if (cursor.inViewport && interactionMode()) {
        const rect = app.dom.viewport.getBoundingClientRect();
        refreshHover(rect.left + cursor.x, rect.top + cursor.y);
      }
      updateCursor();
    }
  }
}

function preventTaskEvent(event) {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation?.();
}

function focusViewport() {
  const canvas = app.renderer?.domElement;
  if (!canvas) return;
  canvas.setAttribute('tabindex', '0');
  canvas.style.outline = 'none';
  canvas.focus?.({ preventScroll: true });
}

function onPointerDown(event) {
  if (!active) return;
  syncCursor(event);

  const isLeft = event.button === 0;
  const isRight = event.button === 2;
  const wantsComponent = !event.altKey && event.shiftKey;

  if (wantsComponent && (isLeft || isRight)) {
    preventTaskEvent(event);
    focusViewport();
    assignOne(event, buttonRegionId(isLeft), 'component');
    return;
  }

  if (event.altKey && (isLeft || isRight)) {
    const regionId = buttonRegionId(isLeft);
    preventTaskEvent(event);
    focusViewport();
    painting = { pointerId: event.pointerId, regionId, mode: 'brush', before: snapshot(), changed: false };
    painting.changed = assignFromEvent(event, regionId, 'brush') > 0;
    updateCursor();
    return;
  }

  if (event.altKey || event.shiftKey) preventTaskEvent(event);
}

function onPointerMove(event) {
  if (!active) return;
  syncCursor(event);

  if (painting && painting.pointerId === event.pointerId) {
    preventTaskEvent(event);
    painting.changed = assignFromEvent(event, painting.regionId, 'brush') > 0 || painting.changed;
  }
}

function onPointerUp(event) {
  if (!active) return;
  syncCursor(event);

  if (painting && painting.pointerId === event.pointerId) {
    preventTaskEvent(event);
    finishPainting(event);
  }
}

function onContextMenu(event) {
  if (!active) return;
  if (event.altKey || event.shiftKey || painting) preventTaskEvent(event);
}

function onWheel(event) {
  if (!active || !event.altKey) return;
  preventTaskEvent(event);
  setBrushRadius(brushRadius * (event.deltaY < 0 ? 1.12 : 0.88));
}

function onKeyDown(event) {
  if (!active) return;
  syncModifiers(event);

  if (isTextInputTarget(event.target)) return;

  const key = event.key.toLowerCase();
  const isUndo = (event.ctrlKey || event.metaKey) && !event.shiftKey && key === 'z';
  const isRedo = (event.ctrlKey || event.metaKey) && (key === 'y' || (event.shiftKey && key === 'z'));

  if (isUndo) {
    preventTaskEvent(event);
    undo();
  } else if (isRedo) {
    preventTaskEvent(event);
    redo();
  }
}

function bindEvents() {
  const canvas = app.renderer.domElement;
  const viewport = app.dom.viewport;
  canvas.setAttribute('tabindex', '0');
  canvas.style.outline = 'none';
  ensureCursor();

  viewport.addEventListener('pointerdown', focusViewport, true);
  canvas.addEventListener('pointerdown', onPointerDown, true);
  canvas.addEventListener('pointerenter', syncCursor, true);
  canvas.addEventListener('pointerleave', markOutside, true);
  canvas.addEventListener('contextmenu', onContextMenu, true);
  canvas.addEventListener('wheel', onWheel, { passive: false, capture: true });
  document.addEventListener('pointermove', onPointerMove, true);
  document.addEventListener('pointerup', onPointerUp, true);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', syncModifiers, true);
  window.addEventListener('blur', resetCursor);
}

function unbindEvents() {
  const canvas = app.renderer?.domElement;
  const viewport = app.dom?.viewport;
  viewport?.removeEventListener('pointerdown', focusViewport, true);
  canvas?.removeEventListener('pointerdown', onPointerDown, true);
  canvas?.removeEventListener('pointerenter', syncCursor, true);
  canvas?.removeEventListener('pointerleave', markOutside, true);
  canvas?.removeEventListener('contextmenu', onContextMenu, true);
  canvas?.removeEventListener('wheel', onWheel, true);
  document.removeEventListener('pointermove', onPointerMove, true);
  document.removeEventListener('pointerup', onPointerUp, true);
  window.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('keyup', syncModifiers, true);
  window.removeEventListener('blur', resetCursor);
  resetCursor({ remove: true });
}

function clearActiveRegion() {
  const id = activeRegion().id;
  return commit('clear active region', () => {
    assignmentsByMesh.forEach(assignment => {
      for (let i = 0; i < assignment.length; i++) {
        if (assignment[i] === id) assignment[i] = NONE;
      }
    });
  });
}

function clearAll() {
  return commit('clear segmentation', () => {
    assignmentsByMesh.forEach(assignment => assignment.fill(NONE));
  });
}

function addRegion() {
  return commit('add region', () => {
    regions.push(makeRegion());
    activeRegionIndex = regions.length - 1;
  }, { renderRegions: true });
}

function removeRegion(index) {
  if (index < 0 || index >= regions.length) return false;

  const isEmpty = regionVertexCount(regions[index]) === 0;
  if (!isEmpty && !window.confirm(`Remove region "${regionName(regions[index], index)}" and clear its vertices?`)) return false;

  return commit('remove region', () => {
    const id = regions[index].id;
    regions.splice(index, 1);
    assignmentsByMesh.forEach(assignment => {
      for (let i = 0; i < assignment.length; i++) {
        if (assignment[i] === id) assignment[i] = NONE;
      }
    });
    if (!regions.length) regions.push(makeRegion('Region 1'));
    activeRegionIndex = clamp(activeRegionIndex > index ? activeRegionIndex - 1 : activeRegionIndex, 0, regions.length - 1);
  }, { renderRegions: true });
}

function renameRegion(index, name) {
  if (!regions[index]) return false;
  const next = String(name || '').trim() || `Region ${index + 1}`;
  if (regions[index].name === next) return false;
  return commit('rename region', () => { regions[index].name = next; }, { renderRegions: true });
}

function applyRegionColorDirect(index, color) {
  if (!regions[index]) return false;

  const next = normalizeColor(color, regions[index].color);
  if (regions[index].color === next) return false;

  clearPreview();
  regions[index].color = next;
  repaintAll();
  updatePanelStats();
  return true;
}

function beginInteractiveRecolor(index) {
  if (!regions[index]) return;

  if (!colorEditState || colorEditState.index !== index) {
    colorEditState = {
      index,
      before: snapshot(),
    };
  }
}

function previewRegionColor(index, color) {
  if (!regions[index]) return false;

  beginInteractiveRecolor(index);
  return applyRegionColorDirect(index, color);
}

function finishInteractiveRecolor(index, color) {
  if (!regions[index]) return false;

  if (!colorEditState || colorEditState.index !== index) {
    return recolorRegion(index, color);
  }

  applyRegionColorDirect(index, color);

  const before = colorEditState.before;
  colorEditState = null;

  if (snapshotKey(before) !== snapshotKey(snapshot())) {
    pushUndo(before);
  }

  renderRegionList();
  repaintAll();
  updatePanelStats();
  return true;
}

function recolorRegion(index, color) {
  if (!regions[index]) return false;
  const next = normalizeColor(color, regions[index].color);
  if (regions[index].color === next) return false;
  return commit('recolor region', () => { regions[index].color = next; }, { renderRegions: true });
}

function selectRegion(index) {
  if (!regions.length) ensureRegion();
  const next = clamp(Number(index), 0, regions.length - 1);
  if (!Number.isInteger(next) || next === activeRegionIndex) return;
  clearPreview();
  activeRegionIndex = next;
  updatePanelStats();
}

function updateStackButtons() {
  const undoButton = document.getElementById('btn-mesh-seg-undo');
  const redoButton = document.getElementById('btn-mesh-seg-redo');
  if (undoButton) undoButton.disabled = !history.canUndo;
  if (redoButton) redoButton.disabled = !history.canRedo;
}

function updatePanelStats() {
  const activeCount = document.getElementById('mesh-seg-active-count');
  const assignedCount = document.getElementById('mesh-seg-assigned-count');
  const totalCount = document.getElementById('mesh-seg-total-count');
  const brushValue = document.getElementById('mesh-seg-brush-val');
  const activeName = document.getElementById('mesh-seg-active-name');
  const regionCount = document.getElementById('mesh-seg-region-count');

  if (activeCount) activeCount.textContent = `${regionVertexCount().toLocaleString()} verts`;
  if (assignedCount) assignedCount.textContent = `${assignedVertexCount().toLocaleString()} assigned`;
  if (totalCount) totalCount.textContent = `${totalVertexCount().toLocaleString()} verts`;
  if (brushValue) brushValue.textContent = `${Math.round(brushRadius)}px`;
  if (activeName) activeName.textContent = regionName(activeRegion(), activeRegionIndex);
  if (regionCount) regionCount.textContent = `${regions.length.toLocaleString()} region${regions.length === 1 ? '' : 's'}`;

  updateRegionListState();
  updateStackButtons();
  updateGeodesicBrushStatus();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderRegionList() {
  const list = document.getElementById('mesh-seg-region-list');
  if (!list) return;

  list.innerHTML = regions.map((region, index) => `
    <div class="mesh-mask-row mesh-seg-region-row ${index === activeRegionIndex ? 'selected' : ''}" data-idx="${index}">
      <span class="idx">#${index + 1}</span>
      <input class="mesh-seg-region-color" data-idx="${index}" type="color" value="${escapeHtml(region.color)}" title="Region color">
      <input class="mesh-mask-name mesh-seg-region-name" data-idx="${index}" value="${escapeHtml(regionName(region, index))}" title="Region name">
      <span class="mesh-mask-row-count" data-region-count="${index}">${regionVertexCount(region).toLocaleString()} verts</span>
      <button class="btn-mask-delete btn-icon" data-idx="${index}" title="Remove region" aria-label="Remove region">×</button>
    </div>`).join('');

  list.querySelectorAll('.mesh-seg-region-row').forEach(row => {
    row.addEventListener('click', event => {
      if (!event.target.closest('input,button')) selectRegion(parseInt(row.dataset.idx, 10));
    });
  });
  list.querySelectorAll('.mesh-seg-region-name').forEach(input => {
    input.addEventListener('click', event => event.stopPropagation());
    input.addEventListener('change', () => renameRegion(parseInt(input.dataset.idx, 10), input.value));
  });
  list.querySelectorAll('.mesh-seg-region-color').forEach(input => {
    input.addEventListener('click', event => event.stopPropagation());
    input.addEventListener('input', () => previewRegionColor(parseInt(input.dataset.idx, 10), input.value));
    input.addEventListener('change', () => finishInteractiveRecolor(parseInt(input.dataset.idx, 10), input.value));
  });
  list.querySelectorAll('.btn-mask-delete').forEach(button => {
    button.addEventListener('click', event => {
      event.stopPropagation();
      removeRegion(parseInt(button.dataset.idx, 10));
    });
  });

  updateRegionListState();
}

function updateRegionListState() {
  const list = document.getElementById('mesh-seg-region-list');
  if (!list) return;

  list.querySelectorAll('.mesh-seg-region-row').forEach(row => {
    row.classList.toggle('selected', parseInt(row.dataset.idx, 10) === activeRegionIndex);
  });
  list.querySelectorAll('[data-region-count]').forEach(el => {
    const region = regions[parseInt(el.dataset.regionCount, 10)];
    if (region) el.textContent = `${regionVertexCount(region).toLocaleString()} verts`;
  });
}


function colorFloatTriples() {
  const out = new Float32Array(regions.length * 3);
  regions.forEach((region, index) => {
    const color = new THREE.Color(region.color);
    out[index * 3] = color.r;
    out[index * 3 + 1] = color.g;
    out[index * 3 + 2] = color.b;
  });
  return out;
}

function segmentationArrayExportEntries(currentMeshes) {
  const entries = [
    npyEntry('colors.npy', colorFloatTriples(), [regions.length, 3], 'float32'),
    jsonEntry('metadata.json', {
      format: 'geomy-mesh-segmentation-numpy',
      version: GEOMY_VERSION,
      regions: regions.map(region => ({ id: region.id, name: regionName(region), color: region.color })),
      activeRegionIndex,
      arrays: {
        'mesh_N/masks.npy': 'bool[V,S]',
        'colors.npy': 'float32[S,3]',
      },
    }),
  ];

  currentMeshes.forEach((mesh, meshIndex) => {
    const assignment = assignmentFor(mesh);
    const vertexCount = getCanonicalVertexCount(mesh);
    const dense = new Uint8Array(vertexCount * regions.length);

    for (let v = 0; v < vertexCount; v++) {
      const regionIndex = regions.findIndex(region => region.id === assignment?.[v]);
      if (regionIndex >= 0) dense[v * regions.length + regionIndex] = 1;
    }

    entries.push(npyEntry(`mesh_${meshIndex}/masks.npy`, dense, [vertexCount, regions.length], 'bool'));
  });

  return entries;
}

function exportArrayBundle(extension = 'npz') {
  const currentMeshes = meshes();
  if (!currentMeshes.length) return alert('No mesh loaded.');
  const ext = extension === 'zip' ? 'zip' : 'npz';
  downloadArrayBundle(segmentationArrayExportEntries(currentMeshes), `mesh-segmentation.${ext}`);
}

function exportByFormat(format) {
  if (format === 'npz' || format === 'zip') exportArrayBundle(format);
  else exportJSON();
}

function arrayEntryByNames(arrays, names) {
  for (const name of names) {
    if (arrays.has(name)) return arrays.get(name);
  }
  return null;
}

async function parseSegmentationBundle(file) {
  const currentMeshes = meshes();
  if (!currentMeshes.length) throw new Error('Load a mesh before importing a segmentation.');

  const entries = await readArrayBundle(file);
  const arrays = parseBundleArrays(entries);
  const colors = arrayEntryByNames(arrays, ['colors.npy']);
  const firstMasks = arrayEntryByNames(arrays, ['mesh_0/masks.npy', 'masks.npy', 'segmentation.npy']);
  if (!firstMasks) throw new Error('Segmentation bundle needs masks.npy or mesh_0/masks.npy.');

  const S = firstMasks.shape?.[1] || colors?.shape?.[0] || 0;
  if (!S) throw new Error('Could not infer region count from segmentation arrays.');

  const importedRegions = [];
  for (let i = 0; i < S; i++) {
    let color = defaultRegionColor(i + 1);
    if (colors?.data?.length >= (i + 1) * 3) {
      const c = new THREE.Color(colors.data[i * 3], colors.data[i * 3 + 1], colors.data[i * 3 + 2]);
      color = `#${c.getHexString()}`;
    }
    importedRegions.push(makeRegion(`Region ${i + 1}`, color, i + 1));
  }

  const importedAssignments = new Map();
  let skipped = 0;

  currentMeshes.forEach((mesh, meshIndex) => {
    const masksArray = arrayEntryByNames(arrays, [`mesh_${meshIndex}/masks.npy`, meshIndex === 0 ? 'masks.npy' : `masks_${meshIndex}.npy`]);
    if (!masksArray) return;

    const vertexCount = getCanonicalVertexCount(mesh);
    const cols = masksArray.shape?.[1] || S;
    const rows = masksArray.shape?.[0] || Math.floor(masksArray.data.length / Math.max(1, cols));
    const assignment = new Int32Array(vertexCount);
    const n = Math.min(rows, vertexCount);

    for (let v = 0; v < n; v++) {
      let chosen = -1;
      for (let r = 0; r < Math.min(cols, S); r++) {
        if (masksArray.data[v * cols + r]) {
          chosen = r;
          break;
        }
      }
      if (chosen >= 0) assignment[v] = importedRegions[chosen].id;
    }

    if (rows > vertexCount) skipped += rows - vertexCount;
    importedAssignments.set(mesh, assignment);
  });

  if (!importedAssignments.size) throw new Error('No segmentation arrays matched the current mesh.');
  return { regions: importedRegions, assignments: importedAssignments, activeRegionIndex: 0, skipped };
}

async function importSegmentationFiles(fileList) {
  const file = Array.from(fileList || [])[0];
  if (!file) return;

  const isBundle = /\.(npz|zip)$/i.test(file.name || '');
  try {
    const imported = isBundle ? await parseSegmentationBundle(file) : parseSegmentation(await readJSON(file));
    if (assignedVertexCount() > 0 && !window.confirm('Replace the current segmentation with the imported one?')) return;

    commit('import segmentation', () => {
      regions = imported.regions;
      activeRegionIndex = imported.activeRegionIndex;
      assignmentsByMesh.clear();
      imported.assignments.forEach((assignment, mesh) => assignmentsByMesh.set(mesh, assignment));
      nextRegionId = Math.max(1, Math.max(0, ...regions.map(region => region.id)) + 1);
    }, { renderRegions: true });

    if (imported.skipped > 0) {
      alert(`Imported segmentation. Skipped ${imported.skipped} invalid entr${imported.skipped === 1 ? 'y' : 'ies'}.`);
    }
  } catch (error) {
    console.error('Failed to import mesh segmentation:', error);
    alert(error?.message || 'Failed to import mesh segmentation.');
  } finally {
    const input = document.getElementById('mesh-seg-import-file');
    if (input) input.value = '';
  }
}


function exportJSON() {
  const currentMeshes = meshes();
  if (!currentMeshes.length) return alert('No mesh loaded.');

  const payload = {
    format: 'geomy-mesh-segmentation',
    version: GEOMY_VERSION,
    coordinateSpace: 'mesh-vertex-index',
    unassignedRegionId: NONE,
    brushRadius,
    activeRegionIndex,
    regions: regions.map(region => ({
      id: region.id,
      name: regionName(region),
      color: region.color,
      assignedVertexCount: regionVertexCount(region),
    })),
    meshes: currentMeshes.map((mesh, meshIndex) => ({
      meshIndex,
      meshUuid: mesh.uuid,
      meshName: meshName(mesh),
      vertexCount: getCanonicalVertexCount(mesh),
      triangleCount: triangleCount(mesh),
      assignments: sparseAssignments(mesh).map(([vertexIndex, regionId]) => ({ vertexIndex, regionId })),
    })),
  };

  downloadBlob(JSON.stringify(payload, null, 2), 'mesh-segmentation.json', 'application/json');
}

function findMesh(entry, entryIndex, currentMeshes) {
  if (entry?.meshUuid) {
    const byUuid = currentMeshes.find(mesh => mesh.uuid === entry.meshUuid);
    if (byUuid) return byUuid;
  }
  if (entry?.meshName) {
    const byName = currentMeshes.find(mesh => meshName(mesh) === entry.meshName || mesh.parent?.name === entry.meshName);
    if (byName) return byName;
  }
  const explicitIndex = Number(entry?.meshIndex);
  if (Number.isInteger(explicitIndex) && currentMeshes[explicitIndex]) return currentMeshes[explicitIndex];
  return currentMeshes[entryIndex] || (currentMeshes.length === 1 ? currentMeshes[0] : null);
}

function parseAssignments(entry, vertexCount, validRegionIds) {
  const assignment = new Int32Array(vertexCount);
  let skipped = 0;

  if (Array.isArray(entry?.assignments)) {
    entry.assignments.forEach(item => {
      const vertexIndex = Number(item?.vertexIndex ?? item?.index ?? item?.v);
      const regionId = Number(item?.regionId ?? item?.region ?? item?.label);
      if (!Number.isInteger(vertexIndex) || vertexIndex < 0 || vertexIndex >= vertexCount || !validRegionIds.has(regionId)) {
        skipped += 1;
      } else {
        assignment[vertexIndex] = regionId;
      }
    });
    return { assignment, skipped };
  }

  const dense = entry?.regionIdByVertex || entry?.vertexRegions || entry?.labels;
  if (!Array.isArray(dense)) throw new Error('Each mesh entry must include assignments or regionIdByVertex.');

  dense.forEach((rawRegionId, vertexIndex) => {
    const regionId = Number(rawRegionId);
    if (vertexIndex >= vertexCount) {
      if (regionId !== NONE) skipped += 1;
    } else if (regionId !== NONE && validRegionIds.has(regionId)) {
      assignment[vertexIndex] = regionId;
    } else if (regionId !== NONE) {
      skipped += 1;
    }
  });

  return { assignment, skipped };
}

function parseSegmentation(payload) {
  const currentMeshes = meshes();
  if (!currentMeshes.length) throw new Error('Load a mesh before importing a segmentation.');
  if (!Array.isArray(payload?.regions) || !payload.regions.length) throw new Error('This JSON does not contain segmentation regions.');

  const importedRegions = payload.regions.map((entry, index) => makeRegion(
    entry?.name || `Region ${index + 1}`,
    entry?.color,
    entry?.id ?? index + 1
  ));
  const validRegionIds = new Set(importedRegions.map(region => region.id));
  const meshEntries = Array.isArray(payload?.meshes)
    ? payload.meshes
    : (currentMeshes.length === 1 ? [{ assignments: payload?.assignments, regionIdByVertex: payload?.regionIdByVertex }] : []);

  if (!meshEntries.length) throw new Error('This JSON does not contain mesh assignments.');

  const importedAssignments = new Map();
  let skipped = 0;
  meshEntries.forEach((entry, entryIndex) => {
    const mesh = findMesh(entry, entryIndex, currentMeshes);
    if (!mesh) {
      skipped += Array.isArray(entry?.assignments) ? entry.assignments.length : 1;
      return;
    }

    const result = parseAssignments(entry, getCanonicalVertexCount(mesh), validRegionIds);
    importedAssignments.set(mesh, result.assignment);
    skipped += result.skipped;
  });

  if (!importedAssignments.size) throw new Error('No imported assignments matched the current mesh.');

  return {
    regions: importedRegions,
    assignments: importedAssignments,
    activeRegionIndex: clamp(Number(payload.activeRegionIndex) || 0, 0, importedRegions.length - 1),
    skipped,
  };
}

function readJSON(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try { resolve(JSON.parse(String(reader.result || ''))); }
      catch (error) { reject(error); }
    };
    reader.onerror = () => reject(new Error(`Failed to read ${file?.name || 'JSON file'}.`));
    reader.readAsText(file);
  });
}

async function importJSON(fileList) {
  const file = Array.from(fileList || [])[0];
  if (!file) return;

  try {
    const imported = parseSegmentation(await readJSON(file));
    if (assignedVertexCount() > 0 && !window.confirm('Replace the current segmentation with the imported one?')) return;

    commit('import segmentation', () => {
      regions = imported.regions;
      activeRegionIndex = imported.activeRegionIndex;
      assignmentsByMesh.clear();
      imported.assignments.forEach((assignment, mesh) => assignmentsByMesh.set(mesh, assignment));
      nextRegionId = Math.max(1, Math.max(0, ...regions.map(region => region.id)) + 1);
    }, { renderRegions: true });

    if (imported.skipped > 0) {
      alert(`Imported segmentation. Skipped ${imported.skipped} invalid or unmatched entr${imported.skipped === 1 ? 'y' : 'ies'}.`);
    }
  } catch (error) {
    console.error('Failed to import mesh segmentation:', error);
    alert(error?.message || 'Failed to import mesh segmentation JSON.');
  } finally {
    const input = document.getElementById('mesh-seg-import-file');
    if (input) input.value = '';
  }
}

function renderPanel() {
  ensureRegion();

  app.dom.taskContent.innerHTML = `
    <div class="task-heading">
      <h3>Mesh Segmentation</h3>
      <span class="task-help" tabindex="0" data-tip="Partition vertices into exclusive regions. Alt+left-drag assigns the active region; Alt+right-drag clears. Shift handles connected components. Alt+wheel changes brush width. Enable geodesic brush to precompute an all-pairs distance LUT; painting switches to geodesic as soon as the LUT is ready. Ctrl+Z/Y undo/redo.">?</span>
    </div>

    <div class="section-title">Edit Segmentation</div>
    <div class="task-edit-compact">
      <button id="btn-mesh-seg-clear-active" class="btn btn-danger">Clear Region</button>
      <button id="btn-mesh-seg-clear-all" class="btn btn-danger">Clear All</button>
    </div>

    <div class="section-title">Brush Width (screen)</div>
    <div class="range-row">
      <input type="range" id="mesh-seg-brush" min="${MIN_BRUSH_RADIUS}" max="${MAX_BRUSH_RADIUS}" step="1" value="${brushRadius}">
      <span class="range-val" id="mesh-seg-brush-val">${Math.round(brushRadius)}px</span>
    </div>
    <label class="checkbox-label"><input type="checkbox" id="mesh-seg-geodesic-brush" ${useGeodesicBrush ? 'checked' : ''}> Use geodesic brush</label>
    <progress id="mesh-seg-geodesic-progress" max="100" value="0" style="width:100%;display:none;"></progress>
    <div class="hint" id="mesh-seg-geodesic-status"></div>

    <div class="section-title">Regions</div>
    <div class="btn-row mesh-mask-io-row">
      <button id="btn-mesh-seg-add" class="btn">＋ Add Region</button>
    </div>
    <div id="mesh-seg-region-list" class="mesh-mask-list mesh-seg-region-list"></div>

    <div class="section-title">Active Region</div>
    <div class="mesh-mask-option-group">
      <div class="mesh-mask-stat"><span>Name</span><span id="mesh-seg-active-name">${escapeHtml(regionName(activeRegion(), activeRegionIndex))}</span></div>
      <div class="mesh-mask-stat"><span>Region size</span><span id="mesh-seg-active-count">0 verts</span></div>
      <div class="mesh-mask-stat"><span>Assigned</span><span id="mesh-seg-assigned-count">0 assigned</span></div>
      <div class="mesh-mask-stat"><span>Mesh size</span><span id="mesh-seg-total-count">0 verts</span></div>
      <div class="mesh-mask-stat"><span>Regions</span><span id="mesh-seg-region-count">${regions.length} region${regions.length === 1 ? '' : 's'}</span></div>
    </div>

    <div class="section-title section-title-with-help">
      <span>Save / Load</span>
      <span class="section-help" tabindex="0" data-tip="Export saves all regions and vertex assignments. Import replaces the current segmentation.">?</span>
    </div>
    <div class="material-row mesh-mask-io-row">
      <label>Format</label>
      <select id="mesh-seg-io-format">
        <option value="npz">Numpy (NPZ)</option>
        <option value="zip">Numpy (ZIP)</option>
        <option value="json">JSON</option>
      </select>
      <span></span>
    </div>
    <div class="btn-row mesh-mask-io-row">
      <button id="btn-mesh-seg-import" class="btn">Import</button>
      <button id="btn-mesh-seg-export" class="btn btn-export">Export</button>
    </div>
    <input id="mesh-seg-import-file" class="mesh-mask-file-input" type="file" accept=".json,.npz,.zip,application/json,application/zip">
  `;

  const brushSlider = document.getElementById('mesh-seg-brush');
  brushSlider?.addEventListener('input', () => setBrushRadius(brushSlider.value));

  const geodesicBrush = document.getElementById('mesh-seg-geodesic-brush');
  geodesicBrush?.addEventListener('change', () => setUseGeodesicBrush(geodesicBrush.checked));

  document.getElementById('btn-mesh-seg-add')?.addEventListener('click', addRegion);
  document.getElementById('btn-mesh-seg-clear-active')?.addEventListener('click', () => {
    if (regionVertexCount() === 0 || window.confirm('Clear the active region assignments?')) clearActiveRegion();
  });
  document.getElementById('btn-mesh-seg-clear-all')?.addEventListener('click', () => {
    if (assignedVertexCount() === 0 || window.confirm('Clear all region assignments?')) clearAll();
  });
  document.getElementById('btn-mesh-seg-export')?.addEventListener('click', () => exportByFormat(document.getElementById('mesh-seg-io-format')?.value || 'json'));

  const importInput = document.getElementById('mesh-seg-import-file');
  document.getElementById('btn-mesh-seg-import')?.addEventListener('click', () => importInput?.click());
  importInput?.addEventListener('change', () => importSegmentationFiles(importInput.files));

  renderRegionList();
  updatePanelStats();
}

function resetForNewFile() {
  clearPreview();
  restoreRenderBackup({ disposeOriginals: true });
  assignmentsByMesh.clear();
  componentIndex.reset();
  regions = [];
  activeRegionIndex = 0;
  nextRegionId = 1;
  painting = null;
  ensureRegion();
  clearHistory();
}

export const meshSegmentationTask = {
  id: 'segment',

  onDblClick() {
    return false;
  },

  activate() {
    active = true;
    ensureRegion();
    setMaterialPanelHidden(true);
    setSmoothShadingForTask(true);
    renderPanel();
    applyRenderMode();
    bindEvents();
    updatePanelStats();
  },

  deactivate() {
    active = false;
    finishPainting();
    painting = null;
    unbindEvents();
    restoreControls();
    restoreRenderBackup();
    setLightsVisible(false);
    setMaterialPanelHidden(false);
    setSmoothShadingForTask(false);
    restoreVisualizationRenderMode();
    app.dom.taskContent.innerHTML = '';
  },

  onFileLoaded() {
    resetForNewFile();
    if (active) {
      applyRenderMode();
      renderPanel();
    }
  },
};
