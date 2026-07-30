export function cloneMaskSelection(selection) {
  return new Set(selection || []);
}

export function combineMaskSelections(left, right, operation) {
  const a = left || new Set();
  const b = right || new Set();

  if (operation === 'union') {
    return new Set([...a, ...b]);
  }

  if (operation === 'intersection') {
    return new Set(Array.from(a).filter(index => b.has(index)));
  }

  if (operation === 'difference') {
    return new Set(Array.from(a).filter(index => !b.has(index)));
  }

  throw new Error(`Unsupported mask operation: ${operation}`);
}
