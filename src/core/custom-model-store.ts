import { existsSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CustomModelConfig {
  name: string;
  baseUrl: string;
  modelId: string;
  apiKey: string;
}

export interface CustomModelStore {
  defaultModel: string;
  models: CustomModelConfig[];
}

const STORE_DIR_NAME = ".tuanzi";
const STORE_FILE_NAME = "models.json";

export function getCustomModelStorePath(): string {
  const overridePath = process.env.TUANZI_MODELS_PATH?.trim();
  if (overridePath) {
    return path.resolve(overridePath);
  }
  return path.join(os.homedir(), STORE_DIR_NAME, STORE_FILE_NAME);
}

export function loadCustomModelStore(): CustomModelStore {
  const filePath = getCustomModelStorePath();
  if (!existsSync(filePath)) {
    return emptyStore();
  }

  try {
    const raw = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "").trim();
    if (!raw) {
      return emptyStore();
    }
    const parsed = JSON.parse(raw) as unknown;
    return normalizeStore(parsed);
  } catch (error) {
    console.warn(
      `[WARN] Failed to read custom model store, fallback to empty: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return emptyStore();
  }
}

export async function saveCustomModelStore(store: CustomModelStore): Promise<void> {
  const filePath = getCustomModelStorePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const normalized = normalizeStore(store);
  await fs.writeFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

export function findCustomModelConfig(store: CustomModelStore, name: string | null | undefined): CustomModelConfig | null {
  const target = normalizeName(name);
  if (!target) {
    return null;
  }
  for (const model of store.models) {
    if (model.name.toLowerCase() === target.toLowerCase()) {
      return model;
    }
  }
  return null;
}

function normalizeStore(input: unknown): CustomModelStore {
  const raw = asRecord(input);
  if (!raw) {
    return emptyStore();
  }

  const modelsRaw = Array.isArray(raw.models) ? raw.models : [];
  const seen = new Set<string>();
  const models: CustomModelConfig[] = [];
  for (const item of modelsRaw) {
    const normalized = normalizeModel(item);
    if (!normalized) {
      continue;
    }
    const key = normalized.name.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    models.push(normalized);
  }

  const defaultModel = normalizeName(raw.defaultModel);
  const validDefault =
    defaultModel && models.some((item) => item.name.toLowerCase() === defaultModel.toLowerCase()) ? defaultModel : "";

  return {
    defaultModel: validDefault,
    models
  };
}

function normalizeModel(input: unknown): CustomModelConfig | null {
  const raw = asRecord(input);
  if (!raw) {
    return null;
  }

  const name = normalizeName(raw.name);
  const baseUrl = normalizeBaseUrl(raw.baseUrl);
  const modelId = normalizeText(raw.modelId);
  const apiKey = normalizeApiKey(raw.apiKey);
  if (!name || !baseUrl || !modelId || !apiKey) {
    return null;
  }

  return {
    name,
    baseUrl,
    modelId,
    apiKey
  };
}

function normalizeName(value: unknown): string {
  return normalizeText(value);
}

function normalizeBaseUrl(value: unknown): string {
  const trimmed = normalizeText(value);
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/\/+$/, "");
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeApiKey(value: unknown): string {
  const raw = normalizeText(value);
  if (!raw) {
    return "";
  }
  const withoutInvisible = raw.replace(/[\u200B-\u200D\uFEFF]/g, "");
  if (
    (withoutInvisible.startsWith("\"") && withoutInvisible.endsWith("\"")) ||
    (withoutInvisible.startsWith("'") && withoutInvisible.endsWith("'"))
  ) {
    return withoutInvisible.slice(1, -1).trim();
  }
  return withoutInvisible;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function emptyStore(): CustomModelStore {
  return {
    defaultModel: "",
    models: []
  };
}
