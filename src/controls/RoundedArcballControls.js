import * as THREE from 'three';

const _changeEvent = { type: 'change' };
const _startEvent = { type: 'start' };
const _endEvent = { type: 'end' };

const _STATE = {
  NONE: -1,
  ROTATE: 0,
  DOLLY: 1,
  PAN: 2,
  TOUCH_ROTATE: 3,
  TOUCH_DOLLY_PAN: 4,
};

const _EPS = 1e-10;
const _twoPI = Math.PI * 2;

const _v = new THREE.Vector3();
const _offset = new THREE.Vector3();

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function smoothstep(t) {
  t = clamp(t, 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * RoundedArcballControls
 *
 * OrbitControls-like controls with absolute, path-invariant arcball rotation.
 *
 * Key behavior:
 * - Left drag: arcball orbit rotation.
 * - Wheel / right drag: dolly/zoom.
 * - Middle drag: pan.
 * - Shift/Ctrl/Meta + left drag: pan.
 * - Rotation preserves camera roll by rotating camera.up.
 * - Rotation is absolute from drag-start to current pointer position, so closed
 *   mouse paths do not accumulate roll.
 * - update() re-aims at target, so external target changes work.
 */
export class RoundedArcballControls extends THREE.EventDispatcher {
  constructor(object, domElement = null) {
    super();

    this.object = object;
    this.camera = object;
    this.domElement = domElement || document.body;

    // OrbitControls-like public API
    this.enabled = true;
    this.target = new THREE.Vector3();

    this.minDistance = 0.01;
    this.maxDistance = Infinity;
    this.minZoom = 0.01;
    this.maxZoom = Infinity;

    this.enableRotate = true;
    this.rotateSpeed = 1.0;

    this.enableZoom = true;
    this.zoomSpeed = 1.0;

    this.enablePan = true;
    this.panSpeed = 1.0;
    this.screenSpacePanning = true;

    // Kept for API compatibility. This implementation is intentionally
    // non-inertial/path-invariant, so damping is not applied to rotation.
    this.enableDamping = false;
    this.dampingFactor = 0.05;

    this.autoRotate = false;
    this.autoRotateSpeed = 2.0;

    // Arcball tuning
    this.arcballRadius = 0.95;

    // Keep false for stable model-viewer behavior.
    // true adds an outer roll region near the virtual ball edge.
    this.enableEdgeRoll = false;
    this.roundedArcballBorder = 0.25;

    this.invertX = false;
    this.invertY = false;


    Object.defineProperty(this, 'trackballRadius', {
      get: () => this.arcballRadius,
      set: value => {
        this.arcballRadius = value;
      },
    });

    this.mouseButtons = {
      LEFT: 0,
      MIDDLE: 1,
      RIGHT: 2,
    };

    this.keys = {
      LEFT: 'ArrowLeft',
      UP: 'ArrowUp',
      RIGHT: 'ArrowRight',
      BOTTOM: 'ArrowDown',
    };

    this.keyPanSpeed = 7.0;
    this.keyRotateSpeed = 1.0;

    // Saved reset state
    this.target0 = this.target.clone();
    this.position0 = this.object.position.clone();
    this.up0 = this.object.up.clone();
    this.zoom0 = this.object.zoom;

    // Internal interaction state
    this.state = _STATE.NONE;
    this._pointers = [];
    this._pointerPositions = new Map();

    this._rotateStart = new THREE.Vector2();
    this._rotateEnd = new THREE.Vector2();

    this._rotateStartVector = new THREE.Vector3();
    this._rotateStartOffset = new THREE.Vector3();
    this._rotateStartUp = new THREE.Vector3();

    this._rotateStartCameraQuat = new THREE.Quaternion();
    this._rotateStartCameraQuatInverse = new THREE.Quaternion();

    this._panStart = new THREE.Vector2();
    this._panEnd = new THREE.Vector2();
    this._panDelta = new THREE.Vector2();

    this._dollyStart = new THREE.Vector2();
    this._dollyEnd = new THREE.Vector2();
    this._dollyDelta = new THREE.Vector2();

    this._touchCenterStart = new THREE.Vector2();
    this._touchCenterEnd = new THREE.Vector2();

    this._spherical = new THREE.Spherical();

    this._lastPosition = new THREE.Vector3();
    this._lastQuaternion = new THREE.Quaternion();
    this._lastTarget = new THREE.Vector3();

    this._domElementKeyEvents = null;

    this._onContextMenu = this._onContextMenu.bind(this);
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onMouseWheel = this._onMouseWheel.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);

    this.connect(this.domElement);
    this.update();
  }

  connect(element) {
    this.domElement = element;

    this.domElement.addEventListener('contextmenu', this._onContextMenu);
    this.domElement.addEventListener('pointerdown', this._onPointerDown);
    this.domElement.addEventListener('pointercancel', this._onPointerUp);
    this.domElement.addEventListener('wheel', this._onMouseWheel, { passive: false });

    if (this.domElement.style) {
      this.domElement.style.touchAction = 'none';
    }
  }

  disconnect() {
    if (!this.domElement) return;

    this.domElement.removeEventListener('contextmenu', this._onContextMenu);
    this.domElement.removeEventListener('pointerdown', this._onPointerDown);
    this.domElement.removeEventListener('pointercancel', this._onPointerUp);
    this.domElement.removeEventListener('wheel', this._onMouseWheel);

    const doc = this.domElement.ownerDocument || document;
    doc.removeEventListener('pointermove', this._onPointerMove);
    doc.removeEventListener('pointerup', this._onPointerUp);

    this.stopListenToKeyEvents();

    if (this.domElement.style) {
      this.domElement.style.touchAction = '';
    }
  }

  dispose() {
    this.disconnect();
  }

  listenToKeyEvents(domElement) {
    domElement.addEventListener('keydown', this._onKeyDown);
    this._domElementKeyEvents = domElement;
  }

  stopListenToKeyEvents() {
    if (this._domElementKeyEvents !== null) {
      this._domElementKeyEvents.removeEventListener('keydown', this._onKeyDown);
      this._domElementKeyEvents = null;
    }
  }

  saveState() {
    this.target0.copy(this.target);
    this.position0.copy(this.object.position);
    this.up0.copy(this.object.up);
    this.zoom0 = this.object.zoom;
  }

  reset() {
    this.target.copy(this.target0);
    this.object.position.copy(this.position0);
    this.object.up.copy(this.up0);
    this.object.zoom = this.zoom0;

    this.object.updateProjectionMatrix?.();
    this._lookAtTarget();

    this.state = _STATE.NONE;

    this.dispatchEvent(_changeEvent);
    this.update();
  }

  getDistance() {
    return this.object.position.distanceTo(this.target);
  }

  getPolarAngle() {
    this._spherical.setFromVector3(
      _offset.subVectors(this.object.position, this.target)
    );
    return this._spherical.phi;
  }

  getAzimuthalAngle() {
    this._spherical.setFromVector3(
      _offset.subVectors(this.object.position, this.target)
    );
    return this._spherical.theta;
  }

  update(deltaTime = null) {
    if (!this.enabled) return false;

    // External target edits, e.g. double-click recenter, are handled here.
    this._lookAtTarget();

    if (this.autoRotate && this.state === _STATE.NONE) {
      const angle = this._getAutoRotationAngle(deltaTime);
      this._rotateAroundWorldAxis(this.object.up, angle);
    }

    const changed =
      this._lastPosition.distanceToSquared(this.object.position) > _EPS ||
      this._lastTarget.distanceToSquared(this.target) > _EPS ||
      8 * (1 - this._lastQuaternion.dot(this.object.quaternion)) > _EPS;

    if (changed) {
      this._lastPosition.copy(this.object.position);
      this._lastTarget.copy(this.target);
      this._lastQuaternion.copy(this.object.quaternion);
      this.dispatchEvent(_changeEvent);
    }

    return changed;
  }

  pan(deltaX, deltaY) {
    this._pan(deltaX, deltaY);
    this.update();
  }

  dollyIn(dollyScale = this._getZoomScale()) {
    this._dolly(dollyScale);
    this.update();
  }

  dollyOut(dollyScale = this._getZoomScale()) {
    this._dolly(1 / dollyScale);
    this.update();
  }

  rotateLeft(angle) {
    this._rotateAroundWorldAxis(this.object.up, angle);
    this.update();
  }

  rotateUp(angle) {
    const right = new THREE.Vector3()
      .setFromMatrixColumn(this.object.matrix, 0)
      .normalize();

    this._rotateAroundWorldAxis(right, angle);
    this.update();
  }

  // ─────────────────────────────────────────────────────────────
  // Arcball projection + absolute path-invariant rotation
  // ─────────────────────────────────────────────────────────────

  _projectToArcball(clientX, clientY) {
    const rect = this.domElement.getBoundingClientRect();

    const cx = rect.left + rect.width * 0.5;
    const cy = rect.top + rect.height * 0.5;

    // Use min dimension so the ball stays circular in wide viewports.
    const radiusPx = Math.max(
      1,
      Math.min(rect.width, rect.height) * 0.5 * Math.max(_EPS, this.arcballRadius)
    );

    let x = (clientX - cx) / radiusPx;
    let y = -(clientY - cy) / radiusPx;

    if (this.invertX) x = -x;
    if (this.invertY) y = -y;

    const r2 = x * x + y * y;
    let z;

    if (!this.enableEdgeRoll) {
      // Smooth virtual trackball projection:
      // inside sphere, outside hyperbolic sheet.
      // This avoids a hard z=0 edge discontinuity.
      if (r2 <= 0.5) {
        z = Math.sqrt(Math.max(0, 1 - r2));
      } else {
        z = 0.5 / Math.sqrt(r2);
      }
    } else {
      // Optional rounded edge-roll mode:
      // sphere center -> smooth transition -> outer z=0 roll plane.
      const r = Math.sqrt(r2);
      const border = clamp(this.roundedArcballBorder, 0.001, 0.95);
      const inner = 1 - border;

      if (r <= inner) {
        z = Math.sqrt(Math.max(0, 1 - r * r));
      } else if (r < 1) {
        const zInner = Math.sqrt(Math.max(0, 1 - inner * inner));
        const t = (r - inner) / border;
        z = zInner * (1 - smoothstep(t));
      } else {
        z = 0;
      }
    }

    return new THREE.Vector3(x, y, z).normalize();
  }

  _beginRotate(clientX, clientY) {
    this._lookAtTarget();

    this._rotateStart.set(clientX, clientY);
    this._rotateEnd.copy(this._rotateStart);

    this._rotateStartVector.copy(
      this._projectToArcball(clientX, clientY)
    );

    this._rotateStartOffset.subVectors(this.object.position, this.target);
    this._rotateStartUp.copy(this.object.up).normalize();

    // Arcball vectors are in screen/camera space.
    // Capture the starting camera frame so the absolute view-space rotation can
    // be converted to world-space consistently for the entire drag.
    this._rotateStartCameraQuat.copy(this.object.quaternion).normalize();
    this._rotateStartCameraQuatInverse
      .copy(this._rotateStartCameraQuat)
      .invert();
  }

  _rotateAbsolute(clientX, clientY) {
    this._rotateEnd.set(clientX, clientY);

    const dx = this._rotateEnd.x - this._rotateStart.x;
    const dy = this._rotateEnd.y - this._rotateStart.y;

    if (dx * dx + dy * dy < _EPS) {
      this.object.position.copy(this.target).add(this._rotateStartOffset);
      this.object.up.copy(this._rotateStartUp);
      this._lookAtTarget();
      return;
    }

    const currentVector = this._projectToArcball(clientX, clientY);

    // Use current -> start for OrbitControls-like feel:
    // drag right makes the object appear to turn right.
    const viewQ = new THREE.Quaternion().setFromUnitVectors(
      currentVector,
      this._rotateStartVector
    );

    const scaledViewQ = this._scaleQuaternion(viewQ, this.rotateSpeed * 2);

    // Convert view/camera-space rotation into world-space rotation:
    // worldQ = cameraStartQ * viewQ * inverse(cameraStartQ)
    const worldQ = this._rotateStartCameraQuat
      .clone()
      .multiply(scaledViewQ)
      .multiply(this._rotateStartCameraQuatInverse);

    const newOffset = this._rotateStartOffset
      .clone()
      .applyQuaternion(worldQ);

    const newUp = this._rotateStartUp
      .clone()
      .applyQuaternion(worldQ)
      .normalize();

    this.object.position.copy(this.target).add(newOffset);
    this.object.up.copy(newUp);

    this._lookAtTarget();
  }

  _scaleQuaternion(q, scale) {
    if (Math.abs(scale - 1) < _EPS) return q.clone().normalize();
    if (Math.abs(scale) < _EPS) return new THREE.Quaternion();

    const out = q.clone().normalize();

    // Keep shortest representation.
    if (out.w < 0) {
      out.x *= -1;
      out.y *= -1;
      out.z *= -1;
      out.w *= -1;
    }

    const w = clamp(out.w, -1, 1);
    const angle = 2 * Math.acos(w);
    const s = Math.sqrt(Math.max(0, 1 - w * w));

    if (s < _EPS || Math.abs(angle) < _EPS) {
      return new THREE.Quaternion();
    }

    const axis = new THREE.Vector3(out.x / s, out.y / s, out.z / s);
    return new THREE.Quaternion().setFromAxisAngle(axis, angle * scale);
  }

  _rotateAroundWorldAxis(axis, angle) {
    const q = new THREE.Quaternion().setFromAxisAngle(axis, angle);

    _offset.subVectors(this.object.position, this.target);
    _offset.applyQuaternion(q);

    this.object.position.copy(this.target).add(_offset);
    this.object.up.applyQuaternion(q).normalize();

    this._lookAtTarget();
  }

  _lookAtTarget() {
    this.object.lookAt(this.target);
    this.object.updateMatrix?.();
    this.object.updateMatrixWorld?.();
  }

  // ─────────────────────────────────────────────────────────────
  // Pan / dolly
  // ─────────────────────────────────────────────────────────────

  _pan(deltaX, deltaY) {
    this._lookAtTarget();

    const element = this.domElement;
    const panOffset = new THREE.Vector3();

    _offset.subVectors(this.object.position, this.target);

    if (this.object.isPerspectiveCamera) {
      const targetDistance =
        _offset.length() * Math.tan((this.object.fov / 2) * Math.PI / 180);

      this._panLeft(
        2 * deltaX * targetDistance / element.clientHeight,
        panOffset
      );

      this._panUp(
        2 * deltaY * targetDistance / element.clientHeight,
        panOffset
      );
    } else if (this.object.isOrthographicCamera) {
      this._panLeft(
        deltaX *
          (this.object.right - this.object.left) /
          this.object.zoom /
          element.clientWidth,
        panOffset
      );

      this._panUp(
        deltaY *
          (this.object.top - this.object.bottom) /
          this.object.zoom /
          element.clientHeight,
        panOffset
      );
    } else {
      console.warn('RoundedArcballControls: unsupported camera type for panning.');
      return;
    }

    panOffset.multiplyScalar(this.panSpeed);

    this.object.position.add(panOffset);
    this.target.add(panOffset);

    this._lookAtTarget();
  }

  _panLeft(distance, target) {
    _v.setFromMatrixColumn(this.object.matrix, 0);
    _v.multiplyScalar(-distance);
    target.add(_v);
  }

  _panUp(distance, target) {
    if (this.screenSpacePanning) {
      _v.setFromMatrixColumn(this.object.matrix, 1);
    } else {
      _v.setFromMatrixColumn(this.object.matrix, 0);
      _v.crossVectors(this.object.up, _v);
    }

    _v.multiplyScalar(distance);
    target.add(_v);
  }

  _dolly(scale) {
    if (this.object.isPerspectiveCamera) {
      _offset.subVectors(this.object.position, this.target);

      const distance = clamp(
        _offset.length() * scale,
        this.minDistance,
        this.maxDistance
      );

      _offset.normalize().multiplyScalar(distance);
      this.object.position.copy(this.target).add(_offset);

      this._lookAtTarget();
    } else if (this.object.isOrthographicCamera) {
      this.object.zoom = clamp(
        this.object.zoom / scale,
        this.minZoom,
        this.maxZoom
      );

      this.object.updateProjectionMatrix();
      this._lookAtTarget();
    } else {
      console.warn('RoundedArcballControls: unsupported camera type for dolly/zoom.');
    }
  }

  _getZoomScale() {
    return Math.pow(0.95, this.zoomSpeed);
  }

  _getAutoRotationAngle(deltaTime) {
    if (deltaTime !== null) {
      return (_twoPI / 60 * this.autoRotateSpeed) * deltaTime;
    }

    return _twoPI / 60 / 60 * this.autoRotateSpeed;
  }

  // ─────────────────────────────────────────────────────────────
  // Events
  // ─────────────────────────────────────────────────────────────

  _onContextMenu(event) {
    if (!this.enabled) return;
    event.preventDefault();
  }

  _onPointerDown(event) {
    if (!this.enabled) return;

    if (this.domElement.setPointerCapture) {
      try {
        this.domElement.setPointerCapture(event.pointerId);
      } catch (_) {
        // Ignore.
      }
    }

    this._addPointer(event);

    const doc = this.domElement.ownerDocument || document;
    doc.addEventListener('pointermove', this._onPointerMove);
    doc.addEventListener('pointerup', this._onPointerUp);

    if (event.pointerType === 'touch') {
      this._handleTouchStart(event);
    } else {
      this._handleMouseDown(event);
    }
  }

  _handleMouseDown(event) {
    let state = _STATE.NONE;

    if (event.button === this.mouseButtons.LEFT) {
      state =
        event.ctrlKey || event.metaKey || event.shiftKey
          ? _STATE.PAN
          : _STATE.ROTATE;
    } else if (event.button === this.mouseButtons.MIDDLE) {
      state = _STATE.PAN;
    } else if (event.button === this.mouseButtons.RIGHT) {
      state = _STATE.DOLLY;
    }

    if (state === _STATE.ROTATE && !this.enableRotate) return;
    if (state === _STATE.DOLLY && !this.enableZoom) return;
    if (state === _STATE.PAN && !this.enablePan) return;

    event.preventDefault();

    this.state = state;

    if (state === _STATE.ROTATE) {
      this._beginRotate(event.clientX, event.clientY);
    } else if (state === _STATE.DOLLY) {
      this._dollyStart.set(event.clientX, event.clientY);
    } else if (state === _STATE.PAN) {
      this._panStart.set(event.clientX, event.clientY);
    }

    if (state !== _STATE.NONE) {
      this.dispatchEvent(_startEvent);
    }
  }

  _handleTouchStart(event) {
    event.preventDefault();

    if (this._pointers.length === 1) {
      if (!this.enableRotate) return;

      this.state = _STATE.TOUCH_ROTATE;
      this._beginRotate(event.clientX, event.clientY);
      this.dispatchEvent(_startEvent);
    } else if (this._pointers.length === 2) {
      if (!this.enableZoom && !this.enablePan) return;

      this.state = _STATE.TOUCH_DOLLY_PAN;

      const p0 = this._pointerPositions.get(this._pointers[0].pointerId);
      const p1 = this._pointerPositions.get(this._pointers[1].pointerId);

      if (!p0 || !p1) return;

      const dx = p0.x - p1.x;
      const dy = p0.y - p1.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      this._dollyStart.set(0, distance);
      this._touchCenterStart.set((p0.x + p1.x) * 0.5, (p0.y + p1.y) * 0.5);
      this._panStart.copy(this._touchCenterStart);
    }
  }

  _onPointerMove(event) {
    if (!this.enabled) return;
    if (!this._pointerPositions.has(event.pointerId)) return;

    this._trackPointer(event);

    if (event.pointerType === 'touch') {
      this._handleTouchMove(event);
    } else {
      this._handleMouseMove(event);
    }
  }

  _handleMouseMove(event) {
    event.preventDefault();

    switch (this.state) {
      case _STATE.ROTATE:
        if (!this.enableRotate) return;

        this._rotateAbsolute(event.clientX, event.clientY);
        this.update();
        break;

      case _STATE.DOLLY:
        if (!this.enableZoom) return;

        this._dollyEnd.set(event.clientX, event.clientY);
        this._dollyDelta.subVectors(this._dollyEnd, this._dollyStart);

        if (this._dollyDelta.y > 0) {
          this._dolly(1 / this._getZoomScale());
        } else if (this._dollyDelta.y < 0) {
          this._dolly(this._getZoomScale());
        }

        this._dollyStart.copy(this._dollyEnd);
        this.update();
        break;

      case _STATE.PAN:
        if (!this.enablePan) return;

        this._panEnd.set(event.clientX, event.clientY);
        this._panDelta.subVectors(this._panEnd, this._panStart);

        this._pan(this._panDelta.x, this._panDelta.y);
        this._panStart.copy(this._panEnd);
        this.update();
        break;

      default:
        break;
    }
  }

  _handleTouchMove(event) {
    event.preventDefault();

    if (this._pointers.length === 1 && this.state === _STATE.TOUCH_ROTATE) {
      if (!this.enableRotate) return;

      const pointer = this._pointerPositions.get(this._pointers[0].pointerId);
      if (!pointer) return;

      this._rotateAbsolute(pointer.x, pointer.y);
      this.update();

      return;
    }

    if (this._pointers.length === 2 && this.state === _STATE.TOUCH_DOLLY_PAN) {
      const p0 = this._pointerPositions.get(this._pointers[0].pointerId);
      const p1 = this._pointerPositions.get(this._pointers[1].pointerId);

      if (!p0 || !p1) return;

      const dx = p0.x - p1.x;
      const dy = p0.y - p1.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      this._dollyEnd.set(0, distance);

      if (this.enableZoom) {
        const dollyScale = this._dollyStart.y / Math.max(_EPS, this._dollyEnd.y);
        this._dolly(dollyScale);
        this._dollyStart.copy(this._dollyEnd);
      }

      this._touchCenterEnd.set((p0.x + p1.x) * 0.5, (p0.y + p1.y) * 0.5);

      if (this.enablePan) {
        this._panDelta.subVectors(this._touchCenterEnd, this._panStart);
        this._pan(this._panDelta.x, this._panDelta.y);
        this._panStart.copy(this._touchCenterEnd);
      }

      this.update();
    }
  }

  _onPointerUp(event) {
    this._removePointer(event);

    if (this.domElement.releasePointerCapture) {
      try {
        this.domElement.releasePointerCapture(event.pointerId);
      } catch (_) {
        // Ignore.
      }
    }

    if (this._pointers.length === 0) {
      const doc = this.domElement.ownerDocument || document;
      doc.removeEventListener('pointermove', this._onPointerMove);
      doc.removeEventListener('pointerup', this._onPointerUp);

      if (this.state !== _STATE.NONE) {
        this.dispatchEvent(_endEvent);
      }

      this.state = _STATE.NONE;
    } else if (event.pointerType === 'touch' && this._pointers.length === 1) {
      const pointer = this._pointerPositions.get(this._pointers[0].pointerId);

      if (pointer && this.enableRotate) {
        this.state = _STATE.TOUCH_ROTATE;
        this._beginRotate(pointer.x, pointer.y);
      }
    }
  }

  _onMouseWheel(event) {
    if (!this.enabled || !this.enableZoom || this.state !== _STATE.NONE) return;

    event.preventDefault();
    event.stopPropagation();

    this.dispatchEvent(_startEvent);
    if (event.deltaY < 0) {
      this._dolly(this._getZoomScale());
    } else if (event.deltaY > 0) {
      this._dolly(1 / this._getZoomScale());
    }
    this.update();
    this.dispatchEvent(_endEvent);
  }

  _onKeyDown(event) {
    if (!this.enabled) return;

    let needsUpdate = false;

    switch (event.code) {
      case this.keys.UP:
        if (event.ctrlKey || event.metaKey || event.shiftKey) {
          this.rotateUp(this.keyRotateSpeed * Math.PI / 180);
        } else if (this.enablePan) {
          this._pan(0, this.keyPanSpeed);
        }

        needsUpdate = true;
        break;

      case this.keys.BOTTOM:
        if (event.ctrlKey || event.metaKey || event.shiftKey) {
          this.rotateUp(-this.keyRotateSpeed * Math.PI / 180);
        } else if (this.enablePan) {
          this._pan(0, -this.keyPanSpeed);
        }

        needsUpdate = true;
        break;

      case this.keys.LEFT:
        if (event.ctrlKey || event.metaKey || event.shiftKey) {
          this.rotateLeft(this.keyRotateSpeed * Math.PI / 180);
        } else if (this.enablePan) {
          this._pan(this.keyPanSpeed, 0);
        }

        needsUpdate = true;
        break;

      case this.keys.RIGHT:
        if (event.ctrlKey || event.metaKey || event.shiftKey) {
          this.rotateLeft(-this.keyRotateSpeed * Math.PI / 180);
        } else if (this.enablePan) {
          this._pan(-this.keyPanSpeed, 0);
        }

        needsUpdate = true;
        break;

      default:
        break;
    }

    if (needsUpdate) {
      event.preventDefault();
      this.update();
    }
  }

  _addPointer(event) {
    this._pointers.push(event);
    this._trackPointer(event);
  }

  _removePointer(event) {
    this._pointerPositions.delete(event.pointerId);

    for (let i = 0; i < this._pointers.length; i++) {
      if (this._pointers[i].pointerId === event.pointerId) {
        this._pointers.splice(i, 1);
        return;
      }
    }
  }

  _trackPointer(event) {
    this._pointerPositions.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
  }
}

export { RoundedArcballControls as RoundedArcBallControls };