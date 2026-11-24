import {
	MEMORY_KINDS,
	type MemoryScope,
	memorySubjectsFor,
} from "$lib/memory-types";

export class NativeMemoryError extends Error {
	constructor(
		public code: string,
		public retryable: boolean,
		/**
		 * For the job's failure policy (`delivery-policy.ts`): when a wait on
		 * Hindsight began, and how long to hold the job back before its next
		 * attempt. Numbers only, never content.
		 */
		public details: { waitStartedAt?: number; retryAfterMs?: number } = {},
	) {
		super(code);
		this.name = "NativeMemoryError";
	}
}

export const HINDSIGHT_ENGINE_COMMIT =
	"9fb28dbd724dc1ce4da7cb4c49008e601db76c5f";
export const NATIVE_DELIVERY_ATTEMPT_LIMIT = 3;

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
	/** A raw fact's tags: its document's, plus `kind:` and `subject:` from extraction (config 2). */
	tags?: string[];
	/** When the fact's event happened or will happen, when Hindsight dated it. */
	occurred_start?: string | null;
	occurred_end?: string | null;
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
/**
 * Config 1: what the previous release configured, byte for byte. A bank whose
 * stored version is `HINDSIGHT_ENGINE_COMMIT` holds it and is upgraded to
 * config 2 by its next delivery or curation; paths that only verify accept it.
 */
export const PREVIOUS_NATIVE_BANK_CONFIG = {
	retain_mission:
		"Remember useful user-stated personal facts, preferences, constraints, plans and project decisions. Preserve speaker identity, ownership, negation, uncertainty, dates and project scope. Questions, quotations, fictional characters and hypothetical examples are not assertions about the user. Keep explicit personal statements inside questions. Preserve each independently useful preference, including language register. Do not turn interest into ownership. Application source-edit events contain before/after text. The before text and unchanged portions of the after text are old context, NOT new assertions. Extract only the claims actually changed by that explicit edit. Preserve all subject/project distinctions. Ordinary user messages remain ordinary evidence. A correction or source edit is an explicit assertion at its event time; reprocessing does not make it newer.",
	observations_mission:
		"Maintain a readable list of currently supported personal and project information. Each observation should state one subject and one facet clearly, preserving attribution, uncertainty and scope. Include each independently useful fact from the evidence, including relationships, preferences, possessions and explicit plans. Use the latest applicable assertion date, not ingestion order. For a correction, state only the corrected information; do not narrate earlier erroneous or superseded values or invent a real-world change. Keep genuinely historical events and future plans explicitly dated as history or plans, not present state. Preserve unaffected facts when another property changes. Do not infer ownership from questions. Do not combine unrelated facets into a profile paragraph.",
	enable_observations: true,
	default_observation_scopes: "shared",
	retain_extraction_mode: "concise",
	consolidation_llm_batch_size: 1,
} as const;

/** Stored in `memory_banks.native_config_version` once a bank's config 2 is verified. */
export const NATIVE_BANK_CONFIG_VERSION = "alfyai-bank-config-2";
/** Whether a stored version names a config that was verified by readback. */
export function isVerifiedNativeBankConfigVersion(
	version: string | null,
): boolean {
	return (
		version === NATIVE_BANK_CONFIG_VERSION ||
		version === HINDSIGHT_ENGINE_COMMIT
	);
}

/**
 * The words Hindsight's extractor reads for each label (`entity_labels`), and
 * the classifier reads too, so both label the same way. Model-facing: ASCII
 * English with no language named (ruling 79). Kind leans toward lasting: a
 * wrongly lasting entry stays visible and can be removed, a wrongly temporary
 * one silently drops out of recall.
 */
export const NATIVE_KIND_LABEL = {
	description:
		"How this fact ages over time. When unsure, choose lasting. Choose by what the fact says, never by how recently it was said.",
	values: {
		lasting:
			"Stays true until something replaces it: who the person is, family and relationships, languages, values, beliefs, long-held tastes and preferences, possessions, lasting health conditions, and their current situation, such as where they live, the school or university they attend, what they study, where they work and their family home. For a project: its goals, decisions, requirements, people, facts and figures.",
		ongoing:
			"An activity the person themselves keeps doing for weeks or months, which will end: writing a thesis, building an app, a house or a business, learning an instrument or a tool, a training plan, a renovation. Being enrolled somewhere, having a job, and a project's goals, decisions, people, facts and figures are lasting, not ongoing.",
		temporary:
			"A state or event with a natural end: being ill, an injury, a toothache, an exam, a trip, a visit, an appointment, a deadline, plans for one particular day or week.",
	},
} as const;
export const NATIVE_SUBJECT_LABEL = {
	personal: {
		description:
			"What the fact is about, to group the person's memories. Choose the closest subject; choose other only when none fits.",
		values: {
			about_you:
				"The person themselves: name, age, birthday, identity, languages, personality, values, beliefs, looks.",
			home_family:
				"Where they live, their home and household, their partner, children, parents, relatives and pets.",
			work_study:
				"Their job, employer, colleagues, career, school, university, courses, exams and studies.",
			health:
				"Physical and mental health: illnesses, injuries, treatments, medication, diet needs, fitness and sleep.",
			projects:
				"Things they build, write, organize or work towards outside their job or studies.",
			interests:
				"Hobbies, tastes and preferences, favorite things, books, films, music, sports, travel, food and drink.",
			other: "Anything that fits none of the subjects above.",
		},
	},
	project: {
		description:
			"What the fact is about within this project, to group the project's memories. Choose the closest subject; choose other only when none fits.",
		values: {
			goals_decisions:
				"What the project aims for and what was decided: goals, requirements, choices made and their reasons.",
			people:
				"People involved in the project: who they are, their roles and responsibilities, how to work with them.",
			facts_figures:
				"Facts and figures of the project: names, numbers, dates, prices, settings and technical details.",
			plans_status:
				"Plans, next steps, schedules, deadlines and the current progress or state of the work.",
			other: "Anything about the project that fits none of the subjects above.",
		},
	},
} as const;

export interface NativeLabelGroup {
	key: string;
	description: string;
	type: "value";
	optional: boolean;
	tag: boolean;
	values: Array<{ value: string; description: string }>;
}
export interface NativeBankConfig {
	retain_mission: string;
	observations_mission: string;
	enable_observations: boolean;
	default_observation_scopes: string;
	retain_extraction_mode: string;
	consolidation_llm_batch_size: number;
	/** `null` clears the bank's labels (Hindsight's tombstone for an override). */
	entity_labels?: NativeLabelGroup[] | null;
	entities_allow_free_form?: boolean;
}

function labelGroup(
	key: string,
	label: { description: string; values: Record<string, string> },
	order: readonly string[],
): NativeLabelGroup {
	return {
		key,
		description: label.description,
		type: "value",
		optional: true,
		tag: true,
		values: order.map((value) => ({
			value,
			description: label.values[value],
		})),
	};
}

/**
 * Config 2 for a bank of this kind: config 1's missions with part 2's
 * sentences, and the two labels Hindsight writes into each new fact's tags.
 */
export function nativeBankConfig(
	kind: MemoryScope["kind"],
): NativeBankConfig & { entity_labels: NativeLabelGroup[] } {
	return {
		...PREVIOUS_NATIVE_BANK_CONFIG,
		retain_mission: `${PREVIOUS_NATIVE_BANK_CONFIG.retain_mission} Requests to the assistant and what the user wants from this chat are not memories, for example not "The user needs a name for a band" or "The user is looking for a weekend trip". While the user and the assistant brainstorm or weigh options, the options, the user's reactions to them and the reasons for those reactions are not memories either, for example not "The user thinks Static Owls sounds too silly" or "The user finds the second flat too small". A lasting fact about the user stated along the way, such as an allergy or where they live, is still a memory; a liking or dislike of one of the options is not. When the choice settles, keep only its outcome, and only if it is likely to matter beyond this chat, for example "The user's band is called Low Tide".`,
		observations_mission: `${PREVIOUS_NATIVE_BANK_CONFIG.observations_mission} When a later statement settles an earlier wish or plan about the same thing, keep only the settled state. When something really changes in the world, such as a move or a new job, state the new value as current and keep the old value only as earlier history in the same observation; never write an end date or any date the person did not state.`,
		// Pinned so a changed engine default cannot switch a bank to labels-only
		// extraction, which would drop every named entity.
		entities_allow_free_form: true,
		entity_labels: [
			labelGroup("kind", NATIVE_KIND_LABEL, MEMORY_KINDS),
			labelGroup(
				"subject",
				NATIVE_SUBJECT_LABEL[kind],
				memorySubjectsFor(kind),
			),
		],
	};
}
export function nativeBankConfigForScopeKey(scopeKey: string) {
	return nativeBankConfig(scopeKey === "personal" ? "personal" : "project");
}
export const CURRENT_NATIVE_BANK_CONFIGS: readonly NativeBankConfig[] = [
	nativeBankConfig("personal"),
	nativeBankConfig("project"),
];
/** Every config this app has set: what a path that only verifies accepts. */
export const KNOWN_NATIVE_BANK_CONFIGS: readonly NativeBankConfig[] = [
	PREVIOUS_NATIVE_BANK_CONFIG,
	...CURRENT_NATIVE_BANK_CONFIGS,
];
