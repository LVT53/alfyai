import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import Docker from "dockerode";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../../src/lib/server/db/schema";

const REPO_ROOT = process.cwd();
const ORIGINAL_DATABASE_PATH = process.env.DATABASE_PATH;

const JOURNEY_USER_ID = "journey-user";
const JOURNEY_CONVERSATION_ID = "journey-conversation";
const JOURNEY_ASSISTANT_MESSAGE_ID = "journey-assistant-message";
const JOURNEY_NOW = new Date("2026-05-03T21:00:00.000Z");

let tempRoot: string;
let dbPath: string;

type DockerPingClient = {
	ping: () => Promise<unknown>;
};

const dockerAvailability = await getDockerRuntimeAvailability();

async function getDockerRuntimeAvailability(
	createDockerClient: () => DockerPingClient = () => new Docker(),
): Promise<
	| { available: true; diagnostic: string }
	| { available: false; diagnostic: string }
> {
	try {
		const result = await Promise.race([
			createDockerClient().ping(),
			new Promise<never>((_, reject) => {
				const timeout = setTimeout(
					() => reject(new Error("Dockerode ping timed out after 5000ms")),
					5000,
				);
				timeout.unref?.();
			}),
		]);
		return {
			available: true,
			diagnostic: `Dockerode daemon ping succeeded: ${
				typeof result === "string" ? result : "OK"
			}`,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			available: false,
			diagnostic: `Dockerode daemon ping failed: ${
				message || "Docker daemon is not available"
			}`,
		};
	}
}

function migrateAndSeedJourneyDatabase() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: resolve(REPO_ROOT, "drizzle") });

	db.insert(schema.users)
		.values({
			id: JOURNEY_USER_ID,
			email: "file-production-journey@example.com",
			passwordHash: "hash",
		})
		.run();
	db.insert(schema.conversations)
		.values({
			id: JOURNEY_CONVERSATION_ID,
			userId: JOURNEY_USER_ID,
			title: "File Production Journey",
			createdAt: JOURNEY_NOW,
			updatedAt: JOURNEY_NOW,
		})
		.run();
	db.insert(schema.messages)
		.values([
			{
				id: "journey-user-message",
				conversationId: JOURNEY_CONVERSATION_ID,
				messageSequence: 1,
				role: "user",
				content: "Create a deterministic file production artifact.",
				createdAt: JOURNEY_NOW,
			},
			{
				id: JOURNEY_ASSISTANT_MESSAGE_ID,
				conversationId: JOURNEY_CONVERSATION_ID,
				messageSequence: 2,
				role: "assistant",
				content: "I queued the file production job.",
				createdAt: JOURNEY_NOW,
			},
		])
		.run();

	sqlite.close();
}

function makeFileRouteEvent(mode: "preview" | "download", fileId: string) {
	return {
		request: new Request(`http://localhost/api/chat/files/${fileId}/${mode}`),
		locals: {
			user: {
				id: JOURNEY_USER_ID,
				email: "file-production-journey@example.com",
				role: "user",
			},
		},
		params: { id: fileId },
		url: new URL(`http://localhost/api/chat/files/${fileId}/${mode}`),
		route: { id: `/api/chat/files/[id]/${mode}` },
	} as never;
}

function expectPresent<T>(value: T | null | undefined, seam: string): T {
	if (value == null) {
		throw new Error(`[file-production journey:${seam}] expected a value`);
	}
	return value;
}

async function expectResponseStatus(
	response: Response,
	status: number,
	seam: string,
) {
	if (response.status !== status) {
		throw new Error(
			`[file-production journey:${seam}] expected ${status}, got ${
				response.status
			}: ${await response.clone().text()}`,
		);
	}
}

async function installDeterministicProduceFileToolWake() {
	vi.doMock("$lib/server/services/file-production", async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("../../src/lib/server/services/file-production")
			>();
		return {
			...actual,
			submitFileProductionIntake: (
				input: import("../../src/lib/server/services/file-production").SubmitFileProductionIntakeInput,
			) =>
				actual.submitFileProductionIntake({
					...input,
					wakeWorker: async () => {},
				}),
		};
	});
}

describe("File Production journey gate", () => {
	beforeEach(async () => {
		tempRoot = await mkdtemp(join(tmpdir(), "alfyai-file-production-"));
		dbPath = join(tempRoot, `${randomUUID()}.db`);
		process.env.DATABASE_PATH = dbPath;
		migrateAndSeedJourneyDatabase();
		// Pre-create the python sandbox's read-only bind-mount source (resolved
		// from process.cwd(), which becomes tempRoot below) as the current user.
		// Otherwise Docker auto-creates the missing host path as root the first
		// time a container mounts it, and the afterEach cleanup rm() below can't
		// remove its own tempRoot anymore (EACCES).
		await mkdir(
			join(
				tempRoot,
				"sandbox-python-env",
				"lib",
				"python3.11",
				"site-packages",
			),
			{ recursive: true },
		);
		process.chdir(tempRoot);
		vi.resetModules();
		await installDeterministicProduceFileToolWake();
	});

	afterEach(async () => {
		vi.doUnmock("$lib/server/services/file-production");
		try {
			const { sqlite } = await import("../../src/lib/server/db");
			sqlite.close();
		} catch {
			// The DB module may not have been imported if a test failed early.
		}
		process.chdir(REPO_ROOT);
		if (ORIGINAL_DATABASE_PATH === undefined) {
			delete process.env.DATABASE_PATH;
		} else {
			process.env.DATABASE_PATH = ORIGINAL_DATABASE_PATH;
		}
		await rm(tempRoot, { recursive: true, force: true });
	});

	it("gates program-mode availability on Dockerode rather than Docker CLI context state", async () => {
		const availability = await getDockerRuntimeAvailability(() => ({
			ping: async () => {
				throw new Error("connect ENOENT /var/run/docker.sock");
			},
		}));

		expect(availability).toEqual({
			available: false,
			diagnostic:
				"Dockerode daemon ping failed: connect ENOENT /var/run/docker.sock",
		});
	});

	it("runs a document-source produce_file journey through read-model preview and download", async () => {
		const { createNormalChatTools } = await import(
			"../../src/lib/server/services/normal-chat-tools"
		);
		const {
			assignFileProductionJobsToAssistantMessage,
			drainFileProductionWorker,
		} = await import("$lib/server/services/file-production");
		const { getConversationDetail } = await import(
			"../../src/lib/server/services/conversation-detail/read-model"
		);
		const { GET: previewFile } = await import(
			"../../src/routes/api/chat/files/[id]/preview/+server"
		);
		const { GET: downloadFile } = await import(
			"../../src/routes/api/chat/files/[id]/download/+server"
		);
		const { tools, getToolCalls } = createNormalChatTools({
			userId: JOURNEY_USER_ID,
			conversationId: JOURNEY_CONVERSATION_ID,
			turnId: "journey-turn",
		});

		const toolResult = await tools.produce_file.execute(
			{
				idempotencyKey: "document-source-html",
				requestTitle: "Journey Report",
				requestedOutputs: [{ type: "html" }],
				sourceMode: "document_source",
				documentIntent: "journey gate",
				documentSource: {
					version: 1,
					template: "alfyai_standard_report",
					title: "Journey Report",
					subtitle: "Deterministic document-source coverage",
					blocks: [
						{ type: "heading", text: "Result" },
						{
							type: "paragraph",
							text: "Deterministic acceptance path for Slice 4.",
						},
						{
							type: "table",
							title: "Boundaries",
							headers: ["Boundary", "Expected result"],
							rows: [
								["tool adapter", "queued"],
								["worker", "succeeded"],
								["preview", "served"],
								["download", "served"],
							],
						},
					],
				},
			},
			{
				toolCallId: "call-document-source-html",
				messages: [],
			},
		);

		expect(toolResult).toMatchObject({
			ok: true,
			status: 202,
			jobStatus: "queued",
		});
		expect(getToolCalls()[0]).toMatchObject({
			name: "produce_file",
			metadata: {
				ok: true,
				intakeStatus: 202,
				jobStatus: "queued",
			},
		});
		const jobId = expectPresent(
			"jobId" in toolResult ? toolResult.jobId : null,
			"tool adapter",
		);

		await drainFileProductionWorker({
			workerId: "journey-worker",
			now: new Date("2026-05-03T21:00:01.000Z"),
			syncGeneratedFilesToMemory: async () => {},
		});
		await assignFileProductionJobsToAssistantMessage(
			JOURNEY_USER_ID,
			JOURNEY_CONVERSATION_ID,
			JOURNEY_ASSISTANT_MESSAGE_ID,
			[jobId],
		);

		const detail = await getConversationDetail({
			userId: JOURNEY_USER_ID,
			conversationId: JOURNEY_CONVERSATION_ID,
		});
		const card = expectPresent(
			detail?.fileProductionJobs.find((job) => job.id === jobId),
			"read projection",
		);
		expect(card).toMatchObject({
			id: jobId,
			assistantMessageId: JOURNEY_ASSISTANT_MESSAGE_ID,
			title: "Journey Report",
			status: "succeeded",
			files: [
				expect.objectContaining({
					filename: "journey-report.html",
					mimeType: "text/html",
					downloadUrl: expect.stringContaining("/download"),
					previewUrl: expect.stringContaining("/preview"),
					artifactId: expect.any(String),
					documentFamilyStatus: "active",
					documentRole: "journey gate",
				}),
			],
		});
		const file = expectPresent(card.files[0], "storage");

		const preview = await previewFile(makeFileRouteEvent("preview", file.id));
		await expectResponseStatus(preview, 200, "preview");
		expect(preview.headers.get("Content-Type")).toBe(
			"text/html; charset=utf-8",
		);
		expect(preview.headers.get("Content-Disposition")).toContain(
			'inline; filename="journey-report.html"',
		);
		expect(preview.headers.get("Content-Security-Policy")).toContain(
			"default-src 'none'",
		);
		expect(await preview.text()).toContain(
			"Deterministic acceptance path for Slice 4.",
		);

		const download = await downloadFile(
			makeFileRouteEvent("download", file.id),
		);
		await expectResponseStatus(download, 200, "download");
		expect(download.headers.get("Content-Type")).toBe("text/html");
		expect(download.headers.get("Content-Disposition")).toContain(
			"attachment; filename*=UTF-8''journey-report.html",
		);
		expect(await download.text()).toContain("Journey Report");
	});

	it.skipIf(!dockerAvailability.available)(
		`runs a program-mode produce_file journey through Docker sandbox preview and download${
			dockerAvailability.available
				? ""
				: ` (skipped: ${dockerAvailability.diagnostic})`
		}`,
		async () => {
			const { createNormalChatTools } = await import(
				"../../src/lib/server/services/normal-chat-tools"
			);
			const {
				assignFileProductionJobsToAssistantMessage,
				drainFileProductionWorker,
			} = await import("$lib/server/services/file-production");
			const { getConversationDetail } = await import(
				"../../src/lib/server/services/conversation-detail/read-model"
			);
			const { GET: previewFile } = await import(
				"../../src/routes/api/chat/files/[id]/preview/+server"
			);
			const { GET: downloadFile } = await import(
				"../../src/routes/api/chat/files/[id]/download/+server"
			);
			const { tools } = createNormalChatTools({
				userId: JOURNEY_USER_ID,
				conversationId: JOURNEY_CONVERSATION_ID,
				turnId: "journey-turn-program",
			});

			const toolResult = await tools.produce_file.execute(
				{
					idempotencyKey: "program-csv",
					requestTitle: "Program CSV",
					requestedOutputs: [{ type: "csv" }],
					sourceMode: "program",
					documentIntent: "data export",
					program: {
						language: "python",
						filename: "program-report.csv",
						sourceCode:
							"from pathlib import Path\nPath('/output/program-report.csv').write_text('boundary,status\\ntool adapter,queued\\nworker,succeeded\\npreview,served\\ndownload,served\\n', encoding='utf-8')",
					},
				},
				{
					toolCallId: "call-program-csv",
					messages: [],
				},
			);

			expect(toolResult).toMatchObject({
				ok: true,
				status: 202,
				jobStatus: "queued",
			});
			const jobId = expectPresent(
				"jobId" in toolResult ? toolResult.jobId : null,
				"tool adapter",
			);

			await drainFileProductionWorker({
				workerId: "journey-worker-program",
				now: new Date("2026-05-03T21:05:01.000Z"),
				syncGeneratedFilesToMemory: async () => {},
			});
			await assignFileProductionJobsToAssistantMessage(
				JOURNEY_USER_ID,
				JOURNEY_CONVERSATION_ID,
				JOURNEY_ASSISTANT_MESSAGE_ID,
				[jobId],
			);

			const detail = await getConversationDetail({
				userId: JOURNEY_USER_ID,
				conversationId: JOURNEY_CONVERSATION_ID,
			});
			const card = expectPresent(
				detail?.fileProductionJobs.find((job) => job.id === jobId),
				"read projection",
			);
			expect(card).toMatchObject({
				id: jobId,
				assistantMessageId: JOURNEY_ASSISTANT_MESSAGE_ID,
				title: "Program CSV",
				status: "succeeded",
				files: [
					expect.objectContaining({
						filename: "program-report.csv",
						mimeType: "text/csv",
						downloadUrl: expect.stringContaining("/download"),
						previewUrl: expect.stringContaining("/preview"),
					}),
				],
			});
			const file = expectPresent(card.files[0], "storage");

			const preview = await previewFile(makeFileRouteEvent("preview", file.id));
			await expectResponseStatus(preview, 200, "preview");
			expect(preview.headers.get("Content-Type")).toBe("text/csv");
			expect(await preview.text()).toContain("worker,succeeded");

			const download = await downloadFile(
				makeFileRouteEvent("download", file.id),
			);
			await expectResponseStatus(download, 200, "download");
			expect(download.headers.get("Content-Disposition")).toContain(
				"attachment; filename*=UTF-8''program-report.csv",
			);
			expect(await download.text()).toContain("download,served");
		},
		180_000,
	);
});
