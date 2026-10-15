import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChatGptImportTestHarness } from "./index.test-helpers";

// The model call is the only thing faked: the drain reads and writes the real
// tables.
vi.mock("./summarizer", () => ({
	summarizeConversation: vi.fn(),
}));

let harness: ReturnType<typeof createChatGptImportTestHarness>;

async function loadDrain() {
	const { summarizeConversation } = await import("./summarizer");
	const { startImportedSummaryDrain } = await import("./owed-summaries");
	const summarize = vi.mocked(summarizeConversation);
	summarize.mockImplementation(async (_messages, title) => `About ${title}`);
	return { startImportedSummaryDrain, summarize };
}

describe("startImportedSummaryDrain", () => {
	beforeEach(() => {
		const dbPath = `/tmp/alfyai-owed-summaries-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
		vi.clearAllMocks();
		harness = createChatGptImportTestHarness(dbPath);
		harness.seedUser();
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

	it("writes the summary a restart kept the import from writing", async () => {
		harness.seedImportedConversation({
			id: "imported",
			title: "Trip planning",
			messages: [
				{ role: "user", content: "Plan a trip" },
				{ role: "assistant", content: "Here is a plan" },
			],
		});
		const { startImportedSummaryDrain, summarize } = await loadDrain();

		await startImportedSummaryDrain("test-user");

		expect(summarize).toHaveBeenCalledWith(
			[
				{ role: "user", content: "Plan a trip" },
				{ role: "assistant", content: "Here is a plan" },
			],
			"Trip planning",
		);
		expect(harness.readSummary("imported")).toMatchObject({
			userId: "test-user",
			summary: "About Trip planning",
			source: "chatgpt-import",
		});
	});

	it("summarizes only what an import still owes", async () => {
		harness.seedUser("other-user", "other@example.com");
		harness.seedImportedConversation({ id: "owed", title: "Owed" });
		harness.seedImportedConversation({ id: "summarized", title: "Done" });
		harness.seedSummary("summarized", "Already has one");
		harness.seedImportedConversation({
			id: "own-chat",
			title: "Typed here",
			imported: false,
		});
		harness.seedImportedFork("fork", "owed");
		harness.seedImportedConversation({
			id: "incognito",
			title: "Private",
			incognito: true,
		});
		harness.seedImportedConversation({
			id: "theirs",
			title: "Theirs",
			userId: "other-user",
		});
		const { startImportedSummaryDrain, summarize } = await loadDrain();

		await startImportedSummaryDrain("test-user");

		expect(summarize.mock.calls.map(([, title]) => title)).toEqual(["Owed"]);
		expect(harness.readSummary("summarized")?.summary).toBe("Already has one");
		for (const id of ["own-chat", "fork", "incognito", "theirs"]) {
			expect(harness.readSummary(id)).toBeUndefined();
		}
	});

	it("leaves alone what a Clear Memory forgot, and owes what came after it", async () => {
		harness.seedImportedConversation({
			id: "before-reset",
			title: "Before",
			createdAt: new Date("2026-10-01T10:00:00Z"),
		});
		harness.seedMemoryReset(1, new Date("2026-10-02T10:00:00Z"));
		harness.seedImportedConversation({
			id: "after-reset",
			title: "After",
			createdAt: new Date("2026-10-03T10:00:00Z"),
		});
		const { startImportedSummaryDrain, summarize } = await loadDrain();

		await startImportedSummaryDrain("test-user");

		expect(summarize.mock.calls.map(([, title]) => title)).toEqual(["After"]);
		expect(harness.readSummary("before-reset")).toBeUndefined();
	});

	it("stops, writing nothing, when the person clears their memory meanwhile", async () => {
		harness.seedImportedConversation({ id: "first", title: "First" });
		harness.seedImportedConversation({ id: "second", title: "Second" });
		const { startImportedSummaryDrain, summarize } = await loadDrain();
		summarize.mockImplementationOnce(async (_messages, title) => {
			harness.seedMemoryReset(1, new Date());
			return `About ${title}`;
		});

		await startImportedSummaryDrain("test-user");

		expect(summarize).toHaveBeenCalledTimes(1);
		expect(harness.readSummary("first")).toBeUndefined();
		expect(harness.readSummary("second")).toBeUndefined();
	});

	it("never writes over a summary the conversation got while the model wrote", async () => {
		harness.seedImportedConversation({ id: "imported", title: "Imported" });
		const { startImportedSummaryDrain, summarize } = await loadDrain();
		summarize.mockImplementationOnce(async () => {
			// The person chatted in it, and the turn wrote a fresher summary.
			harness.seedSummary("imported", "From the latest turn");
			return "From the import";
		});

		await startImportedSummaryDrain("test-user");

		expect(harness.readSummary("imported")?.summary).toBe(
			"From the latest turn",
		);
	});

	it("writes nothing for a conversation deleted or turned incognito while the model wrote", async () => {
		harness.seedImportedConversation({ id: "deleted", title: "Deleted" });
		harness.seedImportedConversation({ id: "private", title: "Private" });
		const { startImportedSummaryDrain, summarize } = await loadDrain();
		summarize.mockImplementation(async (_messages, title) => {
			if (title === "Deleted") harness.deleteConversation("deleted");
			if (title === "Private") harness.markIncognito("private");
			return `About ${title}`;
		});

		await startImportedSummaryDrain("test-user");

		expect(summarize).toHaveBeenCalledTimes(2);
		expect(harness.readSummary("deleted")).toBeUndefined();
		expect(harness.readSummary("private")).toBeUndefined();
	});

	it("writes one summary at a time, once, however often it is started", async () => {
		harness.seedImportedConversation({ id: "a", title: "A" });
		harness.seedImportedConversation({ id: "b", title: "B" });
		const { startImportedSummaryDrain, summarize } = await loadDrain();
		let running = 0;
		let mostAtOnce = 0;
		summarize.mockImplementation(async (_messages, title) => {
			running += 1;
			mostAtOnce = Math.max(mostAtOnce, running);
			await new Promise((resolve) => setTimeout(resolve, 5));
			running -= 1;
			return `About ${title}`;
		});

		await Promise.all([
			startImportedSummaryDrain("test-user"),
			startImportedSummaryDrain("test-user"),
		]);

		expect(mostAtOnce).toBe(1);
		expect(summarize.mock.calls.map(([, title]) => title).sort()).toEqual([
			"A",
			"B",
		]);
	});

	it("also writes what an import adds while it runs", async () => {
		harness.seedImportedConversation({ id: "first", title: "First" });
		const { startImportedSummaryDrain, summarize } = await loadDrain();
		let finishFirst: (summary: string) => void = () => {};
		summarize.mockImplementationOnce(
			() =>
				new Promise<string>((resolve) => {
					finishFirst = resolve;
				}),
		);

		const drained = startImportedSummaryDrain("test-user");
		await vi.waitFor(() => expect(summarize).toHaveBeenCalledTimes(1));
		harness.seedImportedConversation({ id: "second", title: "Second" });
		void startImportedSummaryDrain("test-user");
		finishFirst("About First");
		await drained;

		expect(harness.readSummary("first")?.summary).toBe("About First");
		expect(harness.readSummary("second")?.summary).toBe("About Second");
	});

	it("tries a failed summary again after a day, or at once after a restart", async () => {
		harness.seedImportedConversation({ id: "hard", title: "Hard" });
		const first = await loadDrain();
		first.summarize.mockRejectedValue(new Error("model unavailable"));
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		vi.useFakeTimers({ toFake: ["Date"] });

		try {
			await first.startImportedSummaryDrain("test-user");
			await first.startImportedSummaryDrain("test-user");
			expect(first.summarize).toHaveBeenCalledTimes(1);

			vi.setSystemTime(Date.now() + 25 * 60 * 60_000);
			await first.startImportedSummaryDrain("test-user");
			expect(first.summarize).toHaveBeenCalledTimes(2);
			expect(harness.readSummary("hard")).toBeUndefined();

			// A restart forgets what this process tried; the debt is still owed.
			first.summarize.mockClear();
			const { sqlite } = await import("$lib/server/db");
			sqlite.close();
			vi.resetModules();
			const restarted = await loadDrain();
			await restarted.startImportedSummaryDrain("test-user");
			expect(restarted.summarize).toHaveBeenCalledTimes(1);
			expect(harness.readSummary("hard")?.summary).toBe("About Hard");
		} finally {
			vi.useRealTimers();
			consoleError.mockRestore();
		}
	});
});
