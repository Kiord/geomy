export class CursorIndicator {
  constructor({
    getViewport,
    getCanvas,
    baseClassName,
    hiddenClassName = 'is-hidden',
    position = ({ x, y }) => `translate(${x}px, ${y}px)`,
  }) {
    this.getViewport = getViewport;
    this.getCanvas = getCanvas;
    this.baseClassName = baseClassName;
    this.hiddenClassName = hiddenClassName;
    this.position = position;
    this.element = null;
  }

  ensure() {
    const viewport = this.getViewport?.();
    if (!viewport) return null;

    if (this.element?.parentElement === viewport) {
      return this.element;
    }

    this.element?.remove?.();
    this.element = document.createElement('div');
    this.element.className = `${this.baseClassName} ${this.hiddenClassName}`;
    this.element.setAttribute('aria-hidden', 'true');
    viewport.appendChild(this.element);
    return this.element;
  }

  setCanvasCursor(cursor = '') {
    const canvas = this.getCanvas?.();
    if (canvas) canvas.style.cursor = cursor;
  }

  hide() {
    this.element?.classList.add(this.hiddenClassName);
    this.setCanvasCursor('');
  }

  update({ active, state, descriptor, offsetX = 0, offsetY = 0 }) {
    const element = this.ensure();

    if (!element) {
      this.setCanvasCursor('');
      return;
    }

    if (!active || !state?.inViewport || !descriptor) {
      this.hide();
      return;
    }

    this.setCanvasCursor(descriptor.cursor || '');
    element.innerHTML = descriptor.html || '';
    element.className = [this.baseClassName, descriptor.className]
      .filter(Boolean)
      .join(' ');
    element.style.transform = this.position({
      x: state.x + offsetX,
      y: state.y + offsetY,
      state,
      descriptor,
    });
  }

  reset({ remove = false } = {}) {
    this.setCanvasCursor('');

    if (!this.element) return;

    if (remove) {
      this.element.remove();
      this.element = null;
    } else {
      this.element.classList.add(this.hiddenClassName);
    }
  }
}
