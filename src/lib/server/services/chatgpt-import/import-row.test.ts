import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChatGptImportTestHarness } from "./index.test-helpers";

let harness: ReturnType<typeof createChatGptImportTestHarness>;

describe("settleInterruptedImports", () => {
	beforeEach(() => {
		const dbPath = `/tmp/alfyai-chatgpt-import-row-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
		harness = createChatGptImportTestHarness(dbPath);
		harness.seedUser();
		harness.seedUser("other-user", "other@example.com");
	});

	afterEach(async () => {
		try {
			const { sqlite } = await import("$lib/server/db");
			sqlite.close();
		} catch {
			// DB module may not have been imported
		}
		harness.cleanup();
	});

	it("settles every import still processing as failed, saying it was interrupted", async () => {
		harness.seedImportJob({ id: "running-now", status: "processing" });
		harness.seedImportJob({
			id: "running-elsewhere",
			userId: "other-user",
			status: "processing",
			updatedAt: new Date(Date.now() - 5 * 60_000),
			totalConversations: 10,
			processedConversations: 3,
		});

		const { INTERRUPTED_IMPORT_LOG, settleInterruptedImports } = await import(
			"./import-row"
		);

		expect(settleInterruptedImports()).toBe(2);
		expect(harness.readImportJob("running-now")).toMatchObject({
			status: "failed",
			errorLog: INTERRUPTED_IMPORT_LOG,
		});
		// How far it got stays on the row: the conversations it made were kept.
		expect(harness.readImportJob("running-elsewhere")).toMatchObject({
			status: "failed",
			errorLog: INTERRUPTED_IMPORT_LOG,
			totalConversations: 10,
			processedConversations: 3,
		});
	});

	it("leaves finished imports as they are, in both shapes of their log", async () => {
		const completedLog = JSON.stringify([{ reason: "No messages" }]);
		harness.seedImportJob({
			id: "completed",
			status: "completed",
			errorLog: completedLog,
		});
		harness.seedImportJob({
			id: "failed",
			status: "failed",
			errorLog: "Parse error: Invalid ZIP format",
		});

		const { settleInterruptedImports } = await import("./import-row");

		expect(settleInterruptedImports()).toBe(0);
		expect(harness.readImportJob("completed")).toMatchObject({
			status: "completed",
			errorLog: completedLog,
		});
		expect(harness.readImportJob("failed")).toMatchObject({
			status: "failed",
			errorLog: "Parse error: Invalid ZIP format",
		});
	});

	it("says in plain words that the import stopped and what was kept", async () => {
		const { INTERRUPTED_IMPORT_LOG } = await import("./import-row");

		// Free text, the failed row's shape: never mistaken for the JSON array a
		// completed row carries.
		expect(INTERRUPTED_IMPORT_LOG).toMatch(/^Interrupted: /);
		expect(() => JSON.parse(INTERRUPTED_IMPORT_LOG)).toThrow();
		expect(INTERRUPTED_IMPORT_LOG).toContain("kept");
	});
});
