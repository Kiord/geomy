import * as THREE from 'three';
import { app } from './app.js';

// ── Mouse coords relative to viewport ──
export function mouseFromEvent(event) {
  const rect = app.dom.viewport.getBoundingClientRect();
  return new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  );
}

// ── Raycast against current object ──
export function raycast(event) {
  if (!app.currentObject) return [];
  const mouse = mouseFromEvent(event);
  const rc = new THREE.Raycaster();
  rc.setFromCamera(mouse, app.camera);
  return rc.intersectObject(app.currentObject, true);
}

// ── Download blob ──
function blobFromContent(content, mime) {
  if (content instanceof Blob) {
    return content.type ? content : new Blob([content], { type: mime });
  }

  return new Blob([content], { type: mime });
}

function anchorDownload(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(a.href), 0);
}

function pickerTypesFor(filename, mime) {
  const ext = String(filename || '').split('.').pop()?.toLowerCase();
  if (!ext || ext === filename) return [];

  return [{
    description: `${ext.toUpperCase()} file`,
    accept: {
      [mime || 'application/octet-stream']: [`.${ext}`],
    },
  }];
}

async function tryNativeSave(blob, filename, mime) {
  if (typeof window.showSaveFilePicker !== 'function') return false;

  let handle;
  try {
    handle = await window.showSaveFilePicker({
      suggestedName: filename,
      types: pickerTypesFor(filename, mime || blob.type),
    });
  } catch (error) {
    if (error?.name === 'AbortError') return true;
    console.warn('Native save dialog failed, falling back to browser download:', error);
    return false;
  }

  try {
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
  } catch (error) {
    console.warn('Native file save failed, falling back to browser download:', error);
    return false;
  }
}

async function saveBlob(blob, filename, mime) {
  if (await tryNativeSave(blob, filename, mime)) return;
  anchorDownload(blob, filename);
}

export function downloadBlob(content, filename, mime = 'text/plain') {
  const blob = blobFromContent(content, mime);
  void saveBlob(blob, filename, mime);
}
