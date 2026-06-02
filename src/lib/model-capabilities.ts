export const MODEL_CAPABILITY_KEYS = [
	"chat",
	"streaming",
	"tools",
	"structuredOutput",
	"reasoningControls",
	"usageReporting",
	"fileMessageParts",
	"imageMessageParts",
	"modelsEndpoint",
] as const;

export type ModelCapabilityKey = (typeof MODEL_CAPABILITY_KEYS)[number];

export type ModelCapabilityState =
	| "detected"
	| "not_detected"
	| "unknown"
	| "manual_override";

export type ModelCapabilitySource =
	| "models_endpoint"
	| "probe"
	| "manual_override";

export interface ModelCapabilityStatus {
	key: ModelCapabilityKey;
	state: ModelCapabilityState;
	supported: boolean | null;
	source: ModelCapabilitySource;
	detail?: string;
	checkedAt?: string;
}

export type ModelCapabilitySet = Record<
	ModelCapabilityKey,
	ModelCapabilityStatus
>;

export type ModelCapabilityOverrideInput = Partial<
	Record<ModelCapabilityKey, boolean>
>;

export function createModelCapabilitySet(
	entries: Partial<
		Record<ModelCapabilityKey, Partial<ModelCapabilityStatus>>
	> = {},
): ModelCapabilitySet {
	return Object.fromEntries(
		MODEL_CAPABILITY_KEYS.map((key) => {
			const entry = entries[key] ?? {};
			const state = entry.state ?? "unknown";
			return [
				key,
				{
					key,
					state,
					supported: resolveSupportedValue(state, entry.supported),
					source: entry.source ?? "probe",
					...(entry.detail ? { detail: entry.detail } : {}),
					...(entry.checkedAt ? { checkedAt: entry.checkedAt } : {}),
				},
			];
		}),
	) as ModelCapabilitySet;
}

function resolveSupportedValue(
	state: ModelCapabilityState,
	supported: boolean | null | undefined,
): boolean | null {
	if (state === "detected") return true;
	if (state === "not_detected") return false;
	if (state === "unknown") return null;
	return supported ?? null;
}

export function applyModelCapabilityOverrides(
	capabilities: ModelCapabilitySet,
	overrides: ModelCapabilityOverrideInput = {},
): ModelCapabilitySet {
	return Object.fromEntries(
		MODEL_CAPABILITY_KEYS.map((key) => {
			const override = overrides[key];
			if (override === undefined) return [key, capabilities[key]];

			return [
				key,
				{
					key,
					state: "manual_override",
					supported: override,
					source: "manual_override",
					detail: "Admin manual override",
					checkedAt: capabilities[key].checkedAt,
				},
			];
		}),
	) as ModelCapabilitySet;
}

export function isModelCapabilityUnsupported(
	capabilities: ModelCapabilitySet | undefined,
	key: ModelCapabilityKey,
): boolean {
	return capabilities?.[key]?.supported === false;
}

export function isModelCapabilitySupported(
	capabilities: ModelCapabilitySet | undefined,
	key: ModelCapabilityKey,
): boolean {
	return capabilities?.[key]?.supported === true;
}
