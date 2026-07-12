import JSZip from 'jszip';
import { dump, load } from 'npyjs';
import { downloadBlob } from '../util.js';

const SAVE_DTYPES = {
  bool: 'b1',
  boolean: 'b1',
  int32: 'i4',
  float32: 'f4',
};

const DTYPE_NAMES = {
  b1: 'bool',
  i1: 'int8',
  u1: 'uint8',
  i2: 'int16',
  u2: 'uint16',
  i4: 'int32',
  u4: 'uint32',
  i8: 'int64',
  u8: 'uint64',
  f2: 'float16',
  f4: 'float32',
  f8: 'float64',
  c8: 'complex64',
  c16: 'complex128',
};

const encoder = new TextEncoder();

function asUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function asExactArrayBuffer(value) {
  const bytes = asUint8Array(value);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function normalizeShape(shape) {
  return Array.from(shape || []).map(value => Math.max(0, Math.floor(Number(value) || 0)));
}

function shapeSize(shape) {
  return shape.reduce((total, value) => total * value, 1);
}

function normalizeSaveDtype(dtype) {
  const key = String(dtype || '').toLowerCase();
  return SAVE_DTYPES[key] || dtype || undefined;
}

function dtypeDescr(dtype) {
  if (!dtype) return '';
  return dtype === 'b1' || dtype.endsWith('1') ? `|${dtype}` : `<${dtype}`;
}

export function writeNpy(data, shape, dtype = null) {
  const finalShape = normalizeShape(shape);
  const expected = shapeSize(finalShape);
  if (data.length !== expected) {
    throw new Error(`NPY data length ${data.length} does not match shape ${finalShape.join('x')} (${expected}).`);
  }

  return new Uint8Array(dump(data, finalShape, { dtype: normalizeSaveDtype(dtype) }));
}

export async function parseNpy(buffer) {
  const parsed = await load(asExactArrayBuffer(buffer));
  const dtype = DTYPE_NAMES[parsed.dtype] || parsed.dtype;

  return {
    data: parsed.data,
    shape: parsed.shape,
    dtype,
    descr: dtypeDescr(parsed.dtype),
    fortranOrder: parsed.fortranOrder,
  };
}

export async function makeZip(entries) {
  const zip = new JSZip();
  entries.forEach(entry => {
    const name = String(entry.name || '').replace(/^\/+/, '');
    zip.file(name, asUint8Array(entry.data));
  });
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'STORE' }));
}

export async function readZip(buffer) {
  const zip = await JSZip.loadAsync(asExactArrayBuffer(buffer));
  const entries = new Map();

  await Promise.all(Object.values(zip.files).map(async entry => {
    if (!entry.dir) entries.set(entry.name, await entry.async('uint8array'));
  }));

  if (!entries.size) throw new Error('No readable entries found in zip/npz file.');
  return entries;
}

export function npyEntry(name, data, shape, dtype = null) {
  return { name, data: writeNpy(data, shape, dtype) };
}

export function jsonEntry(name, value) {
  return { name, data: encoder.encode(JSON.stringify(value, null, 2)) };
}

export async function readArrayBundle(file) {
  const lower = String(file?.name || '').toLowerCase();
  const buffer = await file.arrayBuffer();
  if (lower.endsWith('.npy')) {
    return new Map([[file.name || 'array.npy', new Uint8Array(buffer)]]);
  }
  return readZip(buffer);
}

export async function parseBundleArrays(entries) {
  const arrays = new Map();
  await Promise.all(Array.from(entries, async ([name, bytes]) => {
    if (name.toLowerCase().endsWith('.npy')) arrays.set(name, await parseNpy(bytes));
  }));
  return arrays;
}

export async function downloadArrayBundle(entries, filename) {
  const bytes = await makeZip(entries);
  downloadBlob(bytes, filename, 'application/zip');
}

export function downloadNpy(data, shape, dtype, filename) {
  const bytes = writeNpy(data, shape, dtype);
  downloadBlob(bytes, filename, 'application/octet-stream');
}
