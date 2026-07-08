import { arrayRows, readSimpleArrayFile } from './taskDataDaemon.js';
import { getCanonicalPositionAttribute, getCanonicalVertexCount } from '../tasks/meshTaskUtils.js';

const USER_DATA_KEY = 'geomyVertexSymmetry';
const EPS = 1e-10;

function numericRowsFromArray(array) {
  return array.rows || arrayRows(array.data, array.shape);
}

function mappingValuesFromArray(array, vertexCount) {
  const rows = numericRowsFromArray(array);
  const flat = Array.from(array.data || [], Number);

  if (rows.length === vertexCount && rows.every(row => row.length === 1)) {
    return rows.map(row => Number(row[0]));
  }

  return flat;
}

export function validateSymmetryMapping(values, vertexCount) {
  if (!Number.isInteger(vertexCount) || vertexCount <= 0) {
    throw new Error('Load a mesh before loading a symmetry mapping.');
  }

  if (!Array.isArray(values) && !(values instanceof Int32Array)) {
    throw new Error('Symmetry mapping must be a numeric array.');
  }

  if (values.length !== vertexCount) {
    throw new Error(`Symmetry mapping length ${values.length} does not match mesh vertex count ${vertexCount}.`);
  }

  const mapping = new Int32Array(vertexCount);
  const seen = new Uint8Array(vertexCount);

  for (let i = 0; i < vertexCount; i++) {
    const value = Number(values[i]);
    if (!Number.isInteger(value) || value < 0 || value >= vertexCount) {
      throw new Error(`Symmetry mapping has an invalid vertex index at row ${i + 1}.`);
    }
    if (seen[value]) {
      throw new Error(`Symmetry mapping is not a permutation; vertex ${value} appears more than once.`);
    }
    mapping[i] = value;
    seen[value] = 1;
  }

  let asymmetricPairs = 0;
  let fixedCount = 0;
  for (let i = 0; i < vertexCount; i++) {
    if (mapping[i] === i) fixedCount += 1;
    else if (mapping[mapping[i]] !== i) asymmetricPairs += 1;
  }

  return { mapping, fixedCount, asymmetricPairs };
}

export async function readSymmetryMappingFile(file, mesh) {
  if (!file) throw new Error('Choose a .npy or .txt symmetry mapping file.');

  const vertexCount = getCanonicalVertexCount(mesh);
  const parsed = await readSimpleArrayFile(file);
  const values = mappingValuesFromArray(parsed, vertexCount);
  const validated = validateSymmetryMapping(values, vertexCount);

  return {
    ...validated,
    sourceName: file.name || 'symmetry mapping',
  };
}

export function setMeshSymmetry(mesh, symmetry) {
  if (!mesh) return null;

  const data = {
    mapping: symmetry.mapping,
    sourceName: symmetry.sourceName || 'symmetry mapping',
    fixedCount: symmetry.fixedCount || 0,
    asymmetricPairs: symmetry.asymmetricPairs || 0,
    loadedAt: Date.now(),
  };

  mesh.userData[USER_DATA_KEY] = data;
  mesh.geometry.userData[USER_DATA_KEY] = data;
  window.dispatchEvent(new CustomEvent('geomy:symmetry-changed', { detail: { mesh } }));
  return data;
}

export function getMeshSymmetry(mesh) {
  return mesh?.userData?.[USER_DATA_KEY] || mesh?.geometry?.userData?.[USER_DATA_KEY] || null;
}

export function getSymmetryMapping(mesh) {
  return getMeshSymmetry(mesh)?.mapping || null;
}

export function hasSymmetry(mesh) {
  const mapping = getSymmetryMapping(mesh);
  return !!mapping && mapping.length === getCanonicalVertexCount(mesh);
}

export function mappedVertex(mesh, vertexIndex) {
  const mapping = getSymmetryMapping(mesh);
  const mapped = mapping?.[vertexIndex];
  return Number.isInteger(mapped) ? mapped : vertexIndex;
}

export function expandWithSymmetry(mesh, indices, enabled = true) {
  if (!enabled) return Array.from(indices || []);

  const mapping = getSymmetryMapping(mesh);
  if (!mapping) return Array.from(indices || []);

  const out = new Set();
  Array.from(indices || []).forEach(index => {
    out.add(index);
    const mapped = mapping[index];
    if (Number.isInteger(mapped)) out.add(mapped);
  });
  return Array.from(out);
}

function vectorFromAttribute(pos, index) {
  return [pos.getX(index), pos.getY(index), pos.getZ(index)];
}

function add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scale(a, s) {
  return [a[0] * s, a[1] * s, a[2] * s];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function lengthSq(a) {
  return dot(a, a);
}

function normalize(a) {
  const len = Math.sqrt(lengthSq(a));
  return len > EPS ? scale(a, 1 / len) : null;
}

function centroidForIndices(pos, indices) {
  if (!indices.length) return null;

  let center = [0, 0, 0];
  indices.forEach(index => {
    center = add(center, vectorFromAttribute(pos, index));
  });
  return scale(center, 1 / indices.length);
}

function covarianceForIndices(pos, indices, center) {
  const c = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];

  indices.forEach(index => {
    const v = sub(vectorFromAttribute(pos, index), center);
    c[0][0] += v[0] * v[0];
    c[0][1] += v[0] * v[1];
    c[0][2] += v[0] * v[2];
    c[1][1] += v[1] * v[1];
    c[1][2] += v[1] * v[2];
    c[2][2] += v[2] * v[2];
  });

  const inv = 1 / Math.max(1, indices.length);
  c[0][0] *= inv;
  c[0][1] *= inv;
  c[0][2] *= inv;
  c[1][1] *= inv;
  c[1][2] *= inv;
  c[2][2] *= inv;
  c[1][0] = c[0][1];
  c[2][0] = c[0][2];
  c[2][1] = c[1][2];
  return c;
}

function smallestEigenvectorSymmetric3(matrix) {
  const a = matrix.map(row => row.slice());
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];

  for (let iter = 0; iter < 32; iter++) {
    let p = 0;
    let q = 1;
    let max = Math.abs(a[0][1]);

    [[0, 2], [1, 2]].forEach(([i, j]) => {
      const value = Math.abs(a[i][j]);
      if (value > max) {
        max = value;
        p = i;
        q = j;
      }
    });

    if (max <= EPS) break;

    const app = a[p][p];
    const aqq = a[q][q];
    const apq = a[p][q];
    const angle = 0.5 * Math.atan2(2 * apq, aqq - app);
    const c = Math.cos(angle);
    const s = Math.sin(angle);

    for (let k = 0; k < 3; k++) {
      if (k === p || k === q) continue;
      const akp = a[k][p];
      const akq = a[k][q];
      a[k][p] = c * akp - s * akq;
      a[p][k] = a[k][p];
      a[k][q] = s * akp + c * akq;
      a[q][k] = a[k][q];
    }

    a[p][p] = c * c * app - 2 * s * c * apq + s * s * aqq;
    a[q][q] = s * s * app + 2 * s * c * apq + c * c * aqq;
    a[p][q] = 0;
    a[q][p] = 0;

    for (let k = 0; k < 3; k++) {
      const vkp = v[k][p];
      const vkq = v[k][q];
      v[k][p] = c * vkp - s * vkq;
      v[k][q] = s * vkp + c * vkq;
    }
  }

  let smallest = 0;
  if (a[1][1] < a[smallest][smallest]) smallest = 1;
  if (a[2][2] < a[smallest][smallest]) smallest = 2;

  return normalize([v[0][smallest], v[1][smallest], v[2][smallest]]);
}

function normalFromSelfVertices(pos, self) {
  const center = centroidForIndices(pos, self);
  if (!center || self.length < 3) return null;

  const normal = smallestEigenvectorSymmetric3(covarianceForIndices(pos, self, center));
  return normal ? { point: center, normal, source: 'self' } : null;
}

function normalFromMappedPairs(pos, pairs) {
  if (!pairs.length) return null;

  let center = [0, 0, 0];
  let normal = [0, 0, 0];
  let count = 0;

  pairs.forEach(pair => {
    const a = vectorFromAttribute(pos, pair.a);
    const b = vectorFromAttribute(pos, pair.b);
    center = add(center, scale(add(a, b), 0.5));
    normal = add(normal, sub(b, a));
    count += 1;
  });

  const normalized = normalize(normal);
  return normalized ? { point: scale(center, 1 / count), normal: normalized, source: 'pairs' } : null;
}

function orientPlaneFromPairs(pos, plane, pairs) {
  if (!plane || !pairs.length) return plane;

  const first = pairs.find(pair => {
    const da = signedDistance(pos, pair.a, plane);
    const db = signedDistance(pos, pair.b, plane);
    return Math.abs(da - db) > EPS;
  });

  if (!first) return plane;

  const da = signedDistance(pos, first.a, plane);
  return da >= 0 ? plane : { ...plane, normal: scale(plane.normal, -1) };
}

function fittedSymmetryPlane(pos, self, pairs) {
  const plane = normalFromSelfVertices(pos, self) || normalFromMappedPairs(pos, pairs);
  return orientPlaneFromPairs(pos, plane, pairs);
}

function signedDistance(pos, index, plane) {
  return dot(sub(vectorFromAttribute(pos, index), plane.point), plane.normal);
}

export function symmetryPairs(mesh) {
  const mapping = getSymmetryMapping(mesh);
  const pos = getCanonicalPositionAttribute(mesh);
  if (!mapping || !pos) return { pairs: [], self: [], leftToRight: [], rightToLeft: [], ambiguous: [], plane: null };

  const pairs = [];
  const self = [];
  const leftToRight = [];
  const rightToLeft = [];
  const ambiguous = [];

  for (let i = 0; i < mapping.length; i++) {
    const j = mapping[i];
    if (j === i) {
      self.push(i);
      continue;
    }
    if (i > j) continue;

    const pair = { a: i, b: j };
    pairs.push(pair);
  }

  const plane = fittedSymmetryPlane(pos, self, pairs);

  pairs.forEach(pair => {
    if (!plane) {
      ambiguous.push(pair);
      return;
    }

    const da = signedDistance(pos, pair.a, plane);
    const db = signedDistance(pos, pair.b, plane);

    if (Math.abs(da - db) <= EPS || Math.abs(da) <= EPS || Math.abs(db) <= EPS || da * db > 0) {
      ambiguous.push(pair);
    } else if (da > db) {
      leftToRight.push({ source: pair.a, target: pair.b });
      rightToLeft.push({ source: pair.b, target: pair.a });
    } else {
      leftToRight.push({ source: pair.b, target: pair.a });
      rightToLeft.push({ source: pair.a, target: pair.b });
    }
  });

  return { pairs, self, leftToRight, rightToLeft, ambiguous, plane };
}

export function symmetryStatusText(mesh) {
  const symmetry = getMeshSymmetry(mesh);
  if (!symmetry) return 'No symmetry mapping loaded.';

  const warnings = [];
  if (symmetry.asymmetricPairs) warnings.push(`${symmetry.asymmetricPairs.toLocaleString()} non-involutive entries`);

  return [
    symmetry.sourceName,
    `${symmetry.mapping.length.toLocaleString()} vertices`,
    `${symmetry.fixedCount.toLocaleString()} self-symmetric`,
    ...warnings,
  ].join(' | ');
}
