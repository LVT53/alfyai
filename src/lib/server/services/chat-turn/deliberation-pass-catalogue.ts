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
export const DELIBERATION_MAX_PASS_COUNT = 9;

export type DeliberationPassKind =
	| "context_source_gap_review"
	| "answer_plan_critique"
	| "missed_user_need_check"
	| "contradiction_risk_check"
	| "final_format_style_check"
	| "hungarian_parity_check"
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

const DELIBERATION_RUNNING_LABEL_VARIANTS: Record<
	DeliberationPassKind,
	Record<"en" | "hu", string[]>
> = {
	context_source_gap_review: {
		en: [
			"Reviewing context and sources",
			"Mapping the request and evidence",
			"Scanning context for missing pieces",
			"Grounding the answer setup",
		],
		hu: [
			"Kontextus és források áttekintése",
			"A kérés és a bizonyítékok feltérképezése",
			"Hiányzó kontextusrészek keresése",
			"A válasz alapjainak ellenőrzése",
		],
	},
	answer_plan_critique: {
		en: [
			"Checking answer plan",
			"Stress-testing the answer route",
			"Reviewing the response outline",
			"Testing the plan before drafting",
		],
		hu: [
			"Választerv ellenőrzése",
			"A válaszútvonal terheléses ellenőrzése",
			"A válaszvázlat áttekintése",
			"A terv ellenőrzése megfogalmazás előtt",
		],
	},
	missed_user_need_check: {
		en: [
			"Checking missed requirements",
			"Looking for unstated obligations",
			"Rechecking the user's constraints",
			"Making sure the brief is covered",
		],
		hu: [
			"Hiányzó elvárások ellenőrzése",
			"Kimondatlan kötelezettségek keresése",
			"A felhasználói korlátok újraellenőrzése",
			"Annak ellenőrzése, hogy a kérés teljesül-e",
		],
	},
	contradiction_risk_check: {
		en: [
			"Checking risks and tensions",
			"Looking for contradictions",
			"Testing tradeoffs and failure modes",
			"Checking where the answer could break",
		],
		hu: [
			"Kockázatok és ellentmondások ellenőrzése",
			"Ellentmondások keresése",
			"Kompromisszumok és hibamódok tesztelése",
			"Annak vizsgálata, hol törhet meg a válasz",
		],
	},
	final_format_style_check: {
		en: [
			"Checking answer shape",
			"Polishing the final structure",
			"Checking clarity and format",
			"Tightening the response shape",
		],
		hu: [
			"Válaszforma ellenőrzése",
			"A végső szerkezet csiszolása",
			"Érthetőség és forma ellenőrzése",
			"A válasz szerkezetének feszesítése",
		],
	},
	hungarian_parity_check: {
		en: [
			"Checking Hungarian parity",
			"Checking Hungarian-language implications",
			"Verifying Hungarian user coverage",
			"Reviewing localization-sensitive details",
		],
		hu: [
			"Magyar paritás ellenőrzése",
			"Magyar nyelvi következmények ellenőrzése",
			"A magyar felhasználói lefedettség ellenőrzése",
			"Lokalizációérzékeny részletek áttekintése",
		],
	},
	evidence_gap_review: {
		en: [
			"Checking evidence gaps",
			"Looking for claims that need proof",
			"Reviewing citation-sensitive points",
			"Checking what still needs grounding",
		],
		hu: [
			"Bizonyítéki hiányok ellenőrzése",
			"Bizonyítékot igénylő állítások keresése",
			"Idézésérzékeny pontok áttekintése",
			"Annak ellenőrzése, mi igényel még megalapozást",
		],
	},
	source_reconciliation: {
		en: [
			"Reconciling sources",
			"Comparing source signals",
			"Checking source agreement",
			"Sorting evidence conflicts",
		],
		hu: [
			"Források egyeztetése",
			"Forrásjelek összevetése",
			"A források egyetértésének ellenőrzése",
			"Bizonyítéki ütközések rendezése",
		],
	},
	adversarial_edge_case_check: {
		en: [
			"Checking edge cases",
			"Trying to break the answer",
			"Testing awkward cases",
			"Looking for counterexamples",
		],
		hu: [
			"Szélső esetek ellenőrzése",
			"A válasz megtörésének próbája",
			"Kényelmetlen esetek tesztelése",
			"Ellenpéldák keresése",
		],
	},
	workspace_synthesis: {
		en: [
			"Synthesizing workspace context",
			"Weaving workspace clues together",
			"Combining active context signals",
			"Resolving workspace-level context",
		],
		hu: [
			"Munkaterületi kontextus szintetizálása",
			"Munkaterületi jelek összefűzése",
			"Aktív kontextusjelek összevonása",
			"Munkaterületi kontextus rendezése",
		],
	},
	viable_alternatives_preservation: {
		en: [
			"Checking viable alternatives",
			"Preserving second-best paths",
			"Checking conditional options",
			"Keeping alternatives from collapsing too early",
		],
		hu: [
			"Életképes alternatívák ellenőrzése",
			"Második legjobb utak megőrzése",
			"Feltételes opciók ellenőrzése",
			"Alternatívák túl korai lezárásának elkerülése",
		],
	},
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
	missed_user_need_check: {
		kind: "missed_user_need_check",
		schema: "generic_brief",
		maxOutputTokens: DELIBERATION_MAX_OUTPUT_TOKENS,
		repairMaxOutputTokens: DELIBERATION_REPAIR_MAX_OUTPUT_TOKENS,
		maxToolSteps: DELIBERATION_NO_TOOL_STEPS,
		useDepthProviderOptions: false,
		systemFocusInstruction:
			"Focus only on missing user requirements, explicit constraints, and must-include points. Do not draft final-answer prose.",
		statusLabels: {
			en: {
				running: "Checking missed requirements",
				done: "Checked missed requirements",
				error: "Checked missed requirements",
			},
			hu: {
				running: "Hiányzó elvárások ellenőrzése",
				done: "Hiányzó elvárások ellenőrizve",
				error: "Hiányzó elvárások ellenőrizve",
			},
		},
	},
	contradiction_risk_check: {
		kind: "contradiction_risk_check",
		schema: "generic_brief",
		maxOutputTokens: DELIBERATION_MAX_OUTPUT_TOKENS,
		repairMaxOutputTokens: DELIBERATION_REPAIR_MAX_OUTPUT_TOKENS,
		maxToolSteps: DELIBERATION_NO_TOOL_STEPS,
		useDepthProviderOptions: false,
		systemFocusInstruction:
			"Focus only on contradictions, material risks, overclaiming, and second-best paths. Do not draft final-answer prose.",
		statusLabels: {
			en: {
				running: "Checking risks and tensions",
				done: "Checked risks and tensions",
				error: "Checked risks and tensions",
			},
			hu: {
				running: "Kockázatok és ellentmondások ellenőrzése",
				done: "Kockázatok és ellentmondások ellenőrizve",
				error: "Kockázatok és ellentmondások ellenőrizve",
			},
		},
	},
	final_format_style_check: {
		kind: "final_format_style_check",
		schema: "generic_brief",
		maxOutputTokens: DELIBERATION_MAX_OUTPUT_TOKENS,
		repairMaxOutputTokens: DELIBERATION_REPAIR_MAX_OUTPUT_TOKENS,
		maxToolSteps: DELIBERATION_NO_TOOL_STEPS,
		useDepthProviderOptions: false,
		systemFocusInstruction:
			"Focus only on final answer format, prose style, concision, and avoiding raw deliberation JSON. Do not draft final-answer prose.",
		statusLabels: {
			en: {
				running: "Checking answer shape",
				done: "Checked answer shape",
				error: "Checked answer shape",
			},
			hu: {
				running: "Válaszforma ellenőrzése",
				done: "Válaszforma ellenőrizve",
				error: "Válaszforma ellenőrizve",
			},
		},
	},
	hungarian_parity_check: {
		kind: "hungarian_parity_check",
		schema: "generic_brief",
		maxOutputTokens: DELIBERATION_MAX_OUTPUT_TOKENS,
		repairMaxOutputTokens: DELIBERATION_REPAIR_MAX_OUTPUT_TOKENS,
		maxToolSteps: DELIBERATION_NO_TOOL_STEPS,
		useDepthProviderOptions: false,
		systemFocusInstruction:
			"Focus only on whether Hungarian-speaking users, Hungarian language, or Hungary-specific constraints need first-class treatment. Do not draft final-answer prose.",
		statusLabels: {
			en: {
				running: "Checking Hungarian parity",
				done: "Checked Hungarian parity",
				error: "Checked Hungarian parity",
			},
			hu: {
				running: "Magyar paritás ellenőrzése",
				done: "Magyar paritás ellenőrizve",
				error: "Magyar paritás ellenőrizve",
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
		"missed_user_need_check",
		"contradiction_risk_check",
		"final_format_style_check",
		"hungarian_parity_check",
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
	if (profile === "maximum") {
		expanded.push("missed_user_need_check");
		expanded.push("contradiction_risk_check");
		expanded.push("final_format_style_check");
		expanded.push("hungarian_parity_check");
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

export function selectDeliberationStatusLabel(params: {
	passSpec: PlannedDeliberationPass;
	status: ResponseActivityEntry["status"];
	language: "en" | "hu";
	seed: number;
}): string {
	if (params.status !== "running") {
		return params.passSpec.statusLabels[params.language][params.status];
	}
	const variants =
		DELIBERATION_RUNNING_LABEL_VARIANTS[params.passSpec.kind][params.language];
	return variants[positiveModulo(params.seed, variants.length)];
}

function positiveModulo(value: number, modulo: number): number {
	if (modulo <= 0) return 0;
	return ((value % modulo) + modulo) % modulo;
}
