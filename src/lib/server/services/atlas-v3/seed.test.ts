// Loading and applying a lifecycle child's seed (Phase D): what the parent's
// report and checkpoints yield, for v1, v2 and v3 parents alike, and which
// parents may seed at all — checked against a real (in-memory) database too.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";
import {
	type GeneratedDocumentSource,
	validateGeneratedDocumentSource,
} from "$lib/server/services/file-production/source-schema";
import {
	STORED_V1_SOURCE,
	STORED_V2_SOURCE,
} from "$lib/server/services/file-production/testing/atlas-legacy-document-sources";
import type { AtlasParentJob } from "../atlas/checkpoints";

let memory: InMemoryDatabase;

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

const {
	listAtlasRoundCheckpoints,
	loadAtlasParentJob,
	writeAtlasRoundCheckpoint,
} = await import("../atlas/checkpoints");
const {
	applyAtlasV3Seed,
	atlasV3SeedUrlsFromCheckpointPool,
	extractAtlasV3ParentReport,
	loadAtlasV3ParentSeed,
	stripAtlasV3CitationTokens,
} = await import("./seed");
const { fakeModel, fakeResearchWeb } = await import("./test-support");

import type { AtlasV3SeedReads } from "./seed";
import type { AtlasV3EvidenceBank, AtlasV3ParentSeed } from "./types";

function validated(source: unknown): GeneratedDocumentSource {
	const result = validateGeneratedDocumentSource(structuredClone(source));
	if (!result.ok) throw new Error(`fixture is invalid: ${result.message}`);
	return result.source;
}

/** What `buildAtlasV3DocumentSource` produces, in miniature. */
const STORED_V3_SOURCE = {
	version: 1,
	template: "alfyai_standard_report",
	title: "EU solar additions, 2025",
	subtitle: null,
	date: "2026-09-20",
	language: "en",
	blocks: [
		{ type: "heading", level: 2, text: "Verdict" },
		{
			type: "paragraph",
			text: "The EU added 65.1 GW of solar in 2025. [1][[cite:2:c]] Rooftop demand fell 21%. [[cite:3:s]]",
		},
		{ type: "heading", level: 2, text: "Additions held at 65.1 GW" },
		{ type: "paragraph", text: "Two trackers agree. [[cite:2:c]]" },
		{ type: "heading", level: 2, text: "What this report could not establish" },
		{ type: "list", style: "bullet", items: ["Nothing material."] },
		{
			type: "sourceChips",
			title: "Sources",
			sources: [
				{
					title: "IEA — iea.org",
					url: "https://iea.org/reports/solar-2025",
					kind: "web",
					provided: false,
				},
				{
					title: "Meter log.pdf",
					url: null,
					kind: "library",
					provided: true,
				},
				{
					title: "BBC — bbc.com",
					url: "https://bbc.com/news/eu-solar",
					kind: "web",
					provided: false,
				},
			],
		},
	],
};

describe("extractAtlasV3ParentReport", () => {
	it("reads a stored v1 report: headings, summary without basis tokens, web chips", () => {
		const report = extractAtlasV3ParentReport(validated(STORED_V1_SOURCE));
		expect(report).toEqual({
			title: "Enterprise Search Atlas",
			headings: ["Risks"],
			verdict: "Search should combine local authority and web freshness.",
			webSources: [
				{ url: "https://example.com/docs", title: "Vendor docs" },
				{ url: "https://example.com/audit", title: "Auditability benchmark" },
			],
		});
	});

	it("reads a stored v2 report and strips its cite tokens", () => {
		const report = extractAtlasV3ParentReport(validated(STORED_V2_SOURCE));
		expect(report.headings).toEqual(["Capacity"]);
		expect(report.verdict).toBe("The union added capacity at pace.");
		expect(report.webSources.map((entry) => entry.url)).toEqual([
			"https://source1.example/report",
			"https://source2.example/report",
			"https://source3.example/report",
		]);
	});

	it("reads a v3 report, leaving its library chips out of the web sources", () => {
		const report = extractAtlasV3ParentReport(validated(STORED_V3_SOURCE));
		expect(report.headings).toEqual(["Additions held at 65.1 GW"]);
		expect(report.verdict).toBe(
			"The EU added 65.1 GW of solar in 2025. Rooftop demand fell 21%.",
		);
		expect(report.webSources.map((entry) => entry.url)).toEqual([
			"https://iea.org/reports/solar-2025",
			"https://bbc.com/news/eu-solar",
		]);
	});

	it("caps the verdict at 1,200 characters", () => {
		const long = validated({
			...STORED_V3_SOURCE,
			blocks: [
				{ type: "heading", level: 2, text: "Verdict" },
				{
					type: "paragraph",
					text: `${"A sentence. ".repeat(300)}[[cite:1:c]]`,
				},
			],
		});
		expect(extractAtlasV3ParentReport(long).verdict).toHaveLength(1200);
	});

	it("strips every citation token form", () => {
		expect(
			stripAtlasV3CitationTokens(
				"Capacity reached 8 GW. [2][[cite:3:c]] Grid limits ᶜ bind. [[cite:i]]",
			),
		).toBe("Capacity reached 8 GW. Grid limits bind.");
	});
});

describe("atlasV3SeedUrlsFromCheckpointPool", () => {
	it("reads v1's { web } pool and v2/v3's flat pool, skipping local entries", () => {
		expect(
			atlasV3SeedUrlsFromCheckpointPool({
				web: [{ url: "https://a.example/x", title: "A" }],
				local: [{ title: "Doc" }],
			}),
		).toEqual([{ url: "https://a.example/x", title: "A" }]);
		expect(
			atlasV3SeedUrlsFromCheckpointPool([
				{ url: "https://b.example/y", title: "B" },
				{ kind: "local", url: null, title: "Doc" },
				{ url: "https://b.example/y", title: "B again" },
			]),
		).toEqual([{ url: "https://b.example/y", title: "B" }]);
		expect(atlasV3SeedUrlsFromCheckpointPool(null)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// loadAtlasV3ParentSeed with fake reads
// ---------------------------------------------------------------------------

const CHILD = {
	userId: "user-1",
	conversationId: "conv-1",
	action: "continue" as const,
	parentAtlasJobId: "parent-1",
};

function bank(sourceIds: string[]): AtlasV3EvidenceBank {
	return {
		sources: sourceIds.map((id, index) => ({
			id,
			canonicalUrl:
				index === 0
					? "https://iea.org/reports/solar-2025"
					: `https://example.org/${id}`,
			host: "example.org",
			publisher: `pub-${id}`,
			title: id,
			date: null,
			tier: "press",
			read: true,
		})),
		quotes: sourceIds.map((id, index) => ({
			id: `e${index + 1}`,
			sourceId: id,
			text: `A quote long enough from ${id}.`,
			goal: "g",
		})),
		claims: [],
		filteredCount: 0,
	};
}

function v3Row(
	roundNumber: number,
	phase: string,
	data: unknown,
	pool: unknown = [],
) {
	return {
		roundNumber,
		checkpoint: { schema: "atlas.v3.checkpoint.v1", phase, data },
		curatedSourcePool: pool,
	};
}

function reads(input: {
	parent: Partial<AtlasParentJob> | null;
	checkpoints?: Array<{
		roundNumber: number;
		checkpoint: unknown;
		curatedSourcePool: unknown;
	}>;
	report?: unknown;
	kickoffDocuments?: string[];
}): AtlasV3SeedReads {
	return {
		loadParentJob: async () =>
			input.parent
				? {
						id: "parent-1",
						status: "succeeded",
						conversationId: "conv-1",
						pipelineVersion: 3,
						completedAt: new Date("2026-09-20T12:00:00Z"),
						fileProductionJobId: "fp-parent",
						assistantMessageId: "msg-parent",
						...input.parent,
					}
				: null,
		loadCheckpoints: async () => input.checkpoints ?? [],
		loadReportSource: async () =>
			input.report ? validated(input.report) : null,
		listKickoffDocumentIds: async () => input.kickoffDocuments ?? [],
	};
}

describe("loadAtlasV3ParentSeed", () => {
	it("seeds nothing for a create, or from a parent that cannot seed", async () => {
		expect(
			await loadAtlasV3ParentSeed({
				job: { ...CHILD, action: "create" },
				reads: reads({ parent: {} }),
			}),
		).toBeNull();
		for (const parent of [
			null,
			{ status: "failed" },
			{ status: "running" },
			{ conversationId: "conv-other" },
		]) {
			expect(
				await loadAtlasV3ParentSeed({ job: CHILD, reads: reads({ parent }) }),
			).toBeNull();
		}
	});

	it("prefers the verify-row bank over the research rows, and reads the cited sources", async () => {
		const seed = await loadAtlasV3ParentSeed({
			job: CHILD,
			reads: reads({
				parent: {},
				report: STORED_V3_SOURCE,
				checkpoints: [
					v3Row(1, "ask", {
						ask: { coreQuestion: "How much solar?", title: "EU solar" },
					}),
					v3Row(11, "research", {
						round: 1,
						bank: bank(["s1", "s2", "s3"]),
						memo: {
							answerSoFar: "x",
							claimIds: [],
							openQuestions: [],
							deadEnds: [],
						},
						asked: ["q1"],
					}),
					v3Row(20, "outline", { outline: { nodes: [], cut: [] } }),
					v3Row(24, "verify", { totals: {}, bank: bank(["s1", "s3"]) }),
					v3Row(25, "render", { outputs: {}, citedSourceIds: ["s3"] }),
				],
			}),
		});
		expect(seed?.v3?.bank?.sources.map((source) => source.id)).toEqual([
			"s1",
			"s3",
		]);
		expect(seed?.v3?.citedSourceIds).toEqual(["s3"]);
		expect(seed?.v3?.asked).toEqual(["q1"]);
		expect(seed?.v3?.ask?.coreQuestion).toBe("How much solar?");
		expect(seed?.report?.headings).toEqual(["Additions held at 65.1 GW"]);
		expect(seed?.parentCompletedAt).toBe("2026-09-20T12:00:00.000Z");
	});

	it("falls back to the latest research bank, and to the report's chips for cited sources", async () => {
		const seed = await loadAtlasV3ParentSeed({
			job: CHILD,
			reads: reads({
				parent: {},
				report: STORED_V3_SOURCE,
				checkpoints: [
					v3Row(11, "research", { round: 1, bank: bank(["s1"]) }),
					v3Row(12, "research", { round: 2, bank: bank(["s1", "s2"]) }),
				],
			}),
		});
		expect(seed?.v3?.bank?.sources.map((source) => source.id)).toEqual([
			"s1",
			"s2",
		]);
		// s1's URL is the report's first web chip.
		expect(seed?.v3?.citedSourceIds).toEqual(["s1"]);
	});

	it("inherits the parent bank's documents and its kickoff documents, once each", async () => {
		const withLocal = bank(["s1"]);
		withLocal.sources.push({
			id: "s2",
			kind: "local",
			canonicalUrl: "atlas-local:art-meter",
			host: "",
			publisher: "user-documents",
			title: "Meter log.pdf",
			date: null,
			tier: "user_document",
			read: true,
			displayArtifactId: "art-meter",
			promptArtifactId: "art-meter-n",
			origin: "attachment",
		});
		const seed = await loadAtlasV3ParentSeed({
			job: CHILD,
			reads: reads({
				parent: {},
				checkpoints: [v3Row(24, "verify", { bank: withLocal })],
				kickoffDocuments: ["art-meter", "art-contract"],
			}),
		});
		expect(seed?.localDisplayArtifactIds).toEqual([
			"art-meter",
			"art-contract",
		]);
	});

	it("gives a Fork the parent's report and documents but none of its working state", async () => {
		const seed = await loadAtlasV3ParentSeed({
			job: { ...CHILD, action: "fork" },
			reads: reads({
				parent: {},
				report: STORED_V3_SOURCE,
				checkpoints: [v3Row(24, "verify", { bank: bank(["s1"]) })],
				kickoffDocuments: ["art-meter"],
			}),
		});
		expect(seed?.action).toBe("fork");
		expect(seed?.v3).toBeNull();
		expect(seed?.report?.verdict).toContain("65.1 GW");
		expect(seed?.localDisplayArtifactIds).toEqual(["art-meter"]);
	});

	it("reads a v1 parent's report, and its checkpoint pool when no report persisted", async () => {
		const fromReport = await loadAtlasV3ParentSeed({
			job: CHILD,
			reads: reads({
				parent: { pipelineVersion: 1 },
				report: STORED_V1_SOURCE,
			}),
		});
		expect(fromReport?.parentPipelineVersion).toBe(1);
		expect(fromReport?.v3).toBeNull();
		expect(fromReport?.report?.webSources).toHaveLength(2);

		const fromPool = await loadAtlasV3ParentSeed({
			job: CHILD,
			reads: reads({
				parent: { pipelineVersion: 1, fileProductionJobId: null },
				checkpoints: [
					{
						roundNumber: 3,
						checkpoint: { stage: "audit" },
						curatedSourcePool: {
							web: [{ url: "https://old.example/a", title: "Old" }],
						},
					},
				],
			}),
		});
		expect(fromPool?.report).toEqual({
			title: "",
			headings: [],
			verdict: "",
			webSources: [{ url: "https://old.example/a", title: "Old" }],
		});

		const fromV2Pool = await loadAtlasV3ParentSeed({
			job: CHILD,
			reads: reads({
				parent: { pipelineVersion: 2, fileProductionJobId: null },
				checkpoints: [
					{
						roundNumber: 4,
						checkpoint: {},
						curatedSourcePool: [{ url: "https://v2.example/b", title: "V2" }],
					},
				],
			}),
		});
		expect(fromV2Pool?.report?.webSources).toEqual([
			{ url: "https://v2.example/b", title: "V2" },
		]);
	});
});

// ---------------------------------------------------------------------------
// applyAtlasV3Seed
// ---------------------------------------------------------------------------

function timeSensitiveSeed(input: {
	parentCompletedAt: string;
	localDisplayArtifactIds?: string[];
	withLocal?: { retrievedAt: string };
}): AtlasV3ParentSeed {
	const parentBank: AtlasV3EvidenceBank = {
		sources: [
			{
				id: "s1",
				canonicalUrl: "https://iea.org/reports/solar-2025",
				host: "iea.org",
				publisher: "iea",
				title: "IEA",
				date: null,
				tier: "primary",
				read: true,
				// Written before Phase D: no retrieval time.
			},
		],
		quotes: [
			{
				id: "e1",
				sourceId: "s1",
				text: "The EU added 65.1 GW of solar capacity in 2025.",
				goal: "g",
			},
		],
		claims: [
			{
				id: "c1",
				entity: "EU",
				metric: "solar additions",
				value: "65.1",
				unit: "GW",
				period: "2025",
				asOf: null,
				series: null,
				evidenceIds: ["e1"],
				status: "single",
			},
		],
		filteredCount: 0,
	};
	if (input.withLocal) {
		parentBank.sources.push({
			id: "s2",
			kind: "local",
			canonicalUrl: "atlas-local:art-meter",
			host: "",
			publisher: "user-documents",
			title: "Meter log.pdf",
			date: null,
			tier: "user_document",
			read: true,
			displayArtifactId: "art-meter",
			promptArtifactId: "art-meter-n",
			origin: "attachment",
			retrievedAt: input.withLocal.retrievedAt,
		});
		parentBank.quotes.push({
			id: "e2",
			sourceId: "s2",
			text: "Our household used 1,234 kWh in 2025 per the meter log.",
			goal: "g",
		});
	}
	return {
		parentJobId: "parent-1",
		action: "continue",
		parentPipelineVersion: 3,
		parentCompletedAt: input.parentCompletedAt,
		report: null,
		v3: {
			ask: null,
			bank: parentBank,
			memo: null,
			asked: [],
			outline: null,
			citedSourceIds: ["s1"],
		},
		localDisplayArtifactIds: input.localDisplayArtifactIds ?? [],
	};
}

async function apply(
	seed: AtlasV3ParentSeed,
	localDocuments: Parameters<typeof applyAtlasV3Seed>[0]["localDocuments"] = [],
) {
	const web = fakeResearchWeb({
		hits: [],
		freshPages: {
			"https://iea.org/reports/solar-2025":
				"The EU added 65.1 GW of solar capacity in 2025.",
		},
	});
	const result = await applyAtlasV3Seed({
		seed,
		now: new Date("2026-09-24T00:00:00Z"),
		language: "en",
		currentDate: "2026-09-24",
		coreQuestion: "How much solar did the EU add?",
		budget: 8,
		windowDays: 14,
		localDocuments,
		researchWeb: web,
		runReadModel: fakeModel({}).call,
		concurrency: 1,
	});
	return { result, web };
}

describe("applyAtlasV3Seed", () => {
	it("dates a pre-Phase-D source by the parent's completion time", async () => {
		const recent = await apply(
			timeSensitiveSeed({ parentCompletedAt: "2026-09-20T00:00:00.000Z" }),
		);
		expect(recent.web.freshReadCalls).toEqual([]);
		expect(recent.result.outcomes.s1).toBe("trusted");
		expect(recent.result.state.sources[0]?.retrievedAt).toBe(
			"2026-09-20T00:00:00.000Z",
		);
		expect(recent.result.state.sources[0]?.seededFrom).toBe("parent-1");

		const old = await apply(
			timeSensitiveSeed({ parentCompletedAt: "2026-08-01T00:00:00.000Z" }),
		);
		expect(old.web.freshReadCalls).toEqual([
			"https://iea.org/reports/solar-2025",
		]);
		expect(old.result.outcomes.s1).toBe("confirmed");
		expect(old.result.state.sources[0]?.retrievedAt).toBe(
			"2026-09-24T00:00:00.000Z",
		);
	});

	it("keeps an inherited document's quotes while it still resolves unchanged", async () => {
		const { result } = await apply(
			timeSensitiveSeed({
				parentCompletedAt: "2026-09-20T00:00:00.000Z",
				withLocal: { retrievedAt: "2026-09-20T00:00:00.000Z" },
			}),
			[
				{
					displayArtifactId: "art-meter",
					promptArtifactId: "art-meter-n2",
					title: "Meter log.pdf",
					origin: "inherited",
					summary: null,
					updatedAt: "2026-09-01T00:00:00.000Z",
				},
			],
		);
		const local = result.state.sources.find(
			(source) => source.kind === "local",
		);
		expect(local?.kind === "local" && local.origin).toBe("inherited");
		expect(local?.kind === "local" && local.promptArtifactId).toBe(
			"art-meter-n2",
		);
		expect(result.state.quotes.map((quote) => quote.id)).toContain("e2");
	});

	it("drops an inherited document's quotes when it changed since, or no longer resolves", async () => {
		const changed = await apply(
			timeSensitiveSeed({
				parentCompletedAt: "2026-09-20T00:00:00.000Z",
				withLocal: { retrievedAt: "2026-09-20T00:00:00.000Z" },
			}),
			[
				{
					displayArtifactId: "art-meter",
					promptArtifactId: "art-meter-n",
					title: "Meter log.pdf",
					origin: "inherited",
					summary: null,
					updatedAt: "2026-09-22T00:00:00.000Z",
				},
			],
		);
		expect(changed.result.state.quotes.map((quote) => quote.id)).not.toContain(
			"e2",
		);
		expect(changed.result.diagnostics.dropped).toBe(1);

		const gone = await apply(
			timeSensitiveSeed({
				parentCompletedAt: "2026-09-20T00:00:00.000Z",
				withLocal: { retrievedAt: "2026-09-20T00:00:00.000Z" },
			}),
			[],
		);
		expect(
			gone.result.state.sources.some((source) => source.kind === "local"),
		).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Against the database: which parents may seed at all
// ---------------------------------------------------------------------------

const NOW = new Date("2026-09-20T10:00:00.000Z");

function seedUser(id: string) {
	memory.db
		.insert(schema.users)
		.values({
			id,
			email: `${id}@example.com`,
			passwordHash: "hash",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

function seedConversation(id: string, userId: string) {
	memory.db
		.insert(schema.conversations)
		.values({ id, userId, title: id, createdAt: NOW, updatedAt: NOW })
		.run();
}

function seedJob(input: {
	id: string;
	userId: string;
	conversationId: string;
	status: string;
}) {
	memory.db
		.insert(schema.atlasJobs)
		.values({
			id: input.id,
			userId: input.userId,
			conversationId: input.conversationId,
			action: "create",
			profile: "overview",
			pipelineVersion: 3,
			normalizedQueryHash: "hash",
			clientAtlasTurnId: `turn-${input.id}`,
			idempotencyKey: `idem-${input.id}`,
			title: input.id,
			status: input.status,
			completedAt: input.status === "succeeded" ? NOW : null,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

describe("loadAtlasV3ParentSeed against the database", () => {
	beforeEach(() => {
		memory = createInMemoryDatabase();
		seedUser("user-1");
		seedUser("user-2");
		seedConversation("conv-1", "user-1");
		seedConversation("conv-2", "user-1");
		seedConversation("conv-3", "user-2");
		seedJob({
			id: "p-ok",
			userId: "user-1",
			conversationId: "conv-1",
			status: "succeeded",
		});
		seedJob({
			id: "p-failed",
			userId: "user-1",
			conversationId: "conv-1",
			status: "failed",
		});
		seedJob({
			id: "p-elsewhere",
			userId: "user-1",
			conversationId: "conv-2",
			status: "succeeded",
		});
		seedJob({
			id: "p-theirs",
			userId: "user-2",
			conversationId: "conv-3",
			status: "succeeded",
		});
	});

	afterEach(() => {
		memory.close();
	});

	const dbReads: AtlasV3SeedReads = {
		loadParentJob: (input) => loadAtlasParentJob(input),
		loadCheckpoints: async (jobId) =>
			(await listAtlasRoundCheckpoints(jobId)).map((entry) => ({
				roundNumber: entry.roundNumber,
				checkpoint: entry.checkpoint,
				curatedSourcePool: entry.curatedSourcePool,
			})),
		loadReportSource: async () => null,
		listKickoffDocumentIds: async () => [],
	};

	function child(parentAtlasJobId: string) {
		return {
			userId: "user-1",
			conversationId: "conv-1",
			action: "continue" as const,
			parentAtlasJobId,
		};
	}

	it("seeds from a succeeded parent in the same conversation, reading its verify bank", async () => {
		await writeAtlasRoundCheckpoint({
			jobId: "p-ok",
			roundNumber: 24,
			stage: "verify",
			checkpoint: {
				schema: "atlas.v3.checkpoint.v1",
				phase: "verify",
				data: { bank: bank(["s1"]) },
			},
		});
		const seed = await loadAtlasV3ParentSeed({
			job: child("p-ok"),
			reads: dbReads,
		});
		expect(seed?.parentJobId).toBe("p-ok");
		expect(seed?.parentPipelineVersion).toBe(3);
		expect(seed?.parentCompletedAt).toBe(NOW.toISOString());
		expect(seed?.v3?.bank?.sources.map((source) => source.id)).toEqual(["s1"]);
	});

	it("gives null for a failed parent, another conversation's, or another user's", async () => {
		for (const parent of ["p-failed", "p-elsewhere", "p-theirs", "p-missing"]) {
			expect(
				await loadAtlasV3ParentSeed({ job: child(parent), reads: dbReads }),
			).toBeNull();
		}
		expect(
			await loadAtlasParentJob({
				userId: "user-1",
				parentAtlasJobId: "p-theirs",
			}),
		).toBeNull();
	});
});
