export function resetSkinnedMeshesToBindPose(root) {
  if (!root?.traverse) return root;

  const skinnedMeshes = [];
  root.traverse(object => {
    if (object.isSkinnedMesh && object.skeleton) {
      skinnedMeshes.push(object);
    }
  });

  if (!skinnedMeshes.length) return root;

  root.updateMatrixWorld(true);

  const posedSkeletons = new Set();
  skinnedMeshes.forEach(mesh => {
    if (posedSkeletons.has(mesh.skeleton)) return;
    mesh.pose();
    posedSkeletons.add(mesh.skeleton);
  });

  root.updateMatrixWorld(true);
  skinnedMeshes.forEach(mesh => mesh.skeleton.update());
  return root;
}
