export class NativeMemoryError extends Error {
	constructor(
		public code: string,
		public retryable: boolean,
	) {
		super(code);
		this.name = "NativeMemoryError";
	}
}

export const HINDSIGHT_ENGINE_COMMIT =
	"9fb28dbd724dc1ce4da7cb4c49008e601db76c5f";

// These sentinels cannot collide with native UUID operation identities. Reset
// copies them into its cleanup intent before removing the old local bank.
export const NATIVE_BANK_CONFIG_PENDING = "alfyai-bank-config-pending";
export const NATIVE_BANK_CONFIG_LEGACY_UNKNOWN =
	"alfyai-bank-config-legacy-unknown";
export interface NativeMemory {
	id: string;
	text: string;
	fact_type: string;
	document_id?: string | null;
	mentioned_at?: string | null;
	source_memory_ids?: string[];
	state?: string;
	consolidated_at?: string | null;
	consolidation_failed_at?: string | null;
}
export interface NativeOperation {
	id: string;
	status: string;
}
export interface RetainSource {
	content: string;
	context: string;
	timestamp: string;
	document_id: string;
	tags: string[];
	metadata: Record<string, string>;
}
export const EXPLICIT_EDIT_RETENTION_GUIDANCE =
	"Explicit memory edit. Extract only new or changed user assertions from after. Before and unchanged wording serve only to identify those assertions. If a property of an already owned object changes, state the focused property claim and use a possessive to identify the object. For 'I own a blue bicycle' changed to 'I own a red bicycle', state 'The user's bicycle is red' and leave the existing ownership assertion at its old date. Keep genuinely new claims separate. In every output field, including why and entity annotations, exclude editorial commentary, superseded values, and omitted details. Keep causal reasons and other details that the user actually asserts as part of a changed claim in after. Preserve explicit negation.";
export const NATIVE_BANK_CONFIG = {
	retain_mission:
		"Remember useful user-stated personal facts, preferences, constraints, plans and project decisions. Preserve speaker identity, ownership, negation, uncertainty, dates and project scope. Questions, quotations, fictional characters and hypothetical examples are not assertions about the user. Keep explicit personal statements inside questions. Preserve each independently useful preference, including language register. Do not turn interest into ownership. Application source-edit events contain before/after text. The before text and unchanged portions of the after text are old context, NOT new assertions. Extract only the claims actually changed by that explicit edit. Preserve all subject/project distinctions. Ordinary user messages remain ordinary evidence. A correction or source edit is an explicit assertion at its event time; reprocessing does not make it newer.",
	observations_mission:
		"Maintain a readable list of currently supported personal and project information. Each observation should state one subject and one facet clearly, preserving attribution, uncertainty and scope. Include each independently useful fact from the evidence, including relationships, preferences, possessions and explicit plans. Use the latest applicable assertion date, not ingestion order. For a correction, state only the corrected information; do not narrate earlier erroneous or superseded values or invent a real-world change. Keep genuinely historical events and future plans explicitly dated as history or plans, not present state. Preserve unaffected facts when another property changes. Do not infer ownership from questions. Do not combine unrelated facets into a profile paragraph.",
	enable_observations: true,
	default_observation_scopes: "shared",
	retain_extraction_mode: "concise",
	consolidation_llm_batch_size: 1,
} as const;
