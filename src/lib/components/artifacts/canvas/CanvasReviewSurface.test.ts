import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AlfyRawBoardOp } from "$lib/components/artifacts/document/alfy-activity";
import { sampleBoard } from "$lib/shared/artifacts/canvas-fixtures.test-helpers";
import type { CanvasReviewState } from "$lib/shared/artifacts/canvas-review";
import { uiLanguage } from "$lib/stores/settings";

const api = vi.hoisted(() => ({
	fetchCanvasReviewState: vi.fn(),
	acknowledgeCanvasReview: vi.fn(),
	fetchArtifactVersionBody: vi.fn(),
}));
vi.mock("$lib/client/api/artifacts", () => api);

import {
	CanvasReviewController,
	type LandingBoard,
} from "./_lib/review-controller.svelte";
import CanvasReviewBar from "./CanvasReviewBar.svelte";
import CanvasReviewNotices from "./CanvasReviewNotices.svelte";

// What the reader sees of Alfy's change outside the board itself: the review bar
// below it, and above it the arranging pill, what Alfy skipped and Undo refused.
// A real controller with a fake board and network; the layer on the board has
// its own test.

function state(overrides: Partial<CanvasReviewState> = {}): CanvasReviewState {
	return {
		changes: [
			{
				versionNumber: 2,
				summary: "Planned Sunday",
				touchedIds: ["a", "b"],
				removedCount: 0,
			},
		],
		touchedIds: ["a", "b"],
		removedCount: 0,
		count: 2,
		latestAlfyVersion: 2,
		undo: { available: true, toVersion: 1, toVersionId: "v1" },
		...overrides,
	};
}

function make() {
	const board: LandingBoard = {
		current: () => sampleBoard(),
		land: vi.fn(),
		place: vi.fn(),
		hold: vi.fn(),
	};
	const host = {
		artifactId: "board-1",
		conversationId: null,
		board: () => board,
		saveNow: vi.fn().mockResolvedValue(undefined),
		write: vi.fn(),
		openVersions: vi.fn(),
		reportCount: vi.fn(),
	};
	return { controller: new CanvasReviewController(host), host };
}

beforeEach(() => {
	uiLanguage.set("en");
	for (const fn of Object.values(api)) fn.mockReset();
	api.fetchCanvasReviewState.mockResolvedValue(state());
	api.acknowledgeCanvasReview.mockResolvedValue(
		state({ count: 0, touchedIds: [], changes: [] }),
	);
});
afterEach(() => cleanup());

describe("the review bar below the board", () => {
	it("says what Alfy changed and steps through it, with the change's own Keep and Undo", async () => {
		const { controller } = make();
		controller.restore(state());
		render(CanvasReviewBar, { controller });

		const bar = screen.getByRole("region", {
			name: "Alfy's changes to the board",
		});
		expect(bar).toHaveTextContent("Alfy changed 2 blocks.");
		expect(screen.getByText("1 / 2")).toBeInTheDocument();

		await fireEvent.click(screen.getByRole("button", { name: "Next change" }));
		expect(controller.index).toBe(1);
		expect(controller.goto?.id).toBe("b");
		await fireEvent.click(
			screen.getByRole("button", { name: "Previous change" }),
		);
		expect(controller.index).toBe(0);
	});

	it("keeps the whole change with Keep all", async () => {
		const { controller } = make();
		controller.restore(state());
		render(CanvasReviewBar, { controller });
		await fireEvent.click(screen.getByRole("button", { name: /Keep all/ }));
		expect(api.acknowledgeCanvasReview).toHaveBeenCalledWith(
			"board-1",
			2,
			null,
		);
		expect(controller.status).toBe("kept");
	});

	it("undoes the whole change with Undo all", async () => {
		const { controller } = make();
		controller.restore(state());
		const undo = vi.spyOn(controller, "undo").mockResolvedValue();
		render(CanvasReviewBar, { controller });
		await fireEvent.click(screen.getByRole("button", { name: /Undo all/ }));
		expect(undo).toHaveBeenCalledTimes(1);
	});

	it("is not there without a change waiting, and leaves once it is decided", async () => {
		// The bar sinks out; jsdom never finishes a transition, so this one is told to
		// move less (reduced motion is instant, which is also a state to test).
		Object.defineProperty(window, "matchMedia", {
			configurable: true,
			value: () => ({ matches: true }),
		});
		const { controller } = make();
		const view = render(CanvasReviewBar, { controller });
		expect(screen.queryByTestId("canvas-review-bar")).toBeNull();
		controller.restore(state());
		expect(await screen.findByTestId("canvas-review-bar")).toBeInTheDocument();
		void controller.keep();
		await vi.waitFor(() =>
			expect(screen.queryByTestId("canvas-review-bar")).toBeNull(),
		);
		view.unmount();
		delete (window as { matchMedia?: unknown }).matchMedia;
	});

	it("says what it took away, in Hungarian too", () => {
		uiLanguage.set("hu");
		const { controller } = make();
		controller.restore(
			state({
				touchedIds: ["a"],
				removedCount: 2,
				count: 1,
				changes: [
					{
						versionNumber: 2,
						summary: "x",
						touchedIds: ["a"],
						removedCount: 2,
					},
				],
			}),
		);
		render(CanvasReviewBar, { controller });
		expect(screen.getByRole("region")).toHaveTextContent(
			"Alfy 1 blokkot módosított és 2 blokkot eltávolított.",
		);
	});
});

describe("above the board", () => {
	it("says Alfy is arranging, with what it is doing", () => {
		const { controller } = make();
		controller.beginArranging({ label: "Planned Sunday", ops: [] });
		render(CanvasReviewNotices, { controller });
		expect(screen.getByTestId("canvas-arranging")).toHaveTextContent(
			"Alfy is arranging: Planned Sunday",
		);
	});

	it("says it plainly when the call gave no summary", () => {
		const { controller } = make();
		controller.beginArranging({ label: null, ops: [] });
		render(CanvasReviewNotices, { controller });
		expect(screen.getByTestId("canvas-arranging")).toHaveTextContent(
			"Alfy is arranging…",
		);
	});

	it("lists what Alfy skipped in the shared notice, and can be dismissed", async () => {
		const { controller } = make();
		controller.restore(state());
		await controller.settleActivity(
			{
				key: "c",
				artifactId: "board-1",
				toolName: "edit_artifact",
				status: "refused",
				label: null,
				patches: [],
				ops: [
					{ op: "move", id: "ghost", to: { x: 1, y: 1 } },
				] as AlfyRawBoardOp[],
				refusedBlocks: [{ blockId: "ghost", reason: "unknown_id", opIndex: 0 }],
				appliedCount: 0,
			},
			null,
		);
		render(CanvasReviewNotices, { controller });
		const notice = screen.getByTestId("refusal-notice");
		expect(notice).toHaveTextContent("Alfy skipped 1 change.");
		expect(notice).toHaveTextContent("nothing is at that position any more");
		await fireEvent.click(
			screen.getByRole("button", { name: "See what Alfy did" }),
		);
		expect(controller.goto?.id).toBe("a");
		await fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		await vi.waitFor(() => expect(controller.refusal).toBeNull());
	});

	it("points to the versions when Undo cannot be done", async () => {
		const { controller, host } = make();
		controller.restore(state());
		api.fetchCanvasReviewState.mockResolvedValue(
			state({ undo: { available: false, reason: "user_edited" } }),
		);
		await controller.undo();
		render(CanvasReviewNotices, { controller });
		expect(screen.getByTestId("refusal-notice")).toHaveTextContent(
			"can't be undone here because the board has changed since",
		);
		await fireEvent.click(
			screen.getByRole("button", { name: "Open Versions" }),
		);
		expect(host.openVersions).toHaveBeenCalledTimes(1);
	});

	it("tells a screen reader what happened, politely", async () => {
		const { controller } = make();
		controller.restore(state());
		await controller.keep();
		render(CanvasReviewNotices, { controller });
		const live = screen.getByTestId("canvas-review-live");
		expect(live.getAttribute("aria-live")).toBe("polite");
		expect(live).toHaveTextContent("Kept");
	});
});
