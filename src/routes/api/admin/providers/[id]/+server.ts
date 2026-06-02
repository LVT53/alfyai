import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/auth/hooks';
import { clearProvidersCache, refreshConfig } from '$lib/server/config-store';
import {
  deleteProvider,
  decryptApiKey,
  getProviderWithSecrets,
  normalizeReasoningEffort,
  normalizeThinkingType,
  parseProviderLimitOverrides,
  parseProviderRateLimitFallback,
  resolveProviderLimitDefaults,
  updateProvider,
  validateProviderRateLimitFallbackConfiguration,
  validateProviderLimitConfiguration,
  validateProviderConnection,
  type UpdateProviderInput,
} from '$lib/server/services/inference-providers';

export const PUT: RequestHandler = async (event) => {
  try {
    requireAdmin(event);
    const { id } = event.params;
    const body = await event.request.json();
    const limits = parseProviderLimitOverrides(body);
    if (!limits.ok) {
      return json({ error: limits.error }, { status: 400 });
    }
    const fallback = parseProviderRateLimitFallback(body);
    if (!fallback.ok) {
      return json({ error: fallback.error }, { status: 400 });
    }

    const input: UpdateProviderInput = {};

    if (body.displayName !== undefined) input.displayName = body.displayName;
    if (body.baseUrl !== undefined) input.baseUrl = body.baseUrl;
    if (body.apiKey !== undefined) input.apiKey = body.apiKey;
    if (body.modelName !== undefined) input.modelName = body.modelName;
    if (body.reasoningEffort !== undefined) input.reasoningEffort = normalizeReasoningEffort(body.reasoningEffort);
    if (body.thinkingType !== undefined) input.thinkingType = normalizeThinkingType(body.thinkingType);
    if (body.enabled !== undefined) input.enabled = body.enabled;
    if (body.sortOrder !== undefined) input.sortOrder = body.sortOrder;
    if (limits.value.maxModelContext !== undefined) input.maxModelContext = limits.value.maxModelContext;
    if (limits.value.compactionUiThreshold !== undefined) {
      input.compactionUiThreshold = limits.value.compactionUiThreshold;
    }
    if (limits.value.targetConstructedContext !== undefined) {
      input.targetConstructedContext = limits.value.targetConstructedContext;
    }
    if (limits.value.maxMessageLength !== undefined) input.maxMessageLength = limits.value.maxMessageLength;
    if (limits.value.maxTokens !== undefined) input.maxTokens = limits.value.maxTokens;
    if (body.iconAssetId !== undefined) {
      input.iconAssetId =
        typeof body.iconAssetId === 'string' && body.iconAssetId.trim()
          ? body.iconAssetId.trim()
          : null;
    }
    Object.assign(input, fallback.value);
    if (
      typeof body.rateLimitFallbackApiKey === 'string' &&
      body.rateLimitFallbackApiKey.trim() === ''
    ) {
      delete input.rateLimitFallbackApiKey;
    }

    if (body.reasoningEffort && !input.reasoningEffort) {
      return json({ error: 'Invalid reasoning effort' }, { status: 400 });
    }

    if (body.thinkingType && !input.thinkingType) {
      return json({ error: 'Invalid thinking type' }, { status: 400 });
    }

    const existing = await getProviderWithSecrets(id);
    if (!existing) {
      return json({ error: 'Provider not found' }, { status: 404 });
    }

    if (
      input.modelName !== undefined ||
      input.maxModelContext !== undefined ||
      input.maxMessageLength !== undefined
    ) {
      const limitDefaults = resolveProviderLimitDefaults({
        modelName: input.modelName ?? existing.modelName,
        maxModelContext:
          input.maxModelContext !== undefined
            ? input.maxModelContext
            : existing.maxModelContext,
        maxMessageLength:
          input.maxMessageLength !== undefined
            ? input.maxMessageLength
            : existing.maxMessageLength,
      });
      if (
        input.maxModelContext !== undefined ||
        (existing.maxModelContext == null && limitDefaults.maxModelContext != null)
      ) {
        input.maxModelContext = limitDefaults.maxModelContext;
      }
      if (input.maxMessageLength === undefined || input.maxMessageLength === null) {
        input.maxMessageLength = limitDefaults.maxMessageLength;
      }
    }

    const limitOrderingError = validateProviderLimitConfiguration({
      enabled: input.enabled !== undefined ? input.enabled : existing.enabled,
      maxModelContext:
        input.maxModelContext !== undefined ? input.maxModelContext : existing.maxModelContext,
      compactionUiThreshold:
        input.compactionUiThreshold !== undefined
          ? input.compactionUiThreshold
          : existing.compactionUiThreshold,
      targetConstructedContext:
        input.targetConstructedContext !== undefined
          ? input.targetConstructedContext
          : existing.targetConstructedContext,
      maxTokens:
        input.maxTokens !== undefined ? input.maxTokens : existing.maxTokens,
    });
    if (limitOrderingError) {
      return json({ error: limitOrderingError }, { status: 400 });
    }

    const fallbackEnabled =
      input.rateLimitFallbackEnabled !== undefined
        ? input.rateLimitFallbackEnabled
        : existing.rateLimitFallbackEnabled;
    const fallbackBaseUrl =
      input.rateLimitFallbackBaseUrl !== undefined
        ? input.rateLimitFallbackBaseUrl
        : existing.rateLimitFallbackBaseUrl;
    const fallbackModelName =
      input.rateLimitFallbackModelName !== undefined
        ? input.rateLimitFallbackModelName
        : existing.rateLimitFallbackModelName;
    const fallbackApiKeyChanged =
      typeof input.rateLimitFallbackApiKey === 'string' &&
      input.rateLimitFallbackApiKey.trim().length > 0;
    const fallbackApiKeyCleared = input.rateLimitFallbackApiKey === null;
    const fallbackApiKeyAvailable =
      fallbackApiKeyChanged ||
      (!fallbackApiKeyCleared &&
        Boolean(existing.rateLimitFallbackApiKeyEncrypted && existing.rateLimitFallbackApiKeyIv));
    const fallbackConfigurationError = validateProviderRateLimitFallbackConfiguration({
      enabled: fallbackEnabled,
      baseUrl: fallbackBaseUrl,
      modelName: fallbackModelName,
      apiKeyAvailable: fallbackApiKeyAvailable,
      timeoutMs:
        input.rateLimitFallbackTimeoutMs !== undefined
          ? input.rateLimitFallbackTimeoutMs
          : existing.rateLimitFallbackTimeoutMs,
    });
    if (fallbackConfigurationError) {
      return json({ error: fallbackConfigurationError }, { status: 400 });
    }

    const validationBaseUrl =
      typeof body.baseUrl === 'string' && body.baseUrl.trim()
        ? body.baseUrl
        : undefined;
    const validationApiKey =
      typeof body.apiKey === 'string' && body.apiKey.trim()
        ? body.apiKey
        : undefined;

    if (
      validationBaseUrl ||
      validationApiKey ||
      input.modelName !== undefined ||
      input.reasoningEffort !== undefined ||
      input.thinkingType !== undefined
    ) {
      const apiKey = validationApiKey ?? decryptApiKey(existing.apiKeyEncrypted, existing.apiKeyIv);
      const connectionTest = await validateProviderConnection(
        validationBaseUrl ?? existing.baseUrl,
        apiKey,
        {
          modelName: input.modelName ?? existing.modelName,
          reasoningEffort:
            input.reasoningEffort !== undefined
              ? input.reasoningEffort
              : existing.reasoningEffort,
          thinkingType:
            input.thinkingType !== undefined ? input.thinkingType : existing.thinkingType,
        }
      );
      if (!connectionTest.valid) {
        return json({ error: connectionTest.error }, { status: 400 });
      }
      input.capabilities = connectionTest.capabilities ?? null;
    }

    const fallbackEndpointChanged =
      input.rateLimitFallbackBaseUrl !== undefined ||
      input.rateLimitFallbackModelName !== undefined ||
      fallbackApiKeyChanged;
    if (fallbackEnabled && fallbackEndpointChanged) {
      if (!fallbackBaseUrl) {
        return json({ error: 'Rate-limit fallback base URL is required' }, { status: 400 });
      }
      const fallbackApiKey = fallbackApiKeyChanged
        ? input.rateLimitFallbackApiKey
        : existing.rateLimitFallbackApiKeyEncrypted && existing.rateLimitFallbackApiKeyIv
          ? decryptApiKey(
              existing.rateLimitFallbackApiKeyEncrypted,
              existing.rateLimitFallbackApiKeyIv
            )
          : null;
      if (!fallbackApiKey) {
        return json({ error: 'Rate-limit fallback API key is required' }, { status: 400 });
      }
      const fallbackConnectionTest = await validateProviderConnection(
        fallbackBaseUrl,
        fallbackApiKey,
        { modelName: fallbackModelName }
      );
      if (!fallbackConnectionTest.valid) {
        return json({ error: fallbackConnectionTest.error }, { status: 400 });
      }
    }

    const provider = await updateProvider(id, input);

    if (!provider) {
      return json({ error: 'Provider not found' }, { status: 404 });
    }

    clearProvidersCache();
    await refreshConfig();
    return json({ provider });
  } catch (error) {
    console.error('[ADMIN] Failed to update provider:', error);
    return json({ error: 'Failed to update provider' }, { status: 500 });
  }
};

export const DELETE: RequestHandler = async (event) => {
  try {
    requireAdmin(event);
    const { id } = event.params;

    const deleted = await deleteProvider(id);

    if (!deleted) {
      return json({ error: 'Provider not found' }, { status: 404 });
    }

    clearProvidersCache();
    await refreshConfig();
    return json({ success: true });
  } catch (error) {
    console.error('[ADMIN] Failed to delete provider:', error);
    return json({ error: 'Failed to delete provider' }, { status: 500 });
  }
};
