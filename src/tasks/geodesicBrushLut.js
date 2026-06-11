import * as THREE from 'three';
import { app } from '../app.js';
import {
  canonicalTriangleVertexIndicesFromHit,
  getCanonicalData,
  getCanonicalPositionAttribute,
  getCanonicalVertexCount,
  renderVertexToCanonical,
} from './meshTaskUtils.js';

export const GEODESIC_BRUSH_LARGE_VERTEX_COUNT = 20000;

const STATUS_IDLE = 'idle';
const STATUS_BUILDING = 'building';
const STATUS_READY = 'ready';
const STATUS_ERROR = 'error';

const states = new WeakMap();
const _world = new THREE.Vector3();
const _projected = new THREE.Vector3();
const _hitPointAtDepth = new THREE.Vector3();
const _edgePointAtDepthX = new THREE.Vector3();
const _edgePointAtDepthY = new THREE.Vector3();

function makeWorker() {
  const code = `
    const FACE_SAMPLE_MODE = 'parallel-original-triangle-edge-graph';
    const DUPLICATE_POSITION_SCALE = 1e6;

    class IndexedMinHeap {
      constructor(capacity) {
        this.nodes = new Int32Array(Math.max(1, capacity));
        this.pos = new Int32Array(Math.max(1, capacity));
        this.dists = new Float64Array(Math.max(1, capacity));
        this.length = 0;
        this.pos.fill(-1);
      }

      clear() {
        const nodes = this.nodes;
        const pos = this.pos;
        for (let i = 0; i < this.length; i++) pos[nodes[i]] = -1;
        this.length = 0;
      }

      _swap(i, j) {
        const nodes = this.nodes;
        const dists = this.dists;
        const pos = this.pos;
        const ni = nodes[i];
        const nj = nodes[j];
        const di = dists[i];
        nodes[i] = nj;
        nodes[j] = ni;
        dists[i] = dists[j];
        dists[j] = di;
        pos[nj] = i;
        pos[ni] = j;
      }

      _bubbleUp(i) {
        const dists = this.dists;
        while (i > 0) {
          const p = (i - 1) >> 1;
          if (dists[p] <= dists[i]) break;
          this._swap(i, p);
          i = p;
        }
      }

      _bubbleDown(i) {
        const dists = this.dists;
        while (true) {
          let c = i * 2 + 1;
          if (c >= this.length) break;
          const r = c + 1;
          if (r < this.length && dists[r] < dists[c]) c = r;
          if (dists[i] <= dists[c]) break;
          this._swap(i, c);
          i = c;
        }
      }

      pushOrDecrease(node, dist) {
        const pos = this.pos;
        let i = pos[node];
        if (i >= 0) {
          if (dist >= this.dists[i]) return;
          this.dists[i] = dist;
          this._bubbleUp(i);
          return;
        }

        i = this.length++;
        this.nodes[i] = node;
        this.dists[i] = dist;
        pos[node] = i;
        this._bubbleUp(i);
      }

      popNode() {
        if (this.length <= 0) return -1;

        const nodes = this.nodes;
        const pos = this.pos;
        const node = nodes[0];
        pos[node] = -1;

        const last = --this.length;
        if (last > 0) {
          const lastNode = nodes[last];
          nodes[0] = lastNode;
          this.dists[0] = this.dists[last];
          pos[lastNode] = 0;
          this._bubbleDown(0);
        }

        return node;
      }
    }

    function vertexKeyXYZ(x, y, z) {
      const sx = Math.round(x * DUPLICATE_POSITION_SCALE);
      const sy = Math.round(y * DUPLICATE_POSITION_SCALE);
      const sz = Math.round(z * DUPLICATE_POSITION_SCALE);
      return sx + '|' + sy + '|' + sz;
    }

    function vertexKey(positions, i) {
      return vertexKeyXYZ(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    }

    function edgeWeight(positions, a, b) {
      const ax = positions[a * 3];
      const ay = positions[a * 3 + 1];
      const az = positions[a * 3 + 2];
      const bx = positions[b * 3];
      const by = positions[b * 3 + 1];
      const bz = positions[b * 3 + 2];
      const dx = ax - bx;
      const dy = ay - by;
      const dz = az - bz;
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    function addEdge(edges, a, b, weight) {
      if (a === b || a < 0 || b < 0 || !Number.isFinite(weight) || weight < 0) return;
      const lo = a < b ? a : b;
      const hi = a < b ? b : a;
      const key = lo + ',' + hi;
      const previous = edges.get(key);
      if (previous === undefined || weight < previous) edges.set(key, weight);
    }

    function buildAdjacency(vertexCount, positions, indices) {
      const edges = new Map();

      for (let i = 0; i + 2 < indices.length; i += 3) {
        const a = indices[i];
        const b = indices[i + 1];
        const c = indices[i + 2];
        if (a < 0 || b < 0 || c < 0 || a >= vertexCount || b >= vertexCount || c >= vertexCount) continue;
        if (a === b || b === c || c === a) continue;

        addEdge(edges, a, b, edgeWeight(positions, a, b));
        addEdge(edges, b, c, edgeWeight(positions, b, c));
        addEdge(edges, c, a, edgeWeight(positions, c, a));
      }

      const duplicates = new Map();
      for (let i = 0; i < vertexCount; i++) {
        const key = vertexKey(positions, i);
        const first = duplicates.get(key);
        if (first === undefined) duplicates.set(key, i);
        else addEdge(edges, first, i, 0);
      }

      const counts = new Int32Array(vertexCount);
      edges.forEach((_, key) => {
        const comma = key.indexOf(',');
        counts[Number(key.slice(0, comma))]++;
        counts[Number(key.slice(comma + 1))]++;
      });

      const offsets = new Int32Array(vertexCount + 1);
      for (let i = 0; i < vertexCount; i++) offsets[i + 1] = offsets[i] + counts[i];

      const write = new Int32Array(offsets);
      const neighbors = new Int32Array(offsets[vertexCount]);
      const weights = new Float32Array(offsets[vertexCount]);

      edges.forEach((weight, key) => {
        const comma = key.indexOf(',');
        const a = Number(key.slice(0, comma));
        const b = Number(key.slice(comma + 1));
        const ia = write[a]++;
        const ib = write[b]++;
        neighbors[ia] = b;
        weights[ia] = weight;
        neighbors[ib] = a;
        weights[ib] = weight;
      });

      return { offsets, neighbors, weights, edgeCount: edges.size, graphNodeCount: vertexCount, mode: FACE_SAMPLE_MODE };
    }

    function dijkstra(source, offsets, neighbors, weights, scratch, heap) {
      scratch.fill(Infinity);
      scratch[source] = 0;
      heap.clear();
      heap.pushOrDecrease(source, 0);

      while (heap.length) {
        const node = heap.popNode();
        if (node < 0) break;
        const dist = scratch[node];

        for (let e = offsets[node]; e < offsets[node + 1]; e++) {
          const next = neighbors[e];
          const nextDistance = dist + weights[e];
          if (nextDistance < scratch[next]) {
            scratch[next] = nextDistance;
            heap.pushOrDecrease(next, nextDistance);
          }
        }
      }
    }

    let vertexCount = 0;
    let adjacency = null;
    let scratch = null;
    let heap = null;

    self.onmessage = event => {
      const data = event.data || {};
      try {
        if (data.type === 'init') {
          vertexCount = data.vertexCount || 0;
          if (!vertexCount || !data.positions || !data.indices) throw new Error('Invalid geodesic precompute payload.');
          adjacency = buildAdjacency(vertexCount, data.positions, data.indices);
          scratch = new Float64Array(adjacency.graphNodeCount);
          heap = new IndexedMinHeap(adjacency.graphNodeCount);
          self.postMessage({
            type: 'ready',
            edgeCount: adjacency.edgeCount,
            graphNodeCount: adjacency.graphNodeCount,
            mode: adjacency.mode,
          });
          return;
        }

        if (data.type === 'range') {
          if (!adjacency || !scratch || !heap) throw new Error('Worker not initialized.');
          const start = data.start | 0;
          const end = Math.min(vertexCount, data.end | 0);
          const rowCount = Math.max(0, end - start);
          const rows = new Float32Array(rowCount * vertexCount);

          for (let source = start; source < end; source++) {
            dijkstra(source, adjacency.offsets, adjacency.neighbors, adjacency.weights, scratch, heap);
            rows.set(scratch, (source - start) * vertexCount);
          }

          self.postMessage({ type: 'chunk', start, rowCount, rows }, [rows.buffer]);
          return;
        }

        if (data.type === 'close') {
          self.close();
        }
      } catch (error) {
        self.postMessage({ type: 'error', message: error?.message || String(error) });
      }
    };
  `;

  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  const worker = new Worker(url);
  URL.revokeObjectURL(url);
  return worker;
}

function chooseWorkerCount(vertexCount) {
  const cores = Math.max(1, Number(navigator.hardwareConcurrency) || 4);
  const memoryGiB = Number(navigator.deviceMemory) || 4;
  const memoryCap = memoryGiB <= 4 ? 3 : 6;
  const bySize = vertexCount < 1500 ? 1 : vertexCount < 5000 ? 2 : vertexCount < 9000 ? 4 : 6;
  return Math.max(1, Math.min(cores - 1 || 1, memoryCap, bySize));
}

function chooseRowChunkSize(vertexCount, workerCount) {
  if (vertexCount >= 20000) return 4;
  if (vertexCount >= 7000) return 8;
  if (vertexCount >= 3500) return 16;
  return Math.max(16, Math.ceil(vertexCount / Math.max(1, workerCount * 24)));
}

function stateFor(mesh) {
  let state = states.get(mesh);
  if (!state) {
    state = {
      status: STATUS_IDLE,
      progress: 0,
      phase: '',
      label: '',
      vertexCount: 0,
      edgeCount: 0,
      graphNodeCount: 0,
      graphMode: '',
      lastLookup: null,
      distances: null,
      worker: null,
      workers: [],
      promise: null,
      error: null,
    };
    states.set(mesh, state);
  }
  return state;
}

function meshLabel(mesh, index) {
  return mesh?.name || mesh?.parent?.name || `mesh ${index + 1}`;
}

function makeCanonicalIndexArray(mesh, vertexCount) {
  const canonical = getCanonicalData(mesh);
  if (canonical?.faces?.length) {
    const out = new Uint32Array(canonical.faces.length);
    for (let i = 0; i < out.length; i++) out[i] = canonical.faces[i];
    return out;
  }

  const geometry = mesh.geometry;
  const sourceCount = geometry.index ? geometry.index.count : (geometry.attributes.position?.count || 0);
  const out = new Uint32Array(Math.floor(sourceCount / 3) * 3);

  for (let i = 0; i < out.length; i++) {
    const renderIndex = geometry.index ? geometry.index.getX(i) : i;
    const canonicalIndex = renderVertexToCanonical(mesh, renderIndex);
    out[i] = canonicalIndex >= 0 && canonicalIndex < vertexCount ? canonicalIndex : 0;
  }

  return out;
}

function makePrecomputePayload(mesh) {
  const position = getCanonicalPositionAttribute(mesh);
  const vertexCount = getCanonicalVertexCount(mesh);
  if (!mesh?.isMesh || !position || !vertexCount) throw new Error('No mesh vertices available.');

  mesh.updateMatrixWorld(true);
  const positions = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    _world.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
    positions[i * 3] = _world.x;
    positions[i * 3 + 1] = _world.y;
    positions[i * 3 + 2] = _world.z;
  }

  return {
    positions,
    indices: makeCanonicalIndexArray(mesh, vertexCount),
    vertexCount,
  };
}

function startPrecompute(mesh, label, onProgress) {
  const state = stateFor(mesh);
  if (state.status === STATUS_READY && state.distances) return Promise.resolve(state);
  if (state.status === STATUS_BUILDING && state.promise) return state.promise;

  const payload = makePrecomputePayload(mesh);
  const vertexCount = payload.vertexCount;
  const workerCount = chooseWorkerCount(vertexCount);
  const chunkSize = chooseRowChunkSize(vertexCount, workerCount);
  const distances = new Float32Array(vertexCount * vertexCount);
  const workers = Array.from({ length: workerCount }, makeWorker);

  state.status = STATUS_BUILDING;
  state.progress = 0;
  state.phase = 'graph';
  state.label = label;
  state.vertexCount = vertexCount;
  state.edgeCount = 0;
  state.graphNodeCount = 0;
  state.graphMode = '';
  state.distances = null;
  state.error = null;
  state.worker = workers[0] || null;
  state.workers = workers;

  state.promise = new Promise((resolve, reject) => {
    let nextSource = 0;
    let completedRows = 0;
    let readyWorkers = 0;
    let finished = false;
    let lastProgressPost = performance.now();

    const cleanup = () => {
      workers.forEach(worker => worker.terminate());
      state.worker = null;
      state.workers = [];
      state.promise = null;
    };

    const fail = message => {
      if (finished) return;
      finished = true;
      state.status = STATUS_ERROR;
      state.error = message || 'Geodesic precompute failed.';
      cleanup();
      onProgress?.(state);
      reject(new Error(state.error));
    };

    const maybeProgress = force => {
      const now = performance.now();
      if (!force && now - lastProgressPost < 100) return;
      lastProgressPost = now;
      state.status = STATUS_BUILDING;
      state.phase = 'distances';
      state.progress = vertexCount ? completedRows / vertexCount : 0;
      onProgress?.(state);
    };

    const finish = () => {
      if (finished) return;
      finished = true;
      state.status = STATUS_READY;
      state.progress = 1;
      state.phase = 'done';
      state.distances = distances;
      cleanup();
      onProgress?.(state);
      resolve(state);
    };

    const assign = worker => {
      if (finished) return;
      if (nextSource >= vertexCount) {
        if (completedRows >= vertexCount) finish();
        return;
      }

      const start = nextSource;
      const end = Math.min(vertexCount, start + chunkSize);
      nextSource = end;
      worker.postMessage({ type: 'range', start, end });
    };

    workers.forEach(worker => {
      worker.onmessage = event => {
        const data = event.data || {};

        if (data.type === 'ready') {
          readyWorkers++;
          state.edgeCount = Math.max(state.edgeCount || 0, data.edgeCount || 0);
          state.graphNodeCount = Math.max(state.graphNodeCount || 0, data.graphNodeCount || 0);
          state.graphMode = data.mode || state.graphMode || '';
          state.phase = readyWorkers < workerCount ? 'mesh graph' : 'distances';
          state.progress = 0;
          onProgress?.(state);
          assign(worker);
          return;
        }

        if (data.type === 'chunk') {
          const rows = data.rows;
          const start = data.start | 0;
          const rowCount = data.rowCount | 0;
          if (!(rows instanceof Float32Array) || rowCount <= 0) {
            fail('Invalid geodesic worker chunk.');
            return;
          }

          distances.set(rows, start * vertexCount);
          completedRows += rowCount;
          maybeProgress(completedRows >= vertexCount);

          if (completedRows >= vertexCount) finish();
          else assign(worker);
          return;
        }

        if (data.type === 'error') {
          fail(data.message || 'Geodesic worker failed.');
        }
      };

      worker.onerror = event => {
        fail(event?.message || 'Geodesic precompute worker failed.');
      };
    });

    workers.forEach(worker => {
      // Do not transfer these buffers: each worker needs its own read-only clone.
      worker.postMessage({
        type: 'init',
        positions: payload.positions,
        indices: payload.indices,
        vertexCount,
      });
    });
  });

  onProgress?.(state);
  return state.promise;
}

export function geodesicBrushStatus(meshes) {
  const list = Array.from(meshes || []).filter(mesh => mesh?.isMesh);
  if (!list.length) return { ready: false, building: false, progress: 0, label: 'Load a mesh first' };

  const statesForMeshes = list.map(stateFor);
  const ready = statesForMeshes.every(state => state.status === STATUS_READY && state.distances);
  const building = statesForMeshes.some(state => state.status === STATUS_BUILDING);
  const error = statesForMeshes.find(state => state.status === STATUS_ERROR);
  const progress = statesForMeshes.reduce((sum, state) => {
    if (state.status === STATUS_READY) return sum + 1;
    return sum + (state.progress || 0);
  }, 0) / statesForMeshes.length;

  if (error) return { ready: false, building: false, progress, label: error.error || 'Geodesic precompute failed' };
  if (ready) {
    const lookup = statesForMeshes.find(state => state.lastLookup)?.lastLookup;
    const suffix = lookup
      ? ` · ${lookup.selectedCount.toLocaleString()} verts · ${lookup.worldRadius.toPrecision(3)} world`
      : '';
    return { ready: true, building: false, progress: 1, label: `Geodesic brush ready${suffix}` };
  }
  if (building) {
    const active = statesForMeshes.reduce((sum, state) => sum + (state.workers?.length || (state.worker ? 1 : 0)), 0);
    const suffix = active > 1 ? ` · ${active} workers` : '';
    return { ready: false, building: true, progress, label: `Building geodesic LUT ${Math.round(progress * 100)}%${suffix}` };
  }
  return { ready: false, building: false, progress: 0, label: 'Click checkbox to build LUT' };
}

export function geodesicBrushMemoryEstimateBytes(vertexCount) {
  return Number(vertexCount) * Number(vertexCount) * 4;
}

export async function precomputeGeodesicBrush(meshes, { confirmLarge = null, onProgress = null } = {}) {
  const list = Array.from(meshes || []).filter(mesh => mesh?.isMesh);
  if (!list.length) throw new Error('Load a mesh before enabling the geodesic brush.');

  const totalVertices = list.reduce((sum, mesh) => sum + getCanonicalVertexCount(mesh), 0);
  if (totalVertices > GEODESIC_BRUSH_LARGE_VERTEX_COUNT) {
    const ok = confirmLarge
      ? confirmLarge(totalVertices)
      : window.confirm(`This mesh has ${totalVertices.toLocaleString()} vertices. Precomputing all-pairs geodesic distances can take a while and use a lot of memory. Continue?`);
    if (!ok) return false;
  }

  for (let i = 0; i < list.length; i++) {
    await startPrecompute(list[i], meshLabel(list[i], i), onProgress);
  }

  return true;
}

export function resetGeodesicBrushPrecompute(meshes = []) {
  Array.from(meshes || []).forEach(mesh => {
    const state = states.get(mesh);
    state?.worker?.terminate?.();
    state?.workers?.forEach?.(worker => worker.terminate());
    states.delete(mesh);
  });
}

function screenRadiusToWorldRadiusAtPoint(worldPoint, screenRadiusPx) {
  const camera = app.camera;
  const rect = app.dom.viewport?.getBoundingClientRect?.();
  const radiusPx = Number(screenRadiusPx);
  if (!camera || !rect?.width || !rect?.height || !worldPoint || !Number.isFinite(radiusPx) || radiusPx <= 0) return 0;

  camera.updateMatrixWorld?.(true);
  camera.updateProjectionMatrix?.();

  if (camera.isPerspectiveCamera) {
    _hitPointAtDepth.copy(worldPoint).applyMatrix4(camera.matrixWorldInverse);
    const depth = Math.abs(_hitPointAtDepth.z);
    if (!Number.isFinite(depth) || depth <= 0) return 0;

    // CSS-pixel radius -> world radius on a plane parallel to the camera image
    // plane, i.e. the user's requested "surface normal points at us" model.
    const visibleHeight = 2 * depth * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
    return radiusPx * visibleHeight / rect.height;
  }

  if (camera.isOrthographicCamera) {
    const visibleHeight = Math.abs(camera.top - camera.bottom) / Math.max(1e-12, camera.zoom || 1);
    return radiusPx * visibleHeight / rect.height;
  }

  // Fallback: exact unprojected CSS-pixel offset at the same depth.
  _projected.copy(worldPoint).project(camera);
  if (!Number.isFinite(_projected.x) || !Number.isFinite(_projected.y) || !Number.isFinite(_projected.z)) return 0;

  const dyNdc = radiusPx * 2 / rect.height;
  _hitPointAtDepth.set(_projected.x, _projected.y, _projected.z).unproject(camera);
  _edgePointAtDepthY.set(_projected.x, _projected.y + dyNdc, _projected.z).unproject(camera);
  const radius = _hitPointAtDepth.distanceTo(_edgePointAtDepthY);
  return Number.isFinite(radius) ? radius : 0;
}

function closestCanonicalVertexToPoint(mesh, point, vertexCount) {
  const position = getCanonicalPositionAttribute(mesh);
  if (!position || !point || vertexCount <= 0) return { index: -1, point: null, distance: Infinity };

  mesh.updateMatrixWorld(true);
  let bestIndex = -1;
  let bestDistanceSq = Infinity;
  const bestPoint = new THREE.Vector3();

  for (let i = 0; i < vertexCount; i++) {
    _world.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
    const distanceSq = _world.distanceToSquared(point);
    if (distanceSq < bestDistanceSq) {
      bestDistanceSq = distanceSq;
      bestIndex = i;
      bestPoint.copy(_world);
    }
  }

  return {
    index: bestIndex,
    point: bestIndex >= 0 ? bestPoint : null,
    distance: Math.sqrt(bestDistanceSq),
  };
}

export function getPrecomputedGeodesicDistanceDebug(hit, brushRadiusPx = 0) {
  const mesh = hit?.object;
  const state = states.get(mesh);
  if (!mesh?.isMesh || state?.status !== STATUS_READY || !state.distances) return null;

  const n = state.vertexCount;
  const source = closestCanonicalVertexToPoint(mesh, hit?.point, n);
  if (source.index < 0 || !source.point) return null;

  const radius = screenRadiusToWorldRadiusAtPoint(hit.point, brushRadiusPx);
  const rowOffset = source.index * n;
  const distances = state.distances.subarray(rowOffset, rowOffset + n);

  let finiteCount = 0;
  let maxFiniteDistance = 0;
  for (let i = 0; i < distances.length; i++) {
    const d = distances[i];
    if (Number.isFinite(d)) {
      finiteCount++;
      if (d > maxFiniteDistance) maxFiniteDistance = d;
    }
  }

  let selectedCount = 0;
  if (Number.isFinite(radius) && radius > 0) {
    for (let i = 0; i < distances.length; i++) {
      if (distances[i] <= radius) selectedCount++;
    }
  }

  state.lastLookup = {
    sourceIndex: source.index,
    brushRadiusPx: Number(brushRadiusPx),
    worldRadius: radius,
    sourceOffset: source.distance,
    selectedCount,
  };

  return {
    mesh,
    vertexCount: n,
    sourceIndex: source.index,
    sourcePoint: source.point.clone(),
    sourceOffset: source.distance,
    brushRadiusPx: Number(brushRadiusPx),
    worldRadius: radius,
    selectedCount,
    finiteCount,
    maxFiniteDistance,
    distances,
  };
}

export function collectPrecomputedGeodesicBrushVertexIndices(hit, brushRadiusPx) {
  const mesh = hit?.object;
  const state = states.get(mesh);
  if (!mesh?.isMesh || state?.status !== STATUS_READY || !state.distances) return null;

  const n = state.vertexCount;
  const source = closestCanonicalVertexToPoint(mesh, hit?.point, n);
  if (source.index < 0 || !source.point) return [];

  const radius = screenRadiusToWorldRadiusAtPoint(hit.point, brushRadiusPx);
  if (!Number.isFinite(radius) || radius <= 0) return [];

  // Deliberately simple runtime path: closest vertex -> one all-pairs row ->
  // threshold. No triangle blending, no cached selection, no screen-space cap.
  const rowOffset = source.index * n;
  const distances = state.distances;
  const out = [];

  for (let vertex = 0; vertex < n; vertex++) {
    const distance = distances[rowOffset + vertex];
    if (distance <= radius) out.push(vertex);
  }

  state.lastLookup = {
    sourceIndex: source.index,
    brushRadiusPx: Number(brushRadiusPx),
    worldRadius: radius,
    sourceOffset: source.distance,
    selectedCount: out.length,
  };

  return out;
}
