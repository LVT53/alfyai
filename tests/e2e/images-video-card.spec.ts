import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { db } from "../../src/lib/server/db";
import {
	conversations,
	messages,
	users,
	videoJobs,
} from "../../src/lib/server/db/schema";
import {
	createFakeComfyUi,
	type FakeComfyUi,
} from "../../src/lib/server/services/images/comfyui/testing/fake-comfyui";
import { storeImageFile } from "../../src/lib/server/services/images/files";
import { enqueueVideoTake } from "../../src/lib/server/services/images/video/video-job";
import { e2eBaseUrl, e2eSlot } from "./e2e-env";
import { clearAdminConfig, login, waitForStableBoundingBox } from "./helpers";

// The video card in the chat, its player and its two downloads (video plan,
// slice 3): the browser half the pipeline spec does not touch.
//
// A ready clip is seeded the way `images-video.spec.ts` seeds one — the real job
// engine claims the take, the real runner renders it against a fake ComfyUI on a
// loopback port and stores the mp4 with its poster — then a `make_video` tool
// call is written into a message, which is what makes the chat draw the card.
// No chat turn and no model are involved.
//
// The spec file owns its own conversation and file folder and takes them away
// again. The e2e servers share one database with this process, so the rows are
// inserted through the same services the app uses.

const CONFIG_KEYS = ["COMFYUI_LTX_URL"] as const;
const TOOL_CALL_ID = "e2e-video-card-call";

let fake: FakeComfyUi | undefined;
let userId: string;
let conversationId: string;
let takeId: string;
let fileId: string;

async function adminId(): Promise<string> {
	const [user] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, "admin@local"));
	if (!user) throw new Error("No seeded admin");
	return user.id;
}

async function storeStill(): Promise<string> {
	const png = await sharp({
		create: {
			width: 1920,
			height: 1080,
			channels: 3,
			background: { r: 40, g: 90, b: 140 },
		},
	})
		.png()
		.toBuffer();
	const file = await storeImageFile({
		userId,
		conversationId,
		role: "input",
		png,
	});
	return file.id;
}

/** Polls the take row the server owns until it settles, like the pipeline spec does. */
async function waitForTake(id: string) {
	const deadline = Date.now() + 45_000;
	for (;;) {
		const [row] = await db.select().from(videoJobs).where(eq(videoJobs.id, id));
		if (row && ["succeeded", "failed", "cancelled"].includes(row.status)) {
			return row;
		}
		if (Date.now() > deadline) {
			throw new Error(
				`The take never settled; last status ${row?.status ?? "missing"}${
					row?.errorMessage ? `: ${row.errorMessage}` : ""
				}`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

/** A message whose `make_video` call names the take's card, as the tool writes it. */
async function seedCardMessage(id: string, callId: string): Promise<void> {
	const now = new Date();
	await db.insert(messages).values([
		{
			id: randomUUID(),
			conversationId,
			messageSequence: 1,
			role: "user",
			content: "Make this picture a short clip.",
			createdAt: now,
		},
		{
			id: randomUUID(),
			conversationId,
			messageSequence: 2,
			role: "assistant",
			content: "Here is your clip.",
			toolCalls: JSON.stringify([
				{
					type: "tool_call",
					callId,
					name: "make_video",
					input: {
						prompt: "the harbour at dusk, a slow tide",
						picture: "1",
						title: "Harbour at dusk",
						durationSeconds: 5,
					},
					status: "done",
					outputSummary: "Made Harbour at dusk",
					metadata: {
						videoTakeId: id,
						videoCardId: id,
						videoTitle: "Harbour at dusk",
						videoDurationSeconds: 5,
						videoWidth: 1280,
						videoHeight: 704,
					},
				},
			]),
			createdAt: now,
		},
	]);
}

async function openChat(page: Page): Promise<void> {
	await page.goto(`/chat/${conversationId}`, { waitUntil: "domcontentloaded" });
	await expect(page.getByTestId("artifact-card").first()).toBeVisible({
		timeout: 20_000,
	});
	// The e2e server has a few optional services off, so the admin gets the
	// degraded-capabilities banner over the top of the chat. It is dismissed for
	// this session; the card's own top strip must not be under it when the spec
	// presses the duration chip.
	// Only on the expanded layout: in the phone drawer the strip's wrapped
	// Hide sits under the fixed chrome, and the spec only measures there.
	const banner = page.getByTestId("degraded-capabilities-banner");
	if ((page.viewportSize()?.width ?? 0) >= 768 && (await banner.isVisible())) {
		await banner.getByRole("button").click();
	}
}

/** The card's player, once the card body has loaded it. */
function player(page: Page) {
	return page.getByTestId("video-card-player");
}

function media(page: Page) {
	return page.getByTestId("video-player-media");
}

test.beforeAll(async ({ browser }) => {
	const context = await browser.newContext({
		baseURL: e2eBaseUrl(e2eSlot()),
	});
	const page = await context.newPage();
	try {
		await login(page);
		userId = await adminId();
		fake = await createFakeComfyUi();
		const saved = await page.request.put("/api/admin/config", {
			data: { COMFYUI_LTX_URL: fake.baseUrl },
		});
		expect(saved.ok(), `video server set -> ${saved.status()}`).toBe(true);

		const created = await page.evaluate(async () => {
			const response = await fetch("/api/conversations", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title: "A video card" }),
			});
			if (!response.ok)
				throw new Error(`create conversation ${response.status}`);
			return ((await response.json()) as { id: string }).id;
		});
		conversationId = created;
		const stillId = await storeStill();
		const queued = await enqueueVideoTake({
			userId,
			conversationId,
			artifactId: null,
			toolCallId: TOOL_CALL_ID,
			origin: "turn",
			retryOf: null,
			request: {
				v: 1,
				prompt: "the harbour at dusk, a slow tide",
				durationSeconds: 5,
				sourceFileId: stillId,
				title: "Harbour at dusk",
				summary: null,
				artifactId: null,
			},
			seed: 1001,
		});
		takeId = queued.takeId;
		const take = await waitForTake(takeId);
		expect(take.status, take.errorMessage ?? "").toBe("succeeded");
		expect(take.resultFileId).not.toBeNull();
		fileId = take.resultFileId as string;
		await seedCardMessage(takeId, TOOL_CALL_ID);
	} finally {
		await context.close();
	}
});

test.afterAll(async ({ browser }) => {
	try {
		if (conversationId) {
			await db
				.delete(conversations)
				.where(eq(conversations.id, conversationId));
			await rm(join(process.cwd(), "data", "image-files", conversationId), {
				recursive: true,
				force: true,
			});
		}
	} finally {
		const context = await browser.newContext({
			baseURL: e2eBaseUrl(e2eSlot()),
		});
		const page = await context.newPage();
		try {
			await login(page);
			await clearAdminConfig(page, [...CONFIG_KEYS]);
		} finally {
			await context.close();
			await fake?.close();
		}
	}
});

test.beforeEach(async ({ page }) => {
	await login(page);
	// The card's words are the English ones: a previous file on this worker may
	// have left the person in Hungarian (a failed run does not clean up).
	const language = await page.request.patch("/api/settings/preferences", {
		data: { uiLanguage: "en" },
	});
	expect(language.ok(), `language -> ${language.status()}`).toBe(true);
});

test("the card holds its box, and the player plays, seeks, loops and lets go of Tab", async ({
	page,
}) => {
	// Hold the poster until the test has seen the box without it: the stage's
	// shape is reserved before a single pixel paints.
	let releasePoster!: () => void;
	const posterGate = new Promise<void>((resolve) => {
		releasePoster = resolve;
	});
	let posterServed = false;
	await page.route(
		/\/api\/images\/files\/[^/?]+\?variant=poster/,
		async (route) => {
			await posterGate;
			await route.continue();
			posterServed = true;
		},
	);

	await openChat(page);
	const card = page.getByTestId("artifact-card").first();
	const head = card.getByTestId("artifact-card-head");
	await expect(head).toContainText("Harbour at dusk");
	await expect(head).toContainText("Video");
	await expect(card.getByTestId("video-card-badge")).toHaveText("VIDEO");
	await expect(card.getByTestId("video-card-duration")).toHaveText("0:05");

	const stage = card.getByTestId("video-card-stage");
	await expect(stage).toBeVisible();
	// The chat opens scrolled to its bottom; centre the clip so its top strip is
	// clear of the page chrome (the duration chip lives there).
	await stage.evaluate((element) =>
		element.scrollIntoView({ block: "center" }),
	);
	await waitForStableBoundingBox(stage);
	const beforePoster = await stage.boundingBox();
	expect(beforePoster?.width ?? 0).toBeGreaterThan(0);
	expect(beforePoster?.height ?? 0).toBeGreaterThan(0);
	expect(posterServed).toBe(false);

	releasePoster();
	await expect.poll(() => posterServed, { timeout: 10_000 }).toBe(true);
	await expect
		.poll(
			() => media(page).evaluate((video: HTMLVideoElement) => video.readyState),
			{
				timeout: 10_000,
			},
		)
		.toBeGreaterThanOrEqual(1);
	await waitForStableBoundingBox(stage);
	const afterPoster = await stage.boundingBox();
	expect(
		Math.abs((afterPoster?.width ?? 0) - (beforePoster?.width ?? 0)),
	).toBeLessThanOrEqual(1);
	expect(
		Math.abs((afterPoster?.height ?? 0) - (beforePoster?.height ?? 0)),
	).toBeLessThanOrEqual(1);

	// A press on the clip's top-right — where the duration chip lies — is a press
	// on the clip, not a dead spot.
	const chip = await card.getByTestId("video-card-duration").boundingBox();
	expect(chip).not.toBeNull();
	const chipCentre = {
		x: (chip?.x ?? 0) + (chip?.width ?? 0) / 2,
		y: (chip?.y ?? 0) + (chip?.height ?? 0) / 2,
	};
	// The chip is a label, not a target: the element at its own centre is the
	// clip underneath it.
	expect(
		await page.evaluate(
			({ x, y }) => document.elementFromPoint(x, y)?.tagName,
			chipCentre,
		),
	).toBe("VIDEO");
	await page.mouse.click(chipCentre.x, chipCentre.y);
	await expect
		.poll(
			() => media(page).evaluate((video: HTMLVideoElement) => video.paused),
			{
				timeout: 5_000,
			},
		)
		.toBe(false);

	// Space pauses from the player's own button: the button keeps its activation.
	await page.getByTestId("video-player-toggle").focus();
	await page.keyboard.press("Space");
	await expect
		.poll(() => media(page).evaluate((video: HTMLVideoElement) => video.paused))
		.toBe(true);

	// → seeks one second forward from wherever the clip is.
	await media(page).evaluate((video: HTMLVideoElement) => {
		video.currentTime = 1;
	});
	await page.keyboard.press("ArrowRight");
	await expect
		.poll(() =>
			media(page).evaluate((video: HTMLVideoElement) => video.currentTime),
		)
		.toBeGreaterThan(1.5);

	// Loop starts on, one press turns it off, and the change is announced.
	expect(
		await media(page).evaluate((video: HTMLVideoElement) => video.loop),
	).toBe(true);
	await page.keyboard.press("l");
	await expect
		.poll(() => media(page).evaluate((video: HTMLVideoElement) => video.loop))
		.toBe(false);
	await expect(page.getByTestId("video-player-status")).toHaveText("Loop off");

	// Tab reaches both player buttons, and leaves the player after them.
	const toggle = page.getByTestId("video-player-toggle");
	const fullscreen = page.getByTestId("video-player-fullscreen");
	await toggle.focus();
	await page.keyboard.press("Tab");
	await expect(fullscreen).toBeFocused();
	await page.keyboard.press("Shift+Tab");
	await expect(toggle).toBeFocused();
	await page.keyboard.press("Tab");
	await page.keyboard.press("Tab");
	await expect(fullscreen).not.toBeFocused();

	// Leaving the chat pauses the clip: listen for the pause the unmount makes,
	// then navigate away client-side.
	await toggle.focus();
	await page.keyboard.press("Space");
	await expect
		.poll(
			() => media(page).evaluate((video: HTMLVideoElement) => video.paused),
			{
				timeout: 5_000,
			},
		)
		.toBe(false);
	await media(page).evaluate((video: HTMLVideoElement) => {
		(window as unknown as { __pausedOnLeave: number }).__pausedOnLeave = 0;
		video.addEventListener("pause", () => {
			(window as unknown as { __pausedOnLeave: number }).__pausedOnLeave += 1;
		});
	});
	await page.getByTestId("new-conversation").click();
	await page.waitForURL((url) => url.pathname === "/");
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					(window as unknown as { __pausedOnLeave?: number }).__pausedOnLeave ??
					0,
			),
		)
		.toBeGreaterThan(0);
});

test("the GIF download answers an attachment image/gif, and the mp4 still answers video/mp4", async ({
	page,
}) => {
	const gif = await page.request.get(
		`/api/images/files/${fileId}?download=1&format=gif`,
	);
	expect(gif.status()).toBe(200);
	expect(gif.headers()["content-type"]).toContain("image/gif");
	expect(gif.headers()["content-disposition"]).toMatch(/^attachment;/);
	expect((await gif.body()).byteLength).toBeGreaterThan(100);

	const mp4 = await page.request.get(`/api/images/files/${fileId}?download=1`);
	expect(mp4.status()).toBe(200);
	expect(mp4.headers()["content-type"]).toContain("video/mp4");
});

test("a failed GIF says so, and its row is busy while the GIF is made", async ({
	page,
}) => {
	await openChat(page);
	await page.getByTestId(`video-card-more-${takeId}`).click();
	const gifRow = page.getByTestId("video-card-download-gif");
	await expect(gifRow).toBeVisible();

	let releaseGif!: () => void;
	const gifGate = new Promise<void>((resolve) => {
		releaseGif = resolve;
	});
	await page.route(/format=gif/, async (route) => {
		await gifGate;
		await route.fulfill({
			status: 503,
			contentType: "application/json",
			body: JSON.stringify({ error: "video_media_unavailable" }),
		});
	});

	await gifRow.click();
	// The menu stays open and the row wears the card's own disabled look while a
	// first GIF is made (seconds of ffmpeg), so the wait is visible.
	await expect(gifRow).toBeDisabled();
	await expect(page.getByTestId("video-card-menu")).toBeVisible();

	releaseGif();
	await expect(page.getByTestId("toast-entry")).toContainText(
		"That didn't work. Try again in a moment.",
	);
	await expect(page.getByTestId("video-card-menu")).toBeHidden();
});

test("the player's and the card's buttons are 44 px targets on a coarse pointer", async ({
	browser,
	baseURL,
}) => {
	const context = await browser.newContext({
		baseURL,
		viewport: { width: 390, height: 844 },
		hasTouch: true,
		isMobile: true,
	});
	const page = await context.newPage();
	try {
		await login(page);
		const language = await page.request.patch("/api/settings/preferences", {
			data: { uiLanguage: "en" },
		});
		expect(language.ok(), `language -> ${language.status()}`).toBe(true);
		await openChat(page);
		await expect(player(page)).toBeVisible();
		const targets = [
			page.getByTestId("video-player-toggle"),
			page.getByTestId("video-player-fullscreen"),
			page.getByTestId(`video-card-more-${takeId}`),
			page.getByTestId("video-card-another"),
		];
		for (const target of targets) {
			const box = await target.boundingBox();
			expect(box, await target.getAttribute("data-testid")).not.toBeNull();
			expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
			expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
		}
	} finally {
		await context.close();
	}
});
