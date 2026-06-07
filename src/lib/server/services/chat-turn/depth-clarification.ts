import {
	detectLanguage,
	type SupportedLanguage,
} from "$lib/server/services/language";
import type {
	DepthClarificationReason,
	DepthMetadata,
	UiLanguage,
} from "$lib/types";

export type DepthClarificationClassifierDecision = {
	outcome?: "ask" | "proceed_with_assumption" | "bypass";
	reason?: string;
	question?: string;
	assumption?: string;
};

export type DepthClarificationClassifier = (params: {
	message: string;
	depthMetadata: DepthMetadata;
	language: UiLanguage;
}) =>
	| DepthClarificationClassifierDecision
	| null
	| undefined
	| Promise<DepthClarificationClassifierDecision | null | undefined>;

export type DepthClarificationGateResult =
	| {
			action: "ask";
			text: string;
			depthMetadata: DepthMetadata;
	  }
	| {
			action: "proceed";
			assumptionPrefix?: string;
			depthMetadata: DepthMetadata;
	  }
	| {
			action: "bypass";
			depthMetadata?: DepthMetadata;
	  };

const HIGH_COST_PROFILES = new Set(["extended", "maximum"]);

const BROAD_TARGET_QUALIFIER_PATTERN =
	/\b(all|every|complete|comprehensive|full|viable)\b/i;
const OPEN_TARGET_PATTERN =
	/\b(options?|alternatives?|platforms?|vendors?|tools?|solutions?|approaches?|source set|decision criteria)\b/i;
const EXPENSIVE_WORK_PATTERN =
	/\b(research|investigate|compare|evaluate|assess|analy[sz]e|migration plan|implementation plan|strategy|roadmap|architecture)\b/i;
const ASSUMPTION_PATTERN =
	/\b(assume|make an assumption|use your best judgment|use your best judgement|pick one|choose one|proceed|go ahead|continue anyway|default to)\b/i;
const HUNGARIAN_ASSUMPTION_PATTERN =
	/\b(feltetelezz|feltételezz|tegy[ée]l fel|d[oö]nts|valassz|válassz|menj tovabb|menj tovább|folytasd)\b/i;

export async function evaluateDepthClarificationGate(params: {
	message: string;
	depthMetadata?: DepthMetadata;
	classifier?: DepthClarificationClassifier;
	language?: UiLanguage;
}): Promise<DepthClarificationGateResult> {
	const depthMetadata = params.depthMetadata;
	if (!depthMetadata || !HIGH_COST_PROFILES.has(depthMetadata.appliedProfile)) {
		return {
			action: "bypass",
			depthMetadata,
		};
	}

	const language = params.language ?? detectLanguage(params.message);
	const requestedAssumption = asksToProceedWithAssumption(params.message);
	if (requestedAssumption) {
		const assumption = renderDepthAssumption(language);
		return {
			action: "proceed",
			assumptionPrefix: renderDepthAssumptionPrefix(language, assumption),
			depthMetadata: withDepthClarificationMetadata(depthMetadata, {
				outcome: "proceed_with_assumption",
				reason: "user_requested_assumption",
				language,
				assumption,
			}),
		};
	}

	if (shouldAskDeterministically(params.message, depthMetadata)) {
		const text = renderDepthClarificationQuestion(language);
		return {
			action: "ask",
			text,
			depthMetadata: withDepthClarificationMetadata(depthMetadata, {
				outcome: "ask",
				reason: "multiple_plausible_targets",
				language,
				question: text,
			}),
		};
	}

	const classifierDecision = normalizeDepthClarificationClassifierDecision(
		await params.classifier?.({
			message: params.message,
			depthMetadata,
			language,
		}),
	);
	if (classifierDecision?.outcome === "ask") {
		const text =
			classifierDecision.question ?? renderDepthClarificationQuestion(language);
		return {
			action: "ask",
			text,
			depthMetadata: withDepthClarificationMetadata(depthMetadata, {
				outcome: "ask",
				reason: classifierDecision.reason,
				language,
				classifierSource: "injected",
				question: text,
			}),
		};
	}
	if (classifierDecision?.outcome === "proceed_with_assumption") {
		const assumption =
			classifierDecision.assumption ?? renderDepthAssumption(language);
		return {
			action: "proceed",
			assumptionPrefix: renderDepthAssumptionPrefix(language, assumption),
			depthMetadata: withDepthClarificationMetadata(depthMetadata, {
				outcome: "proceed_with_assumption",
				reason: classifierDecision.reason,
				language,
				classifierSource: "injected",
				assumption,
			}),
		};
	}

	return { action: "bypass", depthMetadata };
}

export function normalizeDepthClarificationClassifierDecision(
	value: DepthClarificationClassifierDecision | null | undefined,
): {
	outcome: "ask" | "proceed_with_assumption" | "bypass";
	reason: DepthClarificationReason;
	question?: string;
	assumption?: string;
} | null {
	if (!value || typeof value !== "object") return null;
	const outcome =
		value.outcome === "ask" ||
		value.outcome === "proceed_with_assumption" ||
		value.outcome === "bypass"
			? value.outcome
			: null;
	if (!outcome) return null;
	const reason =
		value.reason === "multiple_plausible_targets" ||
		value.reason === "user_requested_assumption"
			? value.reason
			: "classifier";
	return {
		outcome,
		reason,
		...(typeof value.question === "string" && value.question.trim()
			? { question: value.question.trim() }
			: {}),
		...(typeof value.assumption === "string" && value.assumption.trim()
			? { assumption: value.assumption.trim() }
			: {}),
	};
}

export function renderDepthClarificationQuestion(
	language: SupportedLanguage,
): string {
	if (language === "hu") {
		return [
			"Meg tudom csinálni, de előbb egy döntésre van szükségem, mert több ésszerű cél is lehetséges.",
			"Melyik platformot, forráskört vagy döntési szempontot használjam kiindulópontként?",
		].join("\n\n");
	}
	return [
		"I can do that, but I need one choice from you first because there are several plausible targets.",
		"Which platform, source set, or decision criteria should I use as the starting point?",
	].join("\n\n");
}

export function renderDepthAssumption(language: SupportedLanguage): string {
	if (language === "hu") {
		return "a legáltalánosabban hasznos célra és döntési szempontokra támaszkodom";
	}
	return "I will use the most generally useful target and decision criteria";
}

export function renderDepthAssumptionPrefix(
	language: SupportedLanguage,
	assumption: string,
): string {
	if (language === "hu") {
		return `Feltételezés: ${assumption}.`;
	}
	return `Depth Assumption: ${assumption}.`;
}

function shouldAskDeterministically(
	message: string,
	depthMetadata: DepthMetadata,
): boolean {
	const broadSignals =
		depthMetadata.signals?.contextBreadth === "broad" ||
		depthMetadata.signals?.outputRoom === "expanded" ||
		depthMetadata.signals?.toolUse === "source_heavy";
	if (!broadSignals) return false;
	return (
		BROAD_TARGET_QUALIFIER_PATTERN.test(message) &&
		OPEN_TARGET_PATTERN.test(message) &&
		EXPENSIVE_WORK_PATTERN.test(message)
	);
}

function asksToProceedWithAssumption(message: string): boolean {
	return (
		ASSUMPTION_PATTERN.test(message) ||
		HUNGARIAN_ASSUMPTION_PATTERN.test(message)
	);
}

function withDepthClarificationMetadata(
	depthMetadata: DepthMetadata,
	params: {
		outcome: "ask" | "proceed_with_assumption";
		reason: DepthClarificationReason;
		language: UiLanguage;
		classifierSource?: string;
		question?: string;
		assumption?: string;
	},
): DepthMetadata {
	return {
		...depthMetadata,
		outcome:
			params.outcome === "ask"
				? "clarification_requested"
				: "proceeded_with_assumption",
		clarification: {
			outcome: params.outcome,
			reason: params.reason,
			language: params.language,
			...(params.classifierSource
				? { classifierSource: params.classifierSource }
				: {}),
			...(params.question ? { question: params.question } : {}),
			...(params.assumption ? { assumption: params.assumption } : {}),
		},
	};
}
