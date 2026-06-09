export default async function ({ addon, msg, console }) {
  // ─── Toolbar button (single icon) ─────────────────────────────────────────

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

  // ─── Panel state ───────────────────────────────────────────────────────────

  // tabs[0] is always the Current project; subsequent tabs are loaded references.
  const tabs = []; // [{ label: string, content: string }]
  let activeTabIndex = 0;
  let panel = null;
  let tabBar = null;
  let contentEl = null;
  let compareBtn = null;
  let overlayCopyBtn = null;

  // ─── Panel builder ─────────────────────────────────────────────────────────

  function createPanel() {
    panel = Object.assign(document.createElement("div"), { className: "sa-inspector-panel" });

    // Toolbar: tab strip + action buttons
    const toolbar = Object.assign(document.createElement("div"), { className: "sa-inspector-toolbar" });
    tabBar = Object.assign(document.createElement("div"), { className: "sa-inspector-tabs" });

    const actions = Object.assign(document.createElement("div"), { className: "sa-inspector-toolbar-actions" });

    const loadBtn = Object.assign(document.createElement("button"), {
      className: "sa-inspector-action-btn",
      title: msg("load-button"),
      textContent: "📂",
    });
    loadBtn.addEventListener("click", handleLoadSb3);

    const fetchBtn = Object.assign(document.createElement("button"), {
      className: "sa-inspector-action-btn",
      title: msg("fetch-button"),
      textContent: "🔗",
    });
    fetchBtn.addEventListener("click", handleFetchById);

    compareBtn = Object.assign(document.createElement("button"), {
      className: "sa-inspector-action-btn",
      title: msg("compare-button"),
      textContent: "📊",
    });
    compareBtn.addEventListener("click", handleCompare);
    compareBtn.hidden = true;

    const closeBtn = Object.assign(document.createElement("button"), {
      className: "sa-inspector-close-btn",
      textContent: "✕",
    });
    closeBtn.addEventListener("click", () => { panel.remove(); panel = null; });

    actions.append(loadBtn, fetchBtn, compareBtn, closeBtn);
    toolbar.append(tabBar, actions);

    // Body: code pre + overlay copy button
    const body = Object.assign(document.createElement("div"), { className: "sa-inspector-body" });

    contentEl = Object.assign(document.createElement("pre"), { className: "sa-inspector-content" });

    overlayCopyBtn = Object.assign(document.createElement("button"), {
      className: "sa-inspector-overlay-copy",
      title: msg("copy-button"),
      textContent: "📋",
    });
    overlayCopyBtn.addEventListener("click", handleOverlayCopy);

    body.append(contentEl, overlayCopyBtn);
    panel.append(toolbar, body);
    document.body.appendChild(panel);
  }

  function renderTabs() {
    tabBar.innerHTML = "";
    for (let i = 0; i < tabs.length; i++) {
      const tabEl = Object.assign(document.createElement("button"), {
        className: "sa-inspector-tab" + (i === activeTabIndex ? " sa-inspector-tab-active" : ""),
      });
      const labelSpan = Object.assign(document.createElement("span"), { textContent: tabs[i].label });
      tabEl.appendChild(labelSpan);

      if (i !== 0) {
        const closeX = Object.assign(document.createElement("span"), {
          className: "sa-inspector-tab-close",
          textContent: "×",
        });
        closeX.addEventListener("click", (e) => { e.stopPropagation(); removeTab(i); });
        tabEl.appendChild(closeX);
      }

      tabEl.addEventListener("click", () => switchTab(i));
      tabBar.appendChild(tabEl);
    }
    compareBtn.hidden = tabs.length < 2;
  }

  function switchTab(index) {
    activeTabIndex = index;
    contentEl.textContent = tabs[index].content;
    renderTabs();
  }

  function removeTab(index) {
    tabs.splice(index, 1);
    if (activeTabIndex >= tabs.length) activeTabIndex = tabs.length - 1;
    contentEl.textContent = tabs[activeTabIndex].content;
    renderTabs();
  }

  function upsertCurrentTab(content) {
    if (tabs.length === 0) {
      tabs.push({ label: msg("tab-current"), content });
    } else {
      tabs[0].content = content;
    }
  }

  function addReferenceTab(label, content) {
    tabs.push({ label, content });
    activeTabIndex = tabs.length - 1;
    contentEl.textContent = content;
    renderTabs();
  }

  function handleOverlayCopy() {
    navigator.clipboard.writeText(tabs[activeTabIndex]?.content ?? "");
    overlayCopyBtn.textContent = "✓";
    setTimeout(() => (overlayCopyBtn.textContent = "📋"), 1500);
  }

  function handleCompare() {
    // Compare tab 0 (current) against the active tab, or tab 1 if current is active.
    const refIndex = activeTabIndex === 0 ? 1 : activeTabIndex;
    if (!tabs[refIndex]) return;
    try {
      const studentProject = getCurrentProjectFromVM();
      const studentCode = projectToPseudocode(studentProject);
      const prompt = buildComparisonPrompt(studentCode, tabs[refIndex].content, tabs[refIndex].label);
      navigator.clipboard.writeText(prompt);
      compareBtn.textContent = "✓";
      setTimeout(() => (compareBtn.textContent = "📊"), 1500);
    } catch (e) {
      alert(msg("fetch-error", { error: String(e) }));
    }
  }

  // ─── Toolbar click: refresh/open panel on current tab ─────────────────────

  async function handleToolbarClick() {
    toolbarBtn.disabled = true;
    try {
      const project = getCurrentProjectFromVM();
      upsertCurrentTab(projectToPseudocode(project));
      if (!panel || !document.body.contains(panel)) {
        createPanel();
      }
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
    if (!panel || !document.body.contains(panel)) await handleToolbarClick();
    try {
      const project = await fetchProjectById(projectId);
      addReferenceTab(`#${projectId}`, projectToPseudocode(project));
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
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd === -1) throw new Error("Not a valid ZIP file");

    const cdOffset = view.getUint32(eocd + 16, true);
    const cdCount  = view.getUint16(eocd + 8, true);

    // Walk the Central Directory to find project.json.
    let cdPos = cdOffset;
    for (let i = 0; i < cdCount; i++) {
      if (view.getUint32(cdPos, true) !== 0x02014b50) throw new Error("Bad central directory entry");
      const compression  = view.getUint16(cdPos + 10, true);
      const compSize     = view.getUint32(cdPos + 20, true);
      const uncompSize   = view.getUint32(cdPos + 24, true);
      const fnLen        = view.getUint16(cdPos + 28, true);
      const extraLen     = view.getUint16(cdPos + 30, true);
      const commentLen   = view.getUint16(cdPos + 32, true);
      const localOffset  = view.getUint32(cdPos + 42, true);
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

  // Build a comparison prompt for an LLM given student and reference pseudocode.
  function buildComparisonPrompt(studentCode, refCode, refName) {
    const refLabel = refName ? `REFERENCE PROJECT (${refName})` : "REFERENCE PROJECT";
    return [
      "Compare the STUDENT PROJECT against the REFERENCE PROJECT below.",
      "Match scripts by sprite name, hat block type, and structure — NOT by SCRIPT number.",
      "Empty scripts in the reference are placeholders; ignore them.",
      "",
      "Report under exactly these headings, in this order:",
      "1. Breaking bugs — changes almost certain to prevent the game working correctly (e.g. wrong condition, missing broadcast, wrong variable). List the most game-breaking first.",
      "   IMPORTANT: check variable scope — variables listed under STAGE are global (for all sprites); variables listed under a SPRITE are local (for this sprite only). A variable that should be local but is global (or vice versa) is a common breaking bug in Scratch.",
      "2. Likely bugs — code that looks wrong but might only affect some situations.",
      "3. Missing scripts — scripts present in the reference but absent from the student project.",
      "4. Intentional differences — things that differ but are probably deliberate. Keep this brief.",
      "",
      "Be specific: quote the block or sequence that differs.",
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
      if (!panel || !document.body.contains(panel)) await handleToolbarClick();
      try {
        const project = await readSb3File(file);
        const label = file.name.replace(/\.sb[23]$/i, "");
        addReferenceTab(label, projectToPseudocode(project));
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

  function field(block, name) {
    return block.fields?.[name]?.[0] ?? "?";
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

  // Resolve a literal input array [type, value, ...] to a string
  function resolveLiteral(lit) {
    if (!Array.isArray(lit)) return String(lit ?? "?");
    const [type, value] = lit;
    switch (type) {
      case 4:
      case 5:
      case 6:
      case 7:
      case 8: // numbers / angles — round brackets (reporter style)
        return `(${value})`;
      case 9: // colour
        return value;
      case 10: // string: numeric → (n), empty string → [""], text → [text]
        if (value !== "" && isFinite(value)) return `(${value})`;
        return value === "" ? `[""]` : `[${qVar(value)}]`;
      case 11: // broadcast name — [name]
        return `[${qVar(value)}]`;
      case 12: // variable reporter used as a value — (name) round brackets
        return `(${qVar(value)})`;
      case 13: // list reporter used as a value — (name) round brackets
        return `(${qVar(value)})`;
      default:
        return String(value ?? "?");
    }
  }

  // Resolve an input slot to a string (reporter block or literal).
  //
  // Scratch input arrays have the form [outerMode, primary, secondary?] where:
  //   outerMode 1 = shadow only (primary IS the value, no block on top)
  //   outerMode 2 = block, no shadow (primary is a block ID string)
  //   outerMode 3 = block obscuring shadow (primary is block ID or inline primitive)
  //
  // primary / secondary can each be:
  //   - a string  → block ID in the blocks dict (reporter or shadow menu block)
  //   - an array  → inline primitive [type, value, ...] (variable [12], list [13],
  //                 broadcast [11], or a number/string/colour literal [4-10])
  //
  // Crucially, variable/list/broadcast reporters used as inputs are stored as inline
  // arrays, NOT as entries in the blocks dict, so checking typeof === "string" alone
  // would miss them and silently return empty.
  function resolveInput(blocks, block, inputName) {
    const input = block.inputs?.[inputName];
    if (!input) return "?";
    const [, primary, secondary] = input;

    if (typeof primary === "string") {
      // Block ID — look it up (reporter or shadow menu)
      if (blocks?.[primary]) return renderReporter(blocks, primary);
    } else if (Array.isArray(primary)) {
      // Inline primitive (variable, list, broadcast, or literal)
      return resolveLiteral(primary);
    }

    // Fall back to shadow slot
    if (Array.isArray(secondary)) return resolveLiteral(secondary);
    if (typeof secondary === "string" && blocks?.[secondary]) return renderReporter(blocks, secondary);
    return String(secondary ?? "?");
  }

  // Render a reporter/boolean block inline (no newline)
  function renderReporter(blocks, blockId) {
    const block = blocks[blockId];
    if (!block) return "?";

    const fmt = INLINE_FORMATTERS[block.opcode];
    if (fmt) return fmt(block, blocks);

    // Shadow menu blocks (e.g. motion_goto_menu, looks_costume, sensing_keyoptions, etc.)
    // These hold a user-defined name — rendered inside [...] by the caller, so escape ] only.
    // Scratch uses underscore-wrapped tokens for built-in targets; translate them to readable names.
    if (block.shadow) {
      const firstField = Object.values(block.fields ?? {})[0];
      if (firstField) {
        const INTERNAL_TOKENS = {
          _myself_: "myself",
          _mouse_: "mouse-pointer",
          _random_: "random position",
          _edge_: "edge",
          _stage_: "Stage",
        };
        const raw = firstField[0];
        // Return "name v" — callers that wrap in [...] produce [name v]
        return qVar(INTERNAL_TOKENS[raw] ?? raw);
      }
    }

    return `(${block.opcode})`;
  }

  // Resolve a slot that may be either a fixed menu choice or a computed reporter.
  // Fixed menu values (bare text from a shadow block) get wrapped in [...].
  // Computed values that already carry their own delimiters — (reporter), <bool>,
  // [broadcast], [text] — are returned as-is.
  function resolveSlot(blocks, block, inputName) {
    const val = resolveInput(blocks, block, inputName);
    // Already delimited — reporter, boolean, broadcast, or string literal
    if (val.startsWith("(") || val.startsWith("<") || val.startsWith("[")) return val;
    // Bare menu text — wrap in [...]
    return `[${val}]`;
  }

  // ─── Procedure helpers ─────────────────────────────────────────────────────

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

  function formatProcCall(block) {
    const proccode = block.mutation?.proccode ?? "(unknown)";
    const argIds = JSON.parse(block.mutation?.argumentids ?? "[]");
    let i = 0;
    return proccode.replace(/%[sb]/g, () => {
      const id = argIds[i++];
      return id ? resolveInput(null, block, id) : "?";
    });
  }

  function formatProcCallWithBlocks(block, blocks) {
    const proccode = block.mutation?.proccode ?? "(unknown)";
    const argIds = JSON.parse(block.mutation?.argumentids ?? "[]");
    let i = 0;
    return proccode.replace(/%[sb]/g, () => {
      const id = argIds[i++];
      return id ? resolveInput(blocks, block, id) : "?";
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
    motion_glideto: (b, blocks) =>
      `glide ${resolveInput(blocks, b, "SECS")} secs to ${resolveSlot(blocks, b, "TO")}`,
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
    data_changevariableby: (b, blocks) => `change [${qVar(field(b, "VARIABLE"))}] by ${resolveInput(blocks, b, "VALUE")}`,
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
    procedures_call: (b, blocks) => formatProcCallWithBlocks(b, blocks),
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

  function renderSequence(blocks, startId, indent) {
    const lines = [];
    let currentId = startId;

    while (currentId) {
      const block = blocks[currentId];
      if (!block) break;

      const cDef = C_BLOCKS[block.opcode];
      if (cDef) {
        lines.push(indent + cDef.header(block, blocks));
        for (let si = 0; si < cDef.substacks.length; si++) {
          if (si === 1 && cDef.elseLabel) lines.push(indent + cDef.elseLabel);
          const substackInput = block.inputs?.[cDef.substacks[si]];
          const substackId = substackInput && typeof substackInput[1] === "string" ? substackInput[1] : null;
          if (substackId) {
            lines.push(...renderSequence(blocks, substackId, indent + "  "));
          }
        }
        if (!cDef.noEnd) lines.push(indent + "end");
      } else {
        const fmt = STATEMENT_FORMATTERS[block.opcode];
        if (fmt) {
          lines.push(indent + fmt(block, blocks));
        } else {
          // Unknown / extension block — show opcode and key fields
          const fieldStr = Object.entries(block.fields ?? {})
            .map(([k, v]) => `${k}: ${v[0]}`)
            .join(", ");
          lines.push(indent + `[${block.opcode}${fieldStr ? ` | ${fieldStr}` : ""}]`);
        }
      }

      currentId = block.next;
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

  function targetToPseudocode(target, isStage) {
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
          display = quoted.length > 40 ? quoted.slice(0, 40) + "…\"" : quoted;
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

    for (let scriptNum = 0; scriptNum < scriptIds.length; scriptNum++) {
      const scriptId = scriptIds[scriptNum];
      const topBlock = blocks[scriptId];
      if (!topBlock) continue;

      lines.push(`  SCRIPT #${scriptNum + 1}:`);

      // Render hat / definition header, indented under SCRIPT label
      if (topBlock.opcode === "procedures_definition") {
        const protoInput = topBlock.inputs?.["custom_block"];
        const protoId = typeof protoInput?.[1] === "string" ? protoInput[1] : null;
        const proto = protoId ? blocks[protoId] : null;
        const warp = proto?.mutation?.warp;
        const warpTag = (warp === "true" || warp === true) ? " [warp: true]" : " [warp: false]";
        lines.push("    define " + getProcSignature(blocks, topBlock) + ":" + warpTag);
      } else {
        const hatFmt = STATEMENT_FORMATTERS[topBlock.opcode];
        if (hatFmt) lines.push("    " + hatFmt(topBlock, blocks));
      }

      // Render body one level deeper, indented under the hat
      if (topBlock.next) {
        lines.push(...renderSequence(blocks, topBlock.next, "      "));
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  // ─── Project renderer ──────────────────────────────────────────────────────

  function projectToPseudocode(project) {
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
      parts.push(targetToPseudocode(sprite, false));
    }
    if (stage) {
      parts.push(targetToPseudocode(stage, true));
    }

    return parts.join("\n");
  }
}
