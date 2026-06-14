import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPrepare = vi.fn();
const mockExec = vi.fn();

vi.mock("./index", () => ({
	sqlite: {
		prepare: mockPrepare,
		exec: mockExec,
	},
}));

describe("ensureRuntimeSchemaCompatibility", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
	});

	it("adds honcho_peer_version when the users table exists without the column", async () => {
		mockPrepare.mockImplementation((query: string) => {
			if (query.includes("sqlite_master")) {
				return {
					get: vi.fn(() => ({ exists: 1 })),
				};
			}

			if (query.includes("PRAGMA table_info")) {
				return {
					all: vi.fn(() => [{ name: "id" }, { name: "email" }]),
				};
			}

			throw new Error(`Unexpected query: ${query}`);
		});

		const { ensureRuntimeSchemaCompatibility } = await import("./compat");

		await ensureRuntimeSchemaCompatibility();
		await ensureRuntimeSchemaCompatibility();

		expect(mockExec).toHaveBeenCalledTimes(2);
		expect(mockExec).toHaveBeenCalledWith(
			"ALTER TABLE users ADD COLUMN honcho_peer_version integer DEFAULT 0 NOT NULL",
		);
		expect(mockExec).toHaveBeenCalledWith(
			"ALTER TABLE users ADD COLUMN ui_language text DEFAULT 'en' NOT NULL",
		);
	});

	it("does nothing when the column already exists", async () => {
		mockPrepare.mockImplementation((query: string) => {
			if (query.includes("sqlite_master")) {
				return {
					get: vi.fn(() => ({ exists: 1 })),
				};
			}

			if (query.includes("PRAGMA table_info")) {
				return {
					all: vi.fn(() => [
						{ name: "id" },
						{ name: "honcho_peer_version" },
						{ name: "ui_language" },
					]),
				};
			}

			throw new Error(`Unexpected query: ${query}`);
		});

		const { ensureRuntimeSchemaCompatibility } = await import("./compat");

		await ensureRuntimeSchemaCompatibility();

		expect(mockExec).not.toHaveBeenCalled();
	});
});
