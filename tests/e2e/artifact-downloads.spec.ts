import { randomUUID } from "node:crypto";
import { expect, type Page, type Response, test } from "@playwright/test";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import {
	fileProductionJobFiles,
	fileProductionJobs,
} from "../../src/lib/server/db/schema";
import { updateArtifactBody } from "../../src/lib/server/services/artifacts";
import {
	APP_HTML,
	APP_TITLE,
	adminId,
	bytesOf,
	cleanUpConversation,
	jobDto,
	seedApp,
	seedDocument,
	seedSucceededAppJob,
	TITLE,
} from "./artifact-download-helpers";
import { buildAiSdkUiStreamBody, login, sendMessage } from "./helpers";

/**
 * A download does what it says (friction audit F1, F30; ruling 77).
 *
 * Letöltés ▸ PDF / Word / Markdown used to start an export job that succeeded in
 * under a second and then reached nobody: no download, no card, no row, and the
 * files turned up later as ghost cards inside an unrelated reply. Real clicks, then
 * the browser's own `download` event, the file's name and a body that is the format.
 * The App's `.html` runs a sandbox program, which this Mac (and the gate's server)
 * has no Docker for: its job is the one thing stubbed, and everything the reader
 * meets after it (the poll, the canonical download route, the bytes) is real.
 */

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

/** What each test seeded, taken out again afterwards: the next spec on this worker's database must not meet it. */
const made: string[] = [];
async function track<T extends { conversationId: string }>(
	seeded: Promise<T>,
): Promise<T> {
	const value = await seeded;
	made.push(value.conversationId);
	return value;
}

test.afterEach(async () => {
	for (const conversationId of made.splice(0)) {
		await cleanUpConversation(conversationId);
	}
});

test.describe("the Document's Download", () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
	});

	// Every format is named after the title as the reader wrote it (RC-A: PDF and Word
	// used to come out as an ASCII slug, Markdown alone kept the accents).
	const formats = [
		{
			name: "PDF" as const,
			filename: `${TITLE}.pdf`,
			check: (bytes: Buffer) =>
				expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-"),
		},
		{
			name: "Word" as const,
			filename: `${TITLE}.docx`,
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
			const { conversationId } = await track(seedDocument());
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
		const { conversationId } = await track(seedDocument());
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
		const { conversationId } = await track(seedDocument());
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

	// FB-8 (FB-1's concern 1): the same item, as it is now, in the same format is the
	// same file. Every press used to make a new job and a new file.
	test("a repeated press for the same version and format downloads the file it made, and a changed Document makes a new one", async ({
		page,
	}) => {
		const { conversationId, artifactId } = await track(seedDocument());
		await openDocument(page, conversationId);
		const exportJobs = () =>
			db
				.select({
					id: fileProductionJobs.id,
					status: fileProductionJobs.status,
				})
				.from(fileProductionJobs)
				.where(eq(fileProductionJobs.conversationId, conversationId));

		async function press(name: "PDF" | "Word" | "Markdown") {
			const downloaded = page.waitForEvent("download", { timeout: 20_000 });
			await chooseFormat(page, name);
			return (await downloaded).url();
		}

		const first = await press("PDF");
		const again = await press("PDF");
		// The same file of the same job, by the canonical route.
		expect(again).toBe(first);
		expect(first).toMatch(/\/api\/chat\/files\/[^/]+\/download$/);
		expect(await exportJobs()).toHaveLength(1);

		// Another format is another file.
		const markdown = await press("Markdown");
		expect(markdown).not.toBe(first);
		expect(await exportJobs()).toHaveLength(2);

		// An edit that keeps the version number (the reader's own save coalesces into
		// it) is still a new file: what the PDF is made of changed.
		await updateArtifactBody({
			userId: await adminId(),
			artifactId,
			conversationId,
			body: "Szombat: Naschmarkt, aztán a Hofburg.",
			author: "user",
			summary: "Edited",
		});
		const afterEdit = await press("PDF");
		expect(afterEdit).not.toBe(first);
		expect(await exportJobs()).toHaveLength(3);
	});

	test("a press after a job that failed makes a new one: the failure is not handed back for ever", async ({
		page,
	}) => {
		const { conversationId } = await track(seedDocument());
		await openDocument(page, conversationId);
		const first = page.waitForEvent("download", { timeout: 20_000 });
		await chooseFormat(page, "PDF");
		const firstUrl = (await first).url();

		// What an earlier press left: its job failed (no renderer, a timeout).
		await db
			.update(fileProductionJobs)
			.set({ status: "failed", retryable: false, errorCode: "render_failed" })
			.where(eq(fileProductionJobs.conversationId, conversationId));
		await db
			.delete(fileProductionJobFiles)
			.where(
				inArray(
					fileProductionJobFiles.jobId,
					db
						.select({ id: fileProductionJobs.id })
						.from(fileProductionJobs)
						.where(eq(fileProductionJobs.conversationId, conversationId)),
				),
			);

		const second = page.waitForEvent("download", { timeout: 20_000 });
		await chooseFormat(page, "PDF");
		const secondUrl = (await second).url();
		expect(secondUrl).not.toBe(firstUrl);
		const jobs = await db
			.select({ status: fileProductionJobs.status })
			.from(fileProductionJobs)
			.where(eq(fileProductionJobs.conversationId, conversationId));
		expect(jobs.map((job) => job.status).sort()).toEqual([
			"failed",
			"succeeded",
		]);
	});

	test("a failure after the reader closed the popover is told in a toast, never silence (FB-1's concern 4)", async ({
		page,
	}) => {
		const { conversationId } = await track(seedDocument());
		await openDocument(page, conversationId);
		let downloadStarted = false;
		page.on("download", () => {
			downloadStarted = true;
		});
		// The poll is held while the reader closes the popover; then it answers that
		// the job failed. The popover is gone by then: nothing else could say so.
		let fail!: () => void;
		const failing = new Promise<void>((resolve) => {
			fail = resolve;
		});
		await page.route("**/api/chat/files/jobs/*", async (route) => {
			if (route.request().method() !== "GET") return route.fallback();
			await failing;
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

		const popover = await chooseFormat(page, "PDF");
		await expect(popover.getByRole("status")).toHaveText(
			"Preparing your file…",
		);
		await page.keyboard.press("Escape");
		await expect(popover).toHaveCount(0);
		await expect(page.getByTestId("toast-entry")).toHaveCount(0);

		fail();
		await expect(page.getByTestId("toast-entry")).toHaveText(
			"Could not create this file.",
		);
		expect(downloadStarted).toBe(false);
	});

	test("an incognito chat's Document downloads too: the export names the chat it is read from", async ({
		page,
	}) => {
		const { conversationId } = await track(seedDocument({ incognito: true }));
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

	test("a download's own requests all answer well: no probe that is meant to fail (F30)", async ({
		page,
	}) => {
		const { conversationId } = await track(seedDocument());
		await openDocument(page, conversationId);

		const refused: string[] = [];
		const watch = (response: Response) => {
			if (response.status() >= 400) {
				refused.push(`${response.status()} ${response.url()}`);
			}
		};
		page.on("response", watch);
		const downloaded = page.waitForEvent("download", { timeout: 20_000 });
		await chooseFormat(page, "Markdown");
		await downloaded;
		page.off("response", watch);

		expect(refused).toEqual([]);
	});

	test("the export belongs to no reply: no job of it hangs from one, and the next reply is handed no card for it (F1's ghosts)", async ({
		page,
	}) => {
		const { conversationId } = await track(seedDocument());
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

test.describe("a job that hung from no reply before a turn", () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
	});

	// What an earlier Download left (before exports belonged to no reply), or a job
	// whose intake failed: unassigned, from an hour ago. The page stamped every such
	// job of the conversation on the reply that finished, so it came back as a card
	// of a reply that never made it, until the next reload.
	test("is not handed to the next reply as its card", async ({ page }) => {
		const { conversationId } = await track(seedDocument());
		const hourAgo = new Date(Date.now() - 3_600_000);
		await db.insert(fileProductionJobs).values({
			id: randomUUID(),
			conversationId,
			assistantMessageId: null,
			userId: await adminId(),
			title: "An export from an hour ago",
			status: "failed",
			origin: "unified_produce",
			errorCode: "render_failed",
			errorMessage: "It did not work.",
			retryable: false,
			sourceMode: "document_source",
			createdAt: hourAgo,
			updatedAt: hourAgo,
			completedAt: hourAgo,
		});

		await login(page);
		await page.goto(`/chat/${conversationId}`, { waitUntil: "networkidle" });
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
		const { conversationId } = await track(seedApp());
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
		const { conversationId } = await track(seedApp());
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
