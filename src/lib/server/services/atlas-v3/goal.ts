// Atlas v3 stage 5: the goal test (ADR 0063).
//
// v2 stopped after a round count. This stops when the answer is in hand, and it
// is deliberately DETERMINISTIC — no model call, no self-evaluation. The
// literature is clear that a small model asked "is this good enough?" says yes,
// and structural checks are what actually stop a research loop at the right
// place.
//
// Three conditions, all of which must hold:
//
//   1. the core question's claims carry their key figures from at least two
//      INDEPENDENT publishers, of a tier that can corroborate;
//   2. every outline node carries at least `minEvidencePerNode` bound quotes;
//   3. the budget allows another round if they do not.
//
// When they cannot be met and the budget is gone, the report ABSTAINS. That is
// a first-class outcome: a report that says "the 2025 member-state breakdown
// has not been published" is more useful than one that pads around the hole.

import {
	ATLAS_V3_INDEPENDENT_PUBLISHERS,
	type AtlasV3ProfileConfig,
} from "./config";
import { atlasV3PublishersFor } from "./evidence-bank";
import type {
	AtlasV3EvidenceBank,
	AtlasV3GoalVerdict,
	AtlasV3Memo,
	AtlasV3Outline,
} from "./types";

export interface AtlasV3GoalTestInput {
	memo: AtlasV3Memo;
	outline: AtlasV3Outline;
	bank: AtlasV3EvidenceBank;
	config: AtlasV3ProfileConfig;
	/** Rounds already run. */
	roundsRun: number;
	/** Independent publishers a core figure needs. Defaults to 2. */
	independentPublishers?: number;
}

export function runAtlasV3GoalTest(
	input: AtlasV3GoalTestInput,
): AtlasV3GoalVerdict {
	const required =
		input.independentPublishers ?? ATLAS_V3_INDEPENDENT_PUBLISHERS;
	const claimsById = new Map(
		input.bank.claims.map((claim) => [claim.id, claim]),
	);

	// -- 1. is the core answer corroborated? ---------------------------------
	//
	// The memo's own claim list IS the core claim table: it is what the memo
	// says the answer rests on. A memo that named no claim has no answer.
	const coreClaims = input.memo.claimIds
		.map((id) => claimsById.get(id))
		.filter((claim): claim is NonNullable<typeof claim> => Boolean(claim));
	const corroborated = coreClaims.filter(
		(claim) =>
			atlasV3PublishersFor(input.bank, claim.evidenceIds).length >= required,
	);
	const coreCorroborated = coreClaims.length > 0 && corroborated.length > 0;

	// -- 2. is every node covered? -------------------------------------------
	const liveNodes = input.outline.nodes.filter((node) => node.status !== "cut");
	const thinNodeIds = liveNodes
		.filter((node) => node.evidenceIds.length < input.config.minEvidencePerNode)
		.map((node) => node.id);

	// -- 3. what is left to spend? -------------------------------------------
	const roundsLeft = Math.max(0, input.config.rounds - input.roundsRun);
	const passed = coreCorroborated && thinNodeIds.length === 0;
	const exhausted = roundsLeft === 0;

	if (passed) {
		return {
			passed: true,
			coreCorroborated,
			thinNodeIds: [],
			gaps: [],
			exhausted,
			abstain: false,
			reason: `the core answer is corroborated by ${required} independent publishers and every section carries its evidence`,
		};
	}

	const gaps = buildAtlasV3Gaps({
		memo: input.memo,
		outline: input.outline,
		thinNodeIds,
		coreCorroborated,
		coreClaims,
	});

	if (!exhausted) {
		return {
			passed: false,
			coreCorroborated,
			thinNodeIds,
			gaps,
			exhausted: false,
			abstain: false,
			reason: coreCorroborated
				? `${thinNodeIds.length} section(s) still lack evidence`
				: "no figure in the core answer is corroborated by two independent publishers",
		};
	}

	// The budget is gone. The report abstains only when there is nothing to
	// stand on at all: a corroborated core with one thin section is a report
	// with a Limitations line, not an abstention.
	const abstain =
		!coreCorroborated &&
		liveNodes.every((node) => node.evidenceIds.length === 0);
	return {
		passed: false,
		coreCorroborated,
		thinNodeIds,
		gaps,
		exhausted: true,
		abstain,
		reason: abstain
			? "the research budget is spent and no publishable evidence was found for the core question"
			: coreCorroborated
				? `the research budget is spent; ${thinNodeIds.length} section(s) remain thin`
				: "the research budget is spent and no figure in the core answer reached two independent publishers",
	};
}

/**
 * The targeted sub-questions the next round should research. Ordered: the core
 * answer's missing corroboration first, then the thin nodes' own `needs`, then
 * the memo's open questions.
 */
export function buildAtlasV3Gaps(input: {
	memo: AtlasV3Memo;
	outline: AtlasV3Outline;
	thinNodeIds: readonly string[];
	coreCorroborated: boolean;
	coreClaims: ReadonlyArray<{
		entity: string;
		metric: string;
		period: string | null;
		series: string | null;
	}>;
}): string[] {
	const gaps: string[] = [];
	if (!input.coreCorroborated) {
		if (input.coreClaims.length === 0) {
			gaps.push(...input.memo.openQuestions.slice(0, 2));
		}
		for (const claim of input.coreClaims.slice(0, 2)) {
			// A second publisher for the SAME series: asking for the metric alone is
			// what produced v2's false disagreements between a target and an actual.
			gaps.push(
				[
					claim.entity,
					claim.metric,
					claim.period ?? "",
					claim.series ?? "",
					"independent source",
				]
					.filter(Boolean)
					.join(" ")
					.slice(0, 240),
			);
		}
	}
	const thin = new Set(input.thinNodeIds);
	for (const node of input.outline.nodes) {
		if (!thin.has(node.id)) continue;
		gaps.push(...(node.needs.length > 0 ? node.needs : [node.claim]));
	}
	gaps.push(...input.memo.openQuestions);

	const unique: string[] = [];
	for (const gap of gaps) {
		const cleaned = gap.replace(/\s+/g, " ").trim().slice(0, 240);
		if (!cleaned) continue;
		if (unique.some((entry) => entry.toLowerCase() === cleaned.toLowerCase())) {
			continue;
		}
		unique.push(cleaned);
	}
	return unique;
}

/**
 * The Limitations lines a failed goal test produces: what could not be
 * established, and why. Never "five sentences were removed".
 */
export function atlasV3GoalLimitations(input: {
	verdict: AtlasV3GoalVerdict;
	outline: AtlasV3Outline;
	memo: AtlasV3Memo;
}): Array<{ subject: string; reason: string }> {
	const limitations: Array<{ subject: string; reason: string }> = [];
	if (!input.verdict.coreCorroborated) {
		limitations.push({
			subject: "the central figure",
			reason:
				"only one independent publisher was found for it within the research budget",
		});
	}
	for (const nodeId of input.verdict.thinNodeIds) {
		const node = input.outline.nodes.find((entry) => entry.id === nodeId);
		if (!node) continue;
		limitations.push({
			subject: node.claim || node.title,
			reason:
				node.needs.length > 0
					? `no published source was found for: ${node.needs.join("; ")}`
					: "no published source stated it",
		});
	}
	for (const deadEnd of input.memo.deadEnds) {
		limitations.push({
			subject: deadEnd,
			reason: "established as unavailable",
		});
	}
	for (const entry of input.outline.cut) {
		limitations.push({ subject: entry.title, reason: entry.reason });
	}
	return limitations;
}
