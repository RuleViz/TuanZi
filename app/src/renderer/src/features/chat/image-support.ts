import type { AgentBackendConfig, ProviderConfig, ProviderModelItem } from "../../../../shared/domain-types";

function findActiveProvider(config: AgentBackendConfig): ProviderConfig | null {
  const activeProviderId = typeof config.activeProviderId === "string" ? config.activeProviderId.trim() : "";
  if (!activeProviderId) {
    return null;
  }
  const providers = Array.isArray(config.providers) ? config.providers : [];
  const provider = providers.find((item) => item.id === activeProviderId) ?? null;
  if (!provider || provider.isEnabled === false) {
    return null;
  }
  return provider;
}

function findActiveModel(provider: ProviderConfig): ProviderModelItem | null {
  const activeModelId = typeof provider.model === "string" ? provider.model.trim().toLowerCase() : "";
  if (!activeModelId) {
    return null;
  }
  const models = Array.isArray(provider.models) ? provider.models : [];
  const model = models.find((item) => item.id.trim().toLowerCase() === activeModelId) ?? null;
  if (!model || model.enabled === false) {
    return null;
  }
  return model;
}

export function isActiveModelImageUploadSupported(config: AgentBackendConfig | null): boolean {
  if (!config) {
    return false;
  }
  const provider = findActiveProvider(config);
  if (!provider) {
    return false;
  }
  const model = findActiveModel(provider);
  if (!model) {
    return false;
  }
  return model.isVision === true;
}

