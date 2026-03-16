import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { JsonObject, Tool, ToolExecutionContext, ToolExecutionResult } from "../core/types";
import { asNumber, asString } from "../core/json-utils";

type BrowserAction = "navigate" | "screenshot" | "click" | "type" | "extract_text" | "evaluate" | "close";

let browserInstance: any = null;
let pageInstance: any = null;

export class BrowserActionTool implements Tool {
  readonly definition = {
    name: "browser_action",
    description:
      "Control a headless browser: navigate, screenshot, click, type, extract_text, evaluate JavaScript, close.",
    destructive: true,
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["navigate", "screenshot", "click", "type", "extract_text", "evaluate", "close"],
          description: "Browser action."
        },
        url: { type: "string", description: "Required for navigate." },
        selector: { type: "string", description: "Required for click/type/extract_text." },
        text: { type: "string", description: "Required for type." },
        script: { type: "string", description: "Required for evaluate." },
        wait_ms: { type: "number", description: "Optional wait after action." },
        viewport: {
          type: "object",
          properties: {
            width: { type: "number" },
            height: { type: "number" }
          },
          required: [],
          additionalProperties: false
        }
      },
      required: ["action"],
      additionalProperties: false
    }
  };

  async execute(input: JsonObject, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const action = asString(input.action);
    if (!action || !isBrowserAction(action)) {
      return {
        ok: false,
        error: "action is required. Valid actions: navigate, screenshot, click, type, extract_text, evaluate, close."
      };
    }

    const policyDecision = context.policyEngine?.evaluateTool(this.definition.name, input) ?? {
      decision: "ask" as const,
      reason: "No policy engine configured."
    };
    if (policyDecision.decision === "deny") {
      return { ok: false, error: `Policy denied browser_action: ${policyDecision.reason}` };
    }
    if (policyDecision.decision === "ask") {
      const approval = await context.approvalGate.approve({
        action: `browser_action ${action}`,
        risk: action === "evaluate" ? "high" : "medium",
        preview: buildPreview(action, input)
      });
      if (!approval.approved) {
        return { ok: false, error: approval.reason ?? "browser_action rejected." };
      }
    }

    if (action === "close") {
      await closeBrowser();
      return { ok: true, data: { action: "close", message: "Browser closed." } };
    }

    const page = await getOrCreatePage(input);
    const waitMs = clampInt(asNumber(input.wait_ms) ?? defaultWait(action), 0, 30_000);

    if (action === "navigate") {
      const url = asString(input.url);
      if (!url) {
        return { ok: false, error: "url is required for navigate." };
      }
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      if (waitMs > 0) {
        await sleep(waitMs);
      }
      return {
        ok: true,
        data: {
          action: "navigate",
          url,
          status: response ? response.status() : null,
          title: await page.title()
        }
      };
    }

    if (action === "screenshot") {
      const screenshotDir = path.join(context.workspaceRoot, ".tuanzi", "screenshots");
      await fs.mkdir(screenshotDir, { recursive: true });
      const fileName = `screenshot-${Date.now()}.png`;
      const screenshotPath = path.join(screenshotDir, fileName);
      await page.screenshot({ path: screenshotPath, fullPage: false });
      return { ok: true, data: { action: "screenshot", path: screenshotPath } };
    }

    if (action === "click") {
      const selector = asString(input.selector);
      if (!selector) {
        return { ok: false, error: "selector is required for click." };
      }
      await page.click(selector);
      if (waitMs > 0) {
        await sleep(waitMs);
      }
      return { ok: true, data: { action: "click", selector } };
    }

    if (action === "type") {
      const selector = asString(input.selector);
      const text = asString(input.text);
      if (!selector || text === null) {
        return { ok: false, error: "selector and text are required for type." };
      }
      await page.click(selector, { clickCount: 3 }).catch(() => { });
      await page.type(selector, text);
      if (waitMs > 0) {
        await sleep(waitMs);
      }
      return { ok: true, data: { action: "type", selector, text } };
    }

    if (action === "extract_text") {
      const selector = asString(input.selector) ?? "body";
      const text = await page.$eval(selector, (element: Element) => element.textContent ?? "");
      return {
        ok: true,
        data: {
          action: "extract_text",
          selector,
          text: text.length > 5000 ? `${text.slice(0, 5000)}...(truncated)` : text
        }
      };
    }

    const script = asString(input.script);
    if (!script) {
      return { ok: false, error: "script is required for evaluate." };
    }
    const result = await page.evaluate((code: string) => {
      return (0, eval)(code);
    }, script);
    return { ok: true, data: { action: "evaluate", result } };
  }
}

function isBrowserAction(value: string): value is BrowserAction {
  return (
    value === "navigate" ||
    value === "screenshot" ||
    value === "click" ||
    value === "type" ||
    value === "extract_text" ||
    value === "evaluate" ||
    value === "close"
  );
}

function buildPreview(action: BrowserAction, input: JsonObject): string {
  if (action === "navigate") {
    return `url: ${asString(input.url) ?? "[missing]"}`;
  }
  if (action === "click" || action === "type" || action === "extract_text") {
    return `selector: ${asString(input.selector) ?? "[missing]"}`;
  }
  if (action === "evaluate") {
    const script = asString(input.script) ?? "";
    return `script: ${script.slice(0, 200)}${script.length > 200 ? "...(truncated)" : ""}`;
  }
  return "browser interaction";
}

async function getOrCreatePage(input: JsonObject): Promise<any> {
  const browser = await getBrowser();
  if (!pageInstance || pageInstance.isClosed()) {
    pageInstance = await browser.newPage();
  }

  const viewportValue = input.viewport;
  if (viewportValue && typeof viewportValue === "object" && !Array.isArray(viewportValue)) {
    const viewport = viewportValue as Record<string, unknown>;
    const width = clampInt(asNumber(viewport.width) ?? 0, 0, 10_000);
    const height = clampInt(asNumber(viewport.height) ?? 0, 0, 10_000);
    if (width > 0 && height > 0) {
      await pageInstance.setViewport({ width, height });
    }
  }

  return pageInstance;
}

async function getBrowser(): Promise<any> {
  if (browserInstance && browserInstance.isConnected()) {
    return browserInstance;
  }

  let puppeteer: any;
  try {
    const dynamicImporter = new Function("specifier", "return import(specifier);") as (
      specifier: string
    ) => Promise<any>;
    puppeteer = await dynamicImporter("puppeteer-core");
  } catch {
    throw new Error("browser_action requires optional dependency 'puppeteer-core'. Install it with: npm install puppeteer-core");
  }

  const executablePath = findChromePath();
  if (!executablePath) {
    throw new Error("Chrome/Edge not found. Install browser or set CHROME_PATH environment variable.");
  }

  browserInstance = await puppeteer.default.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  });

  browserInstance.on("disconnected", () => {
    browserInstance = null;
    pageInstance = null;
  });

  return browserInstance;
}

function findChromePath(): string | null {
  const candidates = process.platform === "win32"
    ? [
      process.env.CHROME_PATH,
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
    ]
    : process.platform === "darwin"
      ? [
        process.env.CHROME_PATH,
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
      ]
      : [
        process.env.CHROME_PATH,
        "/usr/bin/google-chrome",
        "/usr/bin/chromium-browser",
        "/usr/bin/chromium",
        "/snap/bin/chromium"
      ];

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function closeBrowser(): Promise<void> {
  if (pageInstance) {
    await pageInstance.close().catch(() => { });
    pageInstance = null;
  }
  if (browserInstance) {
    await browserInstance.close().catch(() => { });
    browserInstance = null;
  }
}

function clampInt(value: number, min: number, max: number): number {
  const integer = Math.floor(value);
  return Math.max(min, Math.min(max, integer));
}

function defaultWait(action: BrowserAction): number {
  if (action === "navigate") {
    return 1000;
  }
  if (action === "click" || action === "type") {
    return 300;
  }
  return 0;
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
