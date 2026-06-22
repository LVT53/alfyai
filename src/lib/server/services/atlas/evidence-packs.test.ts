import { describe, expect, it } from "vitest";
import {
	ATLAS_EVIDENCE_PACK_SCHEMA_VERSION,
	buildAtlasEvidencePacks,
	normalizeEvidenceText,
} from "./evidence-packs";

describe("Atlas evidence packs", () => {
	it("builds stable compact packs for explicit local sources with highest authority", () => {
		const longLocalText = [
			"Internal rollout playbook: regulated SaaS teams must keep lexical retrieval for exact compliance terms and vector retrieval for concept discovery.",
			"Reranking is required before final answer generation because broad retrieval can include stale policy drafts.",
			"This line should be compacted rather than persisted as an unbounded raw source dump.",
			"Extra operational detail ".repeat(80),
		].join(" ");

		const first = buildAtlasEvidencePacks({
			query: "Compare retrieval architectures for regulated SaaS",
			currentDate: "2026-06-21",
			curatedEvidence:
				"Curated fact: hybrid retrieval is the preferred architecture.",
			localSources: [
				{
					id: "artifact-explicit-1",
					title: "Internal rollout playbook",
					authority: "explicit",
					text: longLocalText,
				},
			],
			webSources: [],
			searchLimitation: null,
			parentSeed: null,
		});
		const second = buildAtlasEvidencePacks({
			query: "Compare retrieval architectures for regulated SaaS",
			currentDate: "2026-06-21",
			curatedEvidence:
				"Curated fact: hybrid retrieval is the preferred architecture.",
			localSources: [
				{
					id: "artifact-explicit-1",
					title: "Internal rollout playbook",
					authority: "explicit",
					text: longLocalText,
				},
			],
			webSources: [],
			searchLimitation: null,
			parentSeed: null,
		});

		expect(first.version).toBe(ATLAS_EVIDENCE_PACK_SCHEMA_VERSION);
		expect(first.evidencePacks).toHaveLength(1);
		expect(first.evidencePacks[0]).toMatchObject({
			version: ATLAS_EVIDENCE_PACK_SCHEMA_VERSION,
			sourceKind: "local",
			authority: "explicit_local",
			sourceRefs: [
				{
					id: "artifact-explicit-1",
					title: "Internal rollout playbook",
					kind: "local",
					authority: "explicit_local",
				},
			],
			supportedQuestions: [
				"Compare retrieval architectures for regulated SaaS",
			],
			freshness: {
				asOfDate: null,
				retrievedAt: null,
				isCurrentEvidence: true,
				parentAtlasJobId: null,
			},
		});
		expect(first.evidencePacks[0].evidence.excerpt.length).toBeLessThan(900);
		expect(first.evidencePacks[0].evidence.excerpt).not.toContain(
			"Extra operational detail Extra operational detail Extra operational detail Extra operational detail Extra operational detail Extra operational detail",
		);
		expect(first.evidencePacks[0].id).toBe(second.evidencePacks[0].id);
	});

	it("collapses duplicate web sources and records freshness metadata", () => {
		const result = buildAtlasEvidencePacks({
			query: "What changed in AI regulation this year?",
			currentDate: "2026-06-21",
			curatedEvidence:
				"Curated fact: current reporting says regulators updated enforcement guidance.",
			localSources: [],
			webSources: [
				{
					id: "web-a",
					title: "AI Regulation Update",
					url: "https://example.com/report?b=2&a=1#section",
					snippet:
						"Fetched page excerpt: Current reporting from 2026-06-20 says regulators updated enforcement guidance for AI systems.",
				},
				{
					id: "web-b",
					title: "AI Regulation Update duplicate",
					url: "https://example.com/report?a=1&b=2",
					snippet:
						"Search result snippet: Duplicate result for the same reporting.",
				},
			],
			searchLimitation: null,
			parentSeed: null,
		});

		expect(result.evidencePacks).toHaveLength(1);
		expect(result.evidencePacks[0]).toMatchObject({
			sourceKind: "web",
			authority: "accepted_web",
			sourceRefs: [
				expect.objectContaining({ id: "web-a", kind: "web" }),
				expect.objectContaining({ id: "web-b", kind: "web" }),
			],
			freshness: {
				asOfDate: "2026-06-20",
				retrievedAt: "2026-06-21",
				isCurrentEvidence: true,
				parentAtlasJobId: null,
			},
		});
		expect(result.evidencePacks[0].evidence.summary).toContain(
			"Current reporting",
		);
	});

	it("represents parent seed evidence without treating it as fresh current evidence", () => {
		const result = buildAtlasEvidencePacks({
			query: "Revise the prior Atlas report for current deployment risks",
			currentDate: "2026-06-21",
			curatedEvidence: "",
			localSources: [],
			webSources: [],
			searchLimitation: null,
			parentSeed: {
				parentAtlasJobId: "atlas-parent-1",
				compressedFindings: {
					synthesize:
						"Parent report found that hybrid retrieval reduced noisy matches, but it was written before the new deployment deadline.",
				},
				curatedSourcePool: null,
				checkpoint: {},
				documentSourceSummary: {},
			},
		});

		expect(result.evidencePacks).toHaveLength(1);
		expect(result.evidencePacks[0]).toMatchObject({
			sourceKind: "local",
			authority: "parent_seed",
			sourceRefs: [
				{
					id: "parent:atlas-parent-1:compressed-findings",
					title: "Parent Atlas compressed findings",
					kind: "local",
					authority: "parent_seed",
				},
			],
			freshness: {
				asOfDate: null,
				retrievedAt: null,
				isCurrentEvidence: false,
				parentAtlasJobId: "atlas-parent-1",
			},
			limitations: [
				expect.stringContaining(
					"Parent Atlas seed evidence is context, not fresh current evidence",
				),
			],
		});
	});

	it("records a diagnostic instead of fabricating packs when no evidence is available", () => {
		const result = buildAtlasEvidencePacks({
			query: "Research a topic with no available sources",
			currentDate: "2026-06-21",
			curatedEvidence: "",
			localSources: [],
			webSources: [],
			searchLimitation: {
				code: "atlas_search_unavailable",
				message: "Search endpoint unavailable.",
			},
			parentSeed: null,
		});

		expect(result.evidencePacks).toEqual([]);
		expect(result.diagnostics).toEqual([
			{
				code: "atlas_evidence_packs_empty",
				severity: "warning",
				message:
					"No accepted Atlas sources or parent seed findings were available for Evidence Pack creation.",
			},
			{
				code: "atlas_search_unavailable",
				severity: "warning",
				message: "Search endpoint unavailable.",
			},
		]);
	});
});

describe("normalizeEvidenceText sanitization", () => {
	it("strips Accepted source excerpt label", () => {
		const text = "Accepted source excerpt: This is the actual content.";
		expect(normalizeEvidenceText(text)).toBe("This is the actual content.");
	});

	it("strips SearXNG metadata keywords", () => {
		const text =
			"Naptár · Keresés · Beállítások · Some content about AI regulation.";
		expect(normalizeEvidenceText(text)).toBe(
			"Some content about AI regulation.",
		);
	});

	it("strips SearXNG Hungarian filter echoes", () => {
		const text =
			"Nem tartalmazza: foo | Tartalmaznia kell: bar | Content about retrieval.";
		expect(normalizeEvidenceText(text)).toBe("Content about retrieval.");
	});

	it("strips SearXNG English filter echoes", () => {
		const text =
			"Excluding: foo | Must include: bar | Content about regulation.";
		expect(normalizeEvidenceText(text)).toBe("Content about regulation.");
	});

	it("strips YouTube channel prefix", () => {
		const text = "YouTube · SomeChannel This is an AI review video content.";
		expect(normalizeEvidenceText(text)).toBe(
			"SomeChannel This is an AI review video content.",
		);
	});

	it("strips Hungarian date prefix", () => {
		const text = "2024. jan. 26. · Some content about hybrid retrieval.";
		expect(normalizeEvidenceText(text)).toBe(
			"Some content about hybrid retrieval.",
		);
	});

	it("strips Hungarian date prefix with full month name", () => {
		const text =
			"2024. január 26. · Content about regulated AI SaaS deployment.";
		expect(normalizeEvidenceText(text)).toBe(
			"Content about regulated AI SaaS deployment.",
		);
	});

	it("strips English YouTube footer multi-word phrases", () => {
		const text = "Policy & Safety How YouTube works Test new features";
		expect(normalizeEvidenceText(text)).toBe("");
	});

	it("strips Hungarian YouTube footer text", () => {
		const text =
			"Ismertető Sajtó Szerzői jog Kapcsolatfelvétel Alkotók Hirdetés Fejlesztők Feltételek Adatvédelem Irányelvek YouTube működése Új funkciók tesztelése";
		expect(normalizeEvidenceText(text)).toBe("");
	});

	it("strips all source labels together", () => {
		const text =
			"Search result snippet: snippet. Fetched page excerpt: excerpt. Accepted source excerpt: excerpt2.";
		expect(normalizeEvidenceText(text)).toBe("snippet. excerpt. excerpt2.");
	});

	it("strips combined SearXNG artifacts", () => {
		const text =
			"Naptár · Nem tartalmazza: foo | Tartalmaznia kell: bar | 2024. márc. 15. · Actual content here.";
		expect(normalizeEvidenceText(text)).toBe("Actual content here.");
	});

	it("preserves meaningful text without artifacts", () => {
		const text =
			"Hybrid retrieval combines lexical and vector search for regulated SaaS environments.";
		expect(normalizeEvidenceText(text)).toBe(text);
	});
});

describe("Atlas evidence pack summary boilerplate filtering", () => {
	it("filters boilerplate cookie sentences from evidence summary", () => {
		const result = buildAtlasEvidencePacks({
			query: "test",
			currentDate: "2026-06-22",
			curatedEvidence: "",
			localSources: [
				{
					id: "test-1",
					title: "Test Source",
					authority: "explicit",
					text: "This cookie policy explains how we use cookies. The actual research finding shows that AI models perform better with structured data. Subscribe to our newsletter for updates.",
				},
			],
			webSources: [],
			searchLimitation: null,
			parentSeed: null,
		});

		const summary = result.evidencePacks[0].evidence.summary;
		expect(summary).toContain("actual research finding");
		expect(summary).not.toContain("cookie policy");
		expect(summary).not.toContain("Subscribe");
	});

	it("falls back to source title when all evidence is boilerplate", () => {
		const result = buildAtlasEvidencePacks({
			query: "test",
			currentDate: "2026-06-22",
			curatedEvidence: "",
			localSources: [
				{
					id: "test-2",
					title: "Test Source Title",
					authority: "explicit",
					text: "This site uses cookies. Privacy policy applies. Subscribe to our newsletter.",
				},
			],
			webSources: [],
			searchLimitation: null,
			parentSeed: null,
		});

		expect(result.evidencePacks[0].evidence.summary).toContain(
			"Test Source Title",
		);
	});

	it("strips SearXNG boilerplate from evidence summary", () => {
		const result = buildAtlasEvidencePacks({
			query: "test",
			currentDate: "2026-06-22",
			curatedEvidence: "",
			localSources: [
				{
					id: "test-3",
					title: "Web Research",
					authority: "explicit",
					text: "Keresés Beállítások Naptár. The actual research finding validates hybrid retrieval. Excluding: old results | Must include: recent studies.",
				},
			],
			webSources: [],
			searchLimitation: null,
			parentSeed: null,
		});

		const summary = result.evidencePacks[0].evidence.summary;
		expect(summary).toContain("actual research finding");
		expect(summary).not.toContain("Keresés");
		expect(summary).not.toContain("Excluding:");
	});

	it("strips YouTube footer from evidence summary via build", () => {
		const result = buildAtlasEvidencePacks({
			query: "test",
			currentDate: "2026-06-22",
			curatedEvidence: "",
			localSources: [
				{
					id: "test-4",
					title: "YouTube Review",
					authority: "explicit",
					text: "This video reviews the new retrieval architecture. About Press Copyright Contact us Creators.",
				},
			],
			webSources: [],
			searchLimitation: null,
			parentSeed: null,
		});

		const summary = result.evidencePacks[0].evidence.summary;
		expect(summary).toContain("retrieval architecture");
		expect(summary).not.toContain("About Press");
	});

	it("preserves evidence without boilerplate in summary", () => {
		const result = buildAtlasEvidencePacks({
			query: "test",
			currentDate: "2026-06-22",
			curatedEvidence: "",
			localSources: [
				{
					id: "test-5",
					title: "Clean Source",
					authority: "explicit",
					text: "Hybrid retrieval reduces noisy matches in regulated environments. Reranking is required before final answer generation.",
				},
			],
			webSources: [],
			searchLimitation: null,
			parentSeed: null,
		});

		const summary = result.evidencePacks[0].evidence.summary;
		expect(summary).toContain("Hybrid retrieval");
		expect(summary).toContain("Reranking");
	});
});
