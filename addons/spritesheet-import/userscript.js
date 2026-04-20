import SpriteSheetDialog from "./SpriteSheetDialog.js";
import SpriteSheetImporter from "./SpriteSheetImporter.js";

export default async function ({ addon, msg, console }) {
  const vm = addon.tab.traps.vm;

  /**
   * Create the menu-item wrapper (button + hidden file input) for one menu.
   *
   * @param {string} id - Unique ID for this menu instance.
   * @param {boolean} isRight - True when the menu is on the right side (tooltip placement).
   * @returns {{ wrapper: Element, button: Element, input: HTMLInputElement }}
   */
  function createMenuItem(id, isRight) {
    const labelText = msg("menu-item");

    const wrapper = Object.assign(document.createElement("div"), {
      id: `sa-ss-wrap-${id}`,
    });

    const button = Object.assign(document.createElement("button"), {
      className: [
        addon.tab.scratchClass("action-menu_button"),
        addon.tab.scratchClass("action-menu_more-button"),
        "sa-ss-menu-btn",
      ].join(" "),
      currentitem: "false",
    });
    button.dataset.for = `sa-ss-tip-${id}`;
    button.dataset.tip = labelText;

    const icon = Object.assign(document.createElement("img"), {
      className: addon.tab.scratchClass("action-menu_more-icon"),
      draggable: false,
      src: `${addon.self.dir}/icon.svg`,
      height: "10",
      width: "10",
    });
    button.append(icon);

    const input = Object.assign(document.createElement("input"), {
      accept: ".png,.jpg,.jpeg,.bmp,.gif,.webp",
      className: addon.tab.scratchClass("action-menu_file-input"),
      type: "file",
    });
    button.append(input);

    // Tooltip element (mirrors better-img-uploads pattern)
    const tooltip = Object.assign(document.createElement("div"), {
      className: [
        "__react_component_tooltip",
        `place-${isRight ? "left" : "right"}`,
        "type-dark",
        addon.tab.scratchClass("action-menu_tooltip"),
        "sa-ss-tooltip",
      ].join(" "),
      id: `sa-ss-tip-${id}`,
      textContent: labelText,
    });
    tooltip.dataset.id = "tooltip";

    wrapper.append(button, tooltip);
    addon.tab.displayNoneWhileDisabled(wrapper);
    return { wrapper, button, input, tooltip };
  }

  /** Position the tooltip alongside its button (called on menu resize). */
  function positionTooltip(wrapper, tooltip, isRight) {
    const rect = wrapper.getBoundingClientRect();
    tooltip.style.top = `${rect.top + 2}px`;
    if (isRight) {
      tooltip.style.right = `${window.innerWidth - rect.right + rect.width + 10}px`;
      tooltip.style.left = "";
    } else {
      tooltip.style.left = `${rect.left + rect.width}px`;
      tooltip.style.right = "";
    }
  }

  /**
   * Handle a file chosen from the input — open the dialog and import tiles.
   *
   * @param {File} file
   * @param {string} targetId - The sprite target ID captured at the moment of file selection.
   */
  async function handleFile(file, targetId) {
    if (!file) return;

    const dialog = new SpriteSheetDialog(addon, msg);
    dialog.getCostumes = () => Array.from(vm.editingTarget?.sprite.costumes_ ?? []);
    dialog.onImport = async (spec) => {
      if (!spec) return;
      // Allow spec.tiles to be empty when replaceExisting is set — the importer
      // will delete all matching costumes and then skip the (empty) import loop.
      if (spec.tiles.length === 0 && !spec.replaceExisting) return;

      if (!vm.runtime.getTargetById(targetId)) {
        console.warn("spritesheet-import: target no longer exists, aborting import");
        return;
      }

      const img = new Image();
      img.src = URL.createObjectURL(file);
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
      });
      URL.revokeObjectURL(img.src);

      const importer = new SpriteSheetImporter(vm, targetId);
      try {
        await importer.import(img, spec);
      } catch (err) {
        console.error("spritesheet-import: import failed", err);
      }
    };

    const existingCostumes = Array.from(vm.editingTarget?.sprite.costumes_ ?? []);
    await dialog.open(file, existingCostumes);
  }

  // ─── Menu injection loop ────────────────────────────────────────────────────

  while (true) {
    // Wait for a costume-tab action-menu more-buttons container to appear.
    const costumeSelector =
      '[class*="gui_tabs_"] > :nth-child(3) [class*="action-menu_more-buttons_"]';
    const menu = await addon.tab.waitForElement(costumeSelector, {
      markAsSeen: true,
      reduxCondition: (state) => !state.scratchGui.mode.isPlayerOnly,
      reduxEvents: [
        "scratch-gui/mode/SET_PLAYER",
        "fontsLoaded/SET_FONTS_LOADED",
        "scratch-gui/locales/SELECT_LOCALE",
        "scratch-gui/navigation/ACTIVATE_TAB",
      ],
    });

    // Derive a stable ID from the main button's aria-label.
    const mainButton =
      menu.parentElement.previousElementSibling.previousElementSibling;
    const id = (mainButton.getAttribute("aria-label") ?? "costume").replace(/\s+/g, "_");
    const isRight = false; // Costume tab menu is on the left side of the screen.

    const { wrapper, button, input, tooltip } = createMenuItem(id, isRight);
    menu.prepend(wrapper);

    button.addEventListener("click", (e) => {
      e.stopPropagation();
      // Reset so the same file can be re-selected.
      input.value = "";
      input.click();
    });

    input.addEventListener("change", () => {
      const file = input.files?.[0];
      // Capture target ID at selection time to survive sprite-switching during the dialog.
      const targetId = vm.editingTarget?.id ?? "";
      if (file) handleFile(file, targetId);
    });

    // Keep tooltip positioned correctly as menu opens/closes/resizes.
    const observer = new MutationObserver(() =>
      positionTooltip(wrapper, tooltip, isRight)
    );
    observer.observe(menu, { attributes: true, subtree: true });
  }
}
