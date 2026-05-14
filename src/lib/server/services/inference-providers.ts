import {
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { inferenceProviders } from '../db/schema';
import { config } from '../env';
import {
  deriveMaxMessageLengthFromContextTokens,
  getKnownModelLimitPreset,
} from '$lib/model-limit-presets';
import { buildOpenAICompatibleUrl } from './openai-compatible-url';

export type ProviderReasoningEffort = 'low' | 'medium' | 'high' | 'max' | 'xhigh';
export type ProviderThinkingType = 'enabled' | 'disabled';
const FIRE_PASS_KEY_PREFIX = 'fpk_';
const FIRE_PASS_MODEL_NAME = 'accounts/fireworks/routers/kimi-k2p6-turbo';

export interface InferenceProvider {
  id: string;
  name: string;
  displayName: string;
  baseUrl: string;
  modelName: string;
  reasoningEffort: ProviderReasoningEffort | null;
  thinkingType: ProviderThinkingType | null;
  enabled: boolean;
  sortOrder: number;
  maxModelContext: number | null;
  compactionUiThreshold: number | null;
  targetConstructedContext: number | null;
  maxMessageLength: number | null;
  maxTokens: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface InferenceProviderWithSecrets extends InferenceProvider {
  apiKeyEncrypted: string;
  apiKeyIv: string;
}

export interface CreateProviderInput {
  name: string;
  displayName: string;
  baseUrl: string;
  apiKey: string;
  modelName: string;
  reasoningEffort?: ProviderReasoningEffort | null;
  thinkingType?: ProviderThinkingType | null;
  enabled?: boolean;
  sortOrder?: number;
  maxModelContext?: number | null;
  compactionUiThreshold?: number | null;
  targetConstructedContext?: number | null;
  maxMessageLength?: number | null;
  maxTokens?: number | null;
}

export interface UpdateProviderInput {
  displayName?: string;
  baseUrl?: string;
  apiKey?: string;
  modelName?: string;
  reasoningEffort?: ProviderReasoningEffort | null;
  thinkingType?: ProviderThinkingType | null;
  enabled?: boolean;
  sortOrder?: number;
  maxModelContext?: number | null;
  compactionUiThreshold?: number | null;
  targetConstructedContext?: number | null;
  maxMessageLength?: number | null;
  maxTokens?: number | null;
}

export type ProviderLimitInput = {
  maxModelContext?: unknown;
  compactionUiThreshold?: unknown;
  targetConstructedContext?: unknown;
  maxMessageLength?: unknown;
  maxTokens?: unknown;
};

export type NormalizedProviderLimits = {
  maxModelContext?: number | null;
  compactionUiThreshold?: number | null;
  targetConstructedContext?: number | null;
  maxMessageLength?: number | null;
  maxTokens?: number | null;
};

export function parseProviderLimitOverrides(input: ProviderLimitInput): {
  ok: true;
  value: NormalizedProviderLimits;
} | {
  ok: false;
  error: string;
} {
  const normalized: NormalizedProviderLimits = {};

  const parseOptionalNumber = (
    key: keyof ProviderLimitInput,
    min: number,
    label: string
  ): { ok: true; value: number | null | undefined } | { ok: false; error: string } => {
    const value = input[key];
    if (value === undefined) return { ok: true, value: undefined };
    if (value === null || value === '') return { ok: true, value: null };
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
      return { ok: false, error: `${label} must be an integer` };
    }
    if (value < min) {
      return { ok: false, error: `${label} must be at least ${min}` };
    }
    return { ok: true, value };
  };

  const maxModelContext = parseOptionalNumber('maxModelContext', 1000, 'Max model context');
  if (!maxModelContext.ok) return maxModelContext;
  if (maxModelContext.value !== undefined) normalized.maxModelContext = maxModelContext.value;

  const compactionUiThreshold = parseOptionalNumber(
    'compactionUiThreshold',
    1000,
    'Compaction UI threshold'
  );
  if (!compactionUiThreshold.ok) return compactionUiThreshold;
  if (compactionUiThreshold.value !== undefined) {
    normalized.compactionUiThreshold = compactionUiThreshold.value;
  }

  const targetConstructedContext = parseOptionalNumber(
    'targetConstructedContext',
    1000,
    'Target constructed context'
  );
  if (!targetConstructedContext.ok) return targetConstructedContext;
  if (targetConstructedContext.value !== undefined) {
    normalized.targetConstructedContext = targetConstructedContext.value;
  }

  const maxMessageLength = parseOptionalNumber('maxMessageLength', 1, 'Max message length');
  if (!maxMessageLength.ok) return maxMessageLength;
  if (maxMessageLength.value !== undefined) normalized.maxMessageLength = maxMessageLength.value;

  const maxTokens = parseOptionalNumber('maxTokens', 1, 'Max tokens');
  if (!maxTokens.ok) return maxTokens;
  if (maxTokens.value !== undefined) normalized.maxTokens = maxTokens.value;

  return { ok: true, value: normalized };
}

export function validateProviderLimitOrdering(input: {
  maxModelContext: number | null;
  compactionUiThreshold: number | null;
  targetConstructedContext: number | null;
  maxTokens?: number | null;
}): string | null {
  const {
    maxModelContext,
    compactionUiThreshold,
    targetConstructedContext,
    maxTokens = null,
  } = input;
  if (
    maxModelContext !== null &&
    compactionUiThreshold !== null &&
    compactionUiThreshold >= maxModelContext
  ) {
    return 'Compaction UI threshold must be less than max model context';
  }
  if (
    maxModelContext !== null &&
    targetConstructedContext !== null &&
    targetConstructedContext >= maxModelContext
  ) {
    return 'Target constructed context must be less than max model context';
  }
  if (
    maxModelContext !== null &&
    maxTokens !== null &&
    maxTokens >= maxModelContext
  ) {
    return 'Max tokens must be less than max model context';
  }
  return null;
}

export function validateProviderLimitConfiguration(input: {
  enabled?: boolean;
  maxModelContext: number | null;
  compactionUiThreshold: number | null;
  targetConstructedContext: number | null;
  maxTokens?: number | null;
}): string | null {
  if (input.enabled !== false && input.maxModelContext === null) {
    return 'Max model context is required';
  }

  return validateProviderLimitOrdering(input);
}

export function resolveProviderLimitDefaults(input: {
  modelName: string;
  maxModelContext: number | null;
  maxMessageLength: number | null;
}): {
  maxModelContext: number | null;
  maxMessageLength: number | null;
} {
  const preset = getKnownModelLimitPreset(input.modelName);
  const maxModelContext = input.maxModelContext ?? preset?.maxModelContext ?? null;
  const maxMessageLength =
    input.maxMessageLength ??
    preset?.maxMessageLength ??
    (maxModelContext != null
      ? deriveMaxMessageLengthFromContextTokens(maxModelContext)
      : null);

  return { maxModelContext, maxMessageLength };
}

export function normalizeReasoningEffort(value: unknown): ProviderReasoningEffort | null {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'max' || value === 'xhigh' ? value : null;
}

export function normalizeThinkingType(value: unknown): ProviderThinkingType | null {
  return value === 'enabled' || value === 'disabled' ? value : null;
}

function deriveEncryptionKey(secret: string): Buffer {
  return pbkdf2Sync(secret, 'alfaai-inference-providers', 100000, 32, 'sha256');
}

export function encryptApiKey(plaintext: string): { encrypted: string; iv: string } {
  const sessionSecret = config.sessionSecret;
  const key = deriveEncryptionKey(sessionSecret);
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    encrypted: Buffer.concat([encrypted, authTag]).toString('base64'),
    iv: iv.toString('base64'),
  };
}

export function decryptApiKey(encrypted: string, iv: string): string {
  const sessionSecret = config.sessionSecret;
  const key = deriveEncryptionKey(sessionSecret);
  const ivBuffer = Buffer.from(iv, 'base64');
  const encryptedBuffer = Buffer.from(encrypted, 'base64');
  const authTag = encryptedBuffer.slice(-16);
  const ciphertext = encryptedBuffer.slice(0, -16);
  const decipher = createDecipheriv('aes-256-gcm', key, ivBuffer);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext).toString('utf8') + decipher.final('utf8');
}

export async function createProvider(input: CreateProviderInput): Promise<InferenceProvider> {
  const { encrypted, iv } = encryptApiKey(input.apiKey);
  const now = new Date();

  const [provider] = await db
    .insert(inferenceProviders)
    .values({
      id: randomUUID(),
      name: input.name,
      displayName: input.displayName,
      baseUrl: input.baseUrl,
      apiKeyEncrypted: encrypted,
      apiKeyIv: iv,
      modelName: input.modelName,
      reasoningEffort: input.reasoningEffort ?? null,
      thinkingType: input.thinkingType ?? null,
      enabled: input.enabled ?? true,
      sortOrder: input.sortOrder ?? 0,
      maxModelContext: input.maxModelContext ?? null,
      compactionUiThreshold: input.compactionUiThreshold ?? null,
      targetConstructedContext: input.targetConstructedContext ?? null,
      maxMessageLength: input.maxMessageLength ?? null,
      maxTokens: input.maxTokens ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return mapRowToProvider(provider);
}

export async function getProvider(id: string): Promise<InferenceProvider | null> {
  const [provider] = await db
    .select()
    .from(inferenceProviders)
    .where(eq(inferenceProviders.id, id));

  return provider ? mapRowToProvider(provider) : null;
}

export async function getProviderWithSecrets(id: string): Promise<InferenceProviderWithSecrets | null> {
  const [provider] = await db
    .select()
    .from(inferenceProviders)
    .where(eq(inferenceProviders.id, id));

  return provider ? mapRowToProviderWithSecrets(provider) : null;
}

export async function getProviderByName(name: string): Promise<InferenceProvider | null> {
  const [provider] = await db
    .select()
    .from(inferenceProviders)
    .where(eq(inferenceProviders.name, name));

  return provider ? mapRowToProvider(provider) : null;
}

export async function listProviders(): Promise<InferenceProvider[]> {
  const providers = await db
    .select()
    .from(inferenceProviders)
    .orderBy(inferenceProviders.sortOrder);

  return providers.map(mapRowToProvider);
}

export async function listEnabledProviders(): Promise<InferenceProvider[]> {
  const providers = await db
    .select()
    .from(inferenceProviders)
    .where(eq(inferenceProviders.enabled, true))
    .orderBy(inferenceProviders.sortOrder);

  return providers.map(mapRowToProvider);
}

export async function updateProvider(
  id: string,
  input: UpdateProviderInput
): Promise<InferenceProvider | null> {
  const existing = await db
    .select()
    .from(inferenceProviders)
    .where(eq(inferenceProviders.id, id));

  if (!existing[0]) {
    return null;
  }

  const updates: Partial<typeof inferenceProviders.$inferInsert> = {
    updatedAt: new Date(),
  };

  if (input.displayName !== undefined) {
    updates.displayName = input.displayName;
  }
  if (input.baseUrl !== undefined) {
    updates.baseUrl = input.baseUrl;
  }
  if (input.modelName !== undefined) {
    updates.modelName = input.modelName;
  }
  if (input.reasoningEffort !== undefined) {
    updates.reasoningEffort = input.reasoningEffort;
  }
  if (input.thinkingType !== undefined) {
    updates.thinkingType = input.thinkingType;
  }
  if (input.enabled !== undefined) {
    updates.enabled = input.enabled;
  }
  if (input.sortOrder !== undefined) {
    updates.sortOrder = input.sortOrder;
  }
  if (input.apiKey !== undefined) {
    const { encrypted, iv } = encryptApiKey(input.apiKey);
    updates.apiKeyEncrypted = encrypted;
    updates.apiKeyIv = iv;
  }
  if (input.maxModelContext !== undefined) {
    updates.maxModelContext = input.maxModelContext;
  }
  if (input.compactionUiThreshold !== undefined) {
    updates.compactionUiThreshold = input.compactionUiThreshold;
  }
  if (input.targetConstructedContext !== undefined) {
    updates.targetConstructedContext = input.targetConstructedContext;
  }
  if (input.maxMessageLength !== undefined) {
    updates.maxMessageLength = input.maxMessageLength;
  }
  if (input.maxTokens !== undefined) {
    updates.maxTokens = input.maxTokens;
  }

  const [updated] = await db
    .update(inferenceProviders)
    .set(updates)
    .where(eq(inferenceProviders.id, id))
    .returning();

  return updated ? mapRowToProvider(updated) : null;
}

export async function deleteProvider(id: string): Promise<boolean> {
  const result = await db
    .delete(inferenceProviders)
    .where(eq(inferenceProviders.id, id));

  return result.changes > 0;
}

export async function validateProviderConnection(
  baseUrl: string,
  apiKey: string,
  options: { modelName?: string | null } = {}
): Promise<{ valid: boolean; error?: string }> {
  try {
    const url = new URL(baseUrl);
    if (!url.protocol.startsWith('http')) {
      return { valid: false, error: 'Base URL must use HTTP or HTTPS protocol' };
    }

    const isFirePassKey = apiKey.trim().startsWith(FIRE_PASS_KEY_PREFIX);
    if (isFirePassKey && isFireworksHost(url)) {
      const modelName = options.modelName?.trim().toLowerCase() ?? '';
      if (modelName !== FIRE_PASS_MODEL_NAME) {
        return {
          valid: false,
          error: `Fire Pass keys only work with ${FIRE_PASS_MODEL_NAME}`,
        };
      }

      return { valid: true };
    }

    const modelsUrl = buildOpenAICompatibleUrl(baseUrl, '/v1/models');
    const response = await fetch(modelsUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return { valid: false, error: 'Invalid API key' };
      }
      return { valid: false, error: `Server returned ${response.status}` };
    }

    return { valid: true };
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === 'TimeoutError') {
        return { valid: false, error: 'Connection timeout' };
      }
      return { valid: false, error: error.message };
    }
    return { valid: false, error: 'Unknown error' };
  }
}

function isFireworksHost(url: URL): boolean {
  return url.hostname === 'fireworks.ai' || url.hostname.endsWith('.fireworks.ai');
}

function mapRowToProvider(row: typeof inferenceProviders.$inferSelect): InferenceProvider {
  return {
    id: row.id,
    name: row.name,
    displayName: row.displayName,
    baseUrl: row.baseUrl,
    modelName: row.modelName,
    reasoningEffort: normalizeReasoningEffort(row.reasoningEffort),
    thinkingType: normalizeThinkingType(row.thinkingType),
    enabled: row.enabled ?? true,
    sortOrder: row.sortOrder ?? 0,
    maxModelContext: row.maxModelContext ?? null,
    compactionUiThreshold: row.compactionUiThreshold ?? null,
    targetConstructedContext: row.targetConstructedContext ?? null,
    maxMessageLength: row.maxMessageLength ?? null,
    maxTokens: row.maxTokens ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapRowToProviderWithSecrets(
  row: typeof inferenceProviders.$inferSelect
): InferenceProviderWithSecrets {
  return {
    ...mapRowToProvider(row),
    apiKeyEncrypted: row.apiKeyEncrypted,
    apiKeyIv: row.apiKeyIv,
  };
}
