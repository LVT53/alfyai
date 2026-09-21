// Phase 6 D8 — the inline_text production mode, end to end through the real
// durable ledger.
//
// The point of every case here is that inline_text is not a shortcut around
// the boundary: it is a third source mode inside it. It queues the same job
// row, honours the same idempotency key, obeys the same limits, runs the same
// output validation and reaches the same storage adapter as a program job —
// it just never asks Docker for anything.
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import type { FileInput } from "$lib/server/services/chat-files";
import type { StoreGeneratedFileDependency } from "./storage-adapter";

let dbPath: string;

const NOW = new Date("2026-09-21T09:00:00.000Z");

const MARKDOWN = [
	"# Quarterly summary",
	"",
	"Revenue grew 12% quarter over quarter.",
	"",
	"| Region | Revenue |",
	"|---|---|",
	"| North | €24.25 |",
	"",
	"```python",
	"print('kept verbatim')",
	"```",
].join("\n");

function seedDatabase() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });

	db.insert(schema.users)
		.values({ id: "user-1", email: "user@example.com", passwordHash: "hash" })
		.run();
	db.insert(schema.conversations)
		.values({
			id: "conv-1",
			userId: "user-1",
			title: "Inline text conversation",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	db.insert(schema.messages)
		.values({
			id: "assistant-1",
			conversationId: "conv-1",
			role: "assistant",
			content: "Here is the file.",
			createdAt: NOW,
		})
		.run();

	sqlite.close();
}

/**
 * Captures what reached storage AND stands in for the real chat-file writer,
 * so a case can assert the exact bytes without touching the filesystem.
 */
function makeStoreGeneratedFile() {
	const stored: Array<{
		filename: string;
		mimeType: string | null;
		content: Buffer;
	}> = [];
	let counter = 0;
	const storeGeneratedFile: StoreGeneratedFileDependency = vi.fn(
		async (conversationId: string, userId: string, file: FileInput) => {
			counter += 1;
			const id = `file-inline-${counter}`;
			const content = Buffer.isBuffer(file.content)
				? file.content
				: Buffer.from(file.content);
			stored.push({
				filename: file.filename,
				mimeType: file.mimeType ?? null,
				content,
			});
			const { db } = await import("$lib/server/db");
			await db.insert(schema.chatGeneratedFiles).values({
				id,
				conversationId,
				assistantMessageId: file.assistantMessageId ?? null,
				userId,
				filename: file.filename,
				mimeType: file.mimeType ?? null,
				sizeBytes: content.length,
				storagePath: `${conversationId}/${id}`,
				createdAt: NOW,
			});
			return {
				id,
				conversationId,
				assistantMessageId: file.assistantMessageId ?? null,
				artifactId: null,
				userId,
				filename: file.filename,
				mimeType: file.mimeType ?? null,
				sizeBytes: content.length,
				storagePath: `${conversationId}/${id}`,
				createdAt: NOW.getTime(),
			};
		},
	);
	return { storeGeneratedFile, stored };
}

function inlineBody(overrides: Record<string, unknown> = {}) {
	return {
		conversationId: "conv-1",
		assistantMessageId: "assistant-1",
		idempotencyKey: "turn-1:inline-markdown",
		requestTitle: "Quarterly summary",
		sourceMode: "inline_text",
		documentIntent: "data export",
		inlineText: {
			content: MARKDOWN,
			files: [{ filename: "quarterly-summary.md", outputType: "md" }],
		},
		...overrides,
	};
}

describe("inline_text production mode", () => {
	beforeEach(async () => {
		dbPath = `/tmp/alfyai-inline-text-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
		seedDatabase();
	});

	afterEach(async () => {
		try {
			const { sqlite } = await import("$lib/server/db");
			sqlite.close();
		} catch {
			// The DB module may not have been imported if a test failed early.
		}
		try {
			unlinkSync(dbPath);
		} catch {
			// Temporary DB cleanup is best-effort.
		}
	});

	it("queues an inline_text job and persists the mode and the content", async () => {
		const { db } = await import("$lib/server/db");
		const { submitFileProductionIntake } = await import("./index");
		const wakeWorker = vi.fn();

		const result = await submitFileProductionIntake({
			userId: "user-1",
			body: inlineBody(),
			wakeWorker,
			now: NOW,
		});

		expect(result).toMatchObject({
			ok: true,
			status: 202,
			job: { conversationId: "conv-1", status: "queued", files: [] },
		});
		if (!result.ok) throw new Error("expected inline_text intake to succeed");
		expect(wakeWorker).toHaveBeenCalledTimes(1);

		const [row] = await db
			.select({
				sourceMode: schema.fileProductionJobs.sourceMode,
				requestJson: schema.fileProductionJobs.requestJson,
			})
			.from(schema.fileProductionJobs)
			.where(eq(schema.fileProductionJobs.id, result.job.id));

		// A plain text column with no CHECK constraint: the new mode needs no
		// migration.
		expect(row.sourceMode).toBe("inline_text");
		expect(JSON.parse(row.requestJson ?? "{}")).toMatchObject({
			sourceMode: "inline_text",
			outputs: [{ type: "md" }],
			program: null,
			documentSource: null,
			inlineText: {
				content: MARKDOWN,
				files: [{ filename: "quarterly-summary.md", outputType: "md" }],
			},
		});
	});

	it("writes the content byte for byte, with no container and no sandbox call", async () => {
		const { submitFileProductionIntake, executeNextFileProductionJob } =
			await import("./index");
		const { storeGeneratedFile, stored } = makeStoreGeneratedFile();
		const executeCode = vi.fn();

		await submitFileProductionIntake({
			userId: "user-1",
			body: inlineBody(),
			wakeWorker: vi.fn(),
			now: NOW,
		});

		const result = await executeNextFileProductionJob({
			workerId: "worker-inline",
			executeCode,
			storeGeneratedFile,
			syncGeneratedFilesToMemory: vi.fn(async () => undefined),
			now: NOW,
		});

		expect(result).toMatchObject({
			job: { status: "succeeded" },
			files: [
				expect.objectContaining({
					filename: "quarterly-summary.md",
					mimeType: "text/markdown",
				}),
			],
		});
		// The whole point of D8: no program ever ran.
		expect(executeCode).not.toHaveBeenCalled();
		expect(stored).toHaveLength(1);
		// Byte-for-byte with what `buildTextFileProgram`'s Python `write_text`
		// used to put in the container's /output.
		expect(stored[0].content.equals(Buffer.from(MARKDOWN, "utf8"))).toBe(true);
		expect(stored[0].content.toString("utf8")).toBe(MARKDOWN);
	});

	it("carries CRLF and a trailing newline through untouched", async () => {
		const { submitFileProductionIntake, executeNextFileProductionJob } =
			await import("./index");
		const { storeGeneratedFile, stored } = makeStoreGeneratedFile();
		const content = "alpha\r\nbravo\r\n\r\ncharlie\n";

		await submitFileProductionIntake({
			userId: "user-1",
			body: inlineBody({
				inlineText: {
					content,
					files: [{ filename: "log.txt", outputType: "txt" }],
				},
			}),
			wakeWorker: vi.fn(),
			now: NOW,
		});
		await executeNextFileProductionJob({
			workerId: "worker-inline-crlf",
			storeGeneratedFile,
			syncGeneratedFilesToMemory: vi.fn(async () => undefined),
			now: NOW,
		});

		expect(stored[0].content.toString("utf8")).toBe(content);
	});

	it("produces a tsv output, new in Phase 6", async () => {
		const { submitFileProductionIntake, executeNextFileProductionJob } =
			await import("./index");
		const { storeGeneratedFile, stored } = makeStoreGeneratedFile();
		const content = "region\trevenue\nNorth\t24.25\nSouth\t25.75\n";

		await submitFileProductionIntake({
			userId: "user-1",
			body: inlineBody({
				idempotencyKey: "turn-1:inline-tsv",
				inlineText: {
					content,
					files: [{ filename: "quarterly-summary.tsv", outputType: "tsv" }],
				},
			}),
			wakeWorker: vi.fn(),
			now: NOW,
		});
		const result = await executeNextFileProductionJob({
			workerId: "worker-inline-tsv",
			storeGeneratedFile,
			syncGeneratedFilesToMemory: vi.fn(async () => undefined),
			now: NOW,
		});

		expect(result).toMatchObject({ job: { status: "succeeded" } });
		expect(stored[0]).toMatchObject({
			filename: "quarterly-summary.tsv",
			mimeType: "text/tab-separated-values",
		});
		expect(stored[0].content.toString("utf8")).toBe(content);
	});

	it("writes one file per requested output and links them under one job", async () => {
		const { db } = await import("$lib/server/db");
		const { submitFileProductionIntake, executeNextFileProductionJob } =
			await import("./index");
		const { storeGeneratedFile, stored } = makeStoreGeneratedFile();

		const intake = await submitFileProductionIntake({
			userId: "user-1",
			body: inlineBody({
				idempotencyKey: "turn-1:inline-two",
				inlineText: {
					content: MARKDOWN,
					files: [
						{ filename: "quarterly-summary.md", outputType: "md" },
						{ filename: "quarterly-summary.txt", outputType: "txt" },
					],
				},
			}),
			wakeWorker: vi.fn(),
			now: NOW,
		});
		if (!intake.ok) throw new Error("expected intake to succeed");

		await executeNextFileProductionJob({
			workerId: "worker-inline-two",
			storeGeneratedFile,
			syncGeneratedFilesToMemory: vi.fn(async () => undefined),
			now: NOW,
		});

		expect(stored.map((file) => file.filename)).toEqual([
			"quarterly-summary.md",
			"quarterly-summary.txt",
		]);
		expect(stored[0].content.toString("utf8")).toBe(MARKDOWN);
		expect(stored[1].content.toString("utf8")).toBe(MARKDOWN);
		const links = await db
			.select()
			.from(schema.fileProductionJobFiles)
			.where(eq(schema.fileProductionJobFiles.jobId, intake.job.id));
		expect(links).toHaveLength(2);
	});

	it("reuses one job for a repeated idempotency key", async () => {
		const { db } = await import("$lib/server/db");
		const { submitFileProductionIntake } = await import("./index");

		const first = await submitFileProductionIntake({
			userId: "user-1",
			body: inlineBody(),
			wakeWorker: vi.fn(),
			now: NOW,
		});
		const second = await submitFileProductionIntake({
			userId: "user-1",
			body: inlineBody(),
			wakeWorker: vi.fn(),
			now: new Date(NOW.getTime() + 1000),
		});

		expect(first.job?.id).toBe(second.job?.id);
		expect(second).toMatchObject({ ok: true, reused: true });
		const rows = await db
			.select()
			.from(schema.fileProductionJobs)
			.where(
				eq(schema.fileProductionJobs.idempotencyKey, "turn-1:inline-markdown"),
			);
		expect(rows).toHaveLength(1);
	});

	it("re-runs the same persisted bytes on retry", async () => {
		const { submitFileProductionIntake, executeNextFileProductionJob } =
			await import("./index");
		const first = makeStoreGeneratedFile();

		const intake = await submitFileProductionIntake({
			userId: "user-1",
			body: inlineBody(),
			wakeWorker: vi.fn(),
			now: NOW,
		});
		if (!intake.ok) throw new Error("expected intake to succeed");

		await executeNextFileProductionJob({
			workerId: "worker-retry-1",
			storeGeneratedFile: first.storeGeneratedFile,
			syncGeneratedFilesToMemory: vi.fn(async () => undefined),
			now: NOW,
		});

		// Resubmitting the identical request replays the verdict rather than
		// producing a second file: one user request, one card.
		const replay = await submitFileProductionIntake({
			userId: "user-1",
			body: inlineBody(),
			wakeWorker: vi.fn(),
			now: new Date(NOW.getTime() + 2000),
		});
		expect(replay).toMatchObject({
			ok: true,
			reused: true,
			job: { id: intake.job.id, status: "succeeded" },
		});
		expect(first.stored).toHaveLength(1);
	});

	it("cancels a queued inline_text job without producing anything", async () => {
		const {
			submitFileProductionIntake,
			cancelFileProductionJob,
			executeNextFileProductionJob,
		} = await import("./index");
		const { storeGeneratedFile, stored } = makeStoreGeneratedFile();

		const intake = await submitFileProductionIntake({
			userId: "user-1",
			body: inlineBody(),
			wakeWorker: vi.fn(),
			now: NOW,
		});
		if (!intake.ok) throw new Error("expected intake to succeed");

		const cancelled = await cancelFileProductionJob({
			userId: "user-1",
			jobId: intake.job.id,
			now: new Date(NOW.getTime() + 500),
		});
		expect(cancelled?.status).toBe("cancelled");

		const result = await executeNextFileProductionJob({
			workerId: "worker-cancelled",
			storeGeneratedFile,
			now: new Date(NOW.getTime() + 1000),
		});
		expect(result).toBeNull();
		expect(stored).toHaveLength(0);
	});

	describe("refusals", () => {
		async function submit(body: Record<string, unknown>) {
			const { submitFileProductionIntake } = await import("./index");
			return submitFileProductionIntake({
				userId: "user-1",
				body,
				wakeWorker: vi.fn(),
				now: NOW,
			});
		}

		it("refuses a binary output type before any job runs", async () => {
			for (const outputType of ["pdf", "docx", "html", "xlsx", "zip"]) {
				const result = await submit(
					inlineBody({
						idempotencyKey: `turn-1:inline-${outputType}`,
						inlineText: {
							content: MARKDOWN,
							files: [{ filename: `report.${outputType}`, outputType }],
						},
					}),
				);
				expect(result, outputType).toMatchObject({
					ok: false,
					status: 422,
					code: "unsupported_inline_text_output_type",
				});
			}
		});

		it("refuses a filename whose extension does not match its output type", async () => {
			const result = await submit(
				inlineBody({
					inlineText: {
						content: MARKDOWN,
						files: [{ filename: "report.pdf", outputType: "md" }],
					},
				}),
			);

			expect(result).toMatchObject({
				ok: false,
				status: 422,
				code: "invalid_inline_text_request",
			});
			if (result.ok) throw new Error("expected a refusal");
			expect(result.error).toContain("must produce a .md file");
		});

		it.each([
			["a path separator", "reports/summary.md"],
			["a parent traversal", "../summary.md"],
			["a windows separator", "reports\\summary.md"],
			["a dotfile", ".summary.md"],
		])("refuses %s in a filename", async (_label, filename) => {
			const result = await submit(
				inlineBody({
					inlineText: {
						content: MARKDOWN,
						files: [{ filename, outputType: "md" }],
					},
				}),
			);
			expect(result).toMatchObject({
				ok: false,
				status: 422,
				code: "invalid_inline_text_request",
			});
		});

		it("refuses empty content", async () => {
			const result = await submit(
				inlineBody({
					inlineText: {
						content: "",
						files: [{ filename: "summary.md", outputType: "md" }],
					},
				}),
			);
			expect(result).toMatchObject({
				ok: false,
				status: 422,
				code: "missing_inline_text_content",
			});
		});

		it("refuses the same filename twice in one job", async () => {
			const result = await submit(
				inlineBody({
					inlineText: {
						content: MARKDOWN,
						files: [
							{ filename: "summary.md", outputType: "md" },
							{ filename: "summary.md", outputType: "md" },
						],
					},
				}),
			);
			expect(result).toMatchObject({
				ok: false,
				status: 422,
				code: "invalid_inline_text_request",
			});
		});

		it("applies the static output-count limit to the files it would write", async () => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			const result = await submit(
				inlineBody({
					inlineText: {
						content: MARKDOWN,
						files: ["md", "txt", "csv", "tsv", "json", "xml"].map((type) => ({
							filename: `summary.${type}`,
							outputType: type,
						})),
					},
				}),
			);
			expect(result).toMatchObject({
				ok: false,
				status: 422,
				code: "too_many_outputs",
				job: { status: "failed" },
			});
			warnSpy.mockRestore();
		});

		it("applies the static source-size limit to very large text", async () => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			const result = await submit(
				inlineBody({
					inlineText: {
						// maxSourceJsonBytes defaults to 2 MiB and the content rides
						// inside the persisted request JSON.
						content: "x".repeat(3 * 1024 * 1024),
						files: [{ filename: "summary.md", outputType: "md" }],
					},
				}),
			);
			expect(result).toMatchObject({
				ok: false,
				status: 422,
				code: "source_too_large",
				job: { status: "failed" },
			});
			warnSpy.mockRestore();
		});

		it("accepts text that sits just under the source limit", async () => {
			const result = await submit(
				inlineBody({
					inlineText: {
						content: "x".repeat(1_900_000),
						files: [{ filename: "summary.md", outputType: "md" }],
					},
				}),
			);
			expect(result).toMatchObject({ ok: true, status: 202 });
		});

		it("fails a job whose content carries a NUL byte, at the same validation the sandbox path uses", async () => {
			const { submitFileProductionIntake, executeNextFileProductionJob } =
				await import("./index");
			const { listConversationFileProductionJobs } = await import("./index");
			const { storeGeneratedFile, stored } = makeStoreGeneratedFile();

			const intake = await submitFileProductionIntake({
				userId: "user-1",
				body: inlineBody({
					inlineText: {
						content: `alpha bravo${MARKDOWN}`,
						files: [{ filename: "summary.md", outputType: "md" }],
					},
				}),
				wakeWorker: vi.fn(),
				now: NOW,
			});
			if (!intake.ok) throw new Error("expected intake to succeed");

			const result = await executeNextFileProductionJob({
				workerId: "worker-nul",
				storeGeneratedFile,
				now: NOW,
			});

			expect(result).toBeNull();
			expect(stored).toHaveLength(0);
			expect(
				(await listConversationFileProductionJobs("user-1", "conv-1")).find(
					(job) => job.id === intake.job.id,
				),
			).toMatchObject({
				status: "failed",
				// Bad bytes are the model's to fix; re-running the identical request
				// cannot help.
				error: { code: "invalid_text_output", retryable: false },
			});
		});
	});
});
