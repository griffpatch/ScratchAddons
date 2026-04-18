/**
 * Secondary toolbar injected into the canvas container while the rig tool is active.
 * Floats above the canvas and contains Edit / Move mode buttons.
 */
export class RigSecondaryToolbar {
  constructor(container, msg, onModeChange) {
    this._el = null;
    this._editBtn = null;
    this._moveBtn = null;
    this._ikBtn = null;
    this._build(container, msg, onModeChange);
  }

  _build(container, msg, onModeChange) {
    this._el = document.createElement("div");
    this._el.className = "sa-rig-toolbar";

    this._editBtn = this._makeBtn(msg("edit-mode"), () => onModeChange("edit"));
    this._moveBtn = this._makeBtn(msg("move-mode"), () => onModeChange("move"));
    this._ikBtn = this._makeBtn(msg("ik-mode"), () => onModeChange("ik"));

    this._el.appendChild(this._editBtn);
    this._el.appendChild(this._moveBtn);
    this._el.appendChild(this._ikBtn);
    container.appendChild(this._el);
  }

  _makeBtn(label, handler) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.addEventListener("click", handler);
    return btn;
  }

  /** Highlight the button for the active mode ("edit" | "move" | "ik"). */
  setActive(mode) {
    this._editBtn?.classList.toggle("sa-rig-active", mode === "edit");
    this._moveBtn?.classList.toggle("sa-rig-active", mode === "move");
    this._ikBtn?.classList.toggle("sa-rig-active", mode === "ik");
  }

  destroy() {
    this._el?.remove();
    this._el = null;
  }
}
