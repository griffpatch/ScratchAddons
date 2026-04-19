# ScratchAddons Addon Development Notes

Personal reference for developing and porting addons in this repo.

---

## Architecture

**Scratch Addons is a Manifest V3 browser extension.** Addons are independent — each can be enabled/disabled at runtime without affecting others.

### Execution flow
1. **Background service worker** (`background/background.js`): loads manifests, filters enabled addons by URL
2. **Content script** (`content-scripts/cs.js`): injects at `document_start`, waits for background
3. **Module injection** (`content-scripts/inject/module.js`): runs userscripts in *page context* (not content script context) via ES modules + Comlink
4. **Userscript**: `export default async function({ addon, msg, console }) {}`

> Userscripts run in **page context** — full access to `window`, Blockly, React, etc. No `chrome.*` APIs (use messaging via Comlink for that).

### Critical addon rules
- Never depend on another addon being enabled
- Always check `addon.self.disabled` in persistent event handlers when using `dynamicDisable: true`
- Clean up via `addon.self.addEventListener("disabled", cleanup)`
- Work correctly when enabled late (after page load)

---

## Repo layout

```
addons/<name>/addon.json        — manifest (permissions, scripts, settings)
addons/<name>/userscript.js    — content script
addons/<name>/userstyle.css    — injected CSS
addons-l10n/en/<name>.json     — English i18n strings
libraries/common/cs/           — shared content-script utilities (always check here first!)
libraries/thirdparty/cs/       — third-party libs (fuse, tinycolor, text-field-edit, etc.)
addon-api/                     — SA addon API (read-only)
_locales/                      — extension UI translations (NOT addon strings)
webpages/                      — settings page, popup, other extension pages
```

---

## addon.json essentials

- `runAtComplete: false` — runs before React mounts; redux listeners won't fire until store exists (see Redux section)
- `permissions: ["clipboardWrite"]` — must declare browser permissions used
- `injectAsStyleElt: true` — inject userstyle as `<style>` instead of `<link>`
- `dynamicEnable` / `dynamicDisable` — whether the addon can be toggled without a page reload
- `matches: ["projects"]` — page patterns: `"projects"`, `"profiles"`, `"studios"`, or full URLs
- `settings` — user configuration; `type: "color"` auto-generates `--addonId-settingName` CSS variables (use `updateUserstylesOnSettingsChange: true` to live-update)

---

## Userscript entry point

```js
export default async function ({ addon, msg, console }) {
  const Blockly = await addon.tab.traps.getBlockly();
  // ...
}
```

---

## Addon API reference

```js
addon.tab.traps.getBlockly()              // Await Blockly instance
addon.tab.traps.getWorkspace()            // Current Blockly workspace (changes on sprite switch)
addon.tab.traps.vm                        // Scratch VM runtime
addon.tab.redux.state                     // Redux state (always readable)
addon.tab.redux.initialize()              // Enable statechanged listeners (see Redux timing)
addon.tab.redux.addEventListener("statechanged", cb)
addon.tab.waitForElement(selector, opts) // Promise-based DOM query
addon.tab.scratchClass("module_class")   // Resolve minified CSS class name
addon.tab.displayNoneWhileDisabled(el)   // Auto-hide element when addon disabled
addon.tab.editorMode                     // "editor" | "player" | "fullscreen" | null
addon.settings.get("key")               // User setting value
addon.self.disabled                      // Is addon currently disabled?
msg("key", { placeholder: value })       // Localized string
```

---

## Dynamic enable/disable pattern

Always guard persistent listeners when `dynamicDisable: true`:

```js
document.addEventListener("keydown", (e) => {
  if (addon.self.disabled) return; // Required
  // ...
}, true);

addon.self.addEventListener("disabled", () => {
  // clean up DOM, cancel animations, etc.
});
addon.self.addEventListener("reenabled", () => {
  // reinitialize if needed
});
```

---

## Reusable utilities (always check before implementing)

**Check `libraries/common/cs/` first** — duplicating these is a common mistake.

| File | Exports |
|---|---|
| `devtools-utils.js` | `getTopBlocks(ws)`, `getTopOfStackFor(block)`, `getVariableUsesById(id, ws)` |
| `block-scrolling.js` | `initializeSmoothScrolling`, `scrollBlockIntoViewIfNeeded`, `animateScrollTo`, `scrollPosFromOffset` |
| `update-all-blocks.js` | `updateAllBlocks(tab, opts)` — refresh workspace after programmatic changes |
| `text-color.esm.js` | `parseHex`, `brighten`, `multiply`, `alphaBlend` |
| `autoescaper.js` | `escapeHTML(str)` |
| `small-stage.js` | `addSmallStageClass()` — shrink stage for addon UI |
| `download-blob.js` | `downloadBlob(filename, blob)` |
| `rate-limiter.js` | Throttle/debounce |

Third-party (`libraries/thirdparty/cs/`): `fuse.esm.min.js` (fuzzy search), `tinycolor-min.js`, `text-field-edit.js`, `spark-md5.min.js`

---

## i18n

Keys live in `addons-l10n/en/<addon-name>.json`:

```json
{
  "addon-name/key-name": "String with {placeholder}",
  "addon-name/key-complex": {
    "string": "Text {var}",
    "developer_comment": "Explanation for translators"
  }
}
```

Access in userscript:

```js
msg("key-name")
msg("key-name", { placeholder: value })
msg("/_general/blocks/green-flag")   // cross-addon key
```

Missing keys print `SA[page] Key missing: addon-name/key` to the console.

---

## Blockly trapping

```js
const Blockly = await addon.tab.traps.getBlockly();  // wait for Blockly
const workspace = addon.tab.traps.getWorkspace();    // call per-use (changes on sprite switch)
```

Patch prototypes **after** awaiting `getBlockly()`.

---

## New Blockly vs old Blockly

Detection:

```js
if (Blockly.registry) { /* new Blockly (RPi fork v12+) */ }
else              { /* old Blockly */ }
```

| Concept | Old Blockly | New Blockly |
|---|---|---|
| Block SVG path | `block.svgPath_` | `block.pathObject.svgPath` |
| Field → block | `field.sourceBlock_` | `field.getSourceBlock()` |
| Gesture start block | `gesture.startBlock_` | `gesture.startBlock` |
| Gesture start field | `gesture.startField_` | `gesture.startField` |
| Scrollbar internals | `hScroll`, `vScroll`, `handlePosition_`, `ratio_`, `getRatio_`, `scrollViewSize_` | **do not exist** |
| Scroll apply | `setMetrics({x, y})` + handle positions | `workspace.scrollbar.set(sx, sy)` |
| Metrics content origin | `contentLeft` / `contentTop` | `scrollLeft` / `scrollTop` |

Safe field→block pattern:

```js
const block = field.getSourceBlock ? field.getSourceBlock() : field.sourceBlock_;
```

Safe metrics origin:

```js
const scrollLeft = metrics.scrollLeft ?? metrics.contentLeft ?? 0;
const scrollTop  = metrics.scrollTop  ?? metrics.contentTop  ?? 0;
```

---

## Workspace metrics

```js
const metrics = workspace.getMetrics();
// metrics.viewLeft, viewTop, viewWidth, viewHeight  — viewport in workspace pixels
// current scroll position passed to scrollbar.set():
const sx = metrics.viewLeft - scrollLeft;
const sy = metrics.viewTop  - scrollTop;
```

---

## Smooth scrolling (`libraries/common/cs/block-scrolling.js`)

```js
import {
  initializeSmoothScrolling,
  scrollBlockIntoViewIfNeeded,
  animateScrollTo,
  scrollPosFromOffset,
} from "../../libraries/common/cs/block-scrolling.js";

// Call once after Blockly is ready
initializeSmoothScrolling(Blockly);

// Scroll a block into view (async, smooth)
await scrollBlockIntoViewIfNeeded(workspace, block, offsetX, offsetY, instant);

// Direct animated scroll to position
await animateScrollTo(workspace, sx, sy);

// Convert pixel offset → scroll position
const { sx, sy } = scrollPosFromOffset({ left: targetX, top: targetY }, metrics);
```

`createSmoothScrollAnimator(blockly)` handles both Blockly versions via `createScrollAdapter`.

---

## Prototype patching

```js
// Getter property
Object.defineProperty(Blockly.Gesture.prototype, "exploreBlocks", {
  get() { return !addon.self.disabled; },
});

// Method wrap
const orig = Blockly.SomeClass.prototype.method;
Blockly.SomeClass.prototype.method = function (...args) {
  // custom logic
  return orig.apply(this, args);
};
```

---

## Component registration (avoid duplicate crash)

```js
// Always remove before adding — re-opening without closing can leave a stale registration
addon.tab.removeComponent("myComponentId");
addon.tab.addComponent("myComponentId", myComponent);
```

---

## Redux timing with `runAtComplete: false`

When `runAtComplete: false`, React hasn't mounted yet, so `redux.initialize()` finds no store and all `statechanged` listeners are silently dead.

```js
addon.tab.redux.initialize();
if (!addon.tab.redux.initialized) {
  (async () => {
    while (!window.__scratchAddonsRedux?.target) {
      await new Promise((r) => setTimeout(r, 50));
    }
    addon.tab.redux.initialize(); // succeeds; previously-registered listeners now fire
  })();
}
```

State reads (`addon.tab.redux.state`) always work regardless.

---

## Creating a new addon checklist

1. `addons/addons.json` — add the addon ID (position = settings page order)
2. `addons/<name>/addon.json` — required fields: `name`, `description`, `userscripts`/`userstyles`, `versionAdded`, `tags`
3. `addons/<name>/userscript.js` — export default async function
4. `addons-l10n/en/<name>.json` — English strings
5. Reload extension in Chrome (`chrome://extensions` → reload button) — no build step needed
6. Test dynamic enable/disable if `dynamicEnable: true`
7. Test with `runAtComplete: false` if using early injection

**No build required.** Load unpacked from repo root. Firefox: `about:debugging` → Load Temporary Add-on → `manifest.json`.

---

## Packaging for sharing

```powershell
git archive dev --format=zip --output=scratch-addons-dev.zip
```

---

## Branch strategy

```
upstream/master          — Scratch Foundation's master (fetch-only)
      │
personal/base            ← branch here for new features (has this file)
      │
feature/<name>           ← one branch per feature/addon
```

- Branch new features from `personal/base`, not `upstream/master`
- Keep commits minimal and scoped
- Rebase `personal/base` onto `upstream/master` after upstream updates
