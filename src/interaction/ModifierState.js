function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export class ModifierState {
  constructor({ getViewport }) {
    this.getViewport = getViewport;
    this.reset();
  }

  reset() {
    this.x = 0;
    this.y = 0;
    this.hasPointerPosition = false;
    this.inViewport = false;
    this.alt = false;
    this.shift = false;
    this.ctrlOrMeta = false;
  }

  get hasModifier() {
    return this.alt || this.shift || this.ctrlOrMeta;
  }

  getViewportRect() {
    return this.getViewport()?.getBoundingClientRect?.() || null;
  }

  syncFromPointerEvent(event) {
    if (!event) return false;

    const rect = this.getViewportRect();
    if (!rect) return false;

    this.x = event.clientX - rect.left;
    this.y = event.clientY - rect.top;
    this.hasPointerPosition = true;
    this.inViewport = (
      this.x >= 0 &&
      this.y >= 0 &&
      this.x <= rect.width &&
      this.y <= rect.height
    );

    this.alt = !!event.altKey;
    this.shift = !!event.shiftKey;
    this.ctrlOrMeta = !!(event.ctrlKey || event.metaKey);

    return true;
  }

  syncFromKeyEvent(event, { allowHoverFallback = false } = {}) {
    if (!event) return false;

    const getModifier = (name, fallback) => (
      event.getModifierState ? event.getModifierState(name) : fallback
    );

    this.alt = getModifier('Alt', !!event.altKey);
    this.shift = getModifier('Shift', !!event.shiftKey);
    this.ctrlOrMeta = (
      getModifier('Control', !!event.ctrlKey) ||
      getModifier('Meta', !!event.metaKey)
    );

    if (event.key === 'Alt') this.alt = event.type === 'keydown';
    if (event.key === 'Shift') this.shift = event.type === 'keydown';
    if (event.key === 'Control' || event.key === 'Meta') {
      this.ctrlOrMeta = event.type === 'keydown';
    }

    this.refreshViewportPresence({ allowHoverFallback });
    return true;
  }

  refreshViewportPresence({ allowHoverFallback = false } = {}) {
    const viewport = this.getViewport?.();
    const rect = this.getViewportRect();
    if (!viewport || !rect) return;

    const insideStoredPoint = (
      this.hasPointerPosition &&
      this.x >= 0 &&
      this.y >= 0 &&
      this.x <= rect.width &&
      this.y <= rect.height
    );

    if (insideStoredPoint) {
      const element = document.elementFromPoint(rect.left + this.x, rect.top + this.y);
      this.inViewport = !!(element && viewport.contains(element));
    } else {
      this.inViewport = false;
    }

    if (!this.inViewport && allowHoverFallback && viewport.matches(':hover')) {
      this.x = this.hasPointerPosition
        ? clamp(this.x, 0, rect.width)
        : rect.width * 0.5;
      this.y = this.hasPointerPosition
        ? clamp(this.y, 0, rect.height)
        : rect.height * 0.5;
      this.hasPointerPosition = true;
      this.inViewport = true;
    }
  }

  markOutsideViewport() {
    this.inViewport = false;
  }
}
