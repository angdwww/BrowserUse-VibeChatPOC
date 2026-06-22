#!/usr/bin/env node
import { chromium, firefox, webkit } from "playwright";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { inspect } from "node:util";

const VERSION = "0.1.0";

const HELP = `
Terminal Browser CLI ${VERSION}

Run:
  npm start -- [url]
  npm start -- google.com --headed
  npm start -- --browser firefox
  npm start -- --user-data-dir .browser-profile

Options:
  --browser chromium|firefox|webkit
  --headed
  --user-data-dir <path>
  --timeout <ms>
  --wait-until domcontentloaded|load|networkidle

Commands:
  help
  goto <url-or-search>
  url
  reload
  back
  forward
  waitload [domcontentloaded|load|networkidle]
  status
  text [selector]
  title
  ready
  links [filter]
  open <link-number>
  inputs
  click <selector-or-number-or-text>
  type <selector-or-number> <text>
  press <key>
  wait <ms-or-selector>
  screenshot [path]
  eval <javascript-expression>
  search <query>
  exit
`;

function parseArgs(argv) {
  const options = {
    browser: "chromium",
    headed: false,
    userDataDir: null,
    timeout: 15000,
    startUrl: null,
    waitUntil: "domcontentloaded"
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--browser") options.browser = argv[++i] || options.browser;
    else if (arg === "--headed") options.headed = true;
    else if (arg === "--user-data-dir") options.userDataDir = argv[++i] || null;
    else if (arg === "--timeout") options.timeout = Number(argv[++i] || options.timeout);
    else if (arg === "--wait-until") options.waitUntil = argv[++i] || options.waitUntil;
    else if (arg === "--help" || arg === "-h") {
      console.log(HELP.trim());
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
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}

function splitCommand(line) {
  const parts = [];
  let current = "";
  let quote = null;
  let escaped = false;

  for (const char of line.trim()) {
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

function short(text, limit = 120) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function trimOutput(text, limit = 12000) {
  const value = String(text || "");
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n... truncated ${value.length - limit} chars`;
}

async function summary(page) {
  const title = await page.title().catch(() => "");
  return `${title || "(no title)"} — ${page.url()}`;
}

async function gotoPage(page, url, waitUntil = "domcontentloaded") {
  const response = await page.goto(normalizeUrl(url), { waitUntil });
  const status = response ? `${response.status()} ${response.statusText()}` : "no main response";
  console.log(`${await summary(page)} [${status}]`);
}

async function printStatus(page) {
  const info = await page.evaluate(() => ({
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
  console.log(inspect(info, { colors: true, depth: 6 }));
}

async function waitForPage(page, waitUntil = "networkidle") {
  if (!["domcontentloaded", "load", "networkidle"].includes(waitUntil)) {
    throw new Error("waitload must be domcontentloaded, load, or networkidle");
  }
  await page.waitForLoadState(waitUntil);
  await page.waitForTimeout(500);
  console.log(`Reached ${waitUntil}. ${await summary(page)}`);
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

async function getControls(page) {
  return page.locator("input, textarea, select, button, [role=button], [contenteditable=true]").evaluateAll((nodes) =>
    nodes.map((node, i) => {
      const tag = node.tagName.toLowerCase();
      const type = node.getAttribute("type") || node.getAttribute("role") || "";
      const label = node.getAttribute("aria-label") || node.getAttribute("placeholder") || node.getAttribute("name") || node.id || node.innerText || node.textContent || "";
      const selector = node.id
        ? `#${CSS.escape(node.id)}`
        : node.getAttribute("name")
          ? `${tag}[name="${node.getAttribute("name").replace(/"/g, '\\"')}"]`
          : tag;
      return {
        number: i + 1,
        kind: [tag, type].filter(Boolean).join(":"),
        label: label.replace(/\s+/g, " ").trim(),
        selector,
        visible: Boolean(node.offsetWidth || node.offsetHeight || node.getClientRects().length)
      };
    }).filter((item) => item.visible)
  );
}

function byNumber(raw, list) {
  const number = Number(raw);
  if (!Number.isInteger(number) || number < 1) return null;
  return list.find((item) => item.number === number) || list[number - 1] || null;
}

async function clickThing(page, state, target) {
  const link = byNumber(target, state.links);
  if (link?.href) {
    await page.goto(link.href, { waitUntil: "domcontentloaded" });
    return;
  }

  const control = byNumber(target, state.controls);
  if (control?.selector) {
    await page.locator(control.selector).first().click();
    return;
  }

  const css = page.locator(target).first();
  if (await css.count().catch(() => 0)) {
    await css.click();
    return;
  }

  await page.getByText(target, { exact: false }).first().click();
}

async function typeInto(page, state, target, text) {
  const control = byNumber(target, state.controls);
  const selector = control?.selector || target;
  const field = page.locator(selector).first();

  if (await field.count().catch(() => 0)) {
    await field.fill(text).catch(async () => {
      await field.click();
      await page.keyboard.type(text);
    });
    return;
  }

  await page.getByLabel(target, { exact: false }).first().fill(text);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
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

  const page = context.pages()[0] || await context.newPage();
  const state = { links: [], controls: [] };

  page.on("console", (message) => console.log(`[page:${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => console.log(`[page error] ${error.message}`));

  if (options.startUrl) {
    await gotoPage(page, options.startUrl, options.waitUntil);
  }

  console.log("Playwright terminal browser ready. Type help for commands.");

  const rl = createInterface({ input, output, prompt: "browser> " });
  if (input.isTTY) rl.prompt();
  for await (const line of rl) {
    const [command, ...args] = splitCommand(line);
    const rest = line.trim().slice((command || "").length).trim();
    if (!command) continue;

    try {
      if (command === "help" || command === "?") {
        console.log(HELP.trim());
      } else if (["exit", "quit", ":q"].includes(command)) {
        break;
      } else if (command === "goto" || command === "go") {
        await page.goto(normalizeUrl(rest), { waitUntil: "domcontentloaded" });
        await gotoPage(page, rest, options.waitUntil);
        console.log(await summary(page));
      } else if (command === "reload") {
      } else if (command === "title") {
        console.log(await page.title());
      } else if (command === "ready") {
        console.log(await page.evaluate(() => document.readyState));
      } else if (command === "status") {
        await printStatus(page);
      } else if (command === "waitload" || command === "waitnetwork") {
        await waitForPage(page, rest || "networkidle");
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.reload({ waitUntil: options.waitUntil });
      } else if (command === "back") {
        await page.goBack({ waitUntil: "domcontentloaded" });
        await page.goBack({ waitUntil: options.waitUntil });
      } else if (command === "forward") {
        await page.goForward({ waitUntil: "domcontentloaded" });
        await page.goForward({ waitUntil: options.waitUntil });
      } else if (command === "text") {
        console.log(trimOutput(await page.locator(rest || "body").first().innerText()));
        await page.waitForLoadState("domcontentloaded").catch(() => {});
      } else if (command === "links") {
        state.links = await getLinks(page, rest);
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        if (!state.links.length) console.log("No visible links found.");
        for (const link of state.links.slice(0, 80)) {
          console.log(`${link.number}. ${short(link.text || "(no text)", 80)} -> ${link.href}`);
        }
        if (state.links.length > 80) console.log(`... ${state.links.length - 80} more links hidden`);
      } else if (command === "open") {
        const link = byNumber(args[0], state.links);
        if (!link?.href) throw new Error("Run links first, then open a link number.");
        await page.goto(link.href, { waitUntil: "domcontentloaded" });
        console.log(await summary(page));
        await gotoPage(page, link.href, options.waitUntil);
        state.controls = await getControls(page);
        if (!state.controls.length) console.log("No visible inputs/buttons found.");
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        for (const control of state.controls.slice(0, 100)) {
          console.log(`${control.number}. ${control.kind} | ${short(control.label || "(unlabeled)", 80)} | ${control.selector}`);
        }
        if (state.controls.length > 100) console.log(`... ${state.controls.length - 100} more controls hidden`);
      } else if (command === "click") {
        if (!rest) throw new Error("Usage: click <selector-or-number-or-text>");
        await clickThing(page, state, rest);
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        console.log(await summary(page));
      } else if (command === "type" || command === "fill") {
        const [target, ...words] = args;
        if (!target || !words.length) throw new Error("Usage: type <selector-or-number> <text>");
        await typeInto(page, state, target, words.join(" "));
      } else if (command === "press") {
        if (!rest) throw new Error("Usage: press <key>");
        await page.keyboard.press(rest);
      } else if (command === "wait") {
        const ms = Number(rest);
        if (Number.isFinite(ms)) await page.waitForTimeout(ms);
        else await page.locator(rest).first().waitFor();
      } else if (command === "screenshot") {
        const path = rest || "screenshot.png";
        await page.screenshot({ path, fullPage: true });
        console.log(`Saved ${path}`);
      } else if (command === "eval" || command === "js") {
        if (!rest) throw new Error("Usage: eval <javascript-expression>");
        const result = await page.evaluate(`(() => (${rest}))()`);
        console.log(inspect(result, { colors: true, depth: 4 }));
      } else if (command === "search" || command === "find") {
        if (!rest) throw new Error("Usage: search <query>");
        const text = await page.locator("body").innerText();
        const matches = text.split("\n").map((line) => line.trim()).filter((line) => line.toLowerCase().includes(rest.toLowerCase()));
        console.log(matches.slice(0, 50).join("\n") || "No matches.");
        if (matches.length > 50) console.log(`... ${matches.length - 50} more matches`);
      } else {
        console.log(`Unknown command: ${command}. Type help for commands.`);
      }
    } catch (error) {
      console.error(`Error: ${error.message}`);
    }
    if (input.isTTY) rl.prompt();
  }

  rl.close();
  await context.close();
  if (!options.userDataDir) await browserOrContext.close();
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
