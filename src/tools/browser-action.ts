import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { JsonObject, Tool, ToolExecutionContext, ToolExecutionResult } from "../core/types";
import { asNumber, asString } from "../core/json-utils";

type BrowserAction = "navigate" | "screenshot" | "click" | "type" | "extract_text" | "evaluate" | "close";

interface BrowserSession {
  browser: any;
  page: any;
  lastUsedAt: number;
}

const sessions = new Map<string, BrowserSession>();
const DEFAULT_ACTION_TIMEOUT_MS = 45_000;
const SESSION_IDLE_TTL_MS = 60_000;

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
    throwIfAborted(context.signal);
    await cleanupIdleSessions(resolveSessionKey(context));

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
      await closeBrowser(context);
      return { ok: true, data: { action: "close", message: "Browser closed." } };
    }

    const page = await getOrCreatePage(input, context);
    const waitMs = clampInt(asNumber(input.wait_ms) ?? defaultWait(action), 0, 30_000);
    const onCancel = async (): Promise<void> => {
      await closeBrowser(context);
    };

    if (action === "navigate") {
      const url = asString(input.url);
      if (!url) {
        return { ok: false, error: "url is required for navigate." };
      }
      const response = await executeWithGuards<any>(
        () => page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }),
        {
          signal: context.signal,
          timeoutMs: 35_000,
          onCancel
        }
      );
      if (waitMs > 0) {
        await sleep(waitMs, context.signal);
      }
      return {
        ok: true,
        data: {
          action: "navigate",
          url,
          status: response ? response.status() : null,
          title: await executeWithGuards(() => page.title(), {
            signal: context.signal,
            timeoutMs: 10_000,
            onCancel
          })
        }
      };
    }

    if (action === "screenshot") {
      const screenshotDir = path.join(context.workspaceRoot, ".tuanzi", "screenshots");
      await fs.mkdir(screenshotDir, { recursive: true });
      const fileName = `screenshot-${Date.now()}.png`;
      const screenshotPath = path.join(screenshotDir, fileName);
      await executeWithGuards(() => page.screenshot({ path: screenshotPath, fullPage: false }), {
        signal: context.signal,
        timeoutMs: DEFAULT_ACTION_TIMEOUT_MS,
        onCancel
      });
      return { ok: true, data: { action: "screenshot", path: screenshotPath } };
    }

    if (action === "click") {
      const selector = asString(input.selector);
      if (!selector) {
        return { ok: false, error: "selector is required for click." };
      }
      await executeWithGuards(() => page.click(selector), {
        signal: context.signal,
        timeoutMs: DEFAULT_ACTION_TIMEOUT_MS,
        onCancel
      });
      if (waitMs > 0) {
        await sleep(waitMs, context.signal);
      }
      return { ok: true, data: { action: "click", selector } };
    }

    if (action === "type") {
      const selector = asString(input.selector);
      const text = asString(input.text);
      if (!selector || text === null) {
        return { ok: false, error: "selector and text are required for type." };
      }
      await executeWithGuards(() => page.click(selector, { clickCount: 3 }).catch(() => { }), {
        signal: context.signal,
        timeoutMs: DEFAULT_ACTION_TIMEOUT_MS,
        onCancel
      });
      await executeWithGuards(() => page.type(selector, text), {
        signal: context.signal,
        timeoutMs: DEFAULT_ACTION_TIMEOUT_MS,
        onCancel
      });
      if (waitMs > 0) {
        await sleep(waitMs, context.signal);
      }
      return { ok: true, data: { action: "type", selector, text } };
    }

    if (action === "extract_text") {
      const selector = asString(input.selector) ?? "body";
      const extracted = await executeWithGuards(
        () => page.$eval(selector, (element: Element) => element.textContent ?? ""),
        {
          signal: context.signal,
          timeoutMs: DEFAULT_ACTION_TIMEOUT_MS,
          onCancel
        }
      );
      const text = typeof extracted === "string" ? extracted : String(extracted ?? "");
      return {
        ok: true,
        data: {
          action: "extract_text",
          selector,
          text: normalizeExtractedBrowserText(text)
        }
      };
    }

    const script = asString(input.script);
    if (!script) {
      return { ok: false, error: "script is required for evaluate." };
    }
    const result = await executeWithGuards(
      () =>
        page.evaluate((code: string) => {
          return (0, eval)(code);
        }, script),
      {
        signal: context.signal,
        timeoutMs: DEFAULT_ACTION_TIMEOUT_MS,
        onCancel
      }
    );
    return { ok: true, data: { action: "evaluate", result } };
  }
}

export function normalizeExtractedBrowserText(extracted: unknown): string {
  return typeof extracted === "string" ? extracted : String(extracted ?? "");
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

async function getOrCreatePage(input: JsonObject, context: ToolExecutionContext): Promise<any> {
  const session = await getOrCreateSession(context);
  if (!session.page || session.page.isClosed()) {
    session.page = await session.browser.newPage();
  }

  const viewportValue = input.viewport;
  if (viewportValue && typeof viewportValue === "object" && !Array.isArray(viewportValue)) {
    const viewport = viewportValue as Record<string, unknown>;
    const width = clampInt(asNumber(viewport.width) ?? 0, 0, 10_000);
    const height = clampInt(asNumber(viewport.height) ?? 0, 0, 10_000);
    if (width > 0 && height > 0) {
      await session.page.setViewport({ width, height });
    }
  }

  return session.page;
}

async function getOrCreateSession(context: ToolExecutionContext): Promise<BrowserSession> {
  const key = resolveSessionKey(context);
  const existing = sessions.get(key);
  if (existing && existing.browser && existing.browser.isConnected()) {
    existing.lastUsedAt = Date.now();
    return existing;
  }

  const browser = await launchBrowser();
  const page = await browser.newPage();
  const next: BrowserSession = { browser, page, lastUsedAt: Date.now() };
  sessions.set(key, next);

  browser.on("disconnected", () => {
    const active = sessions.get(key);
    if (active && active.browser === browser) {
      sessions.delete(key);
    }
  });

  return next;
}

async function launchBrowser(): Promise<any> {
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

  return puppeteer.default.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  });
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

async function closeBrowser(context: ToolExecutionContext): Promise<void> {
  const key = resolveSessionKey(context);
  const session = sessions.get(key);
  if (!session) {
    return;
  }
  sessions.delete(key);

  if (session.page) {
    await session.page.close().catch(() => { });
  }
  if (session.browser) {
    await session.browser.close().catch(() => { });
  }
}

async function cleanupIdleSessions(activeSessionKey: string): Promise<void> {
  const now = Date.now();
  const staleEntries: Array<[string, BrowserSession]> = [];
  for (const entry of sessions.entries()) {
    const [key, session] = entry;
    if (key === activeSessionKey) {
      continue;
    }
    if (now - session.lastUsedAt < SESSION_IDLE_TTL_MS) {
      continue;
    }
    staleEntries.push(entry);
  }

  for (const [key, session] of staleEntries) {
    sessions.delete(key);
    await session.page?.close?.().catch(() => { });
    await session.browser?.close?.().catch(() => { });
  }
}

function resolveSessionKey(context: ToolExecutionContext): string {
  const taskId = context.taskId?.trim();
  if (taskId) {
    return taskId;
  }
  return "default";
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

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }
  if (signal?.aborted) {
    throw new Error("Interrupted by user");
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(new Error("Interrupted by user"));
    };

    const cleanup = (): void => {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Interrupted by user");
  }
}

async function executeWithGuards<T>(
  operation: () => Promise<T>,
  options: {
    signal?: AbortSignal;
    timeoutMs: number;
    onCancel?: () => Promise<void>;
  }
): Promise<T> {
  throwIfAborted(options.signal);

  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      void options.onCancel?.().catch(() => {
        return;
      });
      reject(new Error(`browser_action timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);

    const onAbort = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      void options.onCancel?.().catch(() => {
        return;
      });
      reject(new Error("Interrupted by user"));
    };

    const cleanup = (): void => {
      clearTimeout(timer);
      if (options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
    };

    if (options.signal) {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    void operation()
      .then((value) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      })
      .catch((error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      });
  });
}
