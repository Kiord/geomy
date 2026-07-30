import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RecenterGestureGuard,
  hasUsefulModifier,
} from '../src/interaction/RecenterGestureGuard.js';

function pointerEvent({
  timeStamp,
  clientX = 100,
  clientY = 100,
  altKey = false,
  shiftKey = false,
  ctrlKey = false,
  metaKey = false,
} = {}) {
  return {
    button: 0,
    isPrimary: true,
    timeStamp,
    clientX,
    clientY,
    altKey,
    shiftKey,
    ctrlKey,
    metaKey,
  };
}

test('an unmodified double-click may recenter', () => {
  const guard = new RecenterGestureGuard();
  guard.recordPointerDown(pointerEvent({ timeStamp: 100 }));
  guard.recordPointerDown(pointerEvent({ timeStamp: 200 }));

  assert.equal(guard.shouldBlockRecenter(pointerEvent({ timeStamp: 250 })), false);
});

test('a modifier used during either click blocks a later unmodified dblclick event', () => {
  const guard = new RecenterGestureGuard();
  guard.recordPointerDown(pointerEvent({ timeStamp: 100, altKey: true }));
  guard.recordPointerDown(pointerEvent({ timeStamp: 200 }));

  assert.equal(guard.shouldBlockRecenter(pointerEvent({ timeStamp: 250 })), true);
});

test('a modifier still pressed on dblclick blocks recentering', () => {
  const guard = new RecenterGestureGuard();
  guard.recordPointerDown(pointerEvent({ timeStamp: 100 }));
  guard.recordPointerDown(pointerEvent({ timeStamp: 200 }));

  assert.equal(
    guard.shouldBlockRecenter(pointerEvent({ timeStamp: 250, shiftKey: true })),
    true,
  );
});

test('stale or distant modified clicks do not block a new gesture', () => {
  const guard = new RecenterGestureGuard({ maxAgeMs: 500, maxDistancePx: 10 });
  guard.recordPointerDown(pointerEvent({ timeStamp: 100, altKey: true }));

  assert.equal(
    guard.shouldBlockRecenter(pointerEvent({ timeStamp: 800, clientX: 140 })),
    false,
  );
});

test('all task modifier keys count as useful modifiers', () => {
  assert.equal(hasUsefulModifier(pointerEvent({ altKey: true })), true);
  assert.equal(hasUsefulModifier(pointerEvent({ shiftKey: true })), true);
  assert.equal(hasUsefulModifier(pointerEvent({ ctrlKey: true })), true);
  assert.equal(hasUsefulModifier(pointerEvent({ metaKey: true })), true);
});
