import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
import type { DeepResearchJob, DocumentWorkspaceItem } from "$lib/types";
import ResearchCard from "./ResearchCard.svelte";

function makeDeepResearchJob(
	overrides: Partial<DeepResearchJob> = {},
): DeepResearchJob {
	const now = Date.now();
	return {
		id: overrides.id ?? "research-job-1",
		conversationId: overrides.conversationId ?? "conv-1",
		triggerMessageId: overrides.triggerMessageId ?? "user-1",
		depth: overrides.depth ?? "standard",
		status: overrides.status ?? "awaiting_approval",
		stage: overrides.stage ?? "plan_drafted",
		title: overrides.title ?? "Research battery recycling policy",
		userRequest: overrides.userRequest ?? "Research battery recycling policy",
		createdAt: overrides.createdAt ?? now,
		updatedAt: overrides.updatedAt ?? now,
		completedAt: overrides.completedAt ?? null,
		cancelledAt: overrides.cancelledAt ?? null,
		...overrides,
	};
}

describe("ResearchCard", () => {
	afterEach(() => {
		uiLanguage.set("en");
	});

	it("renders a shell-only card when no Research Plan is present", () => {
		const { getByRole, getByText, queryByText, queryByRole } = render(
			ResearchCard,
			{
				job: makeDeepResearchJob({
					status: "awaiting_plan",
					stage: "job_shell_created",
					plan: null,
				}),
			},
		);

		expect(
			getByRole("article", {
				name: "Deep Research: Research battery recycling policy",
			}),
		).toBeInTheDocument();
		expect(getByText("Standard")).toBeInTheDocument();
		expect(getByText("Awaiting plan")).toBeInTheDocument();
		expect(getByText("Drafting research plan...")).toBeInTheDocument();
		expect(getByText("Drafting plan")).toBeInTheDocument();
		expect(
			getByRole("button", { name: "Cancel Deep Research" }),
		).toBeInTheDocument();
		expect(queryByText("Research Plan")).not.toBeInTheDocument();
		expect(
			queryByRole("button", { name: "Approve Research Plan" }),
		).not.toBeInTheDocument();
		expect(
			queryByRole("button", { name: "Edit Research Plan" }),
		).not.toBeInTheDocument();
	});

	it("localizes plan sections and timeline step labels in Hungarian", () => {
		uiLanguage.set("hu");
		const { getAllByText, getByText, queryByText } = render(ResearchCard, {
			job: makeDeepResearchJob({
				plan: {
					version: 1,
					renderedPlan: "",
					rawPlan: {
						goal: "Hasonlítsd össze az akkumulátor-újrahasznosítási szabályokat.",
						depth: "standard",
						reportIntent: "comparison",
						researchBudget: {
							sourceReviewCeiling: 40,
							synthesisPassCeiling: 2,
						},
						keyQuestions: ["Mely szabályok változtak mostanában?"],
						sourceScope: {
							includePublicWeb: true,
							planningContextDisclosure: null,
						},
						reportShape: [],
						constraints: [],
						deliverables: ["Rövid összehasonlító jelentés"],
					},
					contextDisclosure: null,
					effortEstimate: {
						selectedDepth: "standard",
						expectedTimeBand: "10-25 perc",
						sourceReviewCeiling: 40,
						relativeCostWarning: "Közepes relatív költség.",
					},
				},
			}),
		});

		expect(getByText(/Jelentési szándék/)).toBeInTheDocument();
		expect(getByText("Összehasonlítás")).toBeInTheDocument();
		expect(getByText("Kulcskérdések")).toBeInTheDocument();
		expect(getByText("Eredmények")).toBeInTheDocument();
		expect(getByText("Terv elkészült")).toBeInTheDocument();
		expect(getAllByText("Jóváhagyásra vár").length).toBeGreaterThan(0);
		expect(queryByText("Key questions")).not.toBeInTheDocument();
		expect(queryByText("Plan drafted")).not.toBeInTheDocument();
	});

	it("shows a persisted Research Plan and approval affordances when awaiting approval", () => {
		const { getByRole, getByText, queryByText } = render(ResearchCard, {
			job: makeDeepResearchJob({
				plan: {
					version: 1,
					renderedPlan:
						"Research Plan\n\nGoal: Compare EU and US battery recycling policy.\n\nKey questions:\n- Which rules changed recently?",
					contextDisclosure:
						"Planning considered 2 knowledge items and 1 attachment item.",
					effortEstimate: {
						selectedDepth: "standard",
						expectedTimeBand: "10-25 minutes",
						sourceReviewCeiling: 40,
						relativeCostWarning:
							"Moderate relative cost; use for serious multi-source synthesis.",
					},
				},
			}),
		});

		expect(getByText("Research Plan")).toBeInTheDocument();
		expect(
			getByText(/Compare EU and US battery recycling policy/),
		).toBeInTheDocument();
		expect(getByText("10-25 minutes")).toBeInTheDocument();
		expect(getByText("Up to 40 sources")).toBeInTheDocument();
		expect(queryByText(/Moderate relative cost/)).not.toBeInTheDocument();
		expect(
			getByText(/Planning considered 2 knowledge items/),
		).toBeInTheDocument();
		expect(
			getByRole("button", { name: "Approve Research Plan" }),
		).toBeInTheDocument();
		expect(
			getByRole("button", { name: "Edit Research Plan" }),
		).toBeInTheDocument();
		expect(
			getByRole("button", { name: "Cancel Deep Research" }),
		).toBeInTheDocument();
	});

	it("lets running jobs be cancelled", async () => {
		const onCancel = vi.fn();
		const { getByRole } = render(ResearchCard, {
			job: makeDeepResearchJob({
				status: "running",
				stage: "citation_audit",
			}),
			onCancel,
		});

		await fireEvent.click(
			getByRole("button", { name: "Cancel Deep Research" }),
		);

		expect(onCancel).toHaveBeenCalledWith("research-job-1");
	});

	it("presents a corrected plan revision draft as needing approval", async () => {
		const onApprove = vi.fn(async () => {});
		const onEdit = vi.fn(async () => {});
		const onCancel = vi.fn(async () => {});
		const {
			getAllByText,
			getByLabelText,
			getByRole,
			getByText,
			queryByRole,
			queryByText,
		} = render(ResearchCard, {
			job: makeDeepResearchJob({
				status: "completed",
				stage: "plan_revision_needed",
				plan: null,
				currentPlan: {
					version: 2,
					status: "awaiting_approval",
					renderedPlan: "",
					rawPlan: {
						goal: "Compare EU and US battery recycling policy with a narrower source scope.",
						depth: "standard",
						reportIntent: "comparison",
						researchBudget: {
							sourceReviewCeiling: 24,
							synthesisPassCeiling: 2,
						},
						keyQuestions: [
							"Which official policy updates are supported by primary sources?",
						],
						sourceScope: {
							includePublicWeb: true,
							planningContextDisclosure: null,
						},
						reportShape: ["Corrected comparison"],
						constraints: [],
						deliverables: ["Corrected cited report"],
					},
					contextDisclosure:
						"The previous draft needed a narrower, evidence-backed scope.",
					effortEstimate: {
						selectedDepth: "standard",
						expectedTimeBand: "10-25 minutes",
						sourceReviewCeiling: 24,
						relativeCostWarning:
							"Moderate relative cost; use for serious multi-source synthesis.",
					},
				},
			}),
			onApprove,
			onEdit,
			onCancel,
		});

		expect(getByText("Needs attention")).toBeInTheDocument();
		expect(queryByText("Completed")).not.toBeInTheDocument();
		expect(queryByText("Insufficient evidence")).not.toBeInTheDocument();
		expect(
			getByText("Stage: Research Plan Revision Needed"),
		).toBeInTheDocument();
		expect(
			getAllByText("Research Plan Revision Needed").length,
		).toBeGreaterThan(0);
		expect(
			getByText(
				"The corrected draft is ready. Approve it to continue Deep Research, or edit it before approving.",
			),
		).toBeInTheDocument();
		expect(getByText("Research Plan")).toBeInTheDocument();
		expect(getByText("v2")).toBeInTheDocument();
		expect(
			getByText(
				"Which official policy updates are supported by primary sources?",
			),
		).toBeInTheDocument();

		await fireEvent.click(
			getByRole("button", { name: "Approve Research Plan" }),
		);
		expect(onApprove).toHaveBeenCalledWith("research-job-1");

		await fireEvent.click(getByRole("button", { name: "Edit Research Plan" }));
		await fireEvent.input(getByLabelText("Edit plan instructions"), {
			target: {
				value: "Keep the corrected scope but add enforcement examples.",
			},
		});
		await fireEvent.click(getByRole("button", { name: "Submit Plan Edit" }));

		expect(onEdit).toHaveBeenCalledWith(
			"research-job-1",
			"Keep the corrected scope but add enforcement examples.",
		);
		expect(
			queryByRole("button", { name: "Cancel Deep Research" }),
		).not.toBeInTheDocument();
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("maps operational job status to user-facing research severity", () => {
		const examples: Array<[Partial<DeepResearchJob>, string]> = [
			[
				{ status: "awaiting_approval", stage: "plan_drafted" },
				"Needs attention",
			],
			[{ status: "running", stage: "source_review" }, "Working"],
			[
				{
					status: "completed",
					stage: "report_ready",
					reportArtifactId: "artifact-report-1",
				},
				"Completed",
			],
			[
				{
					status: "completed",
					stage: "evidence_limitation_memo_ready",
					evidenceLimitationMemo: {
						title: "Evidence Limitation Memo",
						reviewedScope: {
							discoveredCount: 3,
							reviewedCount: 1,
							topicRelevantCount: 0,
							rejectedOrOffTopicCount: 2,
						},
						limitations: ["Evidence is too thin."],
						nextResearchDirection: "Add stronger primary sources.",
						recoveryActions: [],
					},
				},
				"Insufficient evidence",
			],
			[{ status: "cancelled", stage: "cancelled" }, "Cancelled"],
			[{ status: "failed", stage: "failed" }, "Failed"],
		];

		for (const [overrides, label] of examples) {
			const { getAllByText, unmount } = render(ResearchCard, {
				job: makeDeepResearchJob(overrides),
			});

			expect(getAllByText(label).length).toBeGreaterThan(0);
			unmount();
		}
	});

	it("reveals coarse stage progress details and dismisses the popup without exact percent language", async () => {
		const { container, getByRole, getByText, queryByText } = render(
			ResearchCard,
			{
				job: makeDeepResearchJob({
					status: "running",
					stage: "citation_audit",
					passCheckpoints: [
						{
							id: "pass-1",
							jobId: "research-job-1",
							conversationId: "conv-1",
							passNumber: 1,
							lifecycleState: "decided",
							searchIntent: "Establish primary regulatory baseline.",
							reviewedSourceIds: ["source-1"],
							coverageGapIds: ["gap-1"],
							nextDecision: "continue_research",
							decisionSummary: "Need stronger US enforcement evidence.",
							terminalDecision: true,
							startedAt: "2026-05-05T10:00:00.000Z",
							completedAt: "2026-05-05T10:30:00.000Z",
							createdAt: "2026-05-05T10:00:00.000Z",
							updatedAt: "2026-05-05T10:30:00.000Z",
						},
						{
							id: "pass-2",
							jobId: "research-job-1",
							conversationId: "conv-1",
							passNumber: 2,
							lifecycleState: "running",
							searchIntent: "Target unresolved enforcement gaps.",
							reviewedSourceIds: ["source-2"],
							coverageGapIds: [],
							terminalDecision: false,
							startedAt: "2026-05-05T10:31:00.000Z",
							createdAt: "2026-05-05T10:31:00.000Z",
							updatedAt: "2026-05-05T10:45:00.000Z",
						},
					],
					coverageGaps: [
						{
							id: "gap-1",
							jobId: "research-job-1",
							conversationId: "conv-1",
							passCheckpointId: "pass-1",
							lifecycleState: "open",
							severity: "important",
							reason: "US enforcement evidence remains thin.",
							keyQuestion: "Which rules changed recently?",
							recommendedNextAction: "Search regulator guidance.",
							reviewedSourceCount: 3,
							createdAt: "2026-05-05T10:30:00.000Z",
							updatedAt: "2026-05-05T10:30:00.000Z",
						},
					],
					synthesisClaims: [
						{
							id: "claim-a",
							jobId: "research-job-1",
							conversationId: "conv-1",
							statement: "EU enforcement is stricter.",
							central: true,
							status: "accepted",
							competingClaimGroupId: "conflict-1",
							evidenceLinks: [],
							createdAt: "2026-05-05T10:45:00.000Z",
							updatedAt: "2026-05-05T10:45:00.000Z",
						},
						{
							id: "claim-b",
							jobId: "research-job-1",
							conversationId: "conv-1",
							statement: "US enforcement is stricter.",
							central: true,
							status: "rejected",
							competingClaimGroupId: "conflict-1",
							evidenceLinks: [],
							createdAt: "2026-05-05T10:45:00.000Z",
							updatedAt: "2026-05-05T10:45:00.000Z",
						},
					],
					resumePoints: [
						{
							id: "resume-repair",
							jobId: "research-job-1",
							conversationId: "conv-1",
							boundary: "repair",
							resumeKey: "repair:1",
							status: "running",
							stage: "citation_audit",
							startedAt: "2026-05-05T10:46:00.000Z",
							createdAt: "2026-05-05T10:46:00.000Z",
							updatedAt: "2026-05-05T10:47:00.000Z",
						},
					],
				}),
			},
		);

		await fireEvent.click(
			getByRole("button", { name: "Show research progress details" }),
		);

		expect(
			getByRole("dialog", { name: "Research progress details" }),
		).toBeInTheDocument();
		expect(getByText("Current stage: Auditing citations")).toBeInTheDocument();
		expect(
			getByText("1 meaningful pass completed, 1 in progress"),
		).toBeInTheDocument();
		expect(getByText("1 open coverage gap")).toBeInTheDocument();
		expect(getByText("1 claim conflict resolved")).toBeInTheDocument();
		expect(getByText("Audit repair in progress")).toBeInTheDocument();
		expect(container).not.toHaveTextContent(/%|\bpercent\b/i);

		await fireEvent.keyDown(window, { key: "Escape" });

		await waitFor(() => {
			expect(queryByText("Research progress details")).not.toBeInTheDocument();
		});
	});

	it("labels citation repair separately from generic gap filling", async () => {
		const { getByRole, getByText } = render(ResearchCard, {
			job: makeDeepResearchJob({
				status: "running",
				stage: "research_tasks",
				passCheckpoints: [
					{
						id: "pass-repair",
						jobId: "research-job-1",
						conversationId: "conv-1",
						passNumber: 4,
						lifecycleState: "running",
						searchIntent:
							"Citation audit repair pass for unsupported or contradicted Synthesis Claims",
						reviewedSourceIds: [],
						coverageGapIds: [],
						terminalDecision: false,
						startedAt: "2026-05-05T10:31:00.000Z",
						createdAt: "2026-05-05T10:31:00.000Z",
						updatedAt: "2026-05-05T10:45:00.000Z",
					},
				],
				resumePoints: [
					{
						id: "resume-repair",
						jobId: "research-job-1",
						conversationId: "conv-1",
						boundary: "repair",
						resumeKey: "repair:1",
						status: "running",
						stage: "repair",
						startedAt: "2026-05-05T10:46:00.000Z",
						createdAt: "2026-05-05T10:46:00.000Z",
						updatedAt: "2026-05-05T10:47:00.000Z",
					},
				],
			}),
		});

		expect(getByText("Stage: Repairing citations")).toBeInTheDocument();

		await fireEvent.click(
			getByRole("button", { name: "Show research progress details" }),
		);

		expect(getByText("Current stage: Repairing citations")).toBeInTheDocument();
		expect(getByText("Audit repair in progress")).toBeInTheDocument();
	});

	it("shows Report Intent in the approval view and lets Plan Edit revise it", async () => {
		const onEdit = vi.fn(async () => {});
		const { getByRole, getByLabelText, getByText } = render(ResearchCard, {
			job: makeDeepResearchJob({
				plan: {
					version: 1,
					renderedPlan: "",
					rawPlan: {
						goal: "Compare EU and US battery recycling policy.",
						depth: "standard",
						reportIntent: "comparison",
						researchBudget: {
							sourceReviewCeiling: 40,
							synthesisPassCeiling: 2,
						},
						keyQuestions: ["Which rules changed recently?"],
						sourceScope: {
							includePublicWeb: true,
							planningContextDisclosure: null,
						},
						reportShape: ["Comparison"],
						constraints: [],
						deliverables: ["Cited Research Report"],
					},
					contextDisclosure: null,
					effortEstimate: {
						selectedDepth: "standard",
						expectedTimeBand: "10-25 minutes",
						sourceReviewCeiling: 40,
						relativeCostWarning:
							"Moderate relative cost; use for serious multi-source synthesis.",
					},
				},
			}),
			onEdit,
		});

		expect(getByText(/Report intent/)).toBeInTheDocument();
		expect(getByText("Comparison")).toBeInTheDocument();

		await fireEvent.click(getByRole("button", { name: "Edit Research Plan" }));
		await fireEvent.change(getByLabelText("Report intent"), {
			target: { value: "recommendation" },
		});
		await fireEvent.click(getByRole("button", { name: "Submit Plan Edit" }));

		expect(onEdit).toHaveBeenCalledWith("research-job-1", "", "recommendation");
	});

	it("shows meaningful Activity Timeline warnings and assumptions without manual expansion", () => {
		const { getByRole, getByText } = render(ResearchCard, {
			job: makeDeepResearchJob({
				status: "running",
				stage: "source_review",
				timeline: [
					{
						id: "timeline-1",
						jobId: "research-job-1",
						conversationId: "conv-1",
						userId: "user-1",
						taskId: null,
						stage: "source_review",
						kind: "stage_completed",
						occurredAt: "2026-05-05T10:30:00.000Z",
						messageKey: "deepResearch.timeline.sourceReviewCompleted",
						messageParams: {},
						sourceCounts: {
							discovered: 12,
							reviewed: 5,
							cited: 2,
						},
						assumptions: [
							"Public web sources are enough for the initial pass.",
						],
						warnings: ["One source could not be opened and was skipped."],
						summary: "Reviewed 5 candidate sources.",
						createdAt: "2026-05-05T10:30:00.000Z",
					},
				],
			} as Partial<DeepResearchJob> & { timeline: unknown[] }),
		});

		expect(
			getByRole("button", { name: "Hide Activity Timeline" }),
		).toHaveAttribute("aria-expanded", "true");
		expect(getByText("Activity Timeline")).toBeInTheDocument();
		expect(getByText("Reviewed 5 candidate sources.")).toBeInTheDocument();
		expect(getByText("12 discovered")).toBeInTheDocument();
		expect(getByText("5 reviewed")).toBeInTheDocument();
		expect(getByText("2 cited")).toBeInTheDocument();
		expect(getByText("Assumptions")).toBeInTheDocument();
		expect(
			getByText("Public web sources are enough for the initial pass."),
		).toBeInTheDocument();
		expect(getByText("Warnings")).toBeInTheDocument();
		expect(
			getByText("One source could not be opened and was skipped."),
		).toBeInTheDocument();
	});

	it("collapses the Activity Timeline by default for routine running progress", async () => {
		const { getByRole, getByText, queryByText } = render(ResearchCard, {
			job: makeDeepResearchJob({
				status: "running",
				stage: "source_review",
				timeline: [
					{
						id: "timeline-1",
						jobId: "research-job-1",
						conversationId: "conv-1",
						userId: "user-1",
						taskId: null,
						stage: "source_review",
						kind: "stage_completed",
						occurredAt: "2026-05-05T10:30:00.000Z",
						messageKey: "deepResearch.timeline.sourceReviewCompleted",
						messageParams: {
							reviewedSources: 5,
						},
						sourceCounts: {
							discovered: 12,
							reviewed: 5,
							cited: 2,
						},
						assumptions: [],
						warnings: [],
						summary: "Source review completed for 5 reviewed sources.",
						createdAt: "2026-05-05T10:30:00.000Z",
					},
				],
			} as Partial<DeepResearchJob> & { timeline: unknown[] }),
		});

		expect(getByText("Stage: Reviewing sources")).toBeInTheDocument();
		const timelineToggle = getByRole("button", {
			name: "Show Activity Timeline",
		});
		expect(timelineToggle).toHaveAttribute("aria-expanded", "false");
		expect(
			queryByText("Source review completed for 5 reviewed sources."),
		).not.toBeInTheDocument();

		await fireEvent.click(timelineToggle);

		expect(timelineToggle).toHaveAttribute("aria-expanded", "true");
		expect(
			getByText("Source review completed for 5 reviewed sources."),
		).toBeInTheDocument();
	});

	it("auto-expands the Activity Timeline for memo/failure context while running", () => {
		const { getByRole, getByText } = render(ResearchCard, {
			job: makeDeepResearchJob({
				status: "running",
				stage: "citation_audit_failed",
				timeline: [
					{
						id: "timeline-memo",
						jobId: "research-job-1",
						conversationId: "conv-1",
						userId: "user-1",
						taskId: null,
						stage: "citation_audit_failed",
						kind: "memo_completed",
						occurredAt: "2026-05-05T11:30:00.000Z",
						messageKey: "deepResearch.timeline.evidenceLimitationMemoCompleted",
						messageParams: {},
						sourceCounts: {
							discovered: 4,
							reviewed: 2,
							cited: 0,
						},
						assumptions: [],
						warnings: [],
						summary:
							"Research completed with an Evidence Limitation Memo because there was not enough credible topic-relevant evidence.",
						createdAt: "2026-05-05T11:30:00.000Z",
					},
				],
			} as Partial<DeepResearchJob> & { timeline: unknown[] }),
		});

		expect(
			getByRole("button", { name: "Hide Activity Timeline" }),
		).toHaveAttribute("aria-expanded", "true");
		expect(
			getByText(
				"Research completed with an Evidence Limitation Memo because there was not enough credible topic-relevant evidence.",
			),
		).toBeInTheDocument();
	});

	it("renders known timeline operational summaries in Hungarian instead of persisted English", async () => {
		uiLanguage.set("hu");
		const { getAllByText, getByRole, getByText, queryByText } = render(
			ResearchCard,
			{
				job: makeDeepResearchJob({
					status: "running",
					stage: "source_review",
					timeline: [
						{
							id: "timeline-discovery",
							jobId: "research-job-1",
							conversationId: "conv-1",
							userId: "user-1",
							taskId: null,
							stage: "source_discovery",
							kind: "stage_completed",
							occurredAt: "2026-05-05T10:20:00.000Z",
							messageKey: "deepResearch.timeline.sourceDiscoveryCompleted",
							messageParams: {
								discoveredSources: 12,
							},
							sourceCounts: {
								discovered: 12,
								reviewed: 0,
								cited: 0,
							},
							assumptions: [],
							warnings: [],
							summary: "Discovered 12 public web source candidates.",
							createdAt: "2026-05-05T10:20:00.000Z",
						},
						{
							id: "timeline-review",
							jobId: "research-job-1",
							conversationId: "conv-1",
							userId: "user-1",
							taskId: null,
							stage: "source_review",
							kind: "stage_completed",
							occurredAt: "2026-05-05T10:30:00.000Z",
							messageKey: "deepResearch.timeline.sourceReviewCompleted",
							messageParams: {
								reviewedSources: 5,
							},
							sourceCounts: {
								discovered: 12,
								reviewed: 5,
								cited: 2,
							},
							assumptions: [],
							warnings: [],
							summary: "Source review completed for 5 reviewed sources.",
							createdAt: "2026-05-05T10:30:00.000Z",
						},
					],
				} as Partial<DeepResearchJob> & { timeline: unknown[] }),
			},
		);

		await fireEvent.click(
			getByRole("button", { name: "Tevékenységi idővonal megjelenítése" }),
		);

		expect(
			getByText("12 nyilvános webes forrásjelölt felfedezve."),
		).toBeInTheDocument();
		expect(
			getByText("Forrásáttekintés befejezve 5 áttekintett forrással."),
		).toBeInTheDocument();
		expect(getAllByText("12 felfedezett").length).toBeGreaterThan(0);
		expect(getByText("5 áttekintett")).toBeInTheDocument();
		expect(getByText("2 idézett")).toBeInTheDocument();
		expect(
			queryByText("Discovered 12 public web source candidates."),
		).not.toBeInTheDocument();
		expect(
			queryByText("Source review completed for 5 reviewed sources."),
		).not.toBeInTheDocument();
	});

	it("suppresses routine running timeline rows already represented by the Stage pill", () => {
		const { getByText, queryByRole, queryByText } = render(ResearchCard, {
			job: makeDeepResearchJob({
				status: "running",
				stage: "source_review",
				timeline: [],
			}),
		});

		expect(getByText("Stage: Reviewing sources")).toBeInTheDocument();
		expect(
			queryByRole("region", { name: "Activity Timeline" }),
		).not.toBeInTheDocument();
		expect(queryByText("Reviewing sources")).not.toBeInTheDocument();
		expect(queryByText("Synthesizing")).not.toBeInTheDocument();
		expect(queryByText("Writing report")).not.toBeInTheDocument();
		expect(queryByText("Completed")).not.toBeInTheDocument();
	});

	it("suppresses repeated per-event source counts unless the event needs source context", async () => {
		const { getByRole, getByText } = render(ResearchCard, {
			job: makeDeepResearchJob({
				status: "running",
				stage: "report_writing",
				timeline: [
					{
						id: "timeline-coverage",
						jobId: "research-job-1",
						conversationId: "conv-1",
						userId: "user-1",
						taskId: null,
						stage: "coverage_assessment",
						kind: "stage_completed",
						occurredAt: "2026-05-05T10:40:00.000Z",
						messageKey: "deepResearch.timeline.coverageCompleted",
						messageParams: {},
						sourceCounts: {
							discovered: 12,
							reviewed: 5,
							cited: 2,
						},
						assumptions: [],
						warnings: [],
						summary: "Checked coverage.",
						createdAt: "2026-05-05T10:40:00.000Z",
					},
					{
						id: "timeline-synthesis",
						jobId: "research-job-1",
						conversationId: "conv-1",
						userId: "user-1",
						taskId: null,
						stage: "synthesis",
						kind: "stage_completed",
						occurredAt: "2026-05-05T10:50:00.000Z",
						messageKey: "deepResearch.timeline.synthesisCompleted",
						messageParams: {},
						sourceCounts: {
							discovered: 12,
							reviewed: 5,
							cited: 2,
						},
						assumptions: [],
						warnings: [],
						summary: "Synthesized findings.",
						createdAt: "2026-05-05T10:50:00.000Z",
					},
					{
						id: "timeline-citation",
						jobId: "research-job-1",
						conversationId: "conv-1",
						userId: "user-1",
						taskId: null,
						stage: "citation_audit",
						kind: "stage_completed",
						occurredAt: "2026-05-05T11:00:00.000Z",
						messageKey: "deepResearch.timeline.citationAuditCompleted",
						messageParams: {},
						sourceCounts: {
							discovered: 12,
							reviewed: 5,
							cited: 2,
						},
						assumptions: [],
						warnings: [],
						summary: "Audited citations.",
						createdAt: "2026-05-05T11:00:00.000Z",
					},
					{
						id: "timeline-writing",
						jobId: "research-job-1",
						conversationId: "conv-1",
						userId: "user-1",
						taskId: null,
						stage: "report_writing",
						kind: "stage_completed",
						occurredAt: "2026-05-05T11:10:00.000Z",
						messageKey: "deepResearch.timeline.reportWritingCompleted",
						messageParams: {},
						sourceCounts: {
							discovered: 12,
							reviewed: 5,
							cited: 2,
						},
						assumptions: [],
						warnings: ["Citation density was low in one section."],
						summary: "Wrote report.",
						createdAt: "2026-05-05T11:10:00.000Z",
					},
				],
			} as Partial<DeepResearchJob> & { timeline: unknown[] }),
		});

		expect(
			getByRole("button", { name: "Hide Activity Timeline" }),
		).toHaveAttribute("aria-expanded", "true");

		const coverageEvent = getByText("Checked coverage.").closest(
			".research-card__timeline-event",
		);
		const synthesisEvent = getByText("Synthesized findings.").closest(
			".research-card__timeline-event",
		);
		const citationEvent = getByText("Audited citations.").closest(
			".research-card__timeline-event",
		);
		const writingEvent = getByText("Wrote report.").closest(
			".research-card__timeline-event",
		);

		expect(coverageEvent).toHaveTextContent("12 discovered");
		expect(synthesisEvent).not.toHaveTextContent("12 discovered");
		expect(citationEvent).toHaveTextContent("12 discovered");
		expect(writingEvent).toHaveTextContent("12 discovered");
		expect(writingEvent).toHaveTextContent(
			"Citation density was low in one section.",
		);
	});

	it("shows per-event source counts when non-source timeline counts change", async () => {
		const { getByRole, getByText } = render(ResearchCard, {
			job: makeDeepResearchJob({
				status: "running",
				stage: "synthesis",
				timeline: [
					{
						id: "timeline-coverage",
						jobId: "research-job-1",
						conversationId: "conv-1",
						userId: "user-1",
						taskId: null,
						stage: "coverage_assessment",
						kind: "stage_completed",
						occurredAt: "2026-05-05T10:40:00.000Z",
						messageKey: "deepResearch.timeline.coverageCompleted",
						messageParams: {},
						sourceCounts: {
							discovered: 12,
							reviewed: 5,
							cited: 2,
						},
						assumptions: [],
						warnings: [],
						summary: "Checked coverage.",
						createdAt: "2026-05-05T10:40:00.000Z",
					},
					{
						id: "timeline-synthesis",
						jobId: "research-job-1",
						conversationId: "conv-1",
						userId: "user-1",
						taskId: null,
						stage: "synthesis",
						kind: "stage_completed",
						occurredAt: "2026-05-05T10:50:00.000Z",
						messageKey: "deepResearch.timeline.synthesisCompleted",
						messageParams: {},
						sourceCounts: {
							discovered: 12,
							reviewed: 5,
							cited: 3,
						},
						assumptions: [],
						warnings: [],
						summary: "Synthesized findings after one more citation.",
						createdAt: "2026-05-05T10:50:00.000Z",
					},
				],
			} as Partial<DeepResearchJob> & { timeline: unknown[] }),
		});

		await fireEvent.click(
			getByRole("button", { name: "Show Activity Timeline" }),
		);

		const synthesisEvent = getByText(
			"Synthesized findings after one more citation.",
		).closest(".research-card__timeline-event");

		expect(synthesisEvent).toHaveTextContent("12 discovered");
		expect(synthesisEvent).toHaveTextContent("5 reviewed");
		expect(synthesisEvent).toHaveTextContent("3 cited");
	});

	it("shows source ledger progress with distinct discovered, reviewed, and cited counts", () => {
		const { getByText } = render(ResearchCard, {
			job: makeDeepResearchJob({
				status: "running",
				stage: "source_review",
				timeline: [],
				sourceCounts: {
					discovered: 12,
					reviewed: 5,
					cited: 2,
				},
			}),
		});

		expect(getByText("Sources")).toBeInTheDocument();
		expect(getByText("12 discovered")).toBeInTheDocument();
		expect(getByText("5 reviewed")).toBeInTheDocument();
		expect(getByText("2 cited")).toBeInTheDocument();
	});

	it("lists only reviewed and cited sources without presenting discovered-only sources as evidence", () => {
		const { getByText, queryByText } = render(ResearchCard, {
			job: makeDeepResearchJob({
				status: "completed",
				stage: "report_ready",
				sourceCounts: {
					discovered: 3,
					reviewed: 2,
					cited: 1,
				},
				sources: [
					{
						id: "source-discovered",
						jobId: "research-job-1",
						conversationId: "conv-1",
						status: "discovered",
						url: "https://example.com/discovered",
						title: "Discovered-only source",
						provider: "web_search",
						discoveredAt: "2026-05-05T10:10:00.000Z",
						reviewedAt: null,
						citedAt: null,
					},
					{
						id: "source-reviewed",
						jobId: "research-job-1",
						conversationId: "conv-1",
						status: "reviewed",
						url: "https://example.com/reviewed",
						title: "Reviewed source",
						provider: "web_search",
						reviewedNote: "Relevant background source.",
						discoveredAt: "2026-05-05T10:11:00.000Z",
						reviewedAt: "2026-05-05T10:20:00.000Z",
						citedAt: null,
					},
					{
						id: "source-cited",
						jobId: "research-job-1",
						conversationId: "conv-1",
						status: "cited",
						url: "https://example.com/cited",
						title: "Cited source",
						provider: "web_search",
						citationNote: "Supports a report claim.",
						discoveredAt: "2026-05-05T10:12:00.000Z",
						reviewedAt: "2026-05-05T10:21:00.000Z",
						citedAt: "2026-05-05T10:30:00.000Z",
					},
				],
			}),
		});

		expect(getByText("Reviewed sources")).toBeInTheDocument();
		expect(getByText("Reviewed source")).toBeInTheDocument();
		expect(getByText("Relevant background source.")).toBeInTheDocument();
		expect(getByText("Cited source")).toBeInTheDocument();
		expect(getByText("Supports a report claim.")).toBeInTheDocument();
		expect(queryByText("Discovered-only source")).not.toBeInTheDocument();
	});

	it("renders source favicons and keeps a fallback icon slot when the favicon fails", async () => {
		const { container, getByText } = render(ResearchCard, {
			job: makeDeepResearchJob({
				status: "completed",
				stage: "report_ready",
				sourceCounts: {
					discovered: 1,
					reviewed: 1,
					cited: 1,
				},
				sources: [
					{
						id: "source-cited",
						jobId: "research-job-1",
						conversationId: "conv-1",
						status: "cited",
						url: "https://docs.example.com/cited",
						faviconUrl: "https://docs.example.com/favicon.ico",
						title: "Cited source with favicon",
						provider: "web_search",
						discoveredAt: "2026-05-05T10:12:00.000Z",
						reviewedAt: "2026-05-05T10:21:00.000Z",
						citedAt: "2026-05-05T10:30:00.000Z",
					},
				],
			}),
		});

		expect(getByText("Cited source with favicon")).toBeInTheDocument();
		const iconSlot = container.querySelector(".research-card__source-favicon");
		const favicon = iconSlot?.querySelector("img");

		expect(iconSlot).not.toBeNull();
		expect(favicon).not.toBeNull();
		expect(favicon).toHaveAttribute(
			"src",
			"https://docs.example.com/favicon.ico",
		);

		await fireEvent.error(favicon as Element);

		expect(
			container.querySelector(".research-card__source-favicon img"),
		).toBeNull();
		expect(
			container.querySelector(".research-card__source-favicon-fallback"),
		).not.toBeNull();
		expect(container.querySelector(".research-card__source-favicon")).toBe(
			iconSlot,
		);
	});

	it("does not render unexpected private reasoning fields from timeline payloads", async () => {
		const { container, getByRole, getByText, queryByText } = render(
			ResearchCard,
			{
				job: makeDeepResearchJob({
					status: "running",
					stage: "source_discovery",
					timeline: [
						{
							id: "timeline-1",
							jobId: "research-job-1",
							conversationId: "conv-1",
							userId: "user-1",
							taskId: null,
							stage: "source_discovery",
							kind: "stage_completed",
							occurredAt: "2026-05-05T10:20:00.000Z",
							messageKey: "deepResearch.timeline.sourceDiscoveryCompleted",
							messageParams: {
								privateReasoning: "chain-of-thought source strategy",
							},
							sourceCounts: {
								discovered: 8,
								reviewed: 0,
								cited: 0,
							},
							assumptions: [],
							warnings: [],
							summary: "Discovered 8 candidate sources.",
							createdAt: "2026-05-05T10:20:00.000Z",
							privateReasoning:
								"The worker privately ranked alternate search branches.",
							chainOfThought: "Do not render this hidden reasoning.",
						},
					],
				} as Partial<DeepResearchJob> & { timeline: unknown[] }),
			},
		);

		await fireEvent.click(
			getByRole("button", { name: "Show Activity Timeline" }),
		);

		expect(getByText("Discovered 8 candidate sources.")).toBeInTheDocument();
		expect(
			queryByText(/chain-of-thought source strategy/),
		).not.toBeInTheDocument();
		expect(
			queryByText(/privately ranked alternate search branches/),
		).not.toBeInTheDocument();
		expect(queryByText(/hidden reasoning/)).not.toBeInTheDocument();
		expect(container).not.toHaveTextContent("chain-of-thought");
	});

	it("lets the user submit a freeform Plan Edit while awaiting approval", async () => {
		const onEdit = vi.fn(async () => {});
		const { getByRole, getByLabelText, queryByLabelText } = render(
			ResearchCard,
			{
				job: makeDeepResearchJob({
					plan: {
						version: 1,
						renderedPlan:
							"Research Plan\n\nGoal: Compare EU and US battery recycling policy.",
						contextDisclosure: null,
						effortEstimate: {
							selectedDepth: "standard",
							expectedTimeBand: "10-25 minutes",
							sourceReviewCeiling: 40,
							relativeCostWarning:
								"Moderate relative cost; use for serious multi-source synthesis.",
						},
					},
				}),
				onEdit,
			},
		);

		expect(queryByLabelText("Edit plan instructions")).not.toBeInTheDocument();

		await fireEvent.click(getByRole("button", { name: "Edit Research Plan" }));
		const instructions = getByLabelText("Edit plan instructions");
		await fireEvent.input(instructions, {
			target: {
				value: "Focus more on EU enforcement and recent recycling targets.",
			},
		});
		await fireEvent.click(getByRole("button", { name: "Submit Plan Edit" }));

		expect(onEdit).toHaveBeenCalledWith(
			"research-job-1",
			"Focus more on EU enforcement and recent recycling targets.",
		);
		await waitFor(() => {
			expect(
				queryByLabelText("Edit plan instructions"),
			).not.toBeInTheDocument();
		});
	});

	it("locks approval actions while approving and hides edit affordances after approval", async () => {
		let finishApproval: () => void = () => {};
		const onApprove = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finishApproval = resolve;
				}),
		);
		const awaitingApprovalJob = makeDeepResearchJob({
			plan: {
				version: 1,
				renderedPlan:
					"Research Plan\n\nGoal: Compare EU and US battery recycling policy.",
				contextDisclosure: null,
				effortEstimate: {
					selectedDepth: "standard",
					expectedTimeBand: "10-25 minutes",
					sourceReviewCeiling: 40,
					relativeCostWarning:
						"Moderate relative cost; use for serious multi-source synthesis.",
				},
			},
		});
		const { getByRole, queryByRole, rerender } = render(ResearchCard, {
			job: awaitingApprovalJob,
			onApprove,
			onEdit: vi.fn(),
		});

		await fireEvent.click(
			getByRole("button", { name: "Approve Research Plan" }),
		);

		expect(onApprove).toHaveBeenCalledWith("research-job-1");
		expect(
			getByRole("button", { name: "Approve Research Plan" }),
		).toBeDisabled();
		expect(getByRole("button", { name: "Edit Research Plan" })).toBeDisabled();

		finishApproval();
		await rerender({
			job: {
				...awaitingApprovalJob,
				status: "approved",
				stage: "plan_approved",
			},
			onApprove,
			onEdit: vi.fn(),
		});

		expect(
			queryByRole("button", { name: "Approve Research Plan" }),
		).not.toBeInTheDocument();
		expect(
			queryByRole("button", { name: "Edit Research Plan" }),
		).not.toBeInTheDocument();
	});

	it("lets approved and running jobs manually advance the research workflow", async () => {
		const onAdvanceResearch = vi.fn();
		const { getByRole, rerender } = render(ResearchCard, {
			job: makeDeepResearchJob({
				status: "approved",
				stage: "plan_approved",
			}),
			onAdvanceResearch,
		});

		await fireEvent.click(getByRole("button", { name: "Advance research" }));
		expect(onAdvanceResearch).toHaveBeenCalledWith("research-job-1");

		await rerender({
			job: makeDeepResearchJob({
				status: "running",
				stage: "source_review",
			}),
			onAdvanceResearch,
		});
		await fireEvent.click(getByRole("button", { name: "Advance research" }));

		expect(onAdvanceResearch).toHaveBeenCalledTimes(2);
	});

	it("does not show manual workflow advance for completed, cancelled, or failed jobs", () => {
		for (const status of ["completed", "cancelled", "failed"] as const) {
			const { queryByRole, unmount } = render(ResearchCard, {
				job: makeDeepResearchJob({
					status,
					stage: status === "completed" ? "report_ready" : status,
					reportArtifactId: status === "completed" ? "artifact-report-1" : null,
				}),
				onAdvanceResearch: vi.fn(),
			});

			expect(
				queryByRole("button", { name: "Advance research" }),
			).not.toBeInTheDocument();
			unmount();
		}
	});

	it("shows an approval error without opening the Plan Edit form", async () => {
		const onApprove = vi.fn(async () => {
			throw new Error("Approval route unavailable");
		});
		const { getByRole } = render(ResearchCard, {
			job: makeDeepResearchJob({
				plan: {
					version: 1,
					renderedPlan:
						"Research Plan\n\nGoal: Compare EU and US battery recycling policy.",
					contextDisclosure: null,
					effortEstimate: {
						selectedDepth: "standard",
						expectedTimeBand: "10-25 minutes",
						sourceReviewCeiling: 40,
						relativeCostWarning:
							"Moderate relative cost; use for serious multi-source synthesis.",
					},
				},
			}),
			onApprove,
			onEdit: vi.fn(),
		});

		await fireEvent.click(
			getByRole("button", { name: "Approve Research Plan" }),
		);

		await waitFor(() => {
			expect(getByRole("alert")).toHaveTextContent(
				"Approval route unavailable",
			);
		});
	});

	it("shows Report Actions on completed Research Reports and calls their handlers", async () => {
		const onDiscussReport = vi.fn();
		const onResearchFurther = vi.fn();
		const { getByRole } = render(ResearchCard, {
			job: makeDeepResearchJob({
				status: "completed",
				stage: "report_ready",
				reportArtifactId: "artifact-report-1",
				completedAt: Date.now(),
			}),
			onDiscussReport,
			onResearchFurther,
		});

		await fireEvent.click(getByRole("button", { name: "Discuss Report" }));
		await fireEvent.click(getByRole("button", { name: "Research Further" }));

		expect(onDiscussReport).toHaveBeenCalledWith("research-job-1");
		expect(onResearchFurther).toHaveBeenCalledWith("research-job-1");
	});

	it("renders final Research Time next to completed job cost summary", () => {
		const { getByText } = render(ResearchCard, {
			job: makeDeepResearchJob({
				status: "completed",
				stage: "report_ready",
				reportArtifactId: "artifact-report-1",
				completedAt: Date.now(),
				usageSummary: {
					totalCostUsdMicros: 12_345,
					totalTokens: 1234,
					byModel: [],
				},
				runtimeEstimate: {
					label: "10-25 minutes",
					source: "calibrated",
					actualRuntimeMs: 723_000,
				},
			}),
		});

		expect(getByText("Est. $0.0123")).toBeInTheDocument();
		expect(getByText("Research time 12m 03s")).toBeInTheDocument();
	});

	it("presents completed Evidence Limitation Memos with actionable recovery buttons", async () => {
		const onDiscussReport = vi.fn();
		const onResearchFurther = vi.fn();
		const { getAllByText, getByText, queryByRole, queryByText } = render(
			ResearchCard,
			{
				job: makeDeepResearchJob({
					status: "completed",
					stage: "evidence_limitation_memo_ready",
					depth: "focused",
					reportArtifactId: "artifact-memo-1",
					completedAt: Date.now(),
					sourceCounts: {
						discovered: 5,
						reviewed: 2,
						cited: 0,
					},
					evidenceLimitationMemo: {
						title: "Evidence Limitation Memo: Battery recycling claims",
						reviewedScope: {
							discoveredCount: 5,
							reviewedCount: 2,
							topicRelevantCount: 1,
							rejectedOrOffTopicCount: 3,
						},
						limitations: [
							"Only one reviewed source matched the approved key questions.",
							"Two opened sources were rejected as off-topic.",
						],
						nextResearchDirection:
							"Revise the plan toward official enforcement guidance and add primary sources.",
						recoveryActions: [
							{
								kind: "revise_plan",
								label: "Revise plan",
								description: "Clarify the approved question or scope.",
							},
							{
								kind: "add_sources",
								label: "Add sources",
								description: "Attach stronger primary sources.",
							},
							{
								kind: "choose_deeper_depth",
								label: "Choose deeper depth",
								description:
									"Start a new run only after explicitly choosing a deeper depth.",
							},
							{
								kind: "targeted_follow_up",
								label: "Targeted follow-up",
								description: "Run focused follow-up research.",
							},
						],
					},
				} as Partial<DeepResearchJob> & { evidenceLimitationMemo: unknown }),
				onDiscussReport,
				onResearchFurther,
			},
		);

		expect(getByText("Insufficient evidence")).toBeInTheDocument();
		expect(queryByText("Failed")).not.toBeInTheDocument();
		expect(getByText("Reviewed scope")).toBeInTheDocument();
		expect(getAllByText("5 discovered").length).toBeGreaterThan(0);
		expect(getAllByText("2 reviewed").length).toBeGreaterThan(0);
		expect(getByText("1 topic-relevant")).toBeInTheDocument();
		expect(getByText("3 rejected/off-topic")).toBeInTheDocument();
		expect(getByText("Grounded limitation reasons")).toBeInTheDocument();
		expect(
			getByText("Only one reviewed source matched the approved key questions."),
		).toBeInTheDocument();
		expect(getByText("Next research direction")).toBeInTheDocument();
		expect(
			getByText(/Revise the plan toward official enforcement guidance/),
		).toBeInTheDocument();
		expect(getByText("Memo Recovery Actions")).toBeInTheDocument();
		expect(getByText("Revise plan")).toBeInTheDocument();
		expect(getByText("Add sources")).toBeInTheDocument();
		expect(getByText("Choose deeper depth")).toBeInTheDocument();
		expect(getByText("Targeted follow-up")).toBeInTheDocument();
		expect(
			queryByRole("button", { name: "Discuss Report" }),
		).not.toBeInTheDocument();
		expect(
			queryByRole("button", { name: "Research Further" }),
		).not.toBeInTheDocument();

		await fireEvent.click(getByText("Revise plan"));
		await fireEvent.click(getByText("Add sources"));
		await fireEvent.click(getByText("Choose deeper depth"));
		await fireEvent.click(getByText("Targeted follow-up"));

		expect(onDiscussReport).toHaveBeenCalledWith("research-job-1");
		expect(onResearchFurther).toHaveBeenNthCalledWith(1, "research-job-1");
		expect(onResearchFurther).toHaveBeenNthCalledWith(2, "research-job-1", {
			depth: "standard",
		});
		expect(onResearchFurther).toHaveBeenNthCalledWith(3, "research-job-1");
	});

	it("shows pending feedback and ignores repeated Evidence Limitation Memo recovery clicks", async () => {
		let resolveResearchFurther: (() => void) | undefined;
		const onResearchFurther = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolveResearchFurther = resolve;
				}),
		);
		const { getByRole } = render(ResearchCard, {
			job: makeDeepResearchJob({
				status: "completed",
				stage: "evidence_limitation_memo_ready",
				depth: "focused",
				reportArtifactId: "artifact-memo-1",
				completedAt: Date.now(),
				evidenceLimitationMemo: {
					title: "Evidence Limitation Memo: Battery recycling claims",
					reviewedScope: {
						discoveredCount: 5,
						reviewedCount: 2,
						topicRelevantCount: 1,
						rejectedOrOffTopicCount: 3,
					},
					limitations: [
						"Only one reviewed source matched the approved key questions.",
					],
					nextResearchDirection: "Revise the plan toward official guidance.",
					recoveryActions: [
						{
							kind: "targeted_follow_up",
							label: "Targeted follow-up",
							description: "Run focused follow-up research.",
						},
					],
				},
			} as Partial<DeepResearchJob> & { evidenceLimitationMemo: unknown }),
			onResearchFurther,
		});

		const actionButton = getByRole("button", { name: "Targeted follow-up" });

		await fireEvent.click(actionButton);
		await fireEvent.click(actionButton);

		expect(onResearchFurther).toHaveBeenCalledTimes(1);
		expect(actionButton).toBeDisabled();
		expect(actionButton).toHaveTextContent("Opening...");

		resolveResearchFurther?.();
		await waitFor(() => {
			expect(actionButton).not.toBeDisabled();
		});
	});

	it("does not show Report Actions before a Research Report is completed", () => {
		const { queryByRole } = render(ResearchCard, {
			job: makeDeepResearchJob({
				status: "running",
				stage: "synthesis",
				reportArtifactId: null,
			}),
			onDiscussReport: vi.fn(),
			onResearchFurther: vi.fn(),
		});

		expect(
			queryByRole("button", { name: "Discuss Report" }),
		).not.toBeInTheDocument();
		expect(
			queryByRole("button", { name: "Research Further" }),
		).not.toBeInTheDocument();
	});

	it("opens a completed fake Research Report in the document workspace", async () => {
		const onOpenReport = vi.fn<(document: DocumentWorkspaceItem) => void>();
		const { getByRole } = render(ResearchCard, {
			job: makeDeepResearchJob({
				status: "completed",
				stage: "report_ready",
				reportArtifactId: "artifact-report-1",
				completedAt: Date.now(),
			}),
			onOpenReport,
		});

		await fireEvent.click(getByRole("button", { name: "Open Report" }));

		expect(onOpenReport).toHaveBeenCalledWith({
			id: "artifact:artifact-report-1",
			source: "knowledge_artifact",
			filename: "Research Report - Research battery recycling policy.md",
			title: "Research Report - Research battery recycling policy.md",
			documentLabel: "Research Report - Research battery recycling policy.md",
			documentRole: "research_report",
			versionNumber: 1,
			mimeType: "text/markdown",
			artifactId: "artifact-report-1",
			conversationId: "conv-1",
			previewUrl: "/api/knowledge/artifact-report-1/preview",
			downloadUrl: "/api/knowledge/artifact-report-1/download",
		});
	});

	it("labels limited Research Reports distinctly while keeping completed report handoff", async () => {
		const onOpenReport = vi.fn<(document: DocumentWorkspaceItem) => void>();
		const { getAllByText, getByRole, getByText, queryByText } = render(
			ResearchCard,
			{
				job: makeDeepResearchJob({
					status: "completed",
					stage: "limited_research_report_ready",
					reportArtifactId: "artifact-limited-report-1",
					completedAt: Date.now(),
				}),
				onOpenReport,
			},
		);

		expect(getAllByText("Completed").length).toBeGreaterThan(0);
		expect(queryByText("Insufficient evidence")).not.toBeInTheDocument();
		expect(getByText("Limited Research Report")).toBeInTheDocument();
		expect(
			getByText(
				"The report is complete, but it explicitly labels evidence limits and unresolved gaps.",
			),
		).toBeInTheDocument();

		await fireEvent.click(
			getByRole("button", { name: "Open Limited Research Report" }),
		);

		expect(onOpenReport).toHaveBeenCalledWith({
			id: "artifact:artifact-limited-report-1",
			source: "knowledge_artifact",
			filename:
				"Limited Research Report - Research battery recycling policy.md",
			title: "Limited Research Report - Research battery recycling policy.md",
			documentLabel:
				"Limited Research Report - Research battery recycling policy.md",
			documentRole: "research_report",
			versionNumber: 1,
			mimeType: "text/markdown",
			artifactId: "artifact-limited-report-1",
			conversationId: "conv-1",
			previewUrl: "/api/knowledge/artifact-limited-report-1/preview",
			downloadUrl: "/api/knowledge/artifact-limited-report-1/download",
		});
	});
});
