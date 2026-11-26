// The agents' browser.
// Agents drive the Browser tab: the frame named "arcex-preview" inside the Arcex window. They never reach the Arcex
// interface itself, which is the window's main frame. Clicks and keys go in as real mouse and keyboard events.
const PREVIEW = "arcex-preview";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Gives each element a person could use a number, and lists them with the page's headings and text.
const SNAPSHOT = String.raw`(() => {
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const shown = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const roleOf = (el) => {
    const role = el.getAttribute("role"); if (role) return role;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "select") return "dropdown";
    if (tag === "textarea") return "textbox";
    if (tag === "input") { const type = (el.type || "text").toLowerCase(); return ["checkbox", "radio", "range", "file", "submit", "button", "reset"].includes(type) ? type : "textbox"; }
    return tag === "summary" ? "disclosure" : "button";
  };
  document.querySelectorAll("[data-arcex-ref]").forEach((el) => el.removeAttribute("data-arcex-ref"));
  const usable = "a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[role=switch],[contenteditable=true]";
  const lines = [];
  let ref = 0;
  for (const el of document.body ? document.body.querySelectorAll("h1,h2,h3,h4,p,li,td,label," + usable) : []) {
    if (!shown(el)) continue;
    if (el.matches(usable)) {
      ref += 1;
      el.setAttribute("data-arcex-ref", String(ref));
      const role = roleOf(el);
      const name = clean(el.getAttribute("aria-label") || el.innerText || el.placeholder || el.title || el.getAttribute("alt") || el.name);
      let line = "[" + ref + "] " + role + ' "' + name.slice(0, 80) + '"';
      if ("value" in el && el.value && el.type !== "password" && role === "textbox") line += ' value="' + clean(el.value).slice(0, 60) + '"';
      if (el.type === "password") line += " (password)";
      if (el.checked) line += " (checked)";
      if (el.disabled) line += " (disabled)";
      if (el.tagName === "SELECT") line += ' selected="' + clean(el.options[el.selectedIndex] && el.options[el.selectedIndex].text) + '"';
      lines.push(line);
    } else if (!el.querySelector(usable)) {
      const words = clean(el.innerText);
      if (words) lines.push((/^H[1-4]$/.test(el.tagName) ? "# " : "") + words.slice(0, 300));
    }
    if (lines.length >= 400) { lines.push("(more on the page)"); break; }
  }
  return { url: location.href, title: document.title, page: lines.join("\n").slice(0, 16000) };
})()`;

// Runs in the page. Resolves with { selector, tag, text, html, styles, note, rect, url, title } or null when cancelled.
const PICKER = String.raw`new Promise((resolve) => {
  if (window.__arcexPickDone) window.__arcexPickDone();
  const host = document.createElement("div");
  host.setAttribute("data-arcex-picker", "");
  host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = '<style>' +
    '.box{position:fixed;border:2px solid #f4f4f5;border-radius:4px;box-shadow:0 0 0 9999px rgba(0,0,0,.18);pointer-events:none;transition:all .06s ease-out}' +
    '.tag{position:fixed;font:600 12px/20px system-ui,sans-serif;color:#0b0b0c;background:#f4f4f5;padding:0 7px;border-radius:4px;pointer-events:none;white-space:nowrap}' +
    '.hint{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);font:500 13px/20px system-ui,sans-serif;color:#f4f4f5;background:#17171a;border:1px solid rgba(255,255,255,.13);padding:7px 12px;border-radius:9px;pointer-events:none}' +
    '.note{position:fixed;width:280px;pointer-events:auto;background:#17171a;border:1px solid rgba(255,255,255,.13);border-radius:10px;padding:8px;box-shadow:0 12px 32px -14px rgba(0,0,0,.8)}' +
    '.note textarea{box-sizing:border-box;width:100%;min-height:56px;resize:vertical;background:#0e0e10;color:#f4f4f5;border:1px solid rgba(255,255,255,.13);border-radius:7px;padding:7px 9px;font:14px/20px system-ui,sans-serif;outline:none}' +
    '.note textarea:focus{border-color:rgba(255,255,255,.35)}' +
    '.note p{margin:6px 2px 0;font:12px/16px system-ui,sans-serif;color:#a6a6ad}' +
    '</style><div class="box" hidden></div><div class="tag" hidden></div><div class="hint">Click the part of the page you mean. Esc to cancel.</div>';
  const box = root.querySelector(".box"), tag = root.querySelector(".tag"), hint = root.querySelector(".hint");
  document.documentElement.appendChild(host);
  let current = null, chosen = null, note = null;
  const clean = (value, max) => String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
  const describe = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + [...el.classList].slice(0, 2).map((c) => "." + c).join("");
  const selectorOf = (el) => {
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && node !== document.documentElement && parts.length < 6; node = node.parentElement) {
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) { parts.unshift("#" + node.id); break; }
      let part = node.tagName.toLowerCase();
      const classes = [...node.classList].filter((c) => /^[A-Za-z_-][\w-]*$/.test(c)).slice(0, 2);
      if (classes.length) part += "." + classes.join(".");
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((child) => child.tagName === node.tagName);
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
    }
    return parts.join(" > ") || el.tagName.toLowerCase();
  };
  const place = (el) => {
    const r = el.getBoundingClientRect();
    box.hidden = false; tag.hidden = false;
    Object.assign(box.style, { left: r.left - 2 + "px", top: r.top - 2 + "px", width: r.width + 4 + "px", height: r.height + 4 + "px" });
    tag.textContent = describe(el);
    tag.style.left = Math.max(4, r.left) + "px";
    tag.style.top = (r.top > 26 ? r.top - 24 : r.bottom + 4) + "px";
  };
  const inside = (event) => event.composedPath().includes(host);
  const onMove = (event) => {
    if (chosen || inside(event)) return;
    const el = document.elementFromPoint(event.clientX, event.clientY);
    if (el && el !== current && el !== host) { current = el; place(el); }
  };
  const block = (event) => { if (!inside(event)) { event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); } };
  const finish = (result) => {
    removeEventListener("mousemove", onMove, true);
    for (const type of ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "contextmenu", "submit"]) removeEventListener(type, block, true);
    removeEventListener("click", ask, true);
    removeEventListener("keydown", onKey, true);
    if (note) note.remove();
    hint.remove();
    if (!result) host.remove();
    window.__arcexPickDone = () => { host.remove(); window.__arcexPickDone = undefined; };
    resolve(result);
  };
  const result = () => {
    const el = chosen, r = el.getBoundingClientRect(), s = getComputedStyle(el);
    const open = el.outerHTML.slice(0, el.outerHTML.indexOf(">") + 1);
    return {
      selector: selectorOf(el), tag: el.tagName.toLowerCase(), text: clean(el.innerText || el.getAttribute("aria-label") || el.getAttribute("alt") || el.value, 160),
      html: open.slice(0, 300), note: clean(note.querySelector("textarea").value, 2000),
      styles: { font: s.fontSize + " " + s.fontWeight, color: s.color, background: s.backgroundColor, padding: s.padding, size: Math.round(r.width) + "×" + Math.round(r.height) },
      rect: { x: r.left, y: r.top, width: r.width, height: r.height }, url: location.href, title: document.title,
    };
  };
  const ask = (event) => {
    block(event);
    if (chosen || inside(event)) return;
    chosen = current || document.elementFromPoint(event.clientX, event.clientY);
    if (!chosen) return;
    place(chosen);
    hint.textContent = "Say what should change, then Enter. Esc to cancel.";
    note = document.createElement("div");
    note.className = "note";
    note.innerHTML = '<textarea placeholder="What should change here?" maxlength="2000"></textarea><p>Enter adds it to your message. Shift+Enter for a new line.</p>';
    root.appendChild(note);
    const r = chosen.getBoundingClientRect();
    note.style.left = Math.min(Math.max(8, r.left), innerWidth - 296) + "px";
    note.style.top = (r.bottom + 120 < innerHeight ? r.bottom + 8 : Math.max(8, r.top - 120)) + "px";
    note.querySelector("textarea").focus();
  };
  const onKey = (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); return finish(null); }
    if (chosen && event.key === "Enter" && !event.shiftKey && inside(event)) { event.preventDefault(); event.stopPropagation(); return finish(result()); }
    if (inside(event)) event.stopPropagation();
  };
  addEventListener("mousemove", onMove, true);
  for (const type of ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "contextmenu", "submit"]) addEventListener(type, block, true);
  addEventListener("click", ask, true);
  addEventListener("keydown", onKey, true);
  window.__arcexPickDone = () => finish(null);
})`;

const KEYS = {
  enter: "Enter", tab: "Tab", escape: "Escape", backspace: "Backspace", delete: "Delete", space: " ",
  arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
};
const WHERE = "({ url: location.href, title: document.title })";
const NOT_OPEN = "The Browser tab isn't showing. Ask the user to open this project in Arcex, then try again.";

function createAgentBrowser(getWindow, getEngineUrl) {
  const pageConsole = [];
  const win = () => {
    const window = getWindow();
    if (!window || window.isDestroyed()) throw new Error("The Arcex window is closed.");
    return window;
  };

  function previewFrame() {
    for (const frame of win().webContents.mainFrame.frames) {
      try {
        if (frame.name === PREVIEW && !frame.detached) return frame;
      } catch {
        // A frame that went away while looking.
      }
    }
    return undefined;
  }

  async function frameReady(waitMs) {
    const until = Date.now() + waitMs;
    while (Date.now() < until) {
      const frame = previewFrame();
      if (frame) {
        try {
          if ((await frame.executeJavaScript("document.readyState")) === "complete") return frame;
        } catch {
          // Mid-navigation; look again.
        }
      }
      await wait(150);
    }
    throw new Error(previewFrame() ? "The page took too long to load. Check that the app is running." : NOT_OPEN);
  }

  // Chromium can swap the frame object (for example on focus or navigation), so every call looks it up again.
  async function inFrame(script, waitMs = 15_000) {
    for (let attempt = 0; ; attempt++) {
      const frame = await frameReady(waitMs);
      try {
        return await frame.executeJavaScript(script);
      } catch (error) {
        if (attempt >= 2 || !/disposed|destroyed|detached/i.test(String(error?.message))) throw error;
        await wait(250);
      }
    }
  }

  async function previewRect() {
    const rect = await win().webContents.mainFrame.executeJavaScript(
      `(() => { const r = document.querySelector('iframe[name="${PREVIEW}"]')?.getBoundingClientRect(); return r ? { x: r.left, y: r.top, width: r.width, height: r.height } : null; })()`,
    );
    if (!rect) throw new Error(NOT_OPEN);
    return rect;
  }

  // Everything happens inside the page itself, so it works while Arcex is in the background.
  // (Simulated keyboard input needs the window in front, and Electron's insertText crashes cross-site frames.)
  async function onElement(ref, body) {
    if (!Number.isInteger(ref) || ref < 1) throw new Error("Use a number from the latest browser_snapshot.");
    const found = await inFrame(`(() => {
      const el = document.querySelector('[data-arcex-ref="${ref}"]');
      if (!el) return false;
      el.scrollIntoView({ block: "center", inline: "center" });
      ${body}
      return true;
    })()`);
    if (!found) throw new Error(`There is no [${ref}] on the page now. Take a new browser_snapshot.`);
    await wait(250);
  }

  const CLICK = `
    const at = el.getBoundingClientRect();
    const where = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, clientX: at.left + at.width / 2, clientY: at.top + at.height / 2 };
    el.dispatchEvent(new PointerEvent("pointerdown", where));
    el.dispatchEvent(new MouseEvent("mousedown", where));
    if (typeof el.focus === "function") el.focus();
    el.dispatchEvent(new PointerEvent("pointerup", where));
    el.dispatchEvent(new MouseEvent("mouseup", where));
    el.click();`;

  // Sets a field's text the way typing does, so frameworks such as React see the change.
  const typeInto = (text) => `
    el.focus();
    const text = ${JSON.stringify(text)};
    if (el.isContentEditable) {
      document.execCommand("selectAll");
      if (!document.execCommand("insertText", false, text)) el.textContent = text;
    } else {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, text);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }`;

  // A key press on whatever has focus. Enter submits the field's form, Tab moves to the next field.
  const pressKey = (key) => `
    const key = ${JSON.stringify(key)};
    const target = el || document.activeElement || document.body;
    const down = new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true });
    const allowed = target.dispatchEvent(down);
    if (allowed && key === "Enter" && target.form) target.form.requestSubmit();
    if (allowed && key === "Tab") {
      const all = [...document.querySelectorAll("a[href],button,input,select,textarea,[tabindex]:not([tabindex='-1'])")].filter((n) => !n.disabled);
      all[(all.indexOf(target) + 1) % all.length]?.focus();
    }
    target.dispatchEvent(new KeyboardEvent("keyup", { key, code: key, bubbles: true }));`;

  function keyName(name) {
    const key = KEYS[String(name).toLowerCase()];
    if (!key) throw new Error(`Supported keys: ${Object.values(KEYS).join(", ")}.`);
    return key;
  }

  async function settled(waitMs = 15_000) {
    await wait(400);
    return inFrame(WHERE, waitMs);
  }

  async function act(action, args) {
    if (action === "open") {
      // The engine has already pointed the Browser tab at the address. Reload when it was already there.
      await frameReady(8000);
      if (args.reload) await inFrame("location.reload()").catch(() => {});
      return settled(20_000);
    }
    switch (action) {
      case "snapshot":
        return inFrame(SNAPSHOT);
      case "click":
        await onElement(args.ref, CLICK);
        return settled();
      case "type":
        await onElement(args.ref, typeInto(String(args.text ?? "")) + (args.submit ? pressKey("Enter") : ""));
        return settled();
      case "press": {
        const key = keyName(args.key);
        await inFrame(`(() => { const el = null; ${pressKey(key)} })()`);
        return settled();
      }
      case "screenshot": {
        const rect = await previewRect();
        const image = await win().webContents.capturePage({
          x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)),
        });
        return { image: image.toJPEG(80).toString("base64"), mimeType: "image/jpeg" };
      }
      case "console":
        return { messages: pageConsole.splice(0) };
      case "back":
        await inFrame("history.back()");
        return settled();
      case "reload":
        await inFrame("location.reload()");
        return settled(20_000);
      default:
        throw new Error("Unknown browser action");
    }
  }

  // The user points at something in the Browser tab (P10): hover outlines an element, a click picks it and opens a small
  // "What should change?" box beside it. Enter returns the element and the note, Esc cancels. The page can't receive the
  // click itself while picking. The outline stays on for the screenshot, then everything Arcex added is removed.
  async function pick() {
    const picked = await inFrame(PICKER, 8000);
    if (!picked) return null;
    try {
      const frame = await previewRect();
      const pad = 48;
      const left = Math.max(0, picked.rect.x - pad);
      const top = Math.max(0, picked.rect.y - pad);
      const right = Math.min(frame.width, picked.rect.x + picked.rect.width + pad);
      const bottom = Math.min(frame.height, picked.rect.y + picked.rect.height + pad);
      const image = await win().webContents.capturePage({
        x: Math.round(frame.x + left), y: Math.round(frame.y + top), width: Math.max(1, Math.round(right - left)), height: Math.max(1, Math.round(bottom - top)),
      });
      return { ...picked, image: image.toPNG().toString("base64") };
    } finally {
      await inFrame("window.__arcexPickDone && window.__arcexPickDone()", 2000).catch(() => {});
    }
  }

  // Keeps what the page in the Browser tab logs, so an agent can check it for errors. Arcex's own logs are left out.
  function watch(window) {
    window.webContents.on("console-message", (event) => {
      const source = event.sourceId ?? "";
      let fromPreview;
      try {
        fromPreview = event.frame ? event.frame.name === PREVIEW : !!source && !source.startsWith(getEngineUrl() ?? "\0");
      } catch {
        fromPreview = false;
      }
      if (!fromPreview) return;
      pageConsole.push({ level: event.level ?? "info", message: String(event.message).slice(0, 2000), source: `${source}:${event.lineNumber ?? 0}` });
      if (pageConsole.length > 200) pageConsole.shift();
    });
  }

  // Ends a pick in progress, for example when the user presses the button again.
  const cancelPick = () => inFrame("window.__arcexPickDone && window.__arcexPickDone()", 2000).catch(() => {});

  return { act, watch, pick, cancelPick };
}

module.exports = { createAgentBrowser };
