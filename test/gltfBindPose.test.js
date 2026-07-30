import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { resetSkinnedMeshesToBindPose } from '../src/io/gltfBindPose.js';

function assertMatrixClose(actual, expected, epsilon = 1e-6) {
  actual.elements.forEach((value, index) => {
    assert.ok(
      Math.abs(value - expected.elements[index]) <= epsilon,
      `matrix element ${index}: expected ${expected.elements[index]}, got ${value}`,
    );
  });
}

test('skinned GLTF meshes are restored to their skeleton bind pose', () => {
  const scene = new THREE.Group();
  const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  const hip = new THREE.Bone();
  const leg = new THREE.Bone();

  hip.position.set(0, 1, 0);
  leg.position.set(0, -1, 0);
  hip.add(leg);
  mesh.add(hip);
  scene.add(mesh);
  scene.updateMatrixWorld(true);

  const skeleton = new THREE.Skeleton([hip, leg]);
  mesh.bind(skeleton);

  const hipBindMatrix = hip.matrix.clone();
  const legBindMatrix = leg.matrix.clone();

  hip.rotation.z = 0.7;
  leg.position.set(0.8, -0.4, 0.3);
  leg.rotation.x = -1.1;
  scene.updateMatrixWorld(true);

  resetSkinnedMeshesToBindPose(scene);

  assertMatrixClose(hip.matrix, hipBindMatrix);
  assertMatrixClose(leg.matrix, legBindMatrix);
});

test('bind-pose reset leaves ordinary meshes unchanged', () => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  mesh.position.set(2, 3, 4);
  mesh.updateMatrix();
  const originalMatrix = mesh.matrix.clone();

  assert.equal(resetSkinnedMeshesToBindPose(mesh), mesh);
  assertMatrixClose(mesh.matrix, originalMatrix);
});
