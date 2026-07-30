export function hasUsefulModifier(event) {
  if (!event) return false;

  const modifier = (name, fallback) => (
    event.getModifierState ? event.getModifierState(name) : fallback
  );

  return !!(
    modifier('Alt', event.altKey)
    || modifier('Shift', event.shiftKey)
    || modifier('Control', event.ctrlKey)
    || modifier('Meta', event.metaKey)
  );
}

export class RecenterGestureGuard {
  constructor({ maxAgeMs = 1500, maxDistancePx = 24 } = {}) {
    this.maxAgeMs = maxAgeMs;
    this.maxDistanceSquared = maxDistancePx * maxDistancePx;
    this.pointerDowns = [];
  }

  recordPointerDown(event) {
    if (!event || event.button !== 0 || event.isPrimary === false) return;

    this.pointerDowns.push({
      timeStamp: Number(event.timeStamp) || 0,
      clientX: Number(event.clientX) || 0,
      clientY: Number(event.clientY) || 0,
      hasModifier: hasUsefulModifier(event),
    });

    if (this.pointerDowns.length > 2) {
      this.pointerDowns.splice(0, this.pointerDowns.length - 2);
    }
  }

  shouldBlockRecenter(event) {
    const timeStamp = Number(event?.timeStamp) || 0;
    const clientX = Number(event?.clientX) || 0;
    const clientY = Number(event?.clientY) || 0;

    const gestureUsedModifier = this.pointerDowns.some(pointer => {
      const age = timeStamp - pointer.timeStamp;
      const dx = clientX - pointer.clientX;
      const dy = clientY - pointer.clientY;
      return (
        age >= 0
        && age <= this.maxAgeMs
        && dx * dx + dy * dy <= this.maxDistanceSquared
        && pointer.hasModifier
      );
    });

    this.reset();
    return hasUsefulModifier(event) || gestureUsedModifier;
  }

  reset() {
    this.pointerDowns = [];
  }
}
