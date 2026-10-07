"use strict";
(() => {
  const NOTES = ["C", "D", "E", "F", "G", "A", "B"];
  const FREQ = { C: 261.63, D: 293.66, E: 329.63, F: 349.23, G: 392.0, A: 440.0, B: 493.88 };
  const DEFAULT_KEYS = { C: "a", D: "s", E: "d", F: "f", G: "g", A: "h", B: "j" };
  const MAX_LEN = { classic: 8, easy: 5 };   // max notes in one pattern per mode (server enforces too)
  const IDLE_MS = 3000;           // AI hint appears after this much idle time
  const RING = 326.73;            // circumference of the timer ring (r = 52)
  const COLORS = { Classic: "#fffbee", Candy: "#ffc1e3", Ocean: "#b3e5fc", Mint: "#b9f6ca", Sunset: "#ffcc80", Night: "#546e7a" };
  const QUICK = ["Good luck!", "Nice one!", "GG", "Oops!", "Rematch?"];

  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(2, "0");

  // ---------- settings (saved in this browser) ----------
  const cfg = loadCfg();
  function loadCfg() {
    const c = { color: "Classic", hints: true, keys: { ...DEFAULT_KEYS }, custom: {} };
    try {
      const d = JSON.parse(localStorage.getItem("dupme.settings"));
      if (d) {
        if (d.color in COLORS) c.color = d.color;
        if (typeof d.hints === "boolean") c.hints = d.hints;
        if (d.custom) for (const n of NOTES) if (/^#[0-9a-f]{6}$/i.test(d.custom[n] || "")) c.custom[n] = d.custom[n];
        const k = d.keys;
        if (k && NOTES.every((n) => typeof k[n] === "string" && k[n].length === 1) &&
            new Set(NOTES.map((n) => k[n])).size === NOTES.length) c.keys = { ...k };
      }
    } catch (e) { /* use defaults */ }
    return c;
  }
  // picture spread across the keys (kept apart from the settings because it is larger)
  let img = "";
  try { img = localStorage.getItem("dupme.image") || ""; } catch (e) { img = ""; }

  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const hex = (a) => "#" + a.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  const mixHex = (h, other, t) => { const a = rgb(h), b = rgb(other); return hex(a.map((v, i) => v * (1 - t) + b[i] * t)); };
  const inkFor = (h) => { const [r, g, b] = rgb(h); return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? "#1a1a2e" : "#ffffff"; };

  function saveCfg() {
    try { localStorage.setItem("dupme.settings", JSON.stringify(cfg)); } catch (e) { /* ignore */ }
  }

  // ---------- game state ----------
  const S = {
    me: "", opp: "", scores: {}, inMatch: false, active: false,
    phase: "", round: 1, deadline: 0, total: 1,
    seq: [], pattern: [], repCount: 0, lastAct: Date.now(),
    hint: null, hideLabels: false,
    mode: "classic", online: [],        // classic = 8-note cap, easy = 5-note cap + AI hints, expert = letters hidden
  };
  const capped = () => S.mode === "easy";          // AI hints
  const maxLen = () => MAX_LEN[S.mode] || 0;       // note limit while creating (0 = none)
  const expert = () => S.mode === "expert";        // letters hidden while repeating
  const keyEls = {};
  const flashTimers = {};

  // ---------- sound (Web Audio, no files needed) ----------
  let actx = null;
  function ensureAudio() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC && !actx) actx = new AC();
      if (actx && actx.state === "suspended") actx.resume();
    } catch (e) { actx = null; }
  }
  function playNote(n) {
    if (!actx) return;
    try {
      const t = actx.currentTime;
      const out = actx.createGain();
      out.gain.setValueAtTime(0.0001, t);
      out.gain.exponentialRampToValueAtTime(0.5, t + 0.008);
      out.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
      out.connect(actx.destination);
      [[1, 1], [2, 0.5], [3, 0.25]].forEach(([mult, amp]) => {
        const o = actx.createOscillator();
        const g = actx.createGain();
        o.type = "sine";
        o.frequency.value = FREQ[n] * mult;
        g.gain.value = amp / 1.75;
        o.connect(g); g.connect(out);
        o.start(t); o.stop(t + 1.2);
      });
    } catch (e) { /* audio must never break the game */ }
  }

  // ---------- talking to client_web.py ----------
  let chain = Promise.resolve();
  function send(msg) {           // sent one after another so note order is kept
    chain = chain.then(() => fetch("/send", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(msg),
    }).catch(() => {}));
  }
  function openStream() {
    return new Promise((resolve) => {
      const es = new EventSource("/events");
      es.onopen = () => resolve();
      es.onmessage = (e) => handle(JSON.parse(e.data));
    });
  }

  // ---------- rendering ----------
  function setStatus(text) { $("status").textContent = text; }

  function renderNames() {
    $("meName").textContent = S.me || "You";
    $("oppName").textContent = S.opp || "Waiting for opponent";
    renderScores();
  }
  function renderScores() {
    bumpIf($("meScore"), S.scores[S.me] || 0);
    bumpIf($("oppScore"), S.opp ? S.scores[S.opp] || 0 : 0);
  }
  function bumpIf(el, value) {
    const text = String(value);
    if (el.textContent !== text) {
      el.textContent = text;
      el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump");
    }
  }
  function setRoles(creator, repeater, phase) {
    const turn = phase === "create" ? creator : phase === "repeat" ? repeater : "";
    for (const [who, roleEl, plate] of [[S.me, $("meRole"), $("plateMe")], [S.opp, $("oppRole"), $("plateOpp")]]) {
      roleEl.textContent = !who ? "" : who === creator ? "Creating the pattern" : who === repeater ? "Repeating" : "";
      plate.dataset.turn = String(!!who && who === turn);
    }
  }
  function clearRoles() { setRoles("", "", ""); }

  function renderOnline() {
    const ul = $("onlineList");
    ul.textContent = "";
    for (const name of S.online) {
      const li = document.createElement("li");
      li.textContent = name + (name === S.me ? " (you)" : "");
      if (name === S.me) li.className = "me";
      else if (/^AI Bot/.test(name)) li.className = "bot";
      ul.appendChild(li);
    }
    $("onlineCount").textContent = String(S.online.length);
  }
  function renderMode() {
    const b = $("modeBadge");
    b.dataset.mode = S.mode;
    b.textContent = { easy: "Easy mode", expert: "Expert mode" }[S.mode] || "Classic mode";
    b.title = { easy: "Easier: 5 notes at most, plus AI hints",
                expert: "Harder: the letters on the keys are hidden while you repeat" }[S.mode]
      || "The standard rules: 10 seconds to create (8 notes at most), 20 seconds to repeat";
  }
  function renderLobbyActions() {                 // the AI bot button shows only when you wait alone
    $("botBtn").hidden = S.inMatch || S.online.length !== 1;
  }

  function renderRail(popIndex) {
    const rail = $("rail");
    // Placeholders only where the count is known: the pattern length while repeating, or the
    // mode's note limit while creating. Otherwise slots appear as notes are played.
    const n = S.phase === "REPEAT" && S.pattern.length ? S.pattern.length
      : maxLen() && S.inMatch && S.phase === "CREATE" ? maxLen() : S.seq.length;
    rail.textContent = "";
    for (let i = 0; i < n; i++) {
      const li = document.createElement("li");
      li.className = "slot";
      const e = S.seq[i];
      if (e) {
        li.classList.add("filled");
        if (e.ok === true) li.classList.add("ok");
        if (e.ok === false) li.classList.add("bad");
        li.textContent = e.note + (e.ok === true ? " ✓" : e.ok === false ? " ✗" : "");
      }
      if (i === popIndex) li.classList.add("pop");
      rail.appendChild(li);
    }
  }

  function renderLegend() {
    const keys = NOTES.map((n) => cfg.keys[n].toUpperCase()).join(" ");
    $("legend").textContent = "Keyboard: " + keys + " = " + NOTES.join(" ");
    $("legend").style.visibility = S.hideLabels ? "hidden" : "visible";
  }

  function paintKeys() {
    const p = $("piano");
    p.dataset.theme = cfg.color;
    p.dataset.img = img ? "1" : "0";
    if (img) p.style.setProperty("--img", 'url("' + img + '")'); else p.style.removeProperty("--img");
    p.dataset.hide = S.hideLabels ? "1" : "0";
    p.classList.toggle("on", S.active);
    for (const n of NOTES) {                       // per-key colors override the theme
      const el = keyEls[n], c = cfg.custom[n];
      if (c) {
        el.style.setProperty("--key-on", c);
        el.style.setProperty("--key-off", mixHex(c, "#8c8c8c", 0.5));
        el.style.setProperty("--key-ink", inkFor(c));
      } else {
        for (const v of ["--key-on", "--key-off", "--key-ink"]) el.style.removeProperty(v);
      }
    }
    renderLegend();
  }

  function setActive(on) {
    S.active = on;
    S.hideLabels = on && S.phase === "REPEAT" && expert();     // the repeater sees no letters on the keys
    clearHint();
    paintKeys();
  }

  function flash(note, kind, ms) {
    playNote(note);
    const el = keyEls[note];
    el.dataset.flash = kind;
    clearTimeout(flashTimers[note]);
    flashTimers[note] = setTimeout(() => { delete el.dataset.flash; }, ms || 250);
  }

  // ---------- AI hint (Easy mode, repeat phase) ----------
  // Shows one right key and one wrong key. The wrong key is not random: the hint learns which
  // key you usually press by mistake for the right one (saved in this browser) and offers that.
  let conf = {};
  try { conf = JSON.parse(localStorage.getItem("dupme.confusion")) || {}; } catch (e) { conf = {}; }
  function learnMistake(expected, pressed) {
    conf[expected] = conf[expected] || {};
    conf[expected][pressed] = (conf[expected][pressed] || 0) + 1;
    try { localStorage.setItem("dupme.confusion", JSON.stringify(conf)); } catch (e) { /* ignore */ }
  }
  function clearHint() {
    if (S.hint) for (const n of S.hint) delete keyEls[n].dataset.hint;
    S.hint = null;
    $("hint").textContent = "";
  }
  function maybeHint(now) {
    if (!S.active || !S.deadline || S.hint || !cfg.hints || !capped() || S.phase !== "REPEAT") return;
    if (now - S.lastAct < IDLE_MS || S.repCount >= S.pattern.length) return;
    const right = S.pattern[S.repCount];
    const seen = conf[right] || {};
    const others = NOTES.filter((n) => n !== right);
    const weights = others.map((n) => 1 + 4 * (seen[n] || 0) +
      (Math.abs(NOTES.indexOf(n) - NOTES.indexOf(right)) === 1 ? 1 : 0));   // neighbours are easy to mix up
    let r = Math.random() * weights.reduce((x, y) => x + y, 0), k = 0;
    while (k < others.length - 1 && (r -= weights[k]) > 0) k++;
    const pair = [right, others[k]];
    if (Math.random() < 0.5) pair.reverse();
    S.hint = pair;
    for (const n of pair) keyEls[n].dataset.hint = "1";
    const learned = Object.values(seen).some((v) => v > 0);
    $("hint").textContent = "AI hint" + (learned ? " (from your past mistakes)" : "") +
      ": one of these is next: " + pair[0] + " or " + pair[1];
  }

  // ---------- timer ----------
  function tick() {
    const now = Date.now();
    const clock = $("clock");
    if (S.deadline) {
      const left = Math.max(0, Math.ceil((S.deadline - now) / 1000));
      const frac = Math.max(0, Math.min(1, (S.deadline - now) / (S.total * 1000)));
      $("timer").textContent = "00:00:" + pad(left);
      $("ring").style.strokeDashoffset = String(RING * (1 - frac));
      clock.dataset.state = left <= 3 ? "low" : "ok";
    } else {
      $("timer").textContent = "00:00:00";
      $("ring").style.strokeDashoffset = String(RING);
      clock.dataset.state = "idle";
      $("phaseName").textContent = "";
    }
    maybeHint(now);
  }

  // ---------- input ----------
  function press(note) {
    if (!S.active) return;
    if (maxLen() && S.phase === "CREATE" && S.pattern.length >= maxLen()) return;
    ensureAudio();
    S.lastAct = Date.now();
    clearHint();
    send({ t: "key", note });
  }

  window.addEventListener("keydown", (e) => {
    if (e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
    if ($("settings").open) return;
    const t = e.target;
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;     // typing in chat
    const ch = e.key.length === 1 ? e.key.toLowerCase() : "";
    const note = NOTES.find((n) => cfg.keys[n] === ch);
    if (note) { e.preventDefault(); press(note); }
  });

  // ---------- messages from the game server ----------
  function handle(m) {
    switch (m.t) {
      case "nick":                                   // server accepted the nickname: say hello
        S.me = m.nick; renderNames();
        $("welcome").textContent = "Welcome, " + S.me + ".";
        $("welcomeTitle").textContent = "Welcome, " + S.me + "!";
        if (!$("welcomeDlg").open) $("welcomeDlg").show();   // not modal: a match may start right away
        setTimeout(() => $("welcomeDlg").close(), 2500);
        break;

      case "players":
        S.online = m.list;
        if (!S.inMatch) S.mode = m.mode || "classic";    // a running match keeps its own mode
        renderOnline(); renderMode(); renderLobbyActions(); renderRail();
        if (!S.inMatch) {
          setStatus("Online: " + m.list.join(", ") + (m.list.length < 2 ? "\nWaiting for another player..." : ""));
        }
        break;

      case "lobby":
        S.inMatch = false; S.deadline = 0; S.scores = {}; S.seq = []; S.pattern = []; S.opp = "";
        setActive(false); clearRoles(); renderLobbyActions();
        $("result").hidden = true;
        $("welcome").textContent = "Lobby";
        setStatus(m.text);
        renderNames(); renderRail();
        break;

      case "start":
        S.inMatch = true; S.me = m.you; S.opp = m.opponent; S.scores = m.scores;
        S.mode = m.mode || "classic";
        renderMode(); renderOnline(); renderLobbyActions();
        $("result").hidden = true;
        $("rematch").disabled = false; $("rematch").textContent = "Rematch";
        $("welcome").textContent = "Welcome, " + S.me + ".";
        setStatus(m.first + " goes first!");
        renderNames();
        break;

      case "phase": {
        S.deadline = Date.now() + m.seconds * 1000;
        S.total = m.seconds;
        S.phase = m.phase === "create" ? "CREATE" : "REPEAT";
        S.round = m.round; S.seq = []; S.repCount = 0; S.lastAct = Date.now();
        if (m.phase === "create") S.pattern = [];
        $("phaseName").textContent = m.phase === "create" ? "Create" : "Repeat";
        const mine = (m.phase === "create" ? m.creator : m.repeater) === S.me;
        setActive(mine);
        setRoles(m.creator, m.repeater, m.phase);
        const r = "Round " + m.round + ": ";
        if (m.phase === "create") {
          setStatus(mine ? r + "Create a pattern!" + (maxLen() ? " (max " + maxLen() + " notes)" : "")
                         : r + "Memorize " + m.creator + "'s pattern...");
        } else {
          setStatus(mine ? r + "Repeat the pattern!" : r + m.repeater + " is repeating...");
        }
        renderRail();
        break;
      }

      case "pkey": {
        S.pattern.push(m.note);
        clearHint();
        S.seq.push({ note: m.note, ok: null });
        const full = maxLen() && S.phase === "CREATE" && S.pattern.length >= maxLen();
        if (full) {                                  // pattern full: stop the clock, lock the keys
          S.deadline = 0;
          setActive(false);                          // (repaints keys, so flash comes after)
          setStatus("Pattern complete (" + maxLen() + " notes)! Repeat phase starting...");
        }
        flash(m.note, "p", full ? 1800 : 250);       // last key stays lit so the opponent sees it
        renderRail(S.seq.length - 1);
        break;
      }

      case "rkey":
        if (!m.ok && S.active && S.pattern[m.i]) learnMistake(S.pattern[m.i], m.note);
        S.repCount += 1;
        clearHint();
        S.seq.push({ note: m.note, ok: m.ok });
        flash(m.note, m.ok ? "ok" : "bad", 250);
        S.scores = m.scores;
        renderRail(S.seq.length - 1);
        renderScores();
        break;

      case "scores":
        S.scores = m.scores; S.deadline = 0;
        setActive(false); clearRoles();
        setStatus("Round " + m.round + " over." + (m.round === 1 ? " Switching roles..." : ""));
        renderScores();
        break;

      case "end": {
        S.scores = m.scores; S.deadline = 0;
        setActive(false); clearRoles();
        setStatus("Match over.");
        renderScores();
        const box = $("result");
        box.dataset.kind = m.result.toLowerCase();
        $("resultWord").textContent = m.result;
        $("resultScores").textContent = Object.entries(m.scores).map(([k, v]) => k + " " + v).join("  vs  ");
        box.hidden = false;
        break;
      }

      case "info":
        setStatus(m.text); break;

      case "chat": {
        const li = document.createElement("li");
        if (m.from === S.me) li.className = "mine";
        const who = document.createElement("b");
        who.textContent = (m.from === S.me ? "You" : m.from) + ": ";
        li.appendChild(who);
        li.appendChild(document.createTextNode(m.text));
        const log = $("chatLog");
        log.appendChild(li);
        while (log.children.length > 100) log.removeChild(log.firstChild);
        log.scrollTop = log.scrollHeight;
        break;
      }

      case "disconnected":
        $("lost").showModal(); break;
    }
  }

  // ---------- setup ----------
  function buildPiano() {
    const p = $("piano");
    p.textContent = "";
    for (const [i, n] of NOTES.entries()) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "key"; b.dataset.note = n;
      b.style.setProperty("--k", String(i));
      b.setAttribute("aria-label", "Note " + n);
      b.innerHTML = '<span class="note"></span>';
      b.querySelector(".note").textContent = n;
      b.addEventListener("click", () => press(n));
      keyEls[n] = b; p.appendChild(b);
    }
    for (const i of [1, 2, 4, 5, 6]) {              // decorative black keys
      const d = document.createElement("span");
      d.className = "black"; d.style.setProperty("--i", String(i));
      p.appendChild(d);
    }
  }

  function buildChips() {
    for (const q of QUICK) {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = q;
      b.addEventListener("click", () => { send({ t: "chat", text: q }); b.blur(); });
      $("chips").appendChild(b);
    }
  }

  function buildSettings() {
    const sw = $("swatches");
    for (const name of Object.keys(COLORS)) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "swatch"; b.dataset.v = name;
      b.innerHTML = "<i></i>"; b.firstChild.style.setProperty("--c", COLORS[name]);
      b.append(name);
      b.addEventListener("click", () => { cfg.color = name; cfg.custom = {}; saveCfg(); paintKeys(); markSettings(); });
      sw.appendChild(b);
    }
    const kc = $("keyColors");
    for (const n of NOTES) {
      const cell = document.createElement("label");
      cell.className = "keycell";
      cell.append(n);
      const inp = document.createElement("input");
      inp.type = "color"; inp.dataset.note = n; inp.setAttribute("aria-label", "Color for note " + n);
      inp.addEventListener("input", () => { cfg.custom[n] = inp.value; saveCfg(); paintKeys(); });
      cell.appendChild(inp);
      kc.appendChild(cell);
    }
    $("resetColors").addEventListener("click", () => { cfg.custom = {}; saveCfg(); paintKeys(); markSettings(); });
    $("imgClear").addEventListener("click", () => {
      img = ""; try { localStorage.removeItem("dupme.image"); } catch (e) { /* ignore */ }
      paintKeys();
    });
    $("imgFile").addEventListener("change", (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const url = URL.createObjectURL(f), im = new Image();
      im.onload = () => {                          // crop to the keyboard's shape and shrink it
        const W = 1400, H = 400, cv = document.createElement("canvas");
        cv.width = W; cv.height = H;
        const s = Math.max(W / im.width, H / im.height), w = im.width * s, h = im.height * s;
        cv.getContext("2d").drawImage(im, (W - w) / 2, (H - h) / 2, w, h);
        img = cv.toDataURL("image/jpeg", 0.82);
        try { localStorage.setItem("dupme.image", img); } catch (err) { /* kept for this session only */ }
        URL.revokeObjectURL(url);
        paintKeys();
      };
      im.onerror = () => URL.revokeObjectURL(url);
      im.src = url;
      e.target.value = "";
    });
    $("hintsOn").addEventListener("change", (e) => { cfg.hints = e.target.checked; saveCfg(); if (!cfg.hints) clearHint(); });
    $("resetKeys").addEventListener("click", () => { cfg.keys = { ...DEFAULT_KEYS }; saveCfg(); buildKeyInputs(); renderLegend(); });
    $("settings").addEventListener("close", buildKeyInputs);
    buildKeyInputs();
    markSettings();
  }

  function markSettings() {
    for (const b of document.querySelectorAll("#swatches .swatch")) b.setAttribute("aria-pressed", String(b.dataset.v === cfg.color));
    for (const inp of document.querySelectorAll("#keyColors input")) inp.value = cfg.custom[inp.dataset.note] || COLORS[cfg.color];
    $("hintsOn").checked = cfg.hints;
  }

  function buildKeyInputs() {
    const row = $("keyInputs");
    row.textContent = "";
    for (const n of NOTES) {
      const cell = document.createElement("label");
      cell.className = "keycell";
      cell.append(n);
      const inp = document.createElement("input");
      inp.value = cfg.keys[n]; inp.readOnly = true; inp.setAttribute("aria-label", "Key for note " + n);
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Tab") return;
        e.preventDefault();
        if (e.key.length !== 1 || e.key === " ") return;
        const k = e.key.toLowerCase();
        const other = NOTES.find((x) => x !== n && cfg.keys[x] === k);
        if (other) cfg.keys[other] = cfg.keys[n];         // swap, so keys always stay unique
        cfg.keys[n] = k;
        saveCfg(); buildKeyInputs(); renderLegend();
        row.querySelectorAll("input")[NOTES.indexOf(n)].focus();
      });
      cell.appendChild(inp);
      row.appendChild(cell);
    }
  }

  async function init() {
    buildPiano(); buildChips(); buildSettings();
    paintKeys(); renderRail(); renderNames();
    setInterval(tick, 100);

    $("botBtn").addEventListener("click", () => { send({ t: "bot" }); $("botBtn").hidden = true; });
    $("openSettings").addEventListener("click", () => $("settings").showModal());
    $("reload").addEventListener("click", () => location.reload());
    $("rematch").addEventListener("click", () => {
      send({ t: "rematch" });
      $("rematch").disabled = true; $("rematch").textContent = "Waiting for opponent...";
    });
    $("chatForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const text = $("chatInput").value.trim();
      if (text) send({ t: "chat", text });
      $("chatInput").value = "";
      $("chatInput").blur();                              // back to the game so shortcut keys work
    });
    $("loginForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const nick = $("nick").value.trim();
      if (!nick) return;
      ensureAudio();                                      // needs a click/keypress to be allowed
      $("loginErr").textContent = "";
      let res;
      try {
        res = await (await fetch("/join", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nick }),
        })).json();
      } catch (err) { res = { ok: false, error: "The web client program is not running." }; }
      if (!res.ok) { $("loginErr").textContent = res.error || "Could not join."; return; }
      $("login").hidden = true; $("game").hidden = false;
      setStatus("Waiting for another player...");
    });

    await fetch("/leave", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
    await openStream();
    $("nick").focus();
  }

  init();
})();
