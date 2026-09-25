import { describe, expect, it, vi } from "vitest";
import type { ContextDebugState } from "./knowledge/context-types";
import {
	buildAssistantEvidenceSummary,
	countProjectFilesRead,
	type ProjectFilesEvidenceContext,
	toolReadArtifactIdsMetadata,
} from "./message-evidence";
import type { ToolCallEntry } from "./messages-types";

vi.mock("./knowledge", () => ({
	getArtifactsForUser: vi.fn(async () => []),
}));

vi.mock("./tei-reranker", () => ({
	canUseTeiReranker: vi.fn(() => false),
	rerankItems: vi.fn(async () => null),
}));

vi.mock("./evidence-family", () => ({
	resolveArtifactFamilyKeys: vi.fn(async () => new Map()),
}));

describe("buildAssistantEvidenceSummary", () => {
	it("references promoted sibling context only when its trace section entered prompt context", async () => {
		const included = await buildAssistantEvidenceSummary({
			userId: "user-1",
			message: "what font options did we discuss in this project?",
			taskState: null,
			contextTraceSections: [
				{
					name: "Project Folder Sibling Context",
					source: "memory",
					body: 'Title: "Font options"',
					inclusionLevel: "legacy_full",
					itemIds: ["conversation:conv-fonts"],
					itemTitles: ["Font options"],
					signalReasons: [
						"project_folder_sibling:query_match",
						"project_folder_sibling_score:24",
					],
				},
			],
		});

		expect(included?.groups).toEqual([
			expect.objectContaining({
				sourceType: "memory",
				items: [
					expect.objectContaining({
						id: "conversation:conv-fonts",
						title: "Font options",
						sourceType: "memory",
						status: "reference",
						description:
							"Promoted from the same Project Folder for this query.",
						channels: ["memory"],
					}),
				],
			}),
		]);

		const omitted = await buildAssistantEvidenceSummary({
			userId: "user-1",
			message: "what font options did we discuss in this project?",
			taskState: null,
			contextTraceSections: [
				{
					name: "Project Folder Sibling Context",
					source: "memory",
					body: 'Title: "Font options"',
					inclusionLevel: "omitted",
					itemIds: ["conversation:conv-fonts"],
					itemTitles: ["Font options"],
					signalReasons: ["project_folder_sibling:query_match"],
				},
			],
		});

		expect(omitted).toBeNull();
	});

	it("omits unselected memory_context candidates from completed tool calls", async () => {
		const summary = await buildAssistantEvidenceSummary({
			userId: "user-1",
			message: "use the pricing context from the project tool",
			taskState: null,
			toolCalls: [
				{
					name: "memory_context",
					input: { mode: "project", query: "pricing" },
					status: "done",
					sourceType: "memory",
					candidates: [
						{
							id: "memory-context:project:conv-pricing",
							title: "Pricing project",
							snippet:
								"Stable pricing brief. user: Recent user message assistant: Recent assistant message",
							sourceType: "memory",
						},
						{
							id: "memory-context:persona:user-1",
							title: "Profile persona recall",
							snippet: "The user prefers concise answers.",
							sourceType: "memory",
						},
						{
							id: "memory-context:history:conv-cycling",
							title: "Cycling history",
							snippet: "Older non-project cycling discussion.",
							sourceType: "memory",
						},
					],
				},
				{
					name: "memory_context",
					input: { mode: "history", query: "draft" },
					status: "running",
					sourceType: "memory",
					candidates: [
						{
							id: "memory-context:history:running",
							title: "Running history lookup",
							snippet:
								"This incomplete lookup should not be persisted as evidence.",
							sourceType: "memory",
						},
					],
				},
			],
		});

		expect(summary).toBeNull();
		expect(JSON.stringify(summary)).not.toContain("Running history lookup");
	});

	it("includes selected memory_context candidates and carries applied limits", async () => {
		const summary = await buildAssistantEvidenceSummary({
			userId: "user-1",
			message: "use memory_context history",
			taskState: null,
			toolCalls: [
				{
					name: "memory_context",
					input: { mode: "history", query: "bike" },
					status: "done",
					sourceType: "memory",
					metadata: {
						mode: "history",
						appliedMaxHistoryConversations: 3,
						omittedConversationCount: 2,
					},
					candidates: [
						{
							id: "memory-context:history:conv-bike",
							title: "Bike planning",
							snippet: "Discussed commute setup and tire width.",
							sourceType: "memory",
							metadata: { selected: true },
						},
						{
							id: "memory-context:history:conv-fit",
							title: "Bike fit",
							snippet: "Discussed saddle height constraints.",
							sourceType: "memory",
							material: true,
						},
					],
				},
			],
		});

		expect(summary?.groups).toEqual([
			expect.objectContaining({
				sourceType: "memory",
				items: [
					expect.objectContaining({
						id: "memory-context:history:conv-bike",
						title: "Bike planning",
						sourceType: "memory",
						status: "reference",
						metadata: {
							mode: "history",
							appliedMaxHistoryConversations: 3,
							omittedConversationCount: 2,
						},
					}),
					expect.objectContaining({
						id: "memory-context:history:conv-fit",
						title: "Bike fit",
						sourceType: "memory",
						status: "reference",
					}),
				],
			}),
		]);
	});

	it("ignores running web and tool calls when building evidence internally", async () => {
		const summary = await buildAssistantEvidenceSummary({
			userId: "user-1",
			message: "show me current launch pricing",
			taskState: null,
			toolCalls: [
				{
					name: "web_search",
					input: { query: "current launch pricing" },
					status: "running",
					sourceType: "web",
					candidates: [
						{
							id: "web-running",
							title: "Incomplete web result",
							url: "https://example.com/incomplete",
							snippet: "This result is not final.",
							sourceType: "web",
						},
					],
				},
				{
					name: "custom_tool",
					input: { topic: "pricing" },
					status: "running",
					sourceType: "tool",
					outputSummary: "Partial tool output",
				},
			],
		});

		expect(summary).toBeNull();
	});

	it("emits per-fact persona memory evidence from the ambient Baseline Memory Profile trace section", async () => {
		const summary = await buildAssistantEvidenceSummary({
			userId: "user-7",
			message: "what do you remember about me and my preferences?",
			taskState: null,
			contextStatus: {
				layersUsed: ["session"],
				summary: "Session summary text.",
			} as never,
			contextTraceSections: [
				{
					name: "Baseline Memory Profile",
					source: "memory",
					body: "Facts:\n- Prefers concise answers.\n- Works in TypeScript.",
					inclusionLevel: "legacy_full",
					itemIds: ["fact-a", "fact-b"],
					itemTitles: ["Prefers concise answers.", "Works in TypeScript."],
				},
			],
		});

		const memoryGroup = summary?.groups.find(
			(group) => group.sourceType === "memory",
		);
		expect(memoryGroup).toBeTruthy();
		const factItems = memoryGroup?.items.filter((item) =>
			item.id.startsWith("memory-fact:"),
		);
		expect(factItems).toEqual([
			expect.objectContaining({
				id: "memory-fact:fact-a",
				title: "Prefers concise answers.",
				sourceType: "memory",
				metadata: expect.objectContaining({ memoryItemId: "fact-a" }),
			}),
			expect.objectContaining({
				id: "memory-fact:fact-b",
				title: "Works in TypeScript.",
				sourceType: "memory",
				metadata: expect.objectContaining({ memoryItemId: "fact-b" }),
			}),
		]);
		// The aggregate "session-memory" item is replaced by the per-fact items.
		expect(
			memoryGroup?.items.some((item) => item.id === "session-memory"),
		).toBe(false);
	});

	it("includes persona-fact memory_context tool candidates that carry memoryItemId even without an explicit selected flag", async () => {
		const summary = await buildAssistantEvidenceSummary({
			userId: "user-7",
			message: "what do you remember about me?",
			taskState: null,
			toolCalls: [
				{
					name: "memory_context",
					input: { mode: "persona", query: "preferences" },
					status: "done",
					sourceType: "memory",
					candidates: [
						{
							id: "memory-fact:fact-a",
							title: "Prefers concise answers.",
							sourceType: "memory",
							metadata: { memoryItemId: "fact-a" },
						},
						{
							id: "memory-context:summary:user-7",
							title: "Persona summary",
							sourceType: "memory",
						},
					],
				},
			],
		});

		const memoryGroup = summary?.groups.find(
			(group) => group.sourceType === "memory",
		);
		expect(memoryGroup).toBeTruthy();
		expect(
			memoryGroup?.items.find((item) => item.id === "memory-fact:fact-a"),
		).toEqual(
			expect.objectContaining({
				id: "memory-fact:fact-a",
				sourceType: "memory",
				metadata: expect.objectContaining({ memoryItemId: "fact-a" }),
			}),
		);
		expect(
			memoryGroup?.items.some(
				(item) => item.id === "memory-context:summary:user-7",
			),
		).toBe(true);
	});

	describe("web evidence citation-driven classification", () => {
		const webCandidate = (id: string, url: string) => ({
			id,
			title: `Title ${id}`,
			url,
			snippet: `snippet ${id}`,
			sourceType: "web" as const,
			material: true,
		});
		const webTool = (candidates: ReturnType<typeof webCandidate>[]) => ({
			name: "research_web",
			input: { query: "q" },
			status: "done" as const,
			sourceType: "web" as const,
			candidates,
		});
		const fourWebCandidates = () => [
			webCandidate("a", "https://a.example.com/one"),
			webCandidate("b", "https://b.example.com/two"),
			webCandidate("c", "https://c.example.com/three"),
			webCandidate("d", "https://d.example.com/four"),
		];

		it("marks only cited web sources as used and demotes a high-rank uncited source to reference", async () => {
			const summary = await buildAssistantEvidenceSummary({
				userId: "user-1",
				message: "compare the frameworks",
				taskState: null,
				toolCalls: [webTool(fourWebCandidates())],
				// The answer cited only the LAST candidate. Under the old
				// reranker/default logic candidate "a" (first) would be kept as
				// selected and "d" (last) rejected — the citation signal must flip
				// that.
				citedCanonicalWebUrls: new Set(["https://d.example.com/four"]),
			});

			const web = summary?.groups.find((group) => group.sourceType === "web");
			expect(web).toBeTruthy();
			const selectedIds = web?.items
				.filter((item) => item.status === "selected")
				.map((item) => item.id);
			expect(selectedIds).toEqual(["d"]);
			// A high-default-rank but UNCITED source is demoted to reference, not
			// marked used.
			expect(web?.items.find((item) => item.id === "a")?.status).toBe(
				"reference",
			);
			// Uncited candidates become "reference" (also-found), never "rejected".
			expect(web?.items.some((item) => item.status === "rejected")).toBe(false);
		});

		it("orders cited web sources before uncited ones", async () => {
			const summary = await buildAssistantEvidenceSummary({
				userId: "user-1",
				message: "compare the frameworks",
				taskState: null,
				toolCalls: [webTool(fourWebCandidates())],
				citedCanonicalWebUrls: new Set([
					"https://b.example.com/two",
					"https://d.example.com/four",
				]),
			});

			const web = summary?.groups.find((group) => group.sourceType === "web");
			const order = web?.items.map((item) => item.id) ?? [];
			expect(order.slice(0, 2).sort()).toEqual(["b", "d"]);
			expect(web?.items[0]?.status).toBe("selected");
			expect(web?.items[1]?.status).toBe("selected");
			expect(web?.items[2]?.status).toBe("reference");
		});

		it("falls back to reranker/default classification when the answer cited zero web URLs", async () => {
			const summary = await buildAssistantEvidenceSummary({
				userId: "user-1",
				message: "compare the frameworks",
				taskState: null,
				toolCalls: [webTool(fourWebCandidates())],
				// No citedCanonicalWebUrls: the previous reranker/default logic must
				// still apply so the "used" group is not empty.
			});

			const web = summary?.groups.find((group) => group.sourceType === "web");
			expect(
				web?.items.filter((item) => item.status === "selected").length,
			).toBeGreaterThan(0);
			// Fallback classification demotes to "rejected", not "reference".
			expect(web?.items.some((item) => item.status === "rejected")).toBe(true);
		});

		it("falls back to reranker classification when cited URLs match no candidate", async () => {
			const summary = await buildAssistantEvidenceSummary({
				userId: "user-1",
				message: "compare the frameworks",
				taskState: null,
				toolCalls: [webTool(fourWebCandidates())],
				// Cited a URL the model was never given -> no candidate match -> must
				// not blank out the "used" group.
				citedCanonicalWebUrls: new Set(["https://unrelated.example.net/z"]),
			});

			const web = summary?.groups.find((group) => group.sourceType === "web");
			expect(
				web?.items.filter((item) => item.status === "selected").length,
			).toBeGreaterThan(0);
			expect(web?.items.some((item) => item.status === "rejected")).toBe(true);
		});

		it("matches cited sources through canonicalization (www / trailing slash / utm)", async () => {
			const summary = await buildAssistantEvidenceSummary({
				userId: "user-1",
				message: "compare the frameworks",
				taskState: null,
				toolCalls: [
					webTool([
						// Candidate URL carries www + trailing slash.
						webCandidate("a", "https://www.foo.example.com/article/"),
						webCandidate("b", "https://bar.example.com/x"),
					]),
				],
				// Canonical form of the cited URL (no www, no trailing slash).
				citedCanonicalWebUrls: new Set(["https://foo.example.com/article"]),
			});

			const web = summary?.groups.find((group) => group.sourceType === "web");
			expect(web?.items.find((item) => item.id === "a")?.status).toBe(
				"selected",
			);
			expect(web?.items.find((item) => item.id === "b")?.status).toBe(
				"reference",
			);
		});
	});

	it("falls back to the aggregate session-memory item when no persona facts are present", async () => {
		const summary = await buildAssistantEvidenceSummary({
			userId: "user-7",
			message: "continue",
			taskState: null,
			contextStatus: {
				layersUsed: ["session"],
				summary: "Session summary text.",
			} as never,
		});

		const memoryGroup = summary?.groups.find(
			(group) => group.sourceType === "memory",
		);
		expect(
			memoryGroup?.items.some((item) => item.id === "session-memory"),
		).toBe(true);
		expect(
			memoryGroup?.items.some((item) => item.id.startsWith("memory-fact:")),
		).toBe(false);
	});

	// Workspaces Slice E — a document that reached the turn *because the
	// project knows it* says so, as a token on its own evidence row. The
	// Sources panel is where a file's name may be read; the token is what ties
	// that row back to the project whose file it is. A document the project
	// does not know stays untouched — the same turn, the same panel, no token.
	it("stamps the project token on evidence items that came from the project", async () => {
		const summary = await buildAssistantEvidenceSummary({
			userId: "user-1",
			message: "what time does the museum open?",
			taskState: null,
			contextDebug: {
				activeTaskId: null,
				activeTaskObjective: null,
				taskLocked: false,
				routingStage: "deterministic",
				routingConfidence: 0,
				verificationStatus: "skipped",
				selectedEvidence: [
					{
						artifactId: "artifact-project",
						name: "Wien itinerary.md",
						artifactType: "normalized_document",
						sourceType: "document",
						role: "selected",
						origin: "system",
						confidence: 0.8,
						reason: "deterministic selection",
					},
					{
						artifactId: "artifact-library",
						name: "Packing list.md",
						artifactType: "normalized_document",
						sourceType: "document",
						role: "selected",
						origin: "system",
						confidence: 0.7,
						reason: "control-model selection",
					},
				],
				selectedEvidenceBySource: [{ sourceType: "document", count: 2 }],
			},
			projectFiles: {
				projectId: "project-1",
				projectName: "Vienna trip",
				documentIdByArtifactId: new Map([
					["artifact-project", "artifact-project"],
				]),
			},
		});

		const documentGroup = summary?.groups.find(
			(group) => group.sourceType === "document",
		);
		const projectItem = documentGroup?.items.find(
			(item) => item.artifactId === "artifact-project",
		);
		expect(projectItem?.metadata).toEqual({
			projectId: "project-1",
			projectName: "Vienna trip",
		});
		// The reason/description the row already carried survives the stamp —
		// the token is added, never a replacement for what explains the row.
		expect(projectItem?.description).toBe("deterministic selection");

		const libraryItem = documentGroup?.items.find(
			(item) => item.artifactId === "artifact-library",
		);
		expect(libraryItem?.metadata).toBeUndefined();
	});
});

// The Info popover's "project files read" row: how many of the conversation's
// project files the answer actually consulted. Two channels bring a file into
// a turn — the evidence selection picked it, or the model read it with a tool
// — and the row has to count both, as files rather than as ids.
describe("countProjectFilesRead", () => {
	// One project: the itinerary is an uploaded document, so it answers to its
	// own row and to the normalized sibling retrieval and the read tool return;
	// the tickets were never normalized and answer to one id.
	const projectFiles: ProjectFilesEvidenceContext = {
		projectId: "project-1",
		projectName: "Vienna trip",
		documentIdByArtifactId: new Map([
			["itinerary", "itinerary"],
			["itinerary-normalized", "itinerary"],
			["tickets", "tickets"],
		]),
	};

	function selecting(artifactIds: string[]): ContextDebugState {
		return {
			activeTaskId: "task-1",
			activeTaskObjective: null,
			taskLocked: false,
			routingStage: "deterministic",
			routingConfidence: 0,
			verificationStatus: "skipped",
			selectedEvidence: artifactIds.map((artifactId) => ({
				artifactId,
				name: artifactId,
				artifactType: "normalized_document",
				sourceType: "document",
				role: "selected",
				origin: "system",
				confidence: 0.8,
				reason: null,
			})),
			selectedEvidenceBySource: [
				{ sourceType: "document", count: artifactIds.length },
			],
		};
	}

	/** A finished read, carrying the ids it read exactly as a tool records them. */
	function readCall(
		readArtifactIds: string | number,
		overrides: Partial<ToolCallEntry> = {},
	): ToolCallEntry {
		return {
			callId: `call-${readArtifactIds}`,
			name: "read_generated_file",
			input: { filename: "Wien itinerary.pdf" },
			status: "done",
			outputSummary: 'Found "Wien itinerary.pdf".',
			sourceType: "tool",
			metadata: { ok: true, found: true, readArtifactIds },
			...overrides,
		};
	}

	it("counts the project files the turn's evidence selected", () => {
		expect(
			countProjectFilesRead({
				contextDebug: selecting(["itinerary-normalized", "packing-list"]),
				toolCalls: [],
				projectFiles,
			}),
		).toBe(1);
	});

	it("counts a project file the model read with a tool", () => {
		// Nothing was selected: the model found the file in the project's list
		// and read it itself. This is the turn the row used to miss entirely.
		expect(
			countProjectFilesRead({
				contextDebug: null,
				toolCalls: [readCall("itinerary-normalized")],
				projectFiles,
			}),
		).toBe(1);
	});

	it("counts a file that was both selected and read once", () => {
		expect(
			countProjectFilesRead({
				contextDebug: selecting(["itinerary-normalized"]),
				toolCalls: [readCall("itinerary-normalized")],
				projectFiles,
			}),
		).toBe(1);
	});

	it("counts a file once when selection and the tool reached it through different ids", () => {
		// Selection named the display row, the tool read the normalized sibling
		// the text lives in: one document, one file read.
		expect(
			countProjectFilesRead({
				contextDebug: selecting(["itinerary"]),
				toolCalls: [readCall("itinerary-normalized")],
				projectFiles,
			}),
		).toBe(1);
	});

	it("counts every project file one call read, each once", () => {
		expect(
			countProjectFilesRead({
				contextDebug: null,
				toolCalls: [
					readCall("itinerary-normalized,tickets"),
					readCall("tickets"),
				],
				projectFiles,
			}),
		).toBe(2);
	});

	it("does not count a tool read of a file the project does not know", () => {
		// A library document, or another project's file, or anything the
		// knowledge boundary did not hand over as this project's.
		expect(
			countProjectFilesRead({
				contextDebug: null,
				toolCalls: [readCall("packing-list")],
				projectFiles,
			}),
		).toBe(0);
	});

	it("ignores ids on a tool call that did not finish", () => {
		expect(
			countProjectFilesRead({
				contextDebug: null,
				toolCalls: [
					readCall("tickets", { status: "failed" }),
					readCall("itinerary-normalized", { status: "running" }),
				],
				projectFiles,
			}),
		).toBe(0);
	});

	it("ignores a read record that is not an id list", () => {
		expect(
			countProjectFilesRead({
				contextDebug: null,
				toolCalls: [readCall(42)],
				projectFiles,
			}),
		).toBe(0);
	});

	it("counts nothing outside a project", () => {
		expect(
			countProjectFilesRead({
				contextDebug: selecting(["itinerary-normalized"]),
				toolCalls: [readCall("itinerary-normalized")],
				projectFiles: null,
			}),
		).toBe(0);
	});
});

// The one way a tool says which stored files it read: artifact ids only, on
// its tool-call entry's flat metadata record, under one key the count reads.
describe("toolReadArtifactIdsMetadata", () => {
	it("records each id the tool read once, under one key", () => {
		expect(toolReadArtifactIdsMetadata(["b-id", "a-id", "b-id"])).toEqual({
			readArtifactIds: "b-id,a-id",
		});
	});

	it("records nothing when nothing was read", () => {
		expect(toolReadArtifactIdsMetadata([])).toEqual({});
		expect(toolReadArtifactIdsMetadata([null, undefined, "  "])).toEqual({});
	});

	it("never writes an id the count would read back as two", () => {
		// Artifact ids are UUIDs, so this cannot happen today; if it ever did,
		// splitting the value would credit the turn with ids it never read.
		expect(toolReadArtifactIdsMetadata(["a-id,b-id", "c-id"])).toEqual({
			readArtifactIds: "c-id",
		});
	});

	it("is what the count reads", () => {
		const call: ToolCallEntry = {
			name: "memory_context",
			input: { mode: "history" },
			status: "done",
			metadata: {
				ok: true,
				...toolReadArtifactIdsMetadata(["itinerary", "tickets"]),
			},
		};
		expect(
			countProjectFilesRead({
				contextDebug: null,
				toolCalls: [call],
				projectFiles: {
					projectId: "project-1",
					projectName: "Vienna trip",
					documentIdByArtifactId: new Map([
						["itinerary", "itinerary"],
						["tickets", "tickets"],
					]),
				},
			}),
		).toBe(2);
	});
});
