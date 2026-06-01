export function snapshotJsonEquals(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class HistoryStack {
  constructor({ limit = 100 } = {}) {
    this.limit = Math.max(1, Math.floor(limit) || 100);
    this.undoStack = [];
    this.redoStack = [];
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  record(snapshot) {
    if (snapshot === undefined) return false;

    this.undoStack.push(snapshot);

    if (this.undoStack.length > this.limit) {
      this.undoStack.shift();
    }

    this.redoStack.length = 0;
    return true;
  }

  undo(currentSnapshot, restoreSnapshot) {
    if (!this.canUndo) return false;

    const snapshot = this.undoStack.pop();
    this.redoStack.push(currentSnapshot);
    restoreSnapshot(snapshot);
    return true;
  }

  redo(currentSnapshot, restoreSnapshot) {
    if (!this.canRedo) return false;

    const snapshot = this.redoStack.pop();
    this.undoStack.push(currentSnapshot);
    restoreSnapshot(snapshot);
    return true;
  }

  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }

  commit({
    getSnapshot,
    mutate,
    equals = snapshotJsonEquals,
    onChanged = null,
    onUnchanged = null,
  }) {
    const before = getSnapshot();
    mutate();
    const after = getSnapshot();

    if (equals(before, after)) {
      onUnchanged?.(before, after);
      return false;
    }

    this.record(before);
    onChanged?.(before, after);
    return true;
  }
}
