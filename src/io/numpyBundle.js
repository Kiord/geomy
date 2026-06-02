// Minimal NumPy .npy and uncompressed .npz/.zip helpers for browser-only I/O.
// Supports little-endian int32, float32, and bool arrays.

const DTYPE_INFO = {
  int32: { descr: '<i4', ctor: Int32Array, bytes: 4 },
  float32: { descr: '<f4', ctor: Float32Array, bytes: 4 },
  bool: { descr: '|b1', ctor: Uint8Array, bytes: 1 },
};

function align16(n) {
  return (16 - (n % 16)) % 16;
}

function normalizeShape(shape) {
  return Array.from(shape || []).map(v => Math.max(0, Math.floor(Number(v) || 0)));
}

function shapeSize(shape) {
  return shape.reduce((a, b) => a * b, 1);
}

function asciiBytes(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function textFromAscii(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

export function writeNpy(data, shape, dtype = null) {
  const inferred = dtype || (
    data instanceof Float32Array ? 'float32' :
    data instanceof Int32Array ? 'int32' :
    'bool'
  );
  const info = DTYPE_INFO[inferred];
  if (!info) throw new Error(`Unsupported NPY dtype: ${inferred}`);

  const finalShape = normalizeShape(shape);
  const expected = shapeSize(finalShape);
  if (data.length !== expected) {
    throw new Error(`NPY data length ${data.length} does not match shape ${finalShape.join('x')} (${expected}).`);
  }

  let typed;
  if (data instanceof info.ctor) typed = data;
  else typed = new info.ctor(data);

  const shapeText = finalShape.length === 1
    ? `(${finalShape[0]},)`
    : `(${finalShape.join(', ')})`;
  let header = `{'descr': '${info.descr}', 'fortran_order': False, 'shape': ${shapeText}, }`;
  const prefixLen = 10;
  header += ' '.repeat(align16(prefixLen + header.length + 1));
  header += '\n';

  const headerBytes = asciiBytes(header);
  const bytes = new Uint8Array(prefixLen + headerBytes.length + typed.byteLength);
  bytes.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 0x01, 0x00], 0);
  bytes[8] = headerBytes.length & 0xff;
  bytes[9] = (headerBytes.length >> 8) & 0xff;
  bytes.set(headerBytes, 10);
  bytes.set(new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength), prefixLen + headerBytes.length);
  return bytes;
}

export function parseNpy(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 10 || bytes[0] !== 0x93 || textFromAscii(bytes.slice(1, 6)) !== 'NUMPY') {
    throw new Error('Not a NumPy .npy file.');
  }
  const major = bytes[6];
  let headerLen, offset;
  if (major === 1) {
    headerLen = bytes[8] | (bytes[9] << 8);
    offset = 10;
  } else if (major === 2 || major === 3) {
    headerLen = bytes[8] | (bytes[9] << 8) | (bytes[10] << 16) | (bytes[11] << 24);
    offset = 12;
  } else {
    throw new Error(`Unsupported NPY version ${major}.`);
  }

  const header = textFromAscii(bytes.slice(offset, offset + headerLen));
  const descr = /'descr'\s*:\s*'([^']+)'/.exec(header)?.[1];
  const shapeMatch = /'shape'\s*:\s*\(([^)]*)\)/.exec(header);
  if (!descr || !shapeMatch) throw new Error('Could not parse NPY header.');

  const shape = shapeMatch[1]
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(Number);

  const dataOffset = offset + headerLen;
  const dataBytes = bytes.slice(dataOffset);
  let dtype, Ctor;
  if (descr === '<i4' || descr === '|i4') { dtype = 'int32'; Ctor = Int32Array; }
  else if (descr === '<f4' || descr === '|f4') { dtype = 'float32'; Ctor = Float32Array; }
  else if (descr === '|b1' || descr === '|u1') { dtype = 'bool'; Ctor = Uint8Array; }
  else throw new Error(`Unsupported NPY dtype: ${descr}`);

  const aligned = dataBytes.byteOffset % Ctor.BYTES_PER_ELEMENT === 0;
  const data = aligned
    ? new Ctor(dataBytes.buffer, dataBytes.byteOffset, Math.floor(dataBytes.byteLength / Ctor.BYTES_PER_ELEMENT)).slice()
    : new Ctor(dataBytes.slice().buffer);

  return { data, shape, dtype, descr };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u16(out, offset, value) {
  out[offset] = value & 0xff;
  out[offset + 1] = (value >>> 8) & 0xff;
}

function u32(out, offset, value) {
  out[offset] = value & 0xff;
  out[offset + 1] = (value >>> 8) & 0xff;
  out[offset + 2] = (value >>> 16) & 0xff;
  out[offset + 3] = (value >>> 24) & 0xff;
}

function readU16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function makeZip(entries) {
  const normalized = entries.map(entry => ({
    name: String(entry.name).replace(/^\/+/, ''),
    data: entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data),
  }));

  let localSize = 0;
  let centralSize = 0;
  const meta = normalized.map(entry => {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const localOffset = localSize;
    localSize += 30 + nameBytes.length + entry.data.length;
    centralSize += 46 + nameBytes.length;
    return { ...entry, nameBytes, crc, localOffset };
  });

  const total = localSize + centralSize + 22;
  const out = new Uint8Array(total);
  let p = 0;

  for (const entry of meta) {
    u32(out, p, 0x04034b50); p += 4;
    u16(out, p, 20); p += 2;
    u16(out, p, 0); p += 2;
    u16(out, p, 0); p += 2;
    u16(out, p, 0); p += 2;
    u16(out, p, 0); p += 2;
    u32(out, p, entry.crc); p += 4;
    u32(out, p, entry.data.length); p += 4;
    u32(out, p, entry.data.length); p += 4;
    u16(out, p, entry.nameBytes.length); p += 2;
    u16(out, p, 0); p += 2;
    out.set(entry.nameBytes, p); p += entry.nameBytes.length;
    out.set(entry.data, p); p += entry.data.length;
  }

  const centralOffset = p;
  for (const entry of meta) {
    u32(out, p, 0x02014b50); p += 4;
    u16(out, p, 20); p += 2;
    u16(out, p, 20); p += 2;
    u16(out, p, 0); p += 2;
    u16(out, p, 0); p += 2;
    u16(out, p, 0); p += 2;
    u16(out, p, 0); p += 2;
    u32(out, p, entry.crc); p += 4;
    u32(out, p, entry.data.length); p += 4;
    u32(out, p, entry.data.length); p += 4;
    u16(out, p, entry.nameBytes.length); p += 2;
    u16(out, p, 0); p += 2;
    u16(out, p, 0); p += 2;
    u16(out, p, 0); p += 2;
    u16(out, p, 0); p += 2;
    u32(out, p, 0); p += 4;
    u32(out, p, entry.localOffset); p += 4;
    out.set(entry.nameBytes, p); p += entry.nameBytes.length;
  }

  u32(out, p, 0x06054b50); p += 4;
  u16(out, p, 0); p += 2;
  u16(out, p, 0); p += 2;
  u16(out, p, meta.length); p += 2;
  u16(out, p, meta.length); p += 2;
  u32(out, p, centralSize); p += 4;
  u32(out, p, centralOffset); p += 4;
  u16(out, p, 0); p += 2;

  return out;
}

export function readZip(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const entries = new Map();
  let p = 0;
  while (p + 30 <= bytes.length && readU32(bytes, p) === 0x04034b50) {
    const method = readU16(bytes, p + 8);
    if (method !== 0) throw new Error('Only uncompressed .zip/.npz files are supported here.');
    const compressedSize = readU32(bytes, p + 18);
    const nameLen = readU16(bytes, p + 26);
    const extraLen = readU16(bytes, p + 28);
    const nameStart = p + 30;
    const dataStart = nameStart + nameLen + extraLen;
    const name = decoder.decode(bytes.slice(nameStart, nameStart + nameLen));
    entries.set(name, bytes.slice(dataStart, dataStart + compressedSize));
    p = dataStart + compressedSize;
  }
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

export function parseBundleArrays(entries) {
  const arrays = new Map();
  entries.forEach((bytes, name) => {
    if (name.toLowerCase().endsWith('.npy')) arrays.set(name, parseNpy(bytes));
  });
  return arrays;
}

export function downloadArrayBundle(entries, filename) {
  const bytes = makeZip(entries);
  const blob = new Blob([bytes], { type: 'application/zip' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function downloadNpy(data, shape, dtype, filename) {
  const bytes = writeNpy(data, shape, dtype);
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
