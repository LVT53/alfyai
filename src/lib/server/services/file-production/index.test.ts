import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

let dbPath: string;
const XLSX_MIME_TYPE =
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

async function seedLegacyGeneratedFile() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });

	const now = new Date("2026-05-03T19:30:00.000Z");
	db.insert(schema.users)
		.values({
			id: "user-1",
			email: "user@example.com",
			passwordHash: "hash",
		})
		.run();
	db.insert(schema.conversations)
		.values({
			id: "conv-1",
			userId: "user-1",
			title: "Report conversation",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.messages)
		.values({
			id: "assistant-1",
			conversationId: "conv-1",
			role: "assistant",
			content: "Here is the report.",
			createdAt: now,
		})
		.run();
	db.insert(schema.chatGeneratedFiles)
		.values({
			id: "file-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			userId: "user-1",
			filename: "report.pdf",
			mimeType: "application/pdf",
			sizeBytes: 2048,
			storagePath: "conv-1/file-1.pdf",
			createdAt: now,
		})
		.run();

	sqlite.close();
}

async function buildExcelJsSmokeWorkbook(): Promise<Buffer> {
	const ExcelJS = (await import("exceljs")).default;
	const workbook = new ExcelJS.Workbook();
	workbook.creator = "SPV-08 smoke";
	workbook.calcProperties.fullCalcOnLoad = true;

	const summary = workbook.addWorksheet("Summary");
	summary.columns = [
		{ header: "Metric", key: "metric", width: 18 },
		{ header: "Q1", key: "q1", width: 12 },
		{ header: "Q2", key: "q2", width: 12 },
		{ header: "Total", key: "total", width: 14 },
	];
	summary.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
	summary.getRow(1).fill = {
		type: "pattern",
		pattern: "solid",
		fgColor: { argb: "FF1F4E78" },
	};
	summary.addRow({ metric: "Revenue", q1: 100, q2: 125 });
	summary.getCell("D2").value = { formula: "SUM(B2:C2)", result: 225 };

	const detail = workbook.addWorksheet("Detail");
	detail.columns = [
		{ header: "Region", key: "region", width: 18 },
		{ header: "Value", key: "value", width: 12 },
	];
	detail.getRow(1).font = { bold: true };
	detail.addRows([
		{ region: "North", value: 140 },
		{ region: "South", value: 85 },
	]);

	return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe("file production service", () => {
	beforeEach(async () => {
		dbPath = `/tmp/alfyai-file-production-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
		await seedLegacyGeneratedFile();
	});

	afterEach(async () => {
		vi.doUnmock("./worker-runner");
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

	it("lists a legacy generated file as a succeeded file-production job", async () => {
		const { listConversationFileProductionJobs } = await import("./index");

		const jobs = await listConversationFileProductionJobs("user-1", "conv-1");

		expect(jobs).toEqual([
			expect.objectContaining({
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				title: "report.pdf",
				status: "succeeded",
				files: [
					expect.objectContaining({
						id: "file-1",
						filename: "report.pdf",
						mimeType: "application/pdf",
						sizeBytes: 2048,
						downloadUrl: "/api/chat/files/file-1/download",
						previewUrl: "/api/chat/files/file-1/preview",
					}),
				],
			}),
		]);
	});

	it("backfills each legacy generated file into one durable job link", async () => {
		const { listConversationFileProductionJobs } = await import("./index");
		const { db } = await import("$lib/server/db");

		await listConversationFileProductionJobs("user-1", "conv-1");
		await listConversationFileProductionJobs("user-1", "conv-1");

		const jobs = await db
			.select()
			.from(schema.fileProductionJobs)
			.where(eq(schema.fileProductionJobs.conversationId, "conv-1"));
		const links = await db
			.select()
			.from(schema.fileProductionJobFiles)
			.where(eq(schema.fileProductionJobFiles.chatGeneratedFileId, "file-1"));

		expect(jobs).toHaveLength(1);
		expect(jobs[0]).toMatchObject({
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			status: "succeeded",
			title: "report.pdf",
		});
		expect(links).toHaveLength(1);
		expect(links[0]).toMatchObject({
			jobId: jobs[0].id,
			chatGeneratedFileId: "file-1",
			sortOrder: 0,
		});
	});

	it("groups multiple produced files under one persisted job", async () => {
		const { db } = await import("$lib/server/db");
		const now = new Date("2026-05-03T19:31:00.000Z");
		await db.insert(schema.chatGeneratedFiles).values({
			id: "file-2",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			userId: "user-1",
			filename: "report.html",
			mimeType: "text/html",
			sizeBytes: 4096,
			storagePath: "conv-1/file-2.html",
			createdAt: now,
		});
		await db.insert(schema.fileProductionJobs).values({
			id: "job-multi-output",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			userId: "user-1",
			title: "Quarterly report package",
			status: "succeeded",
			stage: null,
			origin: "native",
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(schema.fileProductionJobFiles).values([
			{
				id: "link-file-1",
				jobId: "job-multi-output",
				chatGeneratedFileId: "file-1",
				sortOrder: 0,
				createdAt: now,
			},
			{
				id: "link-file-2",
				jobId: "job-multi-output",
				chatGeneratedFileId: "file-2",
				sortOrder: 1,
				createdAt: now,
			},
		]);
		const { listConversationFileProductionJobs } = await import("./index");

		const jobs = await listConversationFileProductionJobs("user-1", "conv-1");

		expect(jobs).toHaveLength(1);
		expect(jobs[0]).toMatchObject({
			id: "job-multi-output",
			title: "Quarterly report package",
			status: "succeeded",
			files: [
				expect.objectContaining({ id: "file-1", filename: "report.pdf" }),
				expect.objectContaining({ id: "file-2", filename: "report.html" }),
			],
		});
	});

	it("lists a queued production job before it has produced files", async () => {
		const { createFileProductionJob, listConversationFileProductionJobs } =
			await import("./index");

		const created = await createFileProductionJob({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			title: "Research brief",
			origin: "unified_produce",
		});

		expect(created).toMatchObject({
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			title: "Research brief",
			status: "queued",
			files: [],
		});

		const jobs = await listConversationFileProductionJobs("user-1", "conv-1");

		expect(jobs[0]).toMatchObject({
			id: created.id,
			title: "Research brief",
			status: "queued",
			files: [],
		});
	});

	it("accepts a parsed program-mode intake request and wakes queued work", async () => {
		const { submitFileProductionIntake } = await import("./index");
		const wakeWorker = vi.fn();

		const result = await submitFileProductionIntake({
			userId: "user-1",
			body: {
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				idempotencyKey: "turn-1:intake-program",
				requestTitle: "CSV export",
				sourceMode: "program",
				documentIntent: "data_export",
				requestedOutputs: [{ type: "csv" }],
				program: {
					language: "python",
					sourceCode:
						'from pathlib import Path\nPath("/output/data.csv").write_text("a,b\\n1,2")',
					filename: "data.csv",
				},
			},
			wakeWorker,
			now: new Date("2026-05-03T19:31:20.000Z"),
		});

		expect(result).toMatchObject({
			ok: true,
			status: 202,
			reused: false,
			job: {
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				title: "CSV export",
				status: "queued",
				files: [],
			},
		});
		expect(wakeWorker).toHaveBeenCalledTimes(1);
	});

	it("does not load the worker runner when invalid intake cannot queue work", async () => {
		let workerRunnerLoaded = false;
		vi.doMock("./worker-runner", () => {
			workerRunnerLoaded = true;
			return {
				wakeFileProductionWorker: vi.fn(),
			};
		});
		const { submitFileProductionIntake } = await import("./index");

		const result = await submitFileProductionIntake({
			userId: "user-1",
			body: {
				idempotencyKey: "turn-1:intake-missing-conversation",
				requestTitle: "Missing conversation",
				sourceMode: "program",
				outputs: [{ type: "csv" }],
				program: {
					language: "python",
					sourceCode:
						'from pathlib import Path\nPath("/output/data.csv").write_text("a,b\\n1,2")',
				},
			},
			now: new Date("2026-05-03T19:31:21.000Z"),
		});

		expect(result).toMatchObject({
			ok: false,
			status: 400,
			code: "missing_conversation_id",
		});
		expect(workerRunnerLoaded).toBe(false);
	});

	it("accepts model-friendly document-source intake and stores normalized source", async () => {
		const { db } = await import("$lib/server/db");
		const { submitFileProductionIntake } = await import("./index");
		const wakeWorker = vi.fn();

		const result = await submitFileProductionIntake({
			userId: "user-1",
			body: {
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				idempotencyKey: "turn-1:intake-document-source",
				requestTitle: "Our Chats - PDF Report",
				sourceMode: "document_source",
				documentIntent: "report",
				requestedOutputs: [{ type: "pdf" }],
				documentSource: {
					version: 1,
					template: "alfyai_standard_report",
					title: "Our Chats: Interaction Analysis Report",
					blocks: [
						{ type: "heading", text: "Executive Summary" },
						{
							type: "paragraph",
							text: "This report summarizes the conversation.",
						},
						{
							type: "table",
							title: "Key Chat Metrics",
							headers: ["Metric", "Value"],
							rows: [["Total Messages", "48"]],
						},
						{
							type: "chart",
							chartType: "bar",
							title: "Topics Discussed by Message Count",
							caption: "Breakdown of conversation volume across main topics.",
							altText: "Bar chart showing message counts per topic",
							data: {
								labels: ["General", "Technical"],
								datasets: [{ label: "Messages", data: [12, 15] }],
							},
						},
					],
				},
			},
			wakeWorker,
			now: new Date("2026-05-03T19:31:25.000Z"),
		});

		expect(result).toMatchObject({
			ok: true,
			status: 202,
			job: {
				title: "Our Chats - PDF Report",
				status: "queued",
			},
		});
		if (!result.ok) throw new Error("Expected accepted document-source intake");
		const [row] = await db
			.select({ requestJson: schema.fileProductionJobs.requestJson })
			.from(schema.fileProductionJobs)
			.where(eq(schema.fileProductionJobs.id, result.job.id));
		const requestJson = JSON.parse(row.requestJson ?? "{}");

		expect(requestJson).toMatchObject({
			sourceMode: "document_source",
			outputs: [{ type: "pdf" }],
			documentIntent: "report",
			documentSource: {
				version: 1,
				template: "alfyai_standard_report",
				blocks: expect.arrayContaining([
					{ type: "heading", level: 2, text: "Executive Summary" },
					expect.objectContaining({
						type: "table",
						columns: [
							{ key: "metric", label: "Metric", kind: "text" },
							{ key: "value", label: "Value", kind: "text" },
						],
						rows: [{ metric: "Total Messages", value: "48" }],
					}),
					expect.objectContaining({
						type: "chart",
						chartType: "bar",
						xKey: "label",
						yKey: "value",
					}),
				]),
			},
		});
		expect(wakeWorker).toHaveBeenCalledTimes(1);
	});

	it("persists malformed program intake as a durable failed job", async () => {
		const { submitFileProductionIntake } = await import("./index");
		const wakeWorker = vi.fn();

		const result = await submitFileProductionIntake({
			userId: "user-1",
			body: {
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				idempotencyKey: "turn-1:intake-bad-program",
				requestTitle: "Broken export",
				sourceMode: "program",
				outputs: [{ type: "csv" }],
				program: {
					language: "ruby",
					sourceCode: 'puts "bad"',
				},
			},
			wakeWorker,
			now: new Date("2026-05-03T19:31:26.000Z"),
		});

		expect(result).toMatchObject({
			ok: false,
			status: 422,
			code: "invalid_program_language",
			error: "program.language must be python or javascript",
			job: {
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				title: "Broken export",
				status: "failed",
				error: {
					code: "invalid_program_language",
					message: "program.language must be python or javascript",
					retryable: false,
				},
			},
		});
		expect(wakeWorker).not.toHaveBeenCalled();
	});

	it("persists static limit failures during intake and logs the limit detail", async () => {
		const { submitFileProductionIntake } = await import("./index");
		const wakeWorker = vi.fn();
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const result = await submitFileProductionIntake({
			userId: "user-1",
			body: {
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				idempotencyKey: "turn-1:intake-too-many",
				requestTitle: "Too many files",
				sourceMode: "program",
				outputs: [
					{ type: "csv" },
					{ type: "json" },
					{ type: "txt" },
					{ type: "xlsx" },
					{ type: "html" },
					{ type: "zip" },
				],
				program: {
					language: "python",
					sourceCode:
						'from pathlib import Path\nPath("/output/data.csv").write_text("a,b\\n1,2")',
				},
			},
			wakeWorker,
			now: new Date("2026-05-03T19:31:27.000Z"),
		});

		expect(result).toMatchObject({
			ok: false,
			status: 422,
			code: "too_many_outputs",
			error: "Too many outputs were requested.",
			job: {
				conversationId: "conv-1",
				title: "Too many files",
				status: "failed",
				error: {
					code: "too_many_outputs",
					message: "Too many outputs were requested.",
					retryable: false,
				},
			},
		});
		expect(wakeWorker).not.toHaveBeenCalled();
		expect(warnSpy).toHaveBeenCalledWith(
			"[FILE_PRODUCTION] Static limit failed",
			expect.objectContaining({
				code: "too_many_outputs",
				limit: 5,
				actual: 6,
				unit: "outputs",
			}),
		);
		warnSpy.mockRestore();
	});

	it("persists malformed document-source intake as a durable failed job", async () => {
		const { submitFileProductionIntake } = await import("./index");
		const wakeWorker = vi.fn();

		const result = await submitFileProductionIntake({
			userId: "user-1",
			body: {
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				idempotencyKey: "turn-1:intake-bad-document-source",
				requestTitle: "Unsafe report",
				sourceMode: "document_source",
				outputs: [{ type: "pdf" }],
				documentSource: {
					version: 1,
					template: "alfyai_standard_report",
					title: "Unsafe report",
					blocks: [{ type: "rawHtml", html: "<script>alert(1)</script>" }],
				},
			},
			wakeWorker,
			now: new Date("2026-05-03T19:31:28.000Z"),
		});

		expect(result).toMatchObject({
			ok: false,
			status: 422,
			code: "unsupported_document_block",
			error: "Generated document source contains an unsupported block.",
			job: {
				conversationId: "conv-1",
				title: "Unsafe report",
				status: "failed",
				error: {
					code: "unsupported_document_block",
					message: "Generated document source contains an unsupported block.",
					retryable: false,
				},
			},
		});
		expect(wakeWorker).not.toHaveBeenCalled();
	});

	it("reuses one failed intake job for the same idempotency key", async () => {
		const { db } = await import("$lib/server/db");
		const { submitFileProductionIntake } = await import("./index");
		const body = {
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			idempotencyKey: "turn-1:intake-failed-reuse",
			requestTitle: "Broken export",
			sourceMode: "program",
			outputs: [{ type: "csv" }],
			program: {
				language: "ruby",
				sourceCode: 'puts "bad"',
			},
		};

		const first = await submitFileProductionIntake({
			userId: "user-1",
			body,
			wakeWorker: vi.fn(),
			now: new Date("2026-05-03T19:31:29.000Z"),
		});
		const second = await submitFileProductionIntake({
			userId: "user-1",
			body: { ...body, requestTitle: "Duplicate broken export" },
			wakeWorker: vi.fn(),
			now: new Date("2026-05-03T19:31:30.000Z"),
		});
		const rows = await db
			.select()
			.from(schema.fileProductionJobs)
			.where(eq(schema.fileProductionJobs.idempotencyKey, body.idempotencyKey));

		expect(first.ok).toBe(false);
		expect(second.ok).toBe(false);
		expect(first.job?.id).toBe(second.job?.id);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			title: "Broken export",
			status: "failed",
			errorCode: "invalid_program_language",
		});
	});

	it("assigns newly produced jobs and linked files to the assistant message after stream completion", async () => {
		const { db } = await import("$lib/server/db");
		const { assignFileProductionJobsToAssistantMessage } = await import(
			"./index"
		);
		const now = new Date("2026-05-03T19:32:00.000Z");
		await db.insert(schema.chatGeneratedFiles).values({
			id: "file-produced-null",
			conversationId: "conv-1",
			assistantMessageId: null,
			userId: "user-1",
			filename: "analysis.pdf",
			mimeType: "application/pdf",
			sizeBytes: 8192,
			storagePath: "conv-1/file-produced-null.pdf",
			createdAt: now,
		});
		await db.insert(schema.fileProductionJobs).values({
			id: "job-produced-null",
			conversationId: "conv-1",
			assistantMessageId: null,
			userId: "user-1",
			title: "Analysis report",
			status: "succeeded",
			stage: null,
			origin: "unified_produce",
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(schema.fileProductionJobFiles).values({
			id: "link-produced-null",
			jobId: "job-produced-null",
			chatGeneratedFileId: "file-produced-null",
			sortOrder: 0,
			createdAt: now,
		});

		await assignFileProductionJobsToAssistantMessage(
			"user-1",
			"conv-1",
			"assistant-1",
			["job-produced-null"],
		);

		const [job] = await db
			.select()
			.from(schema.fileProductionJobs)
			.where(eq(schema.fileProductionJobs.id, "job-produced-null"));
		const [file] = await db
			.select()
			.from(schema.chatGeneratedFiles)
			.where(eq(schema.chatGeneratedFiles.id, "file-produced-null"));

		expect(job.assistantMessageId).toBe("assistant-1");
		expect(file.assistantMessageId).toBe("assistant-1");
	});

	it("keeps fast succeeded unassigned job-linked files discoverable before finalization assigns them", async () => {
		const { db } = await import("$lib/server/db");
		const { listConversationFileProductionJobs } = await import("./index");
		const now = new Date("2026-05-03T19:32:05.000Z");
		await db.insert(schema.chatGeneratedFiles).values({
			id: "file-fast-unassigned",
			conversationId: "conv-1",
			assistantMessageId: null,
			userId: "user-1",
			filename: "fast.pdf",
			mimeType: "application/pdf",
			sizeBytes: 4096,
			storagePath: "conv-1/file-fast-unassigned.pdf",
			createdAt: now,
		});
		await db.insert(schema.fileProductionJobs).values({
			id: "job-fast-unassigned",
			conversationId: "conv-1",
			assistantMessageId: null,
			userId: "user-1",
			title: "Fast report",
			status: "succeeded",
			stage: null,
			origin: "unified_produce",
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(schema.fileProductionJobFiles).values({
			id: "link-fast-unassigned",
			jobId: "job-fast-unassigned",
			chatGeneratedFileId: "file-fast-unassigned",
			sortOrder: 0,
			createdAt: now,
		});

		const jobs = await listConversationFileProductionJobs("user-1", "conv-1");

		expect(jobs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "job-fast-unassigned",
					assistantMessageId: null,
					status: "succeeded",
					files: [
						expect.objectContaining({
							id: "file-fast-unassigned",
							filename: "fast.pdf",
						}),
					],
				}),
			]),
		);
	});

	it("reuses a durable production job for the same idempotency key", async () => {
		const { createOrReuseFileProductionJob } = await import("./index");

		const first = await createOrReuseFileProductionJob({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			title: "CSV export",
			origin: "unified_produce",
			idempotencyKey: "turn-1:file-1",
			sourceMode: "program",
			documentIntent: null,
			requestJson: {
				sourceMode: "program",
				program: {
					language: "python",
					sourceCode:
						'from pathlib import Path\nPath("/output/data.csv").write_text("a,b\\n1,2")',
					filename: "data.csv",
				},
				outputs: [{ type: "csv" }],
			},
			now: new Date("2026-05-03T19:31:30.000Z"),
		});
		const second = await createOrReuseFileProductionJob({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			title: "CSV export duplicate",
			origin: "unified_produce",
			idempotencyKey: "turn-1:file-1",
			sourceMode: "program",
			documentIntent: null,
			requestJson: {
				sourceMode: "program",
				program: {
					language: "python",
					sourceCode: "duplicate",
				},
				outputs: [{ type: "csv" }],
			},
			now: new Date("2026-05-03T19:31:31.000Z"),
		});

		expect(first.reused).toBe(false);
		expect(second.reused).toBe(true);
		expect(second.job).toMatchObject({
			id: first.job.id,
			title: "CSV export",
			status: "queued",
		});
	});

	it("reselects the queued production job when concurrent same-key creation wins the idempotency race", async () => {
		const { db } = await import("$lib/server/db");
		const { createOrReuseFileProductionJob } = await import("./index");
		const baseInput = {
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			origin: "unified_produce",
			idempotencyKey: "turn-1:concurrent-file",
			sourceMode: "program",
			documentIntent: null,
			requestJson: {
				sourceMode: "program",
				program: {
					language: "python",
					sourceCode:
						'from pathlib import Path\nPath("/output/data.csv").write_text("a,b\\n1,2")',
					filename: "data.csv",
				},
				outputs: [{ type: "csv" }],
			},
		} as const;

		const results = await Promise.allSettled([
			createOrReuseFileProductionJob({
				...baseInput,
				title: "Concurrent CSV export",
				now: new Date("2026-05-03T19:31:32.000Z"),
			}),
			createOrReuseFileProductionJob({
				...baseInput,
				title: "Duplicate concurrent CSV export",
				now: new Date("2026-05-03T19:31:32.001Z"),
			}),
		]);

		expect(results.map((result) => result.status)).toEqual([
			"fulfilled",
			"fulfilled",
		]);
		if (
			results[0].status !== "fulfilled" ||
			results[1].status !== "fulfilled"
		) {
			throw new Error("Expected both concurrent submissions to resolve");
		}
		const [first, second] = [results[0].value, results[1].value];
		const rows = await db
			.select()
			.from(schema.fileProductionJobs)
			.where(
				eq(schema.fileProductionJobs.idempotencyKey, baseInput.idempotencyKey),
			);

		expect(first.job.id).toBe(second.job.id);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			id: first.job.id,
			title: "Concurrent CSV export",
			status: "queued",
		});
	});

	it("persists a failed production job for validation failures", async () => {
		const {
			createFailedFileProductionJob,
			listConversationFileProductionJobs,
		} = await import("./index");

		const failed = await createFailedFileProductionJob({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			title: "Broken export",
			origin: "unified_produce",
			idempotencyKey: "turn-1:bad-file",
			sourceMode: "program",
			documentIntent: null,
			requestJson: {
				sourceMode: "program",
				program: {
					language: "ruby",
					sourceCode: 'puts "bad"',
				},
			},
			errorCode: "invalid_program_language",
			errorMessage: "program.language must be python or javascript",
			retryable: false,
			now: new Date("2026-05-03T19:31:40.000Z"),
		});

		expect(failed).toMatchObject({
			title: "Broken export",
			status: "failed",
			error: {
				code: "invalid_program_language",
				message: "program.language must be python or javascript",
				retryable: false,
			},
		});
		expect(
			(await listConversationFileProductionJobs("user-1", "conv-1")).find(
				(job) => job.id === failed.id,
			),
		).toMatchObject({
			status: "failed",
			error: {
				code: "invalid_program_language",
			},
		});
	});

	it("claims the oldest queued job and records the running attempt", async () => {
		const {
			claimNextFileProductionJob,
			createFileProductionJob,
			listConversationFileProductionJobs,
		} = await import("./index");
		const first = await createFileProductionJob({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			title: "First queued report",
			origin: "unified_produce",
			now: new Date("2026-05-03T19:32:00.000Z"),
		});
		const second = await createFileProductionJob({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			title: "Second queued report",
			origin: "unified_produce",
			now: new Date("2026-05-03T19:33:00.000Z"),
		});

		const claimed = await claimNextFileProductionJob({
			workerId: "worker-1",
			now: new Date("2026-05-03T19:34:00.000Z"),
		});

		expect(claimed).toMatchObject({
			job: {
				id: first.id,
				status: "running",
			},
			attempt: {
				jobId: first.id,
				attemptNumber: 1,
				status: "running",
				workerId: "worker-1",
				errorCode: null,
				errorMessage: null,
				retryable: false,
			},
		});
		expect(claimed?.attempt.claimedAt).toBe(
			new Date("2026-05-03T19:34:00.000Z").getTime(),
		);
		expect(claimed?.attempt.heartbeatAt).toBe(
			new Date("2026-05-03T19:34:00.000Z").getTime(),
		);

		const jobs = await listConversationFileProductionJobs("user-1", "conv-1");
		expect(jobs.find((job) => job.id === first.id)?.status).toBe("running");
		expect(jobs.find((job) => job.id === second.id)?.status).toBe("queued");
	});

	it("only lets the claiming worker heartbeat or fail the current attempt", async () => {
		const {
			claimNextFileProductionJob,
			createFileProductionJob,
			failFileProductionJobAttempt,
			heartbeatFileProductionJobAttempt,
			listConversationFileProductionJobs,
		} = await import("./index");
		const job = await createFileProductionJob({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			title: "Owned attempt",
			origin: "unified_produce",
			now: new Date("2026-05-03T19:35:00.000Z"),
		});
		const claimed = await claimNextFileProductionJob({
			workerId: "worker-owner",
			now: new Date("2026-05-03T19:36:00.000Z"),
		});

		expect(claimed?.job.id).toBe(job.id);
		if (!claimed)
			throw new Error("Expected worker to claim file production job");
		await expect(
			heartbeatFileProductionJobAttempt({
				jobId: job.id,
				attemptId: claimed.attempt.id,
				workerId: "worker-late",
				now: new Date("2026-05-03T19:37:00.000Z"),
			}),
		).resolves.toBe(false);
		await expect(
			failFileProductionJobAttempt({
				jobId: job.id,
				attemptId: claimed.attempt.id,
				workerId: "worker-late",
				errorCode: "renderer_timeout",
				errorMessage: "Renderer timed out.",
				retryable: true,
				now: new Date("2026-05-03T19:38:00.000Z"),
			}),
		).resolves.toBe(false);

		expect(
			(await listConversationFileProductionJobs("user-1", "conv-1")).find(
				(row) => row.id === job.id,
			)?.status,
		).toBe("running");

		await expect(
			heartbeatFileProductionJobAttempt({
				jobId: job.id,
				attemptId: claimed.attempt.id,
				workerId: "worker-owner",
				now: new Date("2026-05-03T19:39:00.000Z"),
			}),
		).resolves.toBe(true);
		await expect(
			failFileProductionJobAttempt({
				jobId: job.id,
				attemptId: claimed.attempt.id,
				workerId: "worker-owner",
				errorCode: "renderer_timeout",
				errorMessage: "Renderer timed out.",
				retryable: true,
				now: new Date("2026-05-03T19:40:00.000Z"),
			}),
		).resolves.toBe(true);

		expect(
			(await listConversationFileProductionJobs("user-1", "conv-1")).find(
				(row) => row.id === job.id,
			),
		).toMatchObject({
			status: "failed",
			error: {
				code: "renderer_timeout",
				message: "Renderer timed out.",
				retryable: true,
			},
		});
	});

	it("recovers stale running attempts as retryable infrastructure failures", async () => {
		const {
			claimNextFileProductionJob,
			createFileProductionJob,
			listConversationFileProductionJobs,
			recoverStaleFileProductionAttempts,
		} = await import("./index");
		const job = await createFileProductionJob({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			title: "Stale running report",
			origin: "unified_produce",
			now: new Date("2026-05-03T19:41:00.000Z"),
		});
		await claimNextFileProductionJob({
			workerId: "worker-stale",
			now: new Date("2026-05-03T19:42:00.000Z"),
		});

		const recovered = await recoverStaleFileProductionAttempts({
			staleBefore: new Date("2026-05-03T19:50:00.000Z"),
			now: new Date("2026-05-03T19:51:00.000Z"),
		});

		expect(recovered).toEqual({ recovered: 1 });
		expect(
			(await listConversationFileProductionJobs("user-1", "conv-1")).find(
				(row) => row.id === job.id,
			),
		).toMatchObject({
			status: "failed",
			error: {
				code: "worker_heartbeat_timeout",
				message: "File production worker stopped before finishing.",
				retryable: true,
			},
		});
	});

	it("reconciles stale queued and running jobs while preserving fresh queued work", async () => {
		const {
			claimNextFileProductionJob,
			createFileProductionJob,
			listConversationFileProductionJobs,
			reconcileStaleFileProductionJobs,
		} = await import("./index");
		const runningJob = await createFileProductionJob({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			title: "Stale running fork blocker",
			origin: "unified_produce",
			now: new Date("2026-05-03T19:41:00.000Z"),
		});
		await claimNextFileProductionJob({
			workerId: "worker-stale",
			now: new Date("2026-05-03T19:42:00.000Z"),
		});
		const staleQueuedJob = await createFileProductionJob({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			title: "Stale queued fork blocker",
			origin: "unified_produce",
			now: new Date("2026-05-03T19:43:00.000Z"),
		});
		const freshQueuedJob = await createFileProductionJob({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			title: "Fresh queued fork blocker",
			origin: "unified_produce",
			now: new Date("2026-05-03T20:05:00.000Z"),
		});

		const recovered = await reconcileStaleFileProductionJobs({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageIds: ["assistant-1"],
			staleBefore: new Date("2026-05-03T20:00:00.000Z"),
			now: new Date("2026-05-03T20:10:00.000Z"),
		});

		expect(recovered).toEqual({ recovered: 2 });
		const jobs = await listConversationFileProductionJobs("user-1", "conv-1");
		expect(jobs.find((job) => job.id === runningJob.id)).toMatchObject({
			status: "failed",
			error: {
				code: "worker_heartbeat_timeout",
				retryable: true,
			},
		});
		expect(jobs.find((job) => job.id === staleQueuedJob.id)).toMatchObject({
			status: "failed",
			error: {
				code: "worker_queue_timeout",
				retryable: true,
			},
		});
		expect(jobs.find((job) => job.id === freshQueuedJob.id)).toMatchObject({
			status: "queued",
			error: null,
		});
	});

	it("reconciles stale running jobs with lost attempt state while preserving fresh running jobs", async () => {
		const { db } = await import("$lib/server/db");
		const {
			listConversationFileProductionJobs,
			reconcileStaleFileProductionJobs,
		} = await import("./index");
		const staleTime = new Date("2026-05-03T19:41:00.000Z");
		const freshTime = new Date("2026-05-03T20:05:00.000Z");
		await db.insert(schema.fileProductionJobs).values([
			{
				id: "running-no-attempt",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				userId: "user-1",
				title: "Running without attempt",
				status: "running",
				stage: "rendering",
				origin: "unified_produce",
				currentAttemptId: null,
				createdAt: staleTime,
				updatedAt: staleTime,
			},
			{
				id: "running-missing-attempt",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				userId: "user-1",
				title: "Running missing attempt",
				status: "running",
				stage: "rendering",
				origin: "unified_produce",
				currentAttemptId: "missing-attempt",
				createdAt: staleTime,
				updatedAt: staleTime,
			},
			{
				id: "running-failed-attempt",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				userId: "user-1",
				title: "Running failed attempt",
				status: "running",
				stage: "rendering",
				origin: "unified_produce",
				currentAttemptId: "failed-attempt",
				createdAt: staleTime,
				updatedAt: staleTime,
			},
			{
				id: "running-null-heartbeat",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				userId: "user-1",
				title: "Running null heartbeat",
				status: "running",
				stage: "rendering",
				origin: "unified_produce",
				currentAttemptId: "null-heartbeat-attempt",
				createdAt: staleTime,
				updatedAt: staleTime,
			},
			{
				id: "fresh-running",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				userId: "user-1",
				title: "Fresh running",
				status: "running",
				stage: "rendering",
				origin: "unified_produce",
				currentAttemptId: "fresh-attempt",
				createdAt: freshTime,
				updatedAt: freshTime,
			},
			{
				id: "fresh-running-no-attempt",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				userId: "user-1",
				title: "Fresh running without attempt",
				status: "running",
				stage: "rendering",
				origin: "unified_produce",
				currentAttemptId: null,
				createdAt: freshTime,
				updatedAt: freshTime,
			},
		]);
		await db.insert(schema.fileProductionJobAttempts).values([
			{
				id: "failed-attempt",
				jobId: "running-failed-attempt",
				attemptNumber: 1,
				status: "failed",
				stage: "rendering",
				workerId: "worker-lost",
				claimedAt: staleTime,
				heartbeatAt: staleTime,
				startedAt: staleTime,
				finishedAt: staleTime,
				errorCode: "renderer_timeout",
				errorMessage: "Renderer timed out.",
				retryable: true,
				createdAt: staleTime,
				updatedAt: staleTime,
			},
			{
				id: "null-heartbeat-attempt",
				jobId: "running-null-heartbeat",
				attemptNumber: 1,
				status: "running",
				stage: "rendering",
				workerId: "worker-lost",
				claimedAt: staleTime,
				heartbeatAt: null,
				startedAt: staleTime,
				finishedAt: null,
				createdAt: staleTime,
				updatedAt: staleTime,
			},
			{
				id: "fresh-attempt",
				jobId: "fresh-running",
				attemptNumber: 1,
				status: "running",
				stage: "rendering",
				workerId: "worker-fresh",
				claimedAt: freshTime,
				heartbeatAt: freshTime,
				startedAt: freshTime,
				finishedAt: null,
				createdAt: freshTime,
				updatedAt: freshTime,
			},
		]);

		const recovered = await reconcileStaleFileProductionJobs({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageIds: ["assistant-1"],
			staleBefore: new Date("2026-05-03T20:00:00.000Z"),
			now: new Date("2026-05-03T20:10:00.000Z"),
		});

		expect(recovered).toEqual({ recovered: 4 });
		const jobs = await listConversationFileProductionJobs("user-1", "conv-1");
		for (const jobId of [
			"running-no-attempt",
			"running-missing-attempt",
			"running-failed-attempt",
			"running-null-heartbeat",
		]) {
			expect(jobs.find((job) => job.id === jobId)).toMatchObject({
				status: "failed",
				error: {
					code: "worker_state_lost",
					retryable: true,
				},
			});
		}
		expect(jobs.find((job) => job.id === "fresh-running")).toMatchObject({
			status: "running",
			error: null,
		});
		expect(
			jobs.find((job) => job.id === "fresh-running-no-attempt"),
		).toMatchObject({
			status: "running",
			error: null,
		});
		const [nullHeartbeatAttempt] = await db
			.select()
			.from(schema.fileProductionJobAttempts)
			.where(eq(schema.fileProductionJobAttempts.id, "null-heartbeat-attempt"));
		expect(nullHeartbeatAttempt).toMatchObject({
			status: "failed",
			errorCode: "worker_state_lost",
			retryable: true,
		});
	});

	it("retries a retryable failed job under the same job identity with a new attempt number", async () => {
		const {
			claimNextFileProductionJob,
			createFileProductionJob,
			failFileProductionJobAttempt,
			retryFileProductionJob,
		} = await import("./index");
		const job = await createFileProductionJob({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			title: "Retryable report",
			origin: "unified_produce",
			now: new Date("2026-05-03T19:52:00.000Z"),
		});
		const firstClaim = await claimNextFileProductionJob({
			workerId: "worker-retry-1",
			now: new Date("2026-05-03T19:53:00.000Z"),
		});
		if (!firstClaim)
			throw new Error("Expected first retry worker to claim job");
		await failFileProductionJobAttempt({
			jobId: job.id,
			attemptId: firstClaim.attempt.id,
			workerId: "worker-retry-1",
			errorCode: "renderer_timeout",
			errorMessage: "Renderer timed out.",
			retryable: true,
			now: new Date("2026-05-03T19:54:00.000Z"),
		});

		const retried = await retryFileProductionJob({
			userId: "user-1",
			jobId: job.id,
			now: new Date("2026-05-03T19:55:00.000Z"),
		});
		const secondClaim = await claimNextFileProductionJob({
			workerId: "worker-retry-2",
			now: new Date("2026-05-03T19:56:00.000Z"),
		});

		expect(retried).toMatchObject({
			id: job.id,
			status: "queued",
			error: null,
		});
		expect(secondClaim).toMatchObject({
			job: {
				id: job.id,
				status: "running",
			},
			attempt: {
				jobId: job.id,
				attemptNumber: 2,
				status: "running",
				workerId: "worker-retry-2",
			},
		});
	});

	it("cancels queued and running jobs as persisted terminal states", async () => {
		const {
			cancelFileProductionJob,
			claimNextFileProductionJob,
			createFileProductionJob,
			failFileProductionJobAttempt,
			listConversationFileProductionJobs,
		} = await import("./index");
		const queuedJob = await createFileProductionJob({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			title: "Queued cancellation",
			origin: "unified_produce",
			now: new Date("2026-05-03T19:57:00.000Z"),
		});

		await expect(
			cancelFileProductionJob({
				userId: "user-1",
				jobId: queuedJob.id,
				now: new Date("2026-05-03T19:58:00.000Z"),
			}),
		).resolves.toMatchObject({
			id: queuedJob.id,
			status: "cancelled",
		});
		await expect(
			claimNextFileProductionJob({
				workerId: "worker-cancel",
				now: new Date("2026-05-03T19:59:00.000Z"),
			}),
		).resolves.toBeNull();

		const runningJob = await createFileProductionJob({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			title: "Running cancellation",
			origin: "unified_produce",
			now: new Date("2026-05-03T20:00:00.000Z"),
		});
		const claimed = await claimNextFileProductionJob({
			workerId: "worker-cancel",
			now: new Date("2026-05-03T20:01:00.000Z"),
		});
		if (!claimed) throw new Error("Expected cancellation worker to claim job");

		await expect(
			cancelFileProductionJob({
				userId: "user-1",
				jobId: runningJob.id,
				now: new Date("2026-05-03T20:02:00.000Z"),
			}),
		).resolves.toMatchObject({
			id: runningJob.id,
			status: "cancelled",
		});
		await expect(
			failFileProductionJobAttempt({
				jobId: runningJob.id,
				attemptId: claimed.attempt.id,
				workerId: "worker-cancel",
				errorCode: "renderer_timeout",
				errorMessage: "Renderer timed out.",
				retryable: true,
				now: new Date("2026-05-03T20:03:00.000Z"),
			}),
		).resolves.toBe(false);

		const jobs = await listConversationFileProductionJobs("user-1", "conv-1");
		expect(jobs.find((row) => row.id === queuedJob.id)?.status).toBe(
			"cancelled",
		);
		expect(jobs.find((row) => row.id === runningJob.id)?.status).toBe(
			"cancelled",
		);
	});

	it("does not store outputs when a running job is cancelled while execution is finishing", async () => {
		const { db } = await import("$lib/server/db");
		const {
			cancelFileProductionJob,
			createOrReuseFileProductionJob,
			executeNextFileProductionJob,
			listConversationFileProductionJobs,
		} = await import("./index");
		const created = await createOrReuseFileProductionJob({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			title: "Cancelled CSV export",
			origin: "unified_produce",
			idempotencyKey: "turn-1:cancelled-file",
			sourceMode: "program",
			documentIntent: null,
			requestJson: {
				sourceMode: "program",
				program: {
					language: "python",
					sourceCode:
						'from pathlib import Path\nPath("/output/data.csv").write_text("a,b\\n1,2")',
					filename: "data.csv",
				},
				outputs: [{ type: "csv" }],
			},
			now: new Date("2026-05-03T20:03:30.000Z"),
		});
		const storeGeneratedFile = vi.fn();

		const result = await executeNextFileProductionJob({
			workerId: "worker-cancel-after-exec",
			executeCode: vi.fn(async () => {
				await cancelFileProductionJob({
					userId: "user-1",
					jobId: created.job.id,
					now: new Date("2026-05-03T20:03:45.000Z"),
				});
				return {
					files: [
						{
							filename: "data.csv",
							mimeType: "text/csv",
							content: Buffer.from("a,b\n1,2"),
							sizeBytes: 7,
						},
					],
					stdout: "",
					stderr: "",
					error: null,
				};
			}),
			storeGeneratedFile,
			now: new Date("2026-05-03T20:03:40.000Z"),
		});

		expect(result).toBeNull();
		expect(storeGeneratedFile).not.toHaveBeenCalled();
		expect(
			(await listConversationFileProductionJobs("user-1", "conv-1")).find(
				(job) => job.id === created.job.id,
			),
		).toMatchObject({
			status: "cancelled",
			files: [],
		});
		const links = await db
			.select()
			.from(schema.fileProductionJobFiles)
			.where(eq(schema.fileProductionJobFiles.jobId, created.job.id));
		expect(links).toHaveLength(0);
	});

	it("executes a queued program job after creation and links produced files", async () => {
		const { db } = await import("$lib/server/db");
		const {
			assignFileProductionJobsToAssistantMessage,
			createOrReuseFileProductionJob,
			executeNextFileProductionJob,
		} = await import("./index");
		const created = await createOrReuseFileProductionJob({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: null,
			title: "Executable CSV export",
			origin: "unified_produce",
			idempotencyKey: "turn-1:exec-file",
			sourceMode: "program",
			documentIntent: null,
			requestJson: {
				sourceMode: "program",
				program: {
					language: "python",
					sourceCode:
						'from pathlib import Path\nPath("/output/data.csv").write_text("a,b\\n1,2")',
					filename: "data.csv",
				},
				outputs: [{ type: "csv" }],
			},
			now: new Date("2026-05-03T20:04:00.000Z"),
		});
		const executeCode = vi.fn(async () => ({
			files: [
				{
					filename: "data.csv",
					mimeType: "text/csv",
					content: Buffer.from("a,b\n1,2"),
					sizeBytes: 7,
				},
			],
			stdout: "",
			stderr: "",
			error: null,
		}));
		executeCode.mockImplementationOnce(async () => {
			await assignFileProductionJobsToAssistantMessage(
				"user-1",
				"conv-1",
				"assistant-1",
				[created.job.id],
			);
			return {
				files: [
					{
						filename: "data.csv",
						mimeType: "text/csv",
						content: Buffer.from("a,b\n1,2"),
						sizeBytes: 7,
					},
				],
				stdout: "",
				stderr: "",
				error: null,
			};
		});
		const storeGeneratedFile = vi.fn(async (_conversationId, _userId, file) => {
			const now = new Date("2026-05-03T20:05:00.000Z");
			await db.insert(schema.chatGeneratedFiles).values({
				id: "file-produced-1",
				conversationId: "conv-1",
				assistantMessageId: file.assistantMessageId,
				userId: "user-1",
				filename: "data.csv",
				mimeType: "text/csv",
				sizeBytes: 7,
				storagePath: "conv-1/file-produced-1.csv",
				createdAt: now,
			});
			return {
				id: "file-produced-1",
				conversationId: "conv-1",
				assistantMessageId: file.assistantMessageId ?? null,
				artifactId: null,
				userId: "user-1",
				filename: "data.csv",
				mimeType: "text/csv",
				sizeBytes: 7,
				storagePath: "conv-1/file-produced-1.csv",
				createdAt: now.getTime(),
			};
		});
		const syncGeneratedFilesToMemory = vi.fn(async () => undefined);

		const result = await executeNextFileProductionJob({
			workerId: "worker-exec",
			executeCode,
			storeGeneratedFile,
			syncGeneratedFilesToMemory,
			now: new Date("2026-05-03T20:05:00.000Z"),
		});

		expect(result).toMatchObject({
			job: {
				id: created.job.id,
				status: "succeeded",
			},
			files: [
				expect.objectContaining({
					id: "file-produced-1",
					filename: "data.csv",
				}),
			],
		});
		expect(executeCode).toHaveBeenCalledWith(
			'from pathlib import Path\nPath("/output/data.csv").write_text("a,b\\n1,2")',
			"python",
		);
		expect(storeGeneratedFile).toHaveBeenCalledWith("conv-1", "user-1", {
			assistantMessageId: null,
			filename: "data.csv",
			mimeType: "text/csv",
			content: expect.any(Buffer),
		});
		expect(syncGeneratedFilesToMemory).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			fileIds: ["file-produced-1"],
			assistantResponse: "Here is the report.",
		});

		const links = await db
			.select()
			.from(schema.fileProductionJobFiles)
			.where(eq(schema.fileProductionJobFiles.jobId, created.job.id));
		expect(links).toHaveLength(1);
		expect(links[0]).toMatchObject({
			chatGeneratedFileId: "file-produced-1",
			sortOrder: 0,
		});
		const [file] = await db
			.select()
			.from(schema.chatGeneratedFiles)
			.where(eq(schema.chatGeneratedFiles.id, "file-produced-1"));
		expect(file.assistantMessageId).toBe("assistant-1");
	});

	it("keeps partially stored files unlinked when a later output storage step fails", async () => {
		const { db } = await import("$lib/server/db");
		const {
			createOrReuseFileProductionJob,
			executeNextFileProductionJob,
			listConversationFileProductionJobs,
		} = await import("./index");
		const created = await createOrReuseFileProductionJob({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			title: "Partial package export",
			origin: "unified_produce",
			idempotencyKey: "turn-1:partial-storage-failure",
			sourceMode: "program",
			documentIntent: "data_export",
			requestJson: {
				sourceMode: "program",
				program: {
					language: "python",
					sourceCode: "writes two outputs",
				},
				outputs: [{ type: "csv" }, { type: "txt" }],
			},
			now: new Date("2026-05-03T20:05:30.000Z"),
		});
		const storeGeneratedFile = vi
			.fn()
			.mockImplementationOnce(async (_conversationId, _userId, file) => {
				const now = new Date("2026-05-03T20:05:35.000Z");
				await db.insert(schema.chatGeneratedFiles).values({
					id: "file-partial-storage-1",
					conversationId: "conv-1",
					assistantMessageId: file.assistantMessageId,
					userId: "user-1",
					filename: file.filename,
					mimeType: file.mimeType,
					sizeBytes: file.content.length,
					storagePath: "conv-1/file-partial-storage-1.csv",
					createdAt: now,
				});
				return {
					id: "file-partial-storage-1",
					conversationId: "conv-1",
					assistantMessageId: file.assistantMessageId ?? null,
					artifactId: null,
					userId: "user-1",
					filename: file.filename,
					mimeType: file.mimeType,
					sizeBytes: file.content.length,
					storagePath: "conv-1/file-partial-storage-1.csv",
					createdAt: now.getTime(),
				};
			})
			.mockRejectedValueOnce(new Error("disk full during second output"));

		const result = await executeNextFileProductionJob({
			workerId: "worker-partial-storage",
			executeCode: vi.fn(async () => ({
				files: [
					{
						filename: "data.csv",
						mimeType: "text/csv",
						content: Buffer.from("a,b\n1,2"),
					},
					{
						filename: "notes.txt",
						mimeType: "text/plain",
						content: Buffer.from("notes"),
					},
				],
				stdout: "",
				stderr: "",
				error: null,
			})),
			storeGeneratedFile,
			now: new Date("2026-05-03T20:05:35.000Z"),
		});
		const jobs = await listConversationFileProductionJobs("user-1", "conv-1");
		const links = await db
			.select()
			.from(schema.fileProductionJobFiles)
			.where(eq(schema.fileProductionJobFiles.jobId, created.job.id));
		const storedFiles = await db
			.select()
			.from(schema.chatGeneratedFiles)
			.where(eq(schema.chatGeneratedFiles.id, "file-partial-storage-1"));

		expect(result).toBeNull();
		expect(storeGeneratedFile).toHaveBeenCalledTimes(2);
		expect(storedFiles).toHaveLength(1);
		expect(links).toHaveLength(0);
		expect(jobs.find((job) => job.id === created.job.id)).toMatchObject({
			status: "failed",
			files: [],
			error: {
				code: "program_output_storage_failed",
				message: "disk full during second output",
				retryable: true,
			},
		});
		expect(
			jobs.some((job) =>
				job.files.some((file) => file.id === "file-partial-storage-1"),
			),
		).toBe(false);
	});

	it("fails oversized program outputs before storage and without produced-file links", async () => {
		const { db } = await import("$lib/server/db");
		const {
			createOrReuseFileProductionJob,
			executeNextFileProductionJob,
			listConversationFileProductionJobs,
		} = await import("./index");
		const created = await createOrReuseFileProductionJob({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			title: "Oversized CSV export",
			origin: "unified_produce",
			idempotencyKey: "turn-1:oversized-file",
			sourceMode: "program",
			documentIntent: null,
			requestJson: {
				sourceMode: "program",
				program: {
					language: "python",
					sourceCode:
						'from pathlib import Path\nPath("/output/data.csv").write_text("too large")',
					filename: "data.csv",
				},
				outputs: [{ type: "csv" }],
			},
			now: new Date("2026-05-03T20:06:00.000Z"),
		});
		const storeGeneratedFile = vi.fn();

		const result = await executeNextFileProductionJob({
			workerId: "worker-limit",
			executeCode: vi.fn(async () => ({
				files: [
					{
						filename: "data.csv",
						mimeType: "text/csv",
						content: Buffer.from("too large"),
						sizeBytes: 9,
					},
				],
				stdout: "",
				stderr: "",
				error: null,
			})),
			storeGeneratedFile,
			limits: {
				maxOutputFileBytes: 4,
				maxTotalOutputBytes: 20,
			},
			now: new Date("2026-05-03T20:07:00.000Z"),
		});

		expect(result).toBeNull();
		expect(storeGeneratedFile).not.toHaveBeenCalled();
		expect(
			(await listConversationFileProductionJobs("user-1", "conv-1")).find(
				(job) => job.id === created.job.id,
			),
		).toMatchObject({
			status: "failed",
			error: {
				code: "output_file_too_large",
				retryable: false,
			},
		});
		const links = await db
			.select()
			.from(schema.fileProductionJobFiles)
			.where(eq(schema.fileProductionJobFiles.jobId, created.job.id));
		expect(links).toHaveLength(0);
		const attempts = await db
			.select()
			.from(schema.fileProductionJobAttempts)
			.where(eq(schema.fileProductionJobAttempts.jobId, created.job.id));
		expect(JSON.parse(attempts[0].diagnosticsJson ?? "{}")).toMatchObject({
			limit: 4,
			actual: 9,
			unit: "bytes",
		});
	});

	it("fails invalid XLSX program output before storage and without produced-file links", async () => {
		const { db } = await import("$lib/server/db");
		const {
			createOrReuseFileProductionJob,
			executeNextFileProductionJob,
			listConversationFileProductionJobs,
		} = await import("./index");
		const created = await createOrReuseFileProductionJob({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			title: "Broken workbook",
			origin: "unified_produce",
			idempotencyKey: "turn-1:broken-xlsx",
			sourceMode: "program",
			documentIntent: "spreadsheet",
			requestJson: {
				sourceMode: "program",
				program: {
					language: "javascript",
					sourceCode: "invalid xlsx fixture",
					filename: "workbook.xlsx",
				},
				outputs: [{ type: "xlsx" }],
			},
			now: new Date("2026-05-03T20:07:30.000Z"),
		});
		const storeGeneratedFile = vi.fn();

		const result = await executeNextFileProductionJob({
			workerId: "worker-invalid-xlsx",
			executeCode: vi.fn(async () => ({
				files: [
					{
						filename: "workbook.xlsx",
						mimeType:
							"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
						content: Buffer.from("not an ooxml zip"),
						sizeBytes: 16,
					},
				],
				stdout: "",
				stderr: "",
				error: null,
			})),
			storeGeneratedFile,
			now: new Date("2026-05-03T20:07:45.000Z"),
		});

		expect(result).toBeNull();
		expect(storeGeneratedFile).not.toHaveBeenCalled();
		expect(
			(await listConversationFileProductionJobs("user-1", "conv-1")).find(
				(job) => job.id === created.job.id,
			),
		).toMatchObject({
			status: "failed",
			error: {
				code: "invalid_xlsx_output",
				retryable: false,
			},
		});
		const links = await db
			.select()
			.from(schema.fileProductionJobFiles)
			.where(eq(schema.fileProductionJobFiles.jobId, created.job.id));
		expect(links).toHaveLength(0);
	});

	it("fails program jobs with missing requested outputs before execution", async () => {
		const { db } = await import("$lib/server/db");
		const {
			createOrReuseFileProductionJob,
			executeNextFileProductionJob,
			listConversationFileProductionJobs,
		} = await import("./index");
		const created = await createOrReuseFileProductionJob({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			title: "Missing outputs workbook",
			origin: "unified_produce",
			idempotencyKey: "turn-1:missing-program-outputs",
			sourceMode: "program",
			documentIntent: "spreadsheet",
			requestJson: {
				sourceMode: "program",
				program: {
					language: "javascript",
					sourceCode: "writes workbook",
					filename: "workbook.xlsx",
				},
				outputs: [],
			},
			now: new Date("2026-05-03T20:07:46.000Z"),
		});
		const executeCode = vi.fn(async () => ({
			files: [
				{
					filename: "workbook.xlsx",
					mimeType: XLSX_MIME_TYPE,
					content: await buildExcelJsSmokeWorkbook(),
				},
			],
			stdout: "",
			stderr: "",
			error: null,
		}));
		const storeGeneratedFile = vi.fn();

		const result = await executeNextFileProductionJob({
			workerId: "worker-missing-program-outputs",
			executeCode,
			storeGeneratedFile,
			now: new Date("2026-05-03T20:07:47.000Z"),
		});

		expect(result).toBeNull();
		expect(executeCode).not.toHaveBeenCalled();
		expect(storeGeneratedFile).not.toHaveBeenCalled();
		expect(
			(await listConversationFileProductionJobs("user-1", "conv-1")).find(
				(job) => job.id === created.job.id,
			),
		).toMatchObject({
			status: "failed",
			error: {
				code: "missing_program_requested_outputs",
				retryable: false,
			},
		});
		const links = await db
			.select()
			.from(schema.fileProductionJobFiles)
			.where(eq(schema.fileProductionJobFiles.jobId, created.job.id));
		expect(links).toHaveLength(0);
	});

	it("fails program.filename outputs that would be renamed from a different basename", async () => {
		const { db } = await import("$lib/server/db");
		const {
			createOrReuseFileProductionJob,
			executeNextFileProductionJob,
			listConversationFileProductionJobs,
		} = await import("./index");
		const created = await createOrReuseFileProductionJob({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			title: "Renamed workbook",
			origin: "unified_produce",
			idempotencyKey: "turn-1:renamed-program-output",
			sourceMode: "program",
			documentIntent: "spreadsheet",
			requestJson: {
				sourceMode: "program",
				program: {
					language: "javascript",
					sourceCode: "writes wrong file name",
					filename: "workbook.xlsx",
				},
				outputs: [{ type: "xlsx" }, { type: "csv" }],
			},
			now: new Date("2026-05-03T20:07:48.000Z"),
		});
		const storeGeneratedFile = vi.fn();

		const result = await executeNextFileProductionJob({
			workerId: "worker-renamed-program-output",
			executeCode: vi.fn(async () => ({
				files: [
					{
						filename: "notes.txt",
						mimeType: "text/plain",
						content: Buffer.from("not a workbook"),
					},
				],
				stdout: "",
				stderr: "",
				error: null,
			})),
			storeGeneratedFile,
			now: new Date("2026-05-03T20:07:49.000Z"),
		});

		expect(result).toBeNull();
		expect(storeGeneratedFile).not.toHaveBeenCalled();
		expect(
			(await listConversationFileProductionJobs("user-1", "conv-1")).find(
				(job) => job.id === created.job.id,
			),
		).toMatchObject({
			status: "failed",
			error: {
				code: "program_output_filename_mismatch",
				retryable: false,
			},
		});
		const links = await db
			.select()
			.from(schema.fileProductionJobFiles)
			.where(eq(schema.fileProductionJobFiles.jobId, created.job.id));
		expect(links).toHaveLength(0);
	});

	it("fails requested XLSX program jobs that only produce CSV output", async () => {
		const { db } = await import("$lib/server/db");
		const {
			createOrReuseFileProductionJob,
			executeNextFileProductionJob,
			listConversationFileProductionJobs,
		} = await import("./index");
		const created = await createOrReuseFileProductionJob({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			title: "Wrong output type",
			origin: "unified_produce",
			idempotencyKey: "turn-1:xlsx-produced-csv",
			sourceMode: "program",
			documentIntent: "spreadsheet",
			requestJson: {
				sourceMode: "program",
				program: {
					language: "javascript",
					sourceCode: "writes csv only",
				},
				outputs: [{ type: "xlsx" }],
			},
			now: new Date("2026-05-03T20:07:50.000Z"),
		});
		const storeGeneratedFile = vi.fn();

		const result = await executeNextFileProductionJob({
			workerId: "worker-xlsx-produced-csv",
			executeCode: vi.fn(async () => ({
				files: [
					{
						filename: "workbook.csv",
						mimeType: "text/csv",
						content: Buffer.from("Metric,Value\nRevenue,225\n"),
					},
				],
				stdout: "",
				stderr: "",
				error: null,
			})),
			storeGeneratedFile,
			now: new Date("2026-05-03T20:07:51.000Z"),
		});

		expect(result).toBeNull();
		expect(storeGeneratedFile).not.toHaveBeenCalled();
		expect(
			(await listConversationFileProductionJobs("user-1", "conv-1")).find(
				(job) => job.id === created.job.id,
			),
		).toMatchObject({
			status: "failed",
			error: {
				code: "program_output_type_mismatch",
				retryable: false,
			},
		});
		const links = await db
			.select()
			.from(schema.fileProductionJobFiles)
			.where(eq(schema.fileProductionJobFiles.jobId, created.job.id));
		expect(links).toHaveLength(0);
	});

	it("drains a JavaScript ExcelJS XLSX program job as one validated linked workbook", async () => {
		const { db } = await import("$lib/server/db");
		const {
			createOrReuseFileProductionJob,
			drainFileProductionWorker,
			listConversationFileProductionJobs,
		} = await import("./index");
		const sourceCode = `
const ExcelJS = require('exceljs');
const workbook = new ExcelJS.Workbook();
workbook.calcProperties.fullCalcOnLoad = true;
const summary = workbook.addWorksheet('Summary');
summary.columns = [
  { header: 'Metric', key: 'metric', width: 18 },
  { header: 'Q1', key: 'q1', width: 12 },
  { header: 'Q2', key: 'q2', width: 12 },
  { header: 'Total', key: 'total', width: 14 },
];
summary.getRow(1).font = { bold: true };
summary.addRow({ metric: 'Revenue', q1: 100, q2: 125 });
summary.getCell('D2').value = { formula: 'SUM(B2:C2)', result: 225 };
const detail = workbook.addWorksheet('Detail');
detail.addRows([['Region', 'Value'], ['North', 140], ['South', 85]]);
await workbook.xlsx.writeFile('/output/workbook.xlsx');
`.trim();
		const workbookBuffer = await buildExcelJsSmokeWorkbook();
		const created = await createOrReuseFileProductionJob({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			title: "ExcelJS workbook",
			origin: "unified_produce",
			idempotencyKey: "turn-1:exceljs-workbook",
			sourceMode: "program",
			documentIntent: "spreadsheet",
			requestJson: {
				sourceMode: "program",
				program: {
					language: "javascript",
					sourceCode,
					filename: "workbook.xlsx",
				},
				outputs: [{ type: "xlsx" }],
			},
			now: new Date("2026-05-03T20:07:50.000Z"),
		});
		const executeCode = vi.fn(async () => ({
			files: [
				{
					filename: "workbook.xlsx",
					mimeType: XLSX_MIME_TYPE,
					content: workbookBuffer,
					sizeBytes: workbookBuffer.length,
				},
			],
			stdout: "",
			stderr: "",
			error: null,
		}));
		const storeGeneratedFile = vi.fn(async (_conversationId, _userId, file) => {
			const JSZip = (await import("jszip")).default;
			const zip = await JSZip.loadAsync(file.content);
			const worksheetEntries = Object.keys(zip.files).filter((entry) =>
				/^xl\/worksheets\/sheet\d+\.xml$/u.test(entry),
			);
			const workbookXml = await zip.file("xl/workbook.xml")?.async("string");
			const summaryXml = await zip
				.file("xl/worksheets/sheet1.xml")
				?.async("string");

			expect(file.filename).toBe("workbook.xlsx");
			expect(file.mimeType).toBe(XLSX_MIME_TYPE);
			expect(file.filename.endsWith(".xlsx")).toBe(true);
			expect(worksheetEntries).toHaveLength(2);
			expect(workbookXml).toContain('fullCalcOnLoad="1"');
			expect(summaryXml).toContain("<f>SUM(B2:C2)</f>");
			expect(summaryXml).toMatch(/<c r="A1" s="\d+"/u);

			const now = new Date("2026-05-03T20:08:10.000Z");
			await db.insert(schema.chatGeneratedFiles).values({
				id: "file-exceljs-workbook",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				userId: "user-1",
				filename: file.filename,
				mimeType: file.mimeType,
				sizeBytes: file.content.length,
				storagePath: "conv-1/file-exceljs-workbook.xlsx",
				createdAt: now,
			});
			return {
				id: "file-exceljs-workbook",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				artifactId: null,
				userId: "user-1",
				filename: file.filename,
				mimeType: file.mimeType,
				sizeBytes: file.content.length,
				storagePath: "conv-1/file-exceljs-workbook.xlsx",
				createdAt: now.getTime(),
			};
		});

		await drainFileProductionWorker({
			workerId: "worker-exceljs-smoke",
			executeCode,
			storeGeneratedFile,
			syncGeneratedFilesToMemory: vi.fn(async () => undefined),
			now: new Date("2026-05-03T20:08:00.000Z"),
		});

		expect(executeCode).toHaveBeenCalledWith(sourceCode, "javascript");
		expect(storeGeneratedFile).toHaveBeenCalledTimes(1);
		const jobs = await listConversationFileProductionJobs("user-1", "conv-1");
		expect(jobs.find((job) => job.id === created.job.id)).toMatchObject({
			status: "succeeded",
			files: [
				expect.objectContaining({
					id: "file-exceljs-workbook",
					filename: "workbook.xlsx",
					mimeType: XLSX_MIME_TYPE,
					sizeBytes: workbookBuffer.length,
				}),
			],
		});
		const links = await db
			.select()
			.from(schema.fileProductionJobFiles)
			.where(eq(schema.fileProductionJobFiles.jobId, created.job.id));
		expect(links).toHaveLength(1);
		expect(links[0]).toMatchObject({
			chatGeneratedFileId: "file-exceljs-workbook",
			sortOrder: 0,
		});
	});

	it("fails single-file program contracts that produce extra scratch outputs", async () => {
		const { db } = await import("$lib/server/db");
		const {
			createOrReuseFileProductionJob,
			executeNextFileProductionJob,
			listConversationFileProductionJobs,
		} = await import("./index");
		const created = await createOrReuseFileProductionJob({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			title: "Workbook with diagnostics",
			origin: "unified_produce",
			idempotencyKey: "turn-1:xlsx-scratch-output",
			sourceMode: "program",
			documentIntent: "spreadsheet",
			requestJson: {
				sourceMode: "program",
				program: {
					language: "javascript",
					sourceCode: "writes workbook and debug file",
					filename: "workbook.xlsx",
				},
				outputs: [{ type: "xlsx" }],
			},
			now: new Date("2026-05-03T20:08:30.000Z"),
		});
		const storeGeneratedFile = vi.fn();

		const result = await executeNextFileProductionJob({
			workerId: "worker-xlsx-scratch",
			executeCode: vi.fn(async () => ({
				files: [
					{
						filename: "workbook.xlsx",
						mimeType: XLSX_MIME_TYPE,
						content: await buildExcelJsSmokeWorkbook(),
					},
					{
						filename: "diagnostics.txt",
						mimeType: "text/plain",
						content: Buffer.from("debug notes"),
					},
				],
				stdout: "",
				stderr: "",
				error: null,
			})),
			storeGeneratedFile,
			now: new Date("2026-05-03T20:08:45.000Z"),
		});

		expect(result).toBeNull();
		expect(storeGeneratedFile).not.toHaveBeenCalled();
		expect(
			(await listConversationFileProductionJobs("user-1", "conv-1")).find(
				(job) => job.id === created.job.id,
			),
		).toMatchObject({
			status: "failed",
			error: {
				code: "unexpected_program_output_files",
				message: expect.stringContaining(
					"expected exactly one file named workbook.xlsx",
				),
				retryable: false,
			},
		});
		const links = await db
			.select()
			.from(schema.fileProductionJobFiles)
			.where(eq(schema.fileProductionJobFiles.jobId, created.job.id));
		expect(links).toHaveLength(0);
	});

	it("keeps draining queued jobs after one program job fails", async () => {
		const { db } = await import("$lib/server/db");
		const {
			createOrReuseFileProductionJob,
			drainFileProductionWorker,
			listConversationFileProductionJobs,
		} = await import("./index");
		const failedJob = await createOrReuseFileProductionJob({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			title: "Broken deck",
			origin: "unified_produce",
			idempotencyKey: "turn-1:broken-deck",
			sourceMode: "program",
			documentIntent: "slides",
			requestJson: {
				sourceMode: "program",
				program: {
					language: "javascript",
					sourceCode: 'throw new TypeError("pptx write failed")',
					filename: "deck.pptx",
				},
				outputs: [{ type: "pptx" }],
			},
			now: new Date("2026-05-03T20:12:00.000Z"),
		});
		const succeedingJob = await createOrReuseFileProductionJob({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			title: "Metrics CSV",
			origin: "unified_produce",
			idempotencyKey: "turn-1:metrics-csv",
			sourceMode: "program",
			documentIntent: "data_export",
			requestJson: {
				sourceMode: "program",
				program: {
					language: "python",
					sourceCode:
						'from pathlib import Path\nPath("/output/metrics.csv").write_text("name,value\\nok,1")',
					filename: "metrics.csv",
				},
				outputs: [{ type: "csv" }],
			},
			now: new Date("2026-05-03T20:13:00.000Z"),
		});
		const executeCode = vi
			.fn()
			.mockResolvedValueOnce({
				files: [],
				stdout: "",
				stderr: "TypeError: pptx write failed",
				error:
					"Execution failed with exit code 1: TypeError: pptx write failed",
			})
			.mockResolvedValueOnce({
				files: [
					{
						filename: "metrics.csv",
						mimeType: "text/csv",
						content: Buffer.from("name,value\nok,1"),
						sizeBytes: 15,
					},
				],
				stdout: "",
				stderr: "",
				error: null,
			});
		const storeGeneratedFile = vi.fn(async (_conversationId, _userId, file) => {
			const now = new Date("2026-05-03T20:14:00.000Z");
			await db.insert(schema.chatGeneratedFiles).values({
				id: "file-drain-success",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				userId: "user-1",
				filename: file.filename,
				mimeType: file.mimeType,
				sizeBytes: file.content.length,
				storagePath: "conv-1/file-drain-success.csv",
				createdAt: now,
			});
			return {
				id: "file-drain-success",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				artifactId: null,
				userId: "user-1",
				filename: file.filename,
				mimeType: file.mimeType,
				sizeBytes: file.content.length,
				storagePath: "conv-1/file-drain-success.csv",
				createdAt: now.getTime(),
			};
		});

		await drainFileProductionWorker({
			workerId: "worker-drain",
			executeCode,
			storeGeneratedFile,
			now: new Date("2026-05-03T20:14:00.000Z"),
		});

		const jobs = await listConversationFileProductionJobs("user-1", "conv-1");

		expect(executeCode).toHaveBeenCalledTimes(2);
		expect(jobs.find((job) => job.id === failedJob.job.id)).toMatchObject({
			status: "failed",
			error: {
				code: "program_execution_failed",
				message: expect.stringContaining("pptx write failed"),
				retryable: true,
			},
		});
		expect(jobs.find((job) => job.id === succeedingJob.job.id)).toMatchObject({
			status: "succeeded",
			files: [expect.objectContaining({ filename: "metrics.csv" })],
		});
	});

	it("executes a queued document-source PDF job without using the sandbox", async () => {
		const { db } = await import("$lib/server/db");
		const { createOrReuseFileProductionJob, executeNextFileProductionJob } =
			await import("./index");
		const created = await createOrReuseFileProductionJob({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			title: "Quarterly PDF report",
			origin: "unified_produce",
			idempotencyKey: "turn-1:document-source-pdf",
			sourceMode: "document_source",
			documentIntent: "A styled PDF report",
			requestJson: {
				sourceMode: "document_source",
				outputs: [{ type: "pdf" }],
				documentSource: {
					version: 1,
					template: "alfyai_standard_report",
					title: "Quarterly PDF report",
					blocks: [
						{ type: "heading", level: 2, text: "Summary" },
						{ type: "paragraph", text: "Revenue increased by 12%." },
					],
				},
			},
			now: new Date("2026-05-03T20:08:00.000Z"),
		});
		const executeCode = vi.fn();
		const syncGeneratedFilesToMemory = vi.fn(async () => undefined);
		const storeGeneratedFile = vi.fn(async (_conversationId, _userId, file) => {
			expect(file.filename).toBe("quarterly-pdf-report.pdf");
			expect(file.mimeType).toBe("application/pdf");
			expect(file.content.subarray(0, 4).toString("ascii")).toBe("%PDF");
			const now = new Date("2026-05-03T20:09:00.000Z");
			await db.insert(schema.chatGeneratedFiles).values({
				id: "file-document-pdf-1",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				userId: "user-1",
				filename: file.filename,
				mimeType: file.mimeType,
				sizeBytes: file.content.length,
				storagePath: "conv-1/file-document-pdf-1.pdf",
				createdAt: now,
			});
			return {
				id: "file-document-pdf-1",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				artifactId: null,
				userId: "user-1",
				filename: file.filename,
				mimeType: file.mimeType,
				sizeBytes: file.content.length,
				storagePath: "conv-1/file-document-pdf-1.pdf",
				createdAt: now.getTime(),
			};
		});

		const result = await executeNextFileProductionJob({
			workerId: "worker-document-source",
			executeCode,
			storeGeneratedFile,
			syncGeneratedFilesToMemory,
			now: new Date("2026-05-03T20:09:00.000Z"),
		});
		const sourceArtifacts = await db
			.select()
			.from(schema.artifacts)
			.where(eq(schema.artifacts.type, "generated_output"));
		const sourceArtifact = sourceArtifacts.find((artifact) => {
			const metadata = JSON.parse(artifact.metadataJson ?? "{}");
			return metadata.fileProductionJobId === created.job.id;
		});

		expect(result).toMatchObject({
			job: {
				id: created.job.id,
				status: "succeeded",
			},
			files: [
				expect.objectContaining({
					id: "file-document-pdf-1",
					filename: "quarterly-pdf-report.pdf",
					mimeType: "application/pdf",
					artifactId: sourceArtifact?.id,
					documentLabel: "Quarterly PDF report",
					sourceChatFileId: "file-document-pdf-1",
				}),
			],
		});
		expect(sourceArtifact).toBeDefined();
		expect(sourceArtifact).toMatchObject({
			type: "generated_output",
			retrievalClass: "durable",
			name: "Quarterly PDF report",
			mimeType: "application/vnd.alfyai.generated-document+json",
			contentText: expect.stringContaining("Revenue increased by 12%."),
		});
		const sourceMetadata = JSON.parse(sourceArtifact?.metadataJson ?? "{}");
		expect(sourceMetadata).toMatchObject({
			generatedDocumentSourceVersion: 1,
			fileProductionJobId: created.job.id,
			originConversationId: "conv-1",
			originAssistantMessageId: "assistant-1",
			documentFamilyId: sourceArtifact?.id,
			documentFamilyStatus: "active",
			documentLabel: "Quarterly PDF report",
			versionNumber: 1,
			originalChatFileId: "file-document-pdf-1",
			sourceChatFileId: "file-document-pdf-1",
			generatedDocumentRenderedChatFileIds: ["file-document-pdf-1"],
			generatedDocumentSource: {
				version: 1,
				template: "alfyai_standard_report",
				title: "Quarterly PDF report",
			},
		});
		expect(executeCode).not.toHaveBeenCalled();
		const links = await db
			.select()
			.from(schema.fileProductionJobFiles)
			.where(eq(schema.fileProductionJobFiles.jobId, created.job.id));
		expect(links).toHaveLength(1);
		expect(links[0]).toMatchObject({
			chatGeneratedFileId: "file-document-pdf-1",
			sortOrder: 0,
		});
	});

	it("marks pre-render document-source artifacts failed when PDF rendering fails", async () => {
		const { db } = await import("$lib/server/db");
		const {
			createOrReuseFileProductionJob,
			executeNextFileProductionJob,
			listConversationFileProductionJobs,
		} = await import("./index");
		const created = await createOrReuseFileProductionJob({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			title: "Critical image report",
			origin: "unified_produce",
			idempotencyKey: "turn-1:document-source-critical-image",
			sourceMode: "document_source",
			documentIntent: "A PDF report with a required image",
			requestJson: {
				sourceMode: "document_source",
				outputs: [{ type: "pdf" }],
				documentSource: {
					version: 1,
					template: "alfyai_standard_report",
					title: "Critical image report",
					blocks: [
						{
							type: "image",
							source: { kind: "generated_file", fileId: "missing-image-file" },
							altText: "Required image.",
							critical: true,
						},
					],
				},
			},
			now: new Date("2026-05-03T20:09:30.000Z"),
		});
		const storeGeneratedFile = vi.fn();

		const result = await executeNextFileProductionJob({
			workerId: "worker-document-source-render-failure",
			executeCode: vi.fn(),
			storeGeneratedFile,
			now: new Date("2026-05-03T20:09:31.000Z"),
		});

		const sourceArtifacts = await db
			.select()
			.from(schema.artifacts)
			.where(eq(schema.artifacts.type, "generated_output"));
		const sourceArtifact = sourceArtifacts.find((artifact) => {
			const metadata = JSON.parse(artifact.metadataJson ?? "{}");
			return metadata.fileProductionJobId === created.job.id;
		});
		const links = await db
			.select()
			.from(schema.fileProductionJobFiles)
			.where(eq(schema.fileProductionJobFiles.jobId, created.job.id));

		expect(result).toBeNull();
		expect(sourceArtifact).toMatchObject({
			type: "generated_output",
			retrievalClass: "ephemeral_followup",
			name: "Critical image report",
			contentText: expect.stringContaining("Required image."),
		});
		const sourceMetadata = JSON.parse(sourceArtifact?.metadataJson ?? "{}");
		expect(sourceMetadata).toMatchObject({
			fileProductionJobId: created.job.id,
			generatedDocumentSourceStatus: "failed",
			generatedDocumentSourceErrorCode: "image_limit_exceeded",
		});
		expect(sourceMetadata.sourceChatFileId).toBeUndefined();
		expect(storeGeneratedFile).not.toHaveBeenCalled();
		expect(links).toHaveLength(0);
		expect(
			(await listConversationFileProductionJobs("user-1", "conv-1")).find(
				(job) => job.id === created.job.id,
			),
		).toMatchObject({
			status: "failed",
			error: {
				code: "image_limit_exceeded",
				retryable: false,
			},
		});
	});

	it("executes one document source into PDF, DOCX, and HTML outputs", async () => {
		const { db } = await import("$lib/server/db");
		const {
			createOrReuseFileProductionJob,
			executeNextFileProductionJob,
			listConversationFileProductionJobs,
		} = await import("./index");
		const created = await createOrReuseFileProductionJob({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			title: "Multi output report",
			origin: "unified_produce",
			idempotencyKey: "turn-1:document-source-multi",
			sourceMode: "document_source",
			documentIntent: "A multi-output report",
			requestJson: {
				sourceMode: "document_source",
				outputs: [{ type: "pdf" }, { type: "docx" }, { type: "html" }],
				documentSource: {
					version: 1,
					template: "alfyai_standard_report",
					title: "Multi output report",
					blocks: [{ type: "paragraph", text: "Shared source." }],
				},
			},
			now: new Date("2026-05-03T20:10:00.000Z"),
		});
		let fileIndex = 0;
		const storeGeneratedFile = vi.fn(async (_conversationId, _userId, file) => {
			fileIndex += 1;
			const id = `file-document-multi-${fileIndex}`;
			const now = new Date("2026-05-03T20:11:00.000Z");
			await db.insert(schema.chatGeneratedFiles).values({
				id,
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				userId: "user-1",
				filename: file.filename,
				mimeType: file.mimeType,
				sizeBytes: file.content.length,
				storagePath: `conv-1/${id}`,
				createdAt: now,
			});
			return {
				id,
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				artifactId: null,
				userId: "user-1",
				filename: file.filename,
				mimeType: file.mimeType,
				sizeBytes: file.content.length,
				storagePath: `conv-1/${id}`,
				createdAt: now.getTime(),
			};
		});

		const result = await executeNextFileProductionJob({
			workerId: "worker-document-multi",
			executeCode: vi.fn(),
			storeGeneratedFile,
			now: new Date("2026-05-03T20:11:00.000Z"),
		});

		expect(result?.job.id).toBe(created.job.id);
		expect(result?.files.map((file) => file.mimeType)).toEqual([
			"application/pdf",
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			"text/html",
		]);
		const sourceArtifacts = await db
			.select()
			.from(schema.artifacts)
			.where(eq(schema.artifacts.type, "generated_output"));
		const sourceArtifact = sourceArtifacts.find((artifact) => {
			const metadata = JSON.parse(artifact.metadataJson ?? "{}");
			return metadata.fileProductionJobId === created.job.id;
		});
		expect(sourceArtifact).toBeDefined();
		expect(result?.files.map((file) => file.artifactId)).toEqual([
			sourceArtifact?.id,
			sourceArtifact?.id,
			sourceArtifact?.id,
		]);
		expect(result?.files.map((file) => file.sourceChatFileId)).toEqual([
			"file-document-multi-1",
			"file-document-multi-2",
			"file-document-multi-3",
		]);
		const jobs = await listConversationFileProductionJobs("user-1", "conv-1");
		const listedJob = jobs.find((job) => job.id === created.job.id);
		expect(listedJob?.files.map((file) => file.artifactId)).toEqual([
			sourceArtifact?.id,
			sourceArtifact?.id,
			sourceArtifact?.id,
		]);
		expect(storeGeneratedFile).toHaveBeenCalledTimes(3);
	});

	it("persists generated-document source JSON and readable projection on a generated_output artifact", async () => {
		const { db } = await import("$lib/server/db");
		const { persistGeneratedDocumentSourceArtifact } = await import(
			"./source-persistence"
		);

		const artifact = await persistGeneratedDocumentSourceArtifact({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			fileProductionJobId: "job-document-source",
			title: "Quarterly report",
			source: {
				version: 1,
				template: "alfyai_standard_report",
				title: "Quarterly report",
				subtitle: "Executive summary",
				blocks: [
					{ type: "heading", level: 2, text: "Revenue" },
					{ type: "paragraph", text: "Revenue increased by 12%." },
				],
			},
		});

		const [row] = await db
			.select()
			.from(schema.artifacts)
			.where(eq(schema.artifacts.id, artifact.id));
		const metadata = JSON.parse(row.metadataJson ?? "{}");

		expect(row).toMatchObject({
			type: "generated_output",
			retrievalClass: "ephemeral_followup",
			name: "Quarterly report",
			contentText:
				"Quarterly report\nExecutive summary\n\n## Revenue\nRevenue increased by 12%.",
		});
		expect(metadata).toMatchObject({
			generatedDocumentSourceVersion: 1,
			generatedDocumentSourceStatus: "pending",
			fileProductionJobId: "job-document-source",
			originAssistantMessageId: "assistant-1",
			generatedDocumentSource: {
				version: 1,
				template: "alfyai_standard_report",
				title: "Quarterly report",
			},
		});
	});
});
