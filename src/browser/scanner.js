/*
 * Page-side scanner. Evaluated once per document inside the "bfm" isolated world as
 * `globalThis.__bfm ??= <this expression>`. Page scripts cannot see it, and it never
 * writes to the page DOM. Every function returns a JSON string (or a plain value).
 * Keep this file a single expression.
 */
(() => {
  const SELECTOR =
    'button, a[href], input:not([type=hidden]), textarea, select, [contenteditable=""], [contenteditable="true"], ' +
    '[role="button"], [role="link"], [role="textbox"], [role="searchbox"], [role="checkbox"], [role="radio"], ' +
    '[role="combobox"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"]';
  const BUTTON_INPUTS = ["submit", "button", "reset", "image"];
  const ROLE_FAMILY = { textbox: ["textbox", "searchbox", "combobox"], menuitem: ["menuitem", "option"] };

  const refOf = new WeakMap();
  const byRef = new Map();
  const meta = new Map();
  let counter = 0;

  let lastMutation = performance.now();
  if (document.documentElement) {
    new MutationObserver(() => {
      lastMutation = performance.now();
    }).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  }

  const norm = (s) => String(s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

  function visibleRect(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? r : null;
  }

  function root() {
    const modals = document.querySelectorAll('[aria-modal="true"], dialog[open]');
    for (let i = modals.length - 1; i >= 0; i--) if (visibleRect(modals[i])) return modals[i];
    return document.body ?? document.documentElement;
  }

  function inViewport(r) {
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }

  function isVisible(el) {
    const r = visibleRect(el);
    if (!r) return null;
    if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) return null;
    return r;
  }

  /** Visible candidates under root: in-viewport first (DOM order), then the rest. */
  function candidates(scope) {
    const inView = [];
    const offscreen = [];
    for (const el of scope.querySelectorAll(SELECTOR)) {
      const r = isVisible(el);
      if (!r) continue;
      if (inViewport(r)) inView.push([el, true]);
      else offscreen.push([el, false]);
    }
    return inView.concat(offscreen);
  }

  function roleOf(el) {
    const attr = (el.getAttribute("role") || "").trim().split(/\s+/)[0];
    if (attr) return attr.toLowerCase();
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox" || type === "radio") return type;
      if (BUTTON_INPUTS.includes(type)) return "button";
      if (type === "range") return "slider";
      return "textbox";
    }
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (el.isContentEditable) return "textbox";
    return tag;
  }

  function nameOf(el) {
    const isButtonInput = el.tagName === "INPUT" && BUTTON_INPUTS.includes((el.getAttribute("type") || "").toLowerCase());
    const labelledBy = el.getAttribute("aria-labelledby");
    const sources = [
      () => el.getAttribute("aria-label"),
      () => (labelledBy ? labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ") : ""),
      () => el.labels?.[0]?.textContent,
      () => el.getAttribute("placeholder"),
      () => (isButtonInput ? el.value : ""),
      () => el.getAttribute("title"),
      () => el.textContent,
      () => el.querySelector("img[alt]")?.getAttribute("alt"),
    ];
    for (const source of sources) {
      const value = clean(source());
      if (value) return value.slice(0, 80);
    }
    return "";
  }

  function record(el, inView, role = roleOf(el), name = nameOf(el)) {
    let ref = refOf.get(el);
    if (!ref) {
      ref = "e" + ++counter;
      refOf.set(el, ref);
      byRef.set(ref, el);
    }
    meta.set(ref, { role, name });
    const disabled = el.disabled === true || el.getAttribute("aria-disabled") === "true";
    return { ref, role, name, disabled, inView };
  }

  function scan(limit) {
    const scope = root();
    const all = candidates(scope);
    const result = {
      url: location.href,
      title: document.title,
      modal: scope !== document.body && scope !== document.documentElement,
      total: all.length,
      elements: all.slice(0, limit).map(([el, inView]) => record(el, inView)),
    };
    // A page with nothing interactive is otherwise blank in a snapshot: show what it says.
    if (all.length === 0) result.text = clean(document.body?.innerText).slice(0, 300);
    return JSON.stringify(result);
  }

  /**
   * Text tiers over all candidates (no cap); returns the first non-empty tier, max 20 matches,
   * in-viewport first. Role and name are filtered before any layout read, so only text hits
   * pay for getBoundingClientRect/checkVisibility.
   */
  function match(t, roleFilter) {
    const family = roleFilter ? ROLE_FAMILY[roleFilter] ?? [roleFilter] : null;
    const tiers = { exact: [], words: [], reverse: [] };
    const padded = " " + t + " ";
    for (const el of root().querySelectorAll(SELECTOR)) {
      const role = roleOf(el);
      if (family && !family.includes(role)) continue;
      const name = nameOf(el);
      const n = norm(name);
      if (!n) continue;
      let tier = null;
      if (n === t) tier = "exact";
      else if ((" " + n + " ").includes(padded)) tier = "words";
      else if (n.length >= 3 && padded.includes(" " + n + " ")) tier = "reverse";
      if (!tier || tiers[tier].length >= 20) continue;
      const r = isVisible(el);
      if (r) tiers[tier].push(record(el, inViewport(r), role, name));
    }
    for (const tier of ["exact", "words", "reverse"]) {
      const hits = tiers[tier];
      if (hits.length) return JSON.stringify({ tier, matches: hits.filter((h) => h.inView).concat(hits.filter((h) => !h.inView)) });
    }
    return JSON.stringify({ tier: null, matches: [] });
  }

  /** Resolves a ref to a click point, rebinding by role+name when the node was replaced. */
  function locate(ref) {
    let el = byRef.get(ref);
    let rebound = null;
    if (!el || !el.isConnected || !visibleRect(el)) {
      const known = meta.get(ref);
      if (!known) return JSON.stringify(null);
      const same = candidates(root()).filter(([c]) => c !== el && roleOf(c) === known.role && nameOf(c) === known.name);
      if (same.length !== 1) return JSON.stringify(null);
      el = same[0][0];
      rebound = record(el, same[0][1], known.role, known.name).ref;
    }
    let r = el.getBoundingClientRect();
    let x = r.left + r.width / 2;
    let y = r.top + r.height / 2;
    if (!(x >= 0 && y >= 0 && x < innerWidth && y < innerHeight)) {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      r = el.getBoundingClientRect();
      x = r.left + r.width / 2;
      y = r.top + r.height / 2;
    }
    const disabled = el.disabled === true || el.getAttribute("aria-disabled") === "true";
    return JSON.stringify({ x, y, role: roleOf(el), name: nameOf(el), disabled, ref, rebound, url: location.href });
  }

  return {
    scan,
    match,
    locate,
    /** Milliseconds since the last DOM mutation seen in this document. */
    idle: () => performance.now() - lastMutation,
    text: (max) => (document.body?.innerText ?? "").slice(0, max),
    has: (s) => (document.body?.innerText ?? "").includes(s),
  };
})()
