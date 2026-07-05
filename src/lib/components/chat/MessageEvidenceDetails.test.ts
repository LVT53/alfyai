import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import type { MessageEvidenceSummary } from "$lib/types";
import MessageEvidenceDetails from "./MessageEvidenceDetails.svelte";

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

	it("groups items into Used and Set aside by status", async () => {
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
			screen.getByRole("heading", { name: /^Used$/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { name: /^Set aside$/i }),
		).toBeInTheDocument();

		const usedGroup = screen.getByRole("group", { name: /^Used$/i });
		const setAsideGroup = screen.getByRole("group", { name: /^Set aside$/i });

		expect(within(usedGroup).getByText("Used report")).toBeInTheDocument();
		expect(within(setAsideGroup).getByText("Old draft")).toBeInTheDocument();
	});

	it("counts reference items as Used (contextual memory that informed the answer)", async () => {
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

		// 3 considered total, 2 used (selected + reference); only rejected is set aside.
		expect(screen.getByText(/3 considered, 2 used/i)).toBeInTheDocument();

		const usedGroup = screen.getByRole("group", { name: /^Used$/i });
		const setAsideGroup = screen.getByRole("group", { name: /^Set aside$/i });

		expect(
			within(usedGroup).getByText("Recent task state"),
		).toBeInTheDocument();
		expect(within(setAsideGroup).queryByText("Recent task state")).toBeNull();
		expect(
			within(setAsideGroup).getByText("Irrelevant memory"),
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

		// EvidencePreferenceControl renders a <select> with that aria-label.
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

		expect(screen.getByText(/Prefers concise summaries/i)).toBeInTheDocument();
		expect(screen.queryByRole("link")).toBeNull();
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
});
