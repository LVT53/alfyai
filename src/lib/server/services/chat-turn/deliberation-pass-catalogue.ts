import type { ReasoningDepthEffort } from "$lib/server/services/chat-turn/reasoning-depth-effort";
import type {
	DepthAppliedProfile,
	DepthSelectionSignals,
	ResponseActivityEntry,
} from "$lib/types";

export const DELIBERATION_MAX_OUTPUT_TOKENS = 2_400;
export const DELIBERATION_REPAIR_MAX_OUTPUT_TOKENS = 1_200;
export const DELIBERATION_TOOL_STEPS = 8;
export const DELIBERATION_NO_TOOL_STEPS = 0;
export const DELIBERATION_MAX_PASS_COUNT = 5;

export type DeliberationPassKind =
	| "context_source_gap_review"
	| "answer_plan_critique"
	| "evidence_gap_review"
	| "source_reconciliation"
	| "adversarial_edge_case_check"
	| "workspace_synthesis"
	| "viable_alternatives_preservation";

export type DeliberationPassSchemaKind =
	| "first_pass"
	| "second_pass"
	| "generic_brief"
	| "alternatives_preservation";

export type DeliberationPassCatalogueEntry = {
	kind: DeliberationPassKind;
	schema: DeliberationPassSchemaKind;
	maxOutputTokens: number;
	repairMaxOutputTokens: number;
	maxToolSteps: number;
	useDepthProviderOptions: boolean;
	systemFocusInstruction: string;
	statusLabels: Record<
		"en" | "hu",
		Record<ResponseActivityEntry["status"], string>
	>;
};

export type PlannedDeliberationPass = DeliberationPassCatalogueEntry & {
	pass: number;
};

const DELIBERATION_PASS_CATALOGUE: Record<
	DeliberationPassKind,
	DeliberationPassCatalogueEntry
> = {
	context_source_gap_review: {
		kind: "context_source_gap_review",
		schema: "first_pass",
		maxOutputTokens: DELIBERATION_MAX_OUTPUT_TOKENS,
		repairMaxOutputTokens: DELIBERATION_REPAIR_MAX_OUTPUT_TOKENS,
		maxToolSteps: DELIBERATION_TOOL_STEPS,
		useDepthProviderOptions: true,
		systemFocusInstruction:
			"Focus on user intent, assumptions, evidence needs, relevant findings, missing context, and edge cases.",
		statusLabels: {
			en: {
				running: "Reviewing context and sources",
				done: "Reviewed context and sources",
				error: "Reviewed context and sources",
			},
			hu: {
				running: "Kontextus és források áttekintése",
				done: "Kontextus és források áttekintve",
				error: "Kontextus és források áttekintve",
			},
		},
	},
	answer_plan_critique: {
		kind: "answer_plan_critique",
		schema: "second_pass",
		maxOutputTokens: DELIBERATION_MAX_OUTPUT_TOKENS,
		repairMaxOutputTokens: DELIBERATION_REPAIR_MAX_OUTPUT_TOKENS,
		maxToolSteps: DELIBERATION_TOOL_STEPS,
		useDepthProviderOptions: true,
		systemFocusInstruction:
			"Focus on answer risks, contradictions, missed user needs, format requirements, must-include points, and things to avoid.",
		statusLabels: {
			en: {
				running: "Checking answer plan",
				done: "Checked answer plan",
				error: "Checked answer plan",
			},
			hu: {
				running: "Választerv ellenőrzése",
				done: "Választerv ellenőrizve",
				error: "Választerv ellenőrizve",
			},
		},
	},
	evidence_gap_review: {
		kind: "evidence_gap_review",
		schema: "generic_brief",
		maxOutputTokens: DELIBERATION_MAX_OUTPUT_TOKENS,
		repairMaxOutputTokens: DELIBERATION_REPAIR_MAX_OUTPUT_TOKENS,
		maxToolSteps: DELIBERATION_TOOL_STEPS,
		useDepthProviderOptions: true,
		systemFocusInstruction:
			"Focus on evidence gaps, citation-sensitive claims, facts that need verification, unavailable evidence, and concise final-answer guidance.",
		statusLabels: {
			en: {
				running: "Checking evidence gaps",
				done: "Checked evidence gaps",
				error: "Checked evidence gaps",
			},
			hu: {
				running: "Bizonyítéki hiányok ellenőrzése",
				done: "Bizonyítéki hiányok ellenőrizve",
				error: "Bizonyítéki hiányok ellenőrizve",
			},
		},
	},
	source_reconciliation: {
		kind: "source_reconciliation",
		schema: "generic_brief",
		maxOutputTokens: DELIBERATION_MAX_OUTPUT_TOKENS,
		repairMaxOutputTokens: DELIBERATION_REPAIR_MAX_OUTPUT_TOKENS,
		maxToolSteps: DELIBERATION_TOOL_STEPS,
		useDepthProviderOptions: true,
		systemFocusInstruction:
			"Focus on reconciling source-heavy evidence, conflicting source signals, source authority, stale or missing citations, and concise final-answer guidance.",
		statusLabels: {
			en: {
				running: "Reconciling sources",
				done: "Reconciled sources",
				error: "Reconciled sources",
			},
			hu: {
				running: "Források egyeztetése",
				done: "Források egyeztetve",
				error: "Források egyeztetve",
			},
		},
	},
	adversarial_edge_case_check: {
		kind: "adversarial_edge_case_check",
		schema: "generic_brief",
		maxOutputTokens: DELIBERATION_MAX_OUTPUT_TOKENS,
		repairMaxOutputTokens: DELIBERATION_REPAIR_MAX_OUTPUT_TOKENS,
		maxToolSteps: DELIBERATION_TOOL_STEPS,
		useDepthProviderOptions: true,
		systemFocusInstruction:
			"Focus on adversarial checks, failure-sensitive assumptions, edge cases, counterexamples, overclaiming risks, and concise final-answer guidance.",
		statusLabels: {
			en: {
				running: "Checking edge cases",
				done: "Checked edge cases",
				error: "Checked edge cases",
			},
			hu: {
				running: "Szélső esetek ellenőrzése",
				done: "Szélső esetek ellenőrizve",
				error: "Szélső esetek ellenőrizve",
			},
		},
	},
	workspace_synthesis: {
		kind: "workspace_synthesis",
		schema: "generic_brief",
		maxOutputTokens: DELIBERATION_MAX_OUTPUT_TOKENS,
		repairMaxOutputTokens: DELIBERATION_REPAIR_MAX_OUTPUT_TOKENS,
		maxToolSteps: DELIBERATION_TOOL_STEPS,
		useDepthProviderOptions: true,
		systemFocusInstruction:
			"Focus on synthesizing broad workspace context, active documents, memory context, user constraints, cross-document tensions, and concise final-answer guidance.",
		statusLabels: {
			en: {
				running: "Synthesizing workspace context",
				done: "Synthesized workspace context",
				error: "Synthesized workspace context",
			},
			hu: {
				running: "Munkaterületi kontextus szintetizálása",
				done: "Munkaterületi kontextus szintetizálva",
				error: "Munkaterületi kontextus szintetizálva",
			},
		},
	},
	viable_alternatives_preservation: {
		kind: "viable_alternatives_preservation",
		schema: "alternatives_preservation",
		maxOutputTokens: DELIBERATION_MAX_OUTPUT_TOKENS,
		repairMaxOutputTokens: DELIBERATION_REPAIR_MAX_OUTPUT_TOKENS,
		maxToolSteps: DELIBERATION_NO_TOOL_STEPS,
		useDepthProviderOptions: false,
		systemFocusInstruction:
			"Return a compact JSON object only. Focus on preserving viable alternatives, second-best options, conditional paths, and exit criteria so the final answer remains decisive without collapsing nuance prematurely. Do not draft final-answer prose.",
		statusLabels: {
			en: {
				running: "Checking viable alternatives",
				done: "Checked viable alternatives",
				error: "Checked viable alternatives",
			},
			hu: {
				running: "Életképes alternatívák ellenőrzése",
				done: "Életképes alternatívák ellenőrizve",
				error: "Életképes alternatívák ellenőrizve",
			},
		},
	},
};

const DELIBERATION_PASS_PLAN_BY_PROFILE: Record<
	DepthAppliedProfile,
	DeliberationPassKind[]
> = {
	off: [],
	standard: [],
	extended: ["context_source_gap_review"],
	maximum: [
		"context_source_gap_review",
		"answer_plan_critique",
		"viable_alternatives_preservation",
	],
};

export function planDeliberationPasses(
	depthEffort: ReasoningDepthEffort | null,
): PlannedDeliberationPass[] {
	const profile = depthEffort?.depthMetadata.appliedProfile;
	if (!profile) return [];
	const kinds = planDeliberationPassKinds(
		profile,
		depthEffort.depthMetadata.signals,
	);
	return kinds.slice(0, DELIBERATION_MAX_PASS_COUNT).map((kind, index) => ({
		...DELIBERATION_PASS_CATALOGUE[kind],
		pass: index + 1,
	}));
}

function planDeliberationPassKinds(
	profile: DepthAppliedProfile,
	signals: DepthSelectionSignals | undefined,
): DeliberationPassKind[] {
	const baseline = DELIBERATION_PASS_PLAN_BY_PROFILE[profile];
	if (profile === "off" || profile === "standard") return baseline;
	if (!signals || Object.keys(signals).length === 0) return baseline;

	const expanded: DeliberationPassKind[] = ["context_source_gap_review"];
	const evidenceKind = evidencePassKind(signals);
	if (evidenceKind) {
		expanded.push(evidenceKind);
	}
	if (signals.contextBreadth === "broad") {
		expanded.push("workspace_synthesis");
	}
	if (profile === "maximum" && shouldRunAdversarialPass(signals)) {
		expanded.push("adversarial_edge_case_check");
	}
	if (expanded.length === 1 && profile === "maximum") {
		expanded.push("answer_plan_critique");
	}
	if (profile === "maximum") {
		expanded.push("viable_alternatives_preservation");
	}
	return expanded;
}

function evidencePassKind(
	signals: DepthSelectionSignals,
): DeliberationPassKind | null {
	if (
		signals.toolUse === "source_heavy" ||
		signals.groundingNeed === "required"
	) {
		return "source_reconciliation";
	}
	if (signals.groundingNeed === "useful") return "evidence_gap_review";
	return null;
}

function shouldRunAdversarialPass(signals: DepthSelectionSignals): boolean {
	return (
		signals.outputRoom === "expanded" ||
		signals.contextBreadth === "broad" ||
		signals.groundingNeed === "required" ||
		signals.toolUse === "source_heavy"
	);
}

export function shouldRunDeliberationPasses(
	depthEffort: ReasoningDepthEffort | null,
): boolean {
	return planDeliberationPasses(depthEffort).length > 0;
}

export function deliberationPassCount(
	depthEffort: ReasoningDepthEffort | null,
): number {
	return planDeliberationPasses(depthEffort).length;
}
