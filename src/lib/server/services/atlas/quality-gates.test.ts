import { describe, expect, it, vi } from "vitest";
import { auditAtlasBasis } from "./quality-gates";
import type { AtlasEvidencePack, AtlasSectionBrief } from "./types";

const evidencePack: AtlasEvidencePack = {
	version: "atlas.evidence-pack.v1",
	id: "pack-hybrid",
	sourceRefs: [
		{
			id: "web-hybrid",
			kind: "web",
			title: "Hybrid retrieval evidence",
			url: "https://example.com/hybrid",
			authority: "accepted_web",
		},
	],
	sourceKind: "web",
	authority: "accepted_web",
	supportedFacets: ["hybrid retrieval"],
	supportedQuestions: ["Which architecture is most reliable?"],
	evidence: {
		summary: "Hybrid retrieval combines lexical and semantic recall.",
		excerpt: "Hybrid retrieval combines lexical and semantic recall.",
	},
	conflicts: [],
	limitations: [],
	freshness: {
		asOfDate: "2026-06-21",
		retrievedAt: "2026-06-21",
		isCurrentEvidence: true,
		parentAtlasJobId: null,
		note: null,
	},
	affectedSectionHint: "Executive Summary",
	versionNote: "test pack",
};

const sectionBriefs: AtlasSectionBrief[] = [
	{
		sectionTitle: "Executive Summary",
		brief: "Summarizes the architecture recommendation.",
		evidencePackIds: ["pack-hybrid"],
		sourceAssociations: [],
		limitations: [],
	},
];

describe("Atlas quality gates", () => {
	it("parses structured claim basis output and derives temporary legacy markers", async () => {
		const result = await auditAtlasBasis({
			assembledMarkdown:
				"## Executive Summary\nHybrid retrieval improves recall before reranking.",
			sources: [{ title: "Example", url: "https://example.com" }],
			evidencePacks: [evidencePack],
			sectionBriefs,
			runAuditModel: vi.fn(async () => ({
				text: JSON.stringify({
					retryRequested: false,
					claimBasis: [
						{
							locator: {
								sectionTitle: "Executive Summary",
								paragraphIndex: 0,
								claimIndex: 0,
								claimText: "Hybrid retrieval improves recall before reranking.",
							},
							supportLevel: "supported",
							evidencePackIds: ["pack-hybrid"],
							supportRationale:
								"The accepted source says hybrid retrieval combines lexical and semantic recall.",
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
		expect(result.claimBasis).toHaveLength(1);
		expect(result.claimBasis[0]).toMatchObject({
			supportLevel: "supported",
			evidencePackIds: ["pack-hybrid"],
		});
		expect(result.honestyMarkers).toEqual([]);
		expect(result.claimBasisCoverageBySection).toContainEqual(
			expect.objectContaining({
				sectionTitle: "Executive Summary",
				basisCount: 1,
			}),
		);
		expect(result.usage).toEqual({
			inputTokens: 7,
			outputTokens: 3,
			totalTokens: 10,
			costUsdMicros: 0,
		});
	});

	it("requests a retry for unsupported ordinary prose", async () => {
		const result = await auditAtlasBasis({
			assembledMarkdown:
				"## Findings\nEvery regulated SaaS buyer adopted one identical RAG architecture in 2026.",
			sources: [{ title: "Example", url: "https://example.com" }],
			evidencePacks: [evidencePack],
			runAuditModel: vi.fn(async () => ({
				text: JSON.stringify({
					retryRequested: false,
					claimBasis: [
						{
							locator: {
								sectionTitle: "Findings",
								paragraphIndex: 0,
								claimIndex: 0,
								claimText:
									"Every regulated SaaS buyer adopted one identical RAG architecture in 2026.",
							},
							supportLevel: "partial",
							evidencePackIds: ["pack-hybrid"],
							supportRationale:
								"The accepted evidence does not make this universal adoption claim.",
							auditConcernCode: "hallucinated_fact",
						},
					],
				}),
			})),
		});

		expect(result.passed).toBe(false);
		expect(result.retryRequested).toBe(true);
		expect(result.claimBasis[0]?.supportLevel).toBe("unsupported");
		expect(result.honestyMarkers).toContainEqual(
			expect.objectContaining({
				code: "hallucinated_fact",
				severity: "critical",
			}),
		);
	});

	it("falls back to partial section-level basis when audit JSON fails with accepted evidence", async () => {
		const result = await auditAtlasBasis({
			assembledMarkdown:
				"## Executive Summary\nHybrid retrieval improves recall before reranking.",
			sources: [{ title: "Example", url: "https://example.com" }],
			evidencePacks: [evidencePack],
			sectionBriefs,
			auditModelWarning:
				"Atlas audit used the synthesis model because no distinct audit model is enabled.",
			runAuditModel: vi.fn(async () => ({
				text: "not json",
			})),
		});

		expect(result.claimBasis).toHaveLength(1);
		expect(result.claimBasis[0]).toMatchObject({
			supportLevel: "partial",
			auditConcernCode: "atlas_claim_basis_section_fallback",
		});
		expect(result.claimBasisStatus).toBe("succeeded");
		expect(result.claimBasisFailureReason).toBeNull();
		expect(result.basisDiagnostics).toContainEqual(
			expect.objectContaining({ code: "atlas_claim_basis_invalid_json" }),
		);
		expect(result.basisDiagnostics).toContainEqual(
			expect.objectContaining({
				code: "atlas_claim_basis_section_fallback",
			}),
		);
		expect(result.honestyMarkers).toContainEqual({
			code: "atlas_audit_model_fallback",
			message:
				"Atlas audit used the synthesis model because no distinct audit model is enabled.",
			severity: "warning",
		});
		expect(JSON.stringify(result)).not.toContain("not json");
	});

	it("keeps soft retry findings shippable when accepted sources back the report", async () => {
		const result = await auditAtlasBasis({
			assembledMarkdown:
				"## Executive Summary\nHybrid retrieval improves recall before reranking, but the evidence base is representative.",
			sources: [{ title: "Example", url: "https://example.com" }],
			evidencePacks: [evidencePack],
			sectionBriefs,
			runAuditModel: vi.fn(async () => ({
				text: JSON.stringify({
					retryRequested: true,
					claimBasis: [
						{
							locator: {
								sectionTitle: "Executive Summary",
								paragraphIndex: 0,
								claimIndex: 0,
								claimText:
									"Hybrid retrieval improves recall before reranking, but the evidence base is representative.",
							},
							supportLevel: "partial",
							evidencePackIds: ["pack-hybrid"],
							supportRationale:
								"The accepted source supports hybrid retrieval, while coverage remains representative.",
							auditConcernCode: "limited_evidence",
						},
					],
					limitations: [
						{
							code: "limited_evidence",
							message: "Evidence is representative rather than exhaustive.",
							basisIds: [],
							sectionTitle: "Executive Summary",
						},
					],
				}),
			})),
		});

		expect(result.retryRequested).toBe(true);
		expect(result.passed).toBe(true);
		expect(result.honestyMarkers).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "limited_evidence",
					severity: "warning",
				}),
				expect.objectContaining({
					code: "atlas_audit_retry_requested",
					severity: "warning",
				}),
			]),
		);
	});

	it("adds Hungarian parity guidance to the audit prompt for Hungarian reports", async () => {
		const runAuditModel = vi.fn(async (_prompt: string) => ({
			text: '{"retryRequested": false, "markers": []}',
		}));

		await auditAtlasBasis({
			assembledMarkdown: "## Összefoglaló\nMagyar jelentés.",
			sources: [{ title: "Forrás", url: "https://example.com" }],
			language: "hu",
			evidencePacks: [evidencePack],
			sectionBriefs,
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

	it("retries once with a minimal prompt when first parse returns invalid JSON", async () => {
		const runAuditModel = vi
			.fn()
			.mockResolvedValueOnce({
				text: "not json at all",
			})
			.mockResolvedValueOnce({
				text: JSON.stringify({
					retryRequested: false,
					claimBasis: [
						{
							locator: {
								sectionTitle: "Executive Summary",
								paragraphIndex: 0,
								claimIndex: 0,
								claimText: "Hybrid retrieval improves recall.",
							},
							supportLevel: "supported",
							evidencePackIds: ["pack-hybrid"],
							supportRationale:
								"The accepted source says hybrid retrieval combines lexical and semantic recall.",
						},
					],
				}),
			});

		const result = await auditAtlasBasis({
			assembledMarkdown:
				"## Executive Summary\nHybrid retrieval improves recall before reranking.",
			sources: [{ title: "Example", url: "https://example.com" }],
			evidencePacks: [evidencePack],
			sectionBriefs,
			runAuditModel,
		});

		expect(runAuditModel).toHaveBeenCalledTimes(2);
		expect(result.claimBasisStatus).toBe("succeeded");
		expect(result.claimBasis).toHaveLength(1);
		expect(result.claimBasis[0]?.supportLevel).toBe("supported");
		expect(result.basisDiagnostics).toContainEqual(
			expect.objectContaining({
				code: "atlas_claim_basis_retry_attempted",
				severity: "info",
			}),
		);
	});

	it("retries once when claimBasis array is empty but JSON is valid", async () => {
		const runAuditModel = vi
			.fn()
			.mockResolvedValueOnce({
				text: JSON.stringify({
					retryRequested: false,
					claimBasis: [],
				}),
			})
			.mockResolvedValueOnce({
				text: JSON.stringify({
					retryRequested: false,
					claimBasis: [
						{
							locator: {
								sectionTitle: "Executive Summary",
								paragraphIndex: 0,
								claimIndex: 0,
								claimText: "Hybrid retrieval improves recall.",
							},
							supportLevel: "supported",
							evidencePackIds: ["pack-hybrid"],
							supportRationale:
								"The accepted source says hybrid retrieval combines lexical and semantic recall.",
						},
					],
				}),
			});

		const result = await auditAtlasBasis({
			assembledMarkdown:
				"## Executive Summary\nHybrid retrieval improves recall.",
			sources: [{ title: "Example", url: "https://example.com" }],
			evidencePacks: [evidencePack],
			sectionBriefs,
			runAuditModel,
		});

		expect(runAuditModel).toHaveBeenCalledTimes(2);
		expect(result.claimBasisStatus).toBe("succeeded");
		expect(result.claimBasis).toHaveLength(1);
		expect(result.basisDiagnostics).toContainEqual(
			expect.objectContaining({
				code: "atlas_claim_basis_retry_attempted",
			}),
		);
	});

	it("does NOT retry when claimBasis array is non-empty and JSON is valid", async () => {
		const runAuditModel = vi.fn().mockResolvedValue({
			text: JSON.stringify({
				retryRequested: false,
				claimBasis: [
					{
						locator: {
							sectionTitle: "Executive Summary",
							paragraphIndex: 0,
							claimIndex: 0,
							claimText: "Hybrid retrieval improves recall.",
						},
						supportLevel: "supported",
						evidencePackIds: ["pack-hybrid"],
						supportRationale:
							"The accepted source says hybrid retrieval combines lexical and semantic recall.",
					},
				],
			}),
		});

		const result = await auditAtlasBasis({
			assembledMarkdown:
				"## Executive Summary\nHybrid retrieval improves recall.",
			sources: [{ title: "Example", url: "https://example.com" }],
			evidencePacks: [evidencePack],
			sectionBriefs,
			runAuditModel,
		});

		expect(runAuditModel).toHaveBeenCalledTimes(1);
		expect(result.claimBasisStatus).toBe("succeeded");
		expect(result.claimBasis).toHaveLength(1);
		expect(result.basisDiagnostics).not.toContainEqual(
			expect.objectContaining({
				code: "atlas_claim_basis_retry_attempted",
			}),
		);
	});

	it("falls back to section-level markers when retry also fails", async () => {
		const runAuditModel = vi
			.fn()
			.mockResolvedValueOnce({ text: "not valid json" })
			.mockResolvedValueOnce({ text: "still not json" });

		const result = await auditAtlasBasis({
			assembledMarkdown:
				"## Executive Summary\nHybrid retrieval improves recall before reranking.",
			sources: [{ title: "Example", url: "https://example.com" }],
			evidencePacks: [evidencePack],
			sectionBriefs,
			runAuditModel,
		});

		expect(runAuditModel).toHaveBeenCalledTimes(2);
		expect(result.claimBasisStatus).toBe("succeeded");
		expect(result.claimBasis[0]).toMatchObject({
			supportLevel: "partial",
			auditConcernCode: "atlas_claim_basis_section_fallback",
		});
		expect(result.basisDiagnostics).toContainEqual(
			expect.objectContaining({
				code: "atlas_claim_basis_retry_attempted",
				severity: "info",
			}),
		);
		expect(result.basisDiagnostics).toContainEqual(
			expect.objectContaining({
				code: "atlas_claim_basis_section_fallback",
			}),
		);
	});

	it("retries once when first parse returns missing claimBasis array", async () => {
		const runAuditModel = vi
			.fn()
			.mockResolvedValueOnce({
				text: JSON.stringify({ retryRequested: false }),
			})
			.mockResolvedValueOnce({
				text: JSON.stringify({
					retryRequested: false,
					claimBasis: [
						{
							locator: {
								sectionTitle: "Executive Summary",
								claimText: "Test claim.",
							},
							supportLevel: "supported",
							supportRationale: "evidence supports this.",
						},
					],
				}),
			});

		const result = await auditAtlasBasis({
			assembledMarkdown: "## Executive Summary\nTest.",
			sources: [{ title: "Example", url: "https://example.com" }],
			evidencePacks: [evidencePack],
			sectionBriefs,
			runAuditModel,
		});

		expect(runAuditModel).toHaveBeenCalledTimes(2);
		expect(result.claimBasisStatus).toBe("succeeded");
		expect(result.basisDiagnostics).toContainEqual(
			expect.objectContaining({
				code: "atlas_claim_basis_retry_attempted",
			}),
		);
	});

	it("includes retry attempted diagnostic even when retry succeeds with fallback", async () => {
		const runAuditModel = vi
			.fn()
			.mockResolvedValueOnce({ text: "not json" })
			.mockResolvedValueOnce({ text: "also not json" });

		const result = await auditAtlasBasis({
			assembledMarkdown: "## Executive Summary\nTest.",
			sources: [{ title: "Example", url: "https://example.com" }],
			evidencePacks: [evidencePack],
			sectionBriefs,
			runAuditModel,
		});

		const retryDiag = result.basisDiagnostics.filter(
			(d) => d.code === "atlas_claim_basis_retry_attempted",
		);
		expect(retryDiag).toHaveLength(1);
		expect(retryDiag[0]?.message).toContain("retried");
	});
});
