import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/auth/hooks';
import { clearProvidersCache, refreshConfig } from '$lib/server/config-store';
import { getProviderWithSecrets, updateProvider, validateProviderConnection } from '$lib/server/services/inference-providers';

export const POST: RequestHandler = async (event) => {
  try {
    requireAdmin(event);
    const { id } = event.params;

    const provider = await getProviderWithSecrets(id);

    if (!provider) {
      return json({ error: 'Provider not found' }, { status: 404 });
    }

    const { decryptApiKey } = await import('$lib/server/services/inference-providers');

    let apiKey: string;
    try {
      apiKey = decryptApiKey(provider.apiKeyEncrypted, provider.apiKeyIv);
    } catch {
      return json({ valid: false, error: 'Failed to decrypt API key' });
    }

    const result = await validateProviderConnection(provider.baseUrl, apiKey, {
      modelName: provider.modelName,
      reasoningEffort: provider.reasoningEffort,
      thinkingType: provider.thinkingType,
    });
    if (result.capabilities) {
      await updateProvider(id, { capabilities: result.capabilities });
      clearProvidersCache();
      await refreshConfig();
    }
    return json(result);
  } catch (error) {
    console.error('[ADMIN] Failed to validate provider:', error);
    return json({ error: 'Failed to validate provider' }, { status: 500 });
  }
};
