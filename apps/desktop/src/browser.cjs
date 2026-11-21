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

  return { act, watch };
}

module.exports = { createAgentBrowser };
