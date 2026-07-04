import { RigSecondaryToolbar } from "./rig-toolbar.js";
import { RigOverlay } from "./rig-overlay.js";
import { EditMode } from "./edit-mode.js";
import { MoveMode } from "./move-mode.js";
import { IKMode } from "./ik-mode.js";

/**
 * Orchestrates the rig tool session: acquires Paper.js, builds the overlay and
 * secondary toolbar, manages mode switching between Edit and Move, and tears
 * everything down on deactivation.
 *
 * One instance is created per toolsLoop iteration (each time the costumes tab
 * becomes visible). activate()/deactivate() may be called multiple times on the
 * same instance across button toggles within that session.
 */
export class RigTool {
  constructor({ addon, msg, onActivate, onDeactivate }) {
    this._addon = addon;
    this._msg = msg;
    this._onActivate = onActivate;
    this._onDeactivate = onDeactivate;
    this.isActive = false;
    this._paper = null;
    this._canvasContainer = null;
    this._canvas = null;
    this._toolbar = null;
    this._overlay = null;
    this._mode = null;
    this._reduxHandler = null;
    this._prevMode = null;
  }

  async activate() {
    // Toggle off if already active.
    if (this.isActive) {
      this.deactivate();
      return;
    }

    this._paper = await this._addon.tab.traps.getPaper();
    if (!this._paper) return;

    this._canvasContainer = document.querySelector("[class*='paint-editor_canvas-container_']");
    this._canvas = this._canvasContainer?.querySelector("canvas");
    if (!this._canvasContainer || !this._canvas) return;

    // Store the current paint mode so we can restore it on deactivation.
    this._prevMode = this._addon.tab.redux.state?.scratchPaint?.mode ?? null;

    // Dispatch ROUNDED_RECT: a registered-but-stub mode that deactivates the
    // current native tool without highlighting any sidebar button.
    this._addon.tab.redux.dispatch({
      type: "scratch-paint/modes/CHANGE_MODE",
      mode: "ROUNDED_RECT",
    });

    // Wait two frames for React to flush the dispatch.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (this._addon.self.disabled) return;

    this._overlay = new RigOverlay(this._canvasContainer, this._canvas, this._paper, this._addon);
    this._toolbar = new RigSecondaryToolbar(this._canvasContainer, this._msg, (mode) => this._setMode(mode));

    // Start in edit mode so the user can define pivot points first.
    this._setMode("edit");
    this.isActive = true;
    this._onActivate?.();

    // Deactivate if another paint mode is selected externally.
    this._reduxHandler = ({ detail }) => {
      if (!this.isActive) return;
      if (detail.action?.type === "scratch-paint/modes/CHANGE_MODE") {
        this.deactivate({ restoreMode: false });
      }
    };
    this._addon.tab.redux.addEventListener("statechanged", this._reduxHandler);
  }

  deactivate({ restoreMode = true } = {}) {
    if (!this.isActive) return;

    this._mode?.destroy();
    this._mode = null;
    this._toolbar?.destroy();
    this._toolbar = null;
    this._overlay?.destroy();
    this._overlay = null;

    if (this._reduxHandler) {
      this._addon.tab.redux.removeEventListener("statechanged", this._reduxHandler);
      this._reduxHandler = null;
    }

    this.isActive = false;
    this._onDeactivate?.();

    if (restoreMode) {
      const mode = this._prevMode ?? "SELECT";
      this._prevMode = null;
      this._addon.tab.redux.dispatch({ type: "scratch-paint/modes/CHANGE_MODE", mode });
    }
  }

  _setMode(modeName) {
    this._mode?.destroy();
    this._toolbar?.setActive(modeName);
    const opts = {
      addon: this._addon,
      paper: this._paper,
      overlay: this._overlay,
      onChanged: () => this._triggerUpdate(),
    };
    this._mode = modeName === "edit" ? new EditMode(opts) : modeName === "ik" ? new IKMode(opts) : new MoveMode(opts);
    this._mode.activate();
    this._overlay.render();
  }

  /**
   * Commit the current paper project state as a new undo snapshot.
   * Mirrors the pattern used by paint-round-corners and paint-boolean-ops.
   */
  _triggerUpdate() {
    const container = document.querySelector("[class*='paint-editor_canvas-container_']");
    if (!container) return;
    let fiber = container[this._addon.tab.traps.getInternalKey(container)];
    while (fiber && typeof fiber.stateNode?.handleUpdateImage !== "function") {
      fiber = fiber.return;
    }
    fiber?.stateNode?.handleUpdateImage?.();
  }
}
