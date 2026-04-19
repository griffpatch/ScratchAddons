import BlockItem from "./blockly/BlockItem.js";
import BlockInstance from "./blockly/BlockInstance.js";
import Utils from "./blockly/Utils.js";
import { getTopBlocks } from "../../libraries/common/cs/devtools-utils.js";
import * as BlockTypes from "./blockTypes.js";

/**
 * Find Bar addon for Scratch editor that provides search functionality for blocks, variables,
 * broadcasts, procedures, costumes, and sounds. Supports navigation through search results
 * with keyboard shortcuts and visual carousel controls.
 *
 * Features:
 * - Search across current sprite or all sprites
 * - Keyboard shortcuts (Ctrl+F to open, Arrow keys to navigate)
 * - Visual carousel for navigating multiple instances
 * - Middle-click or Shift+click on blocks to explore related items
 * - Dropdown with categorized results and usage counts
 * - Real-time filtering as you type
 *
 * @param {import("../../addon-api/content-script/typedef").UserscriptUtilities} options - Userscript utilities object
 * @returns {Promise<void>} Resolves when the find bar is initialized and ready
 */
export default async function ({ addon, msg, console }) {
  const Blockly = await addon.tab.traps.getBlockly();

  // When "explore blocks" is enabled, disable jump-to-definition
  Object.defineProperty(Blockly.Gesture.prototype, "exploreBlocks", {
    get() {
      return !addon.self.disabled;
    },
  });

  class FindBar {
    constructor() {
      this.utils = new Utils(addon);

      this.prevValue = "";

      this.findBarOuter = null;
      this.findWrapper = null;
      this.findInput = null;
      this.allSpritesCheckbox = null;
      this.dropdownOut = null;
      this.navControls = null;
      this.clearButton = null;
      this.dropdown = new Dropdown(this.utils, this);

      document.addEventListener("keydown", (e) => this.eventKeyDown(e), true);
    }

    get workspace() {
      return addon.tab.traps.getWorkspace();
    }

    createDom(root) {
      this.findBarOuter = document.createElement("div");
      this.findBarOuter.className = "sa-find-bar";
      addon.tab.displayNoneWhileDisabled(this.findBarOuter);
      root.appendChild(this.findBarOuter);

      this.findWrapper = this.findBarOuter.appendChild(document.createElement("span"));
      this.findWrapper.className = "sa-find-wrapper";

      this.dropdownOut = this.findWrapper.appendChild(document.createElement("label"));
      this.dropdownOut.className = "sa-find-dropdown-out";

      let inputWrap = this.dropdownOut.appendChild(document.createElement("div"));
      inputWrap.className = "sa-find-input-wrap";

      this.findInput = inputWrap.appendChild(document.createElement("input"));
      this.findInput.className = addon.tab.scratchClass("input_input-form", {
        others: "sa-find-input",
      });
      // for <label>
      this.findInput.id = "sa-find-input";
      this.findInput.type = "search";
      this.findInput.placeholder = msg("find-placeholder");
      this.findInput.autocomplete = "off";
      this.currentSearchValue = ""; // Track search value for text block filtering

      // Create the "all sprites" checkbox
      this.allSpritesCheckbox = inputWrap.appendChild(document.createElement("input"));
      this.allSpritesCheckbox.type = "checkbox";
      this.allSpritesCheckbox.className = "sa-find-all-sprites-checkbox";
      this.allSpritesCheckbox.checked = true; // Enabled by default
      this.allSpritesCheckbox.title = msg("all-sprites-tooltip");
      this.allSpritesCheckbox.addEventListener("mousedown", (e) => {
        // Prevent the default behavior that would blur the input
        e.preventDefault();
        e.stopPropagation();
      });
      this.allSpritesCheckbox.addEventListener("click", (e) => {
        e.stopPropagation();
      });
      this.allSpritesCheckbox.addEventListener("change", (e) => {
        const wasVisible = this.dropdownOut.classList.contains("visible");

        // Save carousel state first (before it gets cleared)
        const hadCarousel = this.navControls.style.display === "inline-block";
        const currentBlockInstance =
          hadCarousel && this.dropdown.carousel.blocks.length > 0
            ? this.dropdown.carousel.blocks[this.dropdown.carousel.idx]
            : null;

        // Save the currently selected carousel item info (from the carousel, not dropdown.selected)
        const oldSelectedItem = hadCarousel ? this.dropdown.carousel.selectedItem : null;
        const oldSelectedID = oldSelectedItem ? oldSelectedItem.data.labelID : null;
        const oldSelectedEventName = oldSelectedItem ? oldSelectedItem.data.eventName : null;
        const oldSelectedCls = oldSelectedItem ? oldSelectedItem.data.cls : null;

        const searchValue = this.findInput.value;

        if (wasVisible) {
          // Dropdown is open - regenerate the list
          this.prevValue = null;
          this.rebuildDropdownItems();
          // Note: Don't re-open the dropdown here. If it was open, it will remain open
          // via the "visible" class that was already set. Re-adding the class can cause
          // race conditions with focus/blur handling and the outside-click close handler.
        } else {
          // Dropdown is closed - rebuild the list silently
          this.prevValue = null;
          this.rebuildDropdownItems();
        }

        // If carousel was active, recalculate it with new scope (BEFORE applying search filter)
        if (hadCarousel && oldSelectedItem) {
          // Find the item in the new list
          let newSelectedItem = null;
          for (const item of this.dropdown.items) {
            // For broadcasts, match by eventName (since labelID changes per sprite)
            if (
              oldSelectedCls === "broadcast" &&
              item.data.cls === "broadcast" &&
              oldSelectedEventName &&
              item.data.eventName === oldSelectedEventName
            ) {
              newSelectedItem = item;
              break;
            }
            // For everything else, match by labelID
            else if (item.data.labelID === oldSelectedID) {
              newSelectedItem = item;
              break;
            }
          }

          if (newSelectedItem) {
            // Found the item - rebuild carousel with new scope
            this.dropdown.selected = newSelectedItem;
            newSelectedItem.classList.add("sel");
            this.dropdown.onItemClick(newSelectedItem, currentBlockInstance);
          } else {
            // Item not found - clear the carousel
            this.clearNavigation();
          }
        }

        // Reapply the search filter AFTER carousel recalculation
        if (searchValue) {
          this.inputChange();
        }

        // Focus input if dropdown was open
        if (wasVisible) {
          this.findInput.focus();
        }
      });

      this.dropdownOut.appendChild(this.dropdown.createDom());

      // Prevent clicks inside dropdown from closing it
      this.dropdownOut.addEventListener("mousedown", (e) => {
        // Allow clicks on input and checkbox to work normally
        if (e.target === this.findInput || e.target === this.allSpritesCheckbox) {
          return;
        }
        // Allow clicks on items to work normally (they have their own handlers)
        // Prevent blur for everything else (headings, empty space, scrollbar)
        if (!e.target.closest("li") || e.target.closest(".sa-find-heading")) {
          e.preventDefault();
        }
      });

      // Create navigation controls container (hidden by default)
      this.navControls = this.findBarOuter.appendChild(document.createElement("span"));
      this.navControls.className = "sa-find-nav-controls";
      this.navControls.style.display = "none";

      // Create selected item label (hidden by default)
      this.selectedLabel = this.findBarOuter.appendChild(document.createElement("span"));
      this.selectedLabel.className = "sa-find-selected-label";
      this.selectedLabel.style.display = "none";

      // Create clear button (hidden by default)
      this.clearButton = this.findBarOuter.appendChild(document.createElement("button"));
      this.clearButton.className = "sa-find-clear-btn";
      this.clearButton.textContent = "✕";
      this.clearButton.title = "Clear selection and navigation";
      this.clearButton.style.display = "none";
      this.clearButton.addEventListener("click", () => this.clearNavigation());

      this.bindEvents();
      this.tabChanged();
    }

    bindEvents() {
      this.findInput.addEventListener("focus", () => {
        this.inputChange();
      });
      this.findInput.addEventListener("keydown", (e) => this.inputKeyDown(e));
      this.findInput.addEventListener("keyup", () => this.inputChange());
      this.findInput.addEventListener("focusout", () => this.hideDropDown());
    }

    tabChanged() {
      if (!this.findBarOuter) {
        return;
      }
      const tab = addon.tab.redux.state.scratchGui.editorTab.activeTabIndex;
      const visible = tab === 0 || tab === 1 || tab === 2;
      this.findBarOuter.hidden = !visible;
    }

    /**
     * Smart match that handles camel case and space-separated tokens.
     * Each token in the search (separated by spaces or camelCase) must match the start of a word
     * (after space/start) or a capital letter after a lowercase letter.
     * @param {string} searchText - The search query (space-separated tokens)
     * @param {string} targetText - The text to search in
     * @returns {Array|null} Array of match positions [{start, length}] or null if no match
     */
    /**
     * Simpler text matching for text blocks - case-insensitive substring match that respects word boundaries.
     * Matches "and th" with "this and then" but not "brand thing".
     * @param {string} searchText - The search query
     * @param {string} targetText - The text to search in
     * @returns {Array|null} Array of match positions [{start, length}] or null if no match
     */
    textMatch(searchText, targetText) {
      if (!searchText) return [];

      const searchLower = searchText.toLowerCase();
      const targetLower = targetText.toLowerCase();
      const matches = [];

      // Find all occurrences of the search text
      let searchPos = 0;
      while (searchPos < targetText.length) {
        const idx = targetLower.indexOf(searchLower, searchPos);
        if (idx === -1) break;

        // Check if this is at a word boundary (start of string or after space/punctuation)
        const isWordStart =
          idx === 0 ||
          targetText[idx - 1] === " " ||
          targetText[idx - 1] === "_" ||
          /[^a-zA-Z0-9]/.test(targetText[idx - 1]);

        if (isWordStart) {
          matches.push({ start: idx, length: searchText.length });
          // Only return the first match for highlighting
          return matches;
        }

        searchPos = idx + 1;
      }

      return matches.length > 0 ? matches : null;
    }

    smartMatch(searchText, targetText) {
      // Split by spaces first, then split camelCase within each token
      const rawTokens = searchText.split(/\s+/).filter((t) => t.length > 0);
      const tokens = [];

      for (const rawToken of rawTokens) {
        // Split camelCase only at lowercase->uppercase boundaries: "gD" becomes ["g", "D"], "HEAD" stays ["HEAD"]
        const camelSplit = rawToken.split(/(?<=[a-z])(?=[A-Z])/).filter((t) => t.length > 0);
        tokens.push(...camelSplit.map((t) => t.toLowerCase()));
      }

      if (tokens.length === 0) return [];

      const targetLower = targetText.toLowerCase();
      const matches = [];
      let searchPos = 0;

      for (const token of tokens) {
        let found = false;

        // Search for token starting at searchPos
        for (let i = searchPos; i < targetText.length; i++) {
          // Check if this position is a valid word start
          const isWordStart =
            i === 0 || // Start of string
            targetText[i - 1] === " " || // After space
            targetText[i - 1] === "_" || // After underscore
            (i > 0 &&
              targetText[i - 1] >= "a" &&
              targetText[i - 1] <= "z" &&
              targetText[i] >= "A" &&
              targetText[i] <= "Z"); // Camel case boundary

          if (isWordStart) {
            // Check if token matches at this position
            const matchesHere = targetLower.substr(i, token.length) === token;
            if (matchesHere) {
              matches.push({ start: i, length: token.length });
              searchPos = i + token.length;
              found = true;
              break;
            }
          }
        }

        if (!found) {
          return null; // Token not found, no match
        }
      }

      return matches;
    }

    applyFilter(val) {
      // Hide items in list that do not contain filter text
      let listLI = this.dropdown.items;
      const headingVisibility = new Map(); // Track which headings have visible items

      for (const li of listLI) {
        let procCode = li.data.procCode;
        // Use simpler substring matching for text blocks
        const matches = li.data.cls === "text" ? this.textMatch(val, procCode) : this.smartMatch(val, procCode);

        if (matches !== null) {
          li.style.display = "flex";

          const textSpan = li.querySelector(".sa-find-item-text");
          if (textSpan) {
            while (textSpan.firstChild) {
              textSpan.removeChild(textSpan.firstChild);
            }

            // Build the highlighted text
            if (matches.length > 0) {
              let lastEnd = 0;

              for (const match of matches) {
                // Add text before this match
                if (match.start > lastEnd) {
                  textSpan.appendChild(document.createTextNode(procCode.substring(lastEnd, match.start)));
                }

                // Add highlighted match
                let bText = document.createElement("b");
                bText.appendChild(document.createTextNode(procCode.substr(match.start, match.length)));
                textSpan.appendChild(bText);

                lastEnd = match.start + match.length;
              }

              // Add remaining text after last match
              if (lastEnd < procCode.length) {
                textSpan.appendChild(document.createTextNode(procCode.substr(lastEnd)));
              }
            } else {
              // No search term, just show the text as-is
              textSpan.appendChild(document.createTextNode(procCode));
            }
          }

          // Mark this item's heading as having visible items
          if (li.groupHeading) {
            headingVisibility.set(li.groupHeading, true);
          }
        } else {
          li.style.display = "none";
        }
      }

      // Hide headings that have no visible items
      const allHeadings = this.dropdown.el.querySelectorAll(".sa-find-heading");
      for (const heading of allHeadings) {
        heading.style.display = headingVisibility.get(heading) ? "flex" : "none";
      }
    }

    inputChange() {
      // Always show dropdown when typing
      this.showDropDown();

      // Filter the list...
      let val = this.findInput.value || "";
      if (val === this.prevValue) {
        // No change so don't re-filter
        return;
      }

      // Check if we need to rebuild dropdown due to text block threshold
      const oldIncludeText = this.currentSearchValue.length >= 3;
      const newIncludeText = val.length >= 3;
      if (oldIncludeText !== newIncludeText) {
        // Threshold crossed - rebuild dropdown
        this.currentSearchValue = val;
        this.prevValue = null; // Force rebuild
        this.rebuildDropdownItems();
      }

      this.prevValue = val;
      this.currentSearchValue = val;

      // Don't clear navigation - keep carousel active when dropdown opens
      // this.clearNavigation();

      this.dropdown.blocks = null;

      this.applyFilter(val);
    }

    async inputKeyDown(e) {
      this.dropdown.inputKeyDown(e, this);

      // Enter
      if (e.key === "Enter") {
        // Close dropdown and focus editor, keep carousel active
        this.dropdownOut.classList.remove("visible");
        this.findInput.blur(); // This focuses the editor panel

        let focusTarget = await addon.tab.waitForElement("svg.blocklySvg");
        focusTarget?.focus();

        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // Escape
      if (e.key === "Escape") {
        if (this.findInput.value.length > 0) {
          this.findInput.value = ""; // Clear search first, then close on second press
          this.inputChange();
        } else {
          this.findInput.blur();
        }
        e.preventDefault();
        return;
      }
    }

    /**
     * @param {HtmlElement} selectedItem
     * @param {Carousel} carousel
     */
    showNavigation(selectedItem, carousel) {
      // Show the selected item label
      this.selectedLabel.textContent = selectedItem.data.procCode;
      this.selectedLabel.style.display = "inline-block";

      // Move carousel to navigation area
      this.navControls.innerHTML = "";
      this.navControls.appendChild(carousel.el);
      this.navControls.style.display = "inline-block";

      // Trigger flash animation by removing and re-adding the element to restart CSS animation
      void this.navControls.offsetWidth; // Force reflow to restart animation
      this.navControls.style.animation = "none";
      setTimeout(() => {
        this.navControls.style.animation = "";
      }, 10);

      // Show the clear button
      this.clearButton.style.display = "inline-block";
    }

    clearNavigation() {
      // Clear the navigation controls
      this.selectedLabel.style.display = "none";
      this.navControls.innerHTML = "";
      this.navControls.style.display = "none";
      this.clearButton.style.display = "none";

      // Remove the carousel from dropdown if it exists
      this.dropdown.carousel.remove();
    }

    eventKeyDown(e) {
      if (addon.self.disabled || !this.findBarOuter || addon.tab.editorMode !== "editor") return;

      let ctrlKey = e.ctrlKey || e.metaKey;

      if (e.key?.toLowerCase() === "f" && ctrlKey && !e.shiftKey && !document.activeElement.closest(".sa-find-bar")) {
        // Ctrl + F (Override default Ctrl+F find)
        this.findInput.focus();
        this.findInput.select();
        e.cancelBubble = true;
        e.preventDefault();
        return true;
      }

      if (e.key === "ArrowLeft" && ctrlKey) {
        // Ctrl + Left Arrow Key
        if (document.activeElement.tagName === "INPUT") {
          return;
        }

        if (this.selectedTab === 0) {
          this.utils.navigationHistory.goBack();
          e.cancelBubble = true;
          e.preventDefault();
          return true;
        }
      }

      if (e.key === "ArrowRight" && ctrlKey) {
        // Ctrl + Right Arrow Key
        if (document.activeElement.tagName === "INPUT") {
          return;
        }

        if (this.selectedTab === 0) {
          this.utils.navigationHistory.goForward();
          e.cancelBubble = true;
          e.preventDefault();
          return true;
        }
      }

      // In Chrome, Ctrl+Z will undo edits to the find bar input even if it doesn't have focus.
      // Call preventDefault() to make sure that the event only goes to scratch-blocks or scratch-paint.
      // Blockly.onKeyDown_:
      // https://github.com/scratchfoundation/scratch-blocks/blob/1421093/core/blockly.js#L185
      // globalShortcutHandler() in Blockly:
      // https://github.com/RaspberryPiFoundation/blockly/blob/39c4b58/packages/blockly/core/common.ts#L322
      // KeyboardShortcutsHOC.handleKeyPress:
      // https://github.com/scratchfoundation/scratch-paint/blob/8119055/src/hocs/keyboard-shortcuts-hoc.jsx#L29
      let isTargetInput;
      if (Blockly.registry)
        isTargetInput = Blockly.browserEvents.isTargetInput(e); // new Blockly
      else isTargetInput = Blockly.utils.isTargetInput(e);
      if (!isTargetInput && addon.tab.redux.state?.scratchPaint.textEditTarget === null) {
        if (
          (ctrlKey || e.altKey) &&
          (e.keyCode === 90 || e.key === "z" || (e.shiftKey && e.key.toLowerCase() === "z"))
        ) {
          e.preventDefault();
        }
      }
    }

    rebuildDropdownItems(focusID, instanceBlock, forceAllSprites = false) {
      let scratchBlocks =
        this.selectedTab === 0
          ? this.getScratchBlocks(forceAllSprites)
          : this.selectedTab === 1
            ? this.getScratchCostumes()
            : this.selectedTab === 2
              ? this.getScratchSounds()
              : [];

      this.dropdown.empty();

      // Add items with group headings
      let lastGroup = null;
      const groupMap = {
        broadcast: "broadcasts",
        event: "events",
        "clone-hat": "clones",
        "clone-delete": "clones",
        "clone-create": "clones",
        define: "define",
        VAR: "variables-global",
        var: "variables-local",
        LIST: "lists-global",
        list: "lists-local",
        costume: "costumes",
        sound: "sounds",
        text: "text",
      };

      let selectedItem = null;
      for (const proc of scratchBlocks) {
        const currentGroup = groupMap[proc.cls];
        if (currentGroup !== lastGroup && currentGroup) {
          this.dropdown.addHeading(msg("group-" + currentGroup));
          lastGroup = currentGroup;
        }

        let item = this.dropdown.addItem(proc);

        if (focusID) {
          if (proc.matchesID(focusID)) {
            selectedItem = item;
          } else {
            item.style.display = "none";
          }
        }
      }

      // Calculate counts for all items (only when not filtering to a specific item)
      if (!focusID) {
        this.dropdown.calculateCounts();
      }

      return selectedItem;
    }

    showDropDown(focusID, instanceBlock, skipDropdownOpen, forceAllSprites = false) {
      if (!focusID && this.dropdownOut.classList.contains("visible")) {
        return;
      }

      // special '' vs null... - null forces a reevaluation
      this.prevValue = focusID ? "" : null; // Clear the previous value of the input search

      // Only open dropdown if not skipping
      if (!skipDropdownOpen) {
        this.dropdownOut.classList.add("visible");
      }

      const selectedItem = this.rebuildDropdownItems(focusID, instanceBlock, forceAllSprites);

      if (selectedItem) {
        this.dropdown.onItemClick(selectedItem, instanceBlock);
      }
    }

    hideDropDown() {
      // Just hide the dropdown, don't do anything with carousel
      this.dropdownOut.classList.remove("visible");
    }

    get selectedTab() {
      return addon.tab.redux.state.scratchGui.editorTab.activeTabIndex;
    }

    /**
     * Retrieves and categorizes all Scratch blocks from the current workspace and optionally other sprites.
     * Uses a single-pass algorithm to collect all block usage information while traversing ordered top blocks.
     * This efficiently preserves the natural left-to-right, top-to-bottom ordering of blocks.
     *
     * @param {boolean} forceAllSprites - If true, search all sprites regardless of checkbox state
     * @returns {BlockItem[]} Array of BlockItem objects representing different types of Scratch blocks,
     *                       sorted by category (events, broadcasts, definitions, variables, lists) and then
     *                       alphabetically by name, with position as final sort criteria
     *
     * @see BlockItem - The class used to represent individual blocks
     * @see this.allSpritesCheckbox - Checkbox that determines search scope (current sprite vs all sprites)
     * @see this.workspace - The Blockly workspace containing the blocks
     */
    getScratchBlocks(forceAllSprites = false) {
      const searchAllSprites = forceAllSprites || (this.allSpritesCheckbox ? this.allSpritesCheckbox.checked : true);
      const includeTextBlocks = this.currentSearchValue && this.currentSearchValue.length >= 3;

      // Collections for tracking unique items and their usages
      const itemsByKey = new Map(); // Key -> BlockItem
      const variableUsages = new Map(); // Variable ID -> Array of blocks
      const procedureUsages = new Map(); // Proc code -> Array of blocks
      const eventUsages = new Map(); // Event description or broadcast name -> Array of blocks (combines broadcasts and events)
      const cloneHatBlocks = []; // "when I start as clone" hat blocks
      const cloneDeleteBlocks = []; // "delete this clone" blocks
      const cloneCreateBySprite = new Map(); // Sprite name -> Array of "create clone of" blocks
      const textBlockUsages = new Map(); // Text content -> Array of text blocks

      /**
       * Helper to add a block to a map, initializing the array if needed
       */
      const addToMap = (map, key, block) => {
        if (!map.has(key)) {
          map.set(key, []);
        }
        map.get(key).push(block);
      };

      /**
       * Format a procedure code by replacing %s and %b placeholders with nicer representations
       */
      const formatProcCode = (procCode) => {
        if (!procCode) return procCode;

        // Replace %s (string/number input) with a placeholder in parentheses
        // Replace %b (boolean input) with a diamond placeholder
        let formatted = procCode.replace(/%s/g, "()").replace(/%b/g, "<>");

        return formatted;
      };

      /**
       * Helper to add or update a block item
       */
      const addOrUpdateItem = (cls, txt, blockOrInstance, eventName = null) => {
        const key = `${cls}:${txt}`;
        let item = itemsByKey.get(key);

        if (!item) {
          const id = blockOrInstance.id || blockOrInstance.getId?.() || null;
          item = new BlockItem(cls, txt, id, 0);
          item.y = blockOrInstance.getRelativeToSurfaceXY?.()?.y || blockOrInstance.y || null;
          if (eventName) item.eventName = eventName;
          itemsByKey.set(key, item);
        } else {
          // Clone detected
          const id = blockOrInstance.id || blockOrInstance.getId?.() || null;
          if (!item.clones) item.clones = [];
          item.clones.push(id);
        }

        return item;
      };

      /**
       * Get block description for event blocks
       */
      const getBlockDescription = (block) => {
        const opcode = block.opcode || block.type;

        if (opcode === "event_whenflagclicked") {
          return msg("when-flag-clicked", { flag: msg("/_general/blocks/green-flag") });
        }
        if (opcode === "event_whenkeypressed") {
          const key =
            block.fields?.KEY_OPTION?.value ||
            block.inputList?.[0].fieldRow.find((f) => f.name === "KEY_OPTION")?.getText() ||
            "";
          return msg("when-key-pressed", { key });
        }
        if (opcode === "event_whenthisspriteclicked") {
          return msg("when-this-sprite-clicked");
        }
        if (opcode === "event_whenstageclicked") {
          return msg("when-stage-clicked");
        }
        if (opcode === "event_whenbackdropswitchesto") {
          const backdrop = block.fields?.BACKDROP?.value || "";
          return msg("when-backdrop-switches", { backdrop });
        }
        if (opcode === "event_whengreaterthan") {
          const option = block.fields?.WHENGREATERTHANMENU?.value || "";
          return msg("when-greater-than", { option });
        }
        if (opcode === "control_start_as_clone") {
          return msg("when-i-start-as-clone");
        }

        // Fallback for Blockly blocks
        if (block.inputList) {
          let fields = block.inputList[0];
          let desc = "";
          for (const fieldRow of fields.fieldRow) {
            desc = desc ? desc + " " : "";
            if (fieldRow instanceof Blockly.FieldImage && fieldRow.getValue().endsWith("green-flag.svg")) {
              desc += msg("/_general/blocks/green-flag");
            } else {
              desc += fieldRow.getText();
            }
          }
          return desc;
        }

        return opcode;
      };

      /**
       * Process a single block and collect all relevant information
       */
      const processBlock = (block, target = null) => {
        const isBlockly = !!block.type; // Blockly blocks have .type, JSON blocks have .opcode
        const blockType = isBlockly ? block.type : block.opcode;

        // Handle top-level event blocks
        if (isBlockly) {
          // Create BlockInstance for current sprite's blocks to ensure they remain valid when switching sprites
          const blockRef = target ? new BlockInstance(target, { id: block.id }) : block;

          if (blockType === "procedures_definition") {
            const label = block.getChildren()[0];
            const procCode = label?.getProcCode();
            if (procCode) {
              const formattedProcCode = formatProcCode(procCode);
              addOrUpdateItem("define", formattedProcCode, block);
              addToMap(procedureUsages, procCode, blockRef);
            }
          } else if (blockType === "event_whenbroadcastreceived") {
            const fieldRow = block.inputList[0].fieldRow;
            const eventName = fieldRow.find((input) => input.name === "BROADCAST_OPTION")?.getText();
            if (eventName) {
              addOrUpdateItem("broadcast", eventName, block, eventName);
              addToMap(eventUsages, eventName, blockRef);
            }
          } else if (blockType.substr(0, 10) === "event_when") {
            const desc = getBlockDescription(block);
            addOrUpdateItem("event", desc, block);
            addToMap(eventUsages, desc, blockRef);
          } else if (blockType === "control_start_as_clone") {
            // Add to clone hat blocks collection
            cloneHatBlocks.push(blockRef);
          }
        } else {
          // JSON block from another sprite
          const blockInstance = new BlockInstance(target, block);

          if (blockType === "event_whenbroadcastreceived") {
            const eventName = block.fields.BROADCAST_OPTION.value;
            addOrUpdateItem("broadcast", eventName, blockInstance, eventName);
            addToMap(eventUsages, eventName, blockInstance);
          } else if (blockType.startsWith("event_when")) {
            const desc = getBlockDescription(block);
            addOrUpdateItem("event", desc, blockInstance);
            addToMap(eventUsages, desc, blockInstance);
          } else if (blockType === "control_start_as_clone") {
            // Add to clone hat blocks collection
            cloneHatBlocks.push(blockInstance);
          }
        }

        // Collect variable/list/procedure/broadcast usages from descendants
        if (isBlockly) {
          const descendants = block.getDescendants();
          for (const descendant of descendants) {
            // Create BlockInstance for current sprite's blocks to ensure they remain valid when switching sprites
            const blockRef = target ? new BlockInstance(target, { id: descendant.id }) : descendant;

            // Variables and lists
            const blockVariables = descendant.getVarModels?.();
            if (blockVariables) {
              for (const blockVar of blockVariables) {
                const varId = blockVar.getId();
                addToMap(variableUsages, varId, blockRef);
              }
            }

            // Procedure calls
            if (descendant.type === "procedures_call") {
              const procCode = descendant.getProcCode();
              if (procCode) {
                addToMap(procedureUsages, procCode, blockRef);
              }
            }

            // Broadcast sends
            if (descendant.type === "event_broadcast" || descendant.type === "event_broadcastandwait") {
              const broadcastInput = descendant.getChildren()[0];
              if (broadcastInput) {
                let eventName;
                if (broadcastInput.type === "event_broadcast_menu") {
                  eventName = broadcastInput.inputList[0].fieldRow[0].getText();
                } else {
                  eventName = msg("complex-broadcast");
                }
                addToMap(eventUsages, eventName, blockRef);
              }
            }

            // Collect text blocks if enabled
            if (includeTextBlocks && descendant.type === "text") {
              const textField = descendant.getField("TEXT");
              if (textField) {
                const textValue = textField.getValue();
                if (textValue) {
                  addToMap(textBlockUsages, textValue, blockRef);
                }
              }
            }

            // Handle clone-related blocks
            if (descendant.type === "control_delete_this_clone") {
              cloneDeleteBlocks.push(blockRef);
            } else if (descendant.type === "control_create_clone_of") {
              // Get the sprite being cloned
              const cloneInput = descendant.getChildren()[0];
              if (cloneInput && cloneInput.type === "control_create_clone_of_menu") {
                const field = cloneInput.inputList?.[0]?.fieldRow?.[0];
                let spriteName = field?.getText?.() || field?.value_ || null;

                // Handle "myself" - resolve to actual sprite name
                if (spriteName === "_myself_" || spriteName === "myself") {
                  const currentTarget = target || this.utils.getEditingTarget();
                  spriteName = currentTarget.getName();
                }

                // Track by actual sprite name
                if (spriteName) {
                  addToMap(cloneCreateBySprite, spriteName, blockRef);
                }
              }
            }
          }
        } else {
          // For JSON blocks from other sprites, we need to manually traverse the block tree
          const traverseJSONBlock = (jsonBlock, currentTarget) => {
            // Check for variable/list usage
            if (jsonBlock.fields) {
              for (const fieldName of Object.keys(jsonBlock.fields)) {
                const field = jsonBlock.fields[fieldName];
                if (field.id) {
                  // This field references a variable or list
                  addToMap(variableUsages, field.id, new BlockInstance(currentTarget, jsonBlock));
                }
              }
            }

            // Procedures (custom blocks) are always local to the current sprite.
            // Do NOT include procedure calls from other sprites in the usages map,
            // regardless of the global "all sprites" checkbox state.
            // Intentionally skipping jsonBlock.opcode === "procedures_call" here.

            // Check for broadcast sends
            if (jsonBlock.opcode === "event_broadcast" || jsonBlock.opcode === "event_broadcastandwait") {
              if (jsonBlock.inputs && jsonBlock.inputs.BROADCAST_INPUT) {
                const broadcastInputId = jsonBlock.inputs.BROADCAST_INPUT.block;
                const broadcastInputBlock = currentTarget.blocks._blocks[broadcastInputId];
                if (broadcastInputBlock) {
                  let eventName;
                  if (broadcastInputBlock.opcode === "event_broadcast_menu") {
                    eventName = broadcastInputBlock.fields.BROADCAST_OPTION.value;
                  } else {
                    eventName = msg("complex-broadcast");
                  }
                  addToMap(eventUsages, eventName, new BlockInstance(currentTarget, jsonBlock));
                }
              }
            }

            // Collect text blocks if enabled
            if (includeTextBlocks && jsonBlock.opcode === "text") {
              const textField = jsonBlock.fields?.TEXT;
              if (textField && textField.value) {
                addToMap(textBlockUsages, textField.value, new BlockInstance(currentTarget, jsonBlock));
              }
            }

            // Handle clone-related blocks
            if (jsonBlock.opcode === "control_delete_this_clone") {
              cloneDeleteBlocks.push(new BlockInstance(currentTarget, jsonBlock));
            } else if (jsonBlock.opcode === "control_create_clone_of") {
              // Get the sprite being cloned
              if (jsonBlock.inputs && jsonBlock.inputs.CLONE_OPTION) {
                const cloneInputId = jsonBlock.inputs.CLONE_OPTION.block;
                const cloneInputBlock = currentTarget.blocks._blocks[cloneInputId];
                if (cloneInputBlock && cloneInputBlock.opcode === "control_create_clone_of_menu") {
                  let spriteName = cloneInputBlock.fields?.CLONE_OPTION?.value;

                  // Handle "myself" - resolve to actual sprite name
                  if (spriteName === "_myself_" || spriteName === "myself") {
                    spriteName = currentTarget.getName();
                  }

                  // Track by actual sprite name
                  if (spriteName) {
                    addToMap(cloneCreateBySprite, spriteName, new BlockInstance(currentTarget, jsonBlock));
                  }
                }
              }
            }

            // Traverse child blocks
            if (jsonBlock.inputs) {
              for (const inputName of Object.keys(jsonBlock.inputs)) {
                const input = jsonBlock.inputs[inputName];
                if (input.block) {
                  const childBlock = currentTarget.blocks._blocks[input.block];
                  if (childBlock) {
                    traverseJSONBlock(childBlock, currentTarget);
                  }
                }
              }
            }

            // Traverse next block in stack
            if (jsonBlock.next) {
              const nextBlock = currentTarget.blocks._blocks[jsonBlock.next];
              if (nextBlock) {
                traverseJSONBlock(nextBlock, currentTarget);
              }
            }
          };

          traverseJSONBlock(block, target);
        }
      };

      // Process all sprites in order (including current sprite)
      const runtime = addon.tab.traps.vm.runtime;
      const currentTargetID = this.utils.getEditingTarget().id;

      // Get sprites to process (current sprite only, or all sprites)
      const spritesToProcess = searchAllSprites
        ? runtime.targets.filter((t) => t.isOriginal)
        : [this.utils.getEditingTarget()];

      for (const target of spritesToProcess) {
        // For current sprite, use Blockly workspace for better API access
        if (target.id === currentTargetID) {
          const topBlocks = getTopBlocks(this.workspace);
          for (const topBlock of topBlocks) {
            processBlock(topBlock, target);
          }
        } else {
          // For other sprites, use JSON blocks
          const blocks = target.blocks;
          if (!blocks._blocks) continue;

          // Get ordered top blocks for this sprite
          const topBlockIds = Object.keys(blocks._blocks)
            .filter((id) => {
              const block = blocks._blocks[id];
              return block.topLevel === true;
            })
            .sort((a, b) => {
              const blockA = blocks._blocks[a];
              const blockB = blocks._blocks[b];
              const xDiff = (blockA.x || 0) - (blockB.x || 0);
              if (Math.abs(xDiff) > 256) return xDiff;
              return (blockA.y || 0) - (blockB.y || 0);
            });

          for (const blockId of topBlockIds) {
            processBlock(blocks._blocks[blockId], target);
          }
        }
      }

      // Add variables and lists
      const map = this.workspace.getVariableMap();
      const vars = map.getVariablesOfType("");
      for (const varModel of vars) {
        const varId = varModel.getId();
        const usages = variableUsages.get(varId) || [];

        // Skip global variables not used in current sprite when searching current only
        if (!searchAllSprites && !varModel.isLocal && usages.length === 0) {
          continue;
        }

        addOrUpdateItem(varModel.isLocal ? "var" : "VAR", varModel.name, varModel);
      }

      const lists = map.getVariablesOfType("list");
      for (const listModel of lists) {
        const listId = listModel.getId();
        const usages = variableUsages.get(listId) || [];

        // Skip global lists not used in current sprite when searching current only
        if (!searchAllSprites && !listModel.isLocal && usages.length === 0) {
          continue;
        }

        addOrUpdateItem(listModel.isLocal ? "list" : "LIST", listModel.name, listModel);
      }

      // Add text blocks if enabled
      if (includeTextBlocks) {
        for (const [textValue, blocks] of textBlockUsages.entries()) {
          // Limit text display length to 50 characters
          const displayText = textValue.length > 50 ? textValue.substring(0, 50) + "..." : textValue;
          const textItem = new BlockItem("text", `"${displayText}"`, null, 0);
          textItem.textValue = textValue; // Store original for matching
          textItem.y = null;
          itemsByKey.set(`text:${textValue}`, textItem);
        }
      }

      // Create clone items
      // 1. Single "when I start as clone" entry (even when global)
      if (cloneHatBlocks.length > 0) {
        const cloneHatItem = new BlockItem("clone-hat", msg("when-i-start-as-clone"), null, 0);
        cloneHatItem.y = null;
        itemsByKey.set("clone-hat:when-i-start-as-clone", cloneHatItem);
      }

      // 2. Single "delete this clone" entry (even when global)
      if (cloneDeleteBlocks.length > 0) {
        const cloneDeleteItem = new BlockItem("clone-delete", msg("delete-this-clone"), null, 0);
        cloneDeleteItem.y = null;
        itemsByKey.set("clone-delete:delete-this-clone", cloneDeleteItem);
      }

      // 3. Multiple "create clone of {sprite}" entries
      for (const [spriteName, blocks] of cloneCreateBySprite.entries()) {
        const itemText = msg("create-clone-of-sprite", { sprite: spriteName });
        const cloneCreateItem = new BlockItem("clone-create", itemText, null, 0);
        cloneCreateItem.targetSprite = spriteName;
        cloneCreateItem.y = null;
        itemsByKey.set(`clone-create:${spriteName}`, cloneCreateItem);
      }

      // Store usage data on the dropdown for later retrieval (replaces multiple passes)
      // No need to sort - blocks are already in order from traversing sorted topBlocks
      this.dropdown._cachedVariableUsages = variableUsages;
      this.dropdown._cachedProcedureUsages = procedureUsages;
      this.dropdown._cachedEventUsages = eventUsages; // Contains both broadcasts and other events
      this.dropdown._cachedCloneHatBlocks = cloneHatBlocks;
      this.dropdown._cachedCloneDeleteBlocks = cloneDeleteBlocks;
      this.dropdown._cachedCloneCreateBySprite = cloneCreateBySprite;
      this.dropdown._cachedTextBlockUsages = textBlockUsages;

      // Convert map to array and sort
      const myBlocks = Array.from(itemsByKey.values());
      const clsOrder = {
        event: 0,
        broadcast: 1,
        "clone-hat": 2,
        "clone-delete": 2,
        "clone-create": 2,
        define: 3,
        var: 4,
        VAR: 5,
        list: 6,
        LIST: 7,
        text: 8,
      };

      myBlocks.sort((a, b) => {
        const t = clsOrder[a.cls] - clsOrder[b.cls];
        if (t !== 0) return t;
        if (a.lower < b.lower) return -1;
        if (a.lower > b.lower) return 1;
        return (a.y || 0) - (b.y || 0);
      });

      return myBlocks;
    }

    getScratchCostumes() {
      let costumes = this.utils.getEditingTarget().getCostumes();

      let items = [];

      let i = 0;
      for (const costume of costumes) {
        let item = new BlockItem("costume", costume.name, costume.assetId, i);
        items.push(item);
        i++;
      }

      return items;
    }

    getScratchSounds() {
      let sounds = this.utils.getEditingTarget().getSounds();

      let items = [];

      let i = 0;
      for (const sound of sounds) {
        let item = new BlockItem("sound", sound.name, sound.assetId, i);
        items.push(item);
        i++;
      }

      return items;
    }

    getCallsToEvents() {
      const uses = [];
      const alreadyFound = new Set();

      for (const block of this.workspace.getAllBlocks()) {
        if (block.type !== "event_broadcast" && block.type !== "event_broadcastandwait") {
          continue;
        }

        const broadcastInput = block.getChildren()[0];
        if (!broadcastInput) {
          continue;
        }

        let eventName;
        if (broadcastInput.type === "event_broadcast_menu") {
          eventName = broadcastInput.inputList[0].fieldRow[0].getText();
        } else {
          eventName = msg("complex-broadcast");
        }
        if (!alreadyFound.has(eventName)) {
          alreadyFound.add(eventName);
          uses.push({ eventName: eventName, block: block });
        }
      }

      return uses;
    }
  }

  class Dropdown {
    constructor(utils, findBar) {
      /** @type {Utils} */
      this.utils = utils;
      this.findBar = findBar;

      this.el = null;
      this.items = [];
      this.selected = null;
      this.carousel = new Carousel(this.utils, findBar);
    }

    get workspace() {
      return addon.tab.traps.getWorkspace();
    }

    /**
     * Sort blocks by position (left to right, top to bottom) for tidy navigation.
     * Works with both Blockly.Block objects and BlockInstance objects.
     * @param {Array} blocks - Array of blocks or BlockInstance objects
     * @returns {Array} Sorted array
     */
    sortBlocksByPosition(blocks) {
      const runtime = addon.tab.traps.vm.runtime;

      return blocks.sort((a, b) => {
        let posA, posB;

        // Handle Blockly.Block objects (have getRelativeToSurfaceXY method)
        if (a.getRelativeToSurfaceXY) {
          posA = a.getRelativeToSurfaceXY();
        } else if (a.targetId) {
          // Handle BlockInstance objects - need to look up the block from target
          const target = runtime.targets.find((t) => t.id === a.targetId);
          if (target && target.blocks._blocks && target.blocks._blocks[a.id]) {
            const blockData = target.blocks._blocks[a.id];
            posA = { x: blockData.x || 0, y: blockData.y || 0 };
          } else {
            posA = { x: 0, y: 0 };
          }
        } else {
          posA = { x: 0, y: 0 };
        }

        if (b.getRelativeToSurfaceXY) {
          posB = b.getRelativeToSurfaceXY();
        } else if (b.targetId) {
          const target = runtime.targets.find((t) => t.id === b.targetId);
          if (target && target.blocks._blocks && target.blocks._blocks[b.id]) {
            const blockData = target.blocks._blocks[b.id];
            posB = { x: blockData.x || 0, y: blockData.y || 0 };
          } else {
            posB = { x: 0, y: 0 };
          }
        } else {
          posB = { x: 0, y: 0 };
        }

        // Sort by x first (left to right), then by y (top to bottom)
        const xDiff = posA.x - posB.x;
        if (Math.abs(xDiff) > 256) {
          // Same tolerance as getTopBlocks
          return xDiff;
        }
        return posA.y - posB.y;
      });
    }

    createDom() {
      this.el = document.createElement("ul");
      this.el.className = "sa-find-dropdown";
      return this.el;
    }

    inputKeyDown(e, findBar) {
      // Up Arrow
      if (e.key === "ArrowUp") {
        this.navigateFilter(-1);
        e.preventDefault();
        return;
      }

      // Down Arrow
      if (e.key === "ArrowDown") {
        this.navigateFilter(1);
        e.preventDefault();
        return;
      }

      // Enter is now handled by FindBar.inputKeyDown
      // So we don't consume it here anymore

      this.carousel.inputKeyDown(e);
    }

    navigateFilter(dir) {
      let nxt;
      if (this.selected && this.selected.style.display !== "none") {
        nxt = dir === -1 ? this.selected.previousSibling : this.selected.nextSibling;
      } else {
        nxt = this.items[0];
        dir = 1;
      }
      while (nxt && (nxt.style.display === "none" || nxt.isHeading)) {
        nxt = dir === -1 ? nxt.previousSibling : nxt.nextSibling;
      }
      if (nxt) {
        nxt.scrollIntoView({ block: "nearest" });
        this.onItemClick(nxt);
      }
    }

    addHeading(text) {
      const heading = document.createElement("li");
      heading.innerText = text;
      heading.className = "sa-find-heading";
      heading.isHeading = true;
      heading.itemsInGroup = []; // Track items in this group
      this.el.appendChild(heading);
      this.currentHeading = heading; // Track current heading for items
      return heading;
    }

    addItem(proc) {
      const item = document.createElement("li");

      const textSpan = document.createElement("span");
      textSpan.className = "sa-find-item-text";
      textSpan.innerText = proc.procCode;
      item.appendChild(textSpan);

      const countSpan = document.createElement("span");
      countSpan.className = "sa-find-item-count";
      countSpan.innerText = ""; // Will be filled by calculateCounts
      item.appendChild(countSpan);

      item.data = proc;
      const colorIds = {
        broadcast: "events",
        event: "events",
        "clone-hat": "control",
        "clone-delete": "control",
        "clone-create": "control",
        define: "more",
        var: "data",
        VAR: "data",
        list: "data-lists",
        LIST: "data-lists",
        costume: "looks",
        sound: "sounds",
        text: "operators",
      };

      // Special case: flag events get green color (operators)
      const flagText = msg("when-flag-clicked", { flag: msg("/_general/blocks/green-flag") });
      if (proc.cls === "event" && proc.procCode === flagText) {
        item.className = "sa-block-color sa-block-color-operators";
      } else {
        const colorId = colorIds[proc.cls];
        item.className = `sa-block-color sa-block-color-${colorId}`;
      }
      item.addEventListener("mousedown", (e) => {
        this.onItemClick(item);
        e.preventDefault();
        e.cancelBubble = true;
        return false;
      });

      // Associate item with current heading
      if (this.currentHeading) {
        this.currentHeading.itemsInGroup.push(item);
        item.groupHeading = this.currentHeading;
      }

      this.items.push(item);
      this.el.appendChild(item);
      return item;
    }

    calculateCounts() {
      const searchAllSprites = this.isSearchingAllSprites();

      for (const item of this.items) {
        const countSpan = item.querySelector(".sa-find-item-count");
        if (!countSpan) continue;

        const cls = item.data.cls;
        let count;

        if (cls === "costume" || cls === "sound") {
          // No count for costumes/sounds
          countSpan.innerText = "";
          continue;
        } else if (cls === "text") {
          // Get text block count
          const textValue = item.data.textValue || item.data.procCode.replace(/^"|"$/g, "");
          count = (this._cachedTextBlockUsages?.get(textValue) || []).length;
        } else if (cls === "var" || cls === "VAR" || cls === "list" || cls === "LIST") {
          if (cls === "VAR" || cls === "LIST") {
            // Global variable/list
            if (searchAllSprites) {
              count = this.getGlobalVariableUsesById(item.data.labelID).length;
            } else {
              count = this.getVariableUsesById(item.data.labelID).length;
            }
          } else {
            // Local variable/list
            count = this.getVariableUsesById(item.data.labelID).length;
          }
        } else if (cls === "define") {
          count = this.getCallsToProcedureById(item.data.labelID).length;
        } else if (cls === "broadcast") {
          count = this.getBroadcastBlocks(item.data.eventName, searchAllSprites).length;
        } else if (cls === "event") {
          count = this.getEventBlocks(item.data.procCode, searchAllSprites).length;
        } else if (cls === "clone-hat") {
          count = (this._cachedCloneHatBlocks || []).length;
        } else if (cls === "clone-delete") {
          count = (this._cachedCloneDeleteBlocks || []).length;
        } else if (cls === "clone-create") {
          const spriteName = item.data.targetSprite;
          count = (this._cachedCloneCreateBySprite?.get(spriteName) || []).length;
        } else if (item.data.clones) {
          count = 1 + item.data.clones.length;
        } else {
          count = 1;
        }

        countSpan.innerText = count > 0 ? `${count}` : "";
      }
    }

    onItemClick(item, instanceBlock) {
      if (this.selected && this.selected !== item) {
        this.selected.classList.remove("sel");
        this.selected = null;
      }
      if (this.selected !== item) {
        item.classList.add("sel");
        this.selected = item;
      }

      const searchAllSprites = this.isSearchingAllSprites();
      let cls = item.data.cls;
      if (cls === "costume" || cls === "sound") {
        // Viewing costumes/sounds - jump to selected costume/sound
        const assetPanel = document.querySelector("[class*=asset-panel_wrapper_]");
        if (assetPanel) {
          const reactInstance = assetPanel[addon.tab.traps.getInternalKey(assetPanel)];
          const reactProps = reactInstance.pendingProps.children[0].props;
          reactProps.onItemClick(item.data.y);
          const selectorList = assetPanel.firstChild.firstChild;
          selectorList.children[item.data.y].scrollIntoView({
            behavior: "auto",
            block: "center",
            inline: "start",
          });
          // The wrapper seems to scroll when we use the function above.
          let wrapper = assetPanel.closest("[class*=gui_flex-wrapper_]");
          wrapper.scrollTop = 0;
        }
      } else if (cls === "var" || cls === "VAR" || cls === "list" || cls === "LIST") {
        // Search for all instances - global variables search across all sprites
        let blocks;
        if (cls === "VAR" || cls === "LIST") {
          // Global variable/list - search across all sprites (or current if checkbox unchecked)
          if (searchAllSprites) {
            blocks = this.getGlobalVariableUsesById(item.data.labelID);
          } else {
            blocks = this.getVariableUsesById(item.data.labelID);
          }
          if (!instanceBlock) {
            // Try to start with the first block on 'this' sprite
            const currentTargetID = this.utils.getEditingTarget().id;
            for (const block of blocks) {
              if (block.targetId === currentTargetID) {
                instanceBlock = block;
                break;
              }
            }
          }
        } else {
          // Local variable/list - only current sprite
          blocks = this.getVariableUsesById(item.data.labelID);
        }
        this.carousel.build(item, blocks, instanceBlock);
      } else if (cls === "define") {
        let blocks = this.getCallsToProcedureById(item.data.labelID);
        this.carousel.build(item, blocks, instanceBlock);
      } else if (cls === "broadcast") {
        let blocks = this.getBroadcastBlocks(item.data.eventName, searchAllSprites);
        if (!instanceBlock) {
          // Can we start by selecting the first block on 'this' sprite
          const currentTargetID = this.utils.getEditingTarget().id;
          for (const block of blocks) {
            if (block.targetId === currentTargetID) {
              instanceBlock = block;
              break;
            }
          }
        }
        this.carousel.build(item, blocks, instanceBlock);
      } else if (cls === "event") {
        // Get all matching event blocks (from all sprites if searchAllSprites is true)
        let blocks = this.getEventBlocks(item.data.procCode, searchAllSprites);
        if (!instanceBlock) {
          const currentTargetID = this.utils.getEditingTarget().id;
          for (const block of blocks) {
            if (block.targetId === currentTargetID) {
              instanceBlock = block;
              break;
            }
          }
        }
        this.carousel.build(item, blocks, instanceBlock);
      } else if (cls === "clone-hat") {
        let blocks = this._cachedCloneHatBlocks || [];
        this.carousel.build(item, blocks, instanceBlock);
      } else if (cls === "clone-delete") {
        let blocks = this._cachedCloneDeleteBlocks || [];
        this.carousel.build(item, blocks, instanceBlock);
      } else if (cls === "clone-create") {
        const spriteName = item.data.targetSprite;
        let blocks = this._cachedCloneCreateBySprite?.get(spriteName) || [];
        this.carousel.build(item, blocks, instanceBlock);
      } else if (cls === "text") {
        const textValue = item.data.textValue || item.data.procCode.replace(/^"|"$/g, "");
        let blocks = this._cachedTextBlockUsages?.get(textValue) || [];
        this.carousel.build(item, blocks, instanceBlock);
      } else if (item.data.clones) {
        let blocks = [this.workspace.getBlockById(item.data.labelID)];
        for (const cloneID of item.data.clones) {
          blocks.push(this.workspace.getBlockById(cloneID));
        }
        this.carousel.build(item, blocks, instanceBlock);
      } else {
        // Single item - still show carousel with count of 1
        let blocks = [this.workspace.getBlockById(item.data.labelID)];
        this.carousel.build(item, blocks, instanceBlock);
      }
    }

    getVariableUsesById(id) {
      // Use cached data from the single-pass collection
      return this._cachedVariableUsages?.get(id) || [];
    }

    isSearchingAllSprites() {
      return this.findBar.allSpritesCheckbox ? this.findBar.allSpritesCheckbox.checked : true;
    }

    getGlobalVariableUsesById(id) {
      // Use cached data - already sorted during collection
      return this._cachedVariableUsages?.get(id) || [];
    }

    getCallsToProcedureById(id) {
      // Use cached data from the single-pass collection
      let procBlock = this.workspace.getBlockById(id);
      if (!procBlock) return [];

      let label = procBlock.getChildren()[0];
      let procCode = label?.getProcCode();
      if (!procCode) return [];

      return this._cachedProcedureUsages?.get(procCode) || [];
    }

    getBlockDescription(block) {
      if (block.opcode === "event_whenflagclicked") {
        // Construct the full description to match what getDescFromField produces
        return msg("when-flag-clicked", { flag: msg("/_general/blocks/green-flag") });
      }

      if (block.opcode === "event_whenkeypressed") {
        const key = block.fields.KEY_OPTION ? block.fields.KEY_OPTION.value : "";
        return msg("when-key-pressed", { key: key });
      }

      if (block.opcode === "event_whenthisspriteclicked") {
        return msg("when-this-sprite-clicked");
      }

      if (block.opcode === "event_whenstageclicked") {
        return msg("when-stage-clicked");
      }

      if (block.opcode === "event_whenbackdropswitchesto") {
        const backdrop = block.fields.BACKDROP ? block.fields.BACKDROP.value : "";
        return msg("when-backdrop-switches", { backdrop: backdrop });
      }

      if (block.opcode === "event_whengreaterthan") {
        const option = block.fields.WHENGREATERTHANMENU ? block.fields.WHENGREATERTHANMENU.value : "";
        return msg("when-greater-than", { option: option });
      }

      if (block.opcode === "control_start_as_clone") {
        return msg("when-i-start-as-clone");
      }

      // Fallback: extract field values
      let desc = "";
      if (block.fields) {
        for (const fieldName of Object.keys(block.fields)) {
          const field = block.fields[fieldName];
          if (field.value) {
            desc += (desc ? " " : "") + field.value;
          }
        }
      }
      return desc || block.opcode;
    }

    getBroadcastBlocks(name, searchAllSprites = true) {
      // Use cached data from the single-pass collection (already sorted)
      // Broadcasts are now stored in eventUsages map alongside other events
      return this._cachedEventUsages?.get(name) || [];
    }

    getEventBlocks(eventDesc, searchAllSprites = true) {
      // Use cached data from the single-pass collection (already sorted)
      return this._cachedEventUsages?.get(eventDesc) || [];
    }

    getBlocksForItem(item) {
      let cls = item.data.cls;

      if (cls === "costume" || cls === "sound") {
        // No navigation for costumes/sounds
        return null;
      } else if (cls === "var" || cls === "VAR" || cls === "list" || cls === "LIST") {
        return this.getVariableUsesById(item.data.labelID);
      } else if (cls === "define") {
        return this.getCallsToProcedureById(item.data.labelID);
      } else if (cls === "broadcast") {
        return this.getBroadcastBlocks(item.data.eventName);
      } else if (cls === "event") {
        return this.getEventBlocks(item.data.procCode);
      } else if (cls === "text") {
        const textValue = item.data.textValue || item.data.procCode.replace(/^"|"$/g, "");
        return this._cachedTextBlockUsages?.get(textValue) || [];
      } else if (item.data.clones) {
        let blocks = [this.workspace.getBlockById(item.data.labelID)];
        for (const cloneID of item.data.clones) {
          blocks.push(this.workspace.getBlockById(cloneID));
        }
        return blocks;
      } else {
        // Single block with no navigation
        return [this.workspace.getBlockById(item.data.labelID)];
      }
    }

    empty() {
      // Clear all children (including headings and items)
      while (this.el.firstChild) {
        this.el.removeChild(this.el.firstChild);
      }
      this.items = [];
      this.selected = null;
      this.currentHeading = null;
    }
  }

  class Carousel {
    constructor(utils, findBar) {
      /** @type {Utils} */
      this.utils = utils;
      /** @type {FindBar} */
      this.findBar = findBar;

      this.el = null;
      this.count = null;
      this.blocks = [];
      this.idx = 0;
      this.selectedItem = null;
      this.isDirty = false;
      this._suppressDirty = false;
      this._suppressTimer = null;
      this.workspaceChangeListener = null;
      this.currentTargetId = null;
      this.forceAllSprites = false; // Track if this carousel was built with forceAllSprites
      this.cloneFilterContext = null; // Store clone filtering context: { targetSpriteId, targetSpriteName }
      this.highlighter = new BlockHighlighter(findBar.utils.addon);
      this.spriteNotification = null; // Element for showing sprite switch notifications
      this.notificationTimeout = null; // Timeout for hiding notification
    }

    /**
     * Filter clone blocks to only those related to a specific sprite
     * @param {Array} allBlocks - All clone-related blocks
     * @param {string} targetSpriteId - The sprite ID to filter for
     * @returns {Array} Filtered blocks
     */
    filterCloneBlocksBySprite(allBlocks, targetSpriteId) {
      const runtime = addon.tab.traps.vm.runtime;

      return allBlocks.filter((b) => {
        const bTargetId = b.targetId || this.findBar.utils.getEditingTarget().id;

        // Keep clone hats on the target sprite
        if (bTargetId === targetSpriteId) return true;

        // Keep "create clone of" blocks that target this sprite
        const actualBlock = b.getBlock?.() || runtime.targets.find((t) => t.id === bTargetId)?.blocks._blocks?.[b.id];
        if (actualBlock?.opcode === "control_create_clone_of" || actualBlock?.type === "control_create_clone_of") {
          const cloneInput = actualBlock.inputs?.CLONE_OPTION;
          if (cloneInput) {
            const menuBlock = runtime.targets.find((t) => t.id === bTargetId)?.blocks._blocks?.[cloneInput.block];
            const clonedSpriteName = menuBlock?.fields?.CLONE_OPTION?.value;
            if (clonedSpriteName === "myself") {
              return bTargetId === targetSpriteId;
            } else if (clonedSpriteName) {
              const clonedSprite = runtime.targets.find((t) => t.getName() === clonedSpriteName && t.isOriginal);
              return clonedSprite?.id === targetSpriteId;
            }
          }
        }
        return false;
      });
    }

    build(item, blocks, instanceBlock, forceAllSprites = false, cloneFilterContext = null) {
      // Clear previous highlights
      this.highlighter.clearAll();

      if (this.selectedItem === item && this.blocks.length > 0) {
        // Same item selected... click again to go to next
        this.navRight();
      } else {
        this.remove();
        this.blocks = blocks;
        this.selectedItem = item;
        this.isDirty = false;
        this.currentTargetId = this.utils.getEditingTarget().id;
        this.forceAllSprites = forceAllSprites;
        this.cloneFilterContext = cloneFilterContext;

        this.idx = 0;
        if (instanceBlock) {
          const instanceId = this.utils.getBlockId(instanceBlock);
          for (const idx of Object.keys(this.blocks)) {
            const block = this.blocks[idx];
            const blockId = this.utils.getBlockId(block);
            if (blockId === instanceId) {
              this.idx = Number(idx);
              break;
            }
          }
        }

        this.createDom(item);

        if (this.idx < this.blocks.length) {
          this.utils.scrollBlockIntoView(this.blocks[this.idx]);
        }

        // Immediately show in navigation area (even if 0 items)
        if (this.findBar) {
          this.findBar.showNavigation(item, this);
        }

        // Listen for workspace changes to mark carousel as dirty
        this.startListeningForChanges();

        // Highlight all blocks in carousel
        this.reapplyHighlights();
      }
    }

    startListeningForChanges() {
      if (this.workspaceChangeListener) return; // Already listening

      const workspace = addon.tab.traps.getWorkspace();
      this.workspaceChangeListener = (e) => {
        // Minimal guards
        if (e.isUiEvent) return;

        // Clear suppression when finished loading a batch
        const FINISHED_LOADING = (Blockly?.Events && Blockly.Events.FINISHED_LOADING) || "finished_loading";
        if (e.type === FINISHED_LOADING) {
          this._suppressDirty = false;
          return;
        }

        // Detect sprite switch and start a short suppression
        const currentTargetId = this.utils.getEditingTarget().id;
        if (currentTargetId !== this.currentTargetId) {
          this.currentTargetId = currentTargetId;
          // Clear navigation history when switching sprites
          this.utils.navigationHistory.clearHistory();
          this._suppressDirty = true;
          if (this._suppressTimer) clearTimeout(this._suppressTimer);
          this._suppressTimer = setTimeout(() => {
            this._suppressDirty = false;
            // Re-apply highlights after sprite switch
            this.reapplyHighlights();
          }, 200);
          return;
        }

        if (this._suppressDirty) return;

        // Remove outline from edited blocks (shape may change when typing)
        if (e.blockId && this.highlighter.highlightedBlocks.has(e.blockId)) {
          // Remove outline on any change to a highlighted block (typing, dragging, etc.)
          if (
            e.type === Blockly.Events.BLOCK_CHANGE ||
            e.type === Blockly.Events.BLOCK_FIELD_INTERMEDIATE_CHANGE ||
            e.type === Blockly.Events.BLOCK_MOVE
          ) {
            this.highlighter.removeOutline(e.blockId);
          }
        }

        // Only mark as dirty for actual block changes on the current sprite
        if (
          e.type === Blockly.Events.BLOCK_CHANGE ||
          e.type === Blockly.Events.BLOCK_CREATE ||
          e.type === Blockly.Events.BLOCK_DELETE ||
          e.type === Blockly.Events.BLOCK_MOVE ||
          e.type === Blockly.Events.VAR_CREATE ||
          e.type === Blockly.Events.VAR_DELETE ||
          e.type === Blockly.Events.VAR_RENAME
        ) {
          this.isDirty = true;
        }
      };
      workspace.addChangeListener(this.workspaceChangeListener);
    }

    stopListeningForChanges() {
      if (this.workspaceChangeListener) {
        const workspace = addon.tab.traps.getWorkspace();
        workspace.removeChangeListener(this.workspaceChangeListener);
        this.workspaceChangeListener = null;
      }
    }

    refreshIfDirty() {
      if (!this.isDirty || !this.selectedItem) return;

      // Save references before rebuild
      const currentSearchValue = this.findBar.findInput.value || "";
      const oldItem = this.selectedItem;

      // If this is a clone-filtered carousel, rebuild with the same filter
      let blocks;
      if (this.cloneFilterContext) {
        // Rebuild dropdown with forceAllSprites to get all clone blocks
        this.findBar.rebuildDropdownItems(null, null, true);

        // Find the clone event item
        const cloneDesc = msg("when-i-start-as-clone");
        const evtItem = this.findBar.dropdown.items.find(
          (i) => i.data && i.data.cls === "event" && i.data.procCode === cloneDesc
        );

        if (!evtItem) return;

        // Get all clone blocks and apply the sprite filter
        let allBlocks = this.findBar.dropdown.getEventBlocks(cloneDesc, true);
        blocks = this.filterCloneBlocksBySprite(allBlocks, this.cloneFilterContext.targetSpriteId);

        // Keep the synthetic item with the sprite name
        this.selectedItem = oldItem;
      } else {
        // Normal rebuild path
        this.findBar.rebuildDropdownItems(null, null, this.forceAllSprites);

        // Find the matching new item and restore selection
        for (const item of this.findBar.dropdown.items) {
          let isMatch;

          if (oldItem.data.cls === "broadcast" && item.data.cls === "broadcast") {
            isMatch = item.data.eventName === oldItem.data.eventName;
          } else if (oldItem.data.cls === "event" && item.data.cls === "event") {
            // Match events by their description/procCode, not by a block id that can change order
            isMatch = item.data.procCode === oldItem.data.procCode;
          } else {
            // Fallback: match by labelID (procedure defs, variables/lists, single blocks)
            isMatch = item.data.labelID === oldItem.data.labelID;
          }

          if (isMatch) {
            this.selectedItem = item;
            item.classList.add("sel");
            this.findBar.dropdown.selected = item;
            break;
          }
        }

        // Reapply the current filter if dropdown is visible and there's a search value
        if (this.findBar.dropdownOut.classList.contains("visible") && currentSearchValue) {
          const val = currentSearchValue.toLowerCase();
          this.findBar.applyFilter(val);
        }

        // Re-fetch the blocks for the current item with fresh data
        blocks = this.findBar.dropdown.getBlocksForItem(this.selectedItem);
        if (!blocks) return;
      }

      // Try to maintain position on the same block ID if it still exists
      const currentBlockId = this.blocks[this.idx]?.id;
      this.blocks = blocks;

      // Find the index of the current block in the new list
      if (currentBlockId) {
        const newIdx = this.blocks.findIndex((b) => b.id === currentBlockId);
        if (newIdx !== -1) {
          this.idx = newIdx;
        } else {
          // Block no longer exists, stay at same index or clamp to valid range
          this.idx = Math.min(this.idx, Math.max(0, this.blocks.length - 1));
        }
      } else {
        this.idx = 0;
      }

      // Update the count display
      if (this.count) {
        this.count.innerHTML = this.blocks.length > 0 ? this.idx + 1 + " / " + this.blocks.length : "0";
      }

      // Re-highlight all blocks
      this.highlighter.clearAll();
      const workspace = addon.tab.traps.getWorkspace();
      for (const blockInstance of this.blocks) {
        const block = workspace.getBlockById(blockInstance.id);
        if (block) {
          this.highlighter.highlight(block);
        }
      }

      this.isDirty = false;
    }

    createDom(item) {
      this.el = document.createElement("span");
      this.el.className = "sa-find-carousel";

      // Apply the same color class as the item for consistent theming
      if (item && item.className) {
        // Copy color classes from the item
        const colorClasses = item.className.match(/sa-block-color-[\w-]+/g);
        if (colorClasses) {
          this.el.className += " " + colorClasses.join(" ");
        }
        if (item.className.includes("sa-find-flag")) {
          this.el.classList.add("sa-find-flag");
        }
      }

      const leftControl = this.el.appendChild(document.createElement("span"));
      leftControl.className = "sa-find-carousel-control";
      leftControl.textContent = "◀";
      leftControl.addEventListener("mousedown", (e) => this.navLeft(e));

      this.count = this.el.appendChild(document.createElement("span"));
      this.count.className = "sa-find-carousel-count";
      this.count.innerHTML = this.blocks.length > 0 ? this.idx + 1 + " / " + this.blocks.length : "0";
      this.count.addEventListener("mousedown", (e) => {
        // Ensure list is up-to-date before acting
        this.refreshIfDirty();
        // Re-flash the current block
        if (this.idx < this.blocks.length) {
          this.utils.scrollBlockIntoView(this.blocks[this.idx]);
        }
        e.preventDefault();
        e.stopPropagation();
      });

      const rightControl = this.el.appendChild(document.createElement("span"));
      rightControl.className = "sa-find-carousel-control";
      rightControl.textContent = "▶";
      rightControl.addEventListener("mousedown", (e) => this.navRight(e));

      return this.el;
    }

    inputKeyDown(e) {
      // Left Arrow
      if (e.key === "ArrowLeft") {
        if (this.el && this.blocks) {
          this.navLeft(e);
        }
      }

      // Right Arrow
      if (e.key === "ArrowRight") {
        if (this.el && this.blocks) {
          this.navRight(e);
        }
      }
    }

    navLeft(e) {
      return this.navSideways(e, -1);
    }

    navRight(e) {
      return this.navSideways(e, 1);
    }

    navSideways(e, dir) {
      // Refresh carousel if workspace has changed
      this.refreshIfDirty();

      if (this.blocks.length > 0) {
        this.idx = (this.idx + dir + this.blocks.length) % this.blocks.length; // + length to fix negative modulo js issue.
        this.count.innerText = this.idx + 1 + " / " + this.blocks.length;

        // Pass callback to apply highlights immediately after sprite switch
        this.utils.scrollBlockIntoView(this.blocks[this.idx], false, () => {
          this.reapplyHighlights();
          this.showSpriteNotification();
        });
      }

      if (e) {
        e.cancelBubble = true;
        e.preventDefault();
      }
    }

    reapplyHighlights() {
      // Clear and re-apply highlights (useful after sprite switch)
      this.highlighter.clearAll();
      const workspace = addon.tab.traps.getWorkspace();
      for (const blockInstance of this.blocks) {
        const block = workspace.getBlockById(blockInstance.id);
        if (block) {
          this.highlighter.highlight(block);
        }
      }
    }

    showSpriteNotification() {
      const spriteName = this.utils.getEditingTarget().getName();

      // Create notification element if it doesn't exist
      if (!this.spriteNotification) {
        this.spriteNotification = document.createElement("div");
        this.spriteNotification.className = "sa-find-sprite-notification";
        document.body.appendChild(this.spriteNotification);
      }

      // Set sprite name
      this.spriteNotification.textContent = spriteName;

      // Position below the carousel
      if (this.el) {
        const rect = this.el.getBoundingClientRect();
        this.spriteNotification.style.left = rect.left + rect.width / 2 + "px";
        this.spriteNotification.style.top = rect.bottom + 16 + "px";
        this.spriteNotification.style.transform = "translateX(-50%)";
      }

      // Show with animation
      this.spriteNotification.classList.remove("sa-find-sprite-notification-hiding");
      this.spriteNotification.classList.add("sa-find-sprite-notification-visible");

      // Clear any existing timeout
      if (this.notificationTimeout) {
        clearTimeout(this.notificationTimeout);
      }

      // Hide after delay
      this.notificationTimeout = setTimeout(() => {
        this.spriteNotification.classList.remove("sa-find-sprite-notification-visible");
        this.spriteNotification.classList.add("sa-find-sprite-notification-hiding");
      }, 1500);
    }

    remove() {
      this.stopListeningForChanges();
      this.highlighter.clearAll();

      // Clean up notification
      if (this.notificationTimeout) {
        clearTimeout(this.notificationTimeout);
        this.notificationTimeout = null;
      }
      if (this.spriteNotification) {
        this.spriteNotification.remove();
        this.spriteNotification = null;
      }

      if (this.el) {
        this.el.remove();
        this.blocks = [];
        this.idx = 0;
        this.selectedItem = null;
        this.isDirty = false;
      }
    }
  }

  class BlockHighlighter {
    constructor(addon) {
      this.addon = addon;
      this.highlightedBlocks = new Set();
      this.outlinePaths = new Map(); // Store outline elements
    }

    getSvgPath(block) {
      if (!block) return null;
      if (block.pathObject) return block.pathObject.svgPath; // new Blockly
      if (block.svgPath_) return block.svgPath_; // old Blockly

      // Fallback for shadow blocks (like text blocks) that don't have pathObject/svgPath_
      // These blocks have their path as a child element with class "blocklyPath"
      if (block.getSvgRoot) {
        const svgRoot = block.getSvgRoot();
        if (svgRoot) {
          const path = svgRoot.querySelector(".blocklyPath.blocklyBlockBackground");
          if (path) return path;
        }
      }

      return null;
    }

    highlight(block) {
      const svgPath = this.getSvgPath(block);
      if (!svgPath) return;

      svgPath.classList.add("sa-find-highlighted");
      this.highlightedBlocks.add(block.id);

      // Create an outline path that renders on top
      const outline = svgPath.cloneNode(true);
      outline.classList.remove("sa-find-highlighted");
      outline.style.fill = "none";
      outline.style.stroke = "rgba(0, 0, 0, 0.6)";
      outline.style.strokeWidth = "3";
      outline.style.pointerEvents = "none";
      outline.setAttribute("data-sa-find-outline", "true");

      // Insert after the original path so it renders on top
      svgPath.parentNode.appendChild(outline);
      this.outlinePaths.set(block.id, outline);
    }

    unhighlight(block) {
      const svgPath = this.getSvgPath(block);
      if (!svgPath) return;

      svgPath.classList.remove("sa-find-highlighted");
      this.highlightedBlocks.delete(block.id);

      // Remove the outline path
      const outline = this.outlinePaths.get(block.id);
      if (outline && outline.parentNode) {
        outline.parentNode.removeChild(outline);
      }
      this.outlinePaths.delete(block.id);
    }

    removeOutline(blockId) {
      // Remove just the outline (not the background highlight) when a block is edited
      const outline = this.outlinePaths.get(blockId);
      if (outline && outline.parentNode) {
        outline.parentNode.removeChild(outline);
      }
      this.outlinePaths.delete(blockId);
    }

    clearAll() {
      const workspace = this.addon.tab.traps.getWorkspace();
      for (const blockId of this.highlightedBlocks) {
        const block = workspace.getBlockById(blockId);
        if (block) {
          this.unhighlight(block);
        }
      }
    }
  }

  const findBar = new FindBar();

  // Helper function to check if a block can be explored
  function canBlockBeExplored(block) {
    if (!block) return false;

    // Walk up the block tree to find explorable blocks
    for (let b = block; b; b = b.getSurroundParent ? b.getSurroundParent() : null) {
      if (BlockTypes.isExplorableBlock(b.type)) {
        return true;
      }
    }
    return false;
  }

  // Helper function to handle middle-click/shift-click on blocks
  function handleBlockExplore(block) {
    if (!block) return false;

    for (; block; block = block.getSurroundParent ? block.getSurroundParent() : null) {
      if (block.type === "procedures_definition") {
        let id = findBar.utils.getBlockId(block);
        findBar.showDropDown(id, block, true);
        return true;
      }

      if (block.type === "procedures_call") {
        // For procedure calls, find the definition by procCode
        const procCode = block.getProcCode();
        if (procCode) {
          const workspace = addon.tab.traps.getWorkspace();
          const topBlocks = getTopBlocks(workspace);
          for (const topBlock of topBlocks) {
            if (topBlock.type === "procedures_definition") {
              const label = topBlock.getChildren()[0];
              if (label?.getProcCode() === procCode) {
                // Pass the definition block as instanceBlock to start carousel there
                findBar.showDropDown(topBlock.id, topBlock, true);
                return true;
              }
            }
          }
        }
        return true;
      }

      if (BlockTypes.isVariableBlock(block.type)) {
        let id = block.getVars()[0];
        findBar.showDropDown(id, block, true);
        findBar.selVarID = id;
        return true;
      }

      if (BlockTypes.isListBlock(block.type)) {
        let id = block.getVars()[0];
        findBar.showDropDown(id, block, true);
        findBar.selVarID = id;
        return true;
      }

      if (BlockTypes.isBroadcastBlock(block.type)) {
        // For broadcast blocks, we need to find the item by broadcast name, not block ID
        // Rebuild the dropdown to get fresh items
        findBar.showDropDown(null, null, true);

        // Get the broadcast name from the block
        let broadcastName = null;
        if (block.type === "event_whenbroadcastreceived") {
          const fieldRow = block.inputList?.[0]?.fieldRow;
          broadcastName = fieldRow?.find((input) => input.name === "BROADCAST_OPTION")?.getText();
        } else {
          // For broadcast/broadcastandwait, get the name from the child menu block
          const broadcastInput = block.getChildren()[0];
          if (broadcastInput && broadcastInput.type === "event_broadcast_menu") {
            broadcastName = broadcastInput.inputList[0].fieldRow[0].getText();
          }
        }

        if (broadcastName) {
          // Find the broadcast item by name
          const broadcastItem = findBar.dropdown.items.find(
            (i) => i.data && i.data.cls === "broadcast" && i.data.eventName === broadcastName
          );
          if (broadcastItem) {
            findBar.dropdown.onItemClick(broadcastItem, block);
            return true;
          }
        }
        return true;
      }

      if (block.type === "event_whenflagclicked") {
        let id = block.id;
        findBar.showDropDown(id, block, true);
        findBar.selVarID = id;
        return true;
      }

      // Middle-click on any clone block shows all 3 types filtered to the relevant sprite
      if (BlockTypes.isCloneBlock(block.type)) {
        const runtime = addon.tab.traps.vm.runtime;

        // Extract target sprite for filtering
        let targetSpriteName = null;
        let targetSpriteId = null;

        // Get the block's sprite (works for both Blockly blocks and BlockInstance)
        const blockTargetId = block.targetId || findBar.utils.getEditingTarget().id;

        if (block.type === "control_create_clone_of") {
          // Get the sprite being cloned (where the clone hats will run)
          const cloneInput = block.getChildren()[0];
          if (cloneInput && cloneInput.type === "control_create_clone_of_menu") {
            const field = cloneInput.inputList?.[0]?.fieldRow?.[0];
            targetSpriteName = field?.getText?.() || field?.value_ || null;

            // Handle "myself" - use the block's current sprite (the one being cloned)
            if (targetSpriteName === "myself" || targetSpriteName === "_myself_") {
              const currentTarget = runtime.getTargetById(blockTargetId);
              targetSpriteName = currentTarget?.getName() || "myself";
              targetSpriteId = blockTargetId;
            } else if (targetSpriteName) {
              // Resolve sprite name to ID
              const targetSprite = runtime.targets.find((t) => t.getName() === targetSpriteName && t.isOriginal);
              targetSpriteId = targetSprite?.id;
            }
          }
        } else {
          // For 'when I start as clone' or 'delete this clone', use the block's own sprite
          const currentTarget = runtime.getTargetById(blockTargetId);
          targetSpriteName = currentTarget?.getName();
          targetSpriteId = blockTargetId;
        }

        if (targetSpriteId && targetSpriteName) {
          // Rebuild dropdown with forceAllSprites to get all clone blocks
          findBar.showDropDown(null, null, true, true);

          // Collect ALL three types of blocks filtered to this sprite
          const cloneHatBlocks = (findBar.dropdown._cachedCloneHatBlocks || []).filter(
            (b) => (b.targetId || findBar.utils.getEditingTarget().id) === targetSpriteId
          );
          const cloneDeleteBlocks = (findBar.dropdown._cachedCloneDeleteBlocks || []).filter(
            (b) => (b.targetId || findBar.utils.getEditingTarget().id) === targetSpriteId
          );

          // For create blocks, include those targeting this sprite (by name)
          const cloneCreateBlocks = findBar.dropdown._cachedCloneCreateBySprite?.get(targetSpriteName) || [];

          // Combine all three types
          const allCloneBlocks = [...cloneHatBlocks, ...cloneCreateBlocks, ...cloneDeleteBlocks];

          // Create a synthetic item for the carousel
          const filteredItem = {
            data: {
              cls: "clone-hat",
              procCode: msg("clone-of-sprite", { sprite: targetSpriteName }),
              labelID: null,
              targetSprite: targetSpriteName,
            },
            className: "sa-block-color sa-block-color-control",
            classList: { add: () => {}, remove: () => {} },
          };

          // Build carousel with all three types of blocks for this sprite
          findBar.dropdown.carousel.build(filteredItem, allCloneBlocks, block);
          return true;
        }
        return false;
      }
    }
    return false;
  }

  // Event listeners that need cleanup
  const findBarActivateHandler = (e) => {
    if (!addon.self.disabled && e.detail.blockId) {
      findBar.showDropDown(e.detail.blockId, e.detail.instanceBlock, true);
    }
  };

  const variableFieldMousedownHandler = (e) => {
    if (addon.self.disabled || e.button !== 1) return;

    // Check if clicking on a variable field
    let target = e.target;
    while (target && !target.classList?.contains("blocklyBlockCanvas")) {
      if (target.getAttribute?.("data-argument-type")) {
        // Found a variable field - find the parent block

        let blockEl = target;
        while (blockEl && !blockEl.classList?.contains("blocklyDraggable")) {
          blockEl = blockEl.parentElement;
        }

        if (blockEl) {
          const blockId = blockEl.getAttribute("data-id");
          const workspace = addon.tab.traps.getWorkspace();
          const block = workspace.getBlockById(blockId);

          if (handleBlockExplore(block)) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
        }
        break;
      }
      target = target.parentElement;
    }
  };

  // Store original Blockly method for cleanup
  const doBlockClickMethodName = Blockly.registry ? "doBlockClick" : "doBlockClick_";
  const _doBlockClick_ = Blockly.Gesture.prototype[doBlockClickMethodName];

  const doBlockClickOverride = function () {
    const event = Blockly.registry ? this.mostRecentEvent : this.mostRecentEvent_;
    if (!addon.self.disabled && (event.button === 1 || event.shiftKey)) {
      // Wheel button or shift-click - directly update carousel without opening dropdown
      let block = Blockly.registry ? this.startBlock : this.startBlock_;

      // If no block found but we have a startField, try to get the block from the field
      if (!block) {
        const startField = Blockly.registry ? this.startField : this.startField_;
        if (startField) {
          block = startField.getSourceBlock ? startField.getSourceBlock() : startField.sourceBlock_;
        }
      }

      if (handleBlockExplore(block)) {
        return;
      }
      return; // Block not handled, skip default click behavior for middle/shift click
    }

    _doBlockClick_.call(this);
  };

  // Enable addon
  const enableAddon = () => {
    // Listen for events from jump-to-def addon to activate carousel
    document.addEventListener("scratch-addons-find-bar-activate", findBarActivateHandler);

    // Capture middle-clicks on variable fields before Blockly processes them
    document.addEventListener("mousedown", variableFieldMousedownHandler, true);

    // Override Blockly doBlockClick
    Blockly.Gesture.prototype[doBlockClickMethodName] = doBlockClickOverride;
  };

  // Disable addon
  const disableAddon = () => {
    // Remove event listeners
    document.removeEventListener("scratch-addons-find-bar-activate", findBarActivateHandler);
    document.removeEventListener("mousedown", variableFieldMousedownHandler, true);

    // Restore original Blockly method
    Blockly.Gesture.prototype[doBlockClickMethodName] = _doBlockClick_;
  };

  // Add context menu items for exploring blocks
  addon.tab.createBlockContextMenu(
    (items, block) => {
      if (addon.self.disabled) return items;

      // Check if this block type can be explored
      if (canBlockBeExplored(block)) {
        items.push({
          enabled: true,
          text: msg("explore-usages"),
          callback: () => handleBlockExplore(block),
        });
      }

      return items;
    },
    { blocks: true, flyout: true }
  );

  // Listen for addon state changes
  addon.self.addEventListener("disabled", disableAddon);
  addon.self.addEventListener("reenabled", enableAddon);

  // Initial enable
  enableAddon();

  addon.tab.redux.initialize();
  addon.tab.redux.addEventListener("statechanged", (e) => {
    if (e.detail.action.type === "scratch-gui/navigation/ACTIVATE_TAB") {
      findBar.tabChanged();
    }
  });

  while (true) {
    const root = await addon.tab.waitForElement("ul[class*=gui_tab-list_]", {
      markAsSeen: true,
      reduxEvents: ["scratch-gui/mode/SET_PLAYER", "fontsLoaded/SET_FONTS_LOADED", "scratch-gui/locales/SELECT_LOCALE"],
      reduxCondition: (state) => !state.scratchGui.mode.isPlayerOnly,
    });
    findBar.createDom(root);
  }
}
