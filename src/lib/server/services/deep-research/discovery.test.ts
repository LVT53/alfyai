import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ResearchRequest,
	ResearchResult,
} from "$lib/server/services/web-research";
import type {
	DiscoveredResearchSourceCandidate,
	SavedDiscoveredResearchSource,
} from "./discovery";
import { runPublicWebDiscoveryPass } from "./discovery";
import type { ResearchPlan } from "./planning";
import type { SaveDiscoveredResearchSourceInput } from "./sources";
import {
	makeResearchSource,
	makeSavedDiscoveredSource,
	makeSavedDiscoveredSourceFromInput,
	mockTimelineEvent,
} from "./test-helpers";
import type { ResearchTimelineEvent } from "./timeline";

const {
	mockResearchWeb,
	mockSaveDiscoveredResearchSource,
	mockSaveResearchTimelineEvent,
} = vi.hoisted(() => ({
	mockResearchWeb:
		vi.fn<
			(request: ResearchRequest) => Promise<Pick<ResearchResult, "sources">>
		>(),
	mockSaveDiscoveredResearchSource:
		vi.fn<
			(
				source: SaveDiscoveredResearchSourceInput,
			) => Promise<SavedDiscoveredResearchSource>
		>(),
	mockSaveResearchTimelineEvent: vi.fn<
		(
			event: ResearchTimelineEvent,
		) => Promise<ResearchTimelineEvent & { id: string; createdAt: string }>
	>(async (event) => mockTimelineEvent(event)),
}));

function makeSavedDiscoveredSources(
	sources: DiscoveredResearchSourceCandidate[],
): ReturnType<typeof makeSavedDiscoveredSource>[] {
	return sources.map((source, index) =>
		makeSavedDiscoveredSource(source, index + 1),
	);
}

function createMockSaveDiscoveredSources() {
	return vi.fn(async (sources: DiscoveredResearchSourceCandidate[]) =>
		makeSavedDiscoveredSources(sources),
	);
}

vi.mock("$lib/server/config-store", () => ({
	getConfig: vi.fn(async () => ({
		searxngBaseUrl: "http://127.0.0.1:8080",
		braveSearchApiKey: "brave-key",
		webResearchSearxngNumResults: 12,
		webResearchSearxngLanguage: "en",
		webResearchSearxngSafesearch: 1,
		webResearchSearxngCategories: "general",
		webResearchMaxSources: 6,
		webResearchHighlightChars: 500,
		webResearchContentChars: 2000,
		webResearchFreshnessHours: 24,
	})),
}));

vi.mock("$lib/server/services/web-research", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("$lib/server/services/web-research")>();
	return {
		...actual,
		researchWeb: mockResearchWeb,
	};
});

vi.mock("./sources", () => ({
	saveDiscoveredResearchSource: mockSaveDiscoveredResearchSource,
}));

vi.mock("./timeline", () => ({
	saveResearchTimelineEvent: mockSaveResearchTimelineEvent,
}));

const approvedPlan: ResearchPlan = {
	goal: "Compare EU and US AI copyright training data rules",
	depth: "standard",
	reportIntent: "comparison",
	researchBudget: {
		sourceReviewCeiling: 40,
		synthesisPassCeiling: 2,
		meaningfulPassFloor: 1,
		meaningfulPassCeiling: 2,
		repairPassCeiling: 1,
		sourceProcessingConcurrency: 2,
		modelReasoningConcurrency: 1,
	},
	keyQuestions: [
		"What does the EU AI Act require for training data transparency?",
		"What do current US copyright cases say about AI training data?",
	],
	sourceScope: {
		includePublicWeb: true,
		planningContextDisclosure: null,
	},
	reportShape: ["Executive summary", "Comparison", "Source list"],
	constraints: ["Use current public sources."],
	deliverables: ["Cited Research Report"],
};

describe("public web discovery", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it("uses default discovery dependencies when none are injected", async () => {
		mockResearchWeb.mockResolvedValue({
			sources: [makeResearchSource()],
		});
		mockSaveDiscoveredResearchSource.mockImplementation(
			async (source: SaveDiscoveredResearchSourceInput) =>
				makeSavedDiscoveredSourceFromInput(source),
		);
		const result = await runPublicWebDiscoveryPass({
			jobId: "job-1",
			conversationId: "conversation-1",
			userId: "user-1",
			approvedPlan,
			now: new Date("2026-05-05T12:00:00.000Z"),
		});

		expect(mockResearchWeb).toHaveBeenCalledWith(
			expect.objectContaining({
				query: "Compare EU and US AI copyright training data rules",
				mode: "research",
				sourcePolicy: "general",
			}),
		);
		expect(mockSaveDiscoveredResearchSource).toHaveBeenCalledWith(
			expect.objectContaining({
				jobId: "job-1",
				conversationId: "conversation-1",
				userId: "user-1",
				url: "https://example.com/default-discovery",
				title: "Default discovery source",
				provider: "searxng",
				snippet: "A default dependency result.",
			}),
		);
		expect(mockSaveResearchTimelineEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				stage: "source_discovery",
				kind: "stage_completed",
				sourceCounts: {
					discovered: 1,
					reviewed: 0,
					cited: 0,
				},
			}),
		);
		expect(result.discoveredCount).toBe(1);
		expect(result.savedSources).toHaveLength(1);
	});

	it("discovers public web candidates from an approved Research Plan", async () => {
		const researchWeb = vi.fn().mockResolvedValue({
			sources: [
				makeResearchSource({
					id: "source-2",
					url: "https://example.eu/ai-act",
					canonicalUrl: "https://example.eu/ai-act",
					title: "EU AI Act training data guidance",
					snippet: "Transparency obligations for general-purpose AI.",
					publishedAt: "2026-04-30T00:00:00.000Z",
					authorityClass: "authoritative",
					authorityScore: 80,
				}),
			],
		});
		const saveDiscoveredSources = createMockSaveDiscoveredSources();

		const result = await runPublicWebDiscoveryPass(
			{
				jobId: "job-1",
				conversationId: "conversation-1",
				userId: "user-1",
				approvedPlan,
				now: new Date("2026-05-05T12:00:00.000Z"),
			},
			{
				researchWeb,
				sourceRepository: { saveDiscoveredSources },
				timelineRepository: {
					saveTimelineEvent: mockSaveResearchTimelineEvent,
				},
			},
		);

		expect(researchWeb).toHaveBeenCalledWith(
			expect.objectContaining({
				query: "Compare EU and US AI copyright training data rules",
				mode: "research",
				sourcePolicy: "general",
				maxSources: 10,
			}),
		);
		expect(saveDiscoveredSources).toHaveBeenCalledWith([
			expect.objectContaining({
				jobId: "job-1",
				conversationId: "conversation-1",
				userId: "user-1",
				url: "https://example.eu/ai-act",
				title: "EU AI Act training data guidance",
				provider: "searxng",
				discoveredAt: "2026-05-05T12:00:00.000Z",
				metadata: expect.objectContaining({
					query: "Compare EU and US AI copyright training data rules",
					snippet: "Transparency obligations for general-purpose AI.",
					authorityClass: "authoritative",
					authorityScore: 80,
					publishedAt: "2026-04-30T00:00:00.000Z",
				}),
			}),
		]);
		expect(mockSaveResearchTimelineEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				jobId: "job-1",
				conversationId: "conversation-1",
				userId: "user-1",
				stage: "source_discovery",
				kind: "stage_completed",
				occurredAt: "2026-05-05T12:00:00.000Z",
				sourceCounts: {
					discovered: 1,
					reviewed: 0,
					cited: 0,
				},
			}),
		);
		expect(result.discoveredCount).toBe(1);
		expect(result.savedSources).toHaveLength(1);
	});

	it("persists extracted Markdown source text for Deep Research review", async () => {
		const researchWeb = vi.fn().mockResolvedValue({
			sources: [
				makeResearchSource({
					id: "source-3",
					url: "https://example.eu/ai-act-markdown",
					canonicalUrl: "https://example.eu/ai-act-markdown",
					title: "EU AI Act training data guidance",
					snippet: "Transparency obligations for general-purpose AI.",
					text: "Plain extraction text without tables.",
					markdown:
						"# EU AI Act training data guidance\n\n| Layer | Role |\n| --- | --- |\n| Source summary | Training data transparency |\n\n```text\nsource-derived evidence only\n```",
					highlights: ["Opened page highlight."],
					publishedAt: "2026-04-30T00:00:00.000Z",
					authorityClass: "authoritative",
					authorityScore: 80,
				}),
			],
		});
		const saveDiscoveredSources = createMockSaveDiscoveredSources();

		await runPublicWebDiscoveryPass(
			{
				jobId: "job-markdown-discovery",
				conversationId: "conversation-1",
				userId: "user-1",
				approvedPlan,
				now: new Date("2026-05-05T12:00:00.000Z"),
			},
			{
				researchWeb,
				sourceRepository: { saveDiscoveredSources },
				timelineRepository: {
					saveTimelineEvent: mockSaveResearchTimelineEvent,
				},
			},
		);

		const [savedSources] = saveDiscoveredSources.mock.calls[0] ?? [];
		expect(savedSources?.[0]?.metadata.text).toContain(
			"| Source summary | Training data transparency |",
		);
		expect(savedSources?.[0]?.metadata.text).toContain("```text");
		expect(savedSources?.[0]?.metadata.text).toContain(
			"Opened page highlight.",
		);
		expect(savedSources?.[0]?.metadata.text).not.toContain(
			"Plain extraction text without tables.",
		);
	});

	it("uses web research inference for discovery request controls", async () => {
		const productScanPlan: ResearchPlan = {
			...approvedPlan,
			goal: "current Framework X Pro price",
			depth: "focused",
			reportIntent: "product_scan",
			researchBudget: {
				...approvedPlan.researchBudget,
				sourceReviewCeiling: 12,
				synthesisPassCeiling: 1,
			},
			keyQuestions: ["latest SvelteKit migration documentation"],
		};
		const researchWeb = vi.fn().mockResolvedValue({
			sources: [],
		});
		const saveDiscoveredSources = createMockSaveDiscoveredSources();

		await runPublicWebDiscoveryPass(
			{
				jobId: "job-product-scan-discovery",
				conversationId: "conversation-1",
				userId: "user-1",
				approvedPlan: productScanPlan,
				now: new Date("2026-05-05T12:00:00.000Z"),
			},
			{
				researchWeb,
				sourceRepository: { saveDiscoveredSources },
				timelineRepository: {
					saveTimelineEvent: mockSaveResearchTimelineEvent,
				},
			},
		);

		expect(researchWeb).toHaveBeenNthCalledWith(1, {
			query: "current Framework X Pro price",
			mode: "exact",
			freshness: "live",
			sourcePolicy: "commerce",
			maxSources: 6,
			quoteRequired: true,
		});
		expect(researchWeb).toHaveBeenNthCalledWith(2, {
			query: "latest SvelteKit migration documentation",
			mode: "quick",
			freshness: "live",
			sourcePolicy: "technical",
			maxSources: 6,
			quoteRequired: false,
		});
	});

	it("normalizes and deduplicates equivalent source URLs before saving", async () => {
		const researchWeb = vi.fn().mockResolvedValue({
			sources: [
				makeResearchSource({
					id: "source-4",
					url: "https://Example.com/report?utm_source=newsletter#findings",
					canonicalUrl:
						"https://Example.com/report?utm_source=newsletter#findings",
					title: " Market report ",
					snippet: "Original result.",
					authorityScore: 50,
				}),
				makeResearchSource({
					id: "source-5",
					url: "https://example.com/report/",
					canonicalUrl: "https://example.com/report/",
					title: "Market report duplicate",
					snippet: "Duplicate result.",
					authorityScore: 50,
				}),
			],
		});
		const saveDiscoveredSources = createMockSaveDiscoveredSources();

		await runPublicWebDiscoveryPass(
			{
				jobId: "job-1",
				conversationId: "conversation-1",
				userId: "user-1",
				approvedPlan,
				now: new Date("2026-05-05T12:00:00.000Z"),
			},
			{
				researchWeb,
				sourceRepository: { saveDiscoveredSources },
				timelineRepository: {
					saveTimelineEvent: mockSaveResearchTimelineEvent,
				},
			},
		);

		expect(saveDiscoveredSources).toHaveBeenCalledWith([
			expect.objectContaining({
				url: "https://example.com/report",
				title: "Market report",
				provider: "searxng",
				metadata: expect.objectContaining({
					canonicalUrl: "https://example.com/report",
				}),
			}),
		]);
		expect(mockSaveResearchTimelineEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				sourceCounts: {
					discovered: 1,
					reviewed: 0,
					cited: 0,
				},
			}),
		);
	});

	it("writes a source-discovery warning when web research fails", async () => {
		const researchWeb = vi
			.fn()
			.mockRejectedValue(new Error("provider unavailable"));
		const saveDiscoveredSources = createMockSaveDiscoveredSources();

		const result = await runPublicWebDiscoveryPass(
			{
				jobId: "job-1",
				conversationId: "conversation-1",
				userId: "user-1",
				approvedPlan,
				now: new Date("2026-05-05T12:00:00.000Z"),
			},
			{
				researchWeb,
				sourceRepository: { saveDiscoveredSources },
				timelineRepository: {
					saveTimelineEvent: mockSaveResearchTimelineEvent,
				},
			},
		);

		expect(saveDiscoveredSources).not.toHaveBeenCalled();
		expect(mockSaveResearchTimelineEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				stage: "source_discovery",
				kind: "warning",
				sourceCounts: {
					discovered: 0,
					reviewed: 0,
					cited: 0,
				},
				warnings: ["Public web discovery failed: provider unavailable"],
			}),
		);
		expect(result).toMatchObject({
			discoveredCount: 0,
			savedSources: [],
			warnings: ["Public web discovery failed: provider unavailable"],
		});
	});

	it("bounds discovery queries from the approved plan goal and key questions", async () => {
		const focusedPlan: ResearchPlan = {
			...approvedPlan,
			depth: "focused",
			researchBudget: {
				...approvedPlan.researchBudget,
				sourceReviewCeiling: 12,
				synthesisPassCeiling: 1,
			},
			keyQuestions: [
				"Which primary law changed most recently?",
				"Which regulator guidance is authoritative?",
				"Which litigation risk matters?",
			],
		};
		const researchWeb = vi.fn().mockResolvedValue({ sources: [] });
		const saveDiscoveredSources = createMockSaveDiscoveredSources();

		const result = await runPublicWebDiscoveryPass(
			{
				jobId: "job-1",
				conversationId: "conversation-1",
				userId: "user-1",
				approvedPlan: focusedPlan,
				now: new Date("2026-05-05T12:00:00.000Z"),
			},
			{
				researchWeb,
				sourceRepository: { saveDiscoveredSources },
				timelineRepository: {
					saveTimelineEvent: mockSaveResearchTimelineEvent,
				},
			},
		);

		expect(researchWeb).toHaveBeenCalledTimes(2);
		expect(researchWeb).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				query: "Compare EU and US AI copyright training data rules",
				maxSources: 6,
			}),
		);
		expect(researchWeb).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				query: "Which primary law changed most recently?",
				maxSources: 6,
			}),
		);
		expect(result.queries).toEqual([
			"Compare EU and US AI copyright training data rules",
			"Which primary law changed most recently?",
		]);
	});

	it.each([
		["focused", 6],
		["standard", 12],
		["max", 24],
	] as const)("uses the %s comparison query cap for entity-axis discovery", async (depth, expectedQueryCount) => {
		const comparisonPlan: ResearchPlan = {
			...approvedPlan,
			depth,
			comparedEntities: [
				"Entity A",
				"Entity B",
				"Entity C",
				"Entity D",
				"Entity E",
				"Entity F",
			],
			comparisonAxes: ["privacy", "pricing", "security", "roadmap"],
			goal: "Compare six entities across four axes",
			researchBudget: {
				...approvedPlan.researchBudget,
				sourceReviewCeiling: 240,
				synthesisPassCeiling: 2,
			},
		};
		const researchWeb = vi.fn().mockResolvedValue({
			sources: [],
		});
		const saveDiscoveredSources = createMockSaveDiscoveredSources();
		const saveTimelineEvent = vi.fn(async (event: ResearchTimelineEvent) => ({
			...event,
			id: "event-1",
			createdAt: event.occurredAt,
		}));

		const result = await runPublicWebDiscoveryPass(
			{
				jobId: `job-comparison-${depth}`,
				conversationId: "conversation-1",
				userId: "user-1",
				approvedPlan: comparisonPlan,
				now: new Date("2026-05-05T12:00:00.000Z"),
			},
			{
				researchWeb,
				sourceRepository: { saveDiscoveredSources },
				timelineRepository: { saveTimelineEvent },
			},
		);

		expect(researchWeb).toHaveBeenCalledTimes(expectedQueryCount);
		expect(result.queries).toHaveLength(expectedQueryCount);
		expect(result.queries[0]).toBe("Entity A privacy");
		expect(result.queries.at(-1)).toBe(
			expectedQueryCount === 6
				? "Entity F privacy"
				: expectedQueryCount === 12
					? "Entity F pricing"
					: "Entity F roadmap",
		);
	});

	it("creates targeted entity-axis queries for comparison plans", async () => {
		const comparisonPlan: ResearchPlan = {
			...approvedPlan,
			comparedEntities: ["GitHub Copilot", "Cursor"],
			comparisonAxes: ["privacy", "pricing"],
			goal: "Compare GitHub Copilot and Cursor for privacy and pricing",
		};
		const researchWeb = vi.fn(async (request: ResearchRequest) => ({
			sources: [
				makeResearchSource({
					id: "source-6",
					url: `https://example.com/${request.query.replace(/\s+/g, "-").toLowerCase()}`,
					canonicalUrl: `https://example.com/${request.query.replace(/\s+/g, "-").toLowerCase()}`,
					title: `Source for ${request.query}`,
					snippet: "Comparison source.",
					authorityClass: "standard",
					authorityScore: 50,
				}),
			],
		}));
		const saveDiscoveredSources = createMockSaveDiscoveredSources();
		const saveTimelineEvent = vi.fn(async (event: ResearchTimelineEvent) => ({
			...event,
			id: "event-1",
			createdAt: event.occurredAt,
		}));

		const result = await runPublicWebDiscoveryPass(
			{
				jobId: "job-comparison-discovery",
				conversationId: "conversation-1",
				userId: "user-1",
				approvedPlan: comparisonPlan,
				now: new Date("2026-05-05T12:00:00.000Z"),
			},
			{
				researchWeb,
				sourceRepository: { saveDiscoveredSources },
				timelineRepository: { saveTimelineEvent },
			},
		);

		expect(result.queries).toEqual([
			"GitHub Copilot privacy",
			"Cursor privacy",
			"GitHub Copilot pricing",
			"Cursor pricing",
		]);
		expect(saveDiscoveredSources).toHaveBeenCalledWith(
			expect.arrayContaining([
				expect.objectContaining({
					metadata: expect.objectContaining({
						query: "GitHub Copilot privacy",
						intendedComparedEntity: "GitHub Copilot",
						intendedComparisonAxis: "privacy",
					}),
				}),
				expect.objectContaining({
					metadata: expect.objectContaining({
						query: "Cursor pricing",
						intendedComparedEntity: "Cursor",
						intendedComparisonAxis: "pricing",
					}),
				}),
			]),
		);
	});

	it("keeps comparison discovery queries entity-axis specific for Cube model constraints", async () => {
		const comparisonPlan: ResearchPlan = {
			...approvedPlan,
			goal: "Compare Cube Nulane 400X and Cube Kathmandu SLX",
			depth: "standard",
			comparedEntities: ["Cube Nulane 400X", "Cube Kathmandu SLX"],
			comparisonAxes: [
				"focusing 2026 model year",
				"pricing",
				"availability in Europe",
				"Medium frame size",
			],
			researchBudget: {
				...approvedPlan.researchBudget,
				sourceReviewCeiling: 80,
				synthesisPassCeiling: 2,
			},
		};
		const researchWeb = vi.fn().mockResolvedValue({
			sources: [],
		});
		const saveDiscoveredSources = createMockSaveDiscoveredSources();
		const saveTimelineEvent = vi.fn(async (event: ResearchTimelineEvent) => ({
			...event,
			id: "event-1",
			createdAt: event.occurredAt,
		}));

		const result = await runPublicWebDiscoveryPass(
			{
				jobId: "job-cube-discovery",
				conversationId: "conversation-1",
				userId: "user-1",
				approvedPlan: comparisonPlan,
				now: new Date("2026-05-05T12:00:00.000Z"),
			},
			{
				researchWeb,
				sourceRepository: { saveDiscoveredSources },
				timelineRepository: { saveTimelineEvent },
			},
		);

		expect(result.queries).toEqual([
			"Cube Nulane 400X 2026 model year",
			"Cube Kathmandu SLX 2026 model year",
			"Cube Nulane 400X pricing",
			"Cube Kathmandu SLX pricing",
			"Cube Nulane 400X availability Europe",
			"Cube Kathmandu SLX availability Europe",
			"Cube Nulane 400X Medium frame size",
			"Cube Kathmandu SLX Medium frame size",
		]);
		expect(result.queries).not.toContain("focusing 2026 model year");
		for (const query of result.queries) {
			expect(query).toMatch(/^Cube (?:Nulane 400X|Kathmandu SLX) /);
		}
	});

	it("keeps comparison discovery queries entity-axis specific for software compliance axes", async () => {
		const comparisonPlan: ResearchPlan = {
			...approvedPlan,
			goal: "Compare Acme Analytics Pro and Acme Analytics Enterprise",
			depth: "standard",
			comparedEntities: ["Acme Analytics Pro", "Acme Analytics Enterprise"],
			comparisonAxes: ["SOC 2", "data residency", "SSO", "audit logs"],
			researchBudget: {
				...approvedPlan.researchBudget,
				sourceReviewCeiling: 80,
				synthesisPassCeiling: 2,
			},
		};
		const researchWeb = vi.fn().mockResolvedValue({
			sources: [],
		});
		const saveDiscoveredSources = createMockSaveDiscoveredSources();
		const saveTimelineEvent = vi.fn(async (event: ResearchTimelineEvent) => ({
			...event,
			id: "event-1",
			createdAt: event.occurredAt,
		}));

		const result = await runPublicWebDiscoveryPass(
			{
				jobId: "job-saas-discovery",
				conversationId: "conversation-1",
				userId: "user-1",
				approvedPlan: comparisonPlan,
				now: new Date("2026-05-05T12:00:00.000Z"),
			},
			{
				researchWeb,
				sourceRepository: { saveDiscoveredSources },
				timelineRepository: { saveTimelineEvent },
			},
		);

		expect(result.queries).toEqual([
			"Acme Analytics Pro SOC 2",
			"Acme Analytics Enterprise SOC 2",
			"Acme Analytics Pro data residency",
			"Acme Analytics Enterprise data residency",
			"Acme Analytics Pro SSO",
			"Acme Analytics Enterprise SSO",
			"Acme Analytics Pro audit logs",
			"Acme Analytics Enterprise audit logs",
		]);
		for (const query of result.queries) {
			expect(query).toMatch(/^Acme Analytics (?:Pro|Enterprise) /);
		}
	});
});
