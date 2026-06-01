export class ViewControlsSuppression {
  constructor({ getControls }) {
    this.getControls = getControls;
    this.suppressed = false;
    this.previousEnabled = true;
    this.controls = null;
  }

  update(shouldSuppress) {
    const controls = this.getControls?.();

    if (!controls || !shouldSuppress) {
      this.restore();
      return;
    }

    if (this.controls && this.controls !== controls) {
      this.controls.enabled = this.previousEnabled;
      this.suppressed = false;
      this.controls = null;
    }

    if (!this.suppressed) {
      this.controls = controls;
      this.previousEnabled = controls.enabled !== false;
      this.suppressed = true;
    }

    controls.enabled = false;
  }

  restore() {
    if (!this.suppressed) return;

    if (this.controls) {
      this.controls.enabled = this.previousEnabled;
    }

    this.suppressed = false;
    this.controls = null;
    this.previousEnabled = true;
  }
}
