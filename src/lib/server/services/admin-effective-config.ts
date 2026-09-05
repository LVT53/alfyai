// Effective-configuration readout for the admin System pane: for every admin
// config key, where the running value comes from (admin_config row, process
// env, or the built-in default) with secrets masked. Also reports how the bare
// `model1` / `model2` keys currently resolve so an admin can see when an
// admin_config override is shadowed by an enabled `providers` row.

import {
	ADMIN_CONFIG_KEYS,
	type AdminConfigKey,
	getConfig,
	getEnvDefaults,
	getResolvedAdminConfigValues,
} from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { adminConfig } from "$lib/server/db/schema";
import { resolveNormalChatModelRunProvider } from "$lib/server/services/normal-chat-model";
import { getProviderByName } from "$lib/server/services/providers";

export type EffectiveConfigSource = "admin_config" | "env" | "default";

export interface EffectiveConfigEntry {
	key: AdminConfigKey;
	envValue: string;
	adminOverride: string | null;
	effectiveValue: string;
	source: EffectiveConfigSource;
	secret: boolean;
}

export interface BuiltinModelResolution {
	key: "model1" | "model2";
	providerRowFound: boolean;
	providerEnabled: boolean;
	resolvedModelId: string | null;
	resolvedModelName: string | null;
	resolvedBaseUrl: string | null;
	// "providers_table" when an enabled `providers` row named model1/model2
	// wins; "admin_config_env" when the MODEL_N_* keys are what actually run.
	resolvedFrom: "providers_table" | "admin_config_env" | "unresolved";
	// True when MODEL_N_* admin overrides exist but a providers row shadows them.
	shadowedOverrides: AdminConfigKey[];
	error: string | null;
}

export interface EffectiveConfigReport {
	generatedAt: string;
	entries: EffectiveConfigEntry[];
	models: BuiltinModelResolution[];
}

export const SECRET_MASK = "[set]";

// Superset of the masking config-store applies in getResolvedAdminConfigValues
// (which only masks the OAuth secrets, OwnTracks password, and VAPID private
// key): every key that carries a credential is masked here.
const SECRET_KEY_PATTERN = /(API_KEY|_SECRET|_PASS$|PRIVATE_KEY|TOKEN)/;

export function isSecretConfigKey(key: string): boolean {
	return SECRET_KEY_PATTERN.test(key);
}

function maskValue(key: string, value: string | null): string | null {
	if (value === null) return null;
	if (!isSecretConfigKey(key)) return value;
	return value.trim() === "" ? "" : SECRET_MASK;
}

function readProcessEnv(key: string): string | undefined {
	const value = process.env[key];
	return value === undefined || value === "" ? undefined : value;
}

export interface EffectiveConfigDeps {
	loadOverrides: () => Promise<Record<string, string>>;
	envDefaults: () => Record<AdminConfigKey, string>;
	resolvedValues: () => Record<AdminConfigKey, string>;
	processEnv: (key: string) => string | undefined;
	resolveModel: (key: "model1" | "model2") => Promise<BuiltinModelResolution>;
	now: () => Date;
}

async function loadOverridesFromDb(): Promise<Record<string, string>> {
	const rows = await db.select().from(adminConfig);
	return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

const MODEL_OVERRIDE_KEYS: Record<"model1" | "model2", AdminConfigKey[]> = {
	model1: [
		"MODEL_1_BASEURL",
		"MODEL_1_API_KEY",
		"MODEL_1_NAME",
		"MODEL_1_DISPLAY_NAME",
		"MODEL_1_MAX_TOKENS",
		"MODEL_1_REASONING_EFFORT",
		"MODEL_1_THINKING_TYPE",
	],
	model2: [
		"MODEL_2_BASEURL",
		"MODEL_2_API_KEY",
		"MODEL_2_NAME",
		"MODEL_2_DISPLAY_NAME",
		"MODEL_2_MAX_TOKENS",
		"MODEL_2_REASONING_EFFORT",
		"MODEL_2_THINKING_TYPE",
	],
};

export async function resolveBuiltinModel(
	key: "model1" | "model2",
	overrides: Record<string, string>,
): Promise<BuiltinModelResolution> {
	const base: BuiltinModelResolution = {
		key,
		providerRowFound: false,
		providerEnabled: false,
		resolvedModelId: null,
		resolvedModelName: null,
		resolvedBaseUrl: null,
		resolvedFrom: "unresolved",
		shadowedOverrides: [],
		error: null,
	};
	try {
		const row = await getProviderByName(key);
		base.providerRowFound = Boolean(row);
		base.providerEnabled = Boolean(row?.enabled);
	} catch (error) {
		base.error = error instanceof Error ? error.message : String(error);
	}
	try {
		const provider = await resolveNormalChatModelRunProvider(key, getConfig());
		base.resolvedModelId = provider.modelId ?? provider.id;
		base.resolvedModelName = provider.modelName;
		base.resolvedBaseUrl = provider.baseUrl;
		base.resolvedFrom =
			base.providerEnabled && provider.id !== key
				? "providers_table"
				: "admin_config_env";
	} catch (error) {
		base.error = error instanceof Error ? error.message : String(error);
	}
	if (base.resolvedFrom === "providers_table") {
		base.shadowedOverrides = MODEL_OVERRIDE_KEYS[key].filter(
			(overrideKey) => overrides[overrideKey] !== undefined,
		);
	}
	return base;
}

export function buildEffectiveConfigEntries(
	overrides: Record<string, string>,
	envDefaults: Record<AdminConfigKey, string>,
	resolvedValues: Record<AdminConfigKey, string>,
	processEnv: (key: string) => string | undefined,
): EffectiveConfigEntry[] {
	return ADMIN_CONFIG_KEYS.map((key) => {
		const override = overrides[key];
		const source: EffectiveConfigSource =
			override !== undefined
				? "admin_config"
				: processEnv(key) !== undefined
					? "env"
					: "default";
		return {
			key,
			envValue: maskValue(key, envDefaults[key] ?? "") ?? "",
			adminOverride: maskValue(key, override ?? null),
			effectiveValue: maskValue(key, resolvedValues[key] ?? "") ?? "",
			source,
			secret: isSecretConfigKey(key),
		};
	});
}

export async function getEffectiveConfigReport(
	deps: Partial<EffectiveConfigDeps> = {},
): Promise<EffectiveConfigReport> {
	const overrides = await (deps.loadOverrides ?? loadOverridesFromDb)();
	const resolveModel =
		deps.resolveModel ??
		((key: "model1" | "model2") => resolveBuiltinModel(key, overrides));
	const [model1, model2] = await Promise.all([
		resolveModel("model1"),
		resolveModel("model2"),
	]);
	return {
		generatedAt: (deps.now ?? (() => new Date()))().toISOString(),
		entries: buildEffectiveConfigEntries(
			overrides,
			(deps.envDefaults ?? getEnvDefaults)(),
			(deps.resolvedValues ?? getResolvedAdminConfigValues)(),
			deps.processEnv ?? readProcessEnv,
		),
		models: [model1, model2],
	};
}
