export default async function ({ addon, msg, console }) {
  // ─── Toolbar button (single icon) ─────────────────────────────────────────
  // Created first so the button appears immediately even if later imports fail.

  const nav = await addon.tab.waitForElement("[class*='menu-bar_account-info-group_'] > [href^='/mystuff']", {
    markAsSeen: true,
  });

  const toolbarBtn = Object.assign(document.createElement("button"), {
    className: addon.tab.scratchClass("menu-bar_menu-bar-item", "menu-bar_hoverable") + " sa-inspector-btn",
    title: msg("inspect-button"),
    innerHTML: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
      <circle cx="6.5" cy="6.5" r="4.5"/>
      <line x1="10" y1="10" x2="14" y2="14"/>
    </svg>`,
  });
  addon.tab.displayNoneWhileDisabled(toolbarBtn);
  nav.parentElement.insertBefore(toolbarBtn, nav);
  toolbarBtn.addEventListener("click", handleToolbarClick);

  // ─── Lazy imports (deferred until first use) ───────────────────────────────
  // Keeping these lazy means a syntax error in parser/converter files won't
  // prevent the toolbar button from appearing.

  let _parsePseudocode = null;
  async function getParsePseudocode() {
    if (!_parsePseudocode) {
      const mod = await import("./pseudocode-parser.js");
      _parsePseudocode = mod.parsePseudocode;
    }
    return _parsePseudocode;
  }

  let _astToBlocks = null;
  async function getAstToBlocks() {
    if (!_astToBlocks) {
      const mod = await import("./ast-to-blocks.js");
      _astToBlocks = mod.astToBlocks;
    }
    return _astToBlocks;
  }

  let _diffProjects = null;
  async function getDiffProjects() {
    if (!_diffProjects) {
      const mod = await import("./project-differ.js");
      _diffProjects = mod.diffProjects;
    }
    return _diffProjects;
  }

  let _normalizeNodeForDisplay = null;
  async function getNormalizeNodeForDisplay() {
    if (!_normalizeNodeForDisplay) {
      const mod = await import("./project-differ.js");
      _normalizeNodeForDisplay = mod.normalizeNodeForDisplay;
    }
    return _normalizeNodeForDisplay;
  }

  let _blockToIR = null;
  async function getBlockToIR() {
    if (!_blockToIR) {
      const mod = await import("./block-ir.js");
      _blockToIR = mod.blockToIR;
    }
    return _blockToIR;
  }

  // Smooth-scrolling helpers — only needed when navigating to a block.
  let _scrollBlockIntoViewIfNeeded = null;
  let _initializeSmoothScrolling = null;
  async function ensureScrollingLoaded() {
    if (!_scrollBlockIntoViewIfNeeded) {
      const mod = await import("../../../libraries/common/cs/block-scrolling.js");
      _scrollBlockIntoViewIfNeeded = mod.scrollBlockIntoViewIfNeeded;
      _initializeSmoothScrolling = mod.initializeSmoothScrolling;
    }
  }

  // ─── Blockly / flash helpers (use lazy imports) ───────────────────────────

  let blocklyReady = false;
  async function ensureBlocklyReady() {
    if (blocklyReady) return;
    await ensureScrollingLoaded();
    const Blockly = await addon.tab.traps.getBlockly();
    _initializeSmoothScrolling(Blockly);
    blocklyReady = true;
  }

  let _flashTimer = 0;
  let _flashBlock = null;
  function flashBlock(block) {
    if (_flashTimer) clearTimeout(_flashTimer);
    const getPath = (b) => b?.pathObject?.svgPath ?? b?.svgPath_ ?? null;
    let count = 4,
      on = true;
    _flashBlock = block;
    const _tick = () => {
      const path = getPath(_flashBlock);
      if (path) path.style.fill = on ? "#ffff80" : "";
      on = !on;
      count--;
      if (count > 0) {
        _flashTimer = setTimeout(_tick, 200);
      } else {
        _flashTimer = 0;
        if (path) path.style.fill = "";
        _flashBlock = null;
      }
    };
    _tick();
  }

  // ─── Panel state ───────────────────────────────────────────────────────────

  // ─── Library DB ─────────────────────────────────────────────────────────────

  const DB_NAME = "sa-inspector-library";
  const DB_STORE = "episodes";
  let _db = null;

  async function openDB() {
    if (_db) return _db;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          db.createObjectStore(DB_STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = (e) => {
        _db = e.target.result;
        resolve(_db);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function dbSaveEpisode(ep) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).put(ep);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function dbGetAll() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).getAll();
      req.onsuccess = () => resolve(req.result ?? []);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbDelete(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ─── Fingerprinting & scoring ─────────────────────────────────────────────

  // Collect all opcodes reachable from a top-level block (DFS: inputs then next).
  function collectOpcodes(blocks, startId) {
    const opcodes = [];
    const seen = new Set();
    const visit = (id) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      const b = blocks[id];
      if (!b || b.shadow) return;
      opcodes.push(b.opcode);
      for (const input of Object.values(b.inputs ?? {})) {
        if (typeof input[1] === "string") visit(input[1]);
      }
      if (b.next) visit(b.next);
    };
    visit(startId);
    return opcodes;
  }

  // Build a fingerprint: array of sprite descriptors with opcode bags.
  function fingerprintProject(project) {
    return (project.targets ?? []).map((target) => {
      const blocks = target.blocks ?? {};
      const topIds = Object.keys(blocks).filter((id) => blocks[id].topLevel && !blocks[id].shadow);
      const allOpcodes = topIds.flatMap((id) => collectOpcodes(blocks, id));
      return { name: target.name, isStage: !!target.isStage, allOpcodes };
    });
  }

  // Return a copy of the project JSON safe to store in IndexedDB.
  // Variable values and list contents are stripped (neither is used by the differ,
  // and list contents can be very large in some projects).
  function strippedProjectForDiff(project) {
    return {
      ...project,
      targets: (project.targets ?? []).map((target) => ({
        ...target,
        variables: Object.fromEntries(Object.entries(target.variables ?? {}).map(([id, [name]]) => [id, [name, 0]])),
        lists: Object.fromEntries(Object.entries(target.lists ?? {}).map(([id, [name]]) => [id, [name, []]])),
      })),
    };
  }

  // Jaccard similarity on two opcode arrays treated as multisets.
  function jaccardMultiset(a, b) {
    if (a.length === 0 && b.length === 0) return 1;
    const ca = {},
      cb = {};
    for (const x of a) ca[x] = (ca[x] ?? 0) + 1;
    for (const x of b) cb[x] = (cb[x] ?? 0) + 1;
    const keys = new Set([...Object.keys(ca), ...Object.keys(cb)]);
    let inter = 0,
      union = 0;
    for (const k of keys) {
      inter += Math.min(ca[k] ?? 0, cb[k] ?? 0);
      union += Math.max(ca[k] ?? 0, cb[k] ?? 0);
    }
    return union === 0 ? 0 : inter / union;
  }

  // Score a current project fingerprint against an episode fingerprint.
  // Returns { score 0-1, spritesMatched, spriteCount }.
  function scoreAgainst(currentFP, episodeFP) {
    const relevant = episodeFP.filter((s) => s.allOpcodes.length > 0);
    if (relevant.length === 0) return { score: 0, spritesMatched: 0, spriteCount: 0 };
    let total = 0,
      matched = 0;
    for (const ref of relevant) {
      let best = 0;
      for (const cur of currentFP) {
        const s = jaccardMultiset(cur.allOpcodes, ref.allOpcodes);
        if (s > best) best = s;
      }
      total += best;
      if (best > 0.15) matched++;
    }
    return { score: total / relevant.length, spritesMatched: matched, spriteCount: relevant.length };
  }

  // ─── Panel state ─────────────────────────────────────────────────────────────

  // tabs[0] = Current (permanent); tabs[1] = Compare (permanent, chooser/reference states); tabs[2+] = Issues (closeable)
  const tabs = [];
  let activeTabIndex = 0;
  let panel = null;
  let tabBar = null;
  let textContent = null; // <pre> for Current tab
  let currentHeader = null; // header bar above current pseudocode
  let currentWrap = null; // column wrapper: currentHeader + textContent
  let compareContent = null; // <div> for Compare tab
  let issuesContent = null; // <div> for Issues tabs
  let overlayCopyBtn = null;
  let overlayInjectBtn = null;
  let currentFingerprint = null;
  let currentMatchSort = "relevance";

  // ─── Panel builder ─────────────────────────────────────────────────────────

  function createPanel() {
    panel = Object.assign(document.createElement("div"), { className: "sa-inspector-panel" });

    // Toolbar: tab strip + close button only
    const toolbar = Object.assign(document.createElement("div"), { className: "sa-inspector-toolbar" });
    tabBar = Object.assign(document.createElement("div"), { className: "sa-inspector-tabs" });

    const actions = Object.assign(document.createElement("div"), { className: "sa-inspector-toolbar-actions" });
    const closeBtn = Object.assign(document.createElement("button"), {
      className: "sa-inspector-close-btn",
      textContent: "✕",
    });
    closeBtn.addEventListener("click", () => {
      panel.remove();
      panel = null;
    });
    actions.appendChild(closeBtn);
    toolbar.append(tabBar, actions);

    // Drag the panel by the toolbar
    makeDraggable(toolbar, panel);

    // Body: three content areas, one visible at a time
    const body = Object.assign(document.createElement("div"), { className: "sa-inspector-body" });

    textContent = Object.assign(document.createElement("pre"), { className: "sa-inspector-content" });

    // Header bar for Current tab: free-form question / request input
    currentHeader = Object.assign(document.createElement("div"), { className: "sa-inspector-compare-ref-header" });
    const bugInput = Object.assign(document.createElement("input"), {
      type: "text",
      className: "sa-inspector-bug-input",
      placeholder: "Ask anything about this project… (e.g. why can't I…  /  write a script to…)",
    });
    const bugBtn = Object.assign(document.createElement("button"), {
      className: "sa-inspector-action-btn",
      textContent: hasApiToken() ? "🔍 Ask AI" : "🔍 Ask ChatGPT",
    });
    const triggerBugPrompt = async () => {
      const desc = bugInput.value.trim();
      if (!desc) return;
      let promptText;
      try {
        const project = getCurrentProjectFromVM();
        promptText = buildAskPrompt(await projectToPseudocode(project), desc);
      } catch (e) {
        alert(msg("fetch-error", { error: String(e) }));
        return;
      }
      const newTab = { type: "issues", label: "💬 Ask", issueState: "paste", content: "", cards: [] };
      tabs.push(newTab);
      switchTab(tabs.length - 1);
      renderTabs();
      bugInput.value = "";
      if (hasApiToken()) {
        void streamToIssuesTab(promptText, newTab);
      } else {
        void navigator.clipboard.writeText(promptText);
      }
    };
    bugBtn.addEventListener("click", () => void triggerBugPrompt());
    bugInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void triggerBugPrompt();
    });

    // Parse test button — runs the pseudocode parser and shows the AST in an Issues tab
    const parseTestBtn = Object.assign(document.createElement("button"), {
      className: "sa-inspector-action-btn",
      title: "Parse pseudocode → AST (developer tool)",
      textContent: "🧪 Parse",
    });
    parseTestBtn.addEventListener("click", async () => {
      const pseudo = tabs.find((t) => t.type === "current")?.content ?? "";
      if (!pseudo) {
        alert("No pseudocode loaded — open a project first.");
        return;
      }
      const parsePseudocode = await getParsePseudocode();
      const { scripts, warnings } = parsePseudocode(pseudo);
      const summary = [
        `## Parse result`,
        ``,
        `**${scripts.length} scripts** parsed, **${warnings.length} warnings**`,
        ``,
        warnings.length > 0
          ? `### Warnings\n${warnings
              .map((w) => `- Line ${w.lineNo}: ${w.message}${w.raw ? ` — \`${w.raw}\`` : ""}`)
              .join("\n")}`
          : "",
        ``,
        `### Scripts`,
        ...scripts.map((s, i) =>
          [
            `#### Script ${i + 1} — ${s.spriteName ?? "?"} | ${s.hat?.raw ?? "(no hat)"}`,
            "```",
            JSON.stringify({ hat: s.hat, body: s.body }, null, 2),
            "```",
          ].join("\n")
        ),
      ]
        .filter((l) => l !== "")
        .join("\n");

      const newTab = {
        type: "issues",
        label: "🧪 AST",
        issueState: "cards",
        content: summary,
        cards: [],
        _parseSrc: pseudo,
        _parseWarnings: warnings,
        _parseScripts: scripts,
      };
      tabs.push(newTab);
      switchTab(tabs.length - 1);
      renderTabs();
    });

    currentHeader.append(bugInput, bugBtn, parseTestBtn);

    compareContent = Object.assign(document.createElement("div"), {
      className: "sa-inspector-content sa-inspector-matches",
    });
    compareContent.style.display = "none";

    issuesContent = Object.assign(document.createElement("div"), {
      className: "sa-inspector-content sa-inspector-issues",
    });
    issuesContent.style.display = "none";

    overlayCopyBtn = Object.assign(document.createElement("button"), {
      className: "sa-inspector-overlay-copy",
      title: msg("copy-button"),
      textContent: "📋",
    });
    overlayCopyBtn.style.display = "none";
    overlayCopyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(tabs[activeTabIndex]?.content ?? "");
      overlayCopyBtn.textContent = "✓";
      setTimeout(() => (overlayCopyBtn.textContent = "📋"), 1500);
    });

    overlayInjectBtn = Object.assign(document.createElement("button"), {
      className: "sa-inspector-overlay-inject",
      title: "Inject all scripts into editor",
      textContent: "💉",
    });
    overlayInjectBtn.style.display = "none";
    overlayInjectBtn.addEventListener("click", () => {
      const tab = tabs[activeTabIndex];
      const scripts = tab?._parseScripts;
      if (!scripts?.length) return;
      overlayInjectBtn.disabled = true;
      overlayInjectBtn.textContent = "⏳";
      const lines = [];
      let pending = scripts.length;
      let anyFailed = false;
      for (const script of scripts) {
        doInjectScript(
          script,
          (msg) => {
            lines.push(msg);
            console.log("[inspector:inject-all]", msg);
          },
          (ok) => {
            if (!ok) anyFailed = true;
            pending--;
            if (pending === 0) {
              overlayInjectBtn.disabled = false;
              overlayInjectBtn.textContent = anyFailed ? "❌" : "✅";
              setTimeout(() => {
                overlayInjectBtn.textContent = "💉";
              }, 3000);
              if (anyFailed) {
                // Show the log in a quick overlay so the user can see what went wrong
                const errLog = lines
                  .filter(
                    (l) => l.includes("❌") || l.includes("⚠️") || l.includes("MISSING") || l.includes("EXCEPTION")
                  )
                  .join("\n");
                if (errLog) alert(`Inject failed:\n\n${errLog}`);
              }
            }
          }
        );
      }
    });

    // Wrap currentHeader + textContent in a column so header sits above code
    currentWrap = Object.assign(document.createElement("div"), { className: "sa-inspector-current-wrap" });
    currentWrap.style.display = "none";
    currentWrap.append(currentHeader, textContent);

    body.append(currentWrap, compareContent, issuesContent, overlayCopyBtn, overlayInjectBtn);
    panel.append(toolbar, body);
    // Resize handles (native CSS `resize` only offers a bottom-right corner grip
    // and can't do the left edge at all). The right edge/corners are deliberately
    // omitted — that's where the content scrollbar lives, and a resize handle
    // there makes the scrollbar hard to grab.
    for (const dir of ["n", "s", "w", "nw", "sw"]) {
      panel.appendChild(makeResizeHandle(dir, panel));
    }
    document.body.appendChild(panel);
  }

  const MIN_PANEL_WIDTH = 320;
  const MIN_PANEL_HEIGHT = 200;

  // Make `targetEl` draggable by mousedown-dragging `handleEl` (e.g. a toolbar).
  // Switches `targetEl` from right-anchored to left-anchored on the first drag
  // so subsequent moves are simple absolute positioning.
  function makeDraggable(handleEl, targetEl) {
    handleEl.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      e.preventDefault();
      const rect = targetEl.getBoundingClientRect();
      targetEl.style.right = "";
      targetEl.style.left = rect.left + "px";
      targetEl.style.top = rect.top + "px";
      const ox = e.clientX - rect.left;
      const oy = e.clientY - rect.top;
      const onMove = (me) => {
        targetEl.style.left = Math.max(0, Math.min(me.clientX - ox, window.innerWidth - 60)) + "px";
        targetEl.style.top = Math.max(0, Math.min(me.clientY - oy, window.innerHeight - 40)) + "px";
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  // Build a drag handle for one edge/corner of `targetEl`. `dir` is a subset of
  // "nsew" indicating which edges move: "w"/"e" adjust width (and left, for "w"),
  // "n"/"s" adjust height (and top, for "n"); corners combine both.
  function makeResizeHandle(dir, targetEl) {
    const handle = Object.assign(document.createElement("div"), {
      className: `sa-inspector-resize-handle sa-inspector-resize-${dir}`,
    });
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = targetEl.getBoundingClientRect();
      // Normalise to explicit left/top/width/height so every edge resizes
      // predictably, regardless of whether the element is still right-anchored
      // via CSS `right` (see makeDraggable, which does the same normalisation).
      targetEl.style.right = "";
      targetEl.style.left = rect.left + "px";
      targetEl.style.top = rect.top + "px";
      targetEl.style.width = rect.width + "px";
      targetEl.style.height = rect.height + "px";
      const startX = e.clientX;
      const startY = e.clientY;
      const startLeft = rect.left;
      const startTop = rect.top;
      const startWidth = rect.width;
      const startHeight = rect.height;

      const onMove = (me) => {
        const dx = me.clientX - startX;
        const dy = me.clientY - startY;
        if (dir.includes("w")) {
          const newWidth = Math.max(MIN_PANEL_WIDTH, startWidth - dx);
          targetEl.style.left = startLeft + (startWidth - newWidth) + "px";
          targetEl.style.width = newWidth + "px";
        } else if (dir.includes("e")) {
          targetEl.style.width = Math.max(MIN_PANEL_WIDTH, startWidth + dx) + "px";
        }
        if (dir.includes("n")) {
          const newHeight = Math.max(MIN_PANEL_HEIGHT, startHeight - dy);
          targetEl.style.top = startTop + (startHeight - newHeight) + "px";
          targetEl.style.height = newHeight + "px";
        } else if (dir.includes("s")) {
          targetEl.style.height = Math.max(MIN_PANEL_HEIGHT, startHeight + dy) + "px";
        }
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
    return handle;
  }

  function applyTab(index) {
    const tab = tabs[index];
    if (!tab) return;
    const isCurrent = tab.type === "current";
    const isCompare = tab.type === "compare";
    const isIssues = tab.type === "issues";
    currentWrap.style.display = isCurrent ? "" : "none";
    compareContent.style.display = isCompare ? "" : "none";
    issuesContent.style.display = isIssues ? "" : "none";
    overlayCopyBtn.style.display = isCurrent ? "" : "none";
    overlayInjectBtn.style.display = isIssues && tab._parseScripts?.length > 0 ? "" : "none";
    if (isCurrent) textContent.textContent = tab.content ?? "";
    if (isCompare) void renderCompareTab(tab);
    if (isIssues) void renderIssuesContent(tab);
  }

  // ─── Compare tab rendering ────────────────────────────────────────────────

  async function renderCompareTab(tab) {
    compareContent.innerHTML = "";
    if (tab.compareState === "reference") {
      renderCompareReference(tab);
    } else {
      await renderCompareChooser(tab);
    }
  }

  async function renderCompareChooser(tab) {
    // Controls row: sort + save-episode button
    const controls = Object.assign(document.createElement("div"), { className: "sa-inspector-matches-controls" });
    const sortLabel = Object.assign(document.createElement("span"), {
      className: "sa-inspector-matches-sort-label",
      textContent: "Sort: ",
    });
    const sortSelect = Object.assign(document.createElement("select"), { className: "sa-inspector-matches-sort" });
    for (const [val, lbl] of [
      ["relevance", "By relevance"],
      ["tutorial", "By tutorial"],
    ]) {
      const opt = Object.assign(document.createElement("option"), { value: val, textContent: lbl });
      if (val === currentMatchSort) opt.selected = true;
      sortSelect.appendChild(opt);
    }
    sortSelect.addEventListener("change", () => {
      currentMatchSort = sortSelect.value;
      void renderCompareChooser(tab);
    });
    const saveEpBtn = Object.assign(document.createElement("button"), {
      className: "sa-inspector-action-btn sa-inspector-matches-import-btn",
      textContent: "💾 Add episode to DB",
    });
    saveEpBtn.addEventListener("click", handleImportEpisode);
    controls.append(sortLabel, sortSelect, saveEpBtn);
    compareContent.appendChild(controls);

    // Library match rows
    const episodes = await dbGetAll();
    if (episodes.length === 0) {
      compareContent.appendChild(
        Object.assign(document.createElement("p"), {
          className: "sa-inspector-matches-empty",
          textContent: "No episodes saved yet. Load a reference .sb3 below and click 💾 Save episode to add it.",
        })
      );
    } else {
      const results = episodes.map((ep) => ({
        episode: ep,
        ...scoreAgainst(currentFingerprint ?? [], ep.fingerprint ?? []),
      }));
      const sorted = [...results].sort(
        currentMatchSort === "relevance"
          ? (a, b) => b.score - a.score
          : (a, b) => (a.episode.tutorial + a.episode.label).localeCompare(b.episode.tutorial + b.episode.label)
      );
      for (const result of sorted) {
        compareContent.appendChild(buildMatchRow(result.episode, currentFingerprint ? result : null));
      }
    }

    // Load / Fetch section
    const divider = Object.assign(document.createElement("div"), { className: "sa-inspector-compare-divider" });
    compareContent.appendChild(divider);
    const loadSection = Object.assign(document.createElement("div"), {
      className: "sa-inspector-compare-load-section",
    });
    const loadBtn = Object.assign(document.createElement("button"), {
      className: "sa-inspector-action-btn sa-inspector-compare-load-btn",
      textContent: "📂 Load .sb3 file",
    });
    loadBtn.addEventListener("click", handleLoadSb3);
    const fetchBtn = Object.assign(document.createElement("button"), {
      className: "sa-inspector-action-btn sa-inspector-compare-load-btn",
      textContent: "🔗 Fetch project by ID",
    });
    fetchBtn.addEventListener("click", handleFetchById);
    loadSection.append(loadBtn, fetchBtn);
    compareContent.appendChild(loadSection);
  }

  function renderCompareReference(tab) {
    const header = Object.assign(document.createElement("div"), { className: "sa-inspector-compare-ref-header" });
    const labelEl = Object.assign(document.createElement("span"), {
      className: "sa-inspector-compare-ref-label",
      textContent: tab.referenceLabel ?? "Reference",
    });
    const analyzeBtn = Object.assign(document.createElement("button"), {
      className: "sa-inspector-action-btn",
      textContent: hasApiToken() ? "📊 Analyse with AI" : "📊 Copy & open issues tab",
    });
    analyzeBtn.addEventListener("click", () => void handleCopyAndAnalyze(tab));
    const copyPromptBtn = Object.assign(document.createElement("button"), {
      className: "sa-inspector-action-btn",
      title: "Copy comparison prompt to clipboard (for pasting into any LLM)",
      textContent: "📋",
    });
    copyPromptBtn.addEventListener("click", async () => {
      try {
        const studentProject = getCurrentProjectFromVM();
        const studentCode = await projectToComparePseudocode(studentProject);
        const promptText = buildComparisonPrompt(studentCode, tab.referenceContent, tab.referenceLabel);
        void navigator.clipboard.writeText(promptText).then(() => {
          copyPromptBtn.textContent = "✓";
          setTimeout(() => {
            copyPromptBtn.textContent = "📋";
          }, 1500);
        });
      } catch (e) {
        alert(msg("fetch-error", { error: String(e) }));
      }
    });
    const quickDiffBtn = Object.assign(document.createElement("button"), {
      className: "sa-inspector-action-btn",
      textContent: "🔍 Quick Diff",
      title: tab.referenceProject
        ? "Programmatic diff — no AI needed"
        : "Re-save this episode (💾 Add episode to DB) to enable Quick Diff",
    });
    quickDiffBtn.disabled = !tab.referenceProject;
    if (!tab.referenceProject) quickDiffBtn.style.opacity = "0.45";
    quickDiffBtn.addEventListener("click", () => void handleQuickDiff(tab));
    header.append(labelEl, analyzeBtn, quickDiffBtn, copyPromptBtn);
    compareContent.appendChild(header);

    const pre = Object.assign(document.createElement("pre"), {
      className: "sa-inspector-compare-ref-pre",
      textContent: tab.referenceContent ?? "",
    });
    compareContent.appendChild(pre);
  }

  function loadCompareReference(label, content, referenceProject = null) {
    const compareTab = tabs.find((t) => t.type === "compare");
    if (!compareTab) return;
    compareTab.compareState = "reference";
    compareTab.referenceLabel = label;
    compareTab.referenceContent = content;
    compareTab.referenceProject = referenceProject;
    switchTab(tabs.indexOf(compareTab));
    renderTabs();
  }

  function revertCompareToChooser() {
    const compareTab = tabs.find((t) => t.type === "compare");
    if (!compareTab) return;
    compareTab.compareState = "chooser";
    compareTab.referenceLabel = "";
    compareTab.referenceContent = "";
    compareTab.referenceProject = null;
    const idx = tabs.indexOf(compareTab);
    if (activeTabIndex === idx) {
      void renderCompareTab(compareTab);
    } else {
      switchTab(idx);
    }
    renderTabs();
  }

  async function handleCopyAndAnalyze(tab) {
    let promptText;
    try {
      const studentProject = getCurrentProjectFromVM();
      const studentCode = await projectToComparePseudocode(studentProject);
      promptText = buildComparisonPrompt(studentCode, tab.referenceContent, tab.referenceLabel);
    } catch (e) {
      alert(msg("fetch-error", { error: String(e) }));
      return;
    }
    const newTab = { type: "issues", label: "⚠️ Issues", issueState: "paste", content: "", cards: [] };
    tabs.push(newTab);
    switchTab(tabs.length - 1);
    renderTabs();
    if (hasApiToken()) {
      void streamToIssuesTab(promptText, newTab, COMPARE_SYSTEM_PROMPT);
    } else {
      void navigator.clipboard.writeText(promptText);
    }
  }

  function buildMatchRow(ep, result) {
    const row = Object.assign(document.createElement("div"), { className: "sa-inspector-match-row" });
    const info = Object.assign(document.createElement("div"), { className: "sa-inspector-match-info" });
    info.appendChild(
      Object.assign(document.createElement("div"), {
        className: "sa-inspector-match-title",
        textContent: `${ep.tutorial} — ${ep.label}`,
      })
    );
    if (result) {
      const pct = Math.round(result.score * 100);
      info.appendChild(
        Object.assign(document.createElement("div"), {
          className: "sa-inspector-match-subtitle",
          textContent: `${result.spritesMatched}/${result.spriteCount} sprites matched`,
        })
      );
      const barWrap = Object.assign(document.createElement("div"), { className: "sa-inspector-match-bar-wrap" });
      const barTrack = Object.assign(document.createElement("div"), { className: "sa-inspector-match-bar-track" });
      const bar = Object.assign(document.createElement("div"), { className: "sa-inspector-match-bar" });
      bar.style.width = `${Math.round(pct * 1.2)}px`; // 120px track × pct/100
      bar.style.background = pct > 60 ? "#a6e3a1" : pct > 30 ? "#f9e2af" : "#f38ba8";
      barTrack.appendChild(bar);
      barWrap.append(
        barTrack,
        Object.assign(document.createElement("span"), {
          className: "sa-inspector-match-pct",
          textContent: `${pct}%`,
        })
      );
      info.appendChild(barWrap);
    }
    const btns = Object.assign(document.createElement("div"), { className: "sa-inspector-match-btns" });
    const openBtn = Object.assign(document.createElement("button"), {
      className: "sa-inspector-issue-go-btn",
      textContent: "Open",
    });
    openBtn.addEventListener("click", () => loadCompareReference(ep.label, ep.pseudocode, ep.diffProject ?? null));
    const delBtn = Object.assign(document.createElement("button"), {
      className: "sa-inspector-issue-go-btn sa-inspector-match-del",
      title: "Remove from library",
      textContent: "✕",
    });
    delBtn.addEventListener("click", async () => {
      if (confirm(`Remove "${ep.tutorial} — ${ep.label}" from library?`)) {
        await dbDelete(ep.id);
        const compareTab = tabs.find((t) => t.type === "compare");
        if (compareTab && compareTab.compareState === "chooser") void renderCompareTab(compareTab);
      }
    });
    btns.append(openBtn, delBtn);
    row.append(info, btns);
    return row;
  }

  async function handleImportEpisode() {
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".sb3,.sb2";
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        const project = await readSb3File(file);
        const defaultName = file.name.replace(/\.sb[23]$/i, "");
        const tutorial = (prompt("Tutorial name (e.g. 'Space Shooter'):", "") ?? "").trim();
        if (!tutorial) return;
        const label = (prompt("Episode label (e.g. 'Ep 3 – Enemies'):", defaultName) ?? "").trim();
        if (!label) return;
        await dbSaveEpisode({
          id: crypto.randomUUID(),
          tutorial,
          label,
          pseudocode: await projectToComparePseudocode(project),
          fingerprint: fingerprintProject(project),
          diffProject: strippedProjectForDiff(project),
          createdAt: Date.now(),
        });
        const compareTab = tabs.find((t) => t.type === "compare");
        if (compareTab && compareTab.compareState === "chooser") void renderCompareTab(compareTab);
      } catch (e) {
        alert(`Import failed: ${e}`);
      }
    });
    fileInput.click();
  }

  // ─── Core inject logic ────────────────────────────────────────────────────
  // Injects a single parsed script into the current editing target.
  // appendLog(msg) receives diagnostic lines; onDone(ok) is called when finished.
  async function doInjectScript(script, appendLog, onDone) {
    const vm = addon.tab.traps.vm;
    appendLog(`vm: ${vm ? "ok" : "MISSING"}`);
    if (!vm) {
      onDone(false);
      return;
    }
    appendLog(
      `editingTarget: ${vm.editingTarget ? `"${vm.editingTarget.name}" id=${vm.editingTarget.id}` : "MISSING"}`
    );
    if (!vm.editingTarget) {
      onDone(false);
      return;
    }

    const targetId = vm.editingTarget.id;
    const gui = addon.tab.redux.state?.scratchGui;
    appendLog(`redux.scratchGui: ${gui ? "ok" : "MISSING"}`);
    const reduxMetrics = gui?.workspaceMetrics?.targets?.[targetId];
    appendLog(
      `workspaceMetrics for target: ${reduxMetrics ? JSON.stringify(reduxMetrics) : "NOT FOUND — falling back to 0,0,1"}`
    );
    const scale = reduxMetrics?.scale ?? 1;
    const scrollX = reduxMetrics?.scrollX ?? 0;
    const scrollY = reduxMetrics?.scrollY ?? 0;
    const posX = (-scrollX + 30) / scale;
    const posY = (-scrollY + 30) / scale;
    appendLog(`placing at pos=(${posX.toFixed(1)}, ${posY.toFixed(1)})`);

    try {
      delete vm._unresolvedVars;
      const astToBlocks = await getAstToBlocks();
      const blocks = astToBlocks([script], vm, posX, posY);
      appendLog(`\nastToBlocks produced ${blocks.length} block(s):`);

      const stageTarget = vm.runtime?.getTargetForStage?.();
      const mkId = () => {
        let id = "";
        const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#%()*+,-./:;=?@[]^_`{|}~";
        for (let k = 0; k < 20; k++) id += chars[Math.floor(Math.random() * chars.length)];
        return id;
      };
      const createdVarIds = new Map();
      const createdListIds = new Map();
      const createdVars = [],
        createdLists = [];
      for (const block of blocks) {
        for (const [fieldName, field] of Object.entries(block.fields ?? {})) {
          if (field.id) continue;
          const name = field.value;
          if (fieldName === "VARIABLE") {
            if (!createdVarIds.has(name)) {
              const newId = mkId();
              vm.editingTarget.createVariable(newId, name, "");
              createdVarIds.set(name, newId);
              createdVars.push(name);
            }
            field.id = createdVarIds.get(name);
          } else if (fieldName === "LIST") {
            if (!createdListIds.has(name)) {
              const target = stageTarget ?? vm.editingTarget;
              const newId = mkId();
              target.createVariable(newId, name, "list");
              createdListIds.set(name, newId);
              createdLists.push(name);
            }
            field.id = createdListIds.get(name);
          }
        }
      }
      if (createdVars.length > 0) appendLog(`✅ Created variables: ${createdVars.map((n) => `"${n}"`).join(", ")}`);
      if (createdLists.length > 0) appendLog(`✅ Created lists: ${createdLists.map((n) => `"${n}"`).join(", ")}`);

      const missingIds = [];
      for (const block of blocks) {
        for (const [fieldName, field] of Object.entries(block.fields ?? {})) {
          if ((fieldName === "VARIABLE" || fieldName === "LIST") && !field.id) {
            missingIds.push(`${block.opcode}.${fieldName}="${field.value}"`);
          }
        }
      }
      if (missingIds.length > 0) appendLog(`⚠️ Fields still missing id after auto-create: ${missingIds.join(", ")}`);
      for (const b of blocks) {
        appendLog(`  [${b.id}] opcode=${b.opcode} topLevel=${b.topLevel} shadow=${b.shadow}`);
        appendLog(`    next=${b.next ?? "null"}  parent=${b.parent ?? "null"}`);
        appendLog(`    x=${b.x}  y=${b.y}`);
        if (Object.keys(b.fields).length > 0) appendLog(`    fields=${JSON.stringify(b.fields)}`);
        if (Object.keys(b.inputs).length > 0) appendLog(`    inputs=${JSON.stringify(b.inputs)}`);
        if (b.mutation) appendLog(`    mutation=${JSON.stringify(b.mutation)}`);
      }

      appendLog(`\ncalling vm.shareBlocksToTarget(${blocks.length} blocks, "${targetId}")`);
      const result = vm.shareBlocksToTarget(blocks, targetId);
      appendLog(`shareBlocksToTarget returned: ${result} (type: ${typeof result})`);
      const afterInject = () => {
        const allBlocks = vm.editingTarget.blocks._blocks ?? {};
        const allBlockIds = Object.keys(allBlocks);
        appendLog(`target now has ${allBlockIds.length} total blocks`);
        const topBlocks = Object.entries(allBlocks)
          .filter(([, b]) => b.topLevel)
          .map(([id, b]) => `${id.slice(0, 8)} ${b.opcode} (${b.x?.toFixed(0)},${b.y?.toFixed(0)})`);
        appendLog(`top-level: ${topBlocks.join(", ") || "(none)"}`);
        try {
          const xmlStr = vm.editingTarget.blocks.toXML(vm.editingTarget.comments);
          appendLog(`\nXML (first 2000 chars):\n${xmlStr.slice(0, 2000)}`);
        } catch (xmlErr) {
          appendLog(`❌ toXML() threw: ${xmlErr.message}\n${xmlErr.stack ?? ""}`);
        }
        if (typeof vm.refreshWorkspace === "function") {
          try {
            vm.refreshWorkspace();
            appendLog("✅ vm.refreshWorkspace() called.");
          } catch (refreshErr) {
            appendLog(`❌ refreshWorkspace threw: ${refreshErr.message}\n${refreshErr.stack ?? ""}`);
          }
        } else {
          // refreshWorkspace() isn't available in this VM version, but it just calls
          // vm.emit('workspaceUpdate', {xml}) — do the same thing manually.
          try {
            const xml = vm.editingTarget.blocks.toXML(vm.editingTarget.comments);
            vm.emit("workspaceUpdate", { xml });
            appendLog("✅ emitted workspaceUpdate (refreshWorkspace fallback).");
          } catch (emitErr) {
            appendLog(`⚠️ fallback workspaceUpdate failed: ${emitErr.message}`);
          }
        }
        onDone(true);
      };
      if (result && typeof result.then === "function") {
        result.then(afterInject).catch((e) => {
          appendLog(`❌ Promise rejected: ${e.message}`);
          onDone(false);
        });
      } else {
        afterInject();
      }
    } catch (e) {
      appendLog(`\n❌ EXCEPTION: ${e.message}`);
      appendLog(e.stack ?? "");
      console.error("[inspector:inject]", e);
      onDone(false);
    }
  }

  // ─── Issues tab rendering ─────────────────────────────────────────────────

  async function renderIssuesContent(tab) {
    issuesContent.innerHTML = "";
    if (tab._isDiffTab) {
      await renderDiffContent(tab, issuesContent);
    } else if (tab.issueState === "streaming") {
      const header = Object.assign(document.createElement("div"), {
        className: "sa-inspector-compare-ref-header",
        innerHTML: `<span class="sa-inspector-compare-ref-label sa-inspector-stream-waiting">⏳ Waiting for response…</span>`,
      });
      const mdContainer = Object.assign(document.createElement("div"), {
        className: "sa-inspector-stream-md",
      });
      if (tab.streamText) renderStreamingMarkdown(tab.streamText, mdContainer);
      tab._streamContainer = mdContainer;
      tab._streamHeader = header.querySelector(".sa-inspector-stream-waiting");
      issuesContent.append(header, mdContainer);
    } else if (tab.issueState === "paste") {
      issuesContent.appendChild(
        Object.assign(document.createElement("p"), {
          className: "sa-inspector-matches-empty",
          textContent: "Paste the AI / ChatGPT response below:",
        })
      );
      const pasteArea = Object.assign(document.createElement("textarea"), {
        className: "sa-inspector-paste-area",
        placeholder: "Paste response here…",
        rows: 12,
      });
      const parseBtn = Object.assign(document.createElement("button"), {
        className: "sa-inspector-action-btn sa-inspector-parse-btn",
        textContent: "Render report",
      });
      const doRender = () => {
        const text = pasteArea.value.trim();
        if (!text) return;
        tab.issueState = "cards";
        tab.content = text;
        void renderIssuesContent(tab);
      };
      parseBtn.addEventListener("click", doRender);
      pasteArea.addEventListener("paste", () => setTimeout(doRender, 0));
      issuesContent.append(pasteArea, parseBtn);
    } else if (tab._parseScripts !== null && tab._parseScripts !== undefined) {
      // ── AST tab: per-script cards with sub-tabs ──────────────────────────
      const scripts = tab._parseScripts;
      const warnings = tab._parseWarnings ?? [];

      if (warnings.length > 0) {
        const warnEl = Object.assign(document.createElement("div"), { className: "sa-inspector-ast-warnings" });
        warnEl.innerHTML =
          `<strong>⚠️ ${warnings.length} warning${warnings.length !== 1 ? "s" : ""}</strong>: ` +
          warnings
            .map((w) => `Line ${w.lineNo}: ${w.message}${w.raw ? ` — <code>${escHtml(w.raw)}</code>` : ""}`)
            .join(" · ");
        issuesContent.appendChild(warnEl);
      }
      if (scripts.length === 0) {
        issuesContent.appendChild(
          Object.assign(document.createElement("p"), {
            className: "sa-inspector-matches-empty",
            textContent: "No scripts parsed.",
          })
        );
      }

      for (let si = 0; si < scripts.length; si++) {
        const script = scripts[si];
        const card = Object.assign(document.createElement("div"), { className: "sa-inspector-ast-script-card" });
        const cardHeader = Object.assign(document.createElement("div"), {
          className: "sa-inspector-ast-script-header",
          textContent: `Script ${si + 1} — ${script.spriteName ?? "?"} | ${script.hat?.raw ?? "(no hat)"}`,
        });
        card.appendChild(cardHeader);

        const subTabBar = Object.assign(document.createElement("div"), { className: "sa-inspector-ast-subtabs" });
        const subPanes = {};
        const switchSubTab = (name) => {
          for (const [n, { btn, pane }] of Object.entries(subPanes)) {
            btn.classList.toggle("sa-inspector-ast-subtab-active", n === name);
            pane.style.display = n === name ? "" : "none";
          }
        };
        const addSubTab = (name, label, buildFn) => {
          const btn = Object.assign(document.createElement("button"), {
            className: "sa-inspector-ast-subtab",
            textContent: label,
          });
          const pane = Object.assign(document.createElement("div"), {
            className: "sa-inspector-ast-pane",
            style: "display:none",
          });
          buildFn(pane);
          btn.addEventListener("click", () => switchSubTab(name));
          subTabBar.appendChild(btn);
          subPanes[name] = { btn, pane };
          card.appendChild(pane);
        };

        addSubTab("pseudo", "📝 Pseudocode", (pane) => {
          pane.appendChild(
            Object.assign(document.createElement("pre"), {
              className: "sa-inspector-ast-pre",
              textContent: tab._parseSrc ?? "(no source)",
            })
          );
        });
        addSubTab("ast", "🌳 AST", (pane) => {
          pane.appendChild(
            Object.assign(document.createElement("pre"), {
              className: "sa-inspector-ast-pre",
              textContent: JSON.stringify({ hat: script.hat, body: script.body }, null, 2),
            })
          );
        });
        addSubTab("inject", "💉 Inject", (pane) => {
          const info = Object.assign(document.createElement("p"), {
            className: "sa-inspector-ast-inject-info",
            textContent: `Injects Script ${si + 1} into the current sprite's workspace.`,
          });
          const log = Object.assign(document.createElement("pre"), {
            className: "sa-inspector-ast-pre sa-inspector-ast-inject-log",
            textContent: "",
          });
          const appendLog = (msg) => {
            log.textContent += msg + "\n";
          };
          const injectBtn = Object.assign(document.createElement("button"), {
            className: "sa-inspector-action-btn",
            textContent: "💉 Inject this script",
          });
          injectBtn.addEventListener("click", () => {
            log.textContent = "";
            injectBtn.disabled = true;
            doInjectScript(
              script,
              (msg) => {
                log.textContent += msg + "\n";
              },
              (ok) => {
                injectBtn.disabled = false;
                injectBtn.textContent = ok ? "✅ Done" : "❌ Failed";
                setTimeout(() => {
                  injectBtn.textContent = "💉 Inject this script";
                }, 3000);
              }
            );
          });
          pane.append(info, injectBtn, log);
        });

        card.insertBefore(subTabBar, card.children[1]);
        switchSubTab("pseudo");
        issuesContent.appendChild(card);
      }

      const copyDebugBtn = Object.assign(document.createElement("button"), {
        className: "sa-inspector-action-btn",
        textContent: "📋 Copy debug report",
      });
      copyDebugBtn.addEventListener("click", () => {
        const report = [
          "=== PARSE INPUT ===",
          tab._parseSrc ?? "",
          "",
          "=== WARNINGS ===",
          warnings.length > 0
            ? warnings.map((w) => `Line ${w.lineNo}: ${w.message}${w.raw ? ` — ${w.raw}` : ""}`).join("\n")
            : "(none)",
          "",
          "=== AST ===",
          JSON.stringify(scripts, null, 2),
        ].join("\n");
        void navigator.clipboard.writeText(report).then(() => {
          copyDebugBtn.textContent = "✅ Copied!";
          setTimeout(() => {
            copyDebugBtn.textContent = "📋 Copy debug report";
          }, 2000);
        });
      });
      issuesContent.appendChild(copyDebugBtn);
    } else {
      renderMarkdownToDOM(tab.content ?? "", issuesContent);
      if (tab._usageSummary) {
        issuesContent.appendChild(
          Object.assign(document.createElement("div"), {
            className: "sa-inspector-usage-summary",
            textContent: `🪙 ${tab._usageSummary}`,
          })
        );
      }
    }
  }

  // ─── Markdown renderer ────────────────────────────────────────────────────

  // Escape HTML special chars so they display literally.
  function escHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // Convert inline markdown to HTML string (bold, italic, inline code).
  function inlineMd(text) {
    let s = escHtml(text);
    s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\*(.+?)\*/g, "<em>$1</em>");
    s = s.replace(/`([^`]+)`/g, '<code class="sa-inspector-md-code">$1</code>');
    return s;
  }

  // Render a plain-text segment (between code fences) into the container.
  function renderTextSegment(text, container) {
    let listEl = null;
    let listType = null;
    let paraLines = [];

    const flushPara = () => {
      const joined = paraLines.join(" ").trim();
      paraLines = [];
      if (!joined) return;
      const p = Object.assign(document.createElement("p"), { className: "sa-inspector-md-p" });
      p.innerHTML = inlineMd(joined);
      container.appendChild(p);
    };

    const flushList = () => {
      listEl = null;
      listType = null;
    };

    for (const line of text.split("\n")) {
      const hMatch = line.match(/^(#{1,5})\s+(.+)/);
      if (hMatch) {
        flushPara();
        flushList();
        // Strip bold/italic markers and check for a citation reference [→ id]
        const rawText = hMatch[2].replace(/\*\*/g, "").replace(/\*/g, "").trim();
        if (rawText.includes("\u2192")) {
          // Render as an interactive citation card rather than a plain heading
          renderCitationBlock(rawText, container);
          continue;
        }
        const level = Math.min(hMatch[1].length + 1, 5); // h2–h5 to not clash with page headings
        const el = document.createElement(`h${level}`);
        el.className = "sa-inspector-md-h";
        el.innerHTML = inlineMd(hMatch[2]);
        container.appendChild(el);
        continue;
      }

      const bulletMatch = line.match(/^[-*]\s+(.+)/);
      if (bulletMatch) {
        flushPara();
        if (listType !== "ul") {
          flushList();
          listEl = Object.assign(document.createElement("ul"), { className: "sa-inspector-md-list" });
          container.appendChild(listEl);
          listType = "ul";
        }
        const li = document.createElement("li");
        li.innerHTML = inlineMd(bulletMatch[1]);
        listEl.appendChild(li);
        continue;
      }

      const numMatch = line.match(/^\d+\.\s+(.+)/);
      if (numMatch) {
        flushPara();
        if (listType !== "ol") {
          flushList();
          listEl = Object.assign(document.createElement("ol"), { className: "sa-inspector-md-list" });
          container.appendChild(listEl);
          listType = "ol";
        }
        const li = document.createElement("li");
        li.innerHTML = inlineMd(numMatch[1]);
        listEl.appendChild(li);
        continue;
      }

      if (line.trim() === "") {
        flushList();
        flushPara();
        continue;
      }

      // Indented continuation of a list item — append to last <li>
      if (listEl && line.match(/^\s{2,}/)) {
        const lastLi = listEl.lastElementChild;
        if (lastLi) {
          lastLi.innerHTML += " " + inlineMd(line.trim());
        }
        continue;
      }

      flushList();
      paraLines.push(line.trim());
    }
    flushPara();
  }

  // Build a Parse button that runs parsePseudocode on `codeText` and opens an AST tab.
  function makeParsePseudocodeBtn(codeText, className) {
    const btn = Object.assign(document.createElement("button"), {
      className,
      title: "Parse pseudocode → AST",
      textContent: "🧪 Parse",
    });
    btn.addEventListener("click", () => {
      // Strip trailing ``` fence before parsing (matches what parseTestBtn does)
      const src = codeText.replace(/\n?```\s*$/, "");
      void (async () => {
        const parsePseudocode = await getParsePseudocode();
        const { scripts, warnings } = parsePseudocode(src);
        const newTab = {
          type: "issues",
          label: "🧪 AST",
          issueState: "cards",
          content: "",
          cards: [],
          _parseSrc: src,
          _parseWarnings: warnings,
          _parseScripts: scripts,
        };
        tabs.push(newTab);
        switchTab(tabs.length - 1);
        renderTabs();
      })();
    });
    return btn;
  }

  // Render a citation code block (first line contains [→ id]) as an interactive card.
  function renderCitationBlock(raw, container) {
    const lines = raw.split("\n");
    const firstLine = lines[0] ?? "";
    // Strip the citation reference [→ id] from the title, anchoring to the
    // last ] so IDs containing ] characters (e.g. W61dB;kZ0L6[ZX5O]dCf) work.
    const title =
      firstLine.replace(/\s*\|\s*\[\u2192.*\]\s*$/, "").trim() ||
      firstLine
        .replace(/\[\u2192.*\]/g, "")
        .replace(/\s*\|\s*$/, "")
        .trim();
    const evidence = lines.slice(1).join("\n").trim();

    const el = document.createElement("div");
    el.className = "sa-inspector-issue-card";

    const cardHeader = Object.assign(document.createElement("div"), { className: "sa-inspector-issue-card-header" });
    const titleEl = Object.assign(document.createElement("span"), {
      className: "sa-inspector-issue-card-title",
      textContent: title || firstLine,
    });
    const goBtn = Object.assign(document.createElement("button"), {
      className: "sa-inspector-issue-go-btn",
      textContent: "🎯 Go",
    });
    goBtn.addEventListener("click", () => void handleGotoBlock(raw, el));
    const parseCardBtn = makeParsePseudocodeBtn(evidence || raw, "sa-inspector-issue-go-btn");
    cardHeader.append(titleEl, goBtn, parseCardBtn);

    if (evidence) {
      el.append(
        cardHeader,
        Object.assign(document.createElement("pre"), {
          className: "sa-inspector-issue-evidence",
          textContent: evidence,
        })
      );
    } else {
      el.appendChild(cardHeader);
    }
    container.appendChild(el);
  }

  // Live streaming render: render up to the last complete fence boundary as full
  // markdown, then show any in-progress (unclosed) code fence as a raw growing pre.
  function renderStreamingMarkdown(text, container) {
    const fenceRe = /^```/gm;
    let fenceCount = 0;
    let lastSafeEnd = 0; // end of last *closed* fence
    let openFenceStart = 0; // start of the currently *open* fence
    let m;
    while ((m = fenceRe.exec(text)) !== null) {
      fenceCount++;
      if (fenceCount % 2 === 1) {
        // Opening fence — note where the safe text ends (just before this fence)
        openFenceStart = m.index;
      } else {
        // Closing fence — advance the last-safe cursor past this fence's line
        const eol = text.indexOf("\n", m.index);
        lastSafeEnd = eol === -1 ? text.length : eol + 1;
      }
    }
    // If inside an unclosed fence, safe = everything before it opens; tail = from there on.
    // This prevents the whole panel going blank when the first ``` arrives mid-stream.
    const insideFence = fenceCount % 2 === 1;
    const safePart = insideFence ? text.slice(0, openFenceStart) : text;
    const tail = insideFence ? text.slice(openFenceStart) : "";

    container.innerHTML = "";
    if (safePart.trim()) renderMarkdownToDOM(safePart, container);
    if (tail) {
      container.appendChild(
        Object.assign(document.createElement("pre"), {
          className: "sa-inspector-md-pre sa-inspector-stream-tail",
          textContent: tail,
        })
      );
    }
  }

  // Main entry point: render a full markdown string into a container element.
  function renderMarkdownToDOM(text, container) {
    container.innerHTML = "";
    // Split on fenced code blocks (capture the whole block so we can inspect it).
    const fenceRe = /```([\w]*)\n([\s\S]*?)```/g;
    let pos = 0;
    let match;
    while ((match = fenceRe.exec(text)) !== null) {
      if (match.index > pos) {
        renderTextSegment(text.slice(pos, match.index), container);
      }
      const blockContent = match[2].replace(/\n$/, "");
      const firstLine = blockContent.split("\n")[0] ?? "";
      if (firstLine.includes("\u2192")) {
        renderCitationBlock(blockContent, container);
      } else {
        // Plain code block — wrap so we can add the Parse button alongside
        const blockWrap = document.createElement("div");
        blockWrap.className = "sa-inspector-md-pre-wrap";
        const pre = document.createElement("pre");
        pre.className = "sa-inspector-md-pre";
        const code = Object.assign(document.createElement("code"), { textContent: blockContent });
        pre.appendChild(code);
        const parseBtn = makeParsePseudocodeBtn(blockContent, "sa-inspector-code-parse-btn");
        blockWrap.append(pre, parseBtn);
        container.appendChild(blockWrap);
      }
      pos = match.index + match[0].length;
    }
    if (pos < text.length) {
      const remaining = text.slice(pos);
      // Check for an unclosed fence in the remaining text (AI stream ended before closing ```)
      const openFenceIdx = remaining.indexOf("```");
      if (openFenceIdx !== -1) {
        // Render any markdown before the fence opening
        if (openFenceIdx > 0) renderTextSegment(remaining.slice(0, openFenceIdx), container);
        // Parse the unclosed fence: skip the opening ``` line, treat rest as block content
        const afterFenceLine = remaining.indexOf("\n", openFenceIdx);
        const blockContent = afterFenceLine !== -1 ? remaining.slice(afterFenceLine + 1) : "";
        if (blockContent) {
          const firstLine = blockContent.split("\n")[0] ?? "";
          if (firstLine.includes("\u2192")) {
            renderCitationBlock(blockContent, container);
          } else {
            const blockWrap = document.createElement("div");
            blockWrap.className = "sa-inspector-md-pre-wrap";
            const pre = document.createElement("pre");
            pre.className = "sa-inspector-md-pre";
            const code = Object.assign(document.createElement("code"), { textContent: blockContent });
            pre.appendChild(code);
            const parseBtn = makeParsePseudocodeBtn(blockContent, "sa-inspector-code-parse-btn");
            blockWrap.append(pre, parseBtn);
            container.appendChild(blockWrap);
          }
        }
      } else {
        renderTextSegment(remaining, container);
      }
    }
  }

  // parseReport is kept for extracting citation block IDs (used by streaming end-detection).
  function parseReport(text) {
    const cards = [];
    const fenceRe = /```[\w]*\n([\s\S]*?)```/g;
    let match;
    while ((match = fenceRe.exec(text)) !== null) {
      const raw = match[1].replace(/\n$/, "");
      if (raw.split("\n")[0]?.includes("\u2192")) cards.push(raw);
    }
    return cards;
  }

  function renderTabs() {
    tabBar.innerHTML = "";
    for (let i = 0; i < tabs.length; i++) {
      const tabEl = Object.assign(document.createElement("button"), {
        className: "sa-inspector-tab" + (i === activeTabIndex ? " sa-inspector-tab-active" : ""),
      });
      tabEl.appendChild(Object.assign(document.createElement("span"), { textContent: tabs[i].label }));

      // Current tab (0) is always permanent; Compare tab (1) has ✕ only when showing a reference
      const isCurrentTab = tabs[i].type === "current";
      const isCompareChooser = tabs[i].type === "compare" && tabs[i].compareState !== "reference";
      if (!isCurrentTab && !isCompareChooser) {
        const closeX = Object.assign(document.createElement("span"), {
          className: "sa-inspector-tab-close",
          textContent: "×",
        });
        closeX.addEventListener("click", (e) => {
          e.stopPropagation();
          if (tabs[i].type === "compare") {
            revertCompareToChooser();
          } else {
            removeTab(i);
          }
        });
        tabEl.appendChild(closeX);
      }

      tabEl.addEventListener("click", () => switchTab(i));
      tabBar.appendChild(tabEl);
    }
  }

  function switchTab(index) {
    activeTabIndex = index;
    applyTab(index);
    renderTabs();
  }

  function removeTab(index) {
    if (index <= 1) return; // Current and Compare are permanent
    tabs.splice(index, 1);
    if (activeTabIndex >= tabs.length) activeTabIndex = tabs.length - 1;
    applyTab(activeTabIndex);
    renderTabs();
  }

  function upsertCurrentTab(content) {
    const idx = tabs.findIndex((t) => t.type === "current");
    if (idx === -1) {
      tabs.unshift({ type: "current", label: msg("tab-current"), content });
    } else {
      tabs[idx].content = content;
    }
  }

  function ensureCompareTabs() {
    if (!tabs.some((t) => t.type === "compare")) {
      const insertAt = Math.max(1, tabs.findIndex((t) => t.type === "current") + 1);
      tabs.splice(insertAt, 0, {
        type: "compare",
        label: "Compare",
        compareState: "chooser",
        referenceContent: "",
        referenceLabel: "",
      });
    }
  }

  async function handleGotoBlock(raw, cardEl = null) {
    await ensureBlocklyReady();
    const stripped = raw
      .trim()
      .replace(/^```[\w]*\n?/, "")
      .replace(/\n?```$/, "")
      .trim();
    const lines = stripped.split("\n");
    const firstLine = lines[0] ?? "";
    // Use greedy .* so IDs containing ] characters match to the final ] on the line.
    const idMatch = firstLine.match(/\[\u2192\s*(.*)\]/);
    const blockId = idMatch
      ? idMatch[1].trim()
      : stripped
          .replace(/^\[\u2192\s*/, "")
          .replace(/\]$/, "")
          .trim();
    console.log(`[inspector] goto: firstLine=${JSON.stringify(firstLine)} → blockId=${JSON.stringify(blockId)}`);
    const spriteName = firstLine.split("|")[0].trim();
    const vm = addon.tab.redux.state?.scratchGui?.vm;
    // Try named-sprite switch first, then fall back to searching all targets by block ID.
    let resolvedTarget = null;
    if (vm) {
      if (spriteName && !spriteName.includes("\u2192")) {
        resolvedTarget =
          vm.runtime.targets.find((t) => !t.isStage && t.getName() === spriteName) ??
          vm.runtime.targets.find((t) => !t.isStage && t.getName().toLowerCase() === spriteName.toLowerCase());
      }
      if (!resolvedTarget) {
        // No sprite name in the citation, or no match — search every target for the block ID
        resolvedTarget = vm.runtime.targets.find((t) => !!t.blocks.getBlock(blockId));
        if (resolvedTarget) console.log(`[inspector] Found block in target: ${resolvedTarget.getName()}`);
      }
      if (resolvedTarget && resolvedTarget.id !== vm.editingTarget?.id) {
        vm.setEditingTarget(resolvedTarget.id);
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
    }
    const workspace = addon.tab.traps.getWorkspace();
    if (!workspace) {
      alert("No Scratch workspace found — is the project open in editor mode?");
      return;
    }
    const block = workspace.getBlockById(blockId);
    if (!block) {
      console.warn(
        `[inspector] Block not found. ID=${JSON.stringify(blockId)} firstLine=${JSON.stringify(firstLine)} raw=${JSON.stringify(raw)}`
      );
      alert(`Block not found: ${blockId}`);
      return;
    }
    await ensureScrollingLoaded();
    _scrollBlockIntoViewIfNeeded(workspace, block, 64, 64, false).then(() => flashBlock(block));
    if (cardEl) {
      issuesContent
        .querySelectorAll(".sa-inspector-issue-card")
        .forEach((c) => c.classList.remove("sa-inspector-card-active"));
      cardEl.classList.add("sa-inspector-card-active");
    }
  }

  // ─── Quick Diff ────────────────────────────────────────────────────────────

  async function handleQuickDiff(compareTab) {
    let studentProject;
    try {
      studentProject = getCurrentProjectFromVM();
    } catch (e) {
      alert(msg("fetch-error", { error: String(e) }));
      return;
    }

    const shortLabel = (compareTab.referenceLabel ?? "Diff").slice(0, 20);
    const newTab = {
      type: "issues",
      label: `🔍 ${shortLabel}`,
      issueState: "cards",
      content: "",
      cards: [],
      _isDiffTab: true,
      _diffResult: null,
      _diffComputing: true,
      _diffError: null,
    };
    tabs.push(newTab);
    const tabIdx = tabs.length - 1;
    switchTab(tabIdx);
    renderTabs();

    let diffFn;
    try {
      diffFn = await getDiffProjects();
      newTab._diffResult = diffFn(compareTab.referenceProject, studentProject);
    } catch (e) {
      newTab._diffError = String(e);
      console.error("[inspector:quick-diff]", e);
    } finally {
      newTab._diffComputing = false;
    }

    if (activeTabIndex === tabIdx) void renderIssuesContent(newTab);
  }

  // ─── Diff result renderer ──────────────────────────────────────────────────

  async function renderDiffContent(tab, container) {
    if (tab._diffComputing) {
      container.appendChild(
        Object.assign(document.createElement("p"), {
          className: "sa-inspector-matches-empty",
          textContent: "⏳ Computing diff…",
        })
      );
      return;
    }

    if (tab._diffError) {
      container.appendChild(
        Object.assign(document.createElement("p"), {
          className: "sa-inspector-matches-empty",
          textContent: `❌ Diff failed: ${tab._diffError}`,
        })
      );
      return;
    }

    const {
      spriteMatches,
      unmatchedRefTargets,
      unmatchedStudentTargets,
      nameMaps,
      scriptMatches,
      unmatchedRefScripts,
      unmatchedStudentScripts,
    } = tab._diffResult;
    const blockToIR = await getBlockToIR();
    const normalizeNodeForDisplay = await getNormalizeNodeForDisplay();

    // ── Sprite matching summary ──────────────────────────────────────────────
    renderDiffSectionHeading(container, "🗂️ Sprite Matching");
    const spriteTable = Object.assign(document.createElement("div"), { className: "sa-inspector-diff-sprite-table" });
    // High-confidence matches (≥80%) are almost always correct and mostly just
    // clutter — collapse them behind a toggle by default so missing/extra
    // sprites and anything uncertain stay front and centre.
    const confidentSpriteRows = [];

    for (const { refTarget, studentTarget, confidence } of spriteMatches) {
      const pct = Math.round(confidence * 100);
      const confCls = pct > 60 ? "sa-diff-conf-good" : pct > 30 ? "sa-diff-conf-ok" : "sa-diff-conf-bad";
      const row = Object.assign(document.createElement("div"), { className: "sa-inspector-diff-sprite-row" });
      row.innerHTML = `<span class="sa-diff-name">${escHtml(refTarget.name)}</span><span class="sa-diff-arrow">${refTarget.name !== studentTarget.name ? " → " : " = "}</span><span class="sa-diff-name">${escHtml(studentTarget.name)}</span><span class="sa-inspector-match-pct ${confCls}">${pct}%</span>`;
      if (pct >= 80) confidentSpriteRows.push(row);
      else spriteTable.appendChild(row);
    }
    for (const t of unmatchedRefTargets) {
      const row = Object.assign(document.createElement("div"), {
        className: "sa-inspector-diff-sprite-row sa-diff-missing",
      });
      row.innerHTML = `<span class="sa-diff-name">${escHtml(t.name)}</span><span class="sa-diff-arrow"> ✗ missing in student</span>`;
      spriteTable.appendChild(row);
    }
    for (const t of unmatchedStudentTargets) {
      const row = Object.assign(document.createElement("div"), {
        className: "sa-inspector-diff-sprite-row sa-diff-extra",
      });
      row.innerHTML = `<span class="sa-diff-name">${escHtml(t.name)}</span><span class="sa-diff-arrow"> + extra in student</span>`;
      spriteTable.appendChild(row);
    }
    container.appendChild(spriteTable);
    if (confidentSpriteRows.length > 0) {
      container.appendChild(
        makeCollapsibleRows(
          confidentSpriteRows,
          `${confidentSpriteRows.length} confidently matched sprite${confidentSpriteRows.length === 1 ? "" : "s"} (80%+)`,
          "sa-inspector-diff-sprite-table"
        )
      );
    }

    // ── Name mapping ─────────────────────────────────────────────────────────
    const renames = [];
    for (const [spriteName, nm] of nameMaps) {
      for (const [ref, m] of nm.variables) {
        if (m.isRename) renames.push({ sprite: spriteName, type: "var", ref, stu: m.studentName, conf: m.confidence });
      }
      for (const [ref, m] of nm.lists) {
        if (m.isRename) renames.push({ sprite: spriteName, type: "list", ref, stu: m.studentName, conf: m.confidence });
      }
      for (const [ref, m] of nm.broadcasts) {
        if (m.isRename)
          renames.push({ sprite: "(all)", type: "broadcast", ref, stu: m.studentName, conf: m.confidence });
      }
      for (const [ref, m] of nm.procedures) {
        if (m.isRename)
          renames.push({ sprite: spriteName, type: "proc", ref, stu: m.studentProccode, conf: m.confidence });
      }
    }
    // Deduplicate broadcast renames (appear once per sprite but are global)
    const seenBcRenames = new Set();
    const uniqueRenames = renames.filter((r) => {
      if (r.type !== "broadcast") return true;
      const key = `${r.ref}→${r.stu}`;
      if (seenBcRenames.has(key)) return false;
      seenBcRenames.add(key);
      return true;
    });

    if (uniqueRenames.length > 0) {
      renderDiffSectionHeading(container, "🏷️ Inferred Renames");
      container.appendChild(
        Object.assign(document.createElement("p"), {
          className: "sa-inspector-md-p",
          textContent:
            "Student uses different names for the same concept — these are not bugs if the logic is consistent:",
        })
      );
      // Same collapse-by-default treatment as sprite matches: a rename found
      // with ≥80% confidence is almost certainly correct.
      const confidentRenameRows = [];
      for (const r of uniqueRenames) {
        const el = Object.assign(document.createElement("div"), { className: "sa-inspector-diff-rename-row" });
        el.innerHTML = `<span class="sa-diff-type-tag">${escHtml(r.type)}</span> <span class="sa-diff-name">${escHtml(r.ref)}</span> <span class="sa-diff-arrow">→</span> <span class="sa-diff-name">${escHtml(r.stu)}</span> <span class="sa-inspector-match-pct sa-diff-conf-${r.conf > 0.7 ? "good" : "ok"}">${Math.round(r.conf * 100)}%</span> <span class="sa-diff-sprite-hint">${r.sprite !== "(all)" ? `(${escHtml(r.sprite)})` : ""}</span>`;
        if (r.conf >= 0.8) confidentRenameRows.push(el);
        else container.appendChild(el);
      }
      if (confidentRenameRows.length > 0) {
        container.appendChild(
          makeCollapsibleRows(
            confidentRenameRows,
            `${confidentRenameRows.length} confident rename${confidentRenameRows.length === 1 ? "" : "s"} (80%+)`
          )
        );
      }
    }

    // ── Script differences ────────────────────────────────────────────────────
    renderDiffSectionHeading(container, "📜 Script Differences");

    // Group matched scripts by ref sprite name
    const seenTargetNames = [];
    for (const { refTarget } of spriteMatches) {
      if (!seenTargetNames.includes(refTarget.name)) seenTargetNames.push(refTarget.name);
    }
    for (const { target } of unmatchedRefScripts) {
      if (!seenTargetNames.includes(target.name)) seenTargetNames.push(target.name);
    }

    let hiddenCleanSprites = 0;
    for (const targetName of seenTargetNames) {
      const targetMatches = scriptMatches.filter((m) => m.refTarget.name === targetName);
      const targetUnmatched = unmatchedRefScripts.filter((u) => u.target.name === targetName);
      if (targetMatches.length === 0 && targetUnmatched.length === 0) continue;

      // Find the actual ref target for block access
      const refTarget =
        spriteMatches.find((m) => m.refTarget.name === targetName)?.refTarget ??
        unmatchedRefScripts.find((u) => u.target.name === targetName)?.target;

      // Build this sprite's whole section in a detached fragment first, so it
      // can be skipped entirely if nothing about it differs — see
      // hiddenCleanSprites below.
      const spriteFrag = document.createDocumentFragment();
      let spriteHasChanges = targetUnmatched.length > 0;
      // Scripts that matched with no field/statement differences at all (only
      // their match confidence is < 100%) — hidden the same way whole clean
      // sprites are, since there's nothing to review.
      let cleanScriptCount = 0;

      spriteFrag.appendChild(
        Object.assign(document.createElement("div"), {
          className: "sa-inspector-diff-sprite-label",
          textContent: `🐱 ${targetName}`,
        })
      );

      for (const match of targetMatches) {
        const refBlocks = match.refTarget.blocks ?? {};
        const stuBlocks = match.studentTarget.blocks ?? {};
        // The ref side is rendered through the student's naming (renamed
        // variables/lists/broadcasts/sprites/procedures) so that comparing the
        // two rendered lines only surfaces genuine differences, not renames the
        // diff engine already recognises as equivalent (see normalizeNodeForDisplay).
        const spriteNameMap = nameMaps.get(match.refTarget.name) ?? null;
        const hatNode = normalizeNodeForDisplay(blockToIR(match.refScriptId, refBlocks), spriteNameMap);
        const hatText = getHatText(hatNode);
        const pct = Math.round(match.confidence * 100);
        const ops = match.diffOps ?? [];
        let changed = 0,
          inserted = 0,
          deleted = 0,
          moved = 0,
          swapped = 0;
        for (const op of ops) {
          if (op.swapped) {
            // Count each swapped pair once (see swappedPrimary in project-differ.js).
            if (op.swappedPrimary) swapped++;
          } else if (op.type === "change") changed++;
          else if (op.moved) {
            // Count each moved delete/insert pair once (on the insert side).
            if (op.type === "insert") moved++;
          } else if (op.type === "insert") inserted++;
          else if (op.type === "delete") deleted++;
        }
        const hasChanges = changed > 0 || inserted > 0 || deleted > 0 || moved > 0 || swapped > 0;
        if (hasChanges) spriteHasChanges = true;
        const confCls = pct > 75 ? "sa-diff-conf-good" : pct > 40 ? "sa-diff-conf-ok" : "sa-diff-conf-bad";

        const card = Object.assign(document.createElement("div"), { className: "sa-inspector-diff-script-card" });
        const cardHdr = Object.assign(document.createElement("div"), {
          className: `sa-inspector-diff-script-header${hasChanges ? "" : " sa-diff-clean"}`,
        });
        const hatSpan = Object.assign(document.createElement("span"), {
          className: "sa-diff-script-hat",
          textContent: hatText,
        });
        const pctSpan = Object.assign(document.createElement("span"), {
          className: `sa-inspector-match-pct ${confCls}`,
          textContent: `${pct}%`,
        });
        cardHdr.append(hatSpan, pctSpan);
        if (changed > 0) cardHdr.appendChild(makeDiffBadge(`${changed} changed`, "sa-diff-changed"));
        if (inserted > 0) cardHdr.appendChild(makeDiffBadge(`+${inserted}`, "sa-diff-inserted"));
        if (deleted > 0) cardHdr.appendChild(makeDiffBadge(`−${deleted}`, "sa-diff-deleted"));
        if (moved > 0) cardHdr.appendChild(makeDiffBadge(`↕${moved} moved`, "sa-diff-moved"));
        if (swapped > 0) cardHdr.appendChild(makeDiffBadge(`↔${swapped} swapped`, "sa-diff-swapped"));

        if (hasChanges) {
          const sbsBtn = Object.assign(document.createElement("button"), {
            className: "sa-inspector-issue-go-btn",
            title: "Open side-by-side comparison in a floating panel",
            textContent: "⇄",
          });
          sbsBtn.addEventListener("click", () => {
            openSideBySidePopup(
              hatText,
              ops,
              refBlocks,
              stuBlocks,
              spriteNameMap,
              match,
              blockToIR,
              normalizeNodeForDisplay
            );
          });
          cardHdr.appendChild(sbsBtn);
        }

        const goBtn = Object.assign(document.createElement("button"), {
          className: "sa-inspector-issue-go-btn",
          textContent: "🎯 Go",
        });
        goBtn.addEventListener("click", async () => {
          await handleGotoBlock(`${match.studentTarget.name} | ${hatText} | [→ ${match.studentScriptId}]`, card);
          const changedIds = ops
            .filter((op) => (op.type === "change" || op.type === "insert") && op.studentBlockId)
            .map((op) => op.studentBlockId);
          if (changedIds.length > 0) void highlightDiffBlocks(changedIds);
        });
        cardHdr.appendChild(goBtn);
        card.appendChild(cardHdr);

        if (hasChanges) {
          const bodyEl = Object.assign(document.createElement("div"), { className: "sa-inspector-diff-body" });
          const lineCount = renderDiffBodyUnified(
            bodyEl,
            ops,
            refBlocks,
            stuBlocks,
            spriteNameMap,
            match,
            blockToIR,
            normalizeNodeForDisplay
          );
          if (lineCount > 0) card.appendChild(bodyEl);
        }
        if (hasChanges) spriteFrag.appendChild(card);
        else cleanScriptCount++;
      }

      if (cleanScriptCount > 0) {
        spriteFrag.appendChild(
          Object.assign(document.createElement("div"), {
            className: "sa-inspector-diff-clean-scripts-note",
            textContent: `✅ ${cleanScriptCount} script${cleanScriptCount === 1 ? "" : "s"} had no differences (hidden)`,
          })
        );
      }

      for (const { scriptId } of targetUnmatched) {
        const hatNode = normalizeNodeForDisplay(
          blockToIR(scriptId, refTarget?.blocks ?? {}),
          nameMaps.get(targetName) ?? null
        );
        const hatText = getHatText(hatNode);
        const card = Object.assign(document.createElement("div"), {
          className: "sa-inspector-diff-script-card sa-diff-missing-script",
        });
        const cardHdr = Object.assign(document.createElement("div"), {
          className: "sa-inspector-diff-script-header",
        });
        cardHdr.append(
          makeDiffBadge("✗ missing", "sa-diff-deleted"),
          Object.assign(document.createElement("span"), { className: "sa-diff-script-hat", textContent: hatText })
        );
        card.appendChild(cardHdr);
        spriteFrag.appendChild(card);
      }

      if (spriteHasChanges) container.appendChild(spriteFrag);
      else hiddenCleanSprites++;
    }

    if (hiddenCleanSprites > 0) {
      container.appendChild(
        Object.assign(document.createElement("div"), {
          className: "sa-inspector-diff-clean-sprites-note",
          textContent: `✅ ${hiddenCleanSprites} sprite${hiddenCleanSprites === 1 ? "" : "s"} had no differences (hidden)`,
        })
      );
    }

    // ── Extra scripts in student ──────────────────────────────────────────────
    if (unmatchedStudentScripts.length > 0) {
      renderDiffSectionHeading(container, "➕ Extra Scripts (student only)");
      const byTarget = new Map();
      for (const { target, scriptId } of unmatchedStudentScripts) {
        if (!byTarget.has(target.name)) byTarget.set(target.name, { target, ids: [] });
        byTarget.get(target.name).ids.push(scriptId);
      }
      for (const [targetName, { target, ids }] of byTarget) {
        container.appendChild(
          Object.assign(document.createElement("div"), {
            className: "sa-inspector-diff-sprite-label",
            textContent: targetName,
          })
        );
        for (const scriptId of ids) {
          const hatNode = blockToIR(scriptId, target.blocks ?? {});
          const hatText = getHatText(hatNode);
          const card = Object.assign(document.createElement("div"), {
            className: "sa-inspector-diff-script-card sa-diff-extra-script",
          });
          const cardHdr = Object.assign(document.createElement("div"), {
            className: "sa-inspector-diff-script-header",
          });
          cardHdr.append(
            makeDiffBadge("+ extra", "sa-diff-inserted"),
            Object.assign(document.createElement("span"), { className: "sa-diff-script-hat", textContent: hatText })
          );
          const goBtn = Object.assign(document.createElement("button"), {
            className: "sa-inspector-issue-go-btn",
            textContent: "🎯 Go",
          });
          goBtn.addEventListener("click", () => {
            void handleGotoBlock(`${targetName} | ${hatText} | [→ ${scriptId}]`, card);
          });
          cardHdr.appendChild(goBtn);
          card.appendChild(cardHdr);
          container.appendChild(card);
        }
      }
    }
  }

  function renderDiffSectionHeading(container, title) {
    container.appendChild(
      Object.assign(document.createElement("div"), { className: "sa-inspector-issue-section", textContent: title })
    );
  }

  // Wrap already-built row elements in a collapsed-by-default group behind a
  // small toggle summary line — used for high-confidence sprite matches /
  // renames, which are almost always correct and mostly just clutter the more
  // interesting (uncertain, missing, extra) rows above them. `groupClass`, if
  // given, is applied to the inner row container (e.g. to reuse a table's
  // padding), matching the class of the sibling container these rows would
  // otherwise have been appended to.
  function makeCollapsibleRows(rows, summaryText, groupClass) {
    const wrap = Object.assign(document.createElement("div"), { className: "sa-inspector-collapsible" });
    const toggle = Object.assign(document.createElement("button"), {
      className: "sa-inspector-collapsible-toggle",
      textContent: `▸ ${summaryText}`,
    });
    const group = Object.assign(document.createElement("div"), {
      className: `sa-inspector-collapsible-group${groupClass ? ` ${groupClass}` : ""}`,
    });
    group.style.display = "none";
    group.append(...rows);
    toggle.addEventListener("click", () => {
      const isHidden = group.style.display === "none";
      group.style.display = isHidden ? "" : "none";
      toggle.textContent = `${isHidden ? "▾" : "▸"} ${summaryText}`;
    });
    wrap.append(toggle, group);
    return wrap;
  }

  // 2 spaces per level of C-block nesting (matching renderSequence's indent
  // step), so nested statements keep their visual structure in the diff view.
  // `depth` may be null (op has no block on that side) — treated as top level.
  function indentPrefix(depth) {
    return "  ".repeat(depth ?? 0);
  }

  // Render a script's diff as stacked "− ref" / "+ student" lines, showing only
  // the differences (matches are skipped entirely). A moved statement is shown
  // at BOTH its old and new position (each independently, since they occupy
  // different points in this stacked list) rather than collapsed to one line,
  // so it's clear where it moved from as well as to. Returns the number of
  // lines appended.
  function renderDiffBodyUnified(
    bodyEl,
    ops,
    refBlocks,
    stuBlocks,
    spriteNameMap,
    match,
    blockToIR,
    normalizeNodeForDisplay
  ) {
    let lineCount = 0;
    const cap = 30;
    const nonMatchOps = ops.filter((op) => op.type !== "match");
    for (const op of nonMatchOps) {
      if (lineCount >= cap) {
        bodyEl.appendChild(
          Object.assign(document.createElement("div"), {
            className: "sa-diff-line sa-diff-line-more",
            textContent: `… (${nonMatchOps.length - cap} more)`,
          })
        );
        break;
      }
      if (op.swapped) {
        // Two adjacent statements that just swapped position — show the
        // student's actual (current) content at each position with a distinct
        // badge, rather than the usual before/after word-diff, since nothing
        // about the statement itself changed (see markSwappedPairs).
        const node = blockToIR(op.studentBlockId, stuBlocks);
        const text = node ? formatBlockLine(node) : op.opcode;
        const frag = document.createDocumentFragment();
        frag.appendChild(makeDiffBadge("↔ swapped", "sa-diff-swapped"));
        frag.appendChild(document.createTextNode(` ${indentPrefix(op.studentDepth)}${text}`));
        bodyEl.appendChild(
          makeDiffBodyLineNode("swapped", frag, op.studentBlockId, match.studentTarget.name, "sa-diff-row-start")
        );
        lineCount++;
        continue;
      }
      if (op.moved) {
        const frag = document.createDocumentFragment();
        if (op.type === "delete") {
          const refNode = normalizeNodeForDisplay(blockToIR(op.refBlockId, refBlocks), spriteNameMap);
          const text = refNode ? formatBlockLine(refNode) : op.opcode;
          // Only the "moved" badge gets the blue background — the statement text
          // itself stays plain, same as an unchanged line, since its content
          // didn't change, only its position.
          frag.appendChild(makeDiffBadge("↕ moved away", "sa-diff-moved"));
          frag.appendChild(document.createTextNode(` ${indentPrefix(op.refDepth)}${text}`));
          bodyEl.appendChild(makeDiffBodyLineNode("moved", frag, null, null, "sa-diff-row-start"));
        } else {
          const node = blockToIR(op.studentBlockId, stuBlocks);
          const text = node ? formatBlockLine(node) : op.opcode;
          frag.appendChild(makeDiffBadge("↕ moved here", "sa-diff-moved"));
          frag.appendChild(document.createTextNode(` ${indentPrefix(op.studentDepth)}${text}`));
          bodyEl.appendChild(
            makeDiffBodyLineNode("moved", frag, op.studentBlockId, match.studentTarget.name, "sa-diff-row-start")
          );
        }
        lineCount++;
        continue;
      }
      if (op.type === "change") {
        const refNode = normalizeNodeForDisplay(blockToIR(op.refBlockId, refBlocks), spriteNameMap);
        const stuNode = blockToIR(op.studentBlockId, stuBlocks);
        if (refNode && stuNode) {
          const refLine = formatBlockLine(refNode);
          const stuLine = formatBlockLine(stuNode);
          // If the rendered pseudocode is identical, this is usually a pure
          // rename already captured in the NameMap — nothing to show. But
          // changedFields can still carry a real difference invisible in the
          // text (e.g. a procedure's own parameter swapped for a same-named
          // variable, which renders exactly the same as the parameter) —
          // surface that instead of silently dropping the line.
          if (refLine === stuLine) {
            if (!op.changedFields) continue;
            bodyEl.appendChild(makeSemanticChangeLine(op, stuLine, match, "sa-diff-row-start"));
            lineCount++;
            continue;
          }
          // Show both the before (ref) and after (student) lines, each with just
          // its own differing word(s) highlighted. This is a positional word-level
          // diff between the two rendered lines, not a search for changedFields
          // values as literal substrings — position (not content) disambiguates,
          // so it stays correct even when the same name appears more than once in
          // a line (e.g. a list used as both the source and destination of an
          // "add ... to ..." block).
          const wordOps = wordDiff(tokenizeLine(refLine), tokenizeLine(stuLine));
          const refHighlighted = buildDiffLineFragment(`− ${indentPrefix(op.refDepth)}`, wordOps, "delete");
          const stuHighlighted = buildDiffLineFragment(`+ ${indentPrefix(op.studentDepth)}`, wordOps, "insert");

          bodyEl.appendChild(
            makeDiffBodyLineNode("delete", refHighlighted, null, null, "sa-diff-line-partial sa-diff-row-start")
          );
          lineCount++;
          bodyEl.appendChild(
            makeDiffBodyLineNode(
              "insert",
              stuHighlighted,
              op.studentBlockId,
              match.studentTarget.name,
              "sa-diff-line-partial"
            )
          );
          lineCount++;
        }
      } else if (op.type === "insert") {
        const node = blockToIR(op.studentBlockId, stuBlocks);
        bodyEl.appendChild(
          makeDiffBodyLine(
            "insert",
            `+ ${indentPrefix(op.studentDepth)}${node ? formatBlockLine(node) : op.opcode}`,
            op.studentBlockId,
            match.studentTarget.name
          )
        );
        lineCount++;
      } else if (op.type === "delete") {
        const node = normalizeNodeForDisplay(blockToIR(op.refBlockId, refBlocks), spriteNameMap);
        bodyEl.appendChild(
          makeDiffBodyLine(
            "delete",
            `− ${indentPrefix(op.refDepth)}${node ? formatBlockLine(node) : op.opcode}`,
            null,
            null
          )
        );
        lineCount++;
      }
    }
    return lineCount;
  }

  // Render a script's diff as two aligned columns (reference | student). Unlike
  // the unified view, "match" ops are also rendered (as plain context lines) so
  // rows stay lined up between the two columns — that alignment is the whole
  // point of a side-by-side view. Each row contributes exactly two DOM children
  // (left cell, right cell) to the grid container — a moved statement's old and
  // new position each get their own row (ref-only / student-only, like a delete
  // and an insert), so both endpoints of the move are visible. The "more" cap
  // line is the only row that spans both columns — see .sa-diff-line-full in
  // userstyle.css. Returns the number of rows appended.
  function renderDiffBodySplit(
    bodyEl,
    ops,
    refBlocks,
    stuBlocks,
    spriteNameMap,
    match,
    blockToIR,
    normalizeNodeForDisplay
  ) {
    bodyEl.appendChild(
      Object.assign(document.createElement("div"), { className: "sa-diff-col-header", textContent: "Reference" })
    );
    bodyEl.appendChild(
      Object.assign(document.createElement("div"), { className: "sa-diff-col-header", textContent: "Student" })
    );

    let lineCount = 0;
    const cap = 60;

    const appendMatchRow = (refText, studentBlockId, stuText) => {
      bodyEl.appendChild(
        makeDiffBodyLineNode("match", document.createTextNode(refText), null, null, "sa-diff-col-left")
      );
      bodyEl.appendChild(
        makeDiffBodyLineNode(
          "match",
          document.createTextNode(stuText),
          studentBlockId,
          match.studentTarget.name,
          "sa-diff-col-right"
        )
      );
    };

    for (const op of ops) {
      if (lineCount >= cap) {
        bodyEl.appendChild(
          Object.assign(document.createElement("div"), {
            className: "sa-diff-line sa-diff-line-more sa-diff-line-full",
            textContent: `… (${ops.length - cap} more)`,
          })
        );
        break;
      }

      if (op.swapped) {
        // Two adjacent statements that just swapped position — show both
        // sides' actual content (unlike a "change", there's no before/after
        // for the same statement here, just two real, unrelated positions),
        // each tagged with a small badge instead of red/green word-diffing.
        const refNode = normalizeNodeForDisplay(blockToIR(op.refBlockId, refBlocks), spriteNameMap);
        const stuNode = blockToIR(op.studentBlockId, stuBlocks);
        const refText = indentPrefix(op.refDepth) + (refNode ? formatBlockLine(refNode) : op.opcode);
        const stuText = indentPrefix(op.studentDepth) + (stuNode ? formatBlockLine(stuNode) : op.opcode);
        const leftFrag = document.createDocumentFragment();
        leftFrag.appendChild(makeDiffBadge("↔", "sa-diff-swapped"));
        leftFrag.appendChild(document.createTextNode(` ${refText}`));
        const rightFrag = document.createDocumentFragment();
        rightFrag.appendChild(makeDiffBadge("↔", "sa-diff-swapped"));
        rightFrag.appendChild(document.createTextNode(` ${stuText}`));
        bodyEl.appendChild(makeDiffBodyLineNode("swapped", leftFrag, null, null, "sa-diff-col-left sa-diff-row-start"));
        bodyEl.appendChild(
          makeDiffBodyLineNode(
            "swapped",
            rightFrag,
            op.studentBlockId,
            match.studentTarget.name,
            "sa-diff-col-right sa-diff-row-start"
          )
        );
        lineCount++;
        continue;
      }

      if (op.moved) {
        const frag = document.createDocumentFragment();
        if (op.type === "delete") {
          const refNode = normalizeNodeForDisplay(blockToIR(op.refBlockId, refBlocks), spriteNameMap);
          const text = refNode ? formatBlockLine(refNode) : op.opcode;
          frag.appendChild(makeDiffBadge("↕ moved away", "sa-diff-moved"));
          frag.appendChild(document.createTextNode(` ${indentPrefix(op.refDepth)}${text}`));
          bodyEl.appendChild(makeDiffBodyLineNode("moved", frag, null, null, "sa-diff-col-left sa-diff-row-start"));
          bodyEl.appendChild(makeDiffEmptyCell("sa-diff-col-right sa-diff-line-moved-empty sa-diff-row-start"));
        } else {
          const node = blockToIR(op.studentBlockId, stuBlocks);
          const text = node ? formatBlockLine(node) : op.opcode;
          frag.appendChild(makeDiffBadge("↕ moved here", "sa-diff-moved"));
          frag.appendChild(document.createTextNode(` ${indentPrefix(op.studentDepth)}${text}`));
          bodyEl.appendChild(makeDiffEmptyCell("sa-diff-col-left sa-diff-line-moved-empty sa-diff-row-start"));
          bodyEl.appendChild(
            makeDiffBodyLineNode(
              "moved",
              frag,
              op.studentBlockId,
              match.studentTarget.name,
              "sa-diff-col-right sa-diff-row-start"
            )
          );
        }
        lineCount++;
        continue;
      }

      if (op.type === "match") {
        const refNode = normalizeNodeForDisplay(blockToIR(op.refBlockId, refBlocks), spriteNameMap);
        const stuNode = blockToIR(op.studentBlockId, stuBlocks);
        const refText = indentPrefix(op.refDepth) + (refNode ? formatBlockLine(refNode) : op.opcode);
        const stuText = indentPrefix(op.studentDepth) + (stuNode ? formatBlockLine(stuNode) : op.opcode);
        appendMatchRow(refText, op.studentBlockId, stuText);
        lineCount++;
      } else if (op.type === "change") {
        const refNode = normalizeNodeForDisplay(blockToIR(op.refBlockId, refBlocks), spriteNameMap);
        const stuNode = blockToIR(op.studentBlockId, stuBlocks);
        if (refNode && stuNode) {
          const refLine = formatBlockLine(refNode);
          const stuLine = formatBlockLine(stuNode);
          // Pure rename already captured in the NameMap — show as context, not
          // a diff. But changedFields can still carry a real difference
          // invisible in the text (e.g. a procedure's own parameter swapped
          // for a same-named variable) — surface that instead of hiding it.
          if (refLine === stuLine) {
            if (!op.changedFields) {
              appendMatchRow(
                indentPrefix(op.refDepth) + refLine,
                op.studentBlockId,
                indentPrefix(op.studentDepth) + stuLine
              );
              lineCount++;
              continue;
            }
            const detail = changedFieldsSummary(op.changedFields);
            const leftFrag = document.createDocumentFragment();
            leftFrag.appendChild(makeDiffBadge("⚠", "sa-diff-changed"));
            leftFrag.appendChild(document.createTextNode(` ${indentPrefix(op.refDepth)}${refLine}`));
            const rightFrag = document.createDocumentFragment();
            rightFrag.appendChild(makeDiffBadge("⚠", "sa-diff-changed"));
            rightFrag.appendChild(document.createTextNode(` ${indentPrefix(op.studentDepth)}${stuLine} `));
            rightFrag.appendChild(
              Object.assign(document.createElement("span"), {
                className: "sa-diff-semantic-detail",
                textContent: `(${detail})`,
              })
            );
            bodyEl.appendChild(
              makeDiffBodyLineNode("change", leftFrag, null, null, "sa-diff-col-left sa-diff-row-start")
            );
            bodyEl.appendChild(
              makeDiffBodyLineNode(
                "change",
                rightFrag,
                op.studentBlockId,
                match.studentTarget.name,
                "sa-diff-col-right sa-diff-row-start"
              )
            );
            lineCount++;
            continue;
          }
          const wordOps = wordDiff(tokenizeLine(refLine), tokenizeLine(stuLine));
          const refHighlighted = buildDiffLineFragment(indentPrefix(op.refDepth), wordOps, "delete");
          const stuHighlighted = buildDiffLineFragment(indentPrefix(op.studentDepth), wordOps, "insert");
          bodyEl.appendChild(
            makeDiffBodyLineNode(
              "delete",
              refHighlighted,
              null,
              null,
              "sa-diff-line-partial sa-diff-col-left sa-diff-row-start"
            )
          );
          bodyEl.appendChild(
            makeDiffBodyLineNode(
              "insert",
              stuHighlighted,
              op.studentBlockId,
              match.studentTarget.name,
              "sa-diff-line-partial sa-diff-col-right sa-diff-row-start"
            )
          );
          lineCount++;
        }
      } else if (op.type === "insert") {
        const node = blockToIR(op.studentBlockId, stuBlocks);
        bodyEl.appendChild(makeDiffEmptyCell("sa-diff-col-left"));
        bodyEl.appendChild(
          makeDiffBodyLineNode(
            "insert",
            document.createTextNode(indentPrefix(op.studentDepth) + (node ? formatBlockLine(node) : op.opcode)),
            op.studentBlockId,
            match.studentTarget.name,
            "sa-diff-col-right"
          )
        );
        lineCount++;
      } else if (op.type === "delete") {
        const node = normalizeNodeForDisplay(blockToIR(op.refBlockId, refBlocks), spriteNameMap);
        bodyEl.appendChild(
          makeDiffBodyLineNode(
            "delete",
            document.createTextNode(indentPrefix(op.refDepth) + (node ? formatBlockLine(node) : op.opcode)),
            null,
            null,
            "sa-diff-col-left"
          )
        );
        bodyEl.appendChild(makeDiffEmptyCell("sa-diff-col-right"));
        lineCount++;
      }
    }
    return lineCount;
  }

  // An empty placeholder cell for the side of a split-view row that has no
  // counterpart (an insert's reference side, or a delete's student side).
  function makeDiffEmptyCell(extraClass) {
    return Object.assign(document.createElement("div"), {
      className: `sa-diff-line sa-diff-line-empty${extraClass ? ` ${extraClass}` : ""}`,
    });
  }

  const MIN_POPUP_WIDTH = 480;
  const MIN_POPUP_HEIGHT = 240;

  // Open a small floating, draggable, resizable panel containing just one
  // script's side-by-side (reference | student) diff. Kept separate from the
  // main inspector panel so the main script list can stay in its more compact
  // unified view while still offering the wider side-by-side layout on demand.
  function openSideBySidePopup(
    hatText,
    ops,
    refBlocks,
    stuBlocks,
    spriteNameMap,
    match,
    blockToIR,
    normalizeNodeForDisplay
  ) {
    const popup = Object.assign(document.createElement("div"), { className: "sa-inspector-sbs-popup" });

    const header = Object.assign(document.createElement("div"), { className: "sa-inspector-sbs-header" });
    const title = Object.assign(document.createElement("span"), {
      className: "sa-inspector-sbs-title",
      textContent: hatText,
    });
    const closeBtn = Object.assign(document.createElement("button"), {
      className: "sa-inspector-close-btn",
      textContent: "✕",
    });
    closeBtn.addEventListener("click", () => popup.remove());
    header.append(title, closeBtn);

    const bodyWrap = Object.assign(document.createElement("div"), { className: "sa-inspector-sbs-body-wrap" });
    const bodyEl = Object.assign(document.createElement("div"), {
      className: "sa-inspector-diff-body sa-diff-body-split",
    });
    renderDiffBodySplit(bodyEl, ops, refBlocks, stuBlocks, spriteNameMap, match, blockToIR, normalizeNodeForDisplay);
    bodyWrap.appendChild(bodyEl);

    popup.append(header, bodyWrap);
    makeDraggable(header, popup);
    // Unlike the main panel, this popup allows resizing from the right too —
    // its scrollbar is widened in CSS (see .sa-inspector-sbs-popup ::-webkit-
    // scrollbar) so there's still enough exposed scrollbar track to grab even
    // with the resize handle sharing the same edge.
    for (const dir of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
      popup.appendChild(makeResizeHandle(dir, popup));
    }

    const width = Math.max(MIN_POPUP_WIDTH, Math.min(900, window.innerWidth - 40));
    const height = Math.max(MIN_POPUP_HEIGHT, Math.min(600, window.innerHeight - 80));
    popup.style.width = width + "px";
    popup.style.height = height + "px";
    popup.style.left = Math.max(0, (window.innerWidth - width) / 2) + "px";
    popup.style.top = Math.max(0, (window.innerHeight - height) / 2) + "px";

    document.body.appendChild(popup);
  }

  function makeDiffBadge(text, cls) {
    return Object.assign(document.createElement("span"), { className: `sa-diff-badge ${cls}`, textContent: text });
  }

  // Summarise a "change" op's changedFields (Map<path, {ref, student}>) as
  // "ref → student, ref2 → student2, ...". Only meant for the case where the
  // rendered pseudocode text is identical on both sides (see
  // makeSemanticChangeLine and its split-view equivalent) — a normal word-diffed
  // line already shows the difference directly in its own text.
  function changedFieldsSummary(changedFields) {
    return [...changedFields.values()].map((c) => `${c.ref} → ${c.student}`).join(", ");
  }

  // Render a "change" op whose rendered pseudocode text is IDENTICAL on both
  // sides, but whose changedFields still recorded a real difference — e.g. a
  // procedure's own parameter swapped for a same-named variable. A word-diff
  // would highlight nothing (the words match), so this shows the line once with
  // a warning badge and the changedFields summary instead.
  function makeSemanticChangeLine(op, line, match, extraClass) {
    const frag = document.createDocumentFragment();
    frag.appendChild(makeDiffBadge("⚠ same text, different meaning", "sa-diff-changed"));
    frag.appendChild(document.createTextNode(` ${indentPrefix(op.studentDepth)}${line} `));
    frag.appendChild(
      Object.assign(document.createElement("span"), {
        className: "sa-diff-semantic-detail",
        textContent: `(${changedFieldsSummary(op.changedFields)})`,
      })
    );
    return makeDiffBodyLineNode("change", frag, op.studentBlockId, match.studentTarget.name, extraClass);
  }

  // Create a single diff body line with optional per-block 🎯 Go button.
  function makeDiffBodyLine(diffType, text, blockId, spriteName) {
    return makeDiffBodyLineNode(diffType, document.createTextNode(text), blockId, spriteName);
  }

  // Same as makeDiffBodyLine, but takes an arbitrary node (e.g. a fragment with
  // <mark> spans for token-level highlighting) instead of a plain text string.
  // `extraClass`, if given, is appended to the line's className (used to mark lines
  // that only highlight specific changed token(s) so the base text can stay neutral
  // instead of inheriting the delete/insert line's full red/green colour).
  function makeDiffBodyLineNode(diffType, contentNode, blockId, spriteName, extraClass) {
    const el = Object.assign(document.createElement("div"), {
      className: `sa-diff-line sa-diff-line-${diffType}${extraClass ? ` ${extraClass}` : ""}`,
    });
    el.appendChild(Object.assign(document.createElement("span"), { className: "sa-diff-line-text" })).appendChild(
      contentNode
    );
    if (blockId && spriteName) {
      const btn = Object.assign(document.createElement("button"), {
        className: "sa-diff-line-go",
        title: "Go to this block",
        textContent: "\uD83C\uDFAF",
      });
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await handleGotoBlock(`${spriteName} |  | [\u2192 ${blockId}]`, null);
        void highlightDiffBlocks([blockId]);
      });
      el.appendChild(btn);
    }
    return el;
  }

  // Split a rendered pseudocode line into tokens for word-level diffing, keeping
  // whitespace runs as their own tokens so the original spacing is preserved
  // exactly when reassembled.
  function tokenizeLine(line) {
    return line.split(/(\s+)/).filter((t) => t !== "");
  }

  // LCS-based diff between two token arrays — the same technique used for
  // statement-level diffing in project-differ.js, applied at word granularity for
  // display. Returns an array of {type: "match"|"delete"|"insert", token}.
  // Position (not content) disambiguates which occurrence changed, so this stays
  // correct even when the same word appears more than once in a line (e.g. a list
  // name used as both the source and destination of an "add ... to ..." block) —
  // unlike a plain substring search for a changed value.
  function wordDiff(refTokens, stuTokens) {
    const n = refTokens.length,
      m = stuTokens.length;
    const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = refTokens[i] === stuTokens[j] ? 1 + dp[i + 1][j + 1] : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const ops = [];
    let i = 0,
      j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && refTokens[i] === stuTokens[j]) {
        ops.push({ type: "match", token: refTokens[i] });
        i++;
        j++;
      } else if (j >= m || (i < n && dp[i + 1][j] >= dp[i][j + 1])) {
        ops.push({ type: "delete", token: refTokens[i] });
        i++;
      } else {
        ops.push({ type: "insert", token: stuTokens[j] });
        j++;
      }
    }
    return ops;
  }

  // Build a DocumentFragment for one side (ref or student) of a word-diff,
  // prefixed with `prefix` (e.g. "− " / "+ "). "match" tokens are kept as plain
  // text on both sides; tokens of `keepType` ("delete" for the ref side, "insert"
  // for the student side) are wrapped in <mark>; tokens of the other type are
  // omitted (they belong to the other side).
  function buildDiffLineFragment(prefix, ops, keepType) {
    const frag = document.createDocumentFragment();
    frag.appendChild(document.createTextNode(prefix));
    for (const op of ops) {
      if (op.type === "match") {
        frag.appendChild(document.createTextNode(op.token));
      } else if (op.type === keepType) {
        frag.appendChild(
          Object.assign(document.createElement("mark"), { className: "sa-diff-token-changed", textContent: op.token })
        );
      }
    }
    return frag;
  }

  // Render a single block as a pseudocode line (header only for C-blocks).
  // Render a single IRNode as a pseudocode line (header only for C-blocks).
  function formatBlockLine(node) {
    if (node.opcode === "procedures_definition") return "define " + procSignatureFromNode(node);
    const cDef = C_BLOCKS[node.opcode];
    if (cDef) return cDef.header(node);
    const fmt = STATEMENT_FORMATTERS[node.opcode];
    return fmt ? fmt(node) : node.opcode;
  }

  // Highlight block IDs in the current workspace using an SVG outline clone
  // (same technique as the find-bar carousel). Outlines persist until cleared.
  // The _diffOutlines array holds {path, outline} for cleanup.
  const _diffOutlines = [];

  function clearDiffHighlights() {
    for (const { outline } of _diffOutlines) outline.remove();
    _diffOutlines.length = 0;
    if (_diffHighlightCleanup) {
      _diffHighlightCleanup();
      _diffHighlightCleanup = null;
    }
  }

  function addDiffOutline(block) {
    const path = block?.pathObject?.svgPath ?? block?.svgPath_ ?? null;
    if (!path) {
      console.warn("[inspector:diff-outline] no SVG path for block", block?.id);
      return;
    }
    if (!path.parentNode) {
      console.warn("[inspector:diff-outline] path has no parentNode for block", block?.id);
      return;
    }
    const outline = path.cloneNode(true);
    outline.style.fill = "none";
    outline.style.stroke = "rgba(0,0,0,0.7)";
    outline.style.strokeWidth = "3";
    outline.style.pointerEvents = "none";
    outline.setAttribute("data-sa-diff-outline", "true");
    path.parentNode.appendChild(outline);
    _diffOutlines.push({ path, outline });
    console.log("[inspector:diff-outline] outlined block", block.id.slice(0, 8), block.type);
  }

  // Highlight the given student block IDs amber in the workspace for 5 seconds.
  let _diffHighlightCleanup = null;
  async function highlightDiffBlocks(studentBlockIds) {
    clearDiffHighlights();
    await ensureBlocklyReady();
    const workspace = addon.tab.traps.getWorkspace();
    if (!workspace) {
      console.warn("[inspector:diff-highlight] no workspace");
      return;
    }
    console.log("[inspector:diff-highlight] highlighting", studentBlockIds.length, "blocks");
    for (const id of studentBlockIds) {
      const block = workspace.getBlockById(id);
      if (!block) {
        console.warn("[inspector:diff-highlight] block not found in workspace:", id.slice(0, 12));
        continue;
      }
      addDiffOutline(block);
    }
    // Auto-clear outlines after 8 seconds
    const timer = setTimeout(clearDiffHighlights, 8000);
    _diffHighlightCleanup = () => clearTimeout(timer);
  }

  // Return a human-readable description of a hat/top-level IRNode.
  function getHatText(node) {
    if (!node) return "(unknown hat)";
    if (node.opcode === "procedures_definition") return "define " + procSignatureFromNode(node);
    const fmt = STATEMENT_FORMATTERS[node.opcode];
    return fmt ? fmt(node) : node.opcode;
  }

  // ─── Toolbar click ─────────────────────────────────────────────────────────

  async function handleToolbarClick() {
    toolbarBtn.disabled = true;
    try {
      const project = getCurrentProjectFromVM();
      currentFingerprint = fingerprintProject(project);
      upsertCurrentTab(await projectToPseudocode(project));
      ensureCompareTabs();
      if (!panel || !document.body.contains(panel)) createPanel();
      switchTab(0);
      renderTabs();
    } catch (e) {
      alert(msg("fetch-error", { error: String(e) }));
    } finally {
      toolbarBtn.disabled = false;
    }
  }

  // ─── Fetch & parse ─────────────────────────────────────────────────────────

  // Get the project currently loaded in the Scratch VM — includes unsaved changes.
  function getCurrentProjectFromVM() {
    const vm = addon.tab.redux.state?.scratchGui?.vm;
    if (!vm) throw new Error("Scratch VM not available in Redux state");
    return JSON.parse(vm.toJSON());
  }

  // Fetch a project by ID from the Scratch server.
  async function fetchProjectById(projectId) {
    const metaRes = await fetch(`https://api.scratch.mit.edu/projects/${projectId}`, {
      credentials: "include",
    });
    if (!metaRes.ok) throw new Error(`Metadata API HTTP ${metaRes.status}`);
    const meta = await metaRes.json();
    const token = meta.project_token;
    if (!token) throw new Error("No project_token in metadata response");

    // No credentials on the second request — projects server returns CORS wildcard
    const res = await fetch(`https://projects.scratch.mit.edu/${projectId}?token=${encodeURIComponent(token)}`);
    if (!res.ok) throw new Error(`Project storage HTTP ${res.status}`);
    return res.json();
  }

  async function handleFetchById() {
    const input = prompt(msg("fetch-prompt"), location.pathname.match(/\/projects\/(\d+)/)?.[1] ?? "");
    if (!input?.trim()) return;
    const projectId = input.trim();
    try {
      const project = await fetchProjectById(projectId);
      loadCompareReference(`#${projectId}`, await projectToComparePseudocode(project), project);
    } catch (e) {
      alert(msg("fetch-error", { error: String(e) }));
    }
  }

  // Read project.json out of a local .sb3 file (ZIP) using only browser APIs.
  // .sb3 is a ZIP file; project.json is always stored uncompressed or deflate-raw compressed.
  async function readSb3File(file) {
    const buf = await file.arrayBuffer();
    const view = new DataView(buf);

    // Locate the End-of-Central-Directory record (signature 0x06054b50) by scanning from the end.
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= 0; i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd === -1) throw new Error("Not a valid ZIP file");

    const cdOffset = view.getUint32(eocd + 16, true);
    const cdCount = view.getUint16(eocd + 8, true);

    // Walk the Central Directory to find project.json.
    let cdPos = cdOffset;
    for (let i = 0; i < cdCount; i++) {
      if (view.getUint32(cdPos, true) !== 0x02014b50) throw new Error("Bad central directory entry");
      const compression = view.getUint16(cdPos + 10, true);
      const compSize = view.getUint32(cdPos + 20, true);
      const uncompSize = view.getUint32(cdPos + 24, true);
      const fnLen = view.getUint16(cdPos + 28, true);
      const extraLen = view.getUint16(cdPos + 30, true);
      const commentLen = view.getUint16(cdPos + 32, true);
      const localOffset = view.getUint32(cdPos + 42, true);
      const name = new TextDecoder().decode(new Uint8Array(buf, cdPos + 46, fnLen));
      cdPos += 46 + fnLen + extraLen + commentLen;

      if (name !== "project.json") continue;

      // Found it — read the local file header to get the actual data offset.
      const localExtraLen = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + fnLen + localExtraLen;
      const compData = new Uint8Array(buf, dataStart, compSize);

      let jsonBytes;
      if (compression === 0) {
        // Stored (no compression)
        jsonBytes = compData;
      } else if (compression === 8) {
        // Deflate — use DecompressionStream (Chrome 80+, Firefox 113+)
        const ds = new DecompressionStream("deflate-raw");
        const writer = ds.writable.getWriter();
        writer.write(compData);
        writer.close();
        jsonBytes = new Uint8Array(await new Response(ds.readable).arrayBuffer());
        if (jsonBytes.byteLength !== uncompSize) throw new Error("Decompression size mismatch");
      } else {
        throw new Error(`Unsupported ZIP compression method: ${compression}`);
      }

      return JSON.parse(new TextDecoder().decode(jsonBytes));
    }
    throw new Error('"project.json" not found in .sb3 file');
  }

  // ─── GitHub Models API ────────────────────────────────────────────────────

  // Returns true if an API token has been configured.
  function hasApiToken() {
    return !!(addon.settings.get("apiToken") ?? "").trim();
  }

  // ─── Scratch pseudocode system prompt ────────────────────────────────────────
  // Injected as the system role on every API call so the LLM always writes
  // well-formed pseudocode that our parser can convert back to Scratch blocks.
  // Short system prompt used for project comparison calls.
  // The full SCRATCH_SYSTEM_PROMPT (code-generation rules) is not sent for
  // comparisons — it wastes ~600 tokens and is irrelevant to bug-finding.
  const COMPARE_SYSTEM_PROMPT = `\
You are a Scratch programming assistant helping teachers identify bugs in student projects by comparing them to a reference implementation.
You understand Scratch pseudocode notation: [x] = variable/list/menu target, (x) = reporter/value, <x> = boolean condition.
Sprites each have their own local variables; the Stage has global variables accessible by all sprites.
`;

  const SCRATCH_SYSTEM_PROMPT = `\
You are a Scratch programming assistant. You write pseudocode that maps directly to Scratch blocks — every line must correspond to a real Scratch block or control structure. There is no arbitrary code: no functions, no arrays, no break/continue, no return values. Only what Scratch blocks can do.

You may use ANY real Scratch block that exists. The syntax examples below are not exhaustive — they show the formatting conventions you must follow. The critical rules at the bottom are strict constraints that must always be obeyed.

## Scratch pseudocode syntax

Hat blocks (script starters):
  on green-flag:
  when green-flag clicked:
  when [key] key pressed:
  when this sprite clicked:
  when I receive [broadcast]:
  when I start as a clone:
  define blockName (param1) (param2)
  define warp blockName (param1) (param2)   ← "run without screen refresh" (faster, no rendering between calls)

Custom block calls (invoke a defined block by name with argument values in parens):
  blockName (value1) (value2)

Control blocks (always use 'end' to close, indented body):
  repeat (N):
    ...body...
  end

  repeat until <condition>:
    ...body...
  end

  forever:
    ...body...
  end

  if <condition> then:
    ...body...
  end

  if <condition> then:
    ...body...
  else:
    ...body...
  end

Variables and lists (use EXACT names from the project, with brackets/parens as shown):
  set [varName] to (value)
  change [varName] by (amount)
  (varName)               ← reporter (reads the variable)
  [listName]              ← list literal/reference
  (item (i) of [listName])
  (length of [listName])
  replace item (i) of [listName] with (value)
  add (value) to [listName]
  delete (i) of [listName]
  delete all of [listName]
  insert (value) at (i) of [listName]
  (item # of (value) in [listName])  ← finds position of value in list (0 if not found)

Operators:
  ((a) + (b))   ((a) - (b))   ((a) * (b))   ((a) / (b))   ((a) mod (b))
  <(a) > (b)>   <(a) < (b)>   <(a) = (b)>
  Scratch does NOT have <= or >=. Use <not <(a) > (b)>> for "a <= b" and <not <(a) < (b)>> for "a >= b".
  <condition1> and <condition2>
  <condition1> or <condition2>
  not <condition>

Looks / sound / motion — use exact block names:
  say [message]
  say [message] for (secs) secs
  move (steps) steps
  go to x: (x) y: (y)
  play sound [name] until done

## Critical rules
1. Use the EXACT variable, list, and broadcast names already in the project — do NOT rename, shorten, or generalise them. If the project has [my list], write [my list], not [list] or [arr].
2. Keep variable names SHORT and practical (i, j, temp, swapped) — do not invent long descriptive names like "current item" or "list size" when a short name works.
3. Do NOT use :: type annotations (no ":: list" or ":: variables").
4. Do NOT use the word "when" in hat blocks except for the accepted forms above — use "on green-flag:" not "when green flag clicked:".
5. Do NOT add comments inside pseudocode blocks — keep the code clean.
6. When writing an algorithm that needs loop counters, use single-letter names (i, j, k) unless the project already has longer names.
7. Produce complete, working pseudocode — not partial snippets.
8. Do NOT use "break" — Scratch has no break statement. The only early-exit is "stop this script", which stops the ENTIRE script immediately (not just the current loop). To exit a loop early without stopping everything, use a flag variable with repeat until instead.
9. Do NOT use "repeat index" or any other invented reporter. Scratch has no built-in loop counter — use a variable: set [i] to (1) before the loop, then change [i] by (1) at the end of each iteration.
10. Every "if" block MUST have a complete condition in angle brackets: if <condition> then: — never write "if  then:" or leave the condition blank.
11. Only use reporters and blocks that genuinely exist in Scratch. Do not invent new block names or reporters that Scratch does not have.
12. Scratch has no <= or >= operators. Never write them. Write <not <(a) > (b)>> for "a ≤ b" and <not <(a) < (b)>> for "a ≥ b".
13. Prefer fewer total block operations. Using delete+insert to place an item executes 2 operations; shifting N items with replace executes N operations. Choose whichever approach runs fewer blocks in total.
14. Out-of-bounds list access: (item (0) of [list]) and (item (n) of [list]) where n > length both return "" (empty string). This can be used deliberately, e.g. as a sentinel value to avoid a separate bounds check.
15. When using a custom block (define ...), ALWAYS include the full define script AND all calling scripts. Never write a call to a custom block without also providing its definition. Use "define warp ..." for recursive or inner-loop procedures — it runs without screen refresh and is significantly faster.
16. Do NOT write "end" after hat blocks (on green-flag:, define ..., when ...). Hat blocks are not c-blocks and have no closing "end". Only repeat, forever, if, and if/else blocks use "end".
17. Scratch has NO local variables. Variables do NOT have block scope or function scope. Every variable you declare is a sprite-level variable (visible across all scripts of that sprite) or a global variable (on the stage). There is no way to declare a variable "inside" a custom block so that it disappears when the block ends. If a script needs a temporary value, simply use a sprite variable (e.g. [temp]) — it is shared across the whole sprite. Never describe a variable as "local" or "declared inside" a block.
18. RECURSIVE custom blocks and sprite variables DO NOT MIX. Custom block parameters (the values in the define line) are call-stack-local — each recursive invocation gets its own copy. Sprite variables are NOT: every recursive call overwrites the same variable, so any value a caller stored before making a recursive call will be gone when control returns. This makes classic recursive divide-and-conquer algorithms (quicksort, mergesort, tree traversal) impossible to implement correctly in Scratch using variables for intermediate state — even a single "result" variable written by a helper will be overwritten before the caller can use it, if the caller itself recurses. The correct Scratch solution is to ELIMINATE RECURSION ENTIRELY and replace it with an explicit work stack using lists: push the initial work range onto the stack, then loop until the stack is empty, popping one item per iteration, doing the non-recursive work (e.g. partitioning), and pushing any sub-ranges back onto the stack. Non-recursive helper blocks (blocks that do not call themselves) are safe to use variables in, because there is no deeper call to clobber them.
`;

  // Call the GitHub Models API and stream the response text into `tab`.
  // `tab` must already be pushed into `tabs` and displayed before calling.
  // On each chunk the Issues tab is re-rendered in streaming state.
  async function streamToIssuesTab(promptText, tab, systemPrompt = SCRATCH_SYSTEM_PROMPT) {
    const token = (addon.settings.get("apiToken") ?? "").trim();
    const model = (addon.settings.get("apiModel") ?? "gpt-4o").trim();

    tab.issueState = "streaming";
    tab.streamText = "";
    void renderIssuesContent(tab);

    let response;
    try {
      response = await fetch("https://models.inference.ai.azure.com/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: promptText },
          ],
          stream: true,
          stream_options: { include_usage: true },
        }),
      });
    } catch (e) {
      tab.issueState = "paste";
      void renderIssuesContent(tab);
      alert(`API request failed: ${e}`);
      return;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      tab.issueState = "paste";
      void renderIssuesContent(tab);
      alert(`GitHub Models API error ${response.status}: ${body.slice(0, 200)}`);
      return;
    }

    // Read the SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Keep live references via tab object (set by renderIssuesContent)
    let firstChunk = true;
    let usageIn = 0,
      usageOut = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;
        try {
          const chunk = JSON.parse(data);
          // Capture usage stats — usually in the final chunk
          if (chunk.usage) {
            usageIn = chunk.usage.prompt_tokens ?? usageIn;
            usageOut = chunk.usage.completion_tokens ?? usageOut;
          }
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) {
            if (firstChunk && tab._streamHeader) {
              tab._streamHeader.textContent = "⏳ Receiving response…";
              tab._streamHeader.classList.remove("sa-inspector-stream-waiting");
              firstChunk = false;
            }
            tab.streamText += delta;
            if (tab._streamContainer) renderStreamingMarkdown(tab.streamText, tab._streamContainer);
          }
        } catch {
          /* ignore malformed chunks */
        }
      }
    }

    // Stream finished — render full markdown response
    tab.issueState = tab.streamText.trim().length > 0 ? "cards" : "paste";
    tab.content = tab.streamText;
    // Estimate cost. If the API returned usage data, use it; otherwise approximate
    // from character count (rough heuristic: ~4 chars per token).
    const costPerMTok = {
      "gpt-4o": { in: 2.5, out: 10.0 },
      "gpt-4.1": { in: 2.0, out: 8.0 },
      "gpt-4o-mini": { in: 0.15, out: 0.6 },
      "o4-mini": { in: 1.1, out: 4.4 },
      "claude-3-7-sonnet": { in: 3.0, out: 15.0 },
    };
    const rates = costPerMTok[model] ?? { in: 2.5, out: 10.0 };
    if (usageIn === 0) {
      // API didn't return usage — estimate from prompt/response char counts
      usageIn = Math.round(promptText.length / 4);
      usageOut = Math.round(tab.streamText.length / 4);
    }
    const estCostUsd = (usageIn / 1e6) * rates.in + (usageOut / 1e6) * rates.out;
    tab._usageSummary = `${usageIn.toLocaleString()} in / ${usageOut.toLocaleString()} out tokens ≈ $${estCostUsd.toFixed(4)}`;
    void renderIssuesContent(tab);
  }

  // Build a comparison prompt for an LLM given student and reference pseudocode.
  function buildAskPrompt(projectCode, question) {
    return [
      "Below is a Scratch project exported as pseudocode.",
      "",
      "My question or request is:",
      `"${question}"`,
      "",
      "Please answer directly and concisely, based specifically on this project's code.",
      "When referencing or writing a specific script, wrap it in a fenced code block whose first line is:",
      "  SpriteName | hat block description | [→ blockId]",
      "Subsequent lines show the relevant pseudocode.",
      "",
      "=".repeat(60),
      "PROJECT",
      "=".repeat(60),
      projectCode,
    ].join("\n");
  }

  function buildComparisonPrompt(studentCode, refCode, refName) {
    const refLabel = refName ? `REFERENCE PROJECT (${refName})` : "REFERENCE PROJECT";
    return [
      "Compare the STUDENT PROJECT against the REFERENCE PROJECT below.",
      "Match scripts by sprite name, hat block type, and structure — NOT by SCRIPT number.",
      "Empty scripts in the reference are placeholders; ignore them.",
      "",
      "VARIABLE AND LIST NAMES: Students often rename variables and lists (e.g. 'lives' instead of 'Lives', 'vel' instead of 'xVelocity'). Check consistency WITHIN THE STUDENT PROJECT ONLY — not against the reference names. If the renamed variable is set and read consistently within the student project and the logic is equivalent, this is NOT a bug. Only flag a variable/list as broken if within the student project one script sets [x] but another reads [y] for the same conceptual value, or if a variable that must be global (shared across sprites) is accidentally scoped to a single sprite.",
      "BROADCAST NAMES: Students often rename broadcasts (e.g. 'startGame' instead of 'Start'). Check consistency WITHIN THE STUDENT PROJECT ONLY — not against the reference names. If every 'broadcast [X]' in the student project is matched by a 'when I receive [X]' handler somewhere in the student project, the rename is consistent and NOT a bug. Only flag a broadcast as broken if a broadcast is sent but has NO matching receiver in the student project, or a receiver has no matching sender in the student project.",
      "CUSTOM BLOCK (PROCEDURE) NAMES: Students often rename custom blocks (e.g. 'move player' instead of 'movePlayer'). Check consistency WITHIN THE STUDENT PROJECT ONLY. If the renamed block is defined and called consistently within the student project, this is NOT a bug. Only flag a custom block as broken if a call has no matching definition in the student project, or a definition is never called.",
      "",
      "Report under exactly these headings, in this order:",
      "1. Breaking bugs — changes almost certain to prevent the game working correctly (e.g. wrong condition, missing broadcast, wrong operator, wrong variable scope). List the most game-breaking first. Do NOT list variable renames that preserve the logic.",
      "   IMPORTANT: check variable scope — variables listed under STAGE are global (for all sprites); variables listed under a SPRITE are local (for this sprite only). A variable that should be global but is local (or vice versa) is a breaking bug — the wrong sprite will read it.",
      "2. Likely bugs — code that looks wrong but might only affect some situations.",
      "3. Missing scripts — scripts present in the reference but absent from the student project.",
      "4. Intentional differences — things that differ but are probably deliberate, including variable/list renames, broadcast renames, and custom block renames where the logic is preserved. Keep this section brief.",
      "",
      "When citing a bug, always wrap the evidence in a fenced code block. The first line must be: SpriteName | hat block description | [→ blockId]",
      "Subsequent lines show the relevant pseudocode and what is wrong. Example:",
      "```",
      "Laser | when I start as a clone | [→ -P|Ws|MMN@a3)1rr`2N9]",
      "change x by (ShakeDY)   ← should be ShakeDX",
      "```",
      "Be specific about what differs from the reference. Prioritise bugs that would stop the game running or make it unwinnable.",
      "",
      "=".repeat(60),
      "STUDENT PROJECT",
      "=".repeat(60),
      studentCode,
      "",
      "=".repeat(60),
      refLabel,
      "=".repeat(60),
      refCode,
    ].join("\n");
  }

  function handleLoadSb3() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".sb3,.sb2";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const project = await readSb3File(file);
        const label = file.name.replace(/\.sb[23]$/i, "");
        loadCompareReference(label, await projectToComparePseudocode(project), project);
      } catch (e) {
        alert(msg("fetch-error", { error: String(e) }));
      }
    });
    input.click();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Block-to-pseudocode converter
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── Field / input helpers ─────────────────────────────────────────────────
  //
  // These operate on IRNodes (see block-ir.js) rather than raw VM block JSON.
  // Every entry in INLINE_FORMATTERS / STATEMENT_FORMATTERS / C_BLOCKS below calls
  // ONLY these shared helpers to read fields/inputs — never `.fields`/`.inputs`
  // directly — so migrating rendering onto the IR only required rewriting the
  // handful of helpers here, not any of the ~80 per-opcode formatter entries.

  function field(node, name) {
    return node.fields?.[name] ?? "?";
  }

  // Escape helpers for user-defined names. Each escapes only the characters that would
  // break that particular delimiter pair. Spaces and most punctuation are left as-is so
  // the output stays readable (e.g. [SHAKE DX] rather than ["SHAKE DX"]).

  // For names inside [...] — only ] and \ are dangerous
  function qVar(str) {
    return str.replace(/\\/g, "\\\\").replace(/]/g, "\\]");
  }
  // For string literals inside "..." — only " and \ are dangerous
  function qStr(str) {
    return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }
  // For proc arg names inside (...) — only ) and \ are dangerous
  function qParen(str) {
    return str.replace(/\\/g, "\\\\").replace(/\)/g, "\\)");
  }
  // For proc arg boolean names inside <...> — only > and \ are dangerous
  function qAngle(str) {
    return str.replace(/\\/g, "\\\\").replace(/>/g, "\\>");
  }

  // Scratch uses underscore-wrapped tokens for a handful of built-in menu targets;
  // translate them to readable names when rendering a bare shadow-menu slot.
  const INTERNAL_TOKENS = {
    _myself_: "myself",
    _mouse_: "mouse-pointer",
    _random_: "random position",
    _edge_: "edge",
    _stage_: "Stage",
  };

  // Render a "literal" InputSlot (see block-ir.js) to a string, using its `shape`
  // to pick bracket style — this replicates the old per-storage-format behaviour
  // (an inline number/string/colour primitive vs. a bare shadow-menu selection)
  // now that both are unified into one slot shape by the IR.
  function renderLiteralSlot(slot) {
    const value = slot.value ?? "";
    switch (slot.shape) {
      case "number":
        return `(${value})`;
      case "colour":
        return value;
      case "string":
        // numeric-looking text still renders as a number; empty string as [""]
        if (value !== "" && isFinite(value)) return `(${value})`;
        return value === "" ? `[""]` : `[${qVar(value)}]`;
      case "menu":
      default:
        // Bare shadow-menu text (e.g. a costume/sound/target dropdown) — brackets
        // (if any) are added by the caller (resolveSlot), not here.
        return qVar(INTERNAL_TOKENS[value] ?? value);
    }
  }

  // Resolve an InputSlot to a string (reporter block, variable/list/broadcast name,
  // or literal). Recurses into nested reporters via `slot.node` — no blocksDict
  // lookup needed, since the IR already carries every child node inline.
  function resolveInput(_blocks, node, inputName) {
    const slot = node.inputs?.[inputName];
    if (!slot) return "?";
    switch (slot.kind) {
      case "literal":
        return renderLiteralSlot(slot);
      case "variable":
      case "list":
        // Variable/list reporters used as a value — (name) round brackets.
        return `(${qVar(slot.name)})`;
      case "broadcast":
        return `[${qVar(slot.name)}]`;
      case "block": {
        const fmt = INLINE_FORMATTERS[slot.node.opcode];
        return fmt ? fmt(slot.node) : `(${slot.node.opcode})`;
      }
      case "empty":
      default:
        return "?";
    }
  }

  // Resolve a slot that may be either a fixed menu choice or a computed reporter.
  // Fixed menu values (bare text from a shadow block) get wrapped in [...].
  // Computed values that already carry their own delimiters — (reporter), <bool>,
  // [broadcast], [text] — are returned as-is.
  function resolveSlot(_blocks, node, inputName) {
    const val = resolveInput(_blocks, node, inputName);
    // Already delimited — reporter, boolean, broadcast, or string literal
    if (val.startsWith("(") || val.startsWith("<") || val.startsWith("[")) return val;
    // Bare menu text — wrap in [...]
    return `[${val}]`;
  }

  // ─── Procedure helpers ─────────────────────────────────────────────────────

  // Sorting-only helper (see getOrderedTopLevelIds) — reads raw block JSON directly
  // since it runs before any IR conversion happens for a target's scripts. Kept
  // separate from procSignatureFromNode below (the rendering-path equivalent) to
  // avoid forcing the purely-synchronous sort/order logic to depend on the IR.
  function getProcSignature(blocks, defBlock) {
    const protoInput = defBlock.inputs?.["custom_block"];
    if (!protoInput) return "(unknown)";
    const protoId = typeof protoInput[1] === "string" ? protoInput[1] : null;
    const proto = protoId ? blocks[protoId] : null;
    if (!proto?.mutation) return "(unknown)";
    return formatProccode(proto.mutation.proccode ?? "", JSON.parse(proto.mutation.argumentnames ?? "[]"));
  }

  // Format a proccode string, replacing %s/%b with arg names wrapped in ()/< >
  // e.g. "jump %s times %b" with args ["height","is fast"] → `jump (height) times <is fast>`
  function formatProccode(proccode, argNames) {
    let i = 0;
    return proccode.replace(/%[sb]/g, (match) => {
      const name = argNames[i++] ?? "?";
      return match === "%s" ? `(${qParen(name)})` : `<${qAngle(name)}>`;
    });
  }

  // Render a procedures_definition IRNode's signature, e.g.
  // "jump (height) times <is fast>". The prototype's proccode/argumentnames are
  // already promoted onto the definition node's own `mutation` by blockToIR.
  function procSignatureFromNode(defNode) {
    if (!defNode.mutation) return "(unknown)";
    return formatProccode(defNode.mutation.proccode ?? "", defNode.mutation.argumentnames ?? []);
  }

  // Render a procedures_call IRNode's text, e.g. "jump (10) times <true>".
  // mutation.argumentids is already a decoded array (see block-ir.js).
  function formatProcCall(node) {
    const proccode = node.mutation?.proccode ?? "(unknown)";
    const argIds = node.mutation?.argumentids ?? [];
    let i = 0;
    return proccode.replace(/%[sb]/g, () => {
      const id = argIds[i++];
      return id ? resolveInput(null, node, id) : "?";
    });
  }

  // ─── Inline (reporter/boolean) formatters ──────────────────────────────────

  const INLINE_FORMATTERS = {
    // Motion reporters
    motion_xposition: () => "(x position)",
    motion_yposition: () => "(y position)",
    motion_direction: () => "(direction)",

    // Looks reporters
    looks_costumenumbername: (b) => `(costume ${field(b, "NUMBER_NAME")})`,
    looks_backdropnumbername: (b) => `(backdrop ${field(b, "NUMBER_NAME")})`,
    looks_size: () => "(size)",

    // Sound reporters
    sound_volume: () => "(volume)",

    // Sensing reporters / booleans
    sensing_answer: () => "(answer)",
    sensing_timer: () => "(timer)",
    sensing_loudness: () => "(loudness)",
    sensing_mousex: () => "(mouse x)",
    sensing_mousey: () => "(mouse y)",
    sensing_mousedown: () => "<mouse down?>",
    sensing_keypressed: (b, blocks) => `<key ${resolveSlot(blocks, b, "KEY_OPTION")} pressed?>`,
    sensing_touchingobject: (b, blocks) => `<touching ${resolveSlot(blocks, b, "TOUCHINGOBJECTMENU")}?>`,
    sensing_touchingcolor: (b, blocks) => `<touching color ${resolveInput(blocks, b, "COLOR")}?>`,
    sensing_coloristouchingcolor: (b, blocks) =>
      `<color ${resolveInput(blocks, b, "COLOR")} touching ${resolveInput(blocks, b, "COLOR2")}?>`,
    sensing_distanceto: (b, blocks) => `(distance to ${resolveSlot(blocks, b, "DISTANCETOMENU")})`,
    sensing_of: (b, blocks) => `(${field(b, "PROPERTY")} of ${resolveSlot(blocks, b, "OBJECT")})`,
    sensing_current: (b) => `(current [${field(b, "CURRENTMENU")}])`,
    sensing_username: () => "(username)",
    sensing_dayssince2000: () => "(days since 2000)",

    // Operators
    operator_add: (b, blocks) => `(${resolveInput(blocks, b, "NUM1")} + ${resolveInput(blocks, b, "NUM2")})`,
    operator_subtract: (b, blocks) => `(${resolveInput(blocks, b, "NUM1")} - ${resolveInput(blocks, b, "NUM2")})`,
    operator_multiply: (b, blocks) => `(${resolveInput(blocks, b, "NUM1")} * ${resolveInput(blocks, b, "NUM2")})`,
    operator_divide: (b, blocks) => `(${resolveInput(blocks, b, "NUM1")} / ${resolveInput(blocks, b, "NUM2")})`,
    operator_mod: (b, blocks) => `(${resolveInput(blocks, b, "NUM1")} mod ${resolveInput(blocks, b, "NUM2")})`,
    operator_random: (b, blocks) => `(random ${resolveInput(blocks, b, "FROM")} to ${resolveInput(blocks, b, "TO")})`,
    operator_round: (b, blocks) => `(round ${resolveInput(blocks, b, "NUM")})`,
    operator_mathop: (b, blocks) => `(${field(b, "OPERATOR")} of ${resolveInput(blocks, b, "NUM")})`,
    operator_lt: (b, blocks) => `<${resolveInput(blocks, b, "OPERAND1")} < ${resolveInput(blocks, b, "OPERAND2")}>`,
    operator_gt: (b, blocks) => `<${resolveInput(blocks, b, "OPERAND1")} > ${resolveInput(blocks, b, "OPERAND2")}>`,
    operator_equals: (b, blocks) => `<${resolveInput(blocks, b, "OPERAND1")} = ${resolveInput(blocks, b, "OPERAND2")}>`,
    operator_and: (b, blocks) => `<${resolveInput(blocks, b, "OPERAND1")} and ${resolveInput(blocks, b, "OPERAND2")}>`,
    operator_or: (b, blocks) => `<${resolveInput(blocks, b, "OPERAND1")} or ${resolveInput(blocks, b, "OPERAND2")}>`,
    operator_not: (b, blocks) => `<not ${resolveInput(blocks, b, "OPERAND")}>`,
    operator_join: (b, blocks) => `(join ${resolveInput(blocks, b, "STRING1")} ${resolveInput(blocks, b, "STRING2")})`,
    operator_letter_of: (b, blocks) =>
      `(letter ${resolveInput(blocks, b, "LETTER")} of ${resolveInput(blocks, b, "STRING")})`,
    operator_length: (b, blocks) => `(length of ${resolveInput(blocks, b, "STRING")})`,
    operator_contains: (b, blocks) =>
      `<${resolveInput(blocks, b, "STRING1")} contains ${resolveInput(blocks, b, "STRING2")}?>`,

    // Variable reporter as a value — (name) not a selector
    data_variable: (b) => `(${qVar(field(b, "VARIABLE"))})`,
    // List operations — list name in [...]
    data_itemoflist: (b, blocks) => `(item ${resolveInput(blocks, b, "INDEX")} of [${qVar(field(b, "LIST"))}])`,
    data_itemnumoflist: (b, blocks) => `(item # of ${resolveInput(blocks, b, "ITEM")} in [${qVar(field(b, "LIST"))}])`,
    data_lengthoflist: (b) => `(length of [${qVar(field(b, "LIST"))}])`,
    data_listcontainsitem: (b, blocks) => `<[${qVar(field(b, "LIST"))}] contains ${resolveInput(blocks, b, "ITEM")}?>`,

    // Procedure argument reporters — names in (...)/< > so escape ) or > only
    argument_reporter_string_number: (b) => `(${qParen(field(b, "VALUE"))})`,
    argument_reporter_boolean: (b) => `<${qAngle(field(b, "VALUE"))}>`,
  };

  // ─── Statement formatters (non-C blocks) ───────────────────────────────────

  const HAT_ORDER = [
    "event_whenflagclicked",
    "event_whenbroadcastreceived",
    "event_whenkeypressed",
    "event_whenthisspriteclicked",
    "event_whenstageclicked",
    "event_whenbackdropswitchesto",
    "event_whengreaterthan",
    "control_start_as_clone",
    "procedures_definition",
  ];

  const STATEMENT_FORMATTERS = {
    // Hat blocks (also used as statement header lines)
    event_whenflagclicked: () => "on green-flag:",
    event_whenkeypressed: (b) => `on key [${field(b, "KEY_OPTION")}] pressed:`,
    event_whenthisspriteclicked: () => "on this sprite clicked:",
    event_whenstageclicked: () => "on stage clicked:",
    // backdrop name is user-defined — escape ] inside [...]
    event_whenbackdropswitchesto: (b) => `on backdrop switches to [${qVar(field(b, "BACKDROP"))}]:`,
    event_whengreaterthan: (b, blocks) =>
      `on ${field(b, "WHENGREATERTHANMENU")} > ${resolveInput(blocks, b, "VALUE")}:`,
    event_whenbroadcastreceived: (b) => `on receive [${qVar(field(b, "BROADCAST_OPTION"))}]:`,
    control_start_as_clone: () => "on start as clone:",

    // Motion
    motion_movesteps: (b, blocks) => `move ${resolveInput(blocks, b, "STEPS")} steps`,
    motion_turnright: (b, blocks) => `turn right ${resolveInput(blocks, b, "DEGREES")} degrees`,
    motion_turnleft: (b, blocks) => `turn left ${resolveInput(blocks, b, "DEGREES")} degrees`,
    motion_goto: (b, blocks) => `go to ${resolveSlot(blocks, b, "TO")}`,
    motion_gotoxy: (b, blocks) => `go to x: ${resolveInput(blocks, b, "X")} y: ${resolveInput(blocks, b, "Y")}`,
    motion_glidesecstoxy: (b, blocks) =>
      `glide ${resolveInput(blocks, b, "SECS")} secs to x: ${resolveInput(blocks, b, "X")} y: ${resolveInput(blocks, b, "Y")}`,
    motion_glideto: (b, blocks) => `glide ${resolveInput(blocks, b, "SECS")} secs to ${resolveSlot(blocks, b, "TO")}`,
    motion_pointindirection: (b, blocks) => `point in direction ${resolveInput(blocks, b, "DIRECTION")}`,
    motion_pointtowards: (b, blocks) => `point towards ${resolveSlot(blocks, b, "TOWARDS")}`,
    motion_changexby: (b, blocks) => `change x by ${resolveInput(blocks, b, "DX")}`,
    motion_setx: (b, blocks) => `set x to ${resolveInput(blocks, b, "X")}`,
    motion_changeyby: (b, blocks) => `change y by ${resolveInput(blocks, b, "DY")}`,
    motion_sety: (b, blocks) => `set y to ${resolveInput(blocks, b, "Y")}`,
    motion_ifonedgebounce: () => "if on edge, bounce",
    motion_setrotationstyle: (b) => `set rotation style [${field(b, "STYLE")}]`,

    // Looks
    looks_say: (b, blocks) => `say ${resolveInput(blocks, b, "MESSAGE")}`,
    looks_sayforsecs: (b, blocks) =>
      `say ${resolveInput(blocks, b, "MESSAGE")} for ${resolveInput(blocks, b, "SECS")} secs`,
    looks_think: (b, blocks) => `think ${resolveInput(blocks, b, "MESSAGE")}`,
    looks_thinkforsecs: (b, blocks) =>
      `think ${resolveInput(blocks, b, "MESSAGE")} for ${resolveInput(blocks, b, "SECS")} secs`,
    looks_switchcostumeto: (b, blocks) => `switch costume to ${resolveSlot(blocks, b, "COSTUME")}`,
    looks_nextcostume: () => "next costume",
    looks_switchbackdropto: (b, blocks) => `switch backdrop to ${resolveSlot(blocks, b, "BACKDROP")}`,
    looks_nextbackdrop: () => "next backdrop",
    looks_changesizeby: (b, blocks) => `change size by ${resolveInput(blocks, b, "CHANGE")}`,
    looks_setsizeto: (b, blocks) => `set size to ${resolveInput(blocks, b, "SIZE")}%`,
    looks_changeeffectby: (b, blocks) =>
      `change [${field(b, "EFFECT")}] effect by ${resolveInput(blocks, b, "CHANGE")}`,
    looks_seteffectto: (b, blocks) => `set [${field(b, "EFFECT")}] effect to ${resolveInput(blocks, b, "VALUE")}`,
    looks_cleargraphiceffects: () => "clear graphic effects",
    looks_show: () => "show",
    looks_hide: () => "hide",
    looks_gotofrontback: (b) => `go to ${field(b, "FRONT_BACK")}`,
    looks_goforwardbackwardlayers: (b, blocks) =>
      `go ${field(b, "FORWARD_BACKWARD")} ${resolveInput(blocks, b, "NUM")} layers`,

    // Sound
    sound_playuntildone: (b, blocks) => `play sound ${resolveSlot(blocks, b, "SOUND_MENU")} until done`,
    sound_play: (b, blocks) => `start sound ${resolveSlot(blocks, b, "SOUND_MENU")}`,
    sound_stopallsounds: () => "stop all sounds",
    sound_changeeffectby: (b, blocks) => `change [${field(b, "EFFECT")}] effect by ${resolveInput(blocks, b, "VALUE")}`,
    sound_seteffectto: (b, blocks) => `set [${field(b, "EFFECT")}] effect to ${resolveInput(blocks, b, "VALUE")}`,
    sound_cleareffects: () => "clear sound effects",
    sound_changevolumeby: (b, blocks) => `change volume by ${resolveInput(blocks, b, "VOLUME")}`,
    sound_setvolumeto: (b, blocks) => `set volume to ${resolveInput(blocks, b, "VOLUME")}%`,

    // Events
    event_broadcast: (b, blocks) => `broadcast ${resolveInput(blocks, b, "BROADCAST_INPUT")}`,
    event_broadcastandwait: (b, blocks) => `broadcast ${resolveInput(blocks, b, "BROADCAST_INPUT")} and wait`,

    // Control (non-C)
    control_wait: (b, blocks) => `wait ${resolveInput(blocks, b, "DURATION")} secs`,
    control_wait_until: (b, blocks) => `wait until ${resolveInput(blocks, b, "CONDITION")}`,
    control_stop: (b) => `stop [${field(b, "STOP_OPTION")}]`,
    control_create_clone_of: (b, blocks) => `create clone of ${resolveSlot(blocks, b, "CLONE_OPTION")}`,
    control_delete_this_clone: () => "delete this clone",

    // Sensing
    sensing_askandwait: (b, blocks) => `ask ${resolveInput(blocks, b, "QUESTION")} and wait`,
    sensing_resettimer: () => "reset timer",
    sensing_setdragmode: (b) => `set drag mode [${field(b, "DRAG_MODE")}]`,

    // Variable set/change targets — [name]
    data_setvariableto: (b, blocks) => `set [${qVar(field(b, "VARIABLE"))}] to ${resolveInput(blocks, b, "VALUE")}`,
    data_changevariableby: (b, blocks) =>
      `change [${qVar(field(b, "VARIABLE"))}] by ${resolveInput(blocks, b, "VALUE")}`,
    data_showvariable: (b) => `show variable [${qVar(field(b, "VARIABLE"))}]`,
    data_hidevariable: (b) => `hide variable [${qVar(field(b, "VARIABLE"))}]`,

    // List targets — [name]
    data_addtolist: (b, blocks) => `add ${resolveInput(blocks, b, "ITEM")} to [${qVar(field(b, "LIST"))}]`,
    data_deleteoflist: (b, blocks) => `delete ${resolveInput(blocks, b, "INDEX")} of [${qVar(field(b, "LIST"))}]`,
    data_deletealloflist: (b) => `delete all of [${qVar(field(b, "LIST"))}]`,
    data_insertatlist: (b, blocks) =>
      `insert ${resolveInput(blocks, b, "ITEM")} at ${resolveInput(blocks, b, "INDEX")} of [${qVar(field(b, "LIST"))}]`,
    data_replaceitemoflist: (b, blocks) =>
      `replace item ${resolveInput(blocks, b, "INDEX")} of [${qVar(field(b, "LIST"))}] with ${resolveInput(blocks, b, "ITEM")}`,
    data_showlist: (b) => `show list [${qVar(field(b, "LIST"))}]`,
    data_hidelist: (b) => `hide list [${qVar(field(b, "LIST"))}]`,

    // Procedures (statement call)
    procedures_call: (b) => formatProcCall(b),
  };

  // ─── C-block (control structure) definitions ───────────────────────────────
  // Each entry: { header(b,blocks), substacks: [inputNames], elseLabel? }

  const C_BLOCKS = {
    control_repeat: {
      header: (b, blocks) => `repeat ${resolveInput(blocks, b, "TIMES")}:`,
      substacks: ["SUBSTACK"],
    },
    control_forever: {
      header: () => "forever:",
      substacks: ["SUBSTACK"],
      noEnd: true,
    },
    control_if: {
      header: (b, blocks) => `if ${resolveInput(blocks, b, "CONDITION")} then:`,
      substacks: ["SUBSTACK"],
    },
    control_if_else: {
      header: (b, blocks) => `if ${resolveInput(blocks, b, "CONDITION")} then:`,
      substacks: ["SUBSTACK", "SUBSTACK2"],
      elseLabel: "else:",
    },
    control_repeat_until: {
      header: (b, blocks) => `repeat until ${resolveInput(blocks, b, "CONDITION")}:`,
      substacks: ["SUBSTACK"],
    },
  };

  // ─── Sequence renderer ─────────────────────────────────────────────────────

  // Renders a chain of statement IRNodes (starting at `node`) into pseudocode
  // lines. Purely synchronous — substacks are already arrays of IRNodes (built
  // once by block-ir.js), so no further block lookups or async imports are needed
  // once the caller has converted the script's hat to an IRNode.
  function renderSequence(node, indent) {
    const lines = [];
    let cur = node;

    while (cur) {
      const cDef = C_BLOCKS[cur.opcode];
      if (cDef) {
        lines.push(indent + cDef.header(cur));
        for (let si = 0; si < cDef.substacks.length; si++) {
          if (si === 1 && cDef.elseLabel) lines.push(indent + cDef.elseLabel);
          const body = cur.substacks[cDef.substacks[si]];
          if (body && body.length > 0) {
            lines.push(...renderSequence(body[0], indent + "  "));
          }
        }
        if (!cDef.noEnd) lines.push(indent + "end");
      } else {
        const fmt = STATEMENT_FORMATTERS[cur.opcode];
        if (fmt) {
          lines.push(indent + fmt(cur));
        } else {
          // Unknown / extension block — show opcode and key fields
          const fieldStr = Object.entries(cur.fields)
            .map(([k, v]) => `${k}: ${v}`)
            .join(", ");
          lines.push(indent + `[${cur.opcode}${fieldStr ? ` | ${fieldStr}` : ""}]`);
        }
      }

      cur = cur.next;
    }

    return lines;
  }

  // ─── Script ordering ───────────────────────────────────────────────────────

  function hatPriority(block) {
    const idx = HAT_ORDER.indexOf(block.opcode);
    return idx === -1 ? HAT_ORDER.length : idx;
  }

  // Collect all procedure names called (depth-first) from a top-level script
  function collectCallOrder(blocks, startId, seen, order) {
    let currentId = startId;
    while (currentId) {
      const block = blocks[currentId];
      if (!block) break;
      // recurse into all inputs that are blocks
      for (const input of Object.values(block.inputs ?? {})) {
        const candidateId = input[1];
        if (typeof candidateId === "string" && blocks[candidateId]) {
          collectCallOrder(blocks, candidateId, seen, order);
        }
      }
      // recurse into substacks
      for (const name of ["SUBSTACK", "SUBSTACK2"]) {
        const sub = block.inputs?.[name];
        if (sub && typeof sub[1] === "string") {
          collectCallOrder(blocks, sub[1], seen, order);
        }
      }
      if (block.opcode === "procedures_call") {
        const proccode = block.mutation?.proccode;
        if (proccode && !seen.has(proccode)) {
          seen.add(proccode);
          order.push(proccode);
        }
      }
      currentId = block.next;
    }
  }

  function getOrderedTopLevelIds(blocks) {
    const allTopLevel = Object.entries(blocks)
      .filter(([, b]) => b.topLevel)
      .map(([id, b]) => ({ id, block: b }));

    const hats = allTopLevel.filter(({ block }) => block.opcode !== "procedures_prototype");
    const defs = hats.filter(({ block }) => block.opcode === "procedures_definition");
    const nonDefs = hats.filter(({ block }) => block.opcode !== "procedures_definition");

    // Sort non-def hats by HAT_ORDER priority, then by a secondary key for stability
    nonDefs.sort((a, b) => {
      const pd = hatPriority(a.block) - hatPriority(b.block);
      if (pd !== 0) return pd;
      // secondary: field value (e.g. message name, key name)
      const fa = Object.values(a.block.fields ?? {})[0]?.[0] ?? "";
      const fb = Object.values(b.block.fields ?? {})[0]?.[0] ?? "";
      return fa.localeCompare(fb);
    });

    // Determine call order for procedure definitions
    const callOrder = [];
    const seen = new Set();
    for (const { id } of nonDefs) {
      collectCallOrder(blocks, id, seen, callOrder);
    }

    // Sort defs by call order, then alphabetically for uncalled ones
    defs.sort((a, b) => {
      const sigA = getProcSignature(blocks, a.block);
      const sigB = getProcSignature(blocks, b.block);
      const ia = callOrder.indexOf(a.block.mutation?.proccode ?? sigA);
      const ib = callOrder.indexOf(b.block.mutation?.proccode ?? sigB);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return sigA.localeCompare(sigB);
    });

    return [...nonDefs, ...defs].map(({ id }) => id);
  }

  // ─── Target (sprite / stage) renderer ─────────────────────────────────────

  async function targetToPseudocode(target, isStage) {
    const lines = [];
    const divider = "═".repeat(48);

    if (isStage) {
      lines.push(divider);
      lines.push("STAGE");
    } else {
      lines.push(divider);
      lines.push(`SPRITE: ${target.name}`);
    }

    // Costumes / backdrops
    const assetKey = isStage ? "backdrops" : "costumes";
    const assetNames = (target.costumes ?? []).map((c) => c.name).join(", ");
    if (assetNames) lines.push(`  ${assetKey}: ${assetNames}`);

    // Sounds
    const soundNames = (target.sounds ?? []).map((s) => s.name).join(", ");
    if (soundNames) lines.push(`  sounds: ${soundNames}`);

    // Variables — one per line with current value; floats rounded to 4 sig figs
    const varEntries = Object.values(target.variables ?? {});
    if (varEntries.length) {
      const label = isStage ? "variables (global)" : "variables (local)";
      lines.push(`  ${label}:`);
      for (const [name, value] of varEntries) {
        let display;
        if (typeof value === "number" || (typeof value === "string" && value !== "" && !isNaN(Number(value)))) {
          const n = Number(value);
          display = Number.isInteger(n) ? String(n) : String(parseFloat(n.toPrecision(4)));
        } else {
          const quoted = `"${value}"`;
          display = quoted.length > 40 ? quoted.slice(0, 40) + '…"' : quoted;
        }
        lines.push(`    ${name} = ${display}`);
      }
    }

    // Lists — show name and item count only (contents omitted for brevity)
    const listEntries = Object.values(target.lists ?? {});
    if (listEntries.length) {
      const label = isStage ? "lists (global)" : "lists (local)";
      lines.push(`  ${label}:`);
      for (const [name, items] of listEntries) {
        lines.push(`    ${name} (${Array.isArray(items) ? items.length : "?"} items)`);
      }
    }

    lines.push("");

    // Scripts
    const blocks = target.blocks ?? {};
    const scriptIds = getOrderedTopLevelIds(blocks);
    const blockToIR = await getBlockToIR();

    for (let scriptNum = 0; scriptNum < scriptIds.length; scriptNum++) {
      const scriptId = scriptIds[scriptNum];
      const topBlock = blocks[scriptId];
      if (!topBlock) continue;
      const hatNode = blockToIR(scriptId, blocks);

      lines.push(`  SCRIPT #${scriptNum + 1}:  [→ ${scriptId}]`);

      // Render hat / definition header, indented under SCRIPT label. The
      // procedures_prototype's warp/proccode/argumentnames are already promoted
      // onto hatNode.mutation by blockToIR — no separate custom_block lookup needed.
      if (hatNode.opcode === "procedures_definition") {
        const warp = hatNode.mutation?.warp;
        const warpPrefix = warp === "true" || warp === true ? "warp " : "";
        lines.push("    define " + warpPrefix + procSignatureFromNode(hatNode) + ":");
      } else {
        const hatFmt = STATEMENT_FORMATTERS[hatNode.opcode];
        if (hatFmt) lines.push("    " + hatFmt(hatNode));
      }

      // Render body one level deeper, indented under the hat
      if (hatNode.next) {
        lines.push(...renderSequence(hatNode.next, "      "));
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  // ─── Project renderer ──────────────────────────────────────────────────────

  async function projectToPseudocode(project) {
    const parts = [];

    // Guidance for AI comparison:
    // SCRIPT numbers are local reference labels only. Do not match SCRIPT #1 in one
    // project against SCRIPT #1 in another. Match scripts by sprite name, hat block,
    // custom block name, broadcast/key argument, and structural similarity of the blocks.
    //
    // Convention: [thing] = selected field/menu/dropdown/variable target/list target/literal text
    //             (thing) = reporter value/variable read/number/calculated expression
    //             <thing> = Boolean condition
    parts.push(
      "// SCRIPT numbers are local labels only — match by hat type, sprite, and structure, not number.",
      "// [x] = menu/dropdown/variable target/text   (x) = reporter/value   <x> = boolean",
      ""
    );

    const sprites = (project.targets ?? []).filter((t) => !t.isStage);
    const stage = (project.targets ?? []).find((t) => t.isStage);

    for (const sprite of sprites) {
      parts.push(await targetToPseudocode(sprite, false));
    }
    if (stage) {
      parts.push(await targetToPseudocode(stage, true));
    }

    return parts.join("\n");
  }

  // ─── Slim project renderer (for comparison) ────────────────────────────────
  // Strips variable values, costume/backdrop names, and sound names.
  // Keeps variable/list names (for scope analysis) and all script bodies.
  // Saves ~20-30% tokens vs the full pseudocode for typical projects.
  async function targetToComparePseudocode(target, isStage) {
    const lines = [];
    const divider = "═".repeat(48);

    lines.push(divider);
    lines.push(isStage ? "STAGE" : `SPRITE: ${target.name}`);

    // Variables — names only, no values (values irrelevant for bug comparison)
    const varEntries = Object.values(target.variables ?? {});
    if (varEntries.length) {
      const label = isStage ? "variables (global)" : "variables (local)";
      lines.push(`  ${label}: ${varEntries.map(([name]) => name).join(", ")}`);
    }

    // Lists — names only
    const listEntries = Object.values(target.lists ?? {});
    if (listEntries.length) {
      const label = isStage ? "lists (global)" : "lists (local)";
      lines.push(`  ${label}: ${listEntries.map(([name]) => name).join(", ")}`);
    }

    lines.push("");

    // Scripts — identical to the full renderer
    const blocks = target.blocks ?? {};
    const scriptIds = getOrderedTopLevelIds(blocks);
    const blockToIR = await getBlockToIR();

    for (let scriptNum = 0; scriptNum < scriptIds.length; scriptNum++) {
      const scriptId = scriptIds[scriptNum];
      const topBlock = blocks[scriptId];
      if (!topBlock) continue;
      const hatNode = blockToIR(scriptId, blocks);

      lines.push(`  SCRIPT #${scriptNum + 1}:  [→ ${scriptId}]`);

      if (hatNode.opcode === "procedures_definition") {
        const warp = hatNode.mutation?.warp;
        const warpPrefix = warp === "true" || warp === true ? "warp " : "";
        lines.push("    define " + warpPrefix + procSignatureFromNode(hatNode) + ":");
      } else {
        const hatFmt = STATEMENT_FORMATTERS[hatNode.opcode];
        if (hatFmt) lines.push("    " + hatFmt(hatNode));
      }

      if (hatNode.next) {
        lines.push(...renderSequence(hatNode.next, "      "));
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  async function projectToComparePseudocode(project) {
    const parts = ["// [x] = menu/dropdown/variable target/text   (x) = reporter/value   <x> = boolean", ""];
    const sprites = (project.targets ?? []).filter((t) => !t.isStage);
    const stage = (project.targets ?? []).find((t) => t.isStage);
    for (const sprite of sprites) parts.push(await targetToComparePseudocode(sprite, false));
    if (stage) parts.push(await targetToComparePseudocode(stage, true));
    return parts.join("\n");
  }
}
