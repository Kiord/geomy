import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';

import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoundedArcballControls } from './controls/RoundedArcballControls.js';

import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { getTaskCapabilities, taskAcceptsSharedMeshLoad } from './core/taskCapabilities.js';
import { loadCanonicalOBJFile } from './io/objCanonicalLoader.js';
import { resetSkinnedMeshesToBindPose } from './io/gltfBindPose.js';
import { arrayRows, fileKind, readSimpleArrayFile } from './io/taskDataDaemon.js';
import { readSymmetryMappingFile, setMeshSymmetry } from './io/vertexSymmetry.js';

// ── Central state ──
export const app = {
  scene: null,
  camera: null,
  renderer: null,
  controls: null,
  controlsMode: 'arcball',
  currentObject: null,
  currentFileName: '',
  currentSymmetryFileName: '',
  currentVertexUpdateFileName: '',
  task: null,
  tasks: {},
  dom: {},
  environmentTexture: null,
  environmentTextureIsDefault: true,
  defaultEnvironmentUrl: '/env/studio.hdr',
  showEnvironmentBackground: false,
  environmentBackgroundBlurriness: 0.3,
  renderOverride: null,
};

// ── Scene init ──
export function initScene() {
  const viewport = document.getElementById('viewport');

  app.scene = new THREE.Scene();
  app.scene.background = null; // controlled by CSS

  app.camera = new THREE.PerspectiveCamera(55, viewport.clientWidth / viewport.clientHeight, 0.01, 100);
  app.camera.position.set(0, 0.8, 2);

    app.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    app.renderer.sortObjects = true;
    app.renderer.setPixelRatio(window.devicePixelRatio);
    app.renderer.setSize(viewport.clientWidth, viewport.clientHeight, false);

    // CSS owns the displayed size; renderer.setSize owns the drawing buffer size.
    app.renderer.domElement.style.width = '100%';
    app.renderer.domElement.style.height = '100%';

    viewport.appendChild(app.renderer.domElement);

  // Controls
  const savedControlsMode = localStorage.getItem('geomy-controls-mode') || 'arcball';
  createControls(savedControlsMode);
    
// Ligthing
loadEnvironmentMap(app.defaultEnvironmentUrl);

  const grid = new THREE.GridHelper(5, 20, '#333', '#222');
  grid.name = 'main-grid';
  app.scene.add(grid);
  grid.visible = false;

  // Cache DOM refs
  app.dom.viewport = viewport;
  app.dom.dropOverlay = document.getElementById('drop-overlay');
  app.dom.dropMessage = document.getElementById('drop-message');
  app.dom.fileInput = document.getElementById('file-input');
  app.dom.taskSelect = document.getElementById('task-select');
  app.dom.taskContent = document.getElementById('task-content');
  app.dom.taskMeshLoader = document.getElementById('task-mesh-loader');
  app.dom.taskLoadMeshBtn = document.getElementById('task-load-mesh-btn');
  app.dom.taskLoadSymmetryBtn = document.getElementById('task-load-symmetry-btn');
  app.dom.taskUpdateVerticesBtn = document.getElementById('task-update-vertices-btn');
  app.dom.taskSymmetryRow = document.getElementById('task-symmetry-row');
  app.dom.taskVertexUpdateRow = document.getElementById('task-vertex-update-row');
  app.dom.taskSymmetryFileInput = document.getElementById('task-symmetry-file-input');
  app.dom.taskVertexPositionFileInput = document.getElementById('task-vertex-position-file-input');
  app.dom.taskLoadedMeshName = document.getElementById('task-loaded-mesh-name');
  app.dom.taskLoadedSymmetryName = document.getElementById('task-loaded-symmetry-name');
  app.dom.taskUpdatedVerticesName = document.getElementById('task-updated-vertices-name');
  app.dom.vertexCount = document.getElementById('vertex-count');

  initTaskMeshLoader();

  // Background color synced with theme
  syncBackground();
}

function initTaskMeshLoader() {
  app.dom.taskLoadMeshBtn?.addEventListener('click', () => {
    app.dom.fileInput?.click();
  });

  app.dom.taskLoadSymmetryBtn?.addEventListener('click', () => {
    app.dom.taskSymmetryFileInput?.click();
  });

  app.dom.taskUpdateVerticesBtn?.addEventListener('click', () => {
    app.dom.taskVertexPositionFileInput?.click();
  });

  app.dom.taskSymmetryFileInput?.addEventListener('change', async event => {
    const input = event.target;
    const file = input.files?.[0] || null;

    try {
      await loadSharedSymmetryFile(file);
    } catch (error) {
      console.error('Failed to load vertex symmetry mapping:', error);
      alert(error?.message || 'Failed to load vertex symmetry mapping.');
    } finally {
      input.value = '';
    }
  });

  app.dom.taskVertexPositionFileInput?.addEventListener('change', async event => {
    const input = event.target;
    const file = input.files?.[0] || null;

    try {
      await updateSharedVertexPositions(file);
    } catch (error) {
      console.error('Failed to update vertex positions:', error);
      alert(error?.message || 'Failed to update vertex positions.');
    } finally {
      input.value = '';
    }
  });

  updateTaskMeshLoader();
}

function currentMeshes() {
  const meshes = [];

  app.currentObject?.traverse?.(object => {
    if (object.isMesh && object.geometry?.attributes?.position) meshes.push(object);
  });

  return meshes;
}

function singleCurrentMesh(action = 'use this action') {
  const meshes = currentMeshes();
  if (meshes.length !== 1) {
    throw new Error(`Load exactly one mesh to ${action}.`);
  }
  return meshes[0];
}

function canonicalData(mesh) {
  return mesh?.geometry?.userData?.geomyCanonical || mesh?.userData?.geomyCanonical || null;
}

function canonicalVertexCount(mesh) {
  return canonicalData(mesh)?.vertexCount || mesh?.geometry?.attributes?.position?.count || 0;
}

function rowsToPositionArray(array, vertexCount) {
  const rows = array.rows || arrayRows(array.data, array.shape);
  const flat = Array.from(array.data || [], Number);

  if (rows.length === vertexCount && rows.every(row => row.length >= 3)) {
    return new Float32Array(rows.flatMap(row => row.slice(0, 3).map(Number)));
  }

  if (flat.length === vertexCount * 3) {
    return new Float32Array(flat);
  }

  throw new Error(`Vertex positions must be an Nx3 array with ${vertexCount.toLocaleString()} rows.`);
}

function isMeshPositionFile(file) {
  const ext = String(file?.name || '').split('.').pop().toLowerCase();
  return ['obj', 'stl', 'ply', 'glb', 'gltf'].includes(ext);
}

function disposeObject3D(object) {
  object?.traverse?.(child => {
    child.geometry?.dispose?.();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.filter(Boolean).forEach(material => material.dispose?.());
  });
}

async function objectFromMeshPositionFile(file) {
  const ext = String(file?.name || '').split('.').pop().toLowerCase();

  if (ext === 'obj') {
    return prepareObjectGeometry(await loadCanonicalOBJFile(file));
  }

  const loader = loaders[ext];
  if (!loader) throw new Error(`Unsupported vertex position mesh format: .${ext}`);

  const url = URL.createObjectURL(file);

  try {
    if (ext === 'gltf' || ext === 'glb') {
      const gltf = await loader.loadAsync(url);
      resetSkinnedMeshesToBindPose(gltf.scene);
      return prepareObjectGeometry(gltf.scene);
    }

    const geometry = smoothImportedGeometry(await loader.loadAsync(url));
    return new THREE.Mesh(geometry);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function positionArrayFromMeshObject(object) {
  const meshes = [];
  object?.traverse?.(child => {
    if (child.isMesh && child.geometry?.attributes?.position) meshes.push(child);
  });

  if (object?.isMesh && object.geometry?.attributes?.position && !meshes.includes(object)) {
    meshes.push(object);
  }

  if (meshes.length !== 1) {
    throw new Error(`Vertex update mesh files must contain exactly one mesh (${meshes.length} found).`);
  }

  const mesh = meshes[0];
  const canonical = canonicalData(mesh);
  if (canonical?.positions) return new Float32Array(canonical.positions);

  const position = mesh.geometry?.attributes?.position;
  if (!position) throw new Error('The vertex update mesh has no position buffer.');
  return new Float32Array(position.array);
}

async function readVertexPositionArray(file, vertexCount) {
  const ext = String(file?.name || '').split('.').pop().toLowerCase();

  if (isMeshPositionFile(file)) {
    const object = await objectFromMeshPositionFile(file);
    try {
      return positionArrayFromMeshObject(object);
    } finally {
      disposeObject3D(object);
    }
  }

  const kind = fileKind(file);
  if (kind !== 'npy' && !(kind === 'text' && ext === 'txt')) {
    throw new Error('Choose a .npy, .txt, or mesh file for vertex positions.');
  }

  return rowsToPositionArray(await readSimpleArrayFile(file), vertexCount);
}

function updateMeshPositionBuffers(mesh, positions) {
  const vertexCount = canonicalVertexCount(mesh);
  if (!vertexCount) throw new Error('The loaded mesh has no vertices.');
  if (positions.length !== vertexCount * 3) {
    throw new Error(`Vertex position array length ${positions.length} does not match ${vertexCount.toLocaleString()} vertices.`);
  }

  const canonical = canonicalData(mesh);
  if (canonical?.positions && canonical.positions.length === positions.length) {
    canonical.positions.set(positions);
    if (canonical.positionAttribute) canonical.positionAttribute.needsUpdate = true;
  }

  const renderPosition = mesh.geometry?.attributes?.position;
  if (!renderPosition) throw new Error('The loaded mesh has no render position buffer.');

  const sourceVertexId = mesh.geometry.getAttribute('sourceVertexId');
  if (sourceVertexId) {
    for (let renderIndex = 0; renderIndex < renderPosition.count; renderIndex++) {
      const vertexIndex = Math.floor(Number(sourceVertexId.getX(renderIndex)));
      if (vertexIndex < 0 || vertexIndex >= vertexCount) continue;
      const offset = vertexIndex * 3;
      renderPosition.setXYZ(renderIndex, positions[offset], positions[offset + 1], positions[offset + 2]);
    }
  } else if (renderPosition.count === vertexCount) {
    for (let i = 0; i < vertexCount; i++) {
      const offset = i * 3;
      renderPosition.setXYZ(i, positions[offset], positions[offset + 1], positions[offset + 2]);
    }
  } else {
    throw new Error('This mesh has split render vertices but no source vertex map, so canonical positions cannot be updated safely.');
  }

  renderPosition.needsUpdate = true;
  updateMeshNormalsAfterPositionSwap(mesh, positions);
  mesh.geometry.computeBoundingBox?.();
  mesh.geometry.computeBoundingSphere?.();
}

function normalizeNormalArray(array, index) {
  const offset = index * 3;
  const x = array[offset];
  const y = array[offset + 1];
  const z = array[offset + 2];
  const length = Math.hypot(x, y, z);

  if (length > 1e-20) {
    array[offset] = x / length;
    array[offset + 1] = y / length;
    array[offset + 2] = z / length;
    return;
  }

  array[offset] = 0;
  array[offset + 1] = 0;
  array[offset + 2] = 1;
}

function smoothCanonicalNormals(positions, faces) {
  const vertexCount = Math.floor(positions.length / 3);
  const out = new Float32Array(vertexCount * 3);
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const normal = new THREE.Vector3();

  for (let i = 0; i < faces.length; i += 3) {
    const ia = faces[i];
    const ib = faces[i + 1];
    const ic = faces[i + 2];
    if (ia < 0 || ib < 0 || ic < 0 || ia >= vertexCount || ib >= vertexCount || ic >= vertexCount) continue;

    const ax = positions[ia * 3];
    const ay = positions[ia * 3 + 1];
    const az = positions[ia * 3 + 2];
    const bx = positions[ib * 3];
    const by = positions[ib * 3 + 1];
    const bz = positions[ib * 3 + 2];
    const cx = positions[ic * 3];
    const cy = positions[ic * 3 + 1];
    const cz = positions[ic * 3 + 2];

    ab.set(bx - ax, by - ay, bz - az);
    ac.set(cx - ax, cy - ay, cz - az);
    normal.crossVectors(ab, ac);

    [ia, ib, ic].forEach(index => {
      out[index * 3] += normal.x;
      out[index * 3 + 1] += normal.y;
      out[index * 3 + 2] += normal.z;
    });
  }

  for (let i = 0; i < vertexCount; i++) normalizeNormalArray(out, i);
  return out;
}

function updateMeshNormalsAfterPositionSwap(mesh, positions) {
  const canonical = canonicalData(mesh);
  const faces = canonical?.faces;
  const sourceVertexId = mesh.geometry?.getAttribute?.('sourceVertexId');
  const renderNormal = mesh.geometry?.attributes?.normal;

  if (faces?.length && sourceVertexId && renderNormal) {
    const canonicalNormals = smoothCanonicalNormals(positions, faces);
    canonical.generatedNormals = canonicalNormals;

    for (let renderIndex = 0; renderIndex < renderNormal.count; renderIndex++) {
      const vertexIndex = Math.floor(Number(sourceVertexId.getX(renderIndex)));
      if (vertexIndex < 0 || vertexIndex >= canonicalNormals.length / 3) continue;
      const offset = vertexIndex * 3;
      renderNormal.setXYZ(renderIndex, canonicalNormals[offset], canonicalNormals[offset + 1], canonicalNormals[offset + 2]);
    }

    renderNormal.needsUpdate = true;
    return;
  }

  mesh.geometry.computeVertexNormals?.();
}

async function loadSharedSymmetryFile(file) {
  if (!file) return;

  const mesh = singleCurrentMesh('load a symmetry mapping');
  const symmetry = await readSymmetryMappingFile(file, mesh);
  setMeshSymmetry(mesh, symmetry);
  app.currentSymmetryFileName = file.name || 'symmetry mapping';
  updateTaskMeshLoader();
  app.task?.onSymmetryChanged?.();
}

async function updateSharedVertexPositions(file) {
  if (!file) return;

  const mesh = singleCurrentMesh('update vertex positions');
  const vertexCount = canonicalVertexCount(mesh);
  const positions = await readVertexPositionArray(file, vertexCount);

  updateMeshPositionBuffers(mesh, positions);
  app.currentVertexUpdateFileName = file.name || 'vertex positions';
  updateEnvironmentUsage();
  window.dispatchEvent(new CustomEvent('geomy:vertex-positions-updated', { detail: { mesh, fileName: file.name || '' } }));
  app.task?.onGeometryChanged?.();
}

function updateTaskMeshLoader(task = app.task) {
  const row = app.dom.taskMeshLoader;
  const label = app.dom.taskLoadedMeshName;
  const symmetryRow = app.dom.taskSymmetryRow;
  const vertexUpdateRow = app.dom.taskVertexUpdateRow;
  const symmetryLabel = app.dom.taskLoadedSymmetryName;
  const vertexUpdateLabel = app.dom.taskUpdatedVerticesName;
  const symmetryBtn = app.dom.taskLoadSymmetryBtn;
  const verticesBtn = app.dom.taskUpdateVerticesBtn;

  if (!row) return;

  const capabilities = getTaskCapabilities(task);
  const showLoader = capabilities.usesTaskMeshLoader !== false;
  const singleMeshLoaded = currentMeshes().length === 1;

  row.hidden = !showLoader;
  row.style.display = showLoader ? 'grid' : 'none';

  if (symmetryRow) symmetryRow.hidden = !singleMeshLoaded;
  if (vertexUpdateRow) vertexUpdateRow.hidden = !singleMeshLoaded;

  if (symmetryBtn) {
    symmetryBtn.hidden = !singleMeshLoaded;
    symmetryBtn.disabled = !singleMeshLoaded;
    symmetryBtn.title = singleMeshLoaded ? 'Load a vertex permutation as NPY or text.' : 'Load exactly one mesh first.';
  }

  if (verticesBtn) {
    verticesBtn.hidden = !singleMeshLoaded;
    verticesBtn.disabled = !singleMeshLoaded;
    verticesBtn.title = singleMeshLoaded ? 'Replace vertex positions from an Nx3 NPY or text file.' : 'Load exactly one mesh first.';
  }

  if (label) {
    label.textContent = app.currentFileName || '';
    label.title = app.currentFileName || '';
  }

  if (symmetryLabel) {
    symmetryLabel.textContent = app.currentSymmetryFileName || '';
    symmetryLabel.title = app.currentSymmetryFileName || '';
  }

  if (vertexUpdateLabel) {
    vertexUpdateLabel.textContent = app.currentVertexUpdateFileName || '';
    vertexUpdateLabel.title = app.currentVertexUpdateFileName || '';
  }
}

function setLoadedMeshName(name) {
  app.currentFileName = name || '';
  if (!name) {
    app.currentSymmetryFileName = '';
    app.currentVertexUpdateFileName = '';
  }
  updateTaskMeshLoader();
}

function getEnvironmentLoaderForExtension(ext) {
  switch (ext) {
    case 'hdr':
      return new HDRLoader();
    case 'exr':
      return new EXRLoader();
    default:
      return null;
  }
}

function getCurrentShadingMode() {
  return document.querySelector('input[name="shading"]:checked')?.value || 'lambert';
}

function getCurrentLightIntensity() {
  return parseInt(document.getElementById('viz-light-intensity')?.value || '100', 10) / 100;
}

function applyEnvironmentTexture(texture, { isDefault = false } = {}) {
  if (!app.scene || !texture) return texture;

  texture.mapping = THREE.EquirectangularReflectionMapping;

  if (app.environmentTexture && app.environmentTexture !== texture) {
    app.environmentTexture.dispose();
  }

  app.environmentTexture = texture;
  app.environmentTextureIsDefault = isDefault;

  updateEnvironmentUsage();

  return texture;
}

export function updateEnvironmentUsage() {
  if (!app.scene) return;

  if (app.renderOverride) {
    app.scene.environment = null;
    syncBackground();
    return;
  }

  const shadingMode = getCurrentShadingMode();
  const envOn = shadingMode === 'pbr';
  const lightIntensity = getCurrentLightIntensity();

  app.scene.environment = envOn ? app.environmentTexture : null;
  syncBackground();

  app.currentObject?.traverse(obj => {
    if (!obj.isMesh || !obj.material) return;

    const materials = Array.isArray(obj.material) ? obj.material : [obj.material];

    materials.forEach(mat => {
      if (mat.isMeshStandardMaterial || mat.isMeshPhysicalMaterial) {
        mat.envMap = envOn ? app.environmentTexture : null;
        mat.envMapIntensity = envOn ? lightIntensity : 0.0;
      }

      mat.needsUpdate = true;
    });
  });
}

export async function loadEnvironmentMap(url, { isDefault = true } = {}) {
  if (!app.scene) return null;

  const ext = String(url).split('?')[0].split('#')[0].split('.').pop().toLowerCase();
  const loader = getEnvironmentLoaderForExtension(ext);

  if (!loader) {
    console.error(`Unsupported environment map extension: .${ext}`);
    return null;
  }

  try {
    const texture = await loader.loadAsync(url);
    return applyEnvironmentTexture(texture, { isDefault });
  } catch (err) {
    console.error('Failed to load environment map:', err);
    return null;
  }
}

export async function loadEnvironmentFile(file) {
  if (!file) return null;

  const ext = file.name.split('.').pop().toLowerCase();
  const loader = getEnvironmentLoaderForExtension(ext);

  if (!loader) {
    throw new Error(`Unsupported environment map: .${ext}. Please choose a .hdr or .exr file.`);
  }

  const url = URL.createObjectURL(file);

  try {
    const texture = await loader.loadAsync(url);
    return applyEnvironmentTexture(texture, { isDefault: false });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function setEnvironmentBackgroundBlurriness(value) {
  const n = parseFloat(value);
  app.environmentBackgroundBlurriness = Number.isFinite(n)
    ? Math.max(0, Math.min(1, n))
    : 0;

  syncBackground();
}

export async function resetEnvironmentMap() {
  return loadEnvironmentMap(app.defaultEnvironmentUrl, { isDefault: true });
}

export function syncBackground() {
  if (!app.scene) return;

  if (app.showEnvironmentBackground && app.environmentTexture) {
    app.scene.background = app.environmentTexture;

    if ('backgroundBlurriness' in app.scene) {
      app.scene.backgroundBlurriness = app.environmentBackgroundBlurriness;
    }

    if ('backgroundIntensity' in app.scene) {
      app.scene.backgroundIntensity = 1;
    }

    return;
  }

  const style = getComputedStyle(document.body);
  const hex = style.getPropertyValue('--bg').trim();
  app.scene.background = new THREE.Color(hex || '#1a1a2e');

  if ('backgroundBlurriness' in app.scene) {
    app.scene.backgroundBlurriness = 0;
  }

  if ('backgroundIntensity' in app.scene) {
    app.scene.backgroundIntensity = 1;
  }
}

export function setEnvironmentBackgroundVisible(visible) {
  app.showEnvironmentBackground = !!visible;
  syncBackground();
}

export function createControls(mode = 'arcball') {
  if (!app.camera || !app.renderer) return null;

  const previousTarget = app.controls?.target?.clone?.() || new THREE.Vector3();

  if (app.controls?.dispose) {
    app.controls.dispose();
  }

  let controls;

  switch (mode) {
    case 'orbit':
      controls = new OrbitControls(app.camera, app.renderer.domElement);
      controls.enableDamping = false;
      controls.rotateSpeed = 0.3;
      controls.zoomSpeed = 2.0;
      controls.mouseButtons = {
        LEFT: THREE.MOUSE.ROTATE,
        MIDDLE: THREE.MOUSE.PAN,
        RIGHT: THREE.MOUSE.DOLLY,
      };
      break;

    case 'arcball':
    default:
      controls = new RoundedArcballControls(app.camera, app.renderer.domElement);
      controls.enableDamping = false;
      controls.rotateSpeed = 0.3;
      controls.zoomSpeed = 2.0;
      controls.arcballRadius = 0.9;
      controls.enableEdgeRoll = false;
      mode = 'arcball';
      break;
  }

  controls.target.copy(previousTarget);
  controls.update();

  app.controls = controls;
  app.controlsMode = mode;

  localStorage.setItem('geomy-controls-mode', mode);

  return controls;
}

export function setControlsMode(mode) {
  return createControls(mode);
}


// Re-sync when theme changes
window.addEventListener('themechange', syncBackground);

// ── Loaders ──
const loaders = {
  gltf: new GLTFLoader(),
  stl: new STLLoader(),
  ply: new PLYLoader(),
};


function smoothImportedGeometry(geometry) {
  if (!geometry?.attributes?.position) return geometry;

  // Critical: never weld, merge, re-index, or otherwise replace imported
  // geometry here. geomy tools (masking, landmarks, segmentation, rigid align)
  // rely on the imported vertex count and order staying stable.
  //
  // Imported/authored normals are preserved. Normals are generated only when
  // the asset has none, which adds a normal attribute with the same vertex
  // count/order and does not change positions or indices.
  if (!geometry.attributes.normal) {
    geometry.computeVertexNormals?.();
  }

  geometry.computeBoundingBox?.();
  geometry.computeBoundingSphere?.();
  return geometry;
}

function configureImportedMaterialTransparency(material) {
  if (!material) return;

  const materials = Array.isArray(material) ? material : [material];

  materials.forEach(mat => {
    if (!mat) return;

    const hasAlphaMap = !!mat.alphaMap;
    const hasAlphaTest = (mat.alphaTest || 0) > 0;
    const hasBlendTransparency = mat.transparent || mat.opacity < 0.999;

    if (hasAlphaMap || hasAlphaTest || hasBlendTransparency) {
      // GLB/GLTF alpha can come from alphaMode=BLEND, alphaMode=MASK,
      // or a dedicated alphaMap. Keep those semantics alive even when
      // the visualization panel later rebuilds materials.
      mat.transparent = hasAlphaMap || hasBlendTransparency;
      mat.depthWrite = !(hasAlphaMap || hasBlendTransparency);
      mat.needsUpdate = true;
    }
  });
}

function prepareObjectGeometry(object) {
  object?.traverse?.(child => {
    if (!child.isMesh) return;

    configureImportedMaterialTransparency(child.material);

    if (!child.geometry) return;

    const original = child.geometry;
    const prepared = smoothImportedGeometry(original);
    if (prepared && prepared !== original) {
      child.geometry = prepared;
      original.dispose?.();
    }
  });

  return object;
}

function meshVertexCount(mesh) {
  const canonical = mesh?.geometry?.userData?.geomyCanonical || mesh?.userData?.geomyCanonical;
  const canonicalCount = canonical?.vertexCount;

  if (Number.isFinite(canonicalCount) && canonicalCount >= 0) {
    return canonicalCount;
  }

  return mesh?.geometry?.attributes?.position?.count || 0;
}

function objectVertexCount(object) {
  let count = 0;

  object?.traverse?.(child => {
    if (child.isMesh) count += meshVertexCount(child);
  });

  return count;
}

// ── File loading ──
export function loadFile(file) {
  if (!file) return;

  // Some tasks own their mesh documents and should not receive files through
  // the shared single-mesh loader. This keeps those ownership rules data-driven
  // instead of hard-coding specific task ids here.
  if (!taskAcceptsSharedMeshLoad(app.task)) {
    if (app.dom.fileInput) app.dom.fileInput.value = '';
    return;
  }

  const url = URL.createObjectURL(file);
  const ext = file.name.split('.').pop().toLowerCase();
  app.currentSymmetryFileName = '';
  app.currentVertexUpdateFileName = '';
  setLoadedMeshName(`Loading ${file.name}…`);

  if (app.currentObject) {
    app.scene.remove(app.currentObject);
    app.currentObject.traverse(c => {
      if (c.geometry) c.geometry.dispose();
      if (c.material) {
        [].concat(c.material).forEach(m => m.dispose());
      }
    });
    app.currentObject = null;
  }

  function addToScene(obj) {
    app.currentObject = obj;
    const box = new THREE.Box3().setFromObject(obj);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const s = 1.5 / maxDim;
    obj.scale.setScalar(s);
    obj.position.sub(center.multiplyScalar(s));
    app.scene.add(obj);
    obj.traverse(c => {
        if (c.isMesh) c.renderOrder = 0;
    });
    app.controls.target.set(0, 0, 0);
    app.controls.update();
    app.dom.dropOverlay.style.display = 'none';
    setLoadedMeshName(file.name);

    const verts = objectVertexCount(obj);
    app.dom.vertexCount.textContent = verts ? `${verts.toLocaleString()} verts` : '';

    if (app.task?.onFileLoaded) app.task.onFileLoaded();
  }

  try {
    switch (ext) {
      case 'glb': case 'gltf':
        loaders.gltf.load(url, g => {
          resetSkinnedMeshesToBindPose(g.scene);
          prepareObjectGeometry(g.scene);
          addToScene(g.scene);
        }); break;
      case 'obj':
        loadCanonicalOBJFile(file)
          .then(obj => {
            prepareObjectGeometry(obj);
            addToScene(obj);
          })
          .catch(err => {
            setLoadedMeshName('');
            console.error(err);
            alert(`Failed to load OBJ: ${err?.message || err}`);
          });
        break;
      case 'stl':
        loaders.stl.load(url, geo => {
          const prepared = smoothImportedGeometry(geo);
          addToScene(new THREE.Mesh(prepared, new THREE.MeshStandardMaterial({ color: '#e0e0e0', roughness: 0.4, metalness: 0.1 })));
        }); break;
      case 'ply':
        loaders.ply.load(url, geo => {
          const prepared = smoothImportedGeometry(geo);
          addToScene(new THREE.Mesh(prepared, new THREE.MeshStandardMaterial({ color: '#e0e0e0', roughness: 0.4, metalness: 0.1 })));
        }); break;
      default:
        setLoadedMeshName('');
        alert('Unsupported: .' + ext);
    }
  } catch (e) {
    setLoadedMeshName('');
    console.error(e);
  }
  URL.revokeObjectURL(url);
}

// ── Drag & Drop ──
export function initDragDrop() {
  const { dropOverlay, dropMessage, fileInput } = app.dom;
  dropMessage.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', e => { if (e.target.files[0]) loadFile(e.target.files[0]); });
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt => {
    document.body.addEventListener(evt, e => { e.preventDefault(); e.stopPropagation(); });
  });
  document.body.addEventListener('dragover', () => dropOverlay.classList.add('active'));
  document.body.addEventListener('dragleave', e => {
    if (e.clientX === 0 && e.clientY === 0) dropOverlay.classList.remove('active');
  });
  document.body.addEventListener('drop', e => {
    dropOverlay.classList.remove('active');
    if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
  });
}

export function initThemeToggle() {
  const btn = document.getElementById('theme-toggle');
  const icon = document.getElementById('theme-toggle-icon');

  const syncIcon = theme => {
    if (!btn || !icon) return;

    icon.src = theme === 'dark' ? '/light_icon.svg' : '/dark_icon.svg';
    btn.title = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  };

  const saved = localStorage.getItem('geomy-theme') || 'light';
  document.documentElement.setAttribute('data-theme', saved);
  syncIcon(saved);

  btn?.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    const next = cur === 'dark' ? 'light' : 'dark';

    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('geomy-theme', next);
    syncIcon(next);
    window.dispatchEvent(new Event('themechange'));
  });

  initPanelOpacityToggle();
}

function initPanelOpacityToggle() {
  const btn = document.getElementById('panel-opacity-toggle');
  const icon = document.getElementById('panel-opacity-toggle-icon');
  if (!btn || !icon) return;

  const normalize = value => value === 'opaque' ? 'opaque' : 'transparent';
  const currentTheme = () => document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';

  const iconFor = mode => {
    const isOpaque = mode === 'opaque';
    const action = isOpaque ? 'transparent' : 'opaque';
    const suffix = currentTheme() === 'dark' ? '_dark' : '';

    return `/panel_${action}_icon${suffix}.svg`;
  };

  const syncIcon = mode => {
    const isOpaque = mode === 'opaque';

    icon.src = iconFor(mode);
    btn.title = isOpaque ? 'Use transparent panels' : 'Make panels opaque';
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('aria-pressed', String(isOpaque));
  };

  const saved = normalize(localStorage.getItem('geomy-panel-opacity'));
  document.documentElement.setAttribute('data-panel-opacity', saved);
  syncIcon(saved);

  btn.addEventListener('click', () => {
    const cur = normalize(document.documentElement.getAttribute('data-panel-opacity'));
    const next = cur === 'opaque' ? 'transparent' : 'opaque';

    document.documentElement.setAttribute('data-panel-opacity', next);
    localStorage.setItem('geomy-panel-opacity', next);
    syncIcon(next);
  });

  window.addEventListener('themechange', () => {
    syncIcon(normalize(document.documentElement.getAttribute('data-panel-opacity')));
  });
}

// ── Task switching ──
export function registerTask(taskModule) {
  app.tasks[taskModule.id] = taskModule;
}

export function switchTask(taskId) {
  if (app.task?.deactivate) app.task.deactivate();
  app.task = app.tasks[taskId] || null;
  updateTaskMeshLoader(app.task);
  if (app.task?.activate) app.task.activate();
  updateTaskMeshLoader(app.task);
}
