import { render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryOverview } from "$lib/memory-types";
import { uiLanguage } from "$lib/stores/settings";
import MemoryOverviewSheet from "./MemoryOverviewSheet.svelte";

const api = vi.hoisted(() => ({
	fetchMemoryOverview: vi.fn(),
	writeMemoryOverview: vi.fn(),
}));
vi.mock("$lib/client/api/memory", () => api);
vi.mock("svelte/transition", () => ({
	fade: () => ({ duration: 0 }),
	fly: () => ({ duration: 0 }),
	scale: () => ({ duration: 0 }),
	slide: () => ({ duration: 0 }),
}));

const scope = { kind: "personal" } as const;
const none = (currentCount: number): MemoryOverview => ({
	state: "none",
	currentCount,
	text: null,
	writtenFrom: null,
	writtenAt: null,
});
const written: MemoryOverview = {
	state: "written",
	currentCount: 9,
	text: "A synthetic overview.",
	writtenFrom: 9,
	writtenAt: new Date().toISOString(),
};

function show() {
	return render(MemoryOverviewSheet, {
		scope,
		title: "Overview of you",
		onClose: vi.fn(),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	uiLanguage.set("en");
});

describe("the Overview sheet while it writes", () => {
	it("says how many entries it writes from, once the kept Overview's read said so", async () => {
		api.fetchMemoryOverview.mockResolvedValue(none(9));
		api.writeMemoryOverview.mockReturnValue(new Promise(() => {}));
		show();
		expect(await screen.findByText("Writing your overview…")).toBeTruthy();
		expect(screen.getByText("From your 9 current entries.")).toBeTruthy();
	});

	it("says nothing about a count it does not know when that read failed", async () => {
		api.fetchMemoryOverview.mockRejectedValue(new Error("offline"));
		api.writeMemoryOverview.mockReturnValue(new Promise(() => {}));
		show();
		expect(await screen.findByText("Writing your overview…")).toBeTruthy();
		expect(screen.queryByText(/From your/)).toBeNull();
		expect(screen.queryByText(/ 0 /)).toBeNull();
	});

	it("shows the written paragraph when the write lands, after a failed read too", async () => {
		api.fetchMemoryOverview.mockRejectedValue(new Error("offline"));
		api.writeMemoryOverview.mockResolvedValue(written);
		show();
		await waitFor(() =>
			expect(screen.getByText("A synthetic overview.")).toBeTruthy(),
		);
		expect(
			screen.getByText(/Written just now from your 9 current entries/),
		).toBeTruthy();
	});
});
