// Pure scoring + aggregation logic for the Option-A (local-distill) fidelity
// eval harness (`option-a-fidelity.ts`). Everything in this module is a pure
// function with no I/O: no file access, no network calls, no environment
// reads, no DB. That is intentional — this is what's unit-tested in CI; the
// harness composes these with real model calls (`distillConnectorPayload`
// and `sendJsonControlMessage`), which are NOT exercised here because they
// require the local distill model and a chat model to be reachable.
//
// See `scripts/eval/README-option-a-fidelity.md` for what this harness
// measures, how to run it on-box, and how its output backfills the
// `connections.locality.fidelityNote` i18n copy (Issue 7.4).

export type OptionAFidelityCapability =
	| "calendar"
	| "email"
	| "files"
	| "photos"
	| "contacts";

// --- Judge prompt + response parsing ----------------------------------------
//
// Mirrors the blind-pairwise judge pattern in `scripts/skill-eval-scoring.ts`
// (strict-JSON prompt, tolerant-but-never-throwing parser), adapted to a
// single-answer 0-100 fidelity rubric scored against a reference answer
// rather than a pairwise winner.

export function buildFidelityJudgePrompt(params: {
	question: string;
	rawAnswer: string;
	distilledAnswer: string;
}): string {
	return [
		"You are grading whether a DISTILLED answer preserves the correctness and completeness of a REFERENCE answer to the same user question.",
		"The REFERENCE answer was produced from the raw, unsummarized data. The DISTILLED answer was produced from a local model's summary of that same data, produced before it reached this chat model.",
		"Score fidelity 0-100: 100 means the distilled answer is fully equivalent to the reference for anything the user actually needed; 0 means it lost all the relevant information, contradicts the reference, or is unusable.",
		"Judge only whether facts relevant to the question were preserved — wording, tone, and phrasing differences do not matter.",
		"",
		`User question: ${params.question}`,
		"",
		"Reference answer (from raw data):",
		"<<<REFERENCE_START>>>",
		params.rawAnswer,
		"<<<REFERENCE_END>>>",
		"",
		"Distilled answer (from locally-summarized data):",
		"<<<DISTILLED_START>>>",
		params.distilledAnswer,
		"<<<DISTILLED_END>>>",
		"",
		"Respond with STRICT JSON only, no prose, no markdown fences, matching exactly this shape:",
		"{",
		'  "fidelity": <integer 0-100>,',
		'  "rationale": "<one sentence>"',
		"}",
	].join("\n");
}

export type FidelityJudgeResponse = {
	fidelity: number;
	rationale: string;
};

function extractJsonCandidate(text: string): string | null {
	const trimmed = text.trim();
	const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenceMatch?.[1]) return fenceMatch[1].trim();

	const firstBrace = trimmed.indexOf("{");
	const lastBrace = trimmed.lastIndexOf("}");
	if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
		return trimmed.slice(firstBrace, lastBrace + 1);
	}
	return null;
}

/**
 * Parses a judge model's raw text response into a fidelity score. Returns
 * null (never throws) when the text is not valid/well-formed JSON, or is
 * valid JSON missing/malformed the expected fields, or the fidelity value is
 * out of the 0-100 range — so callers can treat a bad judge response as "no
 * verdict" (recorded as an error outcome, not a fidelity score) rather than
 * crash a batch run.
 */
export function parseFidelityJudgeResponse(
	text: string,
): FidelityJudgeResponse | null {
	const candidate = extractJsonCandidate(text);
	if (!candidate) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(candidate);
	} catch {
		return null;
	}

	if (typeof parsed !== "object" || parsed === null) return null;
	const { fidelity, rationale } = parsed as Record<string, unknown>;

	if (typeof fidelity !== "number" || !Number.isFinite(fidelity)) return null;
	if (fidelity < 0 || fidelity > 100) return null;

	return {
		fidelity,
		rationale: typeof rationale === "string" ? rationale : "",
	};
}

// --- Aggregation -------------------------------------------------------------
//
// Per the harness spec: distill `unavailable` for a case is a "withheld"
// outcome (the safe fallback), never scored as a quality failure. Any other
// failure while running a case (chat-model error, unparseable judge
// response, ...) is an "error" outcome, also excluded from the fidelity
// mean/quality-hit for the same reason — a harness malfunction should not be
// misread as either a quality win or a fidelity loss.

export type OptionAFidelityCaseOutcome =
	| {
			kind: "scored";
			caseId: string;
			capability: OptionAFidelityCapability;
			fidelity: number;
	  }
	| {
			kind: "withheld";
			caseId: string;
			capability: OptionAFidelityCapability;
	  }
	| {
			kind: "error";
			caseId: string;
			capability: OptionAFidelityCapability;
			error: string;
	  };

export type OptionAFidelityAggregate = {
	n: number;
	scoredN: number;
	withheldN: number;
	errorN: number;
	/** Mean of scored fidelities (0-100); null when scoredN is 0. */
	meanFidelity: number | null;
	/** 100 - meanFidelity; null when meanFidelity is null. */
	qualityHitPercent: number | null;
};

function aggregateOutcomes(
	outcomes: OptionAFidelityCaseOutcome[],
): OptionAFidelityAggregate {
	const scored = outcomes.filter(
		(o): o is Extract<OptionAFidelityCaseOutcome, { kind: "scored" }> =>
			o.kind === "scored",
	);
	const withheldN = outcomes.filter((o) => o.kind === "withheld").length;
	const errorN = outcomes.filter((o) => o.kind === "error").length;
	const meanFidelity =
		scored.length > 0
			? scored.reduce((sum, o) => sum + o.fidelity, 0) / scored.length
			: null;

	return {
		n: outcomes.length,
		scoredN: scored.length,
		withheldN,
		errorN,
		meanFidelity,
		qualityHitPercent: meanFidelity === null ? null : 100 - meanFidelity,
	};
}

export type OptionAFidelityCapabilityAggregate = OptionAFidelityAggregate & {
	capability: OptionAFidelityCapability;
};

export type OptionAFidelityAggregateReport = {
	overall: OptionAFidelityAggregate;
	byCapability: OptionAFidelityCapabilityAggregate[];
};

/**
 * Aggregates per-case outcomes into an overall mean fidelity / quality-hit
 * and a per-capability breakdown, in the capability's first-seen order in
 * `outcomes`. Pure — no I/O, safe to call with synthetic fixtures in tests.
 */
export function aggregateOptionAFidelity(
	outcomes: OptionAFidelityCaseOutcome[],
): OptionAFidelityAggregateReport {
	const overall = aggregateOutcomes(outcomes);

	const capabilityOrder: OptionAFidelityCapability[] = [];
	const seen = new Set<OptionAFidelityCapability>();
	for (const outcome of outcomes) {
		if (!seen.has(outcome.capability)) {
			seen.add(outcome.capability);
			capabilityOrder.push(outcome.capability);
		}
	}

	const byCapability = capabilityOrder.map((capability) => ({
		capability,
		...aggregateOutcomes(outcomes.filter((o) => o.capability === capability)),
	}));

	return { overall, byCapability };
}

// --- Preflight: "is the harness configured to run live?" -------------------
//
// The harness script is NOT run in CI (it needs a reachable local distill
// model and a reachable chat model). This check is pure and takes its
// resolvers as injected dependencies so it can be unit-tested with mocks,
// without ever importing the app's DB/config-store modules into the test.

export type OptionAFidelityPreflightDeps = {
	/** Resolves the chat model's provider config; throws/rejects if the model
	 * id does not resolve to a configured provider. */
	resolveChatProvider: (
		chatModelId: string,
	) => Promise<{ baseUrl: string; modelName: string; displayName: string }>;
	/** Returns the configured local-distill model id, or a falsy value if none
	 * is configured. */
	resolveDistillModelId: () => string | undefined | null;
	/** True when `modelId` resolves to a cloud (non-local) provider. Mirrors
	 * `isCloudModel` in `src/lib/server/services/connections/locality.ts`. */
	isCloudModel: (modelId: string) => Promise<boolean>;
};

export type OptionAFidelityPreflightResult =
	| {
			configured: true;
			chatModelId: string;
			chatModelDisplayName: string;
			distillModelId: string;
	  }
	| { configured: false; reason: string };

/**
 * Checks whether the harness can run live: the chat model must resolve to a
 * configured provider, and the local-distill model must be configured AND
 * resolve to a local (non-cloud) host — matching the safety check
 * `distillConnectorPayload` itself performs in production. Never throws;
 * any failure to resolve becomes a `{ configured: false, reason }` result so
 * the harness can exit gracefully instead of crashing.
 */
export async function checkOptionAFidelityConfigured(
	deps: OptionAFidelityPreflightDeps,
	chatModelId = "model1",
): Promise<OptionAFidelityPreflightResult> {
	let chatProvider: { baseUrl: string; modelName: string; displayName: string };
	try {
		chatProvider = await deps.resolveChatProvider(chatModelId);
	} catch (error) {
		return {
			configured: false,
			reason: `Chat model "${chatModelId}" is not configured/reachable: ${errorMessage(error)}`,
		};
	}
	if (!chatProvider.baseUrl || !chatProvider.modelName) {
		return {
			configured: false,
			reason: `Chat model "${chatModelId}" is not configured (missing baseUrl/modelName).`,
		};
	}

	const distillModelId = deps.resolveDistillModelId();
	if (!distillModelId) {
		return {
			configured: false,
			reason:
				"No local-distill model is configured (memoryConsolidationModel). Configure it in the admin panel before running this eval.",
		};
	}

	let distillIsCloud: boolean;
	try {
		distillIsCloud = await deps.isCloudModel(distillModelId);
	} catch (error) {
		return {
			configured: false,
			reason: `Could not resolve local-distill model "${distillModelId}": ${errorMessage(error)}`,
		};
	}
	if (distillIsCloud) {
		return {
			configured: false,
			reason: `Configured local-distill model "${distillModelId}" resolves to a cloud host, not a local one. This eval requires an on-box local distill model.`,
		};
	}

	return {
		configured: true,
		chatModelId,
		chatModelDisplayName: chatProvider.displayName,
		distillModelId,
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// --- Result shape + formatting -----------------------------------------------

export type OptionAFidelitySummaryResult =
	| {
			status: "not_configured";
			generatedAt: string;
			reason: string;
	  }
	| {
			status: "completed";
			generatedAt: string;
			chatModelId: string;
			chatModelDisplayName: string;
			distillModelId: string;
			overall: OptionAFidelityAggregate;
			byCapability: OptionAFidelityCapabilityAggregate[];
	  };

/** Builds the "not configured" skip result. Never throws. This is the
 * graceful-exit branch the harness returns when run off-box / without a
 * reachable local distill model and chat model configured. */
export function buildNotConfiguredResult(
	reason: string,
	generatedAt: string = new Date().toISOString(),
): OptionAFidelitySummaryResult {
	return { status: "not_configured", generatedAt, reason };
}

export function buildCompletedResult(params: {
	generatedAt?: string;
	chatModelId: string;
	chatModelDisplayName: string;
	distillModelId: string;
	outcomes: OptionAFidelityCaseOutcome[];
}): OptionAFidelitySummaryResult {
	const { overall, byCapability } = aggregateOptionAFidelity(params.outcomes);
	return {
		status: "completed",
		generatedAt: params.generatedAt ?? new Date().toISOString(),
		chatModelId: params.chatModelId,
		chatModelDisplayName: params.chatModelDisplayName,
		distillModelId: params.distillModelId,
		overall,
		byCapability,
	};
}

function formatAggregateLine(
	label: string,
	agg: OptionAFidelityAggregate,
): string {
	const fidelityStr =
		agg.meanFidelity === null ? "n/a" : `${agg.meanFidelity.toFixed(1)}%`;
	const qualityHitStr =
		agg.qualityHitPercent === null
			? "n/a"
			: `${agg.qualityHitPercent.toFixed(1)}%`;
	return (
		`${label}: n=${agg.n} scored=${agg.scoredN} withheld=${agg.withheldN} ` +
		`error=${agg.errorN} meanFidelity=${fidelityStr} qualityHit=${qualityHitStr}`
	);
}

/** Renders a concise console/report summary for a result. Pure string
 * formatting — no I/O. */
export function formatOptionAFidelitySummary(
	result: OptionAFidelitySummaryResult,
): string {
	if (result.status === "not_configured") {
		return [
			"Option-A fidelity eval: SKIPPED (not configured)",
			result.reason,
		].join("\n");
	}

	const lines: string[] = [];
	lines.push("Option-A fidelity eval");
	lines.push(`Generated at: ${result.generatedAt}`);
	lines.push(
		`Chat model: ${result.chatModelDisplayName} (${result.chatModelId})`,
	);
	lines.push(`Local-distill model: ${result.distillModelId}`);
	lines.push("");
	lines.push(formatAggregateLine("Overall", result.overall));
	for (const cap of result.byCapability) {
		lines.push(formatAggregateLine(`  ${cap.capability}`, cap));
	}
	return lines.join("\n");
}
