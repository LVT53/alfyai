// Continue / Revise / Fork seeding for Atlas v2 (ADR 0062).
//
// The lifecycle machinery itself is v1's and unchanged: `checkpoints.ts` builds
// the family metadata and loads the parent's latest checkpoint. This module is
// the v2 reading of that payload — what the parent's plan and evidence index
// were — plus the writing side, so a v2 job's final checkpoint is seedable by
// its own children.

import type { AtlasLifecycleContext } from "../atlas/types";
import type {
	AtlasV2EvidenceIndex,
	AtlasV2IndexedSource,
	AtlasV2Plan,
} from "./types";
import { ATLAS_V2_CHECKPOINT_SCHEMA_VERSION } from "./types";

export interface AtlasV2LifecycleSeed {
	parentAtlasJobId: string;
	/** Questions the parent researched, as plan seed text. */
	questions: string[];
	/** Section titles the parent published, for lineage continuity. */
	sections: string[];
	/**
	 * The parent's evidence index, when the action carries the source pool
	 * (Continue and Revise do; Fork deliberately re-researches).
	 */
	evidenceIndex: AtlasV2EvidenceIndex | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function stringArray(value: unknown, maxItems: number): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((entry) =>
			typeof entry === "string" ? entry.replace(/\s+/g, " ").trim() : "",
		)
		.filter(Boolean)
		.slice(0, maxItems);
}

function parseSeededSource(value: unknown): AtlasV2IndexedSource | null {
	if (!isRecord(value)) return null;
	const n = typeof value.n === "number" ? Math.trunc(value.n) : 0;
	const canonicalUrl =
		typeof value.canonicalUrl === "string" ? value.canonicalUrl : "";
	const host = typeof value.host === "string" ? value.host : "";
	if (n < 1 || !canonicalUrl || !host) return null;
	return {
		n,
		canonicalUrl,
		host,
		organisation:
			typeof value.organisation === "string" ? value.organisation : host,
		title: typeof value.title === "string" ? value.title : host,
		date: typeof value.date === "string" ? value.date : null,
		snippets: stringArray(value.snippets, 6),
		pageExcerpt:
			typeof value.pageExcerpt === "string" ? value.pageExcerpt : null,
		questionIds: stringArray(value.questionIds, 24),
	};
}

/**
 * Reads the v2 seed out of the parent's checkpoint. Returns null for a parent
 * that ran on v1 — a v2 child of a v1 parent starts from scratch rather than
 * misreading v1's evidence packs as an evidence index.
 */
export function extractAtlasV2LifecycleSeed(
	lifecycle: AtlasLifecycleContext,
): AtlasV2LifecycleSeed | null {
	const seed = lifecycle.seed;
	if (!seed) return null;
	const findings = seed.compressedFindings;
	if (!isRecord(findings)) return null;
	if (findings.schema !== ATLAS_V2_CHECKPOINT_SCHEMA_VERSION) return null;

	const plan = isRecord(findings.plan) ? findings.plan : {};
	const questions = Array.isArray(plan.questions)
		? plan.questions
				.map((entry) =>
					isRecord(entry) && typeof entry.question === "string"
						? entry.question
						: "",
				)
				.filter(Boolean)
		: [];
	const sections = Array.isArray(plan.sections)
		? plan.sections
				.map((entry) =>
					isRecord(entry) && typeof entry.title === "string" ? entry.title : "",
				)
				.filter(Boolean)
		: [];

	const pool = seed.curatedSourcePool;
	const seededSources =
		isRecord(pool) && Array.isArray(pool.v2Sources)
			? pool.v2Sources
					.map(parseSeededSource)
					.filter((source): source is AtlasV2IndexedSource => source !== null)
			: [];
	const byQuestion: Record<string, number[]> = {};
	for (const source of seededSources) {
		for (const questionId of source.questionIds) {
			const existing = byQuestion[questionId];
			if (existing) existing.push(source.n);
			else byQuestion[questionId] = [source.n];
		}
	}

	return {
		parentAtlasJobId: seed.parentAtlasJobId,
		questions: questions.slice(0, 24),
		sections: sections.slice(0, 12),
		evidenceIndex:
			seededSources.length > 0
				? {
						sources: seededSources,
						dropped: [],
						filteredCount: 0,
						byQuestion,
					}
				: null,
	};
}

/** The `compressedFindings` a v2 job writes so its children can seed from it. */
export function buildAtlasV2CompressedFindings(input: {
	plan: AtlasV2Plan;
	query: string;
}): Record<string, unknown> {
	return {
		schema: ATLAS_V2_CHECKPOINT_SCHEMA_VERSION,
		query: input.query,
		plan: {
			questions: input.plan.questions,
			sections: input.plan.sections.map((section) => ({
				id: section.id,
				title: section.title,
				brief: section.brief,
				questionIds: section.questionIds,
			})),
		},
	};
}

/** The `curatedSourcePool` a v2 job writes for Continue/Revise. */
export function buildAtlasV2CuratedSourcePool(
	index: AtlasV2EvidenceIndex,
): Record<string, unknown> {
	return { v2Sources: index.sources };
}
