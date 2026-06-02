import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/auth/hooks';
import { clearProvidersCache, refreshConfig } from '$lib/server/config-store';
import {
  createProvider,
  listProviders,
  normalizeReasoningEffort,
  normalizeThinkingType,
  parseProviderLimitOverrides,
  parseProviderRateLimitFallback,
  resolveProviderLimitDefaults,
  validateProviderRateLimitFallbackConfiguration,
  validateProviderLimitConfiguration,
  validateProviderConnection,
  type CreateProviderInput,
} from '$lib/server/services/inference-providers';

export const GET: RequestHandler = async (event) => {
  try {
    requireAdmin(event);
    const providers = await listProviders();
    return json({ providers });
  } catch (error) {
    console.error('[ADMIN] Failed to list providers:', error);
    return json({ error: 'Failed to list providers' }, { status: 500 });
  }
};

export const POST: RequestHandler = async (event) => {
  try {
    requireAdmin(event);
    const body = await event.request.json();
    const limits = parseProviderLimitOverrides(body);
    if (!limits.ok) {
      return json({ error: limits.error }, { status: 400 });
    }
    const fallback = parseProviderRateLimitFallback(body);
    if (!fallback.ok) {
      return json({ error: fallback.error }, { status: 400 });
    }

    const input: CreateProviderInput = {
      name: body.name,
      displayName: body.displayName,
      baseUrl: body.baseUrl,
      apiKey: body.apiKey,
      modelName: body.modelName,
      reasoningEffort: normalizeReasoningEffort(body.reasoningEffort),
      thinkingType: normalizeThinkingType(body.thinkingType),
      enabled: body.enabled ?? true,
      sortOrder: body.sortOrder ?? 0,
      maxModelContext: limits.value.maxModelContext ?? null,
      compactionUiThreshold: limits.value.compactionUiThreshold ?? null,
      targetConstructedContext: limits.value.targetConstructedContext ?? null,
      maxMessageLength: limits.value.maxMessageLength ?? null,
      maxTokens: limits.value.maxTokens ?? null,
      iconAssetId:
        typeof body.iconAssetId === 'string' && body.iconAssetId.trim()
          ? body.iconAssetId.trim()
          : null,
      ...fallback.value,
    };

    if (!input.name || !input.displayName || !input.baseUrl || !input.apiKey || !input.modelName) {
      return json({ error: 'Missing required fields' }, { status: 400 });
    }

    const limitDefaults = resolveProviderLimitDefaults({
      modelName: input.modelName,
      maxModelContext: input.maxModelContext,
      maxMessageLength: input.maxMessageLength,
    });
    input.maxModelContext = limitDefaults.maxModelContext;
    input.maxMessageLength = limitDefaults.maxMessageLength;

    if (body.reasoningEffort && !input.reasoningEffort) {
      return json({ error: 'Invalid reasoning effort' }, { status: 400 });
    }

    if (body.thinkingType && !input.thinkingType) {
      return json({ error: 'Invalid thinking type' }, { status: 400 });
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(input.name)) {
      return json({ error: 'Name must contain only letters, numbers, underscores, and hyphens' }, { status: 400 });
    }

    const limitOrderingError = validateProviderLimitConfiguration({
      enabled: input.enabled,
      maxModelContext: input.maxModelContext,
      compactionUiThreshold: input.compactionUiThreshold,
      targetConstructedContext: input.targetConstructedContext,
      maxTokens: input.maxTokens,
    });
    if (limitOrderingError) {
      return json({ error: limitOrderingError }, { status: 400 });
    }

    const fallbackConfigurationError = validateProviderRateLimitFallbackConfiguration({
      enabled: input.rateLimitFallbackEnabled ?? false,
      baseUrl: input.rateLimitFallbackBaseUrl,
      modelName: input.rateLimitFallbackModelName,
      apiKeyAvailable:
        typeof input.rateLimitFallbackApiKey === 'string' &&
        input.rateLimitFallbackApiKey.trim().length > 0,
      timeoutMs: input.rateLimitFallbackTimeoutMs,
    });
    if (fallbackConfigurationError) {
      return json({ error: fallbackConfigurationError }, { status: 400 });
    }

    const connectionTest = await validateProviderConnection(input.baseUrl, input.apiKey, {
      modelName: input.modelName,
      reasoningEffort: input.reasoningEffort,
      thinkingType: input.thinkingType,
    });
    if (!connectionTest.valid) {
      return json({ error: connectionTest.error }, { status: 400 });
    }
    input.capabilities = connectionTest.capabilities ?? null;

    if (input.rateLimitFallbackEnabled) {
      if (!input.rateLimitFallbackBaseUrl || !input.rateLimitFallbackApiKey) {
        return json({ error: 'Rate-limit fallback configuration is incomplete' }, { status: 400 });
      }
      const fallbackConnectionTest = await validateProviderConnection(
        input.rateLimitFallbackBaseUrl,
        input.rateLimitFallbackApiKey,
        { modelName: input.rateLimitFallbackModelName }
      );
      if (!fallbackConnectionTest.valid) {
        return json({ error: fallbackConnectionTest.error }, { status: 400 });
      }
    }

    const provider = await createProvider(input);
    clearProvidersCache();
    await refreshConfig();
    return json({ provider }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE constraint')) {
      return json({ error: 'A provider with this name already exists' }, { status: 409 });
    }
    console.error('[ADMIN] Failed to create provider:', error);
    return json({ error: 'Failed to create provider' }, { status: 500 });
  }
};
