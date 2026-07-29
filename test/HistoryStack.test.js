import assert from 'node:assert/strict';
import test from 'node:test';

import { HistoryStack, snapshotJsonEquals } from '../src/core/HistoryStack.js';

test('a new history stack cannot undo or redo', () => {
  const history = new HistoryStack();

  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, false);
  assert.equal(history.undo({}, () => {}), false);
  assert.equal(history.redo({}, () => {}), false);
});

test('undo and redo restore snapshots in order', () => {
  const history = new HistoryStack();
  let state = { value: 1 };
  const restore = snapshot => {
    state = snapshot;
  };

  history.record({ value: 0 });
  assert.equal(history.undo(state, restore), true);
  assert.deepEqual(state, { value: 0 });
  assert.equal(history.canRedo, true);

  assert.equal(history.redo(state, restore), true);
  assert.deepEqual(state, { value: 1 });
  assert.equal(history.canRedo, false);
});

test('recording a new snapshot after undo clears redo history', () => {
  const history = new HistoryStack();
  let state = { value: 1 };

  history.record({ value: 0 });
  history.undo(state, snapshot => {
    state = snapshot;
  });
  assert.equal(history.canRedo, true);

  history.record(state);
  assert.equal(history.canRedo, false);
});

test('the history limit discards the oldest snapshots', () => {
  const history = new HistoryStack({ limit: 2 });
  const restored = [];

  history.record({ value: 0 });
  history.record({ value: 1 });
  history.record({ value: 2 });

  history.undo({ value: 3 }, snapshot => restored.push(snapshot.value));
  history.undo({ value: 2 }, snapshot => restored.push(snapshot.value));

  assert.deepEqual(restored, [2, 1]);
  assert.equal(history.canUndo, false);
});

test('commit records changed state and ignores unchanged state', () => {
  const history = new HistoryStack();
  let state = { value: 0 };

  const unchanged = history.commit({
    getSnapshot: () => ({ ...state }),
    mutate: () => {},
  });
  assert.equal(unchanged, false);
  assert.equal(history.canUndo, false);

  const changed = history.commit({
    getSnapshot: () => ({ ...state }),
    mutate: () => {
      state.value = 1;
    },
  });
  assert.equal(changed, true);
  assert.equal(history.canUndo, true);
});

test('snapshotJsonEquals compares JSON-compatible snapshots structurally', () => {
  assert.equal(snapshotJsonEquals({ a: 1, b: [2] }, { a: 1, b: [2] }), true);
  assert.equal(snapshotJsonEquals({ a: 1 }, { a: 2 }), false);
});
