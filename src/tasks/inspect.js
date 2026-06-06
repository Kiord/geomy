import * as THREE from 'three';
import { app } from '../app.js';
import { MeshComponentIndex, assetBoundingBoxForObject } from './meshTaskUtils.js';
import { downloadBlob } from '../util.js';


const componentIndex = new MeshComponentIndex();

function downloadTexture(texture, baseName) {
  const img = texture.image;
  if (!img) return;

  try {
    const canvas = document.createElement('canvas');
    canvas.width = img.width || img.naturalWidth || 1024;
    canvas.height = img.height || img.naturalHeight || 1024;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    canvas.toBlob(blob => {
      if (blob) downloadBlob(blob, `${baseName}.png`, 'image/png');
    });
  } catch (err) {
    alert('Could not download texture: it may be a data texture or restricted by CORS.');
    console.error(err);
  }
}

const TEXTURE_SLOTS = [
  ['map', 'Color'],
  ['normalMap', 'Normal'],
  ['roughnessMap', 'Roughness'],
  ['metalnessMap', 'Metalness'],
  ['aoMap', 'Ambient Occlusion'],
  ['emissiveMap', 'Emissive'],
  ['alphaMap', 'Opacity'],
  ['bumpMap', 'Bump'],
  ['displacementMap', 'Displacement'],
  ['lightMap', 'Light'],
  ['specularMap', 'Specular'],
  ['envMap', 'Environment'],
  ['matcap', 'Matcap'],
  ['clearcoatMap', 'Clearcoat'],
  ['clearcoatNormalMap', 'Clearcoat Normal'],
  ['clearcoatRoughnessMap', 'Clearcoat Roughness'],
  ['sheenColorMap', 'Sheen Color'],
  ['sheenRoughnessMap', 'Sheen Roughness'],
  ['transmissionMap', 'Transmission'],
  ['thicknessMap', 'Thickness'],
  ['iridescenceMap', 'Iridescence'],
  ['iridescenceThicknessMap', 'Iridescence Thickness'],
];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function texturePreviewSrc(texture) {
  const img = texture?.image;
  if (!img) return '';

  if (typeof img.src === 'string' && img.src) return img.src;
  if (typeof img.currentSrc === 'string' && img.currentSrc) return img.currentSrc;

  try {
    const width = img.width || img.naturalWidth || 0;
    const height = img.height || img.naturalHeight || 0;
    if (!width || !height) return '';

    const canvas = document.createElement('canvas');
    canvas.width = Math.min(width, 512);
    canvas.height = Math.max(1, Math.round(height * (canvas.width / width)));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } catch (_) {
    return '';
  }
}

function textureLabel(mat, slot, label, texture) {
  const name = texture.name || mat.name || slot;
  return `${label}: ${name}`;
}

function computeStats() {
  let meshesCount = 0;
  let vertices = 0;
  let faces = 0;
  let connectedComponents = 0;
  let unreferencedVertices = 0;
  let degeneratedTriangles = 0;
  let uvVertices = 0;

  const textures = new Map();
  const meshes = [];

  app.currentObject?.traverse(c => {
    if (c.isMesh && c.geometry?.attributes?.position) meshes.push(c);
  });

  meshesCount = meshes.length;
  if (!meshes.length) return null;

  const box = assetBoundingBoxForObject(app.currentObject);
  const size = box.getSize(new THREE.Vector3());
  const scaleDiag = box.isEmpty() ? 0 : size.length();

  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();
  const vC = new THREE.Vector3();
  const triangle = new THREE.Triangle();

  meshes.forEach(mesh => {
    const geo = mesh.geometry;
    const pos = geo.attributes.position;
    const idx = geo.index;
    const uv = geo.attributes.uv;

    vertices += pos.count;
    if (uv) uvVertices += uv.count;

    const data = componentIndex.get(mesh);
    if (data && data.components) {
      connectedComponents += data.components.length;
    }

    const checkDegenerate = (a, b, c) => {
      vA.fromBufferAttribute(pos, a);
      vB.fromBufferAttribute(pos, b);
      vC.fromBufferAttribute(pos, c);
      triangle.set(vA, vB, vC);
      if (triangle.getArea() <= 1e-10) degeneratedTriangles++;
    };

    if (idx) {
      const triCount = Math.floor(idx.count / 3);
      faces += triCount;

      const referenced = new Uint8Array(pos.count);
      for (let i = 0; i < idx.count; i++) {
        referenced[idx.getX(i)] = 1;
      }
      let unref = 0;
      for (let i = 0; i < pos.count; i++) {
        if (!referenced[i]) unref++;
      }
      unreferencedVertices += unref;

      for (let i = 0; i < triCount; i++) {
        checkDegenerate(idx.getX(i * 3), idx.getX(i * 3 + 1), idx.getX(i * 3 + 2));
      }
    } else {
      const triCount = Math.floor(pos.count / 3);
      faces += triCount;
      for (let i = 0; i < triCount; i++) {
        checkDegenerate(i * 3, i * 3 + 1, i * 3 + 2);
      }
    }

    const materialLists = [
      mesh.userData?.geomyOriginalMaterial,
      mesh.material,
    ];

    materialLists.forEach(materialList => {
      const mats = Array.isArray(materialList) ? materialList : [materialList];

      mats.forEach(mat => {
        if (!mat) return;

        TEXTURE_SLOTS.forEach(([slot, label]) => {
          const texture = mat[slot];
          if (!texture?.image) return;

          const baseName = textureLabel(mat, slot, label, texture);
          let uniqueName = baseName;
          let id = 1;

          while (textures.has(uniqueName) && textures.get(uniqueName).texture !== texture) {
            uniqueName = `${baseName} ${id++}`;
          }

          textures.set(uniqueName, {
            label: uniqueName,
            texture,
            previewSrc: texturePreviewSrc(texture),
          });
        });

        if (!mat.alphaMap && mat.map?.image && (mat.transparent || (mat.alphaTest || 0) > 0 || mat.opacity < 0.999)) {
          const baseName = textureLabel(mat, 'map', 'Opacity', mat.map);
          let uniqueName = baseName;
          let id = 1;

          while (textures.has(uniqueName) && textures.get(uniqueName).texture !== mat.map) {
            uniqueName = `${baseName} ${id++}`;
          }

          textures.set(uniqueName, {
            label: uniqueName,
            texture: mat.map,
            previewSrc: texturePreviewSrc(mat.map),
          });
        }
      });
    });
  });


  return {
    meshesCount, vertices, faces, connectedComponents, unreferencedVertices,
    degeneratedTriangles, scaleDiag, size, uvVertices, textures
  };
}

function renderPanel() {
  const content = app.dom.taskContent;
  if (!content) return;

  const stats = computeStats();

  if (!stats) {
    content.innerHTML = `
      <div class="task-heading">
        <h3>Inspect Mesh</h3>
        <span class="task-help" tabindex="0" data-tip="Load a mesh to view statistics. Double-click the viewport to recenter.">?</span>
      </div>
    `;
    return;
  }

  let texturesHtml = '';
  if (stats.textures.size > 0) {
    texturesHtml = `
      <div class="section-title">Textures</div>
      <div class="mesh-mask-option-group">
        ${Array.from(stats.textures.values()).map((entry, i) => `
          <div class="inspect-texture-card">
            ${entry.previewSrc ? `<img class="inspect-texture-thumb" src="${entry.previewSrc}" alt="">` : ''}
            <div class="inspect-texture-meta">
              <span class="inspect-texture-name" title="${escapeHtml(entry.label)}">${escapeHtml(entry.label)}</span>
              <button class="btn btn-mini btn-download-tex" data-tex="${i}">Download</button>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }

  content.innerHTML = `
    <div class="task-heading">
      <h3>Inspect Mesh</h3>
      <span class="task-help" tabindex="0" data-tip="Double-click the viewport to recenter the view. Texture thumbnails can be downloaded from this panel.">?</span>
    </div>

    <div class="section-title">Statistics</div>
    <div class="mesh-mask-option-group">
      <div class="mesh-rigid-stat"><span>Meshes</span><span>${stats.meshesCount.toLocaleString()}</span></div>
      <div class="mesh-rigid-stat"><span>Vertices</span><span>${stats.vertices.toLocaleString()}</span></div>
      <div class="mesh-rigid-stat"><span>Faces</span><span>${stats.faces.toLocaleString()}</span></div>
      <div class="mesh-rigid-stat"><span>Components</span><span>${stats.connectedComponents.toLocaleString()}</span></div>
      <div class="mesh-rigid-stat" title="Vertices present in arrays but not in face index"><span>Unreferenced Verts</span><span>${stats.unreferencedVertices.toLocaleString()}</span></div>
      <div class="mesh-rigid-stat" title="Triangles with zero area"><span>Degenerate Tris</span><span>${stats.degeneratedTriangles.toLocaleString()}</span></div>
      <div class="mesh-rigid-stat" title="Total UV coordinate count"><span>UV Vertices</span><span>${stats.uvVertices.toLocaleString()}</span></div>
    </div>

    <div class="section-title">Bounding Box</div>
    <div class="mesh-mask-option-group">
      <div class="mesh-rigid-stat"><span>Diagonal</span><span>${stats.scaleDiag.toFixed(4)}</span></div>
      <div class="mesh-rigid-stat"><span>Width (X)</span><span>${stats.size.x.toFixed(4)}</span></div>
      <div class="mesh-rigid-stat"><span>Height (Y)</span><span>${stats.size.y.toFixed(4)}</span></div>
      <div class="mesh-rigid-stat"><span>Depth (Z)</span><span>${stats.size.z.toFixed(4)}</span></div>
    </div>

    ${texturesHtml}
  `;

  if (stats.textures.size > 0) {
    const texArray = Array.from(stats.textures.values());
    content.querySelectorAll('.btn-download-tex').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.tex, 10);
        downloadTexture(texArray[idx].texture, texArray[idx].label);
      });
    });
  }
}

export const inpectTask = {
  id: 'view',
  onDblClick: null, // let global handler recenter

  activate() {
    renderPanel();
  },
  deactivate() {
    componentIndex.reset();
    app.dom.taskContent.innerHTML = '';
  },

  onFileLoaded() {
    componentIndex.reset();
    renderPanel();
  }

};

