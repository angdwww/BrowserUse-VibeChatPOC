#!/usr/bin/env node
import blessed from "blessed";
import { chromium, firefox, webkit } from "playwright";
import { inspect } from "node:util";
import { PNG } from "pngjs";

const VERSION = "0.3.0";

const shotHoverYOffsetCells = 5;

const HELP = `
Terminal Browser TUI ${VERSION}

One-line command chains:
  goto artificialanalysis.ai; waitload load; context
  goto google.com; inputs; type 1 hello world; press Enter

Commands:
  help
  goto <url-or-search>
  url | title | ready | status
  reload | back | forward
  scroll [down|up|top|bottom|left|right|amount]
  scrollup [amount] | scrolldown [amount]
  waitload [domcontentloaded|load|networkidle]
  context [selector]
  text [selector]
  links [filter]
  buttons [filter]
  inputs [filter]
  open <link-number>
  click <number-or-selector-or-text>
  clickxy <x> <y>       click page viewport coordinates from shot hover
  type <number-or-selector> <text>
  type <text>              type into the currently focused page element
  typehere <text>          type into the currently focused page element
  typeenter <number-or-selector> <text>
  typeenter <text>         type into focused element, then press Enter
  typeenter                press Enter in the page
  typef1..typef12          press function keys in the page, e.g. typef6
  typeesc | typetab | typespace | typebackspace | typedelete
  enter [number-or-selector]
  hover <control-number>
  key <key>                same as press <key>
  press <key>
  wait <ms-or-selector>
  screenshot [path]
  shot [selector]         real terminal image overlay when supported
  image                  same as shot
  render [selector]      terminal HTML/layout structure
  dom [selector]         terminal HTML/layout structure
  ascii [width]          old image-to-ASCII screenshot
  eval <javascript-expression>
  search <query>         web search the query
  find <query>           find text on the current page
  errors on|off
  newtab [url]
  tabs
  tab <number>
  nexttab
  prevtab
  closetab [number]
  clear
  exit
`;

function parseArgs(argv) {
  const options = {
    browser: "chromium",
    headed: false,
    userDataDir: null,
    timeout: 15000,
    waitUntil: "domcontentloaded",
    startUrl: null,
    runCommands: null,
    smokeTest: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--browser") options.browser = argv[++i] || options.browser;
    else if (arg === "--headed") options.headed = true;
    else if (arg === "--user-data-dir") options.userDataDir = argv[++i] || null;
    else if (arg === "--timeout") options.timeout = Number(argv[++i] || options.timeout);
    else if (arg === "--wait-until") options.waitUntil = argv[++i] || options.waitUntil;
    else if (arg === "--run") options.runCommands = argv[++i] || "";
    else if (arg === "--smoke-test") options.smokeTest = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(HELP.trim());
      process.exit(0);
    } else if (arg === "--version" || arg === "-v") {
      console.log(VERSION);
      process.exit(0);
    } else if (!options.startUrl) {
      options.startUrl = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!["chromium", "firefox", "webkit"].includes(options.browser)) {
    throw new Error("--browser must be chromium, firefox, or webkit");
  }
  if (!["domcontentloaded", "load", "networkidle"].includes(options.waitUntil)) {
    throw new Error("--wait-until must be domcontentloaded, load, or networkidle");
  }
  return options;
}

function normalizeUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "about:blank";
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return text;
  if (text.includes(".") && !text.includes(" ")) return `https://${text}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(text)}`;
}


function decodeHtml(value = "") {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripTags(value = "") {
  return decodeHtml(String(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

function resolveDuckDuckGoHref(href = "") {
  const decoded = decodeHtml(href);
  try {
    const url = new URL(decoded, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    if (url.protocol === "http:" || url.protocol === "https:") return url.href;
  } catch {}
  return decoded;
}

async function fetchDuckDuckGoResults(query, { limit = 10 } = {}) {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9"
    }
  });
  if (!response.ok) throw new Error(`DuckDuckGo search failed: ${response.status} ${response.statusText}`);

  const html = await response.text();
  const blocks = html.split(/<div[^>]+class="[^"]*result[^"]*"[^>]*>/i).slice(1);
  const results = [];

  for (const block of blocks) {
    const linkMatch = block.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    const href = resolveDuckDuckGoHref(linkMatch[1]);
    const title = stripTags(linkMatch[2]);
    if (!title || !/^https?:\/\//i.test(href)) continue;

    const snippetMatch = block.match(/<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<div[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const snippet = snippetMatch ? stripTags(snippetMatch[1]) : "";

    if (results.some((item) => item.href === href)) continue;
    results.push({ number: results.length + 1, text: title, href, snippet });
    if (results.length >= limit) break;
  }

  return results;
}

async function fetchSearchResults(query, options = {}) {
  return await fetchDuckDuckGoResults(query, options);
}

function formatSearchResults(query, results = []) {
  if (!results.length) return `No search results found for: ${query}`;
  return [
    `Search results for: ${query}`,
    "",
    ...results.map((item) => [
      `${item.number}. ${item.text}`,
      `   ${item.href}`,
      item.snippet ? `   ${item.snippet}` : null,
      `   command: open ${item.number}`
    ].filter(Boolean).join("\n"))
  ].join("\n\n");
}

function splitCommand(line) {
  const parts = [];
  let current = "";
  let quote = null;
  let escaped = false;

  for (const char of String(line || "").trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current) parts.push(current);
  return parts;
}

function splitCommandChain(line) {
  const commands = [];
  let current = "";
  let quote = null;
  let escaped = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const next = line[i + 1];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      current += char;
      quote = char;
      continue;
    }
    if (char === ";" || (char === "&" && next === "&")) {
      if (current.trim()) commands.push(current.trim());
      current = "";
      if (char === "&") i++;
      continue;
    }
    current += char;
  }

  if (current.trim()) commands.push(current.trim());
  return commands;
}

function short(text, limit = 120) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function trimOutput(text, limit = 22000) {
  const value = String(text || "");
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n... truncated ${value.length - limit} chars`;
}

function escapeBlessed(text) {
  return String(text ?? "").replace(/[{}]/g, (m) => (m === "{" ? "\\{" : "\\}"));
}

async function pageSummary(page) {
  const title = await page.title().catch(() => "");
  return `${title || "(no title)"} — ${page.url()}`;
}

async function getStatus(page) {
  return page.evaluate(() => ({
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    bodyTextLength: document.body?.innerText?.length || 0,
    links: document.links.length,
    scripts: document.scripts.length,
    appRoots: ["#__next", "#root", "#app", "main"].map((selector) => ({
      selector,
      exists: Boolean(document.querySelector(selector)),
      textLength: document.querySelector(selector)?.innerText?.length || 0
    }))
  }));
}

async function getContext(page, selector = "body") {
  return page.evaluate((sel) => {
    const target = document.querySelector(sel) || document.body;
    const links = [...document.links].slice(0, 20).map((link, index) => ({
      number: index + 1,
      text: (link.innerText || link.textContent || "").replace(/\s+/g, " ").trim(),
      href: link.href
    }));
    const buttons = [...document.querySelectorAll("a, button, input[type=button], input[type=submit], [role=button]")]
      .filter((node) => Boolean(node.offsetWidth || node.offsetHeight || node.getClientRects().length))
      .slice(0, 40)
      .map((node, index) => ({
        number: index + 1,
        tag: node.tagName.toLowerCase(),
        label: (node.getAttribute("aria-label") || node.getAttribute("placeholder") || node.getAttribute("value") || node.innerText || node.textContent || node.href || "").replace(/\s+/g, " ").trim()
      }));
    return {
      title: document.title,
      url: location.href,
      readyState: document.readyState,
      textPreview: (target?.innerText || "").replace(/\n{3,}/g, "\n\n").slice(0, 5000),
      links,
      buttons
    };
  }, selector);
}

async function getLinks(page, filter = "") {
  const links = await page.locator("a").evaluateAll((nodes) =>
    nodes.map((node, i) => ({
      number: i + 1,
      text: (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim(),
      href: node.href || node.getAttribute("href") || "",
      visible: Boolean(node.offsetWidth || node.offsetHeight || node.getClientRects().length)
    })).filter((item) => item.visible && (item.text || item.href))
  );

  const query = filter.toLowerCase();
  return query
    ? links.filter((item) => `${item.text} ${item.href}`.toLowerCase().includes(query))
    : links;
}

async function getControls(page, filter = "") {
  const controls = await page.locator("input, textarea, select, button, a, img, [role=button], [role=menuitem], [role=option], [contenteditable=true]").evaluateAll((nodes) => {
    const visible = (node) => Boolean(node.offsetWidth || node.offsetHeight || node.getClientRects().length);
    const labelled = (node) => (node.getAttribute("aria-labelledby") || "").split(/\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" ");
    const nameFor = (node) => {
      const img = node.matches("img") ? node : node.querySelector?.("img");
      const choices = [node.getAttribute("aria-label"), labelled(node), node.getAttribute("title"), node.getAttribute("alt"), img?.getAttribute("alt"), img?.getAttribute("title"), node.getAttribute("placeholder"), node.getAttribute("value"), node.getAttribute("name"), node.id ? `#${node.id}` : "", node.innerText, node.textContent, node.getAttribute("href"), node.getAttribute("src")];
      return String(choices.find((v) => v && String(v).replace(/\s+/g, " ").trim()) || "unlabeled control").replace(/\s+/g, " ").trim();
    };
    return nodes.map((node, i) => {
      const tag = node.tagName.toLowerCase();
      const type = node.getAttribute("type") || node.getAttribute("role") || "";
      const uid = `tb-control-${i + 1}`;
      node.setAttribute("data-term-browser-id", uid);
      const isField = tag === "input" || tag === "textarea" || tag === "select" || node.getAttribute("contenteditable") === "true";
      return { number: i + 1, kind: [tag, type].filter(Boolean).join(":"), name: nameFor(node), selector: `[data-term-browser-id="${uid}"]`, command: isField ? `type ${i + 1} <text>` : `click ${i + 1}`, visible: visible(node) };
    }).filter((item) => item.visible);
  });
  const q = filter.toLowerCase();
  return q ? controls.filter((item) => `${item.kind} ${item.name} ${item.selector}`.toLowerCase().includes(q)) : controls;
}

async function terminalCellGeometry() {
  const fallback = {
    columns: process.stdout.columns || 120,
    rows: process.stdout.rows || 40,
    pixelWidth: null,
    pixelHeight: null,
    cellWidth: 1,
    cellHeight: 2
  };

  try {
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync("kitten", ["icat", "--print-window-size"], { encoding: "utf8" });
    const text = `${result.stdout || ""} ${result.stderr || ""}`;
    const nums = [...text.matchAll(/\d+/g)].map((m) => Number(m[0])).filter(Number.isFinite);
    if (result.status === 0 && nums.length >= 2) {
      const pixelWidth = nums[0];
      const pixelHeight = nums[1];
      const columns = process.stdout.columns || fallback.columns;
      const rows = process.stdout.rows || fallback.rows;
      return {
        columns,
        rows,
        pixelWidth,
        pixelHeight,
        cellWidth: pixelWidth / Math.max(1, columns),
        cellHeight: pixelHeight / Math.max(1, rows)
      };
    }
  } catch {}

  return fallback;
}

async function terminalImageRender(page, target = "viewport", options = {}) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const shotDir = path.join(process.cwd(), ".shots");
  await fs.mkdir(shotDir, { recursive: true });

  const createdAt = new Date().toISOString();
  const file = path.join(shotDir, `shot-${Date.now()}-${Math.random().toString(16).slice(2)}.png`);
  const normalizedTarget = String(target || "viewport").trim() || "viewport";
  const terminalGeometry = await terminalCellGeometry();
  let captureMode = "viewport";
  let title = "Viewport screenshot";
  let imageWidth = null;
  let imageHeight = null;
  let viewport = page.viewportSize();

  const viewportSizeFromPage = async () => {
    const size = page.viewportSize();
    if (size?.width && size?.height) return size;
    return await page.evaluate(() => ({
      width: window.innerWidth || document.documentElement.clientWidth || 1,
      height: window.innerHeight || document.documentElement.clientHeight || 1
    }));
  };

  if (["viewport", "screen", "visible"].includes(normalizedTarget)) {
    viewport = await viewportSizeFromPage();
    await page.screenshot({ path: file, fullPage: false });
    imageWidth = viewport.width;
    imageHeight = viewport.height;
    captureMode = "viewport";
    title = `Viewport screenshot (${imageWidth}x${imageHeight})`;
  } else if (normalizedTarget === "fullpage" || normalizedTarget === "full") {
    const dims = await page.evaluate(() => ({
      width: Math.max(document.documentElement.scrollWidth || 0, document.body?.scrollWidth || 0, window.innerWidth || 1),
      height: Math.max(document.documentElement.scrollHeight || 0, document.body?.scrollHeight || 0, window.innerHeight || 1),
      viewportWidth: window.innerWidth || document.documentElement.clientWidth || 1,
      viewportHeight: window.innerHeight || document.documentElement.clientHeight || 1
    }));
    await page.screenshot({ path: file, fullPage: true });
    imageWidth = dims.width;
    imageHeight = dims.height;
    viewport = { width: dims.viewportWidth, height: dims.viewportHeight };
    captureMode = "fullpage";
    title = `Full page screenshot (${imageWidth}x${imageHeight})`;
  } else {
    const locator = page.locator(normalizedTarget).first();
    const box = await locator.boundingBox().catch(() => null);
    await locator.screenshot({ path: file });
    imageWidth = Math.max(1, Math.round(box?.width || 1));
    imageHeight = Math.max(1, Math.round(box?.height || 1));
    viewport = await viewportSizeFromPage();
    captureMode = "selector";
    title = `Selector screenshot: ${normalizedTarget} (${imageWidth}x${imageHeight})`;
  }

  return {
    file,
    selector: normalizedTarget,
    title,
    createdAt,
    renderMode: options.renderMode || "graphics",
    captureMode,
    imageWidth,
    imageHeight,
    viewportWidth: viewport?.width || imageWidth,
    viewportHeight: viewport?.height || imageHeight,
    terminalGeometry
  };
}

async function terminalHtmlRender(page, selector = "body") {
  const data = await page.evaluate((selector) => {
    const root = document.querySelector(selector) || document.body;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const interactiveTags = new Set(["a", "button", "input", "textarea", "select", "summary", "option", "img"]);
    const sectionTags = new Set(["main", "header", "nav", "footer", "section", "article", "aside", "form", "dialog", "menu", "ul", "ol", "table"]);
    const headingTags = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const isVisible = (node) => {
      if (!(node instanceof Element)) return false;
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 1 && rect.height > 1;
    };
    const labelFor = (el) => {
      const labelledBy = clean((el.getAttribute("aria-labelledby") || "").split(/\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" "));
      const img = el.matches("img") ? el : el.querySelector?.("img");
      const label = clean([
        el.getAttribute("aria-label"),
        labelledBy,
        el.getAttribute("alt"),
        img?.getAttribute("alt"),
        el.getAttribute("title"),
        el.getAttribute("placeholder"),
        el.getAttribute("value"),
        el.innerText,
        el.textContent,
        el.getAttribute("href"),
        el.getAttribute("src")
      ].find((v) => clean(v)) || "");
      return label.slice(0, 140);
    };
    const cssName = (el) => {
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : "";
      const cls = clean(el.className && typeof el.className === "string" ? el.className : "").split(" ").filter(Boolean).slice(0, 3).map((c) => `.${c}`).join("");
      return `${tag}${id}${cls}`;
    };
    const roleFor = (el) => el.getAttribute("role") || el.getAttribute("type") || "";
    const isImportant = (el) => {
      const tag = el.tagName.toLowerCase();
      return el === root || interactiveTags.has(tag) || sectionTags.has(tag) || headingTags.has(tag) || el.getAttribute("role") || el.getAttribute("aria-label") || el.id || clean(el.innerText).length > 30;
    };

    const out = [];
    let count = 0;
    const maxNodes = 220;

    const walk = (el, depth = 0) => {
      if (count >= maxNodes || !isVisible(el)) return;
      const kids = [...el.children].filter(isVisible);
      const important = isImportant(el);
      if (important) {
        const rect = el.getBoundingClientRect();
        const tag = el.tagName.toLowerCase();
        const role = roleFor(el);
        const text = labelFor(el);
        out.push({
          depth,
          node: cssName(el),
          role,
          tag,
          text,
          box: {
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            w: Math.round(rect.width),
            h: Math.round(rect.height)
          },
          commandHint: interactiveTags.has(tag) || el.getAttribute("role") === "button"
        });
        count++;
      }
      const nextDepth = important ? depth + 1 : depth;
      for (const child of kids) walk(child, nextDepth);
    };

    walk(root, 0);
    return { title: document.title, url: location.href, viewport, selector, nodes: out, truncated: count >= maxNodes };
  }, selector);

  const lines = [
    `title: ${data.title || "(untitled)"}`,
    `url: ${data.url}`,
    `viewport: ${data.viewport.width}x${data.viewport.height}`,
    `selector: ${data.selector}`,
    "",
    "Terminal HTML/layout render:",
    "Format: tree | element | role/type | screen box | visible text/name",
    ""
  ];

  for (const item of data.nodes) {
    const indent = "  ".repeat(Math.min(item.depth, 12));
    const role = item.role ? ` role/type=${item.role}` : "";
    const box = ` box=${item.box.x},${item.box.y} ${item.box.w}x${item.box.h}`;
    const text = item.text ? ` :: ${item.text}` : "";
    const hint = item.commandHint ? "  [interactive: run buttons/click/type]" : "";
    lines.push(`${indent}<${item.node}>${role}${box}${text}${hint}`);
  }

  if (!data.nodes.length) lines.push("No visible DOM nodes found for this selector.");
  if (data.truncated) lines.push("", "[truncated: first 220 visible structural nodes shown]");
  return lines.join("\n");
}

async function screenshotAscii(page, maxWidth = 90) {
  const width = Math.max(30, Math.min(Number(maxWidth) || 90, 160));
  const png = PNG.sync.read(await page.screenshot({ fullPage: false }));
  const chars = " .:-=+*#%@";
  const height = Math.max(12, Math.round((png.height / png.width) * width * 0.48));
  const rows = [];
  for (let y = 0; y < height; y++) {
    let row = "";
    for (let x = 0; x < width; x++) {
      const px = Math.min(png.width - 1, Math.floor(x * png.width / width));
      const py = Math.min(png.height - 1, Math.floor(y * png.height / height));
      const i = (py * png.width + px) * 4;
      const a = png.data[i + 3] / 255;
      const lum = (0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2]) * a + 255 * (1 - a);
      row += chars[Math.max(0, Math.min(chars.length - 1, Math.floor(lum / 255 * (chars.length - 1))))];
    }
    rows.push(row);
  }
  return rows.join("\n");
}

function byNumber(raw, list) {
  const number = Number(raw);
  if (!Number.isInteger(number) || number < 1) return null;
  return list.find((item) => item.number === number) || list[number - 1] || null;
}

async function clickThing(page, state, target) {
  const control = byNumber(target, state.controls);
  if (control?.selector) {
    await page.locator(control.selector).nth(Math.max(0, control.number - 1)).click().catch(async () => {
      await page.locator(control.selector).first().click();
    });
    return;
  }

  const link = byNumber(target, state.links);
  if (link?.href) {
    await page.goto(link.href, { waitUntil: state.options.waitUntil });
    return;
  }

  const css = page.locator(target).first();
  if (await css.count().catch(() => 0)) {
    await css.click();
    return;
  }

  await page.getByText(target, { exact: false }).first().click();
}

async function clickTarget(page, state, raw) {
  const target = String(raw || "").trim();
  if (!target) throw new Error("Usage: click <number-or-selector-or-text>");

  const numberedControl = /^\d+$/.test(target) ? byNumber(target, state.controls) : null;
  if (numberedControl?.selector) {
    await page.locator(numberedControl.selector).first().click({ timeout: state.options.timeout });
    return;
  }

  const numberedLink = /^\d+$/.test(target) ? byNumber(target, state.links) : null;
  if (numberedLink?.href) {
    await page.goto(numberedLink.href, { waitUntil: state.options.waitUntil });
    return;
  }

  const selectorLike = /^[#.[>:*]/.test(target) || /^(input|textarea|select|button|a|form|\[)/i.test(target);
  if (selectorLike) {
    await page.locator(target).first().click({ timeout: state.options.timeout });
    return;
  }

  await page.getByText(target, { exact: false }).first().click({ timeout: state.options.timeout });
}

async function typeInto(page, state, target, text) {
  const control = byNumber(target, state.controls);
  const selector = control?.selector || target;
  const locator = page.locator(selector).first();
  await locator.click({ timeout: state.options.timeout }).catch(() => {});
  await locator.fill(text, { timeout: state.options.timeout }).catch(async () => {
    await page.keyboard.press("Control+A").catch(() => {});
    await page.keyboard.type(text);
  });
  await locator.focus().catch(() => {});
}

function scrollbarContent(visibleRows, totalLines, offset) {
  const rows = Math.max(1, visibleRows);
  if (totalLines <= rows) return " ".repeat(rows).split("").join("\n");
  const maxScroll = Math.max(1, totalLines - rows);
  const thumbSize = Math.max(1, Math.round((rows / totalLines) * rows));
  const thumbTop = Math.round((Math.max(0, Math.min(maxScroll, offset)) / maxScroll) * Math.max(0, rows - thumbSize));
  return Array.from({ length: rows }, (_, row) => row >= thumbTop && row < thumbTop + thumbSize ? "█" : "│").join("\n");
}

function paintScrollbar(bar, visibleRows, totalLines, offset) {
  if (!bar) return;
  bar.setContent(scrollbarContent(visibleRows, totalLines, offset));
}

function virtualScrollGlyph(row, visibleRows, totalLines, offset) {
  if (totalLines <= visibleRows) return " ";
  const trackRows = Math.max(1, visibleRows);
  const maxScroll = Math.max(1, totalLines - visibleRows);
  const thumbSize = Math.max(1, Math.round((visibleRows / totalLines) * trackRows));
  const thumbTop = Math.round((Math.max(0, Math.min(maxScroll, offset)) / maxScroll) * Math.max(0, trackRows - thumbSize));
  return row >= thumbTop && row < thumbTop + thumbSize ? "█" : "│";
}

function makeUi() {
  const screen = blessed.screen({
    smartCSR: true,
    title: "Terminal Browser",
    fullUnicode: true,
    mouse: true
  });

  const footer = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: "100%",
    height: 1,
    tags: true,
    content: "",
    style: { bg: "black", fg: "white" }
  });

  const left = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: "36%",
    height: "100%-1",
    border: "line",
    label: " Controls / logs / errors ",
    style: { border: { fg: "cyan" } }
  });

  const log = blessed.box({
    parent: left,
    top: 0,
    left: 0,
    width: "100%-3",
    bottom: 5,
    tags: false,
    ansi: true,
    scrollable: true,
    alwaysScroll: true,
    mouse: true,
    keys: true
  });

  const logScrollBar = blessed.box({
    parent: left,
    top: 0,
    right: 1,
    width: 1,
    bottom: 5,
    tags: false,
    hidden: false,
    mouse: true,
    content: "",
    style: { fg: "white", bg: "black" }
  });


  const inputLine = blessed.box({
    parent: left,
    bottom: 0,
    left: 0,
    width: "100%-2",
    height: 5,
    border: "line",
    tags: true,
    label: " command ",
    style: { border: { fg: "green" } }
  });

  const output = blessed.box({
    parent: screen,
    top: 0,
    left: "36%",
    width: "64%",
    height: "62%",
    border: "line",
    label: " Current site content ",
    tags: false,
    scrollable: true,
    alwaysScroll: true,
    mouse: true,
    keys: true,
    scrollbar: { ch: " ", inverse: true },
    style: { border: { fg: "magenta" } }
  });

  const controlsPane = blessed.box({
    wrap: false,
    parent: screen,
    top: "62%",
    left: "36%",
    width: "64%",
    height: "38%-1",
    border: "line",
    label: " Current page controls ",
    tags: false,
    ansi: true,
    scrollable: true,
    alwaysScroll: true,
    mouse: true,
    keys: true,
    scrollbar: { ch: " ", inverse: true },
    style: { border: { fg: "yellow" } }
  });
  const controlsScrollBar = blessed.box({
    parent: controlsPane,
    top: 0,
    right: 0,
    width: 1,
    height: "100%-2",
    tags: false,
    hidden: true,
    mouse: false,
    content: "",
    style: { fg: "gray", bg: "black" }
  });


  return { screen, footer, left, log, inputLine, output, controlsPane, logScrollBar, controlsScrollBar };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const ui = makeUi();

  const cleanupShotFiles = async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const dir = path.resolve(process.cwd(), ".shots");
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.map((entry) => fs.rm(path.join(dir, entry.name), { recursive: true, force: true }).catch(() => {})));
  };

  await cleanupShotFiles();

  const state = {
    options,
    pages: [],
    activeIndex: 0,
    appLogs: [],
    scroll: { controls: 0, content: 0, buttons: 0 },
    highlightedControl: null,
    imageOverlay: null,
    links: [],
    controls: [],
    showErrors: true,
    busy: false,
    mode: "controls",
    buffer: "",
    cursor: 0,
    history: [],
    historyIndex: -1
  };

  const activeTab = () => state.pages[state.activeIndex] || null;
  const activePage = () => activeTab()?.page;

  const renderFooter = () => {
    const mode = state.mode === "controls"
      ? "{green-fg}CONTROLS{/green-fg}"
      : state.mode === "content"
        ? "{magenta-fg}CONTENT{/magenta-fg}"
        : "{yellow-fg}BUTTONS{/yellow-fg}";
    ui.footer.setContent(`${mode}  Tab cycle panes | ↑/↓ fine scroll | PgUp/PgDn page scroll | Home/End top/bottom | Controls: type commands + Enter | Ctrl+N new tab | Ctrl+W close tab | Ctrl+←/→ switch tab | Ctrl+C quit`);
  };

  const renderInput = () => {
    const before = escapeBlessed(state.buffer.slice(0, state.cursor));
    const cursorChar = escapeBlessed(state.buffer[state.cursor] || " ");
    const after = escapeBlessed(state.buffer.slice(state.cursor + 1));
    const line = `browser> ${before}{inverse}${cursorChar}{/inverse}${after}`;
    ui.inputLine.setContent(`\n${line}`);
    ui.inputLine.style.border.fg = state.mode === "controls" ? "green" : "gray";
    ui.left.style.border.fg = state.mode === "controls" ? "green" : "cyan";
    ui.output.style.border.fg = state.mode === "content" ? "green" : "magenta";
    ui.controlsPane.style.border.fg = state.mode === "buttons" ? "green" : "yellow";
    renderFooter();
    ui.screen.render();
  };

  const controlsLogBottomPaddingLines = 8;
  const logLines = () => activeTab() ? activeTab().logs : state.appLogs;
  const paddedLogLines = () => {
    const lines = logLines();
    return [...(lines.length ? lines : [""]), ...Array(controlsLogBottomPaddingLines).fill("")];
  };
  const logLineCount = () => Math.max(1, paddedLogLines().length);
  const logContentLineCount = () => Math.max(1, logLines().length);
  const logMaxScroll = () => Math.max(0, logLineCount() - getPaneVisibleRows(ui.log));
  const logContentMaxScroll = () => Math.max(0, logContentLineCount() - getPaneVisibleRows(ui.log));

  const renderLeftLog = ({ preserveScroll = true } = {}) => {
    const lines = paddedLogLines();
    const previous = state.scroll.controls || 0;
    const previousMax = logMaxScroll();
    const wasAtBottom = previous >= Math.max(0, previousMax - 3);
    ui.left.setLabel(" Controls / logs / errors ");
    ui.log.setContent((lines.length ? lines : [""]).join("\n"));
    const nextMax = logMaxScroll();
    const next = preserveScroll && !wasAtBottom ? Math.min(previous, nextMax) : nextMax;
    state.scroll.controls = next;
    ui.log.setScroll(next);
    ui.log.childBase = next;
    ui.log.childOffset = next;
    paintScrollbar(ui.logScrollBar, getPaneVisibleRows(ui.log), logLineCount(), next);
    ui.screen.render();
  };

  const pushLog = (arr, text = "") => {
    arr.push(...String(text).split("\n"));
    if (arr.length > 700) arr.splice(0, arr.length - 700);
  };
  const logLeft = (text = "") => { const tab = activeTab(); pushLog(tab ? tab.logs : state.appLogs, text); renderLeftLog(); };
  const logTab = (tab, text = "") => { pushLog(tab.logs, text); if (tab === activeTab()) renderLeftLog(); };
  const setRight = (title, text = "", { keepImageOverlay = false } = {}) => {
    if (!keepImageOverlay) {
      clearCurrentImageOverlay(activeTab(), { clearTerminal: true });
    }
    ui.output.setLabel(` ${title} `);
    ui.output.setContent(String(text));
    state.scroll.content = 0;
    ui.output.setScroll(0);
    ui.screen.render();
  };
  const setControlsPane = (title, text = "", { preserveScroll = false, desiredScroll = null } = {}) => {
    const content = String(text || "");
    const lines = content.split("\n");
    const oldScroll = state.scroll.buttons || 0;
    const visibleRows = Math.max(1, getPaneVisibleRows(ui.controlsPane));
    const max = Math.max(0, Math.max(1, lines.length) - visibleRows);
    const requested = Number.isFinite(desiredScroll) ? desiredScroll : (preserveScroll ? oldScroll : 0);
    const next = Math.max(0, Math.min(max, requested));
    state.controlsPaneLines = lines;
    state.scroll.buttons = next;
    ui.controlsPane.setLabel(max > 0 ? ` ${title} ${next + 1}-${Math.min(lines.length, next + visibleRows)}/${lines.length} ` : ` ${title} `);
    ui.controlsPane.setContent(content);
    ui.controlsPane.setScroll(next);
    ui.controlsPane.childBase = next;
    ui.controlsPane.childOffset = next;
    ui.screen.render();
  };

  const appendRight = (text = "") => { const existing = ui.output.getContent(); ui.output.setContent(`${existing}${existing ? "\n" : ""}${String(text)}`); ui.screen.render(); };


  const imageOverlayMessage = (overlay) => {
    return [
      `${overlay.title}`,
      `PNG: ${overlay.file}`,
      `Captured: ${overlay.createdAt}`,
      `Mapped controls: ${overlay.controlRects?.length || 0}`,
      "Renderer: Kitty graphics protocol when available",
      "",
      "Run inside Kitty for real image rendering. Other terminals will keep the saved PNG path visible."
    ].join("\n");
  };

  const terminalHasCommand = async (name) => {
    const { spawnSync } = await import("node:child_process");
    return spawnSync("bash", ["-lc", `command -v ${name}`], { encoding: "utf8" }).status === 0;
  };

  const clearImageArea = (left, top, cols, rows) => {
    const blank = " ".repeat(Math.max(0, cols));
    for (let y = 0; y < rows; y++) {
      process.stdout.write(`\x1b[${top + y};${left}H${blank}`);
    }
  };

  function clearCurrentImageOverlay(tab = activeTab(), { clearTerminal = true } = {}) {
    const overlay = tab?.imageOverlay || state.imageOverlay;
    if (clearTerminal && overlay && ui.output.lpos) {
      try {
        // Delete Kitty graphics images, then clear the normal terminal cells too.
        process.stdout.write("\x1b_Ga=d\x1b\\");
        const { left, top, cols, rows } = imageOverlayMetrics();
        clearImageArea(left, top, cols, rows);
      } catch {}
    }
    if (tab) tab.imageOverlay = null;
    if (!tab || tab === activeTab()) state.imageOverlay = null;
    if (tab?.controls) for (const c of tab.controls) c.shotRect = null;
    for (const c of state.controls) c.shotRect = null;
  }









  const imageOverlayMetrics = () => {
    const lpos = ui.output.lpos || {};
    const left = Math.max(1, (lpos.xi || 0) + 2);
    const top = Math.max(1, (lpos.yi || 0) + 7);
    const cols = Math.max(20, (lpos.xl || 100) - (lpos.xi || 0) - 4);
    const rows = Math.max(5, (lpos.yl || 40) - (lpos.yi || 0) - 8);
    return { left, top, cols, rows, place: `${cols}x${rows}@${left - 1}x${top - 1}` };
  };

  async function getControlRectsForShot(page) {
    if (!page || !state.controls.length) return [];
    const controls = state.controls.slice(0, 220).map((c, index) => ({
      index,
      number: c.number,
      selector: c.selector,
      kind: c.kind,
      name: c.name || ""
    }));

    return await page.evaluate((items) => {
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 1;
      const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
      const area = (r) => Math.max(0, r.width) * Math.max(0, r.height);
      const priorityFor = (kind = "") => {
        if (/input|textarea|select/i.test(kind)) return 1;
        if (/button/i.test(kind)) return 2;
        if (/link|a/i.test(kind)) return 3;
        return 4;
      };
      const cssPath = (el) => {
        if (!el || el.nodeType !== 1) return "";
        const parts = [];
        let node = el;
        while (node && node.nodeType === 1 && parts.length < 6) {
          let part = node.tagName.toLowerCase();
          if (node.id) {
            part += `#${CSS.escape(node.id)}`;
            parts.unshift(part);
            break;
          }
          const cls = [...node.classList].slice(0, 2).map((c) => `.${CSS.escape(c)}`).join("");
          part += cls;
          const parent = node.parentElement;
          if (parent) {
            const siblings = [...parent.children].filter((child) => child.tagName === node.tagName);
            if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
          }
          parts.unshift(part);
          node = parent;
        }
        return parts.join(" > ");
      };
      const textOf = (el) => {
        const text = (el.innerText || el.textContent || el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") || "").replace(/\s+/g, " ").trim();
        return text.slice(0, 120);
      };

      return items.flatMap((item) => {
        let el = null;
        try { el = document.querySelector(item.selector); } catch { el = null; }
        if (!el) return [];

        const style = window.getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return [];

        const rects = [...el.getClientRects()]
          .map((rect) => {
            const x1 = clamp(rect.left, 0, viewportWidth);
            const y1 = clamp(rect.top, 0, viewportHeight);
            const x2 = clamp(rect.right, 0, viewportWidth);
            const y2 = clamp(rect.bottom, 0, viewportHeight);
            return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
          })
          .filter((rect) => rect.width > 0 && rect.height > 0)
          .sort((a, b) => area(b) - area(a));

        if (!rects.length) return [];

        return rects.slice(0, 3).map((rect, rectIndex) => {
          const centerX = rect.x + rect.width / 2;
          const centerY = rect.y + rect.height / 2;
          let topElement = null;
          try { topElement = document.elementFromPoint(centerX, centerY); } catch { topElement = null; }
          const topMatches = Boolean(topElement && (topElement === el || el.contains(topElement) || topElement.contains(el)));
          const pad = Math.max(4, Math.min(14, Math.round(Math.min(rect.width, rect.height) * 0.15)));

          return {
            number: item.number,
            index: item.index,
            rectIndex,
            selector: item.selector,
            kind: item.kind,
            name: item.name,
            text: textOf(el),
            cssPath: cssPath(el),
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            centerX,
            centerY,
            hitX: clamp(rect.x - pad, 0, viewportWidth),
            hitY: clamp(rect.y - pad, 0, viewportHeight),
            hitWidth: clamp(rect.x + rect.width + pad, 0, viewportWidth) - clamp(rect.x - pad, 0, viewportWidth),
            hitHeight: clamp(rect.y + rect.height + pad, 0, viewportHeight) - clamp(rect.y - pad, 0, viewportHeight),
            priority: priorityFor(item.kind),
            topMatches,
            viewportWidth,
            viewportHeight
          };
        });
      });
    }, controls).catch(() => []);
  }

  const shotImagePlacement = (overlay, metrics = imageOverlayMetrics()) => {
    const imageWidth = overlay?.imageWidth || overlay?.viewportWidth || overlay?.controlRects?.[0]?.viewportWidth || activePage()?.viewportSize?.()?.width || 1;
    const imageHeight = overlay?.imageHeight || overlay?.viewportHeight || overlay?.controlRects?.[0]?.viewportHeight || activePage()?.viewportSize?.()?.height || 1;
    const viewportWidth = overlay?.viewportWidth || imageWidth;
    const viewportHeight = overlay?.viewportHeight || imageHeight;
    const cellWidth = overlay?.terminalGeometry?.cellWidth || 1;
    const cellHeight = overlay?.terminalGeometry?.cellHeight || 2;

    // Kitty scales the image inside a cell rectangle using the physical pixel size of cells.
    // Compute the exact cell rectangle that preserves the image aspect ratio inside our pane.
    const imageAspect = imageWidth / Math.max(1, imageHeight);
    const placePixelWidth = metrics.cols * cellWidth;
    const placePixelHeight = metrics.rows * cellHeight;
    const placeAspect = placePixelWidth / Math.max(1, placePixelHeight);

    let cols = metrics.cols;
    let rows = metrics.rows;
    const left = metrics.left;
    const top = metrics.top;

    if (imageAspect > placeAspect) {
      cols = metrics.cols;
      rows = Math.max(1, Math.min(metrics.rows, Math.round((cols * cellWidth / imageAspect) / cellHeight)));
    } else {
      rows = metrics.rows;
      cols = Math.max(1, Math.min(metrics.cols, Math.round((rows * cellHeight * imageAspect) / cellWidth)));
    }

    return { left, top, cols, rows, imageWidth, imageHeight, viewportWidth, viewportHeight, cellWidth, cellHeight };
  };

  const rectToShotCells = (rect, overlay, metrics = imageOverlayMetrics()) => {
    const placement = shotImagePlacement(overlay, metrics);
    const x1 = placement.left + (rect.x / placement.viewportWidth) * placement.cols;
    const y1 = placement.top + (rect.y / placement.viewportHeight) * placement.rows;
    const x2 = placement.left + ((rect.x + rect.width) / placement.viewportWidth) * placement.cols;
    const y2 = placement.top + ((rect.y + rect.height) / placement.viewportHeight) * placement.rows;

    const absCol = Math.floor(x1);
    const absRow = Math.floor(y1);
    const absRight = Math.max(absCol + 1, Math.ceil(x2));
    const absBottom = Math.max(absRow + 1, Math.ceil(y2));

    return {
      absCol,
      absRow,
      absRight,
      absBottom,
      col: absCol - metrics.left,
      row: absRow - metrics.top,
      cols: Math.max(1, absRight - absCol),
      rows: Math.max(1, absBottom - absRow)
    };
  };

  const applyShotRectsToControls = (rects = [], overlay = activeTab()?.imageOverlay || state.imageOverlay) => {
    const bestByNumber = new Map();
    for (const rect of rects) {
      const prev = bestByNumber.get(rect.number);
      const rectArea = rect.width * rect.height;
      const prevArea = prev ? prev.width * prev.height : -1;
      if (!prev || rect.topMatches || rectArea > prevArea) bestByNumber.set(rect.number, rect);
    }

    const annotate = (control) => {
      const rect = bestByNumber.get(control.number) || null;
      control.shotRect = rect;
      control.shotCellBox = rect && overlay ? rectToShotCells(rect, overlay) : null;
    };

    for (const c of state.controls) annotate(c);
    const tab = activeTab();
    if (tab?.controls) for (const c of tab.controls) annotate(c);
  };

  const shotCoordsFromMouse = (data = {}) => {
    const overlay = activeTab()?.imageOverlay || state.imageOverlay;
    if (!overlay || !ui.output.lpos) return null;
    const metrics = imageOverlayMetrics();
    const placement = shotImagePlacement(overlay, metrics);
    const x = data.x;
    const y = data.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (x < placement.left || y < placement.top || x >= placement.left + placement.cols || y >= placement.top + placement.rows) return null;

    const imageCol = x - placement.left;
    const clickImageRow = y - placement.top;
    const imageRow = clickImageRow + shotHoverYOffsetCells;

    // Terminal mouse events are cell-based, not pixel-based. Track the full page-coordinate
    // range represented by the current terminal cell so tiny controls can still be hit.
    // pageX/pageY remain the real click coordinates. pageYMin/pageYMax are hover-hit ranges.
    const pageXMin = Math.max(0, Math.min(placement.imageWidth, (imageCol / Math.max(1, placement.cols)) * placement.imageWidth));
    const pageXMax = Math.max(0, Math.min(placement.imageWidth, ((imageCol + 1) / Math.max(1, placement.cols)) * placement.imageWidth));
    const pageYMin = Math.max(0, Math.min(placement.imageHeight, (imageRow / Math.max(1, placement.rows)) * placement.imageHeight));
    const pageYMax = Math.max(0, Math.min(placement.imageHeight, ((imageRow + 1) / Math.max(1, placement.rows)) * placement.imageHeight));
    const clickPageYMin = Math.max(0, Math.min(placement.imageHeight, (clickImageRow / Math.max(1, placement.rows)) * placement.imageHeight));
    const clickPageYMax = Math.max(0, Math.min(placement.imageHeight, ((clickImageRow + 1) / Math.max(1, placement.rows)) * placement.imageHeight));
    const pageX = (pageXMin + pageXMax) / 2;
    const pageY = (clickPageYMin + clickPageYMax) / 2;

    return {
      terminalX: x,
      terminalY: y,
      imageCol,
      clickImageRow,
      imageRow,
      pageX,
      pageY,
      pageXMin,
      pageXMax,
      pageYMin,
      pageYMax,
      viewportWidth: placement.viewportWidth,
      viewportHeight: placement.viewportHeight,
      metrics,
      placement
    };
  };

  const rangesOverlap = (a1, a2, b1, b2) => a1 <= b2 && a2 >= b1;

  const controlHitFromShotCoords = (coords) => {
    const overlay = activeTab()?.imageOverlay || state.imageOverlay;
    if (!coords || !overlay?.controlRects?.length) return null;

    let best = null;
    for (const rect of overlay.controlRects) {
      const cellBox = rectToShotCells(rect, overlay, coords.metrics);
      const cellHit = coords.terminalX >= cellBox.absCol
        && coords.terminalX < cellBox.absRight
        && coords.terminalY >= cellBox.absRow
        && coords.terminalY < cellBox.absBottom;

      const pageRangeHit = rangesOverlap(coords.pageXMin, coords.pageXMax, rect.x, rect.x + rect.width)
        && rangesOverlap(coords.pageYMin, coords.pageYMax, rect.y, rect.y + rect.height);

      const paddedRangeHit = rangesOverlap(coords.pageXMin, coords.pageXMax, rect.hitX, rect.hitX + rect.hitWidth)
        && rangesOverlap(coords.pageYMin, coords.pageYMax, rect.hitY, rect.hitY + rect.hitHeight);

      if (!cellHit && !pageRangeHit && !paddedRangeHit) continue;

      const area = rect.width * rect.height;
      const centerDistance = Math.hypot(coords.pageX - rect.centerX, coords.pageY - rect.centerY);
      const score = (cellHit ? 0 : pageRangeHit ? 10000 : 25000)
        + (rect.topMatches ? 0 : 4000)
        + (rect.priority * 1000)
        + Math.min(area, 50000) * 0.01
        + centerDistance;

      if (!best || score < best.score) best = { ...rect, score, cellHit, pageRangeHit, paddedRangeHit, cellBox };
    }

    return best;
  };

  const controlFromShotHover = (data = {}) => controlHitFromShotCoords(shotCoordsFromMouse(data))?.number || null;

  const scrollButtonsPaneToControl = (number) => {
    const index = state.controls.findIndex((c) => c.number === number);
    if (index < 0) return;
    const cardHeight = 4;
    const visibleRows = getPaneVisibleRows(ui.controlsPane);
    const current = currentPaneScroll(ui.controlsPane, state.scroll.buttons || 0);
    const cardTop = index * cardHeight;
    const cardBottom = cardTop + 2;
    let next = current;

    if (cardTop < current) next = cardTop;
    else if (cardBottom >= current + visibleRows) next = cardBottom - visibleRows + 1;

    state.scroll.buttons = Math.max(0, Math.min(controlsPaneMaxScroll(), next));
  };

  const setShotHoverLabel = (coords, hit = null) => {
    const x = Math.round(coords.pageX);
    const y = Math.round(coords.pageY);
    const xr = `${Math.floor(coords.pageXMin)}-${Math.ceil(coords.pageXMax)}`;
    const yr = `${Math.floor(coords.pageYMin)}-${Math.ceil(coords.pageYMax)}`;
    const hitText = hit ? ` | hit #${hit.number} ${hit.kind}${hit.name ? ` ${short(hit.name, 40)}` : ""}` : " | no hit";
    const label = ` Current site content | cell ${coords.imageCol},${coords.imageRow} | xy≈${x},${y} range x:${xr} y:${yr} img:${Math.round(coords.placement.imageWidth)}x${Math.round(coords.placement.imageHeight)}${hitText} `;
    if (ui.output.getLabel?.() !== label) ui.output.setLabel(label);
  };

  const clearShotHoverHighlight = () => {
    const tab = activeTab();
    if (!tab || !tab.highlightedControl) return;
    state.highlightedControl = null;
    tab.highlightedControl = null;
    renderControlsPane({ preserveScroll: true });
  };

  const highlightControlFromShotNumber = (number, { scrollIntoView = true } = {}) => {
    const tab = activeTab();
    if (!number || !tab) return;
    if (scrollIntoView) scrollButtonsPaneToControl(number);
    state.highlightedControl = number;
    tab.highlightedControl = number;
    renderControlsPane({ preserveScroll: true });
  };


  async function renderImageOverlay() {
    const overlay = activeTab()?.imageOverlay || state.imageOverlay;
    if (!overlay?.file || !ui.output.lpos) return;

    const { spawnSync } = await import("node:child_process");
    const metrics = imageOverlayMetrics();
    const placement = shotImagePlacement(overlay, metrics);
    clearImageArea(metrics.left, metrics.top, metrics.cols, metrics.rows);
    const place = `${placement.cols}x${placement.rows}@${placement.left - 1}x${placement.top - 1}`;

    const supportsKittyGraphics = Boolean(process.env.KITTY_WINDOW_ID || /kitty/i.test(process.env.TERM || ""));
    if (supportsKittyGraphics && await terminalHasCommand("kitten")) {
      const result = spawnSync("kitten", ["icat", "--transfer-mode=file", "--align", "left", "--scale-up", "--place", place, overlay.file], {
        stdio: "inherit",
        env: { ...process.env, COLORTERM: process.env.COLORTERM || "truecolor" }
      });
      if (result.status === 0) return;
    }

    // Intentionally no ANSI/Braille fallback. If the terminal cannot draw real images,
    // leave the screenshot metadata and saved PNG path visible in the pane.
  }

  async function showContext(selector = "body") {
    const page = activePage();
    if (!page) return;
    const data = await getContext(page, selector);
    const lines = [
      data.title,
      data.url,
      `ready: ${data.readyState}`,
      "",
      data.textPreview || "(no visible text)"
    ];
    setRight("Current site content / context", lines.join("\n"));
  }

  const controlsPaneContentWidth = () => {
    const lpos = ui.controlsPane.lpos || {};
    const raw = ((lpos.xl ?? 100) - (lpos.xi ?? 0) - 4);
    return Math.max(24, raw);
  };

  const fitControlLine = (value, width = controlsPaneContentWidth()) => {
    const text = stripAnsi(String(value || "").replace(/\s+/g, " ").trim());
    if (text.length <= width) return text;
    return `${text.slice(0, Math.max(1, width - 1))}…`;
  };

  function renderControlsPane({ preserveScroll = false } = {}) {
    const highlighted = activeTab()?.highlightedControl || state.highlightedControl;
    const width = controlsPaneContentWidth();
    setControlsPane(
      "Current page buttons / inputs",
      state.controls.length
        ? state.controls.map((c) => {
            const isHot = c.number === highlighted;
            const prefix = isHot ? "▶ " : "  ";
            const line1 = fitControlLine(`${prefix}${c.number}. ${c.kind} | name: ${short(c.name || "unlabeled control", 100)}`, width);
            const rectInfo = c.shotRect
              ? `page: ${Math.round(c.shotRect.x)},${Math.round(c.shotRect.y)} ${Math.round(c.shotRect.width)}x${Math.round(c.shotRect.height)}`
              : "page: unmapped";
            const cellInfo = c.shotCellBox
              ? `screen: ${c.shotCellBox.col},${c.shotCellBox.row} ${c.shotCellBox.cols}x${c.shotCellBox.rows}`
              : "screen: unmapped";
            const line2 = fitControlLine(`   ${rectInfo} | ${cellInfo} | selector: ${c.selector}`, width);
            const line3 = fitControlLine(`   command: ${c.command}`, width);
            const blockLines = [line1, line2, line3];
            return isHot
              ? blockLines.map((line) => `\x1b[38;2;255;255;170m\x1b[48;2;75;75;35m${line}\x1b[0m`).join("\n")
              : blockLines.join("\n");
          }).join("\n\n")
        : "No visible clickable controls or typing fields found.",
      { preserveScroll }
    );
  }

  async function showControls(filter = "") {
    const page = activePage();
    const tab = activeTab();
    if (!page || !tab) return;
    state.controls = await getControls(page, filter);
    tab.controls = state.controls;
    if (tab.highlightedControl && !state.controls.some((c) => c.number === tab.highlightedControl)) tab.highlightedControl = null;
    renderControlsPane();
    logLeft(`Controls pane refreshed: ${state.controls.length} visible controls found.`);
  }

  const looksLikeExplicitTarget = (value = "") => {
    const text = String(value || "").trim();
    if (!text) return false;
    if (/^\d+$/.test(text)) return true;
    if (/^[#.[>:*]/.test(text)) return true;
    if (/^(input|textarea|select|button|a|form|\[)/i.test(text)) return true;
    return false;
  };

  const normalizePageKeyShortcut = (command = "") => {
    const raw = String(command || "").toLowerCase().trim();
    const alias = {
      typeenter: "Enter",
      typereturn: "Enter",
      typetab: "Tab",
      typeesc: "Escape",
      typeescape: "Escape",
      typespace: "Space",
      typebackspace: "Backspace",
      typebksp: "Backspace",
      typedelete: "Delete",
      typedel: "Delete",
      typehome: "Home",
      typeend: "End",
      typepageup: "PageUp",
      typepgup: "PageUp",
      typepagedown: "PageDown",
      typepgdn: "PageDown",
      typeup: "ArrowUp",
      typedown: "ArrowDown",
      typeleft: "ArrowLeft",
      typeright: "ArrowRight",
      typearrowup: "ArrowUp",
      typearrowdown: "ArrowDown",
      typearrowleft: "ArrowLeft",
      typearrowright: "ArrowRight"
    };
    if (alias[raw]) return alias[raw];
    const fn = raw.match(/^typef([1-9]|1[0-2])$/);
    if (fn) return `F${fn[1]}`;
    return null;
  };

  async function pressPageKey(page, key) {
    if (!key) throw new Error("Usage: press <key> OR typeenter/typef6/typetab/etc.");
    await page.keyboard.press(key);
    logLeft(`Pressed page key ${key}.`);
  }

  async function scrollPageCommand(page, raw = "") {
    const input = String(raw || "").trim();
    const [first = "down", second = ""] = input.split(/\s+/);
    const direction = first.toLowerCase();
    const numeric = Number(first);
    const amountArg = Number(second);
    const viewport = page.viewportSize() || await page.evaluate(() => ({ width: window.innerWidth || 1200, height: window.innerHeight || 800 }));
    const defaultY = Math.max(240, Math.round((viewport.height || 800) * 0.75));
    const defaultX = Math.max(240, Math.round((viewport.width || 1200) * 0.75));
    let dx = 0;
    let dy = defaultY;
    let description = `down ${defaultY}px`;

    if (Number.isFinite(numeric) && first !== "") {
      dy = numeric;
      description = `${dy}px`;
    } else if (["down", "d", "next"].includes(direction)) {
      dy = Number.isFinite(amountArg) ? Math.abs(amountArg) : defaultY;
      description = `down ${dy}px`;
    } else if (["up", "u", "prev", "previous"].includes(direction)) {
      dy = -(Number.isFinite(amountArg) ? Math.abs(amountArg) : defaultY);
      description = `up ${Math.abs(dy)}px`;
    } else if (["left", "l"].includes(direction)) {
      dx = -(Number.isFinite(amountArg) ? Math.abs(amountArg) : defaultX);
      dy = 0;
      description = `left ${Math.abs(dx)}px`;
    } else if (["right", "r"].includes(direction)) {
      dx = Number.isFinite(amountArg) ? Math.abs(amountArg) : defaultX;
      dy = 0;
      description = `right ${dx}px`;
    } else if (["top", "start", "home"].includes(direction)) {
      const pos = await page.evaluate(() => {
        window.scrollTo({ top: 0, left: window.scrollX || 0, behavior: "instant" });
        return { x: window.scrollX || 0, y: window.scrollY || 0 };
      });
      await page.waitForTimeout(120);
      logLeft(`Scrolled page to top (${Math.round(pos.x)}, ${Math.round(pos.y)}).`);
      return;
    } else if (["bottom", "end"].includes(direction)) {
      const pos = await page.evaluate(() => {
        window.scrollTo({
          top: Math.max(document.documentElement.scrollHeight || 0, document.body?.scrollHeight || 0),
          left: window.scrollX || 0,
          behavior: "instant"
        });
        return { x: window.scrollX || 0, y: window.scrollY || 0 };
      });
      await page.waitForTimeout(120);
      logLeft(`Scrolled page to bottom (${Math.round(pos.x)}, ${Math.round(pos.y)}).`);
      return;
    } else {
      throw new Error("Usage: scroll [down|up|top|bottom|left|right|amount], scrollup [amount], scrolldown [amount]");
    }

    const pos = await page.evaluate(({ dx, dy }) => {
      window.scrollBy({ left: dx, top: dy, behavior: "instant" });
      return {
        x: window.scrollX || 0,
        y: window.scrollY || 0,
        maxY: Math.max(0, (document.documentElement.scrollHeight || document.body?.scrollHeight || 0) - window.innerHeight),
        maxX: Math.max(0, (document.documentElement.scrollWidth || document.body?.scrollWidth || 0) - window.innerWidth)
      };
    }, { dx, dy });
    await page.waitForTimeout(120);
    logLeft(`Scrolled page ${description}. Position ${Math.round(pos.x)},${Math.round(pos.y)} of ${Math.round(pos.maxX)},${Math.round(pos.maxY)}.`);
  }

  async function hoverAtViewportPoint(page, x, y, label = "clicked point") {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    await page.mouse.move(x, y);
    logLeft(`Mouse hovering at ${label} (${Math.round(x)}, ${Math.round(y)}).`);
    return true;
  }


  async function clickHoverPointForTarget(page, raw) {
    const text = String(raw || "").trim();
    if (!text) return null;

    let selector = text;
    if (/^\d+$/.test(text)) {
      const number = Number(text);
      const control = state.controls?.find?.((item) => Number(item.number) === number);
      selector = control?.selector || selector;
    }

    // Direct selector / numbered control.
    try {
      const box = await page.locator(selector).first().boundingBox({ timeout: 500 }).catch(() => null);
      if (box) return { x: box.x + box.width / 2, y: box.y + box.height / 2, label: `clicked ${text}` };
    } catch {}

    // Text fallback, matching what clickTarget can click by visible text.
    const point = await page.evaluate((needle) => {
      const wanted = String(needle || "").toLowerCase().trim();
      if (!wanted) return null;
      const candidates = [...document.querySelectorAll('button, a, input, textarea, select, [role="button"], [onclick], [tabindex]')];
      for (const el of candidates) {
        const style = window.getComputedStyle(el);
        if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) === 0) continue;
        const label = [
          el.innerText,
          el.textContent,
          el.value,
          el.getAttribute('aria-label'),
          el.getAttribute('title'),
          el.getAttribute('placeholder'),
          el.getAttribute('name')
        ].filter(Boolean).join(' ').toLowerCase();
        if (!label.includes(wanted)) continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      return null;
    }, text).catch(() => null);
    return point ? { ...point, label: `clicked ${text}` } : null;
  }

  async function hoverTargetCenter(page, raw, label = "clicked target") {
    const text = String(raw || "").trim();
    if (!text) return false;
    let selector = text;
    if (/^\d+$/.test(text)) {
      const number = Number(text);
      const control = state.controls?.find?.((item) => Number(item.number) === number);
      selector = control?.selector || selector;
    }
    const locator = page.locator(selector).first();
    const box = await locator.boundingBox().catch(() => null);
    if (!box) return false;
    await hoverAtViewportPoint(page, box.x + box.width / 2, box.y + box.height / 2, label);
    return true;
  }

  async function typeFocusedText(page, text, { pressEnter = false } = {}) {
    if (!String(text || "").length) throw new Error("Usage: type <text> or typehere <text>");
    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return { ok: false, reason: "no active element" };
      const tag = (el.tagName || "").toLowerCase();
      const editable = Boolean(el.isContentEditable || tag === "input" || tag === "textarea" || tag === "select");
      return {
        ok: editable,
        tag,
        type: el.getAttribute("type") || "",
        name: el.getAttribute("name") || "",
        id: el.id || "",
        placeholder: el.getAttribute("placeholder") || "",
        reason: editable ? "" : `focused element is ${tag || "unknown"}, not editable`
      };
    });
    if (!focused.ok) {
      throw new Error(`No focused editable field. Click an input in the screenshot or run hover/click on an input first. (${focused.reason})`);
    }
    await page.keyboard.type(String(text));
    if (pressEnter) await page.keyboard.press("Enter");
    logLeft(`Typed into focused ${focused.tag}${focused.id ? `#${focused.id}` : ""}${focused.name ? `[name=${focused.name}]` : ""}.`);
  }

  async function highlightControl(raw, { hoverPage = true } = {}) {
    const page = activePage();
    const tab = activeTab();
    const control = byNumber(raw, state.controls);
    if (!page || !tab || !control) throw new Error("Run buttons first, then hover/highlight a visible control number.");
    state.highlightedControl = control.number;
    tab.highlightedControl = control.number;
    renderControlsPane({ preserveScroll: true });
    if (hoverPage) await page.locator(control.selector).first().hover({ timeout: 2500 }).catch(() => {});
    logLeft(`Highlighted control ${control.number}: ${control.name || control.kind}`);
  }

  function setupPage(page, tab) {
    const pushTabLog = (line) => {
      const value = String(line || "").replace(/\s+/g, " ").trim();
      if (!value) return;
      tab.logs.push(value);
      if (tab.logs.length > 250) tab.logs.splice(0, tab.logs.length - 250);
      if (activeTab() === tab) renderLeftLog();
    };

    page.on("console", (message) => {
      const type = message.type();
      const text = message.text();
      pushTabLog(`[console:${type}] ${text}`);
    });

    page.on("pageerror", (error) => {
      pushTabLog(`[pageerror] ${error.message}`);
    });

    page.on("requestfailed", (request) => {
      pushTabLog(`[requestfailed] ${request.method()} ${request.url()} — ${request.failure()?.errorText || "failed"}`);
    });

    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        clearCurrentImageOverlay(tab, { clearTerminal: activeTab() === tab });
        pushTabLog(`[nav] ${frame.url()}`);
      }
    });

    page.on("dialog", async (dialog) => {
      pushTabLog(`[dialog:${dialog.type()}] ${dialog.message()}`);
      await dialog.dismiss().catch(() => {});
    });
  }

  async function makePage(url = null) {
    const page = await context.newPage();
    const tab = { page, logs: [], links: [], controls: [], highlightedControl: null, imageOverlay: null };
    setupPage(page, tab);
    state.pages.push(tab);
    state.activeIndex = state.pages.length - 1;
    if (url) await gotoPage(url);
    else {
      setRight("Current site content", "New blank tab.");
      logLeft(`Created tab ${state.activeIndex + 1}.`);
    }
    return page;
  }

  async function gotoPage(url) {
    const page = activePage();
    const response = await page.goto(normalizeUrl(url), { waitUntil: options.waitUntil });
    const status = response ? `${response.status()} ${response.statusText()}` : "no main response";
    logLeft(`${await pageSummary(page)} [${status}]`);
    await showContext();
    await showControls();
  }

  async function refreshTabLabels() {
    const rows = [];
    for (let index = 0; index < state.pages.length; index++) {
      const tab = state.pages[index];
      const page = tab.page;
      const active = index === state.activeIndex;
      const title = await page.title().catch(() => "");
      const url = page.url();
      rows.push([
        `${active ? "*" : " "} ${index + 1}. ${short(title || "(untitled)", 90)}`,
        `   ${url}`,
        `   command: tab ${index + 1}${state.pages.length > 1 ? ` | closetab ${index + 1}` : ""}`
      ].join("\n"));
    }
    setRight("Tabs", rows.join("\n\n") || "No tabs.");
    logLeft(`Listed ${state.pages.length} tab${state.pages.length === 1 ? "" : "s"}.`);
  }

  async function switchTab(index) {
    if (index < 0 || index >= state.pages.length) throw new Error("No tab with that number.");
    state.activeIndex = index;
    state.links = activeTab().links || [];
    state.controls = activeTab().controls || [];
    state.highlightedControl = activeTab().highlightedControl || null;
    state.imageOverlay = activeTab().imageOverlay || null;
    renderLeftLog();
    logLeft(`Switched to tab ${index + 1}.`);
    await showContext();
    await showControls();
  }

  async function closeTab(index = state.activeIndex) {
    if (state.pages.length <= 1) throw new Error("Cannot close the last tab.");
    const [tab] = state.pages.splice(index, 1);
    await tab.page.close();
    state.activeIndex = Math.min(state.activeIndex, state.pages.length - 1);
    logLeft(`Closed tab ${index + 1}.`);
    await showContext();
  }

  async function runCommand(line) {
    const page = activePage();
    const [command, ...args] = splitCommand(line);
    const rest = line.trim().slice((command || "").length).trim();
    if (!command) return;

    if (command === "help" || command === "?") {
      logLeft(HELP.trim());
    } else if (["exit", "quit", ":q"].includes(command)) {
      await context.close();
      if (!options.userDataDir) await browserOrContext.close();
      process.exit(0);
    } else if (command === "clear") {
      setRight("Current site content", "");
    } else if (command === "errors") {
      if (!["on", "off"].includes(args[0])) throw new Error("Usage: errors on|off");
      state.showErrors = args[0] === "on";
      logLeft(`Errors are now ${state.showErrors ? "on" : "off"}.`);
    } else if (command === "newtab") {
      await makePage(rest || null);
    } else if (command === "tabs") {
      await refreshTabLabels();
    } else if (command === "tab") {
      const number = Number(args[0]);
      if (!Number.isInteger(number)) throw new Error("Usage: tab <number>");
      await switchTab(number - 1);
    } else if (command === "nexttab") {
      await switchTab((state.activeIndex + 1) % state.pages.length);
    } else if (command === "prevtab") {
      await switchTab((state.activeIndex - 1 + state.pages.length) % state.pages.length);
    } else if (command === "closetab") {
      const number = args[0] ? Number(args[0]) : state.activeIndex + 1;
      if (!Number.isInteger(number)) throw new Error("Usage: closetab [number]");
      await closeTab(number - 1);
    } else if (command === "goto" || command === "go") {
      await gotoPage(rest);
    } else if (command === "url") {
      logLeft(await pageSummary(page));
    } else if (command === "title") {
      logLeft(await page.title());
    } else if (command === "ready") {
      logLeft(await page.evaluate(() => document.readyState));
    } else if (command === "status") {
      logLeft(inspect(await getStatus(page), { colors: false, depth: 6 }));
    } else if (command === "reload") {
      await page.reload({ waitUntil: options.waitUntil });
      logLeft(await pageSummary(page));
      await showContext();
      await showControls();
    } else if (command === "back") {
      await page.goBack({ waitUntil: options.waitUntil });
      logLeft(await pageSummary(page));
      await showContext();
      await showControls();
    } else if (command === "forward") {
      await page.goForward({ waitUntil: options.waitUntil });
      logLeft(await pageSummary(page));
      await showContext();
      await showControls();
    } else if (command === "waitload" || command === "waitnetwork") {
      const waitUntil = rest || "networkidle";
      if (!["domcontentloaded", "load", "networkidle"].includes(waitUntil)) throw new Error("waitload must be domcontentloaded, load, or networkidle");
      await page.waitForLoadState(waitUntil);
      await page.waitForTimeout(500);
      logLeft(`Reached ${waitUntil}. ${await pageSummary(page)}`);
      await showContext();
      await showControls();
    } else if (command === "scroll" || command === "wheel") {
      await scrollPageCommand(page, rest || "down");
      await showContext();
      await showControls();
    } else if (command === "scrollup" || command === "wheelup") {
      await scrollPageCommand(page, `up ${rest || ""}`.trim());
      await showContext();
      await showControls();
    } else if (command === "scrolldown" || command === "wheeldown") {
      await scrollPageCommand(page, `down ${rest || ""}`.trim());
      await showContext();
      await showControls();
    } else if (command === "context" || command === "ctx") {
      await showContext(rest || "body");
      await showControls();
    } else if (command === "text") {
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      setRight("Current site text", trimOutput(await page.locator(rest || "body").first().innerText()));
    } else if (command === "links") {
      state.links = await getLinks(page, rest);
      activeTab().links = state.links;
      setRight("Current site links", state.links.length ? state.links.slice(0, 150).map((link) => `${link.number}. ${short(link.text || "(no text)", 90)} -> ${link.href}\n   command: open ${link.number}`).join("\n") : "No visible links found.");
    } else if (command === "buttons" || command === "controls" || command === "inputs") {
      const controlFilter = rest || (command === "buttons" ? "button" : command === "inputs" ? "input" : "");
      await showControls(controlFilter);
    } else if (command === "open") {
      const link = byNumber(args[0], state.links);
      if (!link?.href) throw new Error("Run links first, then open a link number.");
      await gotoPage(link.href);
    } else if (command === "clickxy" || command === "xyclick") {
      const x = Number(args[0]);
      const y = Number(args[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        setRight("Coordinate click", "Usage: clickxy <x> <y>\nUse the xy shown while hovering over a shot.");
      } else {
        clearCurrentImageOverlay(activeTab(), { clearTerminal: true });
        await page.mouse.click(x, y);
        logLeft(`Clicked page coordinates ${Math.round(x)},${Math.round(y)}`);
        await page.waitForLoadState("domcontentloaded", { timeout: 1500 }).catch(() => {});
        await showContext();
      }
    } else if (command === "click") {
      if (!rest) throw new Error("Usage: click <number-or-selector-or-text>");
      const clickedHoverPoint = await clickHoverPointForTarget(page, rest).catch(() => null);
      await clickTarget(page, state, rest);
      logLeft(`Clicked ${rest}.`);
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForTimeout(250);
      if (clickedHoverPoint) await hoverAtViewportPoint(page, clickedHoverPoint.x, clickedHoverPoint.y, clickedHoverPoint.label).catch(() => false);
      await showContext();
      await showControls();
    } else if (command === "hover" || command === "highlight") {
      if (!args[0]) throw new Error("Usage: hover <control-number>");
      await highlightControl(args[0]);
    } else if (normalizePageKeyShortcut(command) && !rest) {
      await pressPageKey(page, normalizePageKeyShortcut(command));
    } else if (command === "typehere" || command === "write" || command === "focusedtype") {
      await typeFocusedText(page, rest, { pressEnter: false });
    } else if (command === "typeenter" || command === "typesubmit" || command === "submit") {
      const [target, ...words] = args;
      if (!target) {
        await pressPageKey(page, "Enter");
        return;
      }
      if (!words.length || !looksLikeExplicitTarget(target)) {
        await typeFocusedText(page, rest, { pressEnter: true });
      } else {
        await typeInto(page, state, target, words.join(" "));
        await page.keyboard.press("Enter");
        logLeft(`Typed into ${target} and pressed Enter.`);
      }
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForTimeout(250);
      await showContext();
      await showControls();
    } else if (command === "enter" || command === "return") {
      if (args[0]) {
        const control = byNumber(args[0], state.controls);
        const selector = control?.selector || args[0];
        await page.locator(selector).first().click({ timeout: 2500 }).catch(() => {});
      }
      await page.keyboard.press("Enter");
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForTimeout(250);
      logLeft("Pressed Enter.");
      await showContext();
      await showControls();
    } else if (command === "type" || command === "fill") {
      const [target, ...words] = args;
      if (!target) throw new Error("Usage: type <selector-or-number> <text> OR type <text>");
      if (!words.length || !looksLikeExplicitTarget(target)) {
        await typeFocusedText(page, rest, { pressEnter: false });
      } else {
        await typeInto(page, state, target, words.join(" "));
        logLeft(`Typed into ${target}.`);
      }
    } else if (command === "press" || command === "key") {
      if (!rest) throw new Error("Usage: press <key> OR key <key>");
      await page.keyboard.press(rest);
      logLeft(`Pressed ${rest}.`);
    } else if (command === "wait") {
      if (!rest) throw new Error("Usage: wait <ms-or-selector>");
      const ms = Number(rest);
      if (Number.isFinite(ms)) await page.waitForTimeout(ms);
      else await page.locator(rest).first().waitFor();
      logLeft(`Waited for ${rest}.`);
    } else if (command === "screenshot") {
      const path = rest || "screenshot.png";
      await page.screenshot({ path, fullPage: true });
      logLeft(`Saved ${path}`);
    } else if (command === "shot" || command === "image" || command === "viewshot") {
      clearCurrentImageOverlay(activeTab(), { clearTerminal: true });
      const overlay = await terminalImageRender(page, rest || "viewport", { renderMode: "graphics" });
      const rects = overlay.captureMode === "viewport" ? await getControlRectsForShot(page) : [];
      overlay.controlRects = rects;
      overlay.viewportWidth = rects[0]?.viewportWidth || overlay.viewportWidth || page.viewportSize()?.width || null;
      overlay.viewportHeight = rects[0]?.viewportHeight || overlay.viewportHeight || page.viewportSize()?.height || null;
      state.imageOverlay = overlay;
      activeTab().imageOverlay = overlay;
      applyShotRectsToControls(rects, overlay);
      renderControlsPane({ preserveScroll: true });
      setRight("Current tab screenshot", imageOverlayMessage(overlay), { keepImageOverlay: true });
    } else if (command === "render" || command === "dom") {
      setRight("Current tab terminal HTML render", await terminalHtmlRender(page, rest || "body"));
    } else if (command === "ascii") {
      setRight("Current tab screenshot ASCII", await screenshotAscii(page, Number(args[0]) || 90));
    } else if (command === "eval" || command === "js") {
      if (!rest) throw new Error("Usage: eval <javascript-expression>");
      const result = await page.evaluate(`(() => (${rest}))()`);
      logLeft(inspect(result, { colors: false, depth: 4 }));
    } else if (command === "search") {
      if (!rest) throw new Error("Usage: search <query>");
      const results = await fetchSearchResults(rest, { limit: 10 });
      state.links = results.map((item) => ({ number: item.number, text: item.text, href: item.href }));
      activeTab().links = state.links;
      setRight("Search results", formatSearchResults(rest, results));
      logLeft(`Fetched ${results.length} search result${results.length === 1 ? "" : "s"}. Use open <number> to open one.`);
    } else if (command === "find" || command === "pagefind") {
      if (!rest) throw new Error("Usage: find <query>");
      const query = rest.toLowerCase();
      const matches = await page.evaluate((needle) => {
        const text = document.body?.innerText || "";
        return text
          .split("\n")
          .map((item) => item.trim())
          .filter(Boolean)
          .filter((item) => item.toLowerCase().includes(needle))
          .slice(0, 100);
      }, query);
      setRight("Current page find results", matches.join("\n") || "No matches.");
    } else {
      logLeft(`Unknown command: ${command}. Type help for commands.`);
    }
  }

  async function runLine(line) {
    // runLine-clears-shot-overlay
    const firstCommand = String(line || "").trim().split(/\s+/)[0]?.toLowerCase();
    const keepsShotOverlay = new Set(["shot", "image", "viewshot"]).has(firstCommand);
    if (firstCommand && !keepsShotOverlay) clearCurrentImageOverlay(activeTab(), { clearTerminal: true });
    if (state.busy) {
      logLeft("Still running. Wait for the current command to finish.");
      return;
    }
    state.busy = true;
    state.history.push(line);
    state.historyIndex = -1;
    logLeft(`> ${line}`);
    try {
      for (const command of splitCommandChain(line)) {
        logLeft(`$ ${command}`);
        await runCommand(command);
      }
    } catch (error) {
      logLeft(`Error: ${error.message}`);
    } finally {
      state.busy = false;
      renderInput();
      await renderImageOverlay().catch((error) => logLeft(`Image overlay error: ${error.message}`));
    }
  }

  function submitBuffer() {
    const line = state.buffer.trim();
    state.buffer = "";
    state.cursor = 0;
    renderInput();
    if (line) void runLine(line);
  }

  function editInput(ch, key = {}) {
    if (key.name === "left") state.cursor = Math.max(0, state.cursor - 1);
    else if (key.name === "right") state.cursor = Math.min(state.buffer.length, state.cursor + 1);
    else if (key.name === "home") state.cursor = 0;
    else if (key.name === "end") state.cursor = state.buffer.length;
    else if (key.name === "backspace") {
      if (state.cursor > 0) {
        state.buffer = state.buffer.slice(0, state.cursor - 1) + state.buffer.slice(state.cursor);
        state.cursor--;
      }
    } else if (key.name === "delete") {
      state.buffer = state.buffer.slice(0, state.cursor) + state.buffer.slice(state.cursor + 1);
    } else if (key.name === "up") {
      if (state.history.length) {
        if (state.historyIndex < 0) state.historyIndex = state.history.length - 1;
        else state.historyIndex = Math.max(0, state.historyIndex - 1);
        state.buffer = state.history[state.historyIndex] || "";
        state.cursor = state.buffer.length;
      }
    } else if (key.name === "down") {
      if (state.historyIndex >= 0) {
        state.historyIndex++;
        if (state.historyIndex >= state.history.length) {
          state.historyIndex = -1;
          state.buffer = "";
        } else {
          state.buffer = state.history[state.historyIndex] || "";
        }
        state.cursor = state.buffer.length;
      }
    } else if (key.name === "return" || key.name === "enter") {
      submitBuffer();
      return;
    } else if (ch && !key.ctrl && !key.meta && ch >= " ") {
      state.buffer = state.buffer.slice(0, state.cursor) + ch + state.buffer.slice(state.cursor);
      state.cursor += ch.length;
    }
    renderInput();
  }

  const paneForMode = (mode = state.mode) => {
    if (mode === "content") return ui.output;
    if (mode === "buttons") return ui.controlsPane;
    return ui.log;
  };

  const scrollKeyForMode = (mode = state.mode) => {
    if (mode === "content") return "content";
    if (mode === "buttons") return "buttons";
    return "controls";
  };

  const getPaneVisibleRows = (pane) => {
    if (pane.lpos && Number.isFinite(pane.lpos.yl) && Number.isFinite(pane.lpos.yi)) {
      return Math.max(1, pane.lpos.yl - pane.lpos.yi - 2);
    }
    if (Number.isFinite(pane.height)) return Math.max(1, pane.height - 2);
    return 18;
  };

  const getPaneContentLines = (pane) => {
    if (pane === ui.log) return logLineCount();
    if (pane === ui.controlsPane) return controlsPaneLineCount();
    return String(pane.getContent?.() || "").split("\n").length;
  };

  const getPaneMaxScroll = (pane) => Math.max(0, getPaneContentLines(pane) - getPaneVisibleRows(pane));

  const setPaneScroll = (mode, value) => {
    if (mode === "controls") {
      const max = logMaxScroll();
      const next = driveNativeScrollbarFromWheel(ui.log, "controls", max, value);
      ui.left.setLabel(max > 0 ? ` Controls / logs / errors ${next + 1}-${Math.min(logLineCount(), next + getPaneVisibleRows(ui.log))}/${logLineCount()} ` : " Controls / logs / errors ");
      return;
    }
    if (mode === "buttons") {
      setControlsPaneScroll(value);
      return;
    }
    const pane = paneForMode(mode);
    const key = scrollKeyForMode(mode);
    const max = getPaneMaxScroll(pane);
    const next = Math.max(0, Math.min(max, value));
    state.scroll[key] = next;
    pane.setScroll(next);
    pane.childBase = next;
    pane.childOffset = next;
    ui.screen.render();
  };

  const scrollPane = (mode, amount) => {
    const key = scrollKeyForMode(mode);
    setPaneScroll(mode, (state.scroll[key] || 0) + amount);
  };

  const scrollFocusedPane = (amount) => scrollPane(state.mode, amount);
  const focusedPaneTop = () => setPaneScroll(state.mode, 0);
  const focusedPaneBottom = () => setPaneScroll(state.mode, 999999);
  const wheelLineStep = (pane) => {
    if (pane === ui.log || pane === ui.controlsPane) return 2;
    return Math.max(6, Math.round(getPaneVisibleRows(pane) * 0.28));
  };
  const driveNativeScrollbarFromWheel = (pane, key, max, value) => {
    const next = Math.max(0, Math.min(max, value));
    const current = currentPaneScroll(pane, state.scroll[key] || 0);
    const delta = next - current;
    const percent = max > 0 ? (next / max) * 100 : 0;

    // Drive the real native scrollbar directly. Do not let stale childBase cap the wheel target.
    if (typeof pane.setScroll === "function") pane.setScroll(next);
    if (typeof pane.scroll === "function" && delta !== 0) pane.scroll(delta);
    if (typeof pane.setScrollPerc === "function") pane.setScrollPerc(percent);

    pane.childBase = next;
    pane.childOffset = next;
    state.scroll[key] = next;
    if (pane === ui.log) paintScrollbar(ui.logScrollBar, getPaneVisibleRows(ui.log), logLineCount(), next);
    ui.screen.render();
    return next;
  };

  const scrollLogsByWheel = (direction) => {
    const max = logMaxScroll();
    const next = driveNativeScrollbarFromWheel(ui.log, "controls", max, (state.scroll.controls || 0) + direction * wheelLineStep(ui.log));
    ui.left.setLabel(max > 0 ? ` Controls / logs / errors ${next + 1}-${Math.min(logLineCount(), next + getPaneVisibleRows(ui.log))}/${logLineCount()} ` : " Controls / logs / errors ");
  };

  const scrollButtonsByWheel = (direction) => {
    const max = controlsPaneMaxScroll();
    const next = driveNativeScrollbarFromWheel(ui.controlsPane, "buttons", max, (state.scroll.buttons || 0) + direction * wheelLineStep(ui.controlsPane));
    const lines = controlsPaneLineCount();
    ui.controlsPane.setLabel(max > 0 ? ` Current page buttons / inputs ${next + 1}-${Math.min(lines, next + getPaneVisibleRows(ui.controlsPane))}/${lines} ` : " Current page buttons / inputs ");
  };

  const pointInPane = (pane, data = {}) => {
    const p = pane?.lpos;
    if (!p || !Number.isFinite(data.x) || !Number.isFinite(data.y)) return false;
    return data.x >= p.xi && data.x <= p.xl && data.y >= p.yi && data.y <= p.yl;
  };

  const syncNativeScrollState = () => {
    const nativeLogScroll = currentPaneScroll(ui.log, state.scroll.controls || 0);
    if (Math.abs(nativeLogScroll - (state.scroll.controls || 0)) > wheelLineStep(ui.log) * 2) {
      state.scroll.controls = Math.max(0, Math.min(logMaxScroll(), nativeLogScroll));
    }
    const nativeButtonsScroll = currentPaneScroll(ui.controlsPane, state.scroll.buttons || 0);
    if (Math.abs(nativeButtonsScroll - (state.scroll.buttons || 0)) > wheelLineStep(ui.controlsPane) * 8) {
      state.scroll.buttons = Math.max(0, Math.min(controlsPaneMaxScroll(), nativeButtonsScroll));
    }
  };

  const routeWheel = (direction, data = {}, fallback = "controls") => {
    if (pointInPane(ui.controlsPane, data)) {
      scrollButtonsByWheel(direction);
      return;
    }
    if (pointInPane(ui.output, data)) {
      scrollPane("content", direction * wheelLineStep(ui.output));
      return;
    }
    if (pointInPane(ui.left, data) || pointInPane(ui.log, data) || pointInPane(ui.logScrollBar, data) || pointInPane(ui.inputLine, data)) {
      scrollLogsByWheel(direction);
      return;
    }
    if (fallback === "buttons") scrollButtonsByWheel(direction);
    else if (fallback === "content") scrollPane("content", direction * wheelLineStep(ui.output));
    else scrollLogsByWheel(direction);
  };

  const setLogScrollFromScrollbarMouse = (data = {}) => {
    const p = ui.logScrollBar.lpos || ui.log.lpos;
    if (!p || !Number.isFinite(data.y)) return;
    const max = logMaxScroll();
    const height = Math.max(1, (p.yl ?? p.yi) - (p.yi ?? 0));
    const y = Math.max(0, Math.min(height, data.y - (p.yi ?? 0)));
    const next = max > 0 ? Math.round((y / height) * max) : 0;
    setPaneScroll("controls", next);
  };

  ui.logScrollBar.on("click", setLogScrollFromScrollbarMouse);
  ui.logScrollBar.on("mousedown", (data) => {
    state.draggingLogScrollBar = true;
    setLogScrollFromScrollbarMouse(data);
  });
  ui.logScrollBar.on("mousemove", (data) => {
    if (state.draggingLogScrollBar) setLogScrollFromScrollbarMouse(data);
  });
  ui.logScrollBar.on("wheelup", (data) => { routeWheel(-1, data, "controls"); });
  ui.logScrollBar.on("wheeldown", (data) => { routeWheel(1, data, "controls"); });
  ui.screen.on("mouseup", () => { state.draggingLogScrollBar = false; });

  ui.log.on("wheelup", (data) => { routeWheel(-1, data, "controls"); });
  ui.log.on("wheeldown", (data) => { routeWheel(1, data, "controls"); });
  ui.left.on("wheelup", (data) => { routeWheel(-1, data, "controls"); });
  ui.left.on("wheeldown", (data) => { routeWheel(1, data, "controls"); });
  ui.inputLine.on("wheelup", (data) => { routeWheel(-1, data, "controls"); });
  ui.inputLine.on("wheeldown", (data) => { routeWheel(1, data, "controls"); });
  ui.output.on("wheelup", (data) => { routeWheel(-1, data, "content"); });
  ui.output.on("wheeldown", (data) => { routeWheel(1, data, "content"); });
  ui.controlsPane.on("wheelup", (data) => { routeWheel(-1, data, "buttons"); });
  ui.controlsPane.on("wheeldown", (data) => { routeWheel(1, data, "buttons"); });
  ui.screen.on("wheelup", (data) => { routeWheel(-1, data, state.mode); });
  ui.screen.on("wheeldown", (data) => { routeWheel(1, data, state.mode); });


  const stripAnsi = (value) => String(value || "").replace(/\x1b\[[0-9;]*m/g, "");

  const controlsPaneLineCount = () => Math.max(1, (state.controlsPaneLines || String(ui.controlsPane.getContent() || "").split("\n")).length);

  const controlsPaneMaxScroll = () => Math.max(0, controlsPaneLineCount() - getPaneVisibleRows(ui.controlsPane));

  const setControlsPaneScroll = (value) => {
    const max = controlsPaneMaxScroll();
    const next = driveNativeScrollbarFromWheel(ui.controlsPane, "buttons", max, value);
    const lines = controlsPaneLineCount();
    ui.controlsPane.setLabel(max > 0 ? ` Current page buttons / inputs ${next + 1}-${Math.min(lines, next + getPaneVisibleRows(ui.controlsPane))}/${lines} ` : " Current page buttons / inputs ");
  };

  const currentPaneScroll = (pane, fallback = 0) => {
    // Blessed renders scrollable boxes from childBase. Use that as the source of truth
    // for mouse-to-row mapping; getScroll() can be stale or normalized differently.
    if (Number.isFinite(pane.childBase)) return pane.childBase;
    if (typeof pane.getScroll === "function") {
      const value = pane.getScroll();
      if (Number.isFinite(value)) return value;
    }
    return fallback || 0;
  };

  const controlNumberFromPaneEvent = (data = {}) => {
    if (!ui.controlsPane.lpos) return null;

    const contentTop = (ui.controlsPane.lpos.yi ?? 0) + 1;
    const contentBottom = (ui.controlsPane.lpos.yl ?? contentTop) - 1;
    const y = data.y ?? contentTop;
    if (y < contentTop || y > contentBottom) return null;

    const visibleRow = Math.max(0, y - contentTop);
    const scroll = state.scroll.buttons || 0;
    const contentRow = visibleRow + scroll;

    const cardHeight = 4;
    const cardIndex = Math.floor(contentRow / cardHeight);
    const rowInsideCard = contentRow % cardHeight;

    // Separator row between cards should not select the next/previous card.
    if (rowInsideCard === 3) return null;

    const control = state.controls[cardIndex];
    return control?.number || null;
  };

  ui.output.on("mousemove", (data) => {
    const coords = shotCoordsFromMouse(data);
    if (!coords) return;
    const hit = controlHitFromShotCoords(coords);
    setShotHoverLabel(coords, hit);
    if (hit?.number) highlightControlFromShotNumber(hit.number, { scrollIntoView: true });
    else {
      clearShotHoverHighlight();
      ui.screen.render();
    }
  });

  ui.output.on("click", (data) => {
    const coords = shotCoordsFromMouse(data);
    if (!coords) return;
    const page = activePage();
    if (!page) return;
    const x = Math.round(coords.pageX);
    const y = Math.round(coords.pageY);
    state.appLogs.push(`clickxy ${x} ${y}`);
    renderLeftLog();
    clearCurrentImageOverlay(activeTab(), { clearTerminal: true });
    void page.mouse.click(coords.pageX, coords.pageY)
      .then(async () => {
        await page.waitForLoadState("domcontentloaded", { timeout: 1500 }).catch(() => {});
        await showContext();
      })
      .catch((error) => {
        state.appLogs.push(`coordinate click failed: ${error.message}`);
        renderLeftLog();
      });
  });



  ui.controlsPane.on("mousemove", (data) => {
    const number = controlNumberFromPaneEvent(data);
    const tab = activeTab();
    if (!number || !tab || tab.highlightedControl === number) return;
    state.scroll.buttons = Math.max(0, Math.min(controlsPaneMaxScroll(), currentPaneScroll(ui.controlsPane, state.scroll.buttons || 0)));
    state.highlightedControl = number;
    tab.highlightedControl = number;
    renderControlsPane({ preserveScroll: true });
  });

  ui.controlsPane.on("click", (data) => {
    const number = controlNumberFromPaneEvent(data);
    if (number) void highlightControl(String(number));
  });


  ui.screen.key(["C-c"], async () => {
    clearCurrentImageOverlay(activeTab(), { clearTerminal: true });
    await cleanupShotFiles();
    await context.close().catch(() => {});
    if (!options.userDataDir) await browserOrContext.close().catch(() => {});
    process.exit(0);
  });
  ui.screen.key(["tab"], () => {
    const order = ["controls", "content", "buttons"];
    const current = order.includes(state.mode) ? state.mode : "controls";
    state.mode = order[(order.indexOf(current) + 1) % order.length];
    if (state.mode === "buttons") setControlsPaneScroll(currentPaneScroll(ui.controlsPane, state.scroll.buttons || 0));
    else if (state.mode === "controls") renderLeftLog({ preserveScroll: true });
    else setPaneScroll("content", state.scroll.content || 0);
    renderInput();
  });
  ui.screen.key(["C-n"], () => void runLine("newtab"));
  ui.screen.key(["C-w"], () => void runLine("closetab"));
  ui.screen.key(["C-right"], () => void runLine("nexttab"));
  ui.screen.key(["C-left"], () => void runLine("prevtab"));
  ui.screen.key(["pageup"], () => { scrollFocusedPane(-8); });
  ui.screen.key(["pagedown"], () => { scrollFocusedPane(8); });
  ui.screen.key(["home"], () => { if (state.mode !== "controls") focusedPaneTop(); });
  ui.screen.key(["end"], () => { if (state.mode !== "controls") focusedPaneBottom(); });

  ui.screen.on("keypress", (ch, key = {}) => {
    if (["C-c", "tab", "C-n", "C-w", "C-right", "C-left", "pageup", "pagedown"].includes(key.full)) return;
    if (state.mode === "content" || state.mode === "buttons") {
      if (key.name === "up") scrollFocusedPane(-1);
      else if (key.name === "down") scrollFocusedPane(1);
      else if (key.name === "left") scrollFocusedPane(-4);
      else if (key.name === "right") scrollFocusedPane(4);
      else if (key.name === "pageup") scrollFocusedPane(-8);
      else if (key.name === "pagedown") scrollFocusedPane(8);
      else if (key.name === "home") focusedPaneTop();
      else if (key.name === "end") focusedPaneBottom();
      return;
    }
    editInput(ch, key);
  });

  logLeft("Ready. Errors/logs/history stay on this side.");
  logLeft("Press Tab to control the right pane. Use buttons to list clickable items.");
  setRight("Current site content", "No page loaded yet.");
  setControlsPane("Current page buttons / inputs", "Load a page, then this pane will show buttons, links, inputs, image controls, names, selectors, and commands.");
  renderInput();

  const engine = { chromium, firefox, webkit }[options.browser];
  const contextOptions = { viewport: { width: 1280, height: 900 } };
  const launchOptions = { headless: !options.headed };

  const browserOrContext = options.userDataDir
    ? await engine.launchPersistentContext(options.userDataDir, { ...launchOptions, ...contextOptions })
    : await engine.launch(launchOptions);

  const context = options.userDataDir
    ? browserOrContext
    : await browserOrContext.newContext(contextOptions);

  context.setDefaultTimeout(options.timeout);

  const initial = context.pages()[0] || await context.newPage();
  const initialTab = { page: initial, logs: [], links: [], controls: [], highlightedControl: null, imageOverlay: null };
  setupPage(initial, initialTab);
  state.pages.push(initialTab);
  state.activeIndex = 0;

  if (options.startUrl) await gotoPage(options.startUrl);

  async function runSmokeTestCommands() {
    const smokePage = "data:text/html," + encodeURIComponent(`<!doctype html>
      <html><head><title>Smoke Page</title></head><body>
        <h1>Smoke Test Page</h1>
        <p>Alpha beta gamma smoke content for find.</p>
        <a href="data:text/html,<title>Opened Link</title><h1>Opened Link</h1><p>target page</p>">Open target</a>
        <input id="q" name="q" placeholder="Search box" />
        <button id="btn" onclick="document.body.setAttribute('data-clicked','yes')">Smoke Button</button>
      </body></html>`);

    const commands = options.smokeTest ? [
      "help",
      "clear",
      "errors off",
      "errors on",
      `goto ${smokePage}`,
      "url",
      "title",
      "ready",
      "status",
      "waitload domcontentloaded",
      "context",
      "text body",
      "find smoke",
      "links",
      "links",
    "open 1",
      "back",
      "forward",
      "back",
      "buttons",
      "hover 1",
      "inputs",
      "click #q",
      "type #q hello",
      "typehere world",
      "typeenter",
      "typetab",
      "typeesc",
      "typef6",
      "press Escape",
      "key Enter",
      "scroll down 100",
      "scrollup 50",
      "scrolldown 50",
      "scroll top",
      "scroll bottom",
      "clickxy 5 5",
      "screenshot smoke-output.png",
      "shot",
      "render body",
      "dom body",
      "ascii 40",
      "eval 1 + 1",
      "search playwright browser automation",
      "open 1",
      "newtab about:blank",
      "tabs",
      "tab 1",
      "nexttab",
      "prevtab",
      "closetab 2"
    ] : splitCommandChain(options.runCommands || "");

    const failures = [];
    for (const commandText of commands) {
      try {
        logLeft(`[smoke] ${commandText}`);
        await runCommand(commandText);
      } catch (error) {
        failures.push(`${commandText}: ${error.message}`);
        logLeft(`[smoke error] ${commandText}: ${error.message}`);
      }
    }

    if (options.smokeTest) {
      try {
        const manyButtons = Array.from({ length: 320 }, (_, i) => `<button id="b${i}">Virtual Button ${i}</button>`).join("\n");
        const longPage = "data:text/html," + encodeURIComponent(`<!doctype html><html><head><title>Long Controls</title></head><body>${manyButtons}</body></html>`);
        await gotoPage(longPage);
        await showControls("button");
        const max = controlsPaneMaxScroll();
        setControlsPaneScroll(0);
        const buttonWheelIterations = Math.ceil(max / Math.max(1, wheelLineStep(ui.controlsPane))) + 5;
        for (let i = 0; i < buttonWheelIterations; i++) scrollButtonsByWheel(1);
        if ((state.scroll.buttons || 0) !== max) throw new Error(`wheel-style controls scroll did not reach bottom: ${state.scroll.buttons} of ${max}`);
        setControlsPaneScroll(max);
        const visibleRows = getPaneVisibleRows(ui.controlsPane);
        const visible = String(ui.controlsPane.getContent()).split("\n").slice(state.scroll.buttons || 0, (state.scroll.buttons || 0) + visibleRows).join("\n");
        if (state.controls.length < 300) throw new Error(`expected 300+ controls, found ${state.controls.length}`);
        if (max < 500) throw new Error(`expected a long controls scroll range, found ${max}`);
        if ((state.scroll.buttons || 0) !== max) throw new Error(`controls pane did not reach bottom: ${state.scroll.buttons} of ${max}`);
        if (ui.controlsPane.childBase !== max) throw new Error(`native controls scrollbar did not move to bottom: ${ui.controlsPane.childBase} of ${max}`);
        const beforeWheelUp = state.scroll.buttons || 0;
        scrollButtonsByWheel(-1);
        if ((state.scroll.buttons || 0) >= beforeWheelUp) throw new Error(`wheel-up did not move buttons pane upward: ${state.scroll.buttons} from ${beforeWheelUp}`);
        setControlsPaneScroll(max);
        if (!visible.includes("#b319") && !visible.includes("click 320") && !visible.includes("320.")) throw new Error("bottom of long controls list is not visible after scrolling to max");
        logLeft("[smoke] long controls native wheel scroll check passed");
        for (let i = 0; i < 260; i++) logLeft(`Long log line ${i}`);
        const logMax = logMaxScroll();
        const logVisibleRows = getPaneVisibleRows(ui.log);
        setPaneScroll("controls", logContentMaxScroll());
        const logVisible = String(ui.log.getContent()).split("\n").slice(state.scroll.controls || 0, (state.scroll.controls || 0) + logVisibleRows).join("\n");
        if (logMax < 100) throw new Error(`expected a long log scroll range, found ${logMax}`);
        if (!logVisible.includes("Long log line 259")) throw new Error("bottom of real long log list is not visible before padding");
        setPaneScroll("controls", logMax);
        if ((state.scroll.controls || 0) !== logMax) throw new Error(`log pane did not reach padded bottom: ${state.scroll.controls} of ${logMax}`);
        if (ui.log.childBase !== logMax) throw new Error(`native log scrollbar did not move to padded bottom: ${ui.log.childBase} of ${logMax}`);
        const beforeLogWheelUp = state.scroll.controls || 0;
        scrollLogsByWheel(-1);
        if ((state.scroll.controls || 0) >= beforeLogWheelUp) throw new Error(`wheel-up did not move log pane upward: ${state.scroll.controls} from ${beforeLogWheelUp}`);
        setPaneScroll("controls", 0);
        const logWheelIterations = Math.ceil(logMax / Math.max(1, wheelLineStep(ui.log))) + 5;
        for (let i = 0; i < logWheelIterations; i++) scrollLogsByWheel(1);
        if ((state.scroll.controls || 0) !== logMax) throw new Error(`wheel-style controls/logs scroll did not reach padded bottom: ${state.scroll.controls} of ${logMax}`);
        const beforeControlsWheelUp = state.scroll.controls || 0;
        scrollLogsByWheel(-1);
        if ((state.scroll.controls || 0) >= beforeControlsWheelUp) throw new Error(`wheel-up did not move controls/logs pane upward: ${state.scroll.controls} from ${beforeControlsWheelUp}`);
        setPaneScroll("controls", logMax);
        logLeft("[smoke] long logs native wheel scroll with padding check passed");
      } catch (error) {
        failures.push(`long controls/logs scroll: ${error.message}`);
      }
    }

    await cleanupShotFiles().catch(() => {});
    await context.close().catch(() => {});
    if (!options.userDataDir) await browserOrContext.close().catch(() => {});
    ui.screen.destroy();

    if (failures.length) {
      console.error(`Smoke test failed (${failures.length}):`);
      for (const failure of failures) console.error(`- ${failure}`);
      process.exit(1);
    }
    console.log(`Smoke test passed (${commands.length} commands).`);
    process.exit(0);
  }

  if (options.smokeTest || options.runCommands) await runSmokeTestCommands();

  else {
    await showContext().catch(() => {});
    await showControls().catch(() => {});
  }

  renderInput();
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
