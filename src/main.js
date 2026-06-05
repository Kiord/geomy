import './css/theme.css';
import './css/layout.css';
import './css/components.css';
import './css/recenterCursor.css';

import { app, initScene, initDragDrop, initThemeToggle, registerTask, switchTask } from './app.js';
import { raycast } from './util.js';
import { landmarkPickingTask } from './tasks/landmarkPicking.js';
import { meshMaskingTask } from './tasks/meshMasking.js';
import { meshSegmentationTask } from './tasks/meshSegmentation.js';
import { meshRigidAlignTask } from './tasks/meshRigidAlign.js';
import { inpectTask } from './tasks/inspect.js';
import { initVizPanel } from './panels/visualization.js';
import { initGeometryInspection } from './panels/geometryInspection.js';

function initSidePanelToggles() {
  const leftBtn = document.getElementById('toggle-task-panel');
  const rightBtn = document.getElementById('toggle-viz-panel');

  function syncButton(button, collapsed, side) {
    if (!button) return;

    const isLeft = side === 'left';
    const label = `${collapsed ? 'Expand' : 'Collapse'} ${side} panel`;

    button.textContent = isLeft
      ? (collapsed ? '›' : '‹')
      : (collapsed ? '‹' : '›');
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-expanded', String(!collapsed));
  }

  function setCollapsed(side, collapsed) {
    const className = side === 'left' ? 'panel-left-collapsed' : 'panel-right-collapsed';
    document.body.classList.toggle(className, collapsed);
    localStorage.setItem(`geomy-${side}-panel-collapsed`, collapsed ? '1' : '0');
    syncButton(side === 'left' ? leftBtn : rightBtn, collapsed, side);

    // Panels overlay the full-width viewport, so toggling them must not resize
    // the canvas or touch the camera. This keeps the rendered object fixed on screen.
  }

  const leftCollapsed = localStorage.getItem('geomy-left-panel-collapsed') === '1';
  const rightCollapsed = localStorage.getItem('geomy-right-panel-collapsed') === '1';

  setCollapsed('left', leftCollapsed);
  setCollapsed('right', rightCollapsed);

  leftBtn?.addEventListener('click', () => {
    setCollapsed('left', !document.body.classList.contains('panel-left-collapsed'));
  });

  rightBtn?.addEventListener('click', () => {
    setCollapsed('right', !document.body.classList.contains('panel-right-collapsed'));
  });
}

// ── Boot ──
function boot() {
  initScene();
  initDragDrop();
  initThemeToggle();
  initSidePanelToggles();

  registerTask(inpectTask);
  registerTask(landmarkPickingTask);
  registerTask(meshMaskingTask);
  registerTask(meshSegmentationTask);
  registerTask(meshRigidAlignTask);

  const viz = initVizPanel();
  const geo = initGeometryInspection();

  // Hook file-loaded to sync shared panels before the active task refreshes.
  function resetSharedPanelsForFile() {
    viz.reset();
    viz.onFileLoaded();
    geo.reset();
    geo.onFileLoaded();
  }

  function wrapTaskFileLoaded(task) {
    const originalLoaded = task.onFileLoaded;

    task.onFileLoaded = () => {
      resetSharedPanelsForFile();
      originalLoaded?.();
    };
  }

  [
    landmarkPickingTask,
    meshMaskingTask,
    meshSegmentationTask,
    meshRigidAlignTask,
    inpectTask,
  ].forEach(wrapTaskFileLoaded);

  //viewOnlyTask.onFileLoaded = resetSharedPanelsForFile;

  

  // Default task
  const taskSelect = document.getElementById('task-select');
  switchTask(taskSelect.value || 'landmark');
  taskSelect.addEventListener('change', () => switchTask(taskSelect.value));

  function ensureRecenterCursorIndicator() {
    const viewport = app.dom.viewport || document.getElementById('viewport');
    if (!viewport) return null;

    let indicator = document.getElementById('recenter-cursor-indicator');

    if (!indicator) {
      indicator = document.createElement('div');
      indicator.id = 'recenter-cursor-indicator';
      indicator.setAttribute('aria-hidden', 'true');
      viewport.appendChild(indicator);
    }

    return indicator;
  }

  function showRecenterCursorIndicator() {
    const viewport = app.dom.viewport || document.getElementById('viewport');
    const indicator = ensureRecenterCursorIndicator();

    if (!viewport || !indicator) return;

    indicator.style.left = `${viewport.clientWidth * 0.5}px`;
    indicator.style.top = `${viewport.clientHeight * 0.5}px`;

    indicator.classList.remove('is-visible');
    // Restart the CSS animation even for rapid repeated recenters.
    void indicator.offsetWidth;

    indicator.classList.add('is-visible');

    window.clearTimeout(showRecenterCursorIndicator._timer);
    showRecenterCursorIndicator._timer = window.setTimeout(() => {
      indicator.classList.remove('is-visible');
    }, 520);
  }

  // Global double-click → recenter
  app.renderer.domElement.addEventListener('dblclick', event => {
    if (app.task?.onDblClick) {
      const consumed = app.task.onDblClick(event);
      if (consumed) return;
    }

    const hits = raycast(event);

    if (hits.length > 0) {
      app.controls.target.copy(hits[0].point);
      app.controls.update();
      app.renderer.domElement.focus?.({ preventScroll: true });

      // Web pages cannot move the real OS cursor. This gives an immediate,
      // global center-cursor cue when the recenter operation succeeds while
      // leaving the native cursor visible.
      showRecenterCursorIndicator();
    }
  });

  // FPS counter
  const fpsCounter = document.getElementById('fps-counter');
  let fpsFrames = 0;
  let fpsLastTime = performance.now();

  // Render loop
  function animate(now = performance.now()) {
    requestAnimationFrame(animate);

    app.controls.update();
    app.renderer.render(app.scene, app.camera);

    // Update a few times per second instead of every frame to avoid flicker.
    fpsFrames++;
    const elapsed = now - fpsLastTime;

    if (elapsed >= 500) {
      const fps = Math.round((fpsFrames * 1000) / elapsed);

      if (fpsCounter) {
        fpsCounter.textContent = `${fps} FPS`;
      }

      fpsFrames = 0;
      fpsLastTime = now;
    }
  }

  animate();

  // Resize — use ResizeObserver for reliable post-layout sizing
  // Resize — keep camera, drawing buffer, and displayed canvas in sync.
  let lastW = 0;
  let lastH = 0;

  function onResize() {
    const vp = document.getElementById('viewport');
    if (!vp || !app.renderer || !app.camera) return;

    const rect = vp.getBoundingClientRect();
    const w = Math.floor(rect.width);
    const h = Math.floor(rect.height);

    if (w < 10 || h < 10) return;
    if (w === lastW && h === lastH) return;

    lastW = w;
    lastH = h;

    app.camera.aspect = w / h;
    app.camera.updateProjectionMatrix();

    app.renderer.setPixelRatio(window.devicePixelRatio);
    app.renderer.setSize(w, h, false);

    app.renderer.domElement.style.width = '100%';
    app.renderer.domElement.style.height = '100%';

    app.controls?.update?.();
  }

  // Actually observe the viewport, not just the window.
  const resizeObserver = new ResizeObserver(onResize);
  resizeObserver.observe(document.getElementById('viewport'));

  window.addEventListener('resize', onResize);
  requestAnimationFrame(onResize);
}

boot();
