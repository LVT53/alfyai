import { describe, expect, it, vi } from "vitest";
import type { ServerHealth } from "$lib/client/api/health";
import { isServerBeingUpdated } from "./server-update-watch";

const WELL: ServerHealth = { reachable: true, draining: false };

function reads(
	overrides: Partial<Parameters<typeof isServerBeingUpdated>[0]> = {},
) {
	return {
		fetchHealth: vi.fn(async () => WELL),
		checkVersion: vi.fn(async () => false),
		isOffline: vi.fn(() => false),
		...overrides,
	};
}

describe("isServerBeingUpdated", () => {
	it("is no when the server answers, is not draining and runs the version this page has", async () => {
		const r = reads();

		expect(await isServerBeingUpdated(r)).toBe(false);
		expect(r.fetchHealth).toHaveBeenCalledTimes(1);
		expect(r.checkVersion).toHaveBeenCalledTimes(1);
	});

	it("is yes when the server says it is draining, without asking for the version", async () => {
		const r = reads({
			fetchHealth: vi.fn(async () => ({ reachable: true, draining: true })),
		});

		expect(await isServerBeingUpdated(r)).toBe(true);
		expect(r.checkVersion).not.toHaveBeenCalled();
	});

	// During the restart the version file cannot be read either, so "away" has to
	// count by itself.
	it("is yes when the server does not answer", async () => {
		const r = reads({
			fetchHealth: vi.fn(async () => ({ reachable: false, draining: false })),
			checkVersion: vi.fn(async () => false),
		});

		expect(await isServerBeingUpdated(r)).toBe(true);
	});

	it("is yes when a new version is live, though the server is well", async () => {
		const r = reads({ checkVersion: vi.fn(async () => true) });

		expect(await isServerBeingUpdated(r)).toBe(true);
	});

	it("is no when the version cannot be checked and nothing else says so", async () => {
		const r = reads({
			checkVersion: vi.fn(async () => {
				throw new Error("offline");
			}),
		});

		expect(await isServerBeingUpdated(r)).toBe(false);
	});

	// A phone that lost its connection cannot reach the server, and that is not an
	// update.
	it("is no for a browser that reports itself offline, whatever the server would say", async () => {
		const r = reads({
			isOffline: vi.fn(() => true),
			fetchHealth: vi.fn(async () => ({ reachable: false, draining: false })),
		});

		expect(await isServerBeingUpdated(r)).toBe(false);
		expect(r.fetchHealth).not.toHaveBeenCalled();
	});
});
