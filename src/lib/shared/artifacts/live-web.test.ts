import { describe, expect, it } from "vitest";
import {
	isCanvasWebFailure,
	isLiveWebStale,
	LIVEWEB_FRESH_MS,
} from "./live-web";

describe("isLiveWebStale", () => {
	const now = Date.UTC(2026, 8, 30, 12, 0, 0);

	it("holds a snapshot live for its window, and calls it not live once the window has passed", () => {
		expect(isLiveWebStale(now, now)).toBe(false);
		expect(isLiveWebStale(now - LIVEWEB_FRESH_MS, now)).toBe(false);
		expect(isLiveWebStale(now - LIVEWEB_FRESH_MS - 1, now)).toBe(true);
		expect(isLiveWebStale(now - 26 * 60 * 60 * 1000, now)).toBe(true);
	});

	it("does not call a snapshot from a clock a little ahead of ours stale, and does call one with no readable time stale", () => {
		expect(isLiveWebStale(now + 5 * 60 * 1000, now)).toBe(false);
		expect(isLiveWebStale(Number.NaN, now)).toBe(true);
		expect(isLiveWebStale(Number.POSITIVE_INFINITY, now)).toBe(true);
	});

	it("reads the window as an hour, the age past which a search's answer is no longer what the web says", () => {
		expect(LIVEWEB_FRESH_MS).toBe(60 * 60 * 1000);
	});
});

describe("isCanvasWebFailure", () => {
	it("knows the reasons a web read answers with, and nothing else", () => {
		for (const reason of [
			"not_found",
			"not_refreshable",
			"refresh_failed",
			"no_results",
			"invalid_query",
			"rate_limited",
		]) {
			expect(isCanvasWebFailure(reason), reason).toBe(true);
		}
		for (const reason of [
			"version_conflict",
			"",
			"toString",
			4,
			null,
			undefined,
		]) {
			expect(isCanvasWebFailure(reason), String(reason)).toBe(false);
		}
	});
});
