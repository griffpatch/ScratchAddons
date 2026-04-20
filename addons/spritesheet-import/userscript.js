import SpriteSheetDialog from "./SpriteSheetDialog.js";
import SpriteSheetImporter from "./SpriteSheetImporter.js";

export default async function ({ addon, msg, console }) {
  const vm = addon.tab.traps.vm;

  /**
   * Create the menu-item wrapper (button + tooltip) for an action menu.
   *
   * @param {boolean} isRight - True when the menu is on the right side of the screen
   *   (sprite panel); the tooltip then appears to the left of the button.
   * @returns {{ wrapper: Element, button: Element, input: HTMLInputElement, tooltip: Element }}
   */
  function createMenuItem(isRight) {
    const labelText = msg("menu-item");

    const wrapper = document.createElement("div");

    const button = Object.assign(document.createElement("button"), {
      className: [
        addon.tab.scratchClass("action-menu_button"),
        addon.tab.scratchClass("action-menu_more-button"),
        "sa-ss-menu-btn",
      ].join(" "),
      currentitem: "false",
    });

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

    const tooltip = Object.assign(document.createElement("div"), {
      className: [
        "__react_component_tooltip",
        isRight ? "place-left" : "place-right",
        "type-dark",
        addon.tab.scratchClass("action-menu_tooltip"),
        "sa-ss-tooltip",
      ].join(" "),
      textContent: labelText,
    });

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
      tooltip.style.left = "auto";
    } else {
      tooltip.style.left = `${rect.left + rect.width}px`;
      tooltip.style.right = "auto";
    }
  }

  /**
   * Handle a file chosen from the input — open the dialog and import tiles.
   *
   * @param {File} file
   * @param {string} targetId - The sprite target ID captured at the moment of file selection.
   * @param {boolean} [removeBlankPlaceholder] - If true, delete the initial blank placeholder
   *   costume ("costume1") after a successful import, provided costumes remain.
   */
  async function handleFile(file, targetId, removeBlankPlaceholder = false) {
    if (!file) return;

    const dialog = new SpriteSheetDialog(addon, msg);
    dialog.getCostumes = () => Array.from(vm.editingTarget?.sprite.costumes_ ?? []);
    dialog.onImport = async (spec) => {
      if (!spec) return;
      // Allow spec.tiles to be empty when replaceExisting is set — the importer
      // will delete all matching costumes and then skip the (empty) import loop.
      if (spec.tiles.length === 0 && !spec.replaceExisting) return;

      const target = vm.runtime.getTargetById(targetId);
      if (!target) {
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
        return;
      }

      // After a successful import into a freshly created sprite, remove the
      // blank placeholder costume that vm.addSprite inserted, as long as at
      // least one imported costume remains.
      if (removeBlankPlaceholder) {
        const costumes = target.sprite.costumes_;
        const blankIdx = costumes.findIndex(
          (c) => c.assetId === "cd21514d0531fdffb22204e0ec5ed84a"
        );
        if (blankIdx !== -1 && costumes.length > 1) {
          target.deleteCostume(blankIdx);
        }
      }
    };

    const existingCostumes = Array.from(vm.editingTarget?.sprite.costumes_ ?? []);
    await dialog.open(file, existingCostumes);
  }

  // ─── Menu injection loop ────────────────────────────────────────────────────

  while (true) {
    // Wait for an action-menu more-buttons container to appear in either the
    // costume tab or the sprite panel.
    const menu = await addon.tab.waitForElement(
      [
        '[class*="sprite-selector_sprite-selector_"] [class*="action-menu_more-buttons_"]',
        '[class*="gui_tabs_"] > :nth-child(3) [class*="action-menu_more-buttons_"]',
      ].join(", "),
      {
        markAsSeen: true,
        reduxCondition: (state) => !state.scratchGui.mode.isPlayerOnly,
        reduxEvents: [
          "scratch-gui/mode/SET_PLAYER",
          "fontsLoaded/SET_FONTS_LOADED",
          "scratch-gui/locales/SELECT_LOCALE",
          "scratch-gui/navigation/ACTIVATE_TAB",
        ],
      }
    );

    // Sprite-panel menus sit on the right side; tooltip should appear to the left.
    const isRight = !!menu.closest('[class*="sprite-selector_sprite-selector_"]');

    const { wrapper, button, input, tooltip } = createMenuItem(isRight);
    menu.prepend(wrapper);

    button.addEventListener("click", (e) => {
      e.stopPropagation();
      // Reset so the same file can be re-selected.
      input.value = "";
      input.click();
    });

    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      if (isRight) {
        // Sprite-panel context: open the dialog immediately (no sprite exists yet).
        // The blank sprite is created lazily inside onImport so the user only waits
        // after they click the Import button, not while configuring the grid.
        // Pass an empty costume list — there are no existing costumes to compare against.
        const dialog = new SpriteSheetDialog(addon, msg);
        dialog.getCostumes = () => [];
        dialog.onImport = async (spec) => {
          if (!spec) return;
          if (spec.tiles.length === 0 && !spec.replaceExisting) return;

          const spriteName = spec.baseName || file.name.replace(/\.[^.]+$/, "");
          const blank = JSON.stringify({
            name: spriteName,
            isStage: false, x: 0, y: 0, visible: true, size: 100,
            rotationStyle: "all around", direction: 90, draggable: false,
            currentCostume: 0, blocks: {}, variables: {},
            costumes: [{
              name: "costume1",
              bitmapResolution: 1,
              rotationCenterX: 0, rotationCenterY: 0,
              assetId: "cd21514d0531fdffb22204e0ec5ed84a",
              dataFormat: "svg",
              md5ext: "cd21514d0531fdffb22204e0ec5ed84a.svg",
            }],
            sounds: [],
          });
          await vm.addSprite(blank).catch((err) => {
            console.error("spritesheet-import: failed to create sprite", err);
            throw err;
          });
          // Switch to the costume tab so the user can see the imported costumes.
          addon.tab.redux.dispatch({ type: "scratch-gui/navigation/ACTIVATE_TAB", activeTabIndex: 1 });

          const targetId = vm.editingTarget.id;
          const img = new Image();
          img.src = URL.createObjectURL(file);
          await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; });
          URL.revokeObjectURL(img.src);

          const importer = new SpriteSheetImporter(vm, targetId);
          try {
            await importer.import(img, spec);
          } catch (err) {
            console.error("spritesheet-import: import failed", err);
            return;
          }

          // Remove the blank placeholder costume inserted by vm.addSprite.
          const target = vm.runtime.getTargetById(targetId);
          if (target) {
            const costumes = target.sprite.costumes_;
            const blankIdx = costumes.findIndex(
              (c) => c.assetId === "cd21514d0531fdffb22204e0ec5ed84a"
            );
            if (blankIdx !== -1 && costumes.length > 1) {
              target.deleteCostume(blankIdx);
            }
          }
        };
        dialog.open(file, /* existingCostumes */ []);
      } else {
        // Costume-tab context: import into the currently editing sprite.
        // Capture target ID now to survive sprite-switching during the dialog.
        handleFile(file, vm.editingTarget?.id ?? "");
      }
    });
    const observer = new MutationObserver(() => positionTooltip(wrapper, tooltip, isRight));
    observer.observe(menu, { attributes: true, subtree: true });
    positionTooltip(wrapper, tooltip, isRight);
  }
}
