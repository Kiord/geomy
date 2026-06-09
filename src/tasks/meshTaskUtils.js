import * as THREE from 'three';
import { app, updateEnvironmentUsage } from '../app.js';

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function getViewportRect() {
  return app.dom.viewport.getBoundingClientRect();
}

export function getCurrentMeshes() {
  const meshes = [];

  app.currentObject?.traverse(object => {
    if (object.isMesh && object.geometry?.attributes?.position) {
      meshes.push(object);
    }
  });

  return meshes;
}

export function getMeshLabel(mesh) {
  return mesh?.name || mesh?.parent?.name || mesh?.type || 'mesh';
}

export function getTriangleCount(mesh) {
  const canonical = getCanonicalData(mesh);
  if (canonical?.faceCount) return canonical.faceCount;

  const position = mesh?.geometry?.attributes?.position;
  if (!position) return 0;

  const index = mesh.geometry.index;
  return Math.floor((index ? index.count : position.count) / 3);
}


export function getCanonicalData(mesh) {
  return mesh?.geometry?.userData?.geomyCanonical || mesh?.userData?.geomyCanonical || null;
}

export function getCanonicalVertexCount(mesh) {
  const canonical = getCanonicalData(mesh);
  return canonical?.vertexCount || mesh?.geometry?.attributes?.position?.count || 0;
}

export function getCanonicalFaceCount(mesh) {
  const canonical = getCanonicalData(mesh);
  return canonical?.faceCount || getTriangleCount(mesh);
}

export function getCanonicalPositionAttribute(mesh) {
  const canonical = getCanonicalData(mesh);
  if (!canonical?.positions) return mesh?.geometry?.attributes?.position || null;

  if (!canonical.positionAttribute || canonical.positionAttribute.array !== canonical.positions) {
    canonical.positionAttribute = new THREE.Float32BufferAttribute(canonical.positions, 3);
  }

  return canonical.positionAttribute;
}

export function renderVertexToCanonical(mesh, renderVertexIndex) {
  const source = mesh?.geometry?.getAttribute?.('sourceVertexId');
  if (!source) return renderVertexIndex;

  const index = Number(source.getX(renderVertexIndex));
  return Number.isInteger(index) ? index : renderVertexIndex;
}

export function canonicalTriangleVertexIndicesFromHit(hit) {
  const mesh = hit?.object;
  const face = hit?.face;
  if (!mesh?.isMesh || !face) return null;

  return [face.a, face.b, face.c].map(index => renderVertexToCanonical(mesh, index));
}

export function canonicalVertexWorldPosition(mesh, vertexIndex) {
  const position = getCanonicalPositionAttribute(mesh);
  if (!position || vertexIndex < 0 || vertexIndex >= position.count) return null;

  return new THREE.Vector3()
    .fromBufferAttribute(position, vertexIndex)
    .applyMatrix4(mesh.matrixWorld);
}


export function getMaterialList(material) {
  if (!material) return [];
  return Array.isArray(material) ? material : [material];
}

export function disposeMaterialOrArray(material) {
  getMaterialList(material).forEach(mat => mat?.dispose?.());
}

export function roundNumber(value) {
  return Number(Number(value).toFixed(10));
}

export function vectorPayload(vector) {
  return {
    x: roundNumber(vector.x),
    y: roundNumber(vector.y),
    z: roundNumber(vector.z),
  };
}

export function rootLocalPointFromWorld(root, worldPoint) {
  if (!root || !worldPoint) return null;
  root.updateMatrixWorld(true);
  return root.worldToLocal(worldPoint.clone());
}

export function worldPointFromRootLocal(root, localPoint) {
  if (!root || !localPoint) return null;
  root.updateMatrixWorld(true);
  return root.localToWorld(localPoint.clone());
}

export function assetBoundingBoxForObject(root) {
  const box = new THREE.Box3();
  if (!root) return box;

  root.updateMatrixWorld(true);
  const rootInverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const meshBox = new THREE.Box3();
  const transform = new THREE.Matrix4();

  root.traverse(object => {
    if (!object.isMesh || !object.geometry?.attributes?.position) return;

    object.geometry.computeBoundingBox?.();
    if (!object.geometry.boundingBox) return;

    transform.multiplyMatrices(rootInverse, object.matrixWorld);
    meshBox.copy(object.geometry.boundingBox).applyMatrix4(transform);
    box.union(meshBox);
  });

  return box;
}

export function sourceRootToTargetRootMatrix(sourceRoot, targetRoot) {
  if (!sourceRoot || !targetRoot) return new THREE.Matrix4();

  sourceRoot.updateMatrixWorld(true);
  targetRoot.updateMatrixWorld(true);

  return new THREE.Matrix4()
    .copy(targetRoot.matrixWorld)
    .invert()
    .multiply(sourceRoot.matrixWorld);
}

export function isTextInputTarget(target) {
  if (!target) return false;
  const tag = target.tagName?.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

export function ensureColorAttribute(mesh) {
  const position = mesh.geometry?.attributes?.position;
  if (!position) return null;

  let color = mesh.geometry.getAttribute('color');

  if (!color || color.count !== position.count || color.itemSize !== 3) {
    color = new THREE.Float32BufferAttribute(position.count * 3, 3);
    mesh.geometry.setAttribute('color', color);
  }

  color.userData = color.userData || {};

  const sourceVertexId = mesh.geometry.getAttribute('sourceVertexId') || null;

  if (color.userData.sourceVertexId !== sourceVertexId) {
    color.userData.sourceVertexId = sourceVertexId;
    color.userData.sourceVertexLookup = null;
  }

  return color;
}

function renderVerticesForCanonicalVertex(colorAttribute, vertexIndex) {
  const sourceVertexId = colorAttribute?.userData?.sourceVertexId || null;
  if (!sourceVertexId) return null;

  let cache = colorAttribute.userData.sourceVertexLookup;

  if (!cache || cache.sourceVertexId !== sourceVertexId || cache.count !== sourceVertexId.count) {
    const lookup = new Map();

    for (let renderIndex = 0; renderIndex < sourceVertexId.count; renderIndex++) {
      const canonicalIndex = sourceVertexId.getX(renderIndex);
      let renderIndices = lookup.get(canonicalIndex);

      if (!renderIndices) {
        renderIndices = [];
        lookup.set(canonicalIndex, renderIndices);
      }

      renderIndices.push(renderIndex);
    }

    cache = { sourceVertexId, count: sourceVertexId.count, lookup };
    colorAttribute.userData.sourceVertexLookup = cache;
  }

  return cache.lookup.get(vertexIndex) || null;
}

export function setVertexColor(colorAttribute, vertexIndex, color) {
  const renderIndices = renderVerticesForCanonicalVertex(colorAttribute, vertexIndex);

  if (renderIndices) {
    renderIndices.forEach(renderIndex => {
      colorAttribute.setXYZ(renderIndex, color.r, color.g, color.b);
    });
    return;
  }

  colorAttribute.setXYZ(vertexIndex, color.r, color.g, color.b);
}

export class TemporaryVisualizationState {
  constructor({
    materialSectionSelector = '[data-viz-section="material"]',
    smoothShadingId = 'viz-smooth-shading',
  } = {}) {
    this.materialSectionSelector = materialSectionSelector;
    this.smoothShadingId = smoothShadingId;
    this.materialPanelPreviousDisplay = null;
    this.smoothShadingPreviousChecked = null;
  }

  setMaterialPanelHidden(hidden) {
    const materialSection = document.querySelector(this.materialSectionSelector);
    if (!materialSection) return;

    if (hidden) {
      if (this.materialPanelPreviousDisplay === null) {
        this.materialPanelPreviousDisplay = materialSection.style.display || '';
      }
      materialSection.style.display = 'none';
      return;
    }

    if (this.materialPanelPreviousDisplay !== null) {
      materialSection.style.display = this.materialPanelPreviousDisplay;
      this.materialPanelPreviousDisplay = null;
    }
  }

  setSmoothShadingDisabled(disabled) {
    const smoothCheck = document.getElementById(this.smoothShadingId);
    if (!smoothCheck) return;

    if (disabled) {
      if (this.smoothShadingPreviousChecked === null) {
        this.smoothShadingPreviousChecked = !!smoothCheck.checked;
      }
      smoothCheck.checked = false;
      return;
    }

    if (this.smoothShadingPreviousChecked !== null) {
      smoothCheck.checked = this.smoothShadingPreviousChecked;
      this.smoothShadingPreviousChecked = null;
    }
  }

  restore() {
    this.setMaterialPanelHidden(false);
    this.setSmoothShadingDisabled(false);
  }
}

export class MeshRenderBackup {
  constructor({ clearPreview = null, disposeMaterial = disposeMaterialOrArray } = {}) {
    this.clearPreview = clearPreview;
    this.disposeMaterial = disposeMaterial;
    this.originalMaterials = new Map();
    this.originalColorAttributes = new Map();
  }

  capture(mesh) {
    if (this.originalMaterials.has(mesh)) return;

    this.originalMaterials.set(mesh, mesh.material);

    const colorAttribute = mesh.geometry?.getAttribute?.('color');
    this.originalColorAttributes.set(mesh, colorAttribute ? colorAttribute.clone() : null);
  }

  getOriginalMaterial(mesh) {
    return this.originalMaterials.get(mesh);
  }

  restore({ disposeOriginals = false } = {}) {
    this.clearPreview?.();

    this.originalMaterials.forEach((originalMaterial, mesh) => {
      const currentMaterial = mesh?.material;

      if (mesh?.geometry && this.originalColorAttributes.has(mesh)) {
        const originalColor = this.originalColorAttributes.get(mesh);
        if (originalColor) {
          mesh.geometry.setAttribute('color', originalColor);
        } else {
          mesh.geometry.deleteAttribute('color');
        }

        const restoredColor = mesh.geometry.getAttribute('color');
        if (restoredColor) restoredColor.needsUpdate = true;
      }

      if (mesh?.isMesh && !disposeOriginals) {
        mesh.material = originalMaterial;
      }

      if (currentMaterial && currentMaterial !== originalMaterial) {
        this.disposeMaterial(currentMaterial);
      }

      if (disposeOriginals) {
        this.disposeMaterial(originalMaterial);
      }
    });

    this.clear();
  }

  clear() {
    this.originalMaterials.clear();
    this.originalColorAttributes.clear();
  }
}

export function restoreVisualizationRenderMode(taskRenderOverride) {
  if (app.renderOverride === taskRenderOverride) {
    app.renderOverride = null;
  }

  const checkedShading = document.querySelector('input[name="shading"]:checked');

  if (checkedShading) {
    checkedShading.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    updateEnvironmentUsage();
  }
}

function findRoot(parent, index) {
  let root = index;

  while (parent[root] !== root) {
    root = parent[root];
  }

  while (parent[index] !== index) {
    const next = parent[index];
    parent[index] = root;
    index = next;
  }

  return root;
}

function unionRoots(parent, a, b) {
  const rootA = findRoot(parent, a);
  const rootB = findRoot(parent, b);

  if (rootA !== rootB) {
    parent[rootB] = rootA;
  }
}

function quantizedVertexKey(position, index) {
  const scale = 1e6;
  const x = Math.round(position.getX(index) * scale);
  const y = Math.round(position.getY(index) * scale);
  const z = Math.round(position.getZ(index) * scale);
  return `${x}|${y}|${z}`;
}

export class MeshComponentIndex {
  constructor() {
    this.cache = new WeakMap();
  }

  reset() {
    this.cache = new WeakMap();
  }

  get(mesh) {
    const position = getCanonicalPositionAttribute(mesh);
    if (!mesh?.isMesh || !position) return null;

    const canonical = getCanonicalData(mesh);
    const index = mesh.geometry.index || null;
    const faces = canonical?.faces || null;
    const cached = this.cache.get(mesh);

    if (cached && cached.position === position && cached.index === index && cached.faces === faces) {
      return cached;
    }

    const parent = new Int32Array(position.count);
    for (let i = 0; i < parent.length; i++) parent[i] = i;

    const byPosition = new Map();
    for (let i = 0; i < position.count; i++) {
      const key = quantizedVertexKey(position, i);
      const first = byPosition.get(key);

      if (first === undefined) {
        byPosition.set(key, i);
      } else {
        unionRoots(parent, first, i);
      }
    }

    if (faces) {
      const triCount = Math.floor(faces.length / 3);

      for (let tri = 0; tri < triCount; tri++) {
        const a = faces[tri * 3];
        const b = faces[tri * 3 + 1];
        const c = faces[tri * 3 + 2];

        if (a < position.count && b < position.count) unionRoots(parent, a, b);
        if (a < position.count && c < position.count) unionRoots(parent, a, c);
      }
    } else {
      const triIndexCount = index ? index.count : position.count;
      const triCount = Math.floor(triIndexCount / 3);

      for (let tri = 0; tri < triCount; tri++) {
        const a = index ? index.getX(tri * 3) : tri * 3;
        const b = index ? index.getX(tri * 3 + 1) : tri * 3 + 1;
        const c = index ? index.getX(tri * 3 + 2) : tri * 3 + 2;

        if (a < position.count && b < position.count) unionRoots(parent, a, b);
        if (a < position.count && c < position.count) unionRoots(parent, a, c);
      }
    }

    const rootToComponentIndex = new Map();
    const vertexToComponent = new Int32Array(position.count);
    const components = [];

    for (let i = 0; i < position.count; i++) {
      const root = findRoot(parent, i);
      let componentIndex = rootToComponentIndex.get(root);

      if (componentIndex === undefined) {
        componentIndex = components.length;
        rootToComponentIndex.set(root, componentIndex);
        components.push([]);
      }

      vertexToComponent[i] = componentIndex;
      components[componentIndex].push(i);
    }

    const data = { position, index, faces, vertexToComponent, components };
    this.cache.set(mesh, data);
    return data;
  }
}

export function seedVertexIndexFromHit(hit) {
  const mesh = hit?.object;
  const position = getCanonicalPositionAttribute(mesh);
  if (!mesh?.isMesh || !position) return -1;

  const candidates = canonicalTriangleVertexIndicesFromHit(hit)
    ?.filter(index => Number.isInteger(index) && index >= 0 && index < position.count) || [];

  if (!candidates.length) return -1;

  const world = new THREE.Vector3();
  let bestIndex = candidates[0];
  let bestDistance = Infinity;

  mesh.updateMatrixWorld(true);
  candidates.forEach(index => {
    world.fromBufferAttribute(position, index).applyMatrix4(mesh.matrixWorld);
    const distance = world.distanceToSquared(hit.point);

    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });

  return bestIndex;
}

export function collectComponentVertexIndices(hit, componentIndex) {
  const data = componentIndex.get(hit?.object);
  if (!data) return [];

  const seedIndex = seedVertexIndexFromHit(hit);
  if (seedIndex < 0) return [];

  const connectedComponentIndex = data.vertexToComponent[seedIndex];
  return data.components[connectedComponentIndex] || [];
}

export function collectBrushVertexIndices(hit, brushRadius) {
  const mesh = hit?.object;
  const position = getCanonicalPositionAttribute(mesh);
  if (!mesh?.isMesh || !position) return [];

  const radiusSq = brushRadius * brushRadius;
  const world = new THREE.Vector3();
  const indices = [];

  mesh.updateMatrixWorld(true);

  for (let i = 0; i < position.count; i++) {
    world.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
    if (world.distanceToSquared(hit.point) <= radiusSq) {
      indices.push(i);
    }
  }

  // On coarse triangles, a tiny brush may hit the surface without enclosing a
  // vertex. Include the hit triangle vertices so every click has visible effect.
  if (!indices.length) {
    const tri = canonicalTriangleVertexIndicesFromHit(hit) || [];
    indices.push(...tri);
  }

  return Array.from(new Set(indices.filter(i => Number.isInteger(i) && i >= 0 && i < position.count)));
}

export function collectHitVertexIndices(hit, { mode = 'brush', brushRadius, componentIndex }) {
  return mode === 'component'
    ? collectComponentVertexIndices(hit, componentIndex)
    : collectBrushVertexIndices(hit, brushRadius);
}
