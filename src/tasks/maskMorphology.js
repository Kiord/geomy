function validVertexIndex(index, vertexCount) {
  return Number.isInteger(index) && index >= 0 && index < vertexCount;
}

export function buildMaskTopology(vertexCount, triangleIndices) {
  const count = Math.max(0, Math.floor(Number(vertexCount)) || 0);
  const indices = Array.from(triangleIndices || [], Number);
  const neighborSets = Array.from({ length: count }, () => new Set());
  const edgeRecords = new Map();

  const addEdge = (a, b) => {
    if (!validVertexIndex(a, count) || !validVertexIndex(b, count) || a === b) return;

    neighborSets[a].add(b);
    neighborSets[b].add(a);

    const edgeA = Math.min(a, b);
    const edgeB = Math.max(a, b);
    const key = `${edgeA}:${edgeB}`;
    const record = edgeRecords.get(key);

    if (record) {
      record.faceCount += 1;
    } else {
      edgeRecords.set(key, { a: edgeA, b: edgeB, faceCount: 1 });
    }
  };

  const triangleCount = Math.floor(indices.length / 3);
  for (let triangle = 0; triangle < triangleCount; triangle++) {
    const offset = triangle * 3;
    const a = indices[offset];
    const b = indices[offset + 1];
    const c = indices[offset + 2];
    addEdge(a, b);
    addEdge(b, c);
    addEdge(c, a);
  }

  const boundaryVertices = new Set();
  edgeRecords.forEach(({ a, b, faceCount }) => {
    if (faceCount !== 1) return;
    boundaryVertices.add(a);
    boundaryVertices.add(b);
  });

  return {
    neighbors: neighborSets.map(neighbors => Array.from(neighbors)),
    boundaryVertices,
  };
}

export function dilateMaskSelection(current, topology) {
  const dilated = new Set(current || []);
  const neighbors = topology?.neighbors || [];

  Array.from(current || []).forEach(index => {
    (neighbors[index] || []).forEach(neighbor => dilated.add(neighbor));
  });

  return dilated;
}

export function erodeMaskSelection(current, topology) {
  const selected = current instanceof Set ? current : new Set(current || []);
  const neighbors = topology?.neighbors || [];
  const boundaryVertices = topology?.boundaryVertices || new Set();
  const eroded = new Set();

  selected.forEach(index => {
    if (
      !boundaryVertices.has(index)
      && (neighbors[index] || []).every(neighbor => selected.has(neighbor))
    ) {
      eroded.add(index);
    }
  });

  return eroded;
}

export function hollowMaskSelection(current, topology) {
  const selected = current instanceof Set ? current : new Set(current || []);
  const eroded = erodeMaskSelection(selected, topology);
  const hollowed = new Set();

  selected.forEach(index => {
    if (!eroded.has(index)) hollowed.add(index);
  });

  return hollowed;
}
