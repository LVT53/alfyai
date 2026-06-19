import { describe, expect, it, vi } from "vitest";
import { auditAtlasBasis } from "./quality-gates";

describe("Atlas quality gates", () => {
	it("parses structured audit model markers and includes audit usage", async () => {
		const result = await auditAtlasBasis({
			assembledMarkdown: "Atlas report",
			sources: [{ title: "Example", url: "https://example.com" }],
			runAuditModel: vi.fn(async () => ({
				text: JSON.stringify({
					retryRequested: false,
					markers: [
						{
							code: "atlas_conflict",
							message: "Two sources disagree.",
							severity: "warning",
						},
					],
				}),
				usage: {
					inputTokens: 7,
					outputTokens: 3,
					totalTokens: 10,
					costUsdMicros: 0,
				},
			})),
		});

		expect(result.passed).toBe(true);
		expect(result.honestyMarkers).toContainEqual({
			code: "atlas_conflict",
			message: "Two sources disagree.",
			severity: "warning",
		});
		expect(result.usage).toEqual({
			inputTokens: 7,
			outputTokens: 3,
			totalTokens: 10,
			costUsdMicros: 0,
		});
	});

	it("fails the gate when the audit model requests a retry", async () => {
		const result = await auditAtlasBasis({
			assembledMarkdown: "Atlas report",
			sources: [{ title: "Example", url: "https://example.com" }],
			runAuditModel: vi.fn(async () => ({
				text: JSON.stringify({
					retryRequested: true,
					markers: [],
				}),
			})),
		});

		expect(result.passed).toBe(false);
		expect(result.retryRequested).toBe(true);
		expect(result.honestyMarkers).toContainEqual(
			expect.objectContaining({ code: "atlas_audit_retry_requested" }),
		);
	});

	it("records a same-model fallback warning without exposing raw audit text", async () => {
		const result = await auditAtlasBasis({
			assembledMarkdown: "Atlas report",
			sources: [{ title: "Example", url: "https://example.com" }],
			auditModelWarning:
				"Atlas audit used the synthesis model because no distinct audit model is enabled.",
			runAuditModel: vi.fn(async () => ({
				text: "not json",
			})),
		});

		expect(result.honestyMarkers).toContainEqual({
			code: "atlas_audit_model_fallback",
			message:
				"Atlas audit used the synthesis model because no distinct audit model is enabled.",
			severity: "warning",
		});
		expect(result.honestyMarkers).toContainEqual(
			expect.objectContaining({ code: "atlas_audit_unstructured" }),
		);
		expect(JSON.stringify(result)).not.toContain("not json");
	});

	it("adds Hungarian parity guidance to the audit prompt for Hungarian reports", async () => {
		const runAuditModel = vi.fn(async (_prompt: string) => ({
			text: '{"retryRequested": false, "markers": []}',
		}));

		await auditAtlasBasis({
			assembledMarkdown: "## Összefoglaló\nMagyar jelentés.",
			sources: [{ title: "Forrás", url: "https://example.com" }],
			language: "hu",
			runAuditModel,
		});

		const promptText = runAuditModel.mock.calls[0]?.[0];
		expect(promptText).toBeDefined();
		if (!promptText) throw new Error("Audit model was not called.");
		const prompt = JSON.parse(promptText) as {
			expectedLanguage: string;
			languageParityCheck: string;
		};
		expect(prompt.expectedLanguage).toBe("hu");
		expect(prompt.languageParityCheck).toContain("Hungarian Parity Check");
	});
});
