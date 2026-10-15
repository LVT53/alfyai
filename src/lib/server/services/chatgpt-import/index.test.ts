import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChatGptImportTestHarness } from "./index.test-helpers";
import type { ParsedMessage, ParseResult } from "./parser";

let dbPath: string;

vi.mock("./parser", async () => {
	const actual = await vi.importActual<typeof import("./parser")>("./parser");
	return {
		...actual,
		parseConversationsJson: vi.fn(),
	};
});

vi.mock("./embeddings", () => ({
	generateImportEmbeddings: vi.fn(async () => undefined),
}));

// A summary is a model call that outlives the request; here it never finishes,
// as a restart would leave it.
vi.mock("./summarizer", () => ({
	summarizeAndStoreConversation: vi.fn(() => new Promise<void>(() => {})),
}));
type ChatGptImportTestHarness = ReturnType<
	typeof createChatGptImportTestHarness
>;
type RunImportOptions = Parameters<
	ChatGptImportTestHarness["runImportConversations"]
>[0];

let harness: ChatGptImportTestHarness;

async function runImport(options: RunImportOptions = {}) {
	return harness.runImportConversations(options);
}

describe("importConversations", () => {
	beforeEach(async () => {
		dbPath = `/tmp/alfyai-chatgpt-import-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
		vi.clearAllMocks();
		harness = createChatGptImportTestHarness(dbPath);
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

	it("imports a single conversation with messages", async () => {
		harness.seedUser();
		const parsed = harness.makeParsedConversation();
		const result = await runImport({ conversations: [parsed] });

		expect(result.conversationIds).toHaveLength(1);
		expect(result.errors).toHaveLength(0);
		expect(result.jobId).toEqual(expect.any(String));

		const job = harness.readImportJob(result.jobId);
		expect(job?.status).toBe("completed");
		expect(job?.totalConversations).toBe(1);
		expect(job?.processedConversations).toBe(1);

		const convId = result.conversationIds[0];
		const msgs = harness.readMessages(convId);
		expect(msgs).toHaveLength(3);
		expect(msgs[0].messageSequence).toBe(1);
		expect(msgs[0].role).toBe("user");
		expect(msgs[0].content).toBe("Hello");
		expect(msgs[0].importSource).toBe("chatgpt");
		expect(msgs[1].messageSequence).toBe(2);
		expect(msgs[2].messageSequence).toBe(3);
	});

	it("imports multiple conversations", async () => {
		harness.seedUser();
		const parsed1 = harness.makeParsedConversation({ title: "First" });
		const parsed2 = harness.makeParsedConversation({ title: "Second" });
		const result = await runImport({ conversations: [parsed1, parsed2] });

		expect(result.conversationIds).toHaveLength(2);
		expect(result.errors).toHaveLength(0);

		const job = harness.readImportJob(result.jobId);
		expect(job?.totalConversations).toBe(2);
		expect(job?.processedConversations).toBe(2);
	});

	it("assigns conversations to a project when projectId is provided", async () => {
		harness.seedUser();
		harness.seedProject("test-user", "proj-1", "Import Project");
		const parsed = harness.makeParsedConversation();
		const result = await runImport({
			conversations: [parsed],
			importOptions: {
				projectId: "proj-1",
			},
		});

		expect(result.conversationIds).toHaveLength(1);
		expect(result.errors).toHaveLength(0);

		const conv = harness.readConversation(result.conversationIds[0]);
		expect(conv?.projectId).toBe("proj-1");
	});

	it("rejects projectId values not owned by the importing user", async () => {
		harness.seedUser();
		harness.seedUser("other-user", "other@example.com");
		harness.seedProject("other-user", "proj-other", "Other User Project");

		const { parseConversationsJson } = await import("./parser");
		const { ChatGptImportProjectAccessError, importConversations } =
			await import("./index");

		await expect(
			importConversations("test-user", Buffer.from("fake-zip"), {
				projectId: "proj-other",
			}),
		).rejects.toBeInstanceOf(ChatGptImportProjectAccessError);
		expect(parseConversationsJson).not.toHaveBeenCalled();
	});

	it("preserves original ChatGPT timestamps on messages", async () => {
		harness.seedUser();
		const parsed = harness.makeParsedConversation({
			messages: [
				{
					role: "user",
					content: "Test",
					createdAt: new Date("2023-06-15T08:00:00Z"),
				},
			],
		});
		const result = await runImport({ conversations: [parsed] });
		const msgs = harness.readMessages(result.conversationIds[0]);

		expect(msgs[0].createdAt).toEqual(new Date("2023-06-15T08:00:00Z"));
	});

	it("uses current time when message has no createdAt", async () => {
		harness.seedUser();
		const before = new Date();
		const parsed = harness.makeParsedConversation({
			messages: [{ role: "user", content: "No timestamp" }],
		});
		const result = await runImport({ conversations: [parsed] });
		const after = new Date();

		const msgs = harness.readMessages(result.conversationIds[0]);
		expect(msgs[0].createdAt?.getTime()).toBeGreaterThanOrEqual(
			before.getTime() - 1000,
		);
		expect(msgs[0].createdAt?.getTime()).toBeLessThanOrEqual(
			after.getTime() + 1000,
		);
	});

	it("calls onProgress callback for each conversation", async () => {
		harness.seedUser();
		const parsed1 = harness.makeParsedConversation({ title: "A" });
		const parsed2 = harness.makeParsedConversation({ title: "B" });
		const parsed3 = harness.makeParsedConversation({ title: "C" });
		const progressCalls: { processed: number; total: number }[] = [];
		await runImport({
			conversations: [parsed1, parsed2, parsed3],
			importOptions: {
				onProgress: (processed, total) =>
					progressCalls.push({ processed, total }),
			},
		});

		expect(progressCalls).toEqual([
			{ processed: 1, total: 3 },
			{ processed: 2, total: 3 },
			{ processed: 3, total: 3 },
		]);
	});

	it("handles parser errors gracefully", async () => {
		harness.seedUser();
		const result = await runImport({
			zipName: "corrupt",
			parseError: new Error("Invalid ZIP format"),
		});

		expect(result.conversationIds).toHaveLength(0);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].reason).toContain("Invalid ZIP format");

		const job = harness.readImportJob(result.jobId);
		expect(job?.status).toBe("failed");
		expect(job?.errorLog).toContain("Invalid ZIP format");
	});

	it("marks its row failed, in plain words, when it throws after starting", async () => {
		harness.seedUser();

		await expect(
			runImport({
				conversations: [harness.makeParsedConversation()],
				importOptions: {
					onProgress: () => {
						throw new Error("disk full");
					},
				},
			}),
		).rejects.toThrow("disk full");

		const [job] = harness.readImportJobsForUser();
		expect(job).toMatchObject({
			status: "failed",
			errorLog: "Import failed: disk full",
		});
	});

	it("returns parser-level errors alongside successful conversations", async () => {
		harness.seedUser();
		const parsed = harness.makeParsedConversation({ title: "Valid" });
		const result = await runImport({
			conversations: [parsed],
			errors: [
				{ rawId: "bad-id", rawTitle: "Bad Conv", reason: "No messages" },
			],
		});

		expect(result.conversationIds).toHaveLength(1);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].conversationTitle).toBe("Bad Conv");
		expect(result.errors[0].reason).toBe("No messages");
	});

	it("handles empty conversations result", async () => {
		harness.seedUser();
		const result = await runImport({ zipName: "empty-zip" });

		expect(result.conversationIds).toHaveLength(0);
		expect(result.errors).toHaveLength(0);

		const job = harness.readImportJob(result.jobId);
		expect(job?.status).toBe("completed");
		expect(job?.totalConversations).toBe(0);
	});

	it("continues processing remaining conversations when one fails", async () => {
		harness.seedUser();
		const parsed1 = harness.makeParsedConversation({ title: "Valid" });
		const parsed2 = harness.makeParsedConversation({ title: "Also Valid" });
		const result = await runImport({ conversations: [parsed1, parsed2] });

		expect(result.conversationIds).toHaveLength(2);
		expect(result.errors).toHaveLength(0);
	});

	it("uses 'Imported Conversation' as fallback title when conversation has no title", async () => {
		harness.seedUser();
		const parsed = harness.makeParsedConversation({ title: "" });
		const result = await runImport({ conversations: [parsed] });

		expect(result.conversationIds).toHaveLength(1);

		const conv = harness.readConversation(result.conversationIds[0]);
		expect(conv?.title).toBe("Imported Conversation");
	});

	it("sets importSource on all messages", async () => {
		harness.seedUser();
		const parsed = harness.makeParsedConversation({
			messages: [
				{ role: "user", content: "Q1" },
				{ role: "assistant", content: "A1" },
				{ role: "user", content: "Q2" },
				{ role: "assistant", content: "A2" },
			],
		});
		const result = await runImport({ conversations: [parsed] });
		const msgs = harness.readMessages(result.conversationIds[0]);

		expect(msgs).toHaveLength(4);
		for (const msg of msgs) {
			expect(msg.importSource).toBe("chatgpt");
		}
	});

	it("sets correct message sequence numbers starting from 1", async () => {
		harness.seedUser();
		const parsed = harness.makeParsedConversation({
			messages: [
				{ role: "user", content: "First" },
				{ role: "assistant", content: "Second" },
				{ role: "user", content: "Third" },
			],
		});
		const result = await runImport({ conversations: [parsed] });
		const msgs = harness.readMessages(result.conversationIds[0]);

		expect(msgs[0].messageSequence).toBe(1);
		expect(msgs[1].messageSequence).toBe(2);
		expect(msgs[2].messageSequence).toBe(3);
	});

	it("creates a new import job for each import call", async () => {
		harness.seedUser();
		const parsed = harness.makeParsedConversation();
		const result1 = await runImport({
			conversations: [parsed],
			zipName: "zip1",
		});
		const result2 = await runImport({
			conversations: [parsed],
			zipName: "zip2",
		});

		expect(result1.jobId).not.toBe(result2.jobId);

		const job1 = harness.readImportJob(result1.jobId);
		const job2 = harness.readImportJob(result2.jobId);
		expect(job1).toBeTruthy();
		expect(job2).toBeTruthy();
		expect(job1?.id).not.toBe(job2?.id);
	});

	it("creates a fork conversation for each detected branch", async () => {
		harness.seedUser();
		const branchMessages: ParsedMessage[] = [
			{
				role: "user",
				content: "Hello",
				createdAt: new Date("2024-01-15T12:00:00Z"),
			},
			{
				role: "assistant",
				content: "Alternative response",
				createdAt: new Date("2024-01-15T12:00:05Z"),
			},
		];
		const parsed = harness.makeParsedConversation({
			branches: [
				harness.makeBranch("div-n1", "branch-n1", 0.5, branchMessages),
			],
		});

		const result = await runImport({ conversations: [parsed] });

		expect(result.conversationIds).toHaveLength(1);
		expect(result.errors).toHaveLength(0);

		const primaryMsgs = harness.readMessages(result.conversationIds[0]);
		expect(primaryMsgs).toHaveLength(3);
		expect(primaryMsgs[0].content).toBe("Hello");
		expect(primaryMsgs[1].content).toBe("Hi there!");

		const forks = harness.readForks(result.conversationIds[0]);
		expect(forks).toHaveLength(1);
		expect(forks[0].forkSequence).toBe(1);
		expect(forks[0].sourceTitle).toBe("Test Conversation");
		expect(forks[0].sourceConversationIdSnapshot).toBe(
			result.conversationIds[0],
		);

		const forkMsgs = harness.readMessages(forks[0].forkConversationId);
		expect(forkMsgs).toHaveLength(2);
		expect(forkMsgs[0].content).toBe("Hello");
		expect(forkMsgs[0].importSource).toBe("chatgpt");
		expect(forkMsgs[1].content).toBe("Alternative response");
		expect(forkMsgs[1].importSource).toBe("chatgpt");
	});

	it("sets fork point to the last shared message", async () => {
		harness.seedUser();
		const branchMessages: ParsedMessage[] = [
			{
				role: "user",
				content: "Hello",
				createdAt: new Date("2024-01-15T12:00:00Z"),
			},
			{
				role: "assistant",
				content: "Branch-only reply",
				createdAt: new Date("2024-01-15T12:00:05Z"),
			},
		];
		const parsed = harness.makeParsedConversation({
			messages: [
				{
					role: "user",
					content: "Hello",
					createdAt: new Date("2024-01-15T12:00:00Z"),
				},
				{
					role: "assistant",
					content: "Primary reply",
					createdAt: new Date("2024-01-15T12:00:05Z"),
				},
				{
					role: "user",
					content: "Follow-up",
					createdAt: new Date("2024-01-15T12:01:00Z"),
				},
			],
			branches: [
				harness.makeBranch("div-n1", "branch-n1", 0.5, branchMessages),
			],
		});

		const result = await runImport({ conversations: [parsed] });
		const forks = harness.readForks(result.conversationIds[0]);
		expect(forks).toHaveLength(1);

		const forkMsgs = harness.readMessages(forks[0].forkConversationId);
		const forkPointMsg = forkMsgs.find(
			(m) => m.id === forks[0].copiedForkPointMessageId,
		);
		expect(forkPointMsg).toBeTruthy();
		expect(forkPointMsg?.content).toBe("Hello");
		expect(forkPointMsg?.role).toBe("user");
	});

	it("creates multiple forks from multiple branches", async () => {
		harness.seedUser();
		const branch1Messages: ParsedMessage[] = [
			{ role: "user", content: "Hello", createdAt: new Date() },
			{ role: "assistant", content: "Branch 1 answer", createdAt: new Date() },
		];
		const branch2Messages: ParsedMessage[] = [
			{ role: "user", content: "Hello", createdAt: new Date() },
			{ role: "assistant", content: "Branch 2 answer", createdAt: new Date() },
		];
		const parsed = harness.makeParsedConversation({
			branches: [
				harness.makeBranch("div1", "br1", 0.5, branch1Messages),
				harness.makeBranch("div1", "br2", 0.3, branch2Messages),
			],
		});

		const result = await runImport({ conversations: [parsed] });
		const forks = harness.readForks(result.conversationIds[0]);
		expect(forks).toHaveLength(2);
		expect(forks[0].forkSequence).toBe(1);
		expect(forks[1].forkSequence).toBe(2);

		const fork1Msgs = harness.readMessages(forks[0].forkConversationId);
		expect(fork1Msgs[1].content).toBe("Branch 1 answer");

		const fork2Msgs = harness.readMessages(forks[1].forkConversationId);
		expect(fork2Msgs[1].content).toBe("Branch 2 answer");
	});

	it("does not create forks when there are no branches", async () => {
		harness.seedUser();
		const parsed = harness.makeParsedConversation();
		const result = await runImport({ conversations: [parsed] });

		expect(result.conversationIds).toHaveLength(1);
		const forks = harness.readForks(result.conversationIds[0]);
		expect(forks).toHaveLength(0);
	});

	it("calls generateImportEmbeddings for each imported conversation", async () => {
		harness.seedUser();
		const parsed = harness.makeParsedConversation({
			title: "Embeddable Chat",
			messages: [
				{ role: "user", content: "Q1" },
				{ role: "assistant", content: "A1" },
			],
		});
		const { generateImportEmbeddings } = await import("./embeddings");
		const mockGenerate = vi.mocked(generateImportEmbeddings);

		const result = await runImport({ conversations: [parsed] });

		expect(mockGenerate).toHaveBeenCalledTimes(1);
		expect(mockGenerate).toHaveBeenCalledWith(
			result.conversationIds[0],
			"test-user",
			"Embeddable Chat",
			parsed.messages,
		);
	});

	it("queues every imported conversation for the memory judge before it answers", async () => {
		harness.seedUser();
		const branchMessages: ParsedMessage[] = [
			{ role: "user", content: "Hello" },
			{ role: "assistant", content: "Another answer" },
		];
		const result = await runImport({
			conversations: [
				harness.makeParsedConversation({
					title: "With a fork",
					branches: [
						harness.makeBranch("div-1", "branch-1", 0.5, branchMessages),
					],
				}),
				harness.makeParsedConversation({ title: "Plain" }),
			],
		});

		// The judge reads the messages, not the summary, and its queue row is
		// durable: a summary the restart never let finish keeps no conversation
		// from it. The forks stay out, as before.
		expect(harness.readConversationsQueuedForJudge()).toEqual(
			[...result.conversationIds].sort(),
		);
	});

	describe("one import per person at a time", () => {
		it("refuses a second import while the first is still reading its export", async () => {
			harness.seedUser();
			const { parseConversationsJson } = await import("./parser");
			const { ChatGptImportAlreadyRunningError, importConversations } =
				await import("./index");
			let finishReading: (result: ParseResult) => void = () => {};
			vi.mocked(parseConversationsJson).mockReturnValueOnce(
				new Promise<ParseResult>((resolve) => {
					finishReading = resolve;
				}),
			);

			const first = importConversations("test-user", Buffer.from("first"));
			await vi.waitFor(() =>
				expect(parseConversationsJson).toHaveBeenCalledTimes(1),
			);

			await expect(
				importConversations("test-user", Buffer.from("second")),
			).rejects.toBeInstanceOf(ChatGptImportAlreadyRunningError);
			// The refused import read nothing and left no row of its own.
			expect(parseConversationsJson).toHaveBeenCalledTimes(1);
			expect(harness.readImportJobsForUser()).toHaveLength(1);

			finishReading({
				conversations: [harness.makeParsedConversation()],
				errors: [],
			});
			const result = await first;
			expect(harness.readImportJob(result.jobId)?.status).toBe("completed");

			// Once the first has finished, the next one runs.
			vi.mocked(parseConversationsJson).mockResolvedValueOnce({
				conversations: [harness.makeParsedConversation()],
				errors: [],
			});
			const next = await importConversations("test-user", Buffer.from("next"));
			expect(harness.readImportJob(next.jobId)?.status).toBe("completed");
		});

		it("refuses an import while a row of the person's still says processing", async () => {
			harness.seedUser();
			harness.seedImportJob({ id: "first", status: "processing" });
			const { parseConversationsJson } = await import("./parser");
			const { ChatGptImportAlreadyRunningError } = await import("./index");

			await expect(
				runImport({ conversations: [harness.makeParsedConversation()] }),
			).rejects.toBeInstanceOf(ChatGptImportAlreadyRunningError);
			expect(parseConversationsJson).not.toHaveBeenCalled();
			expect(harness.readImportJobsForUser().map((job) => job.id)).toEqual([
				"first",
			]);
			expect(harness.readImportJob("first")?.status).toBe("processing");
		});

		it("names the words the browser shows for the refusal", async () => {
			const { ChatGptImportAlreadyRunningError } = await import("./index");

			expect(new ChatGptImportAlreadyRunningError().errorKey).toBe(
				"chatgptImport.alreadyRunning",
			);
		});

		it("lets one person import while another person's import runs", async () => {
			harness.seedUser();
			harness.seedUser("other-user", "other@example.com");
			harness.seedImportJob({
				id: "theirs",
				userId: "other-user",
				status: "processing",
			});

			const result = await runImport({
				conversations: [harness.makeParsedConversation()],
			});

			expect(harness.readImportJob(result.jobId)?.status).toBe("completed");
			expect(harness.readImportJob("theirs")?.status).toBe("processing");
		});

		it("settles an import that has written nothing for half an hour, then runs the new one", async () => {
			harness.seedUser();
			harness.seedImportJob({
				id: "gone-quiet",
				status: "processing",
				updatedAt: new Date(Date.now() - 31 * 60_000),
			});
			const { INTERRUPTED_IMPORT_LOG } = await import("./import-row");

			const result = await runImport({
				conversations: [harness.makeParsedConversation()],
			});

			expect(harness.readImportJob("gone-quiet")).toMatchObject({
				status: "failed",
				errorLog: INTERRUPTED_IMPORT_LOG,
			});
			expect(harness.readImportJob(result.jobId)?.status).toBe("completed");
		});

		it("stops an import whose row was settled under it, before its next conversation", async () => {
			harness.seedUser();
			const {
				ChatGptImportInterruptedError,
				INTERRUPTED_IMPORT_LOG,
				settleInterruptedImports,
			} = await import("./import-row");

			await expect(
				runImport({
					conversations: [
						harness.makeParsedConversation({ title: "First" }),
						harness.makeParsedConversation({ title: "Second" }),
					],
					importOptions: {
						onProgress: (processed) => {
							if (processed === 1) settleInterruptedImports();
						},
					},
				}),
			).rejects.toBeInstanceOf(ChatGptImportInterruptedError);

			// The row says what settled it, not what the stopped import thought.
			const [job] = harness.readImportJobsForUser();
			expect(job).toMatchObject({
				status: "failed",
				errorLog: INTERRUPTED_IMPORT_LOG,
			});
			expect(harness.countConversations()).toBe(1);
		});
	});
});
