// Stored Atlas v1 and v2 report sources, shared by the tests that must keep
// reading them: the old-report regression test in this directory and the Atlas
// v3 lifecycle seed test (a Continue on an old parent reads its report).
//
// Not a test file: it exports no `describe`, so vitest never runs it as a suite.
//
// Atlas v1 and v2 were deleted in the v3-only consolidation (Phase B), but the
// `GeneratedDocumentSource` each of them persisted on its report's
// `generated_output` artifact is still read: `read_generated_file` re-renders
// it, and a re-run of File Production renders it again. These two fixtures are
// the ACTUAL output of the deleted builders, captured by running
// `buildAtlasDocumentSource` (v1, `atlas/renderer-output.ts`) and
// `buildAtlasV2DocumentSource` (v2, `atlas-v2/render.ts`) at the
// `atlas-v1-v2-final` tag — not hand-written approximations — so a schema or
// renderer change that would break an old stored report fails here.
export const STORED_V1_SOURCE = {
	version: 1,
	template: "alfyai_standard_report",
	title: "Enterprise Search Atlas",
	subtitle: "Representative evidence map",
	date: "2026-06-19",
	language: "en",
	cover: {
		enabled: true,
		eyebrow: "Report date: 2026-06-19",
		dateLabel: null,
	},
	blocks: [
		{ type: "heading", level: 2, text: "Executive summary" },
		{
			type: "paragraph",
			text: "Search should combine local authority and web freshness [1].",
		},
		{
			type: "image",
			source: {
				kind: "https",
				url: "https://example.com/enterprise-search-architecture.png",
			},
			altText: "Enterprise search architecture diagram",
			caption: "Enterprise search architecture diagram",
			sourceAttribution: {
				title: "Example Research",
				url: "https://example.com/enterprise-search-architecture",
			},
			critical: false,
		},
		{ type: "heading", level: 2, text: "Risks" },
		{
			type: "paragraph",
			text: "The market has unresolved adoption signals.[[cite:i]]",
			basisMarkers: [
				{
					type: "basisMarker",
					id: "basis-unanchored",
					support: "unsupported",
					rationale: "No accepted source supports the unanchored risk claim.",
					auditCode: "atlas_unanchored_risk",
					anchorText: "The market has unresolved adoption signals.[[cite:i]]",
					occurrence: 0,
				},
			],
		},
		{
			type: "paragraph",
			text: "Hybrid retrieval improves recall[[cite:s]] before reranking [2].",
			basisMarkers: [
				{
					type: "basisMarker",
					id: "basis-partial",
					support: "partial",
					rationale: "The benchmark covers recall but not reranking order.",
					sourceRefs: [
						{
							title: "Auditability benchmark",
							url: "https://example.com/audit",
						},
					],
					anchorText: "Hybrid retrieval improves recall[[cite:s]]",
					occurrence: 0,
				},
			],
		},
		{ type: "heading", level: 2, text: "Sources" },
		{
			type: "sourceChips",
			title: "Web Sources",
			sources: [
				{
					title: "Vendor docs",
					url: "https://example.com/docs",
					kind: "web",
					provided: false,
					reasoning: "Vendor documentation covers current API limits.",
				},
				{
					title: "Auditability benchmark",
					url: "https://example.com/audit",
					kind: "web",
					provided: false,
					reasoning: "Documents auditability expectations for research tools.",
				},
			],
		},
		{
			type: "sourceChips",
			title: "Your Library",
			sources: [
				{
					title: "Uploaded strategy memo",
					url: null,
					kind: "library",
					provided: true,
					reasoning: "You provided these",
				},
			],
		},
	],
};

export const STORED_V2_SOURCE = {
	version: 1,
	template: "alfyai_standard_report",
	title: "EU solar capacity in 2026",
	subtitle: null,
	date: "2026-09-08",
	language: "en",
	blocks: [
		{ type: "heading", level: 2, text: "Executive summary" },
		{
			type: "paragraph",
			text: "The union added capacity at pace. [[cite:1:s]]",
		},
		{ type: "heading", level: 2, text: "Capacity" },
		{
			type: "paragraph",
			text: "Capacity reached 8 GW. [2][[cite:3:c]] Growth slowed in the second half. [[cite:1:s]] Grid limits are the likely cause. [[cite:i]]",
		},
		{ type: "heading", level: 2, text: "Limitations" },
		{
			type: "list",
			style: "bullet",
			items: [
				"No usable evidence was found for: What did Malta install?",
				"One sentence was removed because no cited source supported it.",
			],
		},
		{
			type: "sourceChips",
			title: "Sources",
			sources: [
				{
					title: "Report 1 — source1.example, 2026-04-01",
					url: "https://source1.example/report",
					kind: "web",
					provided: false,
				},
				{
					title: "Report 2 — source2.example, 2026-04-01",
					url: "https://source2.example/report",
					kind: "web",
					provided: false,
				},
				{
					title: "Report 3 — source3.example, 2026-04-01",
					url: "https://source3.example/report",
					kind: "web",
					provided: false,
				},
			],
		},
	],
};
