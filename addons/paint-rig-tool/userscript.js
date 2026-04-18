import { RigTool } from "./rig-tool.js";

export default async function ({ addon, msg }) {
  addon.tab.redux.initialize();

  // If the Redux store wasn't created yet when initialize() ran (runAtComplete: false
  // timing), retry once the store becomes available so statechanged listeners fire.
  if (!addon.tab.redux.initialized) {
    (async () => {
      while (!window.__scratchAddonsRedux?.target) {
        await new Promise((r) => setTimeout(r, 50));
      }
      addon.tab.redux.initialize();
    })();
  }

  // ── Sidebar button ─────────────────────────────────────────────────────────
  // Follows the same pattern as paint-round-corners: classes are copied from
  // an existing toolbar button each time the mode-selector mounts so that
  // CSS hash-mangling is always handled automatically.
  let isSelectedClass = "";

  const btn = document.createElement("span");
  btn.setAttribute("role", "button");
  btn.title = msg("rig-tool");
  addon.tab.displayNoneWhileDisabled(btn);

  const icon = document.createElement("img");
  icon.alt = msg("rig-tool");
  icon.draggable = false;
  icon.src = `${addon.self.dir}/icons/rig-tool.svg`;
  btn.appendChild(icon);

  let rigTool = null;

  btn.addEventListener("click", () => {
    if (addon.self.disabled) return;
    // RigTool.activate() toggles off when already active.
    rigTool?.activate();
  });

  addon.self.addEventListener("disabled", () => rigTool?.deactivate());

  // ── Side-toolbar injection loop ─────────────────────────────────────────────
  // Runs once per costume-tab visit. Creates a fresh RigTool each time the
  // mode-selector mounts so canvas / container refs are always current.
  const toolsLoop = async () => {
    while (true) {
      const modeSelector = await addon.tab.waitForElement(
        "[class*='paint-editor_mode-selector_']",
        {
          markAsSeen: true,
          reduxCondition: (state) =>
            state.scratchGui.editorTab.activeTabIndex === 1 &&
            !state.scratchGui.mode.isPlayerOnly,
        }
      );

      // Deactivate any leftover session.
      if (rigTool?.isActive) rigTool.deactivate({ restoreMode: false });

      // Mirror native button/icon classes so the button blends into the toolbar.
      const anyBtn = modeSelector.querySelector("[class*='mod-tool-select']");
      const anyIcon = modeSelector.querySelector("[class*='tool-select-icon']");
      const selectedBtn = modeSelector.querySelector("[class*='is-selected']");
      if (anyBtn) btn.className = anyBtn.className;
      if (anyIcon) icon.className = anyIcon.className;
      isSelectedClass = selectedBtn
        ? ([...selectedBtn.classList].find((c) => c.includes("is-selected")) ?? "")
        : "";
      if (isSelectedClass) btn.classList.remove(isSelectedClass);

      const isBitmap = () => {
        const fmt = addon.tab.redux.state?.scratchPaint?.format ?? "";
        return fmt === "BITMAP" || fmt === "BITMAP_SKIP_CONVERT";
      };
      btn.style.display = isBitmap() ? "none" : "";

      rigTool = new RigTool({
        addon,
        msg,
        onActivate: () => {
          if (isSelectedClass) btn.classList.add(isSelectedClass);
        },
        onDeactivate: () => {
          if (isSelectedClass) btn.classList.remove(isSelectedClass);
        },
      });

      modeSelector.appendChild(btn);
    }
  };

  // Hide the button and kill an active session when switching to bitmap mode.
  addon.tab.redux.addEventListener("statechanged", ({ detail }) => {
    if (detail.action?.type !== "scratch-paint/formats/CHANGE_FORMAT") return;
    const fmt = detail.action.format ?? "";
    const bitmap = fmt === "BITMAP" || fmt === "BITMAP_SKIP_CONVERT";
    btn.style.display = bitmap ? "none" : "";
    if (bitmap && rigTool?.isActive) rigTool.deactivate();
  });

  toolsLoop();

  // Prime the getPaper() cache before waitForElement marks the mode-selector as
  // seen — after that point getPaper() would hang until the next DOM remount.
  addon.tab.traps.getPaper().catch(() => {});
}
