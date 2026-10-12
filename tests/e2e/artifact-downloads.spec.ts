import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import {
	conversations,
	fileProductionJobFiles,
	fileProductionJobs,
	users,
} from "../../src/lib/server/db/schema";
import {
	createArtifact,
	createDocumentArtifact,
} from "../../src/lib/server/services/artifacts";
import { storeGeneratedFile } from "../../src/lib/server/services/chat-files";
import { buildAiSdkUiStreamBody, login, sendMessage } from "./helpers";

/**
 * A download does what it says (friction audit F1; ruling 77).
 *
 * Letöltés ▸ PDF / Word / Markdown used to start an export job that succeeded in
 * under a second and then reached nobody: no download, no card, no row, and the
 * files turned up later as ghost cards inside an unrelated reply. Real clicks, then
 * the browser's own `download` event, the file's name and a body that is the format.
 * The App's `.html` runs a sandbox program, which this Mac (and the gate's server)
 * has no Docker for: its job is the one thing stubbed, and everything the reader
 * meets after it (the poll, the canonical download route, the bytes) is real.
 */

const TITLE = "Bécsi hétvégi útiterv";
const MARKDOWN = [
	`# ${TITLE}`,
	"",
	"Szombat: Naschmarkt, aztán az Albertina.",
	"",
	"- Schönbrunn",
	"- Belvedere",
].join("\n");

async function adminId(): Promise<string> {
	const [user] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, "admin@local"));
	return user.id;
}

async function seedConversation(incognito = false): Promise<string> {
	const conversationId = randomUUID();
	const now = new Date();
	await db.insert(conversations).values({
		id: conversationId,
		userId: await adminId(),
		title: "Download chat",
		memoryIncognito: incognito,
		createdAt: now,
		updatedAt: now,
	});
	return conversationId;
}

async function seedDocument(incognito = false): Promise<{
	conversationId: string;
	artifactId: string;
}> {
	const conversationId = await seedConversation(incognito);
	const created = await createDocumentArtifact({
		userId: await adminId(),
		conversationId,
		title: TITLE,
		markdown: MARKDOWN,
		author: "alfy",
		summary: "Seeded for E2E",
	});
	return { conversationId, artifactId: created.id };
}

const APP_HTML =
	'<!doctype html><html><head><title>Tip</title></head><body><p id="x">tip app</p></body></html>';
const APP_TITLE = "Borravaló-kalkulátor";

async function seedApp(): Promise<{ conversationId: string }> {
	const conversationId = await seedConversation();
	const made = await createArtifact({
		userId: await adminId(),
		conversationId,
		kind: "app",
		title: APP_TITLE,
		body: APP_HTML,
		author: "alfy",
		versionSummary: "Seeded for E2E",
	});
	if (!made.ok) throw new Error(`could not seed the App: ${made.reason}`);
	return { conversationId };
}

/** The job an App's Download would have run in the sandbox, already succeeded: a stored file and the rows that say a job made it. */
async function seedSucceededAppJob(conversationId: string) {
	const userId = await adminId();
	const stored = await storeGeneratedFile(conversationId, userId, {
		filename: "app.html",
		mimeType: "text/html",
		content: Buffer.from(APP_HTML, "utf8"),
		assistantMessageId: null,
	});
	const jobId = randomUUID();
	const now = new Date();
	await db.insert(fileProductionJobs).values({
		id: jobId,
		conversationId,
		assistantMessageId: null,
		userId,
		title: `${APP_TITLE} — app source`,
		status: "succeeded",
		origin: "artifact_export",
		sourceMode: "program",
		createdAt: now,
		updatedAt: now,
		completedAt: now,
	});
	await db.insert(fileProductionJobFiles).values({
		id: randomUUID(),
		jobId,
		chatGeneratedFileId: stored.id,
		sortOrder: 0,
		createdAt: now,
	});
	return { jobId, job: jobDto(jobId, conversationId, "queued") };
}

function jobDto(
	id: string,
	conversationId: string,
	status: "queued" | "failed",
) {
	return {
		id,
		conversationId,
		assistantMessageId: null,
		title: `${APP_TITLE} — app source`,
		status,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		files: [],
		warnings: [],
		dismissed: false,
		sourceMode: "program",
		error:
			status === "failed"
				? {
						code: "sandbox_unavailable",
						message: "no sandbox",
						retryable: true,
					}
				: null,
	};
}

/** The item the chat made, opened from the chat's own list. */
async function openItem(page: Page, conversationId: string, name: string) {
	await login(page);
	await page.goto(`/chat/${conversationId}`, { waitUntil: "networkidle" });
	await page.getByTestId("artifact-count-button").click();
	await page
		.getByTestId("artifact-panel-list")
		.getByTestId("artifact-row")
		.filter({ hasText: name })
		.click();
	await expect(
		page.locator('[data-testid="artifact-panel-title"]:visible'),
	).toHaveCount(1, { timeout: 30_000 });
}

async function openDocument(page: Page, conversationId: string) {
	await openItem(page, conversationId, TITLE);
}

async function pressDownload(page: Page) {
	await page
		.locator('[data-testid="artifact-download-button"]:visible')
		.click();
}

async function chooseFormat(page: Page, name: "PDF" | "Word" | "Markdown") {
	await pressDownload(page);
	const popover = page.getByTestId("document-download-popover");
	await expect(popover).toBeVisible();
	await popover.getByRole("button", { name, exact: true }).click();
	return popover;
}

async function bytesOf(download: {
	createReadStream(): Promise<NodeJS.ReadableStream | null>;
}): Promise<Buffer> {
	const stream = await download.createReadStream();
	if (!stream) throw new Error("the download has no body");
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks);
}

test.describe("the Document's Download", () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
	});

	// The report renderers name PDF and Word after the title as a plain ASCII
	// slug, the Markdown file after the title as it is written.
	const formats = [
		{
			name: "PDF" as const,
			filename: "becsi-hetvegi-utiterv.pdf",
			check: (bytes: Buffer) =>
				expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-"),
		},
		{
			name: "Word" as const,
			filename: "becsi-hetvegi-utiterv.docx",
			// A .docx is a zip: "PK".
			check: (bytes: Buffer) =>
				expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK"),
		},
		{
			name: "Markdown" as const,
			filename: `${TITLE}.md`,
			check: (bytes: Buffer) => {
				const text = bytes.toString("utf8");
				expect(text).toContain("Szombat: Naschmarkt");
				expect(text).toContain("Belvedere");
			},
		},
	];

	for (const format of formats) {
		test(`a real click on ${format.name} ends in a download of the right name and bytes`, async ({
			page,
		}) => {
			const { conversationId } = await seedDocument();
			await openDocument(page, conversationId);

			const downloaded = page.waitForEvent("download", { timeout: 20_000 });
			await chooseFormat(page, format.name);
			const download = await downloaded;

			expect(download.suggestedFilename().normalize("NFC")).toBe(
				format.filename.normalize("NFC"),
			);
			const bytes = await bytesOf(download);
			expect(bytes.length).toBeGreaterThan(0);
			format.check(bytes);
		});
	}

	test("the popover says it is preparing until the file is ready, then the file downloads and the popover goes", async ({
		page,
	}) => {
		const { conversationId } = await seedDocument();
		await openDocument(page, conversationId);

		// The poll is held, so "not ready yet" lasts as long as the test looks at it.
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		await page.route("**/api/chat/files/jobs/*", async (route) => {
			if (route.request().method() !== "GET") return route.fallback();
			await held;
			await route.continue();
		});
		let downloadStarted = false;
		page.on("download", () => {
			downloadStarted = true;
		});

		const downloaded = page.waitForEvent("download", { timeout: 20_000 });
		const popover = await chooseFormat(page, "PDF");

		await expect(popover.getByRole("status")).toHaveText(
			"Preparing your file…",
		);
		await expect(
			popover.getByRole("button", { name: "PDF", exact: true }),
		).toBeDisabled();
		expect(downloadStarted).toBe(false);

		release();
		await downloaded;
		await expect(popover).toHaveCount(0);
	});

	test("a job that failed is said so, with Try again, and nothing downloads", async ({
		page,
	}) => {
		const { conversationId } = await seedDocument();
		await openDocument(page, conversationId);
		let downloadStarted = false;
		page.on("download", () => {
			downloadStarted = true;
		});
		// The job runs for real; what the poll hears is that it failed.
		await page.route("**/api/chat/files/jobs/*", async (route) => {
			if (route.request().method() !== "GET") return route.fallback();
			const real = (await (await route.fetch()).json()) as {
				job: Record<string, unknown>;
			};
			await route.fulfill({
				json: {
					job: {
						...real.job,
						status: "failed",
						files: [],
						error: { code: "render_failed", message: "x", retryable: true },
					},
				},
			});
		});

		const popover = await chooseFormat(page, "Markdown");

		await expect(popover.getByRole("alert")).toHaveText(
			"Could not create this file.",
		);
		await popover.getByRole("button", { name: "Try again" }).click();
		await expect(
			popover.getByRole("button", { name: "Markdown", exact: true }),
		).toBeVisible();
		expect(downloadStarted).toBe(false);
	});

	test("an incognito chat's Document downloads too: the export names the chat it is read from", async ({
		page,
	}) => {
		const { conversationId } = await seedDocument(true);
		await openDocument(page, conversationId);

		const exportRequest = page.waitForRequest((request) =>
			/\/api\/artifacts\/[^/]+\/export/.test(request.url()),
		);
		const downloaded = page.waitForEvent("download", { timeout: 20_000 });
		await chooseFormat(page, "Markdown");

		expect(
			new URL((await exportRequest).url()).searchParams.get("conversationId"),
		).toBe(conversationId);
		expect((await downloaded).suggestedFilename().normalize("NFC")).toBe(
			`${TITLE}.md`.normalize("NFC"),
		);
	});

	test("the export belongs to no reply: no job of it hangs from one, and the next reply is handed no card for it (F1's ghosts)", async ({
		page,
	}) => {
		const { conversationId } = await seedDocument();
		await openDocument(page, conversationId);
		for (const name of ["Markdown", "PDF"] as const) {
			const downloaded = page.waitForEvent("download", { timeout: 20_000 });
			await chooseFormat(page, name);
			await downloaded;
		}
		const jobs = await db
			.select({
				assistantMessageId: fileProductionJobs.assistantMessageId,
				origin: fileProductionJobs.origin,
			})
			.from(fileProductionJobs)
			.where(
				and(
					eq(fileProductionJobs.conversationId, conversationId),
					eq(fileProductionJobs.status, "succeeded"),
				),
			);
		expect(jobs).toHaveLength(2);
		expect(jobs.every((job) => job.assistantMessageId === null)).toBe(true);
		expect(jobs.every((job) => job.origin === "artifact_export")).toBe(true);

		// The chat page hears the end of a turn and used to stamp every job of the
		// conversation that hung from no reply onto it. A reload puts the jobs the
		// server lists into the page, a stream's end then names its reply.
		await page.reload({ waitUntil: "networkidle" });
		await page.route("**/api/chat/stream", async (route) => {
			await route.fulfill({
				status: 200,
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
				},
				body: buildAiSdkUiStreamBody("Hello there from the stub", {
					assistantMessageId: randomUUID(),
					userMessageId: randomUUID(),
					totalTokens: 12,
				}),
			});
		});
		await sendMessage(page, "Say hello");
		await expect(page.getByTestId("assistant-message").last()).toContainText(
			"Hello there from the stub",
		);
		// Give the end-of-turn handlers their moment, then look for what must not be there.
		await expect
			.poll(async () => page.getByTestId("file-production-card").count(), {
				timeout: 3_000,
			})
			.toBe(0);
		await expect(page.getByTestId("file-production-card")).toHaveCount(0);
	});
});

test.describe("the App's Download", () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
	});

	async function openAppDownload(page: Page, conversationId: string) {
		await openItem(page, conversationId, APP_TITLE);
		await pressDownload(page);
		const popover = page.getByTestId("app-download-popover");
		await expect(popover).toBeVisible();
		return popover;
	}

	test("a real click on the HTML file ends in a download of the app's own file", async ({
		page,
	}) => {
		const { conversationId } = await seedApp();
		const { job } = await seedSucceededAppJob(conversationId);
		await page.route("**/api/artifacts/*/app/download", async (route) => {
			await route.fulfill({
				status: 202,
				json: { ok: true, job, reused: false },
			});
		});

		const popover = await openAppDownload(page, conversationId);
		const downloaded = page.waitForEvent("download", { timeout: 20_000 });
		await popover.getByRole("button", { name: "HTML file" }).click();
		const download = await downloaded;

		expect(download.suggestedFilename()).toBe("app.html");
		expect((await bytesOf(download)).toString("utf8")).toBe(APP_HTML);
		await expect(popover).toHaveCount(0);
	});

	test("a sandbox run that failed is said so, with Try again, and nothing downloads", async ({
		page,
	}) => {
		const { conversationId } = await seedApp();
		await page.route("**/api/artifacts/*/app/download", async (route) => {
			await route.fulfill({
				status: 202,
				json: {
					ok: true,
					job: jobDto("job-failed", conversationId, "failed"),
					reused: false,
				},
			});
		});
		let downloadStarted = false;
		page.on("download", () => {
			downloadStarted = true;
		});

		const popover = await openAppDownload(page, conversationId);
		await popover.getByRole("button", { name: "HTML file" }).click();

		await expect(popover.getByRole("alert")).toHaveText(
			"Could not prepare this app for download.",
		);
		await expect(
			popover.getByRole("button", { name: "Try again" }),
		).toBeVisible();
		expect(downloadStarted).toBe(false);
	});
});
