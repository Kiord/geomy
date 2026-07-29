import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import {
  buildMaskTopology,
  dilateMaskSelection,
  erodeMaskSelection,
  hollowMaskSelection,
} from '../src/tasks/maskMorphology.js';

function sorted(values) {
  return Array.from(values).sort((a, b) => a - b);
}

function topologyFromGeometry(geometry) {
  const vertexCount = geometry.getAttribute('position').count;
  const triangleIndices = geometry.index
    ? geometry.index.array
    : Array.from({ length: vertexCount }, (_, index) => index);
  return buildMaskTopology(vertexCount, triangleIndices);
}

function makeClosedTetrahedron() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    1, 1, 1,
    -1, -1, 1,
    -1, 1, -1,
    1, -1, -1,
  ], 3));
  geometry.setIndex([
    0, 1, 2,
    0, 3, 1,
    0, 2, 3,
    1, 3, 2,
  ]);
  return geometry;
}

test('an open 3x3 plane identifies its outer eight vertices as boundary', () => {
  const geometry = new THREE.PlaneGeometry(2, 2, 2, 2);
  const topology = topologyFromGeometry(geometry);

  assert.deepEqual(sorted(topology.boundaryVertices), [0, 1, 2, 3, 5, 6, 7, 8]);
  assert.deepEqual(sorted(topology.neighbors[4]), [1, 2, 3, 5, 6, 7]);

  geometry.dispose();
});

test('dilation expands a selected center vertex by one edge without mutating the input', () => {
  const geometry = new THREE.PlaneGeometry(2, 2, 2, 2);
  const topology = topologyFromGeometry(geometry);
  const current = new Set([4]);

  const dilated = dilateMaskSelection(current, topology);

  assert.deepEqual(sorted(dilated), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(sorted(current), [4]);

  geometry.dispose();
});

test('dilating an empty mask remains empty', () => {
  const geometry = new THREE.PlaneGeometry(2, 2, 2, 2);
  const topology = topologyFromGeometry(geometry);

  assert.deepEqual(sorted(dilateMaskSelection(new Set(), topology)), []);

  geometry.dispose();
});

test('eroding a full open plane removes its mesh boundary', () => {
  const geometry = new THREE.PlaneGeometry(2, 2, 2, 2);
  const topology = topologyFromGeometry(geometry);
  const fullMask = new Set(Array.from({ length: 9 }, (_, index) => index));

  assert.deepEqual(sorted(erodeMaskSelection(fullMask, topology)), [4]);
  assert.deepEqual(sorted(fullMask), [0, 1, 2, 3, 4, 5, 6, 7, 8]);

  geometry.dispose();
});

test('hollowing a full open plane returns exactly its boundary vertices', () => {
  const geometry = new THREE.PlaneGeometry(2, 2, 2, 2);
  const topology = topologyFromGeometry(geometry);
  const fullMask = new Set(Array.from({ length: 9 }, (_, index) => index));

  assert.deepEqual(
    sorted(hollowMaskSelection(fullMask, topology)),
    sorted(topology.boundaryVertices)
  );

  geometry.dispose();
});

test('an interior vertex is eroded when one of its neighbours is unselected', () => {
  const geometry = new THREE.PlaneGeometry(2, 2, 2, 2);
  const topology = topologyFromGeometry(geometry);
  const incompleteNeighborhood = new Set([1, 3, 4, 5, 6, 7]);

  assert.deepEqual(sorted(erodeMaskSelection(incompleteNeighborhood, topology)), []);

  geometry.dispose();
});

test('a full closed tetrahedron is unchanged by erosion and has no hollow border', () => {
  const geometry = makeClosedTetrahedron();
  const topology = topologyFromGeometry(geometry);
  const fullMask = new Set([0, 1, 2, 3]);

  assert.deepEqual(sorted(topology.boundaryVertices), []);
  assert.deepEqual(sorted(erodeMaskSelection(fullMask, topology)), [0, 1, 2, 3]);
  assert.deepEqual(sorted(hollowMaskSelection(fullMask, topology)), []);

  geometry.dispose();
});
