// A produced file that was deleted (polish G2-A): the chat says so instead of
// showing an empty card, and the job that made it can make it again from the
// request it kept. Real migrated SQLite with foreign keys on, so deleting a
// chat file takes its job link with it exactly as it does in production.
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";
import {
	NOW,
	seedConversation,
	seedUser,
} from "$lib/server/services/artifacts/artifacts.test-helpers";

let memory: InMemoryDatabase;

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

const { listConversationFileProductionJobs } = await import("./read-model");
const { claimNextFileProductionJob, regenerateFileProductionJob } =
	await import("./job-ledger");

const OWNER = "user-owner";
const STRANGER = "user-stranger";
const CONVERSATION = "conv-1";
const MESSAGE = "assistant-1";

function seedJob(
	overrides: Partial<typeof schema.fileProductionJobs.$inferInsert> & {
		id: string;
	},
) {
	memory.db
		.insert(schema.fileProductionJobs)
		.values({
			conversationId: CONVERSATION,
			assistantMessageId: MESSAGE,
			userId: OWNER,
			title: "Trip summary",
			status: "succeeded",
			origin: "produce_file",
			requestJson: JSON.stringify({
				title: "Trip summary",
				markdown: "# Trip",
			}),
			sourceMode: "inline_text",
			createdAt: NOW,
			updatedAt: NOW,
			completedAt: NOW,
			...overrides,
		})
		.run();
}

function seedFileForJob(jobId: string, fileId: string, filename = "Trip.md") {
	memory.db
		.insert(schema.chatGeneratedFiles)
		.values({
			id: fileId,
			conversationId: CONVERSATION,
			assistantMessageId: MESSAGE,
			userId: OWNER,
			filename,
			mimeType: "text/markdown",
			sizeBytes: 10,
			storagePath: `${CONVERSATION}/${filename}`,
			createdAt: NOW,
		})
		.run();
	memory.db
		.insert(schema.fileProductionJobFiles)
		.values({
			id: `link-${fileId}`,
			jobId,
			chatGeneratedFileId: fileId,
			sortOrder: 0,
			createdAt: NOW,
		})
		.run();
}

function deleteFile(fileId: string) {
	memory.db
		.delete(schema.chatGeneratedFiles)
		.where(eq(schema.chatGeneratedFiles.id, fileId))
		.run();
}

function jobRow(jobId: string) {
	return memory.db
		.select()
		.from(schema.fileProductionJobs)
		.where(eq(schema.fileProductionJobs.id, jobId))
		.get();
}

beforeEach(() => {
	memory = createInMemoryDatabase();
	seedUser(memory, OWNER);
	seedUser(memory, STRANGER);
	seedConversation(memory, { id: CONVERSATION, userId: OWNER });
	memory.db
		.insert(schema.messages)
		.values({
			id: MESSAGE,
			conversationId: CONVERSATION,
			role: "assistant",
			content: "Here it is.",
			createdAt: NOW,
		})
		.run();
});

describe("a job whose files were all deleted", () => {
	it("stays in the conversation's list, marked deleted, with a way to make it again when it kept its request", async () => {
		seedJob({ id: "job-1" });
		seedFileForJob("job-1", "file-1");

		const before = await listConversationFileProductionJobs(
			OWNER,
			CONVERSATION,
		);
		expect(before).toHaveLength(1);
		expect(before[0].filesDeleted).toBeUndefined();

		deleteFile("file-1");

		const after = await listConversationFileProductionJobs(OWNER, CONVERSATION);
		expect(after).toHaveLength(1);
		expect(after[0]).toMatchObject({
			id: "job-1",
			status: "succeeded",
			title: "Trip summary",
			files: [],
			filesDeleted: { canRegenerate: true },
		});
	});

	it("says a job with no stored request cannot be made again", async () => {
		seedJob({
			id: "job-legacy",
			origin: "legacy_generated_file",
			requestJson: null,
		});
		seedFileForJob("job-legacy", "file-legacy");
		deleteFile("file-legacy");

		const jobs = await listConversationFileProductionJobs(OWNER, CONVERSATION);

		expect(jobs[0]).toMatchObject({
			id: "job-legacy",
			filesDeleted: { canRegenerate: false },
		});
	});

	it("does not mistake a failed job, or a job that still has a file, for a deleted one", async () => {
		seedJob({
			id: "job-failed",
			status: "failed",
			errorCode: "renderer_timeout",
			errorMessage: "Too slow",
		});
		seedJob({ id: "job-two" });
		seedFileForJob("job-two", "file-a", "A.md");
		seedFileForJob("job-two", "file-b", "B.md");
		deleteFile("file-b");

		const jobs = await listConversationFileProductionJobs(OWNER, CONVERSATION);
		const byId = new Map(jobs.map((job) => [job.id, job]));

		expect(byId.get("job-failed")?.filesDeleted).toBeUndefined();
		expect(byId.get("job-two")?.files.map((file) => file.filename)).toEqual([
			"A.md",
		]);
		expect(byId.get("job-two")?.filesDeleted).toBeUndefined();
	});

	it("is another user's business: nothing of it is listed for a stranger", async () => {
		seedJob({ id: "job-1" });
		seedFileForJob("job-1", "file-1");
		deleteFile("file-1");

		await expect(
			listConversationFileProductionJobs(STRANGER, CONVERSATION),
		).resolves.toEqual([]);
	});
});

describe("regenerateFileProductionJob", () => {
	it("queues the same job again, from the request it kept, once its files are gone", async () => {
		seedJob({ id: "job-1" });
		seedFileForJob("job-1", "file-1");
		deleteFile("file-1");

		const job = await regenerateFileProductionJob({
			userId: OWNER,
			jobId: "job-1",
		});

		expect(job).toMatchObject({ id: "job-1", status: "queued" });
		expect(jobRow("job-1")).toMatchObject({
			status: "queued",
			completedAt: null,
			errorCode: null,
			// The message it belongs to and the request it was made from stay.
			assistantMessageId: MESSAGE,
			requestJson: JSON.stringify({
				title: "Trip summary",
				markdown: "# Trip",
			}),
		});
		// A worker picks it up like any queued job.
		const claimed = await claimNextFileProductionJob({ workerId: "worker-1" });
		expect(claimed?.job.id).toBe("job-1");
	});

	it("refuses while a file of the job still exists — that job has nothing to make again", async () => {
		seedJob({ id: "job-1" });
		seedFileForJob("job-1", "file-1");

		await expect(
			regenerateFileProductionJob({ userId: OWNER, jobId: "job-1" }),
		).resolves.toBeNull();
		expect(jobRow("job-1")?.status).toBe("succeeded");
	});

	it("refuses a job with no stored request, a job that is not finished, another user's job and an unknown one", async () => {
		seedJob({ id: "job-no-request", requestJson: null });
		seedJob({ id: "job-running", status: "running", completedAt: null });
		seedJob({ id: "job-failed", status: "failed" });
		seedJob({ id: "job-1" });

		for (const [userId, jobId] of [
			[OWNER, "job-no-request"],
			[OWNER, "job-running"],
			[OWNER, "job-failed"],
			[STRANGER, "job-1"],
			[OWNER, "no-such-job"],
		] as const) {
			await expect(
				regenerateFileProductionJob({ userId, jobId }),
			).resolves.toBeNull();
		}
		expect(jobRow("job-1")?.status).toBe("succeeded");
		expect(jobRow("job-running")?.status).toBe("running");
	});
});
