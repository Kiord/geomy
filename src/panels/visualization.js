import * as THREE from 'three';
import { VertexNormalsHelper } from 'three/examples/jsm/helpers/VertexNormalsHelper.js';
import {
  app,
  loadEnvironmentFile,
  resetEnvironmentMap,
  setControlsMode,
  setEnvironmentBackgroundBlurriness,
  setEnvironmentBackgroundVisible,
} from '../app.js';

let normalsHelpers = [];
let bboxHelper = null;
let gridHelper = null;
let originalMaterials = [];
let transparencyMode = 'auto';
let currentNormalType = 'smooth'; // 'smooth' or 'flat'
let lambertLights = [];

const DEFAULT_MATERIAL_VALUES = {
  normalStrength: 1,
  roughness: 0.4,
  metalness: 0.1,
  aoIntensity: 1,
  emissiveColor: '#ffffff',
  emissiveIntensity: 0,
  emissiveMapIntensity: 1,
};


export function initVizPanel() {
  const wireCheck = document.getElementById('viz-wireframe');
  const normCheck = document.getElementById('viz-normals');
  const bboxCheck = document.getElementById('viz-bbox');
  const envBgCheck = document.getElementById('viz-env-bg');
  const envBgControls = document.getElementById('viz-env-bg-controls');
  const envBgFileInput = document.getElementById('viz-env-file');
  const envBgReset = document.getElementById('viz-env-reset');
  const envBgBlurSlider = document.getElementById('viz-env-blur');
  const envBgBlurVal = document.getElementById('viz-env-blur-val');

  const colorModeRadios = document.querySelectorAll('input[name="viz-color-mode"]');
  const flatColorInput = document.getElementById('viz-flat-color');

  const normalMapCheck = document.getElementById('viz-normalmap');
  const gridCheck = document.getElementById('viz-grid');
  const cullCheck = document.getElementById('viz-cull');
  const opacitySlider = document.getElementById('viz-opacity');
  const opacityVal = document.getElementById('opacity-val');
  const shadingRadios = document.querySelectorAll('input[name="shading"]');
  const smoothShadingCheck = document.getElementById('viz-smooth-shading');

  const lightSlider = document.getElementById('viz-light-intensity');
  const lightVal = document.getElementById('light-intensity-val');

  const controlsModeSelect = document.getElementById('viz-controls-mode');

  let sharedUvTexture = null;
  const textureLoader = new THREE.TextureLoader();
  const materialTextures = {
    map: null,
    normalMap: null,
    roughnessMap: null,
    metalnessMap: null,
    aoMap: null,
    emissiveMap: null,
  };

  const materialInputs = {
    map: document.getElementById('mat-map'),
    normalMap: document.getElementById('mat-normal-map'),
    roughnessMap: document.getElementById('mat-roughness-map'),
    metalnessMap: document.getElementById('mat-metalness-map'),
    aoMap: document.getElementById('mat-ao-map'),
    emissiveMap: document.getElementById('mat-emissive-map'),

    normalStrength: document.getElementById('mat-normal-strength'),
    roughness: document.getElementById('mat-roughness'),
    metalness: document.getElementById('mat-metalness'),
    aoIntensity: document.getElementById('mat-ao-intensity'),
    emissiveColor: document.getElementById('mat-emissive-color'),
    emissiveIntensity: document.getElementById('mat-emissive-intensity'),
  };

  function initCollapsibleSections() {
    document.querySelectorAll('.viz-panel-section').forEach(section => {
      const header = section.querySelector('.viz-section-header');
      if (!header) return;

      const key = section.dataset.vizSection || header.textContent.trim().toLowerCase();
      const storageKey = `geomy-viz-section-${key}-collapsed`;

      function setCollapsed(collapsed) {
        section.classList.toggle('is-collapsed', collapsed);
        header.setAttribute('aria-expanded', String(!collapsed));
        localStorage.setItem(storageKey, collapsed ? '1' : '0');
      }

      setCollapsed(localStorage.getItem(storageKey) === '1');

      header.addEventListener('click', () => {
        setCollapsed(!section.classList.contains('is-collapsed'));
      });
    });
  }

  initCollapsibleSections();

  currentNormalType = smoothShadingCheck?.checked ? 'smooth' : 'flat';

  if (controlsModeSelect) {
    controlsModeSelect.value = app.controlsMode || 'arcball';

    controlsModeSelect.addEventListener('change', () => {
      setControlsMode(controlsModeSelect.value);
    });
  }

  function getColorMode() {
    const checked = document.querySelector('input[name="viz-color-mode"]:checked');
    return checked ? checked.value : 'texture';
  }

  function getFlatColor() {
    return flatColorInput?.value || '#b3b3e6';
  }

  function getCurrentShadingMode() {
    const checked = document.querySelector('input[name="shading"]:checked');
    return checked ? checked.value : 'lambert';
  }

  function getLightIntensity() {
    return Math.max(
      0,
      parseInt(lightSlider?.value || '100', 10) / 100
    );
  }

  function updateLightIntensityLabel() {
    if (lightVal) {
      lightVal.textContent = `${Math.round(getLightIntensity() * 100)}%`;
    }
  }

  function getEnvironmentBackgroundBlurriness() {
    const value = parseFloat(envBgBlurSlider?.value ?? app.environmentBackgroundBlurriness ?? 0.3);
    return Number.isFinite(value) ? value : 0.3;
  }

  function updateEnvironmentBackgroundControls() {
    const visible = !!envBgCheck?.checked;

    envBgControls?.classList.toggle('is-hidden', !visible);

    if (envBgBlurSlider) {
      envBgBlurSlider.value = String(app.environmentBackgroundBlurriness ?? 0.3);
    }

    if (envBgBlurVal) {
      envBgBlurVal.textContent = getEnvironmentBackgroundBlurriness().toFixed(2);
    }
  }

  function withLightIntensity(colorValue) {
    return new THREE.Color(colorValue).multiplyScalar(getLightIntensity());
  }

  function getMaterialList(material) {
    if (!material) return [];
    return Array.isArray(material) ? material : [material];
  }

  function cloneMaterialOrArray(material) {
    if (Array.isArray(material)) {
      return material.map(mat => mat?.clone?.() || mat);
    }

    return material?.clone?.() || material;
  }

  function disposeMaterialOrArray(material) {
    getMaterialList(material).forEach(mat => mat?.dispose?.());
  }

  function ensureLambertLights() {
    lambertLights = lambertLights.filter(light => light?.parent);

    if (lambertLights.length) return lambertLights;

    const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.8);
    hemi.name = 'geomy-lambert-hemi-light';

    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.name = 'geomy-lambert-key-light';
    key.position.set(2.5, 3.5, 4.0);

    const fill = new THREE.DirectionalLight(0xffffff, 0.65);
    fill.name = 'geomy-lambert-fill-light';
    fill.position.set(-3.0, 1.5, -2.0);

    lambertLights = [hemi, key, fill];
    lambertLights.forEach(light => {
      light.visible = false;
      app.scene.add(light);
    });

    return lambertLights;
  }

  function setLambertLightsVisible(visible, intensity = 1) {
    const lights = ensureLambertLights();
    const safeIntensity = Math.max(0, intensity);

    lights.forEach(light => {
      light.visible = visible;
    });

    if (lights[0]) lights[0].intensity = 1.8 * safeIntensity;
    if (lights[1]) lights[1].intensity = 2.2 * safeIntensity;
    if (lights[2]) lights[2].intensity = 0.65 * safeIntensity;
  }

  function findGrid() {
    if (gridHelper) return gridHelper;

    app.scene.traverse(c => {
      if (c.name === 'main-grid') gridHelper = c;
    });

    return gridHelper;
  }

  function isVisibleInCurrentHierarchy(object) {
    let cursor = object;

    while (cursor) {
      if (cursor.visible === false) return false;
      if (cursor === app.currentObject) return true;
      cursor = cursor.parent;
    }

    return true;
  }

  function getMeshes() {
    const meshes = [];

    if (!app.currentObject) return meshes;

    app.currentObject.traverse(c => {
      if (c.isMesh && isVisibleInCurrentHierarchy(c)) meshes.push(c);
    });

    return meshes;
  }

  function storeOriginals() {
    originalMaterials = [];

    if (!app.currentObject) return;

    app.currentObject.traverse(c => {
      if (c.isMesh && c.material) {
        const originalMaterial = cloneMaterialOrArray(c.material);

        originalMaterials.push({
          mesh: c,
          material: originalMaterial,
        });

        c.userData.geomyOriginalMaterial = originalMaterial;
      }
    });
  }

  function getOriginalMaterial(mesh) {
    const entry = originalMaterials.find(o => o.mesh === mesh);
    return entry ? entry.material : null;
  }

  function getFirstOriginalMaterial() {
    for (const entry of originalMaterials) {
      const mat = getMaterialList(entry.material).find(Boolean);
      if (mat) return mat;
    }

    return null;
  }

  function hasOriginalTexture(slot) {
    return originalMaterials.some(entry => (
      getMaterialList(entry.material).some(mat => !!mat?.[slot])
    ));
  }

  function setEnvironmentForMode(mode) {
    if (app.renderOverride) {
      app.scene.environment = null;
      return;
    }

    const envOn = mode === 'pbr';
    const lightIntensity = getLightIntensity();

    // Only PBR gets the HDR environment. Lambert uses regular diffuse lights so
    // there are no glossy/specular reflections from the environment map.
    app.scene.environment = envOn ? app.environmentTexture : null;

    setLambertLightsVisible(mode === 'lambert', lightIntensity);

    app.scene.traverse(obj => {
      if (!obj.isLight || lambertLights.includes(obj)) return;
      obj.visible = false;
    });

    app.currentObject?.traverse(obj => {
      if (!obj.isMesh || !obj.material) return;

      getMaterialList(obj.material).forEach(mat => {
        if (mat.isMeshStandardMaterial || mat.isMeshPhysicalMaterial) {
          mat.envMap = envOn ? app.environmentTexture : null;
          mat.envMapIntensity = envOn ? lightIntensity : 0.0;
          mat.needsUpdate = true;
        }
      });
    });
  }

  function applyBackfaceCulling() {
    if (app.renderOverride) {
      app.task?.onVizBackfaceCulling?.(!!cullCheck?.checked);
      return;
    }

    const side = cullCheck?.checked ? THREE.FrontSide : THREE.DoubleSide;

    app.currentObject?.traverse(c => {
      if (!c.isMesh || !c.material) return;

      getMaterialList(c.material).forEach(mat => {
        mat.side = side;
        mat.needsUpdate = true;
      });
    });
  }

  function getNumber(input, fallback = 0) {
    const n = parseFloat(input?.value);
    return Number.isFinite(n) ? n : fallback;
  }

  function setInputValue(input, value) {
    if (!input || value === undefined || value === null) return;
    input.value = String(value);
  }

  function setColorInputValue(input, value) {
    if (!input) return;

    const color = value instanceof THREE.Color
      ? `#${value.getHexString()}`
      : String(value || DEFAULT_MATERIAL_VALUES.emissiveColor);

    input.value = color;
  }

  function updateMaterialValueLabels() {
    const labels = [
      ['normalStrength', 'mat-normal-strength-val'],
      ['roughness', 'mat-roughness-val'],
      ['metalness', 'mat-metalness-val'],
      ['aoIntensity', 'mat-ao-intensity-val'],
      ['emissiveIntensity', 'mat-emissive-intensity-val'],
    ];

    labels.forEach(([inputKey, labelId]) => {
      const input = materialInputs[inputKey];
      const label = document.getElementById(labelId);

      if (input && label) {
        label.textContent = Number(input.value).toFixed(2);
      }
    });
  }


  function hasActiveMaterialMap(slot) {
    return !!materialTextures[slot] || hasOriginalTexture(slot);
  }

  function getDefaultEmissiveIntensity(orig = null) {
    return (materialTextures.emissiveMap || orig?.emissiveMap || hasActiveMaterialMap('emissiveMap'))
      ? DEFAULT_MATERIAL_VALUES.emissiveMapIntensity
      : DEFAULT_MATERIAL_VALUES.emissiveIntensity;
  }

  function syncEmissiveIntensityDefaultForMap(orig = null) {
    setInputValue(materialInputs.emissiveIntensity, getDefaultEmissiveIntensity(orig));
    updateMaterialValueLabels();
  }

  function syncEmissiveDefaultsForMap(orig = null) {
    setColorInputValue(materialInputs.emissiveColor, DEFAULT_MATERIAL_VALUES.emissiveColor);
    syncEmissiveIntensityDefaultForMap(orig);
  }

  function updateMaterialMapDependentVisibility() {
    document.querySelectorAll('[data-map-slot]').forEach(el => {
      const slot = el.dataset.mapSlot;
      el.classList.toggle('is-hidden', hasActiveMaterialMap(slot));
    });

    document.querySelectorAll('[data-map-note]').forEach(el => {
      const slot = el.dataset.mapNote;
      el.classList.toggle('is-hidden', !hasActiveMaterialMap(slot));
    });
  }

  function updateMaterialPropertyVisibility(mode = getCurrentShadingMode()) {
    document.querySelectorAll('[data-visible-modes]').forEach(el => {
      const modes = (el.dataset.visibleModes || '').split(/\s+/).filter(Boolean);
      el.classList.toggle('is-hidden', modes.length > 0 && !modes.includes(mode));
    });

    updateMaterialMapDependentVisibility();
  }

  function prepareTexture(texture, slot) {
    if (slot === 'map' || slot === 'emissiveMap') {
      texture.colorSpace = THREE.SRGBColorSpace;
    }

    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.needsUpdate = true;

    return texture;
  }

  function loadTextureFromInput(input, slot) {
    const file = input?.files?.[0];
    if (!file) return;

    const url = URL.createObjectURL(file);

    textureLoader.load(
      url,
      texture => {
        URL.revokeObjectURL(url);

        materialTextures[slot]?.dispose?.();
        materialTextures[slot] = prepareTexture(texture, slot);

        if (slot === 'map') {
          const textureRadio = document.querySelector('input[name="viz-color-mode"][value="texture"]');
          if (textureRadio) textureRadio.checked = true;
        }

        if (slot === 'normalMap' && normalMapCheck) {
          normalMapCheck.checked = true;
        }

        if (slot === 'emissiveMap') {
          syncEmissiveDefaultsForMap();
        }

        updateMaterialMapDependentVisibility();
        applyShading(getCurrentShadingMode());
      },
      undefined,
      err => {
        URL.revokeObjectURL(url);
        console.error(`Failed to load material texture "${slot}":`, err);
      }
    );
  }

  function clearMaterialTexture(slot) {
    if (!slot || !(slot in materialTextures)) return;

    materialTextures[slot]?.dispose?.();
    materialTextures[slot] = null;

    if (materialInputs[slot]) {
      materialInputs[slot].value = '';
    }

    if (slot === 'emissiveMap') {
      syncEmissiveDefaultsForMap(getFirstOriginalMaterial());
    }

    updateMaterialMapDependentVisibility();
    applyShading(getCurrentShadingMode());
  }

  function clearMaterialTextureInputs() {
    Object.keys(materialTextures).forEach(slot => {
      if (materialInputs[slot]) materialInputs[slot].value = '';
    });
  }

  function disposeMaterialTextures() {
    Object.keys(materialTextures).forEach(slot => {
      materialTextures[slot]?.dispose?.();
      materialTextures[slot] = null;
    });
  }

  function getTexture(slot, orig) {
    return materialTextures[slot] || orig?.[slot] || null;
  }

  function ensureAoUv2(mesh) {
    const geo = mesh.geometry;

    if (!geo?.attributes?.uv2 && geo?.attributes?.uv) {
      geo.setAttribute('uv2', geo.attributes.uv);
    }
  }

  function resetMaterialControlsToDefaults() {
    setInputValue(materialInputs.normalStrength, DEFAULT_MATERIAL_VALUES.normalStrength);
    setInputValue(materialInputs.roughness, DEFAULT_MATERIAL_VALUES.roughness);
    setInputValue(materialInputs.metalness, DEFAULT_MATERIAL_VALUES.metalness);
    setInputValue(materialInputs.aoIntensity, DEFAULT_MATERIAL_VALUES.aoIntensity);
    syncEmissiveDefaultsForMap();

    updateMaterialValueLabels();
  }

  function makeCommonParams(oldMat, orig, useColorTexture, flatColorHex) {
    const opacity = oldMat?.opacity ?? orig?.opacity ?? 1;
    const transparent = oldMat?.transparent ?? orig?.transparent ?? false;
    const colorMap = useColorTexture ? getTexture('map', orig) : null;

    return {
      color: useColorTexture
        ? (orig?.color?.getHex?.() ?? oldMat?.color?.getHex?.() ?? 0xe0e0e0)
        : flatColorHex,

      map: colorMap,
      alphaMap: useColorTexture ? (orig?.alphaMap || null) : null,

      opacity,
      transparent: transparent || opacity < 0.999,
      side: cullCheck?.checked ? THREE.FrontSide : THREE.DoubleSide,
    };
  }

  function getNormalMapParams(orig, mesh) {
    const normalMap = getTexture('normalMap', orig);
    const hasUv = !!mesh?.geometry?.attributes?.uv;

    if (!normalMapCheck?.checked || !normalMap || !hasUv) {
      return null;
    }

    const strength = getNumber(
      materialInputs.normalStrength,
      orig?.normalScale?.x ?? DEFAULT_MATERIAL_VALUES.normalStrength
    );

    return {
      normalMap,
      normalScale: new THREE.Vector2(strength, strength),
    };
  }

  function makeStandardParams(oldMat, orig, useColorTexture, flatColorHex, mesh, options = {}) {
    const roughnessMap = getTexture('roughnessMap', orig);
    const metalnessMap = getTexture('metalnessMap', orig);

    const params = {
      ...makeCommonParams(oldMat, orig, useColorTexture, flatColorHex),

      // In Three.js, roughness/metalness scalar values multiply their maps.
      // When a map is active, keep the scalar at 1 so the map is authoritative.
      roughness: options.forceRoughness ?? (roughnessMap
        ? 1
        : getNumber(materialInputs.roughness, orig?.roughness ?? DEFAULT_MATERIAL_VALUES.roughness)
      ),

      metalness: options.forceMetalness ?? (metalnessMap
        ? 1
        : getNumber(materialInputs.metalness, orig?.metalness ?? DEFAULT_MATERIAL_VALUES.metalness)
      ),
    };

    const normalParams = getNormalMapParams(orig, mesh);
    if (normalParams) Object.assign(params, normalParams);

    if (roughnessMap) params.roughnessMap = roughnessMap;

    if (metalnessMap) params.metalnessMap = metalnessMap;

    const aoMap = getTexture('aoMap', orig);
    if (aoMap) {
      ensureAoUv2(mesh);
      params.aoMap = aoMap;
      params.aoMapIntensity = getNumber(
        materialInputs.aoIntensity,
        orig?.aoMapIntensity ?? DEFAULT_MATERIAL_VALUES.aoIntensity
      );
    }

    const emissiveMap = getTexture('emissiveMap', orig);
    const emissiveColor = materialInputs.emissiveColor?.value || DEFAULT_MATERIAL_VALUES.emissiveColor;
    params.emissive = new THREE.Color(emissiveColor);
    params.emissiveIntensity = getNumber(
      materialInputs.emissiveIntensity,
      getDefaultEmissiveIntensity(orig)
    );

    if (emissiveMap) params.emissiveMap = emissiveMap;

    return params;
  }

  function makeLambertParams(oldMat, orig, useColorTexture, flatColorHex, mesh) {
    const params = {
      ...makeCommonParams(oldMat, orig, useColorTexture, flatColorHex),
      specular: 0x000000,
      shininess: 0,
      envMap: null,
    };

    const normalParams = getNormalMapParams(orig, mesh);
    if (normalParams) Object.assign(params, normalParams);

    return params;
  }

  function makeNormalGradientMaterial(common) {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        opacity: { value: common.opacity },
      },
      vertexShader: `
        varying vec3 vWorldNormal;

        void main() {
          vWorldNormal = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float opacity;
        varying vec3 vWorldNormal;

        void main() {
          vec3 n = normalize(vWorldNormal);
          gl_FragColor = vec4(n * 0.5 + 0.5, opacity);
        }
      `,
      transparent: common.transparent,
      opacity: common.opacity,
      side: common.side,
    });

    mat.depthWrite = !common.transparent;
    return mat;
  }

  function buildMaterialForMode(mode, oldMat, orig, mesh, useColorTexture, flatColorHex) {
    const common = makeCommonParams(oldMat, orig, useColorTexture, flatColorHex);
    const lightIntensity = getLightIntensity();

    switch (mode) {
      case 'unlit':
        // Texture/flat color only. Other material properties stay editable but inactive.
        return new THREE.MeshBasicMaterial({
          ...common,
          color: withLightIntensity(common.color),
        });

      case 'lambert':
        // Diffuse-only lighting. MeshPhongMaterial is used with black specular
        // so normal maps work while environment reflections stay off.
        return new THREE.MeshPhongMaterial(makeLambertParams(
          oldMat,
          orig,
          useColorTexture,
          flatColorHex,
          mesh
        ));

      case 'pbr':
        return new THREE.MeshStandardMaterial({
          ...makeStandardParams(oldMat, orig, useColorTexture, flatColorHex, mesh),
          envMap: app.environmentTexture,
          envMapIntensity: lightIntensity,
        });

      case 'normal':
        return makeNormalGradientMaterial(common, orig, mesh);
      
      case 'uv':
        if (!sharedUvTexture) {
          sharedUvTexture = textureLoader.load('/uv_texture.png');
          sharedUvTexture.colorSpace = THREE.SRGBColorSpace;
          sharedUvTexture.wrapS = THREE.RepeatWrapping;
          sharedUvTexture.wrapT = THREE.RepeatWrapping;
        }
        return new THREE.MeshBasicMaterial({
          ...common,
          map: sharedUvTexture,
          color: 0xffffff,
        });

      default:
        return new THREE.MeshPhongMaterial(makeLambertParams(
          oldMat,
          orig,
          useColorTexture,
          flatColorHex,
          mesh
        ));
    }
  }

  function applyShading(mode) {
    updateMaterialPropertyVisibility(mode);

    if (app.renderOverride) return;

    const useColorTexture = getColorMode() === 'texture';
    const flatColorHex = new THREE.Color(getFlatColor()).getHex();

    setEnvironmentForMode(mode);

    app.currentObject?.traverse(c => {
      if (!c.isMesh) return;

      const origMaterial = getOriginalMaterial(c);
      const oldMaterial = c.material;
      const origList = getMaterialList(origMaterial);
      const oldList = getMaterialList(oldMaterial);
      const useArrayMaterial = Array.isArray(origMaterial) || Array.isArray(oldMaterial);
      const materialCount = Math.max(origList.length, oldList.length, 1);

      const nextMaterials = Array.from({ length: materialCount }, (_, i) => {
        const orig = origList[i] || origList[0] || null;
        const oldMat = oldList[i] || oldList[0] || null;
        const wasWireframe = oldMat?.wireframe ?? false;
        const nextMat = buildMaterialForMode(mode, oldMat, orig, c, useColorTexture, flatColorHex);

        nextMat.wireframe = wasWireframe;

        if ('flatShading' in nextMat) {
          nextMat.flatShading = currentNormalType === 'flat';
        }

        nextMat.needsUpdate = true;
        return nextMat;
      });

      c.material = useArrayMaterial ? nextMaterials : nextMaterials[0];
      disposeMaterialOrArray(oldMaterial);
    });

    applyBackfaceCulling();
    applyOpacity(parseInt(opacitySlider?.value || '100', 10) / 100);
  }

  function applyTexture() {
    applyShading(getCurrentShadingMode());
  }

  function applyMaterialProperties() {
    updateMaterialValueLabels();
    applyShading(getCurrentShadingMode());
  }

  function applyWireframe(show) {
    if (app.renderOverride) {
      app.task?.onVizWireframe?.(!!show);
      return;
    }

    app.currentObject?.traverse(c => {
      if (!c.isMesh || !c.material) return;

      getMaterialList(c.material).forEach(mat => {
        mat.wireframe = show;
        mat.needsUpdate = true;
      });
    });
  }

  function applyOpacity(val) {
    if (app.renderOverride) {
      app.task?.onVizOpacity?.(val);
      return;
    }

    const needsTransparency = val < 0.999;

    app.currentObject?.traverse(c => {
      if (!c.isMesh || !c.material) return;

      getMaterialList(c.material).forEach(mat => {
        mat.opacity = val;
        mat.transparent = needsTransparency;
        mat.depthWrite = !needsTransparency;
        mat.needsUpdate = true;
      });
    });

    if (app.renderer && transparencyMode === 'auto') {
      app.renderer.sortObjects = needsTransparency;
    }
  }

  function clearNormals() {
    normalsHelpers.forEach(h => {
      h.removeFromParent();
      h.dispose?.();
    });

    normalsHelpers = [];
  }

  function toggleNormals(show) {
    clearNormals();

    if (!show) return;

    const meshes = getMeshes();
    if (!meshes.length) return;

    const box = new THREE.Box3().setFromObject(app.currentObject);
    const size = box.getSize(new THREE.Vector3()).length();
    const len = Math.max(size * 0.03, 0.005);

    meshes.forEach(mesh => {
      try {
        const helper = new VertexNormalsHelper(mesh, len, 0x00ffcc);
        app.scene.add(helper);
        normalsHelpers.push(helper);
      } catch (e) {
        console.warn('Could not create normals helper for mesh:', mesh.name, e);
      }
    });
  }

  function toggleGrid(show) {
    const grid = findGrid();
    if (grid) grid.visible = show;
  }

  // ── Listeners ──

  wireCheck?.addEventListener('change', () => {
    applyWireframe(wireCheck.checked);
  });

  colorModeRadios.forEach(r => {
    r.addEventListener('change', () => {
      if (r.checked) applyTexture();
    });
  });

  flatColorInput?.addEventListener('input', () => {
    if (getColorMode() === 'flat') {
      applyTexture();
    }
  });

  Object.entries({
    map: materialInputs.map,
    normalMap: materialInputs.normalMap,
    roughnessMap: materialInputs.roughnessMap,
    metalnessMap: materialInputs.metalnessMap,
    aoMap: materialInputs.aoMap,
    emissiveMap: materialInputs.emissiveMap,
  }).forEach(([slot, input]) => {
    input?.addEventListener('change', () => {
      loadTextureFromInput(input, slot);
    });
  });

  document.querySelectorAll('[data-clear-texture]').forEach(btn => {
    btn.addEventListener('click', () => {
      clearMaterialTexture(btn.dataset.clearTexture);
    });
  });

  [
    materialInputs.normalStrength,
    materialInputs.roughness,
    materialInputs.metalness,
    materialInputs.aoIntensity,
    materialInputs.emissiveIntensity,
  ].forEach(input => {
    input?.addEventListener('input', applyMaterialProperties);
  });

  materialInputs.emissiveColor?.addEventListener('input', applyMaterialProperties);

  normalMapCheck?.addEventListener('change', () => {
    applyMaterialProperties();
  });

  normCheck?.addEventListener('change', () => {
    toggleNormals(normCheck.checked);
  });

  gridCheck?.addEventListener('change', () => {
    toggleGrid(gridCheck.checked);
  });

  envBgCheck?.addEventListener('change', () => {
    updateEnvironmentBackgroundControls();
    setEnvironmentBackgroundVisible(envBgCheck.checked);
  });

  envBgBlurSlider?.addEventListener('input', () => {
    const value = getEnvironmentBackgroundBlurriness();

    if (envBgBlurVal) {
      envBgBlurVal.textContent = value.toFixed(2);
    }

    setEnvironmentBackgroundBlurriness(value);
  });

  envBgFileInput?.addEventListener('change', async () => {
    const file = envBgFileInput.files?.[0];
    if (!file) return;

    try {
      await loadEnvironmentFile(file);
      applyShading(getCurrentShadingMode());
    } catch (err) {
      console.error(err);
      alert(err?.message || 'Failed to load environment map.');
      envBgFileInput.value = '';
    }
  });

  envBgReset?.addEventListener('click', async () => {
    try {
      await resetEnvironmentMap();
      if (envBgFileInput) envBgFileInput.value = '';
      applyShading(getCurrentShadingMode());
    } catch (err) {
      console.error(err);
      alert('Failed to reset the environment map.');
    }
  });

  cullCheck?.addEventListener('change', () => {
    applyBackfaceCulling();
  });

  bboxCheck?.addEventListener('change', () => {
    if (!app.currentObject) return;

    if (bboxCheck.checked) {
      if (!bboxHelper) {
        bboxHelper = new THREE.BoxHelper(app.currentObject, 0xffff00);
        app.scene.add(bboxHelper);
      }

      bboxHelper.visible = true;
    } else if (bboxHelper) {
      bboxHelper.visible = false;
    }
  });

  opacitySlider?.addEventListener('input', () => {
    const v = parseInt(opacitySlider.value, 10) / 100;

    if (opacityVal) {
      opacityVal.textContent = Math.round(v * 100) + '%';
    }

    applyOpacity(v);
  });

  lightSlider?.addEventListener('input', () => {
    updateLightIntensityLabel();
    applyShading(getCurrentShadingMode());
  });

  shadingRadios.forEach(r => {
    r.addEventListener('change', () => {
      if (r.checked) applyShading(r.value);
    });
  });

  smoothShadingCheck?.addEventListener('change', () => {
    currentNormalType = smoothShadingCheck.checked ? 'smooth' : 'flat';
    applyShading(getCurrentShadingMode());

    if (normCheck?.checked) {
      toggleNormals(true);
    }
  });

  updateLightIntensityLabel();
  updateEnvironmentBackgroundControls();
  updateMaterialValueLabels();
  updateMaterialPropertyVisibility();

  return {
    onFileLoaded() {
      storeOriginals();

      // Imported materials can bring an emissive map without touching the UI file input.
      // Keep the default multiplier rule in sync with those imported maps:
      // emissive map => 1, no emissive map => 0.
      syncEmissiveIntensityDefaultForMap(getFirstOriginalMaterial());

      const mode = getCurrentShadingMode();

      updateLightIntensityLabel();
      updateMaterialValueLabels();
      updateMaterialPropertyVisibility(mode);
      updateEnvironmentBackgroundControls();
      setEnvironmentBackgroundVisible(envBgCheck?.checked);
      applyShading(mode);

      if (normCheck?.checked) {
        toggleNormals(true);
      }
    },

    reset() {
      clearNormals();

      if (bboxHelper) {
        bboxHelper.removeFromParent();
        bboxHelper = null;
      }

      disposeMaterialTextures();
      clearMaterialTextureInputs();
      originalMaterials = [];

      if (wireCheck) wireCheck.checked = false;
      if (normCheck) normCheck.checked = false;
      if (bboxCheck) bboxCheck.checked = false;
      if (normalMapCheck) normalMapCheck.checked = true;
      if (gridCheck) {
        gridCheck.checked = false;
        toggleGrid(false);
      }

      if (envBgCheck) {
        envBgCheck.checked = false;
        setEnvironmentBackgroundVisible(false);
      }

      if (envBgFileInput) envBgFileInput.value = '';

      if (envBgBlurSlider) {
        envBgBlurSlider.value = String(app.environmentBackgroundBlurriness ?? 0.3);
      }

      updateEnvironmentBackgroundControls();

      if (cullCheck) cullCheck.checked = false;

      if (colorModeRadios.length) {
        const textureRadio = document.querySelector('input[name="viz-color-mode"][value="texture"]');
        if (textureRadio) textureRadio.checked = true;
      }

      if (flatColorInput) {
        flatColorInput.value = '#b3b3e6';
      }

      resetMaterialControlsToDefaults();

      if (opacitySlider) {
        opacitySlider.value = 100;
      }

      if (opacityVal) {
        opacityVal.textContent = '100%';
      }

      const lambertRadio = document.querySelector('input[name="shading"][value="lambert"]');
      if (lambertRadio) lambertRadio.checked = true;

      if (smoothShadingCheck) smoothShadingCheck.checked = true;
      currentNormalType = 'smooth';

      if (app.renderer) {
        app.renderer.sortObjects = false;
      }

      app.scene.environment = null;
      setLambertLightsVisible(false);

      if (lightSlider) {
        lightSlider.value = 100;
      }

      updateLightIntensityLabel();
      updateMaterialPropertyVisibility('lambert');
    },
  };
}





