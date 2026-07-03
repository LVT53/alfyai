import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationContextStatus } from "$lib/types";
import ContextUsageRing from "./ContextUsageRing.svelte";

vi.mock("$lib/i18n", () => ({
	t: {
		subscribe: vi.fn((cb: (v: (key: string) => string) => void) => {
			const fn = (key: string) => key;
			cb(fn);
			return vi.fn();
		}),
	},
}));

function renderRing(props: Record<string, unknown> = {}) {
	return render(ContextUsageRing, {
		props: {
			contextStatus: null,
			attachedArtifacts: [],
			onManageEvidence: undefined,
			...props,
		},
	});
}

describe("ContextUsageRing cost display", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("renders cost row when totalCostUsd and totalTokens are provided", () => {
		renderRing({ totalCostUsd: 0.42, totalTokens: 12400 });

		expect(screen.getByText(/\$0\.42/)).toBeTruthy();
		expect(screen.getByText(/12[,.]?4K/)).toBeTruthy();
	});

	it("does not render cost section when totalCostUsd is 0", () => {
		renderRing({ totalCostUsd: 0, totalTokens: 0 });

		expect(screen.queryByText(/\$/)).toBeNull();
	});

	it("omits the unused focus section and task control buttons", () => {
		renderRing({});

		expect(screen.queryByText("contextUsageRing.focus")).toBeNull();
		expect(screen.queryByText("Prepare launch brief")).toBeNull();
		expect(screen.queryByText("contextUsageRing.unlockTask")).toBeNull();
		expect(screen.queryByText("contextUsageRing.startNewTask")).toBeNull();
		expect(screen.queryByText("contextUsageRing.manageEvidence")).toBeNull();
	});

	it("opens context source management without restoring task controls", async () => {
		const manageEvidence = vi.fn();
		renderRing({ onManageEvidence: manageEvidence });

		await fireEvent.click(screen.getByLabelText("contextUsageRing.noContext"));
		await fireEvent.click(
			screen.getByRole("button", { name: "contextUsageRing.manageEvidence" }),
		);

		expect(manageEvidence).toHaveBeenCalledTimes(1);
		expect(screen.queryByText("contextUsageRing.unlockTask")).toBeNull();
		expect(screen.queryByText("contextUsageRing.startNewTask")).toBeNull();
	});

	it("removes across chats section even when continuity exists", () => {
		renderRing({
			taskState: {
				continuity: {
					name: "Test Project",
					summary: "A test",
					status: "active",
					linkedTaskCount: 3,
				},
			},
			totalCostUsd: 0.42,
			totalTokens: 12400,
		});

		expect(screen.queryByText(/across chats/i)).toBeNull();
	});

	it("removes compaction and routing stat rows from context section", () => {
		renderRing({
			contextStatus: {
				estimatedTokens: 5000,
				targetTokens: 157286,
				thresholdTokens: 209715,
				compactionMode: "none",
				routingStage: "deterministic",
				routingConfidence: 100,
				verificationStatus: "skipped",
				layersUsed: [],
				recentTurnCount: 5,
				workingSetCount: 3,
				workingSetArtifactIds: [],
				workingSetApplied: true,
				taskStateApplied: true,
				promptArtifactCount: 1,
				summary: null,
				updatedAt: Date.now(),
			},
			contextDebug: {
				routingStage: "deterministic",
				routingConfidence: 100,
				verificationStatus: "skipped",
				selectedEvidence: [],
				pinnedEvidence: [],
				excludedEvidence: [],
			},
			totalCostUsd: 0.42,
			totalTokens: 12400,
		});

		expect(screen.queryByText(/pressure threshold/i)).toBeNull();
		expect(screen.queryByText(/routing/i)).toBeNull();
		expect(screen.queryByText(/verification/i)).toBeNull();
	});

	it("uses contextSources for source counts and reduced state when available", () => {
		renderRing({
			contextStatus: {
				estimatedTokens: 5000,
				targetTokens: 157286,
				thresholdTokens: 209715,
				compactionMode: "none",
				routingStage: "deterministic",
				routingConfidence: 100,
				verificationStatus: "skipped",
				layersUsed: [],
				recentTurnCount: 5,
				workingSetCount: 3,
				workingSetArtifactIds: [],
				workingSetApplied: true,
				taskStateApplied: true,
				promptArtifactCount: 1,
				summary: null,
				updatedAt: Date.now(),
			},
			contextDebug: {
				routingStage: "deterministic",
				routingConfidence: 100,
				verificationStatus: "skipped",
				selectedEvidence: [],
				pinnedEvidence: [],
				excludedEvidence: [],
			},
			contextSources: {
				conversationId: "conversation-1",
				userId: "user-1",
				activeCount: 2,
				inferredCount: 0,
				selectedCount: 2,
				pinnedCount: 1,
				excludedCount: 1,
				reduced: true,
				compacted: false,
				groups: [],
				updatedAt: Date.now(),
			},
		});

		expect(screen.getByText("contextSources.currentSelection")).toBeTruthy();
		expect(screen.getByText("contextSources.state")).toBeTruthy();
		expect(screen.getByText("contextSources.reduced")).toBeTruthy();
		expect(screen.getByText("contextSources.pinned")).toBeTruthy();
		expect(screen.getByText("contextSources.excluded")).toBeTruthy();
	});

	it("formats sub-dollar cost with 4 decimal places", () => {
		renderRing({ totalCostUsd: 0.0042, totalTokens: 500 });

		expect(screen.getByText(/\$0\.0042/)).toBeTruthy();
	});

	it("formats multi-dollar cost with 2 decimal places", () => {
		renderRing({ totalCostUsd: 2.36, totalTokens: 96400 });

		expect(screen.getByText(/\$2\.36/)).toBeTruthy();
	});

	it("formats millions of tokens as M", () => {
		renderRing({ totalCostUsd: 1, totalTokens: 1_240_000 });

		expect(screen.getByText(/1\.2M/)).toBeTruthy();
	});
});

describe("ContextUsageRing humanized popover", () => {
	function contextStatusAtRatio(ratio: number): ConversationContextStatus {
		// targetTokens drives the ratio (estimatedTokens / targetTokens).
		const targetTokens = 100000;
		return {
			conversationId: "conversation-1",
			userId: "user-1",
			estimatedTokens: Math.round(targetTokens * ratio),
			maxContextTokens: 200000,
			thresholdTokens: 209715,
			targetTokens,
			compactionApplied: false,
			compactionMode: "none",
			routingStage: "deterministic",
			routingConfidence: 100,
			verificationStatus: "skipped",
			layersUsed: [],
			workingSetCount: 0,
			workingSetArtifactIds: [],
			workingSetApplied: false,
			taskStateApplied: false,
			promptArtifactCount: 0,
			recentTurnCount: 8,
			summary: null,
			updatedAt: Date.now(),
		};
	}

	it("shows the Conversation cost label alongside the conversation total", () => {
		renderRing({
			contextStatus: contextStatusAtRatio(0.1),
			totalCostUsd: 0.184,
			totalTokens: 12400,
		});

		expect(screen.getByText("contextUsageRing.conversationCost")).toBeTruthy();
		expect(screen.getByText(/\$0\.184/)).toBeTruthy();
	});

	it("shows the Context room bar with N% used and no plenty-left subtext", () => {
		renderRing({
			contextStatus: contextStatusAtRatio(0.1),
		});

		expect(screen.getByText("contextUsageRing.contextRoom")).toBeTruthy();
		// usageFormat renders the percent (10% at 0.1 ratio, rounded).
		expect(screen.getByText("contextUsageRing.usageFormat")).toBeTruthy();
		// The context-room bar element exists.
		expect(document.querySelector(".popover-context-room")).toBeTruthy();
	});

	it("shows the near-trigger heads-up note when ratio >= 0.78", () => {
		renderRing({
			contextStatus: contextStatusAtRatio(0.8),
		});

		expect(screen.getByText("contextUsageRing.nearTriggerNote")).toBeTruthy();
		// The bar should take the near-trigger (amber) accent.
		const bar = document.querySelector(".popover-context-room");
		expect(bar?.classList.contains("popover-context-room--near")).toBe(true);
	});

	it("does not show the near-trigger note well below the threshold", () => {
		renderRing({
			contextStatus: contextStatusAtRatio(0.4),
		});

		expect(screen.queryByText("contextUsageRing.nearTriggerNote")).toBeNull();
	});

	it("does not show the near-trigger note once compacted", () => {
		const status = contextStatusAtRatio(0.8);
		status.compactionMode = "llm_fallback";
		renderRing({
			contextStatus: status,
		});

		expect(screen.queryByText("contextUsageRing.nearTriggerNote")).toBeNull();
	});
});
