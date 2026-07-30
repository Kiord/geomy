import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cloneMaskSelection,
  combineMaskSelections,
} from '../src/tasks/maskOperations.js';

function sorted(selection) {
  return Array.from(selection).sort((a, b) => a - b);
}

test('mask union selects vertices present in either input', () => {
  const left = new Set([1, 2, 4]);
  const right = new Set([2, 3, 5]);

  assert.deepEqual(sorted(combineMaskSelections(left, right, 'union')), [1, 2, 3, 4, 5]);
  assert.deepEqual(sorted(left), [1, 2, 4]);
  assert.deepEqual(sorted(right), [2, 3, 5]);
});

test('mask intersection selects only shared vertices', () => {
  assert.deepEqual(
    sorted(combineMaskSelections(new Set([1, 2, 4]), new Set([2, 3, 4]), 'intersection')),
    [2, 4],
  );
});

test('mask difference subtracts the right input from the left input', () => {
  assert.deepEqual(
    sorted(combineMaskSelections(new Set([1, 2, 4]), new Set([2, 3]), 'difference')),
    [1, 4],
  );
});

test('duplicating a selection creates an independent set', () => {
  const original = new Set([1, 3]);
  const duplicate = cloneMaskSelection(original);
  duplicate.add(5);

  assert.deepEqual(sorted(original), [1, 3]);
  assert.deepEqual(sorted(duplicate), [1, 3, 5]);
});
