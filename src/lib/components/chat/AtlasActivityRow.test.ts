import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import type { AtlasJobCard } from "$lib/server/services/atlas/public-types";
import AtlasActivityRow from "./AtlasActivityRow.svelte";

const NOW = 1_700_000_000_000;

function atlasJob(overrides: Partial<AtlasJobCard> = {}): AtlasJobCard {
	return {
		id: "atlas-job-1",
		conversationId: "conv-1",
		assistantMessageId: "assistant-1",
		action: "create",
		parentAtlasJobId: null,
		profile: "in-depth",
		title: "Ireland's grid decarbonisation and the 2030 targets",
		status: "running",
		stage: "research",
		progress: { percent: 48, stage: "research", details: { queries: [] } },
		sourceCounts: { local: 0, web: 31, accepted: 28, rejected: 5 },
		usage: {
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
			costUsdMicros: 0,
		},
		outputs: {
			fileProductionJobId: "file-job-1",
			htmlChatGeneratedFileId: "html-1",
			pdfChatGeneratedFileId: "pdf-1",
			markdownChatGeneratedFileId: "md-1",
		},
		error: null,
		createdAt: NOW - 360_000,
		updatedAt: NOW,
		completedAt: null,
		...overrides,
	};
}

// The v2 progress details, as the contract shapes them. Assigned through
// `details` (typed as the v1 shape server-side) exactly the way the client
// reads it: defensively, from unknown.
function v2Details(overrides: Record<string, unknown> = {}) {
	return {
		queries: [],
		pipelineVersion: 2,
		phase: "research",
		sourcesRead: 31,
		next: "write 6 sections · verify every cited figure · render PDF",
		plan: [
			{
				id: "q1",
				question: "Current generation mix and renewable share in 2026",
				status: "done",
				sourceCount: 8,
				confidence: "corroborated",
			},
			{
				id: "q2",
				question: "Onshore and offshore wind pipeline to 2030",
				status: "done",
				sourceCount: 6,
				confidence: "corroborated",
			},
			{
				id: "q3",
				question: "Utility-scale solar growth and records",
				status: "done",
				sourceCount: 7,
				confidence: "mixed",
			},
			{
				id: "q4",
				question: "Interconnectors: Celtic, Greenlink, EWIC status",
				status: "done",
				sourceCount: 5,
				confidence: "corroborated",
			},
			{
				id: "q5",
				question: "Battery storage and flexibility capacity",
				status: "running",
				sourceCount: 2,
				confidence: "single",
			},
			{
				id: "q6",
				question: "Delivery risks: planning, grid connections, adequacy",
				status: "queued",
				sourceCount: 0,
			},
		],
		...overrides,
	} as unknown as AtlasJobCard["progress"]["details"];
}

const EVIDENCE = {
	corroborated: 41,
	single: 9,
	inferred: 3,
	cut: 2,
	filteredCount: 5,
	sources: [
		{
			n: 1,
			title: "Ireland reaches 8 GW of onshore renewable generation",
			host: "gov.ie",
			date: "18 Jun 2026",
			cited: true,
		},
		{
			n: 2,
			title: "Renewable Energy Generation, PQ 520",
			host: "oireachtas.ie",
			date: "14 Apr 2026",
			cited: true,
		},
	],
};

function runningJob() {
	return atlasJob({
		status: "running",
		progress: { percent: 48, stage: "research", details: v2Details() },
	});
}

function doneJob(detailOverrides: Record<string, unknown> = {}) {
	return atlasJob({
		status: "succeeded",
		stage: "render",
		completedAt: NOW - 360_000 + 540_000,
		progress: {
			percent: 100,
			stage: "render",
			details: v2Details({
				phase: "render",
				sectionCount: 6,
				evidence: EVIDENCE,
				plan: [
					{
						id: "q1",
						question: "Current generation mix and renewable share in 2026",
						status: "done",
						sourceCount: 8,
						confidence: "corroborated",
					},
					{
						id: "q5",
						question: "Battery storage and flexibility capacity",
						status: "done",
						sourceCount: 2,
						confidence: "single",
					},
				],
				...detailOverrides,
			}),
		},
	});
}

describe("AtlasActivityRow", () => {
	describe("running", () => {
		it("renders the pinned row and the live plan for a v2 job", () => {
			render(AtlasActivityRow, { job: runningJob() });

			const row = screen.getByTestId("tool-activity-row");
			expect(row).toHaveAttribute("data-status", "running");
			expect(row).toHaveTextContent("Atlas report");
			expect(row).toHaveTextContent(
				"Ireland's grid decarbonisation and the 2030 targets",
			);
			expect(row).toHaveTextContent("4 of 6 questions");
			// A pinned, always-open row carries no chevron and is not a button.
			expect(row.tagName).toBe("DIV");

			const body = screen.getByTestId("atlas-activity-body");
			expect(screen.getByTestId("atlas-stage-line")).toHaveTextContent(
				"Researching",
			);
			expect(screen.getByTestId("atlas-stage-line")).toHaveTextContent(
				"31 sources read so far",
			);

			const questions = within(screen.getByTestId("atlas-plan")).getAllByTestId(
				"atlas-plan-question",
			);
			expect(questions).toHaveLength(6);
			expect(questions[0]).toHaveTextContent(
				"Current generation mix and renewable share in 2026",
			);
			expect(questions[0]).toHaveTextContent("8 sources");
			expect(questions[4]).toHaveAttribute("data-status", "running");
			expect(questions[5]).toHaveAttribute("data-status", "queued");

			expect(body).toHaveTextContent(
				"Then: write 6 sections · verify every cited figure · render PDF",
			);
		});

		it("emits cancel from Stop", async () => {
			const onCancel = vi.fn();
			render(AtlasActivityRow, { job: runningJob(), onCancel });

			await fireEvent.click(
				screen.getByRole("button", { name: "Cancel Atlas" }),
			);
			expect(onCancel).toHaveBeenCalledWith("atlas-job-1");
		});

		it("falls back to the stage label and the query list for a v1 job", () => {
			render(AtlasActivityRow, {
				job: atlasJob({
					status: "running",
					stage: "curate",
					progress: {
						percent: 30,
						stage: "curate",
						details: {
							queries: [
								"ireland grid renewable share 2026",
								"offshore wind pipeline consents",
							],
						},
					},
				}),
			});

			expect(screen.getByTestId("atlas-stage-line")).toHaveTextContent(
				"Curating sources",
			);
			const fallback = screen.getByTestId("atlas-plan-fallback");
			expect(
				within(fallback).getAllByTestId("atlas-plan-question"),
			).toHaveLength(2);
			expect(fallback).toHaveTextContent("ireland grid renewable share 2026");
			// No v2 plan means no "n of m questions" claim in the row's meta.
			expect(screen.getByTestId("tool-activity-row")).not.toHaveTextContent(
				"questions",
			);
		});
	});

	describe("done", () => {
		it("folds to a tick, opens on the Report tab and exposes Open and one Download menu", async () => {
			const onOpenDocument = vi.fn();
			render(AtlasActivityRow, { job: doneJob(), onOpenDocument });

			const row = screen.getByTestId("tool-activity-row");
			expect(row).toHaveAttribute("data-status", "done");
			expect(row).toHaveTextContent("28 sources");
			expect(row).toHaveTextContent("9 min");
			// Settled rows are disclosable: a real button with a chevron.
			expect(row.tagName).toBe("BUTTON");

			const reportTab = screen.getByTestId("atlas-report-tab");
			expect(reportTab).toHaveTextContent("6 sections · 28 sources");
			expect(screen.getByRole("tab", { name: "Report" })).toHaveAttribute(
				"aria-selected",
				"true",
			);

			await fireEvent.click(screen.getByTestId("atlas-open-report"));
			expect(onOpenDocument).toHaveBeenCalledTimes(1);
			const [document, options] = onOpenDocument.mock.calls[0] as [
				{ id: string; mimeType: string },
				{ presentation: string },
			];
			expect(document.id).toBe("html-1");
			expect(document.mimeType).toBe("text/html");
			expect(options.presentation).toBe("expanded");

			await fireEvent.click(screen.getByTestId("atlas-download-menu-button"));
			const menu = screen.getByRole("menu", { name: "Download" });
			const items = within(menu).getAllByRole("menuitem");
			expect(items.map((item) => item.textContent?.trim())).toEqual([
				"PDF",
				"HTML",
				"Markdown",
			]);
			expect(items[0]).toHaveAttribute(
				"href",
				"/api/chat/files/pdf-1/download",
			);
			expect(items[2]).toHaveAttribute("href", "/api/chat/files/md-1/download");
		});

		it("switches tabs by click and by arrow key", async () => {
			render(AtlasActivityRow, { job: doneJob() });

			await fireEvent.click(screen.getByRole("tab", { name: "Evidence" }));
			expect(screen.getByTestId("atlas-evidence-tab")).toBeInTheDocument();
			expect(screen.queryByTestId("atlas-report-tab")).not.toBeInTheDocument();

			await fireEvent.keyDown(screen.getByRole("tab", { name: "Evidence" }), {
				key: "ArrowRight",
			});
			expect(screen.getByTestId("atlas-plan-tab")).toBeInTheDocument();
			expect(screen.getByRole("tab", { name: "Plan" })).toHaveAttribute(
				"aria-selected",
				"true",
			);
		});

		it("shows the confidence line, per-question confidence and the deduplicated sources on the Evidence tab", async () => {
			render(AtlasActivityRow, { job: doneJob() });

			await fireEvent.click(screen.getByRole("tab", { name: "Evidence" }));
			const evidence = screen.getByTestId("atlas-evidence-tab");
			expect(evidence).toHaveTextContent(
				"41 corroborated · 9 single-source · 3 inferred · 2 cut",
			);
			expect(evidence).toHaveTextContent("8 sources · corroborated");
			expect(evidence).toHaveTextContent("2 sources · single-source");

			const sources = within(evidence).getAllByTestId("atlas-evidence-source");
			expect(sources).toHaveLength(2);
			expect(sources[0]).toHaveTextContent(
				"Ireland reaches 8 GW of onshore renewable generation",
			);
			expect(sources[0]).toHaveTextContent("gov.ie · 18 Jun 2026");

			// 28 accepted sources, 2 listed, 5 junk pages filtered out.
			expect(screen.getByTestId("atlas-evidence-more")).toHaveTextContent(
				"… 26 more · duplicates and redirect stubs removed (5)",
			);
		});

		it("shows the final source counts on the Plan tab", async () => {
			render(AtlasActivityRow, { job: doneJob() });

			await fireEvent.click(screen.getByRole("tab", { name: "Plan" }));
			const plan = screen.getByTestId("atlas-plan-tab");
			expect(plan).toHaveTextContent("2 of 2 questions");
			expect(within(plan).getAllByTestId("atlas-plan-question")).toHaveLength(
				2,
			);
		});

		it("opens the inline lifecycle panel from Revise and submits it", async () => {
			const onLifecycleAction = vi.fn();
			render(AtlasActivityRow, { job: doneJob(), onLifecycleAction });

			await fireEvent.click(
				screen.getByRole("button", { name: "Revise Atlas" }),
			);
			const panel = screen.getByTestId("atlas-lifecycle-panel");
			const textarea = within(panel).getByRole("textbox");
			await fireEvent.input(textarea, {
				target: { value: "Add the 2027 auction results." },
			});
			await fireEvent.click(
				within(panel).getByRole("button", { name: "Revise Atlas" }),
			);

			expect(onLifecycleAction).toHaveBeenCalledWith({
				jobId: "atlas-job-1",
				action: "revise",
				message: "Add the 2027 auction results.",
				profile: "in-depth",
			});
		});

		it("hides the tab strip for a report with no plan or evidence", () => {
			render(AtlasActivityRow, {
				job: atlasJob({
					status: "succeeded",
					stage: "render",
					completedAt: NOW,
					progress: { percent: 100, stage: "render", details: { queries: [] } },
				}),
			});

			expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
			expect(screen.getByTestId("atlas-report-tab")).toBeInTheDocument();
		});
	});

	describe("failed and stopped", () => {
		it("shows the failure reason and a Retry that opens the prefilled panel", async () => {
			const onLifecycleAction = vi.fn();
			render(AtlasActivityRow, {
				job: atlasJob({
					status: "failed",
					stage: "research",
					completedAt: NOW,
					error: {
						code: "research_failed",
						message:
							"Research could not finish: the web search service returned errors for 4 of 6 questions.",
						retryable: true,
					},
				}),
				onLifecycleAction,
			});

			const row = screen.getByTestId("tool-activity-row");
			expect(row).toHaveAttribute("data-status", "failed");
			expect(row).toHaveTextContent("Failed");
			expect(screen.getByTestId("atlas-failure-reason")).toHaveTextContent(
				"the web search service returned errors for 4 of 6 questions",
			);

			await fireEvent.click(screen.getByTestId("atlas-retry"));
			const panel = screen.getByTestId("atlas-lifecycle-panel");
			expect(within(panel).getByRole("textbox")).toHaveValue(
				"Retry the research plan and keep the sources already read.",
			);
			await fireEvent.click(
				within(panel).getByRole("button", { name: "Continue Atlas" }),
			);
			expect(onLifecycleAction).toHaveBeenCalledWith({
				jobId: "atlas-job-1",
				action: "continue",
				message: "Retry the research plan and keep the sources already read.",
				profile: "in-depth",
			});
		});

		it("renders a cancelled job as a done row with Continue", async () => {
			render(AtlasActivityRow, {
				job: atlasJob({
					status: "cancelled",
					completedAt: NOW,
					sourceCounts: { local: 0, web: 14, accepted: 14, rejected: 0 },
					progress: {
						percent: 33,
						stage: "research",
						details: v2Details({
							plan: [
								{
									id: "q1",
									question: "Current generation mix",
									status: "done",
									sourceCount: 8,
								},
								{
									id: "q2",
									question: "Wind pipeline",
									status: "done",
									sourceCount: 6,
								},
								{
									id: "q3",
									question: "Solar records",
									status: "queued",
									sourceCount: 0,
								},
								{
									id: "q4",
									question: "Interconnectors",
									status: "queued",
									sourceCount: 0,
								},
								{
									id: "q5",
									question: "Storage",
									status: "queued",
									sourceCount: 0,
								},
								{
									id: "q6",
									question: "Delivery risks",
									status: "queued",
									sourceCount: 0,
								},
							],
						}),
					},
				}),
			});

			const row = screen.getByTestId("tool-activity-row");
			expect(row).toHaveAttribute("data-status", "done");
			expect(row).toHaveTextContent("Cancelled after 2 of 6 questions");
			expect(row).toHaveTextContent("Stopped");
			expect(screen.getByTestId("atlas-stopped-note")).toHaveTextContent(
				"The 14 sources already read are kept for Continue.",
			);
			expect(screen.getByTestId("atlas-continue")).toBeInTheDocument();
		});
	});

	it("collapses and reopens a settled row from its chevron", async () => {
		render(AtlasActivityRow, { job: doneJob() });

		const row = screen.getByTestId("tool-activity-row");
		expect(screen.getByTestId("atlas-activity-body")).toBeInTheDocument();
		expect(row).toHaveAttribute("aria-expanded", "true");

		// The body slides closed (it lingers in the DOM for the outro), so the
		// row's own disclosure state is what the assertion pins.
		await fireEvent.click(row);
		expect(row).toHaveAttribute("aria-expanded", "false");

		await fireEvent.click(row);
		expect(row).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByTestId("atlas-activity-body")).toBeInTheDocument();
	});
});
