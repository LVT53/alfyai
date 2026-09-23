import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import chatDict from "$lib/i18n/chat";
import type { atlasJobs } from "$lib/server/db/schema";
import { ATLAS_V3_PHASES } from "$lib/server/services/atlas/progress-details";
import { mapAtlasJobRowToCard } from "$lib/server/services/atlas/read-model";
import { resolveRunningJobPhase } from "$lib/server/services/home-summary";
import { parseAtlasActivityDetails } from "$lib/utils/tool-activity";
import AtlasActivityRow from "./AtlasActivityRow.svelte";

// End-to-end regression for the v3-only consolidation (Phase B): Atlas v1 and
// v2 no longer run, but their `atlas_jobs` rows stay in users' conversations.
// Each case below starts from the raw stored row — `pipeline_version`, the
// `stage` column and the `progress_details_json` string exactly as the deleted
// pipelines wrote them — and goes through the live read path
// (`mapAtlasJobRowToCard` → `AtlasActivityRow`), so a removed sanitiser branch,
// stage label or i18n key shows up here rather than on an old card.

const NOW = new Date("2026-09-01T10:00:00.000Z");

function storedRow(
	overrides: Partial<typeof atlasJobs.$inferSelect>,
): typeof atlasJobs.$inferSelect {
	return {
		id: "atlas-job-old",
		userId: "user-1",
		conversationId: "conv-1",
		assistantMessageId: "assistant-1",
		action: "create",
		parentAtlasJobId: null,
		profile: "in-depth",
		pipelineVersion: 1,
		normalizedQueryHash: "hash",
		clientAtlasTurnId: "client-turn-1",
		idempotencyKey: "atlas:v1:user-1:conv-1:create:root:in-depth:hash",
		title: "Enterprise search in 2026",
		status: "succeeded",
		stage: "audit",
		progressPercent: 100,
		progressDetailsJson: "{}",
		workerId: null,
		heartbeatAt: null,
		startedAt: new Date(NOW.getTime() - 540_000),
		completedAt: NOW,
		cancelRequestedAt: null,
		inputTokens: 1200,
		outputTokens: 800,
		totalTokens: 2000,
		costUsdMicros: 250000,
		localSourceCount: 1,
		webSourceCount: 12,
		acceptedSourceCount: 9,
		rejectedSourceCount: 3,
		fileProductionJobId: "file-job-1",
		htmlChatGeneratedFileId: "html-1",
		pdfChatGeneratedFileId: "pdf-1",
		markdownChatGeneratedFileId: "md-1",
		errorCode: null,
		errorMessage: null,
		errorRetryable: false,
		failureMetadataJson: null,
		createdAt: new Date(NOW.getTime() - 600_000),
		updatedAt: NOW,
		...overrides,
	};
}

// v1 wrote its search queries and gap-fill focus into the details blob.
const V1_DETAILS = JSON.stringify({
	queries: [
		"enterprise rag cost benchmark 2026",
		"hybrid retrieval reranking recall study",
	],
	focus: ["reranking latency"],
	roundKind: "gap-fill",
});

// v2's blob, as `atlas-v2/progress.ts` built it.
const V2_DETAILS = JSON.stringify({
	pipelineVersion: 2,
	phase: "render",
	plan: [
		{
			id: "q1",
			question: "What capacity was added?",
			status: "done",
			sourceCount: 5,
			confidence: "corroborated",
		},
		{
			id: "q2",
			question: "What does the regulator require?",
			status: "done",
			sourceCount: 3,
			confidence: "single",
		},
	],
	round: { current: 3, total: 3 },
	sourcesRead: 17,
	next: null,
	phaseDurationsMs: { plan: 1200, research: 45000 },
	sections: { written: 4, planned: 4 },
	evidence: {
		corroborated: 3,
		single: 2,
		inferred: 1,
		cut: 1,
		filteredCount: 4,
		sources: [
			{
				n: 1,
				title: "Report 1",
				host: "source1.example",
				date: "2026-04-01",
				cited: true,
				snippet: "Evidence for source 1 with a figure of 1 GW.",
			},
		],
	},
});

function expectNoRawI18nKeys(): void {
	const text = document.body.textContent ?? "";
	expect(text).not.toMatch(/atlas(Activity)?\.[a-zA-Z]+\.[a-zA-Z]+/);
}

describe("stored Atlas v1/v2 rows render through the current read path", () => {
	it("renders a succeeded v1 row with its downloads", async () => {
		const card = mapAtlasJobRowToCard(
			storedRow({ progressDetailsJson: V1_DETAILS }),
		);
		expect(card.pipelineVersion).toBe(1);
		render(AtlasActivityRow, { job: card });

		const row = screen.getByTestId("tool-activity-row");
		expect(row).toHaveAttribute("data-status", "done");
		await fireEvent.click(screen.getByTestId("atlas-download-menu-button"));
		const menu = screen.getByRole("menu", { name: "Download" });
		expect(
			within(menu)
				.getAllByRole("menuitem")
				.map((item) => item.getAttribute("href")),
		).toEqual([
			"/api/chat/files/pdf-1/download",
			"/api/chat/files/html-1/download",
			"/api/chat/files/md-1/download",
		]);
		expectNoRawI18nKeys();
	});

	it("renders a v1 row left running at deploy with its v1 stage label", () => {
		const card = mapAtlasJobRowToCard(
			storedRow({
				status: "running",
				stage: "gap-fill",
				progressPercent: 62,
				progressDetailsJson: V1_DETAILS,
				completedAt: null,
			}),
		);
		render(AtlasActivityRow, { job: card });
		expect(screen.getByTestId("atlas-stage-line")).toHaveTextContent(
			"Filling evidence gaps",
		);
		// A gap-fill round lists its focus, not the original queries.
		expect(screen.getByTestId("atlas-plan-fallback")).toHaveTextContent(
			"reranking latency",
		);
		expectNoRawI18nKeys();
	});

	it("renders a failed v1 row with its stored error and a Retry", () => {
		const card = mapAtlasJobRowToCard(
			storedRow({
				status: "failed",
				stage: "audit",
				progressPercent: 88,
				progressDetailsJson: V1_DETAILS,
				errorCode: "atlas_quality_gate_failed",
				errorMessage: "Atlas could not verify enough claims to publish.",
				errorRetryable: true,
				failureMetadataJson: JSON.stringify({ honestyMarkers: [] }),
				htmlChatGeneratedFileId: null,
				pdfChatGeneratedFileId: null,
				markdownChatGeneratedFileId: null,
				fileProductionJobId: null,
			}),
		);
		render(AtlasActivityRow, { job: card });
		expect(screen.getByTestId("tool-activity-row")).toHaveAttribute(
			"data-status",
			"failed",
		);
		expect(screen.getByTestId("atlas-failure-reason")).toHaveTextContent(
			"Atlas could not verify enough claims to publish.",
		);
		expect(screen.getByTestId("atlas-retry")).toBeInTheDocument();
		expectNoRawI18nKeys();
	});

	it("renders a succeeded v2 row with its plan and evidence", async () => {
		const card = mapAtlasJobRowToCard(
			storedRow({
				pipelineVersion: 2,
				stage: "render",
				progressDetailsJson: V2_DETAILS,
			}),
		);
		expect(card.pipelineVersion).toBe(2);
		render(AtlasActivityRow, { job: card });

		expect(screen.getByTestId("tool-activity-row")).toHaveAttribute(
			"data-status",
			"done",
		);
		expect(screen.getByTestId("atlas-report-tab")).toHaveTextContent(
			"9 sources",
		);
		await fireEvent.click(screen.getByRole("tab", { name: /Evidence/ }));
		expect(document.body).toHaveTextContent("Report 1");
		expectNoRawI18nKeys();
	});

	it("renders a cancelled v2 row with Continue", () => {
		const card = mapAtlasJobRowToCard(
			storedRow({
				pipelineVersion: 2,
				status: "cancelled",
				stage: "research",
				progressPercent: 33,
				progressDetailsJson: JSON.stringify({
					...JSON.parse(V2_DETAILS),
					phase: "research",
				}),
			}),
		);
		render(AtlasActivityRow, { job: card });
		expect(screen.getByTestId("atlas-continue")).toBeInTheDocument();
		expectNoRawI18nKeys();
	});

	it("renders a freshly claimed row (stage ask, empty details) without a raw key", () => {
		// `claimNextAtlasJob` now stamps stage "ask", 0% and "{}" details; the
		// card shows it until the pipeline's first heartbeat lands.
		const card = mapAtlasJobRowToCard(
			storedRow({
				pipelineVersion: 3,
				status: "running",
				stage: "ask",
				progressPercent: 0,
				progressDetailsJson: "{}",
				completedAt: null,
			}),
		);
		render(AtlasActivityRow, { job: card });
		expect(screen.getByTestId("atlas-stage-line")).toHaveTextContent(
			"Running research",
		);
		expectNoRawI18nKeys();
	});
});

describe("every v3 phase has a label", () => {
	it.each(
		ATLAS_V3_PHASES,
	)("parses and labels the v3 %s phase in EN and HU", (phase) => {
		expect(parseAtlasActivityDetails({ pipelineVersion: 3, phase }).phase).toBe(
			phase,
		);
		const key = `atlasActivity.phase.${phase}` as const;
		expect((chatDict.en as Record<string, string>)[key]).toBeTruthy();
		expect((chatDict.hu as Record<string, string>)[key]).toBeTruthy();
		for (const locale of ["en", "hu"] as const) {
			expect(
				resolveRunningJobPhase({
					status: "running",
					stage: phase,
					progressDetailsJson: JSON.stringify({ pipelineVersion: 3, phase }),
					locale,
				}),
			).toBe((chatDict[locale] as Record<string, string>)[key]);
		}
	});
});
