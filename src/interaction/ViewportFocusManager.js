export class ViewportFocusManager {
  constructor({ getCanvas, getViewport }) {
    this.getCanvas = getCanvas;
    this.getViewport = getViewport;
    this.focus = this.focus.bind(this);
  }

  prepare() {
    const canvas = this.getCanvas?.();
    const viewport = this.getViewport?.();

    if (canvas) {
      canvas.setAttribute('tabindex', '0');
      canvas.style.outline = 'none';
    }

    if (viewport) {
      viewport.setAttribute('tabindex', '-1');
    }
  }

  focus() {
    const canvas = this.getCanvas?.();
    if (!canvas) return;

    if (!canvas.hasAttribute('tabindex')) {
      canvas.setAttribute('tabindex', '0');
    }

    canvas.style.outline = 'none';

    if (document.activeElement !== canvas) {
      canvas.focus({ preventScroll: true });
    }
  }
}
