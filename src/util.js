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
export function downloadBlob(content, filename, mime = 'text/plain') {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}