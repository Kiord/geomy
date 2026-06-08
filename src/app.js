import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';

import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoundedArcballControls } from './controls/RoundedArcballControls.js';

import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { getTaskCapabilities, taskAcceptsSharedMeshLoad } from './core/taskCapabilities.js';

// ── Central state ──
export const app = {
  scene: null,
  camera: null,
  renderer: null,
  controls: null,
  controlsMode: 'arcball',
  currentObject: null,
  currentFileName: '',
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
  app.dom.taskLoadedMeshName = document.getElementById('task-loaded-mesh-name');
  app.dom.vertexCount = document.getElementById('vertex-count');

  initTaskMeshLoader();

  // Background color synced with theme
  syncBackground();
}

function initTaskMeshLoader() {
  app.dom.taskLoadMeshBtn?.addEventListener('click', () => {
    app.dom.fileInput?.click();
  });

  updateTaskMeshLoader();
}

function updateTaskMeshLoader(task = app.task) {
  const row = app.dom.taskMeshLoader;
  const label = app.dom.taskLoadedMeshName;

  if (!row) return;

  const capabilities = getTaskCapabilities(task);
  const showLoader = capabilities.usesTaskMeshLoader !== false;

  row.hidden = !showLoader;
  row.style.display = showLoader ? 'grid' : 'none';

  if (label) {
    label.textContent = app.currentFileName || 'No mesh loaded';
    label.title = app.currentFileName || '';
  }
}

function setLoadedMeshName(name) {
  app.currentFileName = name || '';
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
  obj: new OBJLoader(),
  stl: new STLLoader(),
  ply: new PLYLoader(),
};


function smoothImportedGeometry(geometry) {
  if (!geometry?.attributes?.position) return geometry;

  // Critical: never weld, merge, re-index, or otherwise replace imported
  // geometry here. Geomy tools (masking, landmarks, segmentation, rigid align)
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

    let verts = 0;
    obj.traverse(c => {
      if (c.isMesh && c.geometry) verts += c.geometry.attributes.position?.count || 0;
    });
    app.dom.vertexCount.textContent = verts ? `${verts.toLocaleString()} verts` : '';

    if (app.task?.onFileLoaded) app.task.onFileLoaded();
  }

  try {
    switch (ext) {
      case 'glb': case 'gltf':
        loaders.gltf.load(url, g => {
          prepareObjectGeometry(g.scene);
          addToScene(g.scene);
        }); break;
      case 'obj':
        loaders.obj.load(url, obj => {
          prepareObjectGeometry(obj);
          obj.traverse(c => {
            if (c.isMesh) c.material = new THREE.MeshStandardMaterial({ color: '#e0e0e0', roughness: 0.4, metalness: 0.1 });
          });
          addToScene(obj);
        }); break;
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



