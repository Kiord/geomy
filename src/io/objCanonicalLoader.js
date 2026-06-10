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

function normalizeVec3(array, index) {
  const i = index * 3;
  const x = array[i];
  const y = array[i + 1];
  const z = array[i + 2];
  const len = Math.hypot(x, y, z);

  if (len > 1e-20) {
    array[i] = x / len;
    array[i + 1] = y / len;
    array[i + 2] = z / len;
  } else {
    array[i] = 0;
    array[i + 1] = 0;
    array[i + 2] = 1;
  }
}

function makeSmoothCanonicalNormals(positions, faces) {
  const vertexCount = Math.floor(positions.length / 3);
  const out = new Float32Array(vertexCount * 3);
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const normal = new THREE.Vector3();

  for (let i = 0; i < faces.length; i += 3) {
    const ia = faces[i];
    const ib = faces[i + 1];
    const ic = faces[i + 2];

    if (ia < 0 || ib < 0 || ic < 0 || ia >= vertexCount || ib >= vertexCount || ic >= vertexCount) {
      continue;
    }

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

    // Keep the area weighting from the raw cross product. This gives smooth
    // per-canonical-vertex normals without welding/reindexing the render mesh.
    [ia, ib, ic].forEach(vi => {
      out[vi * 3] += normal.x;
      out[vi * 3 + 1] += normal.y;
      out[vi * 3 + 2] += normal.z;
    });
  }

  for (let i = 0; i < vertexCount; i++) normalizeVec3(out, i);
  return out;
}

function pushObjOrGeneratedNormal(array, objNormals, generatedNormals, normalIndex, vertexIndex) {
  const objNormalCount = Math.floor(objNormals.length / 3);
  const generatedNormalCount = Math.floor(generatedNormals.length / 3);

  if (normalIndex >= 0 && normalIndex < objNormalCount) {
    pushVec3(array, objNormals, normalIndex);
    return;
  }

  if (vertexIndex >= 0 && vertexIndex < generatedNormalCount) {
    pushVec3(array, generatedNormals, vertexIndex);
    return;
  }

  array.push(0, 0, 1);
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

  // Three's normal generation on this expanded render geometry would produce
  // flat triangle normals because OBJ position/uv/normal streams are split into
  // per-corner render vertices. Generate smooth fallback normals in canonical
  // OBJ vertex space instead, then expand them back to render corners. Authored
  // OBJ `vn` normals still win per corner when present.
  const generatedNormals = makeSmoothCanonicalNormals(positions, faces);
  const renderNormals = [];

  for (let i = 0; i < sourceVertexIds.length; i++) {
    pushObjOrGeneratedNormal(
      renderNormals,
      normals,
      generatedNormals,
      normalFaces[i],
      sourceVertexIds[i],
    );
  }

  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(renderNormals, 3));

  geometry.setAttribute('sourceVertexId', new THREE.Uint32BufferAttribute(sourceVertexIds.map(v => Math.max(0, v)), 1));
  geometry.setAttribute('sourceFaceId', new THREE.Uint32BufferAttribute(sourceFaceIds, 1));

  geometry.userData.geomyCanonical = {
    source: 'obj',
    vertexCount: positions.length / 3,
    faceCount: faces.length / 3,
    positions: new Float32Array(positions),
    uvs: new Float32Array(uvs),
    normals: new Float32Array(normals),
    generatedNormals,
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
