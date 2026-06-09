import * as THREE from 'three';

function parseIndex(value, count) {
  if (!value) return -1;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n === 0) return -1;
  return n > 0 ? n - 1 : count + n;
}

function parseFaceVertex(token, counts) {
  const parts = token.split('/');
  return {
    v: parseIndex(parts[0], counts.positions),
    vt: parseIndex(parts[1], counts.uvs),
    vn: parseIndex(parts[2], counts.normals),
  };
}

function pushVec3(array, source, index) {
  array.push(source[index * 3], source[index * 3 + 1], source[index * 3 + 2]);
}

function pushVec2(array, source, index) {
  array.push(source[index * 2], source[index * 2 + 1]);
}

function makeDefaultMaterial() {
  return new THREE.MeshStandardMaterial({
    color: '#e0e0e0',
    roughness: 0.4,
    metalness: 0.1,
  });
}

export function parseCanonicalOBJ(text, { name = 'OBJ mesh' } = {}) {
  const positions = [];
  const uvs = [];
  const normals = [];
  const faces = [];
  const uvFaces = [];
  const normalFaces = [];
  const renderPositions = [];
  const renderUvs = [];
  const renderNormals = [];
  const sourceVertexIds = [];
  const sourceFaceIds = [];

  const lines = String(text || '').split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const parts = line.split(/\s+/);
    const keyword = parts[0];

    if (keyword === 'v') {
      positions.push(
        parseFloat(parts[1]) || 0,
        parseFloat(parts[2]) || 0,
        parseFloat(parts[3]) || 0,
      );
      continue;
    }

    if (keyword === 'vt') {
      uvs.push(
        parseFloat(parts[1]) || 0,
        parseFloat(parts[2]) || 0,
      );
      continue;
    }

    if (keyword === 'vn') {
      normals.push(
        parseFloat(parts[1]) || 0,
        parseFloat(parts[2]) || 0,
        parseFloat(parts[3]) || 0,
      );
      continue;
    }

    if (keyword !== 'f' || parts.length < 4) continue;

    const counts = {
      positions: positions.length / 3,
      uvs: uvs.length / 2,
      normals: normals.length / 3,
    };

    const polygon = parts.slice(1).map(token => parseFaceVertex(token, counts));

    // Fan-triangulate n-gons while preserving OBJ position/uv/normal indices.
    for (let i = 1; i < polygon.length - 1; i++) {
      const tri = [polygon[0], polygon[i], polygon[i + 1]];
      const faceId = faces.length / 3;

      tri.forEach(corner => {
        const vi = corner.v;
        const ti = corner.vt;
        const ni = corner.vn;

        faces.push(vi);
        uvFaces.push(ti);
        normalFaces.push(ni);

        if (vi >= 0) {
          pushVec3(renderPositions, positions, vi);
        } else {
          renderPositions.push(0, 0, 0);
        }

        if (ti >= 0) {
          pushVec2(renderUvs, uvs, ti);
        } else {
          renderUvs.push(0, 0);
        }

        if (ni >= 0) {
          pushVec3(renderNormals, normals, ni);
        }

        sourceVertexIds.push(vi);
        sourceFaceIds.push(faceId);
      });
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(renderPositions, 3));

  if (uvs.length && renderUvs.length === (renderPositions.length / 3) * 2) {
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(renderUvs, 2));
  }

  if (renderNormals.length === renderPositions.length) {
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(renderNormals, 3));
  } else {
    geometry.computeVertexNormals();
  }

  geometry.setAttribute('sourceVertexId', new THREE.Uint32BufferAttribute(sourceVertexIds.map(v => Math.max(0, v)), 1));
  geometry.setAttribute('sourceFaceId', new THREE.Uint32BufferAttribute(sourceFaceIds, 1));

  geometry.userData.geomyCanonical = {
    source: 'obj',
    vertexCount: positions.length / 3,
    faceCount: faces.length / 3,
    positions: new Float32Array(positions),
    uvs: new Float32Array(uvs),
    normals: new Float32Array(normals),
    faces: new Uint32Array(faces.map(v => Math.max(0, v))),
    uvFaces: new Int32Array(uvFaces),
    normalFaces: new Int32Array(normalFaces),
  };

  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const mesh = new THREE.Mesh(geometry, makeDefaultMaterial());
  mesh.name = name || 'OBJ mesh';
  mesh.userData.geomyCanonical = geometry.userData.geomyCanonical;

  const group = new THREE.Group();
  group.name = name || 'OBJ';
  group.add(mesh);
  return group;
}

export async function loadCanonicalOBJFile(file) {
  const text = await file.text();
  return parseCanonicalOBJ(text, { name: file.name || 'OBJ mesh' });
}
