import { downloadBlob } from '../util.js';
import { escapeAttr, escapeHtml } from '../core/textUtils.js';
import { downloadNpy, parseNpy } from './numpyBundle.js';

export function stripKnownExtension(name, fallback = 'data') {
  const stem = String(name || fallback)
    .replace(/\.(json|npy|npz|zip|txt|csv|tsv)$/i, '')
    .trim();

  return stem || fallback;
}

export function safeDataFilename(value, fallback = 'data') {
  const safe = stripKnownExtension(value, fallback)
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();

  return safe || fallback;
}

export function fileKind(file) {
  const lower = String(file?.name || '').toLowerCase();
  if (lower.endsWith('.npy')) return 'npy';
  if (lower.endsWith('.txt') || lower.endsWith('.csv') || lower.endsWith('.tsv')) return 'text';
  if (lower.endsWith('.npz') || lower.endsWith('.zip')) return 'bundle';
  if (lower.endsWith('.json')) return 'json';
  return 'unknown';
}

export function isSimpleArrayFile(file) {
  const kind = fileKind(file);
  return kind === 'npy' || kind === 'text';
}

export function assertArrayFileKind(file, expectedKind) {
  if (!expectedKind || expectedKind === 'auto') return;

  const kind = fileKind(file);
  if (expectedKind === 'npy' && kind !== 'npy') {
    throw new Error('Choose a .npy file for the selected array type.');
  }
  if (expectedKind === 'text' && kind !== 'text') {
    throw new Error('Choose a .txt, .csv, or .tsv file for the selected array type.');
  }
}

export async function readText(file) {
  if (!file) throw new Error('No file selected.');
  return file.text();
}

export async function readJson(file) {
  try {
    return JSON.parse(await readText(file));
  } catch (error) {
    throw new Error(`Could not parse ${file?.name || 'JSON file'} as JSON.`);
  }
}

export function parseNumericText(text) {
  const rows = [];

  String(text || '').split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    const values = trimmed
      .split(/[\s,;]+/)
      .filter(Boolean)
      .map(Number);

    if (!values.length || values.some(value => !Number.isFinite(value))) {
      throw new Error('Text arrays must contain only numeric values.');
    }

    rows.push(values);
  });

  if (!rows.length) throw new Error('Text array is empty.');

  const width = rows[0].length;
  if (!rows.every(row => row.length === width)) {
    throw new Error('Text array rows must all have the same number of columns.');
  }

  return {
    data: rows.flat(),
    shape: width === 1 ? [rows.length] : [rows.length, width],
    dtype: 'float64',
    rows,
  };
}

export async function readSimpleArrayFile(file) {
  const kind = fileKind(file);

  if (kind === 'npy') {
    const parsed = await parseNpy(await file.arrayBuffer());
    return {
      ...parsed,
      rows: arrayRows(parsed.data, parsed.shape),
      kind,
    };
  }

  if (kind === 'text') {
    return {
      ...parseNumericText(await readText(file)),
      kind,
    };
  }

  throw new Error('Choose a .npy, .txt, .csv, or .tsv file for simple task data.');
}

export function arrayRows(data, shape = []) {
  const rows = Math.max(0, Math.floor(Number(shape[0]) || data.length || 0));
  const cols = Math.max(1, Math.floor(Number(shape[1]) || 1));
  const out = [];

  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      row.push(Number(data[r * cols + c]));
    }
    out.push(row);
  }

  return out;
}

export function downloadNumericText(rows, filename) {
  const text = rows
    .map(row => (Array.isArray(row) ? row : [row]).map(value => String(value)).join(' '))
    .join('\n');

  downloadBlob(`${text}\n`, filename, 'text/plain');
}

export function downloadSimpleNpy(data, shape, dtype, filename) {
  downloadNpy(data, shape, dtype, filename);
}

export function simpleArrayLength(array) {
  return Math.max(0, Math.floor(Number(array?.shape?.[0]) || array?.data?.length || 0));
}

export function parseVertexIndexList(array, vertexCount, { unique = true, sort = true } = {}) {
  const selected = [];
  let skipped = 0;
  const rows = array.rows || arrayRows(array.data, array.shape);

  rows.forEach(row => {
    const value = Number(row[0]);
    if (!Number.isInteger(value) || value < 0 || value >= vertexCount) {
      skipped += 1;
      return;
    }
    selected.push(value);
  });

  let indices = unique ? Array.from(new Set(selected)) : selected;
  if (sort) indices = indices.sort((a, b) => a - b);
  return { indices, skipped };
}

export function parseBooleanOrIndexMask(array, vertexCount) {
  const rows = array.rows || arrayRows(array.data, array.shape);
  const shape = array.shape || [];
  const flatLength = Number(shape[0]) || rows.length;
  const oneColumn = !shape[1] || shape[1] === 1;
  const looksDense = oneColumn && flatLength === vertexCount && rows.every(row => {
    const value = Number(row[0]);
    return value === 0 || value === 1;
  });

  if (looksDense) {
    const indices = [];
    rows.forEach((row, index) => {
      if (Number(row[0])) indices.push(index);
    });
    return { indices, skipped: 0, mode: 'boolean' };
  }

  return { ...parseVertexIndexList(array, vertexCount), mode: 'indices' };
}

export function parseMaskArrayBySchema(array, vertexCount, schema = 'auto') {
  if (schema === 'indices') {
    return { ...parseVertexIndexList(array, vertexCount), mode: 'indices' };
  }

  if (schema === 'dense') {
    const rows = array.rows || arrayRows(array.data, array.shape);
    const indices = [];
    let skipped = 0;

    rows.forEach((row, index) => {
      if (index >= vertexCount) {
        if (Number(row[0])) skipped += 1;
        return;
      }

      if (Number(row[0])) indices.push(index);
    });

    return { indices, skipped, mode: 'boolean' };
  }

  return parseBooleanOrIndexMask(array, vertexCount);
}

export function denseMaskFromIndices(vertexCount, selectedIndices) {
  const dense = new Uint8Array(vertexCount);
  const selected = Array.from(selectedIndices || [])
    .map(Number)
    .filter(index => Number.isInteger(index) && index >= 0 && index < vertexCount)
    .sort((a, b) => a - b);

  selected.forEach(index => {
    dense[index] = 1;
  });

  return { dense, selected };
}

export function arrayEntryByNames(arrays, names) {
  for (const name of names) {
    if (arrays.has(name)) return arrays.get(name);
  }

  return null;
}

export function arrayByName(arrays, name, prefix = 'landmarks') {
  return (
    arrays.get(name) ||
    arrays.get(`${prefix}/${name}`) ||
    arrays.get(name.replace(new RegExp(`^${prefix}/`), '')) ||
    null
  );
}

export function parseDenseLabelsOrPairs(array, vertexCount) {
  const rows = array.rows || arrayRows(array.data, array.shape);
  const cols = Math.max(1, Math.floor(Number(array.shape?.[1]) || (rows[0]?.length ?? 1)));
  const labels = new Int32Array(vertexCount);
  let skipped = 0;

  if (cols >= 2) {
    rows.forEach(row => {
      const vertexIndex = Number(row[0]);
      const label = Number(row[1]);
      if (!Number.isInteger(vertexIndex) || vertexIndex < 0 || vertexIndex >= vertexCount || !Number.isInteger(label)) {
        skipped += 1;
        return;
      }
      labels[vertexIndex] = label;
    });

    return { labels, skipped, mode: 'pairs' };
  }

  rows.forEach((row, vertexIndex) => {
    const label = Number(row[0]);
    if (vertexIndex >= vertexCount) {
      if (label !== 0) skipped += 1;
      return;
    }
    if (!Number.isInteger(label)) {
      skipped += 1;
      return;
    }
    labels[vertexIndex] = label;
  });

  return { labels, skipped, mode: 'dense' };
}

export function statusText(canUse, reason, readyText = 'Simple .npy/.txt I/O is available.') {
  return canUse ? readyText : reason;
}

export function openTaskDataDialog({ title, html, onMount }) {
  document.querySelector('.task-data-dialog-backdrop')?.remove();

  const host = document.getElementById('viewport') || document.body;
  const backdrop = document.createElement('div');
  backdrop.className = 'task-data-dialog-backdrop';
  backdrop.innerHTML = `
    <div class="task-data-dialog" role="dialog" aria-modal="true" aria-label="${escapeAttr(title)}">
      <div class="task-data-dialog-header">
        <h3>${escapeHtml(title)}</h3>
        <button type="button" class="btn btn-mini btn-icon task-data-dialog-close" aria-label="Close" title="Close">&times;</button>
      </div>
      <div class="task-data-dialog-body">${html}</div>
      <div class="task-data-dialog-message" data-task-data-message></div>
    </div>
  `;

  const close = () => {
    window.removeEventListener('keydown', onKeyDown, true);
    backdrop.remove();
  };
  const onKeyDown = event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };
  const setMessage = (message, type = 'info') => {
    const el = backdrop.querySelector('[data-task-data-message]');
    if (!el) return;
    el.textContent = message || '';
    el.dataset.type = type;
  };

  backdrop.addEventListener('click', event => {
    if (event.target === backdrop) close();
  });
  backdrop.querySelector('.task-data-dialog-close')?.addEventListener('click', close);
  window.addEventListener('keydown', onKeyDown, true);
  host.appendChild(backdrop);

  bindDialogFileNameLabels(backdrop);

  onMount?.(backdrop, { close, setMessage });
  refreshDialogSections(backdrop);

  const first = backdrop.querySelector('button, input, select, textarea');
  first?.focus?.({ preventScroll: true });

  return { close, root: backdrop, setMessage };
}

export function dialogFile(root, selector) {
  return root.querySelector(selector)?.files?.[0] || null;
}

export function dialogFiles(root, selector) {
  return Array.from(root.querySelector(selector)?.files || []).filter(Boolean);
}

export function checkedDialogValue(root, name) {
  return root.querySelector(`input[name="${name}"]:checked`)?.value || '';
}

export function setDialogRadioOptionDisabled(root, radioName, value, disabled, reason = '') {
  const input = root.querySelector(`input[name="${radioName}"][value="${value}"]`);
  if (!input) return;

  input.disabled = !!disabled;

  const label = input.closest('label');
  if (label) {
    label.classList.toggle('is-disabled', !!disabled);
    label.title = disabled ? reason : '';
  }

  if (disabled && input.checked) {
    const fallback = root.querySelector(`input[name="${radioName}"]:not(:disabled)`);
    if (fallback) fallback.checked = true;
  }
}

function isEffectivelyHidden(element) {
  if (!element || element.hidden) return true;
  if (element.classList?.contains('is-hidden')) return true;
  return false;
}

function refreshDialogSections(root) {
  root.querySelectorAll('.task-data-dialog-section').forEach(section => {
    const visibleContent = Array.from(section.children).some(child => {
      if (child.classList?.contains('task-data-dialog-section-title')) return false;
      if (isEffectivelyHidden(child)) return false;

      if (child.classList?.contains('task-data-dialog-grid')) {
        return Array.from(child.children).some(grandChild => !isEffectivelyHidden(grandChild));
      }

      return true;
    });

    section.hidden = !visibleContent;
  });
}

function bindDialogFileNameLabels(root) {
  root.querySelectorAll('input[type="file"]').forEach(input => {
    if (input.dataset.taskDataFileNameBound === 'true') return;
    input.dataset.taskDataFileNameBound = 'true';

    let wrapper = input.closest('.task-data-file-picker');
    let nameEl = wrapper?.querySelector('.task-data-file-name');

    if (!wrapper) {
      wrapper = document.createElement('div');
      wrapper.className = 'task-data-file-picker';

      const visibleModes = input.getAttribute('data-task-data-visible');
      if (visibleModes) {
        wrapper.setAttribute('data-task-data-visible', visibleModes);
        input.removeAttribute('data-task-data-visible');
      }

      input.parentNode?.insertBefore(wrapper, input);
      wrapper.appendChild(input);

      nameEl = document.createElement('span');
      nameEl.className = 'task-data-file-name';
      nameEl.setAttribute('aria-live', 'polite');
      wrapper.appendChild(nameEl);
    }

    const sync = () => {
      const files = Array.from(input.files || []);
      if (!nameEl) return;

      if (!files.length) {
        nameEl.textContent = '';
        nameEl.title = '';
        return;
      }

      const text = files.length === 1
        ? files[0].name
        : `${files[0].name} +${files.length - 1} more`;

      nameEl.textContent = text;
      nameEl.title = files.map(file => file.name).join('\n');
    };

    input.addEventListener('change', sync);
    sync();
  });
}

export function bindDialogModeVisibility(root, radioName) {
  const sync = () => {
    const mode = checkedDialogValue(root, radioName);

    root.querySelectorAll('[data-task-data-visible]').forEach(element => {
      const modes = String(element.getAttribute('data-task-data-visible') || '')
        .split(/\s+/)
        .filter(Boolean);

      element.hidden = !modes.includes(mode);
    });

    refreshDialogSections(root);
  };

  root.querySelectorAll(`input[name="${radioName}"]`).forEach(input => {
    input.addEventListener('change', sync);
  });

  sync();
}
