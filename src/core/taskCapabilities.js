const DEFAULT_TASK_CAPABILITIES = Object.freeze({
  usesGlobalMesh: true,
  usesTaskMeshLoader: true,
  acceptsSharedMeshLoad: true,
});

export function getTaskCapabilities(task) {
  return {
    ...DEFAULT_TASK_CAPABILITIES,
    ...(task?.capabilities || {}),
  };
}

export function taskAcceptsSharedMeshLoad(task) {
  const capabilities = getTaskCapabilities(task);

  return capabilities.acceptsSharedMeshLoad !== false && capabilities.usesGlobalMesh !== false;
}
