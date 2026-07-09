import { describe, expect, it } from "vitest";
import {
	aggregateOptionAFidelity,
	buildCompletedResult,
	buildFidelityJudgePrompt,
	buildNotConfiguredResult,
	checkOptionAFidelityConfigured,
	formatOptionAFidelitySummary,
	type OptionAFidelityCaseOutcome,
	type OptionAFidelityPreflightDeps,
	parseFidelityJudgeResponse,
} from "./option-a-fidelity-scoring";

describe("buildFidelityJudgePrompt", () => {
	it("includes the question and both answers, labeled as reference/distilled", () => {
		const prompt = buildFidelityJudgePrompt({
			question: "When's my next meeting with Zsombor?",
			rawAnswer: "Your next meeting with Zsombor is Thursday at 2pm.",
			distilledAnswer: "You have a meeting with Zsombor on Thursday.",
		});
		expect(prompt).toContain("When's my next meeting with Zsombor?");
		expect(prompt).toContain(
			"Your next meeting with Zsombor is Thursday at 2pm.",
		);
		expect(prompt).toContain("You have a meeting with Zsombor on Thursday.");
		expect(prompt).toContain("REFERENCE_START");
		expect(prompt).toContain("DISTILLED_START");
	});

	it("asks for strict JSON with a fidelity field", () => {
		const prompt = buildFidelityJudgePrompt({
			question: "q",
			rawAnswer: "a",
			distilledAnswer: "b",
		});
		expect(prompt.toLowerCase()).toContain("json");
		expect(prompt).toContain('"fidelity"');
	});
});

describe("parseFidelityJudgeResponse", () => {
	it("parses a valid JSON response", () => {
		const text = JSON.stringify({
			fidelity: 87,
			rationale: "Preserved the date and person, dropped the time.",
		});
		expect(parseFidelityJudgeResponse(text)).toEqual({
			fidelity: 87,
			rationale: "Preserved the date and person, dropped the time.",
		});
	});

	it("extracts JSON from a fenced code block", () => {
		const text = ["```json", JSON.stringify({ fidelity: 100 }), "```"].join(
			"\n",
		);
		expect(parseFidelityJudgeResponse(text)).toEqual({
			fidelity: 100,
			rationale: "",
		});
	});

	it("extracts JSON embedded in surrounding prose", () => {
		const text = `Sure, here you go: ${JSON.stringify({ fidelity: 42, rationale: "lost the amount" })} thanks`;
		expect(parseFidelityJudgeResponse(text)).toEqual({
			fidelity: 42,
			rationale: "lost the amount",
		});
	});

	it("returns null for malformed JSON", () => {
		expect(parseFidelityJudgeResponse("not json { broken")).toBeNull();
	});

	it("returns null when fidelity is missing", () => {
		expect(
			parseFidelityJudgeResponse(JSON.stringify({ rationale: "no score" })),
		).toBeNull();
	});

	it("returns null when fidelity is not a number", () => {
		expect(
			parseFidelityJudgeResponse(JSON.stringify({ fidelity: "high" })),
		).toBeNull();
	});

	it("returns null when fidelity is out of the 0-100 range", () => {
		expect(
			parseFidelityJudgeResponse(JSON.stringify({ fidelity: 150 })),
		).toBeNull();
		expect(
			parseFidelityJudgeResponse(JSON.stringify({ fidelity: -5 })),
		).toBeNull();
	});

	it("defaults rationale to an empty string when absent", () => {
		expect(
			parseFidelityJudgeResponse(JSON.stringify({ fidelity: 60 })),
		).toEqual({ fidelity: 60, rationale: "" });
	});
});

describe("aggregateOptionAFidelity", () => {
	it("computes overall mean fidelity and quality-hit from scored cases only", () => {
		const outcomes: OptionAFidelityCaseOutcome[] = [
			{ kind: "scored", caseId: "a", capability: "calendar", fidelity: 90 },
			{ kind: "scored", caseId: "b", capability: "email", fidelity: 70 },
			{ kind: "withheld", caseId: "c", capability: "email" },
		];
		const { overall } = aggregateOptionAFidelity(outcomes);
		expect(overall).toEqual({
			n: 3,
			scoredN: 2,
			withheldN: 1,
			errorN: 0,
			meanFidelity: 80,
			qualityHitPercent: 20,
		});
	});

	it("reports null mean fidelity and quality-hit when nothing was scored", () => {
		const outcomes: OptionAFidelityCaseOutcome[] = [
			{ kind: "withheld", caseId: "a", capability: "photos" },
			{ kind: "error", caseId: "b", capability: "photos", error: "boom" },
		];
		const { overall } = aggregateOptionAFidelity(outcomes);
		expect(overall).toEqual({
			n: 2,
			scoredN: 0,
			withheldN: 1,
			errorN: 1,
			meanFidelity: null,
			qualityHitPercent: null,
		});
	});

	it("does not count withheld or error outcomes as a fidelity loss", () => {
		const allWithheld: OptionAFidelityCaseOutcome[] = [
			{ kind: "withheld", caseId: "a", capability: "files" },
			{ kind: "withheld", caseId: "b", capability: "files" },
		];
		const { overall } = aggregateOptionAFidelity(allWithheld);
		expect(overall.qualityHitPercent).toBeNull();
		expect(overall.withheldN).toBe(2);
	});

	it("breaks down per capability in first-seen order", () => {
		const outcomes: OptionAFidelityCaseOutcome[] = [
			{ kind: "scored", caseId: "a", capability: "email", fidelity: 60 },
			{ kind: "scored", caseId: "b", capability: "calendar", fidelity: 100 },
			{ kind: "scored", caseId: "c", capability: "email", fidelity: 80 },
			{ kind: "withheld", caseId: "d", capability: "contacts" },
		];
		const { byCapability } = aggregateOptionAFidelity(outcomes);
		expect(byCapability.map((c) => c.capability)).toEqual([
			"email",
			"calendar",
			"contacts",
		]);
		const email = byCapability.find((c) => c.capability === "email");
		expect(email).toMatchObject({ n: 2, scoredN: 2, meanFidelity: 70 });
		const contacts = byCapability.find((c) => c.capability === "contacts");
		expect(contacts).toMatchObject({
			n: 1,
			scoredN: 0,
			withheldN: 1,
			meanFidelity: null,
		});
	});

	it("returns an empty report for no outcomes without throwing", () => {
		expect(() => aggregateOptionAFidelity([])).not.toThrow();
		const { overall, byCapability } = aggregateOptionAFidelity([]);
		expect(overall).toEqual({
			n: 0,
			scoredN: 0,
			withheldN: 0,
			errorN: 0,
			meanFidelity: null,
			qualityHitPercent: null,
		});
		expect(byCapability).toEqual([]);
	});
});

describe("checkOptionAFidelityConfigured (not-configured branch)", () => {
	function deps(
		overrides: Partial<OptionAFidelityPreflightDeps> = {},
	): OptionAFidelityPreflightDeps {
		return {
			resolveChatProvider: async () => ({
				baseUrl: "http://127.0.0.1:8000",
				modelName: "local-chat",
				displayName: "Local Chat",
			}),
			resolveDistillModelId: () => "model2",
			isCloudModel: async () => false,
			...overrides,
		};
	}

	it("returns configured:true when the chat model resolves and the distill model is local", async () => {
		const result = await checkOptionAFidelityConfigured(deps());
		expect(result).toEqual({
			configured: true,
			chatModelId: "model1",
			chatModelDisplayName: "Local Chat",
			distillModelId: "model2",
		});
	});

	it("returns configured:false without throwing when the chat model does not resolve", async () => {
		const result = await checkOptionAFidelityConfigured(
			deps({
				resolveChatProvider: async () => {
					throw new Error("Normal Chat Model Run provider not found: model1");
				},
			}),
		);
		expect(result.configured).toBe(false);
		if (!result.configured) {
			expect(result.reason).toContain("model1");
		}
	});

	it("returns configured:false when the chat provider is missing baseUrl/modelName", async () => {
		const result = await checkOptionAFidelityConfigured(
			deps({
				resolveChatProvider: async () => ({
					baseUrl: "",
					modelName: "",
					displayName: "Unset",
				}),
			}),
		);
		expect(result.configured).toBe(false);
	});

	it("returns configured:false when no local-distill model is configured", async () => {
		const result = await checkOptionAFidelityConfigured(
			deps({ resolveDistillModelId: () => undefined }),
		);
		expect(result.configured).toBe(false);
		if (!result.configured) {
			expect(result.reason).toMatch(/no local-distill model/i);
		}
	});

	it("returns configured:false when the distill model resolves to a cloud host", async () => {
		const result = await checkOptionAFidelityConfigured(
			deps({ isCloudModel: async () => true }),
		);
		expect(result.configured).toBe(false);
		if (!result.configured) {
			expect(result.reason).toMatch(/cloud host/i);
		}
	});

	it("returns configured:false without throwing when isCloudModel rejects", async () => {
		const result = await checkOptionAFidelityConfigured(
			deps({
				isCloudModel: async () => {
					throw new Error("ECONNREFUSED");
				},
			}),
		);
		expect(result.configured).toBe(false);
		if (!result.configured) {
			expect(result.reason).toContain("ECONNREFUSED");
		}
	});
});

describe("buildNotConfiguredResult", () => {
	it("returns a skip result and never throws", () => {
		expect(() =>
			buildNotConfiguredResult(
				"no models configured",
				"2026-07-09T00:00:00.000Z",
			),
		).not.toThrow();
		const result = buildNotConfiguredResult(
			"no models configured",
			"2026-07-09T00:00:00.000Z",
		);
		expect(result).toEqual({
			status: "not_configured",
			generatedAt: "2026-07-09T00:00:00.000Z",
			reason: "no models configured",
		});
	});
});

describe("buildCompletedResult", () => {
	it("aggregates outcomes into a completed summary result", () => {
		const outcomes: OptionAFidelityCaseOutcome[] = [
			{ kind: "scored", caseId: "a", capability: "calendar", fidelity: 80 },
			{ kind: "withheld", caseId: "b", capability: "email" },
		];
		const result = buildCompletedResult({
			generatedAt: "2026-07-09T00:00:00.000Z",
			chatModelId: "model1",
			chatModelDisplayName: "Local Chat",
			distillModelId: "model2",
			outcomes,
		});
		expect(result).toMatchObject({
			status: "completed",
			generatedAt: "2026-07-09T00:00:00.000Z",
			chatModelId: "model1",
			chatModelDisplayName: "Local Chat",
			distillModelId: "model2",
			overall: { n: 2, scoredN: 1, withheldN: 1, meanFidelity: 80 },
		});
	});
});

describe("formatOptionAFidelitySummary", () => {
	it("formats the not-configured branch as a clear skip message", () => {
		const text = formatOptionAFidelitySummary(
			buildNotConfiguredResult(
				"Option-A fidelity eval requires the local distill model + a chat model configured; run on-box pre-release",
				"2026-07-09T00:00:00.000Z",
			),
		);
		expect(text).toContain("SKIPPED");
		expect(text).toContain("run on-box pre-release");
	});

	it("formats a completed result with overall and per-capability lines", () => {
		const outcomes: OptionAFidelityCaseOutcome[] = [
			{ kind: "scored", caseId: "a", capability: "calendar", fidelity: 90 },
			{ kind: "scored", caseId: "b", capability: "calendar", fidelity: 70 },
			{ kind: "withheld", caseId: "c", capability: "email" },
		];
		const result = buildCompletedResult({
			generatedAt: "2026-07-09T00:00:00.000Z",
			chatModelId: "model1",
			chatModelDisplayName: "Local Chat",
			distillModelId: "model2",
			outcomes,
		});
		const text = formatOptionAFidelitySummary(result);
		expect(text).toContain("Local Chat (model1)");
		expect(text).toContain("model2");
		expect(text).toContain("Overall: n=3 scored=2 withheld=1 error=0");
		expect(text).toContain("meanFidelity=80.0%");
		expect(text).toContain("qualityHit=20.0%");
		expect(text).toContain("calendar");
		expect(text).toContain("email");
	});
});
