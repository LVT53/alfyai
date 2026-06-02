import { describe, expect, it, vi } from "vitest";
import {
	markServerUpdateRefreshRequested,
	readServerUpdateRefreshSuppressedUntil,
	SERVER_UPDATE_REFRESH_SUPPRESSION_KEY,
	SERVER_UPDATE_REFRESH_SUPPRESSION_MS,
} from "./server-update-notice";

function createStorage(initialValue?: string) {
	const values = new Map<string, string>();
	if (initialValue !== undefined) {
		values.set(SERVER_UPDATE_REFRESH_SUPPRESSION_KEY, initialValue);
	}
	return {
		getItem: vi.fn((key: string) => values.get(key) ?? null),
		removeItem: vi.fn((key: string) => {
			values.delete(key);
		}),
		setItem: vi.fn((key: string, value: string) => {
			values.set(key, value);
		}),
	};
}

describe("server update notice refresh suppression", () => {
	it("marks a short suppression window before reloading for an update", () => {
		const storage = createStorage();
		const suppressedUntil = markServerUpdateRefreshRequested(
			storage,
			() => 1000,
		);

		expect(suppressedUntil).toBe(1000 + SERVER_UPDATE_REFRESH_SUPPRESSION_MS);
		expect(storage.setItem).toHaveBeenCalledWith(
			SERVER_UPDATE_REFRESH_SUPPRESSION_KEY,
			String(suppressedUntil),
		);
	});

	it("keeps a recent refresh suppression window active across reloads", () => {
		const storage = createStorage("61000");

		expect(readServerUpdateRefreshSuppressedUntil(storage, () => 2000)).toBe(
			61000,
		);
		expect(storage.removeItem).not.toHaveBeenCalled();
	});

	it("clears expired or invalid suppression state", () => {
		const expiredStorage = createStorage("61000");
		const invalidStorage = createStorage("not-a-number");

		expect(
			readServerUpdateRefreshSuppressedUntil(expiredStorage, () => 62000),
		).toBe(0);
		expect(
			readServerUpdateRefreshSuppressedUntil(invalidStorage, () => 1000),
		).toBe(0);
		expect(expiredStorage.removeItem).toHaveBeenCalledWith(
			SERVER_UPDATE_REFRESH_SUPPRESSION_KEY,
		);
		expect(invalidStorage.removeItem).toHaveBeenCalledWith(
			SERVER_UPDATE_REFRESH_SUPPRESSION_KEY,
		);
	});
});
