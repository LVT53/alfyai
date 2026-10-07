import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeletedArtifacts } from "$lib/components/artifacts/deleted-artifacts";
import type {
	MessageEvidenceItem,
	MessageEvidenceSummary,
} from "$lib/server/services/message-evidence";
import { uiLanguage } from "$lib/stores/settings";
import MessageEvidenceDetails from "./MessageEvidenceDetails.svelte";

const {
	fetchMemoryProfileMock,
	submitKnowledgeMemoryActionMock,
	submitMemoryV2ActionMock,
} = vi.hoisted(() => ({
	fetchMemoryProfileMock: vi.fn(),
	submitKnowledgeMemoryActionMock: vi.fn(),
	submitMemoryV2ActionMock: vi.fn(),
}));

vi.mock("$lib/client/api/knowledge", () => ({
	fetchMemoryProfile: fetchMemoryProfileMock,
	submitKnowledgeMemoryAction: submitKnowledgeMemoryActionMock,
	submitMemoryV2Action: submitMemoryV2ActionMock,
}));

// Transparent unless a test shelves the tours: which kinds a made row can name
// must not depend on which kinds have a tour (M-3 of the final review).
const tours = vi.hoisted(() => ({ shelved: false }));
vi.mock("$lib/shared/artifacts/tours", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("$lib/shared/artifacts/tours")>();
	return {
		...actual,
		isShippedArtifactTourType: (value: unknown) =>
			!tours.shelved && actual.isShippedArtifactTourType(value),
	};
});

function buildSummary(
	overrides: Partial<MessageEvidenceSummary> = {},
): MessageEvidenceSummary {
	return {
		structuredWebSearch: false,
		groups: [],
		...overrides,
	};
}

describe("MessageEvidenceDetails", () => {
	it('shows a "Sources" label when collapsed (not "Evidence")', () => {
		render(MessageEvidenceDetails, {
			evidenceSummary: buildSummary({
				groups: [
					{
						sourceType: "document",
						label: "Documents",
						reranked: false,
						items: [
							{
								id: "evidence-1",
								title: "Quarterly report",
								sourceType: "document",
								status: "selected",
							},
						],
					},
				],
			}),
		});

		expect(
			screen.getByRole("button", { name: /Sources/i }),
		).toBeInTheDocument();
		// The old label must not be present.
		expect(screen.queryByRole("button", { name: /^Evidence/i })).toBeNull();
	});

	it("does not show the item count when collapsed", () => {
		render(MessageEvidenceDetails, {
			evidenceSummary: buildSummary({
				groups: [
					{
						sourceType: "document",
						label: "Documents",
						reranked: false,
						items: [
							{
								id: "evidence-1",
								title: "Quarterly report",
								sourceType: "document",
								status: "selected",
							},
						],
					},
				],
			}),
		});

		// The "considered/used" line only appears after expansion.
		expect(screen.queryByText(/considered/i)).toBeNull();
	});

	it('shows "· N considered, M used" on expand', async () => {
		render(MessageEvidenceDetails, {
			evidenceSummary: buildSummary({
				groups: [
					{
						sourceType: "document",
						label: "Documents",
						reranked: false,
						items: [
							{
								id: "evidence-1",
								title: "Used report",
								sourceType: "document",
								status: "selected",
							},
							{
								id: "evidence-2",
								title: "Set-aside draft",
								sourceType: "document",
								status: "rejected",
							},
						],
					},
				],
			}),
		});

		await fireEvent.click(screen.getByRole("button", { name: /Sources/i }));

		// 2 considered total, 1 used (selected).
		expect(screen.getByText(/2 considered, 1 used/i)).toBeInTheDocument();
	});

	it("groups items into Cited by the answer / Also found / Set aside by status", async () => {
		render(MessageEvidenceDetails, {
			evidenceSummary: buildSummary({
				groups: [
					{
						sourceType: "document",
						label: "Documents",
						reranked: false,
						items: [
							{
								id: "evidence-1",
								title: "Cited report",
								sourceType: "document",
								status: "selected",
							},
							{
								id: "evidence-2",
								title: "Background draft",
								sourceType: "document",
								status: "reference",
							},
							{
								id: "evidence-3",
								title: "Old draft",
								sourceType: "document",
								status: "rejected",
							},
						],
					},
				],
			}),
		});

		await fireEvent.click(screen.getByRole("button", { name: /Sources/i }));

		expect(
			screen.getByRole("heading", { name: /Cited by the answer/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { name: /Also found/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { name: /^Set aside$/i }),
		).toBeInTheDocument();

		const citedGroup = screen.getByRole("group", {
			name: /Cited by the answer/i,
		});
		const alsoFoundGroup = screen.getByRole("group", { name: /Also found/i });
		const setAsideGroup = screen.getByRole("group", { name: /^Set aside$/i });

		expect(within(citedGroup).getByText("Cited report")).toBeInTheDocument();
		expect(
			within(alsoFoundGroup).getByText("Background draft"),
		).toBeInTheDocument();
		expect(within(setAsideGroup).getByText("Old draft")).toBeInTheDocument();
	});

	it("shows the cited count in the Cited-by-the-answer heading", async () => {
		render(MessageEvidenceDetails, {
			evidenceSummary: buildSummary({
				groups: [
					{
						sourceType: "web",
						label: "Web Search",
						reranked: false,
						items: [
							{
								id: "source-1",
								title: "first.com",
								sourceType: "web",
								status: "selected",
								url: "https://first.com/a",
							},
							{
								id: "source-2",
								title: "second.com",
								sourceType: "web",
								status: "selected",
								url: "https://second.com/b",
							},
							{
								id: "source-3",
								title: "third.com",
								sourceType: "web",
								status: "reference",
								url: "https://third.com/c",
							},
						],
					},
				],
			}),
		});

		await fireEvent.click(screen.getByRole("button", { name: /Sources/i }));

		// Heading carries the count of cited sources (2), Also found carries 1.
		expect(
			screen.getByRole("heading", { name: /Cited by the answer \(2\)/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { name: /Also found \(1\)/i }),
		).toBeInTheDocument();
	});

	it("surfaces a web item's reason as its description line", async () => {
		render(MessageEvidenceDetails, {
			evidenceSummary: buildSummary({
				groups: [
					{
						sourceType: "web",
						label: "Web Search",
						reranked: false,
						items: [
							{
								id: "source-1",
								title: "investopedia.com",
								sourceType: "web",
								status: "selected",
								url: "https://example.com/source",
								reason: "Defines the term the answer quoted.",
							},
						],
					},
				],
			}),
		});

		await fireEvent.click(screen.getByRole("button", { name: /Sources/i }));

		expect(
			screen.getByText("Defines the term the answer quoted."),
		).toBeInTheDocument();
	});

	it("splits memory across Cited / Also found / Set aside by status", async () => {
		render(MessageEvidenceDetails, {
			evidenceSummary: buildSummary({
				groups: [
					{
						sourceType: "memory",
						label: "Memory",
						reranked: false,
						items: [
							{
								id: "memory-selected",
								title: "Selected memory",
								sourceType: "memory",
								status: "selected",
							},
							{
								id: "memory-reference",
								title: "Recent task state",
								sourceType: "memory",
								status: "reference",
							},
							{
								id: "memory-rejected",
								title: "Irrelevant memory",
								sourceType: "memory",
								status: "rejected",
							},
						],
					},
				],
			}),
		});

		await fireEvent.click(screen.getByRole("button", { name: /Sources/i }));

		// 3 considered total; 1 used = the single cited (selected) source.
		expect(screen.getByText(/3 considered, 1 used/i)).toBeInTheDocument();

		const citedGroup = screen.getByRole("group", {
			name: /Cited by the answer/i,
		});
		const alsoFoundGroup = screen.getByRole("group", { name: /Also found/i });
		const setAsideGroup = screen.getByRole("group", { name: /^Set aside$/i });

		// The selected memory sits under Cited (collapsed into its own Memory
		// entry); expanding reveals the underlying item.
		const citedMemoryRow = within(citedGroup).getByRole("button", {
			name: /Memory.*1/i,
		});
		await fireEvent.click(citedMemoryRow);
		expect(within(citedGroup).getByText("Selected memory")).toBeInTheDocument();

		// The reference memory now lives under Also found, not Cited.
		expect(within(citedGroup).queryByText("Recent task state")).toBeNull();
		const alsoFoundMemoryRow = within(alsoFoundGroup).getByRole("button", {
			name: /Memory.*1/i,
		});
		await fireEvent.click(alsoFoundMemoryRow);
		expect(
			within(alsoFoundGroup).getByText("Recent task state"),
		).toBeInTheDocument();

		// The rejected memory is set aside.
		const asideMemoryRow = within(setAsideGroup).getByRole("button", {
			name: /Memory.*1/i,
		});
		await fireEvent.click(asideMemoryRow);
		expect(
			within(setAsideGroup).getByText("Irrelevant memory"),
		).toBeInTheDocument();
	});

	it("collapses N memory items into a single 'Memory' entry alongside a normal web row", async () => {
		render(MessageEvidenceDetails, {
			evidenceSummary: buildSummary({
				groups: [
					{
						sourceType: "memory",
						label: "Memory",
						reranked: false,
						items: [
							{
								id: "memory-1",
								title: "Prefers concise summaries",
								sourceType: "memory",
								status: "reference",
							},
							{
								id: "memory-2",
								title: "Recent task state",
								sourceType: "memory",
								status: "reference",
							},
							{
								id: "memory-3",
								title: "Session memory note",
								sourceType: "memory",
								status: "selected",
							},
							{
								id: "memory-4",
								title: "Project folder sibling",
								sourceType: "memory",
								status: "reference",
							},
						],
					},
					{
						sourceType: "web",
						label: "Web Search",
						reranked: false,
						items: [
							{
								id: "source-1",
								title: "investopedia.com",
								sourceType: "web",
								status: "selected",
								url: "https://example.com/source",
							},
						],
					},
				],
			}),
		});

		await fireEvent.click(screen.getByRole("button", { name: /Sources/i }));

		// 5 considered total (4 memory + 1 web); 2 used = the two cited
		// (selected) sources (the selected memory note + the web link).
		expect(screen.getByText(/5 considered, 2 used/i)).toBeInTheDocument();

		const citedGroup = screen.getByRole("group", {
			name: /Cited by the answer/i,
		});
		const alsoFoundGroup = screen.getByRole("group", { name: /Also found/i });

		// Cited: the single selected memory collapses into one Memory row, and
		// the selected web source keeps its own link row.
		const citedMemoryRow = within(citedGroup).getByRole("button", {
			name: /Memory.*1/i,
		});
		expect(citedMemoryRow).toBeInTheDocument();
		expect(
			within(citedGroup).getByRole("link", { name: /investopedia/i }),
		).toBeInTheDocument();

		// Also found: the three reference memory items collapse into a single
		// Memory entry (count 3), not one row per item.
		const alsoFoundMemoryRow = within(alsoFoundGroup).getByRole("button", {
			name: /Memory.*3/i,
		});
		expect(alsoFoundMemoryRow).toBeInTheDocument();
		expect(
			within(alsoFoundGroup).queryByText("Prefers concise summaries"),
		).toBeNull();
		expect(within(alsoFoundGroup).queryByText("Recent task state")).toBeNull();

		// The collapsed also-found row is expandable to reveal the items.
		await fireEvent.click(alsoFoundMemoryRow);
		expect(
			within(alsoFoundGroup).getByText("Prefers concise summaries"),
		).toBeInTheDocument();

		// The selected memory is under Cited, reachable by expanding its row.
		await fireEvent.click(citedMemoryRow);
		expect(
			within(citedGroup).getByText("Session memory note"),
		).toBeInTheDocument();
	});

	it("does not render a Reranked badge", async () => {
		render(MessageEvidenceDetails, {
			evidenceSummary: buildSummary({
				groups: [
					{
						sourceType: "web",
						label: "Web Search",
						reranked: true,
						confidence: 92,
						items: [
							{
								id: "source-1",
								title: "Official source",
								sourceType: "web",
								status: "selected",
								url: "https://example.com/source",
							},
						],
					},
				],
			}),
		});

		await fireEvent.click(screen.getByRole("button", { name: /Sources/i }));

		expect(screen.queryByText(/reranked/i)).toBeNull();
	});

	it("does not render the Auto/Pinned/Excluded preference control", async () => {
		render(MessageEvidenceDetails, {
			evidenceSummary: buildSummary({
				groups: [
					{
						sourceType: "document",
						label: "Documents",
						reranked: false,
						items: [
							{
								id: "evidence-1",
								title: "Quarterly report",
								sourceType: "document",
								status: "selected",
								artifactId: "artifact-1",
							},
						],
					},
				],
			}),
		});

		await fireEvent.click(screen.getByRole("button", { name: /Sources/i }));

		// The disclosure stays informational: no per-source steering control
		// (the removed control rendered the only <select> here) may come back.
		expect(screen.queryByRole("combobox")).toBeNull();
	});

	it("renders documents as clickable buttons that open the document viewer", async () => {
		const onOpenDocument = vi.fn();
		render(MessageEvidenceDetails, {
			evidenceSummary: buildSummary({
				groups: [
					{
						sourceType: "document",
						label: "Documents",
						reranked: false,
						items: [
							{
								id: "evidence-1",
								title: "Quarterly report",
								sourceType: "document",
								status: "selected",
								artifactId: "artifact-1",
							},
						],
					},
				],
			}),
			onOpenDocument,
		});

		await fireEvent.click(screen.getByRole("button", { name: /Sources/i }));

		const openBtn = screen.getByRole("button", { name: /Quarterly report/i });
		await fireEvent.click(openBtn);

		expect(onOpenDocument).toHaveBeenCalledTimes(1);
		expect(onOpenDocument.mock.calls[0][0]).toMatchObject({
			artifactId: "artifact-1",
		});
	});

	it("renders web items as terracotta-tinted links opening the URL", async () => {
		render(MessageEvidenceDetails, {
			evidenceSummary: buildSummary({
				groups: [
					{
						sourceType: "web",
						label: "Web Search",
						reranked: false,
						items: [
							{
								id: "source-1",
								title: "investopedia.com",
								sourceType: "web",
								status: "selected",
								url: "https://example.com/source",
							},
						],
					},
				],
			}),
		});

		await fireEvent.click(screen.getByRole("button", { name: /Sources/i }));

		const link = screen.getByRole("link", { name: /investopedia/i });
		expect(link).toHaveAttribute("href", "https://example.com/source");
		expect(link).toHaveAttribute("target", "_blank");
	});

	it("renders web items with a favicon via the /api/favicon proxy route", async () => {
		render(MessageEvidenceDetails, {
			evidenceSummary: buildSummary({
				groups: [
					{
						sourceType: "web",
						label: "Web Search",
						reranked: false,
						items: [
							{
								id: "source-1",
								title: "investopedia.com",
								sourceType: "web",
								status: "selected",
								url: "https://example.com/source",
							},
						],
					},
				],
			}),
		});

		await fireEvent.click(screen.getByRole("button", { name: /Sources/i }));

		// The web item should render a favicon <img> routed through the
		// privacy proxy (ADR 0043, Slice 12), keyed by the page's domain.
		const link = screen.getByRole("link", { name: /investopedia/i });
		// Decorative (alt="") so it's removed from the a11y role tree; query
		// by tag name instead of role.
		const favicon = link.querySelector("img");
		expect(favicon).not.toBeNull();
		expect(favicon).toHaveAttribute("src", "/api/favicon?domain=example.com");
		expect(favicon).toHaveAttribute("alt", "");
	});

	it("renders memory items as plain text without a link", async () => {
		render(MessageEvidenceDetails, {
			evidenceSummary: buildSummary({
				groups: [
					{
						sourceType: "memory",
						label: "Memory",
						reranked: false,
						items: [
							{
								id: "memory-1",
								title: '"Prefers concise summaries"',
								sourceType: "memory",
								status: "selected",
							},
						],
					},
				],
			}),
		});

		await fireEvent.click(screen.getByRole("button", { name: /Sources/i }));

		// The single memory item still collapses into a "Memory" entry; expand
		// it to reach the underlying plain-text (non-link) item.
		await fireEvent.click(screen.getByRole("button", { name: /Memory.*1/i }));

		expect(screen.getByText(/Prefers concise summaries/i)).toBeInTheDocument();
		expect(screen.queryByRole("link")).toBeNull();
	});

	describe("memory-fact actions", () => {
		beforeEach(() => {
			fetchMemoryProfileMock.mockReset();
			submitKnowledgeMemoryActionMock.mockReset();
			submitMemoryV2ActionMock.mockReset();
			fetchMemoryProfileMock.mockResolvedValue({ projectionRevision: 7 });
			submitKnowledgeMemoryActionMock.mockResolvedValue({});
			submitMemoryV2ActionMock.mockResolvedValue({});
		});

		// Memory items always collapse into a single "Memory" entry now, so
		// reaching an individual memory-fact item's tap-to-reveal actions
		// requires expanding that entry first.
		async function expandSourcesAndMemoryGroup() {
			await fireEvent.click(screen.getByRole("button", { name: /Sources/i }));
			await fireEvent.click(screen.getByRole("button", { name: /Memory.*1/i }));
		}

		function renderWithMemoryFact() {
			return render(MessageEvidenceDetails, {
				evidenceSummary: buildSummary({
					groups: [
						{
							sourceType: "memory",
							label: "Memory",
							reranked: false,
							items: [
								{
									id: "memory-fact:item-9",
									title: "Prefers dark roast coffee.",
									sourceType: "memory",
									status: "selected",
									metadata: { memoryItemId: "item-9" },
								},
							],
						},
					],
				}),
			});
		}

		it("makes memory-fact items tappable and reveals Correct / Don't use / Retire", async () => {
			renderWithMemoryFact();
			await expandSourcesAndMemoryGroup();

			await fireEvent.click(
				screen.getByRole("button", { name: /Prefers dark roast coffee/i }),
			);

			expect(
				screen.getByRole("button", { name: "Correct" }),
			).toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: "Don't use" }),
			).toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: "Retire" }),
			).toBeInTheDocument();
		});

		it("Don't use suppresses the fact via the legacy action with a fetched revision", async () => {
			renderWithMemoryFact();
			await expandSourcesAndMemoryGroup();
			await fireEvent.click(
				screen.getByRole("button", { name: /Prefers dark roast coffee/i }),
			);
			await fireEvent.click(screen.getByRole("button", { name: "Don't use" }));

			await waitFor(() => {
				expect(submitKnowledgeMemoryActionMock).toHaveBeenCalledWith({
					target: "profile_item",
					action: "suppress",
					itemId: "item-9",
					expectedProjectionRevision: 7,
				});
			});
			expect(
				await screen.findByText("Won't be used anymore"),
			).toBeInTheDocument();
		});

		it("Retire posts the v2 retire action and confirms", async () => {
			renderWithMemoryFact();
			await expandSourcesAndMemoryGroup();
			await fireEvent.click(
				screen.getByRole("button", { name: /Prefers dark roast coffee/i }),
			);
			await fireEvent.click(screen.getByRole("button", { name: "Retire" }));

			await waitFor(() => {
				expect(submitMemoryV2ActionMock).toHaveBeenCalledWith({
					kind: "profile_item",
					action: "retire",
					itemId: "item-9",
					expectedProjectionRevision: 7,
				});
			});
			expect(await screen.findByText("Memory retired")).toBeInTheDocument();
		});

		it("Correct opens a prefilled inline input and posts the corrected statement", async () => {
			renderWithMemoryFact();
			await expandSourcesAndMemoryGroup();
			await fireEvent.click(
				screen.getByRole("button", { name: /Prefers dark roast coffee/i }),
			);
			await fireEvent.click(screen.getByRole("button", { name: "Correct" }));

			const input = screen.getByRole("textbox");
			expect(input).toHaveValue("Prefers dark roast coffee.");
			await fireEvent.input(input, {
				target: { value: "Prefers light roast coffee." },
			});
			await fireEvent.click(
				screen.getByRole("button", { name: "Save correction" }),
			);

			await waitFor(() => {
				expect(submitMemoryV2ActionMock).toHaveBeenCalledWith({
					kind: "profile_item",
					action: "correct",
					itemId: "item-9",
					statement: "Prefers light roast coffee.",
					expectedProjectionRevision: 7,
				});
			});
			expect(await screen.findByText("Memory updated")).toBeInTheDocument();
		});

		it("shows an error state when the action fails", async () => {
			submitMemoryV2ActionMock.mockRejectedValueOnce(new Error("boom"));
			renderWithMemoryFact();
			await expandSourcesAndMemoryGroup();
			await fireEvent.click(
				screen.getByRole("button", { name: /Prefers dark roast coffee/i }),
			);
			await fireEvent.click(screen.getByRole("button", { name: "Retire" }));

			expect(
				await screen.findByText(/Couldn't update this memory/i),
			).toBeInTheDocument();
		});

		it("leaves ordinary memory items without the action row", async () => {
			render(MessageEvidenceDetails, {
				evidenceSummary: buildSummary({
					groups: [
						{
							sourceType: "memory",
							label: "Memory",
							reranked: false,
							items: [
								{
									id: "memory-1",
									title: "Recent task state",
									sourceType: "memory",
									status: "reference",
								},
							],
						},
					],
				}),
			});
			await fireEvent.click(screen.getByRole("button", { name: /Sources/i }));

			expect(
				screen.queryByRole("button", { name: /Recent task state/i }),
			).not.toBeInTheDocument();
		});
	});

	it("animates the expanded box out instead of removing it instantly on collapse", async () => {
		render(MessageEvidenceDetails, {
			evidenceSummary: buildSummary({
				groups: [
					{
						sourceType: "document",
						label: "Documents",
						reranked: false,
						items: [
							{
								id: "evidence-1",
								title: "Quarterly report",
								sourceType: "document",
								status: "selected",
							},
						],
					},
				],
			}),
		});

		const toggle = screen.getByRole("button", { name: /Sources/i });
		await fireEvent.click(toggle);
		expect(document.querySelector(".evidence-groups")).toBeTruthy();

		await fireEvent.click(toggle);
		// An out: transition delays removal — the box should still be in the
		// DOM right after collapsing (mid-animation), not gone instantly the
		// way a plain {#if} without a transition would leave it.
		expect(document.querySelector(".evidence-groups")).toBeTruthy();
	});

	it("animates the considered/used line out too instead of vanishing instantly", async () => {
		render(MessageEvidenceDetails, {
			evidenceSummary: buildSummary({
				groups: [
					{
						sourceType: "document",
						label: "Documents",
						reranked: false,
						items: [
							{
								id: "evidence-1",
								title: "Quarterly report",
								sourceType: "document",
								status: "selected",
							},
						],
					},
				],
			}),
		});

		const toggle = screen.getByRole("button", { name: /Sources/i });
		await fireEvent.click(toggle);
		expect(document.querySelector(".evidence-summary-line")).toBeTruthy();

		await fireEvent.click(toggle);
		// Same reasoning as the box above: a transition: directive delays
		// removal instead of the line vanishing the instant Sources collapses.
		expect(document.querySelector(".evidence-summary-line")).toBeTruthy();
	});

	// Workspaces Slice E — a document that came from the project wears the
	// project's token on its row. The name is what the reader sees in Sources;
	// the token is what says which project's file it is, without repeating the
	// project's name in the file list.
	it("shows the project token on an evidence row that came from the project", async () => {
		render(MessageEvidenceDetails, {
			evidenceSummary: buildSummary({
				groups: [
					{
						sourceType: "document",
						label: "Documents",
						reranked: false,
						items: [
							{
								id: "evidence-project",
								title: "Wien itinerary.md",
								sourceType: "document",
								status: "selected",
								artifactId: "artifact-project",
								metadata: {
									projectId: "project-1",
									projectName: "Vienna trip",
								},
							},
							{
								id: "evidence-library",
								title: "Packing list.md",
								sourceType: "document",
								status: "selected",
								artifactId: "artifact-library",
							},
						],
					},
				],
			}),
			onOpenDocument: () => undefined,
		});

		await fireEvent.click(screen.getByRole("button", { name: /Sources/i }));

		const projectRow = screen
			.getByText("Wien itinerary.md")
			.closest(".evidence-row") as HTMLElement | null;
		expect(projectRow).not.toBeNull();
		const tokens = within(projectRow as HTMLElement).getAllByTestId(
			"scope-token",
		);
		expect(tokens).toHaveLength(1);
		expect(tokens[0]).toHaveAttribute("data-kind", "project");
		expect(tokens[0]).toHaveTextContent("Vienna trip");

		// The same panel, the same turn: a document the project does not know
		// carries no token at all.
		const libraryRow = screen
			.getByText("Packing list.md")
			.closest(".evidence-row") as HTMLElement | null;
		expect(libraryRow).not.toBeNull();
		expect(
			within(libraryRow as HTMLElement).queryAllByTestId("scope-token"),
		).toHaveLength(0);
	});

	it("still toggles Sources from its own button after an external expand", async () => {
		const evidenceSummary = buildSummary({
			groups: [
				{
					sourceType: "document",
					label: "Documents",
					reranked: false,
					items: [
						{
							id: "evidence-1",
							title: "Quarterly report",
							sourceType: "document",
							status: "selected",
						},
					],
				},
			],
		});

		const { rerender } = render(MessageEvidenceDetails, {
			evidenceSummary,
			expandRequest: 0,
		});

		const toggle = () => screen.getByRole("button", { name: /Sources/i });
		expect(toggle()).toHaveAttribute("aria-expanded", "false");

		// The Info popover's row asks for the panel to open — a request, not a
		// takeover: the button's own toggle still owns the state afterwards.
		await rerender({ evidenceSummary, expandRequest: 1 });
		expect(toggle()).toHaveAttribute("aria-expanded", "true");

		await fireEvent.click(toggle());
		expect(toggle()).toHaveAttribute("aria-expanded", "false");

		// And the next request opens it again (each increment is one open).
		await rerender({ evidenceSummary, expandRequest: 2 });
		expect(toggle()).toHaveAttribute("aria-expanded", "true");
	});
});

// Rulings 6 and 7: what the turn made or changed is listed in the Sources panel
// under its own heading, each row named by its kind (`artifacts.type.*`) and
// opened through the same path a chat card uses.
describe("MessageEvidenceDetails — what the turn made", () => {
	beforeEach(() => {
		uiLanguage.set("en");
	});

	function made(
		id: string,
		title: string,
		artifactKind: string | null,
	): MessageEvidenceItem {
		return {
			id,
			title,
			sourceType: "artifact",
			status: "reference",
			artifactId: id,
			description: null,
			channels: ["tool"],
			metadata: artifactKind ? { artifactKind } : undefined,
		};
	}

	function madeSummary(
		...items: MessageEvidenceItem[]
	): MessageEvidenceSummary {
		return buildSummary({
			groups: [
				{
					sourceType: "artifact",
					label: "Made in this chat",
					reranked: false,
					items,
				},
			],
		});
	}

	async function openSources() {
		await fireEvent.click(
			screen.getByRole("button", { name: /Sources|Források/ }),
		);
	}

	it("renders a made item as a button that opens it through the page's open path", async () => {
		const onOpenDocument = vi.fn();
		render(MessageEvidenceDetails, {
			evidenceSummary: madeSummary(made("doc-1", "Weekend plan", "document")),
			onOpenDocument,
		});
		await openSources();

		await fireEvent.click(screen.getByRole("button", { name: /Weekend plan/ }));

		expect(onOpenDocument).toHaveBeenCalledTimes(1);
		// kind is what sends the page's open path through the artifact read, so a
		// deleted item shows the deleted state the chat card shows.
		expect(onOpenDocument.mock.calls[0][0]).toMatchObject({
			id: "artifact:doc-1",
			source: "knowledge_artifact",
			title: "Weekend plan",
			artifactId: "doc-1",
			kind: "document",
		});
	});

	it("puts the rows under the Made in this chat heading and names each by its kind, in English", async () => {
		render(MessageEvidenceDetails, {
			evidenceSummary: madeSummary(
				made("doc-1", "Weekend plan", "document"),
				made("app-1", "Budget tracker", "app"),
				made("board-1", "Trip board", "canvas"),
			),
			onOpenDocument: vi.fn(),
		});
		await openSources();

		expect(
			screen.getByRole("heading", { name: "Made in this chat" }),
		).toBeInTheDocument();
		const rows = [
			["Weekend plan", "Document"],
			["Budget tracker", "App"],
			["Trip board", "Canvas"],
		];
		for (const [title, kindWord] of rows) {
			const row = screen
				.getByText(title)
				.closest(".evidence-row") as HTMLElement;
			expect(within(row).getByText(kindWord)).toBeInTheDocument();
		}
	});

	it("names each row by its kind, and the heading, in Hungarian", async () => {
		uiLanguage.set("hu");
		render(MessageEvidenceDetails, {
			evidenceSummary: madeSummary(
				made("doc-1", "Hétvégi terv", "document"),
				made("app-1", "Költségvetés", "app"),
				made("board-1", "Utazási tábla", "canvas"),
			),
			onOpenDocument: vi.fn(),
		});
		await openSources();

		expect(
			screen.getByRole("heading", { name: "Ebben a beszélgetésben készült" }),
		).toBeInTheDocument();
		const rows = [
			["Hétvégi terv", "Dokumentum"],
			["Költségvetés", "Alkalmazás"],
			["Utazási tábla", "Tábla"],
		];
		for (const [title, kindWord] of rows) {
			const row = screen
				.getByText(title)
				.closest(".evidence-row") as HTMLElement;
			expect(within(row).getByText(kindWord)).toBeInTheDocument();
		}
	});

	it("draws the kind's own icon, not the generic document icon", async () => {
		render(MessageEvidenceDetails, {
			evidenceSummary: buildSummary({
				groups: [
					{
						sourceType: "document",
						label: "Documents",
						reranked: false,
						items: [
							{
								id: "e-1",
								title: "Quarterly report",
								sourceType: "document",
								status: "selected",
							},
						],
					},
					{
						sourceType: "artifact",
						label: "Made in this chat",
						reranked: false,
						items: [
							made("doc-1", "Weekend plan", "document"),
							made("app-1", "Budget tracker", "app"),
							made("board-1", "Trip board", "canvas"),
						],
					},
				],
			}),
			onOpenDocument: vi.fn(),
		});
		await openSources();

		const iconClass = (title: string) =>
			(
				screen
					.getByText(title)
					.closest(".evidence-row")
					?.querySelector("svg.evidence-type-icon") as SVGElement | null
			)?.getAttribute("class") ?? "";
		const retrieved = iconClass("Quarterly report");
		expect(retrieved).toContain("lucide-file-text");
		expect(iconClass("Weekend plan")).toContain("lucide-square-pen");
		expect(iconClass("Budget tracker")).toContain("lucide-app-window");
		expect(iconClass("Trip board")).toContain("lucide-shapes");
		for (const title of ["Weekend plan", "Budget tracker", "Trip board"]) {
			expect(iconClass(title)).not.toContain("lucide-file-text");
		}
	});

	it("keeps made items out of the citation buckets and the considered/used counts", async () => {
		render(MessageEvidenceDetails, {
			evidenceSummary: buildSummary({
				groups: [
					{
						sourceType: "web",
						label: "Web Search",
						reranked: false,
						items: [
							{
								id: "w1",
								title: "Museum hours",
								url: "https://example.com/museum",
								sourceType: "web",
								status: "selected",
							},
						],
					},
					{
						sourceType: "artifact",
						label: "Made in this chat",
						reranked: false,
						items: [made("doc-1", "Weekend plan", "document")],
					},
				],
			}),
			onOpenDocument: vi.fn(),
		});
		await openSources();

		expect(screen.getByText("· 1 considered, 1 used")).toBeInTheDocument();
		expect(screen.getByText("Cited by the answer (1)")).toBeInTheDocument();
		// "Also found" is for what the turn retrieved; what it made is not that.
		expect(screen.queryByText(/Also found/)).toBeNull();
		expect(
			screen.getByRole("heading", { name: "Made in this chat" }),
		).toBeInTheDocument();
	});

	it("says nothing was considered only when something was: a turn that only made an item has no considered/used line", async () => {
		render(MessageEvidenceDetails, {
			evidenceSummary: madeSummary(made("doc-1", "Weekend plan", "document")),
			onOpenDocument: vi.fn(),
		});
		await openSources();

		expect(screen.queryByText(/considered/)).toBeNull();
		expect(screen.queryByText(/Cited by the answer/)).toBeNull();
		expect(screen.getByText("Weekend plan")).toBeInTheDocument();
	});

	it("shows no such heading for a stored summary that has no made group", async () => {
		render(MessageEvidenceDetails, {
			evidenceSummary: buildSummary({
				groups: [
					{
						sourceType: "document",
						label: "Documents",
						reranked: false,
						items: [
							{
								id: "e-1",
								title: "Quarterly report",
								sourceType: "document",
								status: "selected",
								artifactId: "artifact-1",
							},
						],
					},
				],
			}),
			onOpenDocument: vi.fn(),
		});
		await openSources();

		expect(screen.queryByText("Made in this chat")).toBeNull();
		expect(screen.getByText("Quarterly report")).toBeInTheDocument();
	});

	it("draws a made row as plain text when the page gave no way to open it, and still names its kind", async () => {
		render(MessageEvidenceDetails, {
			evidenceSummary: madeSummary(made("doc-1", "Weekend plan", "document")),
		});
		await openSources();

		expect(screen.queryByRole("button", { name: /Weekend plan/ })).toBeNull();
		const row = screen
			.getByText("Weekend plan")
			.closest(".evidence-row") as HTMLElement;
		expect(within(row).getByText("Document")).toBeInTheDocument();
	});

	it("names and opens a kind that ships whatever its tour does: a shelved tour does not turn the row plain", async () => {
		tours.shelved = true;
		try {
			const onOpenDocument = vi.fn();
			render(MessageEvidenceDetails, {
				evidenceSummary: madeSummary(made("board-1", "Trip board", "canvas")),
				onOpenDocument,
			});
			await openSources();

			const row = screen.getByRole("button", { name: /Trip board/ });
			expect(within(row).getByText("Canvas")).toBeInTheDocument();
			await fireEvent.click(row);
			expect(onOpenDocument.mock.calls[0][0]).toMatchObject({
				artifactId: "board-1",
				kind: "canvas",
			});
		} finally {
			tours.shelved = false;
		}
	});

	// M-1 of the final review: the chat's cards say an item was deleted, and the
	// Sources row of the same item kept looking like a link. It reads the state
	// the cards read (`DeletedArtifacts`) and says it in the card's own words.
	describe("an item that is gone or out of reach", () => {
		function state(
			overrides: Partial<Omit<DeletedArtifacts, "onRegenerate">> = {},
		): DeletedArtifacts {
			return {
				deletedIds: [],
				unreachableIds: [],
				regeneratingIds: [],
				unavailableIds: [],
				onRegenerate: vi.fn(),
				...overrides,
			};
		}

		it("draws the row of a deleted item as plain text, with the card's words in place of the kind, and no way to open it", async () => {
			const onOpenDocument = vi.fn();
			render(MessageEvidenceDetails, {
				evidenceSummary: madeSummary(
					made("doc-1", "Weekend plan", "document"),
					made("doc-2", "Packing list", "document"),
				),
				onOpenDocument,
				deletedArtifacts: state({ deletedIds: ["doc-1"] }),
			});
			await openSources();

			expect(
				screen.queryByRole("button", { name: /Weekend plan/ }),
			).toBeNull();
			const gone = screen
				.getByText("Weekend plan")
				.closest(".evidence-row") as HTMLElement;
			expect(
				within(gone).getByText("This document was deleted"),
			).toBeInTheDocument();
			expect(within(gone).queryByText("Document")).toBeNull();
			await fireEvent.click(screen.getByText("Weekend plan"));
			expect(onOpenDocument).not.toHaveBeenCalled();
			// The other item is untouched: still a button, still named by its kind.
			const live = screen.getByRole("button", { name: /Packing list/ });
			expect(within(live).getByText("Document")).toBeInTheDocument();
		});

		it("says it per kind, in English and in Hungarian, with the words the cards use", async () => {
			const items = [
				made("doc-1", "Weekend plan", "document"),
				made("app-1", "Budget tracker", "app"),
				made("board-1", "Trip board", "canvas"),
			];
			const deletedArtifacts = state({
				deletedIds: ["doc-1", "app-1", "board-1"],
			});
			const { unmount } = render(MessageEvidenceDetails, {
				evidenceSummary: madeSummary(...items),
				onOpenDocument: vi.fn(),
				deletedArtifacts,
			});
			await openSources();
			for (const [title, words] of [
				["Weekend plan", "This document was deleted"],
				["Budget tracker", "This app was deleted"],
				["Trip board", "This canvas was deleted"],
			]) {
				const row = screen
					.getByText(title)
					.closest(".evidence-row") as HTMLElement;
				expect(within(row).getByText(words)).toBeInTheDocument();
			}
			unmount();

			uiLanguage.set("hu");
			render(MessageEvidenceDetails, {
				evidenceSummary: madeSummary(...items),
				onOpenDocument: vi.fn(),
				deletedArtifacts,
			});
			await openSources();
			for (const [title, words] of [
				["Weekend plan", "Ez a dokumentum törölve lett"],
				["Budget tracker", "Ez az alkalmazás törölve lett"],
				["Trip board", "Ez a tábla törölve lett"],
			]) {
				const row = screen
					.getByText(title)
					.closest(".evidence-row") as HTMLElement;
				expect(within(row).getByText(words)).toBeInTheDocument();
			}
		});

		it("draws an item that exists but is out of this chat's reach as plain text too, never as deleted", async () => {
			const onOpenDocument = vi.fn();
			render(MessageEvidenceDetails, {
				evidenceSummary: madeSummary(made("doc-1", "Weekend plan", "document")),
				onOpenDocument,
				// Both lists name it: out of reach wins, as it does on the card.
				deletedArtifacts: state({
					deletedIds: ["doc-1"],
					unreachableIds: ["doc-1"],
				}),
			});
			await openSources();

			expect(
				screen.queryByRole("button", { name: /Weekend plan/ }),
			).toBeNull();
			const row = screen
				.getByText("Weekend plan")
				.closest(".evidence-row") as HTMLElement;
			expect(within(row).getByText("Document")).toBeInTheDocument();
			expect(screen.queryByText(/was deleted/)).toBeNull();
			await fireEvent.click(screen.getByText("Weekend plan"));
			expect(onOpenDocument).not.toHaveBeenCalled();
		});

		it("is a live row again the moment the item is back, with the page's own state as the only source", async () => {
			const onOpenDocument = vi.fn();
			const { rerender } = render(MessageEvidenceDetails, {
				evidenceSummary: madeSummary(made("doc-1", "Weekend plan", "document")),
				onOpenDocument,
				deletedArtifacts: state({ deletedIds: ["doc-1"] }),
			});
			await openSources();
			expect(screen.getByText("This document was deleted")).toBeInTheDocument();

			// Regenerate on the card makes it again under the same id.
			await rerender({ deletedArtifacts: state() });

			expect(screen.queryByText(/was deleted/)).toBeNull();
			await fireEvent.click(
				screen.getByRole("button", { name: /Weekend plan/ }),
			);
			expect(onOpenDocument).toHaveBeenCalledTimes(1);
		});

		it("marks nothing when the page gave no state", async () => {
			render(MessageEvidenceDetails, {
				evidenceSummary: madeSummary(made("doc-1", "Weekend plan", "document")),
				onOpenDocument: vi.fn(),
			});
			await openSources();

			expect(
				screen.getByRole("button", { name: /Weekend plan/ }),
			).toBeInTheDocument();
			expect(screen.queryByText(/was deleted/)).toBeNull();
		});
	});

	it("does not offer to open a made row that names no kind it can draw", async () => {
		render(MessageEvidenceDetails, {
			evidenceSummary: madeSummary(
				made("odd-1", "Something odd", null),
				made("odd-2", "Another odd one", "toString"),
			),
			onOpenDocument: vi.fn(),
		});
		await openSources();

		expect(screen.queryByRole("button", { name: /Something odd/ })).toBeNull();
		expect(
			screen.queryByRole("button", { name: /Another odd one/ }),
		).toBeNull();
		expect(screen.getByText("Something odd")).toBeInTheDocument();
	});
});
