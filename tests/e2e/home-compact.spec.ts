import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { GREETING_MAX_LINE_CHARS } from "../../src/lib/client/home/greeting";
import { db } from "../../src/lib/server/db";
import {
	atlasJobs,
	conversations,
	homeSuggestionEvents,
	usageEvents,
	users,
} from "../../src/lib/server/db/schema";
import { createConversation as createServerConversation } from "../../src/lib/server/services/conversations";
import { createMessage } from "../../src/lib/server/services/messages";
import { login, TEST_EMAIL } from "./helpers";

/**
 * The chat home rebuilt to HomeV4A "Compact", with the owner's one change: the
 * suggestion chips sit on their own row under the composer rather than inside
 * its footer.
 *
 * Every strip here is seeded directly into the database rather than produced by
 * a real turn — the point of these tests is what the home screen draws from the
 * summary, not how the rows got there.
 */

const SEEDED = {
	atlasConversation: "Atlas report on EU battery rules",
	plainConversation: "Nextcloud folder clean-up plan",
	runningJob: "Hungarian EV charging subsidies, 2024-2026",
};

async function adminUserId(): Promise<string> {
	const [row] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, TEST_EMAIL))
		.limit(1);
	if (!row) throw new Error(`Seeded user ${TEST_EMAIL} not found`);
	return row.id;
}

async function clearHomeFixtures(userId: string) {
	await db.delete(atlasJobs).where(eq(atlasJobs.userId, userId));
	await db.delete(usageEvents).where(eq(usageEvents.userId, userId));
	await db
		.delete(homeSuggestionEvents)
		.where(eq(homeSuggestionEvents.userId, userId));
	await db.delete(conversations).where(eq(conversations.userId, userId));
}

/** Two conversations with turns, one of which finished an Atlas report. */
async function seedRecent(userId: string): Promise<{
	atlasConversationId: string;
	plainConversationId: string;
}> {
	const plain = await createServerConversation(
		userId,
		SEEDED.plainConversation,
	);
	await createMessage(plain.id, "user", "Which folders can go?");
	await createMessage(plain.id, "assistant", "These three.");

	const atlas = await createServerConversation(
		userId,
		SEEDED.atlasConversation,
	);
	await createMessage(atlas.id, "user", "Research EU battery rules.");
	await createMessage(atlas.id, "assistant", "Here is the report.");
	await db.insert(atlasJobs).values({
		id: randomUUID(),
		userId,
		conversationId: atlas.id,
		action: "create",
		profile: "overview",
		normalizedQueryHash: "hash-eu-battery",
		clientAtlasTurnId: randomUUID(),
		idempotencyKey: randomUUID(),
		title: "EU battery rules",
		status: "succeeded",
		stage: "render",
		progressPercent: 100,
		progressDetailsJson: "{}",
	});

	return { atlasConversationId: atlas.id, plainConversationId: plain.id };
}

/**
 * `count` messages the USER sent this week, plus the assistant replies and a
 * pile of billing rows that must NOT be counted — the bars used to read
 * `usage_events`, which is one row per billed model call (the turn itself, the
 * thought-step classifier, the rail summary, memory maintenance, Atlas stages),
 * and that is how "249 this week" reached an owner who had sent far fewer.
 */
async function seedWeeklyTurns(userId: string, count: number) {
	const conversation = await createServerConversation(userId, "Weekly fixture");
	for (let index = 0; index < count; index += 1) {
		await createMessage(conversation.id, "user", `question ${index}`);
		await createMessage(conversation.id, "assistant", `answer ${index}`);
	}
	const now = new Date();
	const billingMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
	for (let index = 0; index < count * 4; index += 1) {
		await db.insert(usageEvents).values({
			id: randomUUID(),
			userId,
			conversationId: conversation.id,
			messageId: randomUUID(),
			modelId: "control:thought_step_classifier",
			billingMonth,
			createdAt: new Date(now.getTime() - index * 1_000),
		});
	}
	return conversation.id;
}

/** A v2-shaped Atlas job in flight, writing while `stage` still says curate. */
async function seedRunningJob(userId: string): Promise<string> {
	const conversation = await createServerConversation(
		userId,
		SEEDED.runningJob,
	);
	await createMessage(conversation.id, "user", "Research EV subsidies.");
	await db.insert(atlasJobs).values({
		id: randomUUID(),
		userId,
		conversationId: conversation.id,
		action: "create",
		profile: "in-depth",
		normalizedQueryHash: "hash-ev",
		clientAtlasTurnId: randomUUID(),
		idempotencyKey: randomUUID(),
		title: SEEDED.runningJob,
		status: "running",
		stage: "curate",
		progressPercent: 58,
		progressDetailsJson: JSON.stringify({ pipelineVersion: 2, phase: "write" }),
		startedAt: new Date(Date.now() - 6 * 60 * 1000),
	});
	return conversation.id;
}

async function gotoHome(page: Page) {
	await page.goto("/", { waitUntil: "domcontentloaded" });
	await expect(page.getByTestId("message-input")).toBeVisible({
		timeout: 15000,
	});
	// The board only renders once the summary has landed.
	await page.getByTestId("home-board").waitFor({ timeout: 15000 });
}

test.describe("chat home — Compact", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("draws the greeting with the weekly bars on its line", async ({
		page,
	}) => {
		const userId = await adminUserId();
		await clearHomeFixtures(userId);
		await seedWeeklyTurns(userId, 7);
		await gotoHome(page);

		const greeting = page.getByTestId("home-greeting");
		await expect(greeting).toBeVisible();
		await expect(greeting).toContainText("Admin User");

		await expect(page.getByTestId("home-weekly-bars")).toBeVisible();
		// Twelve bars, always — an empty week is a 1px tick, not a gap.
		await expect(page.getByTestId("home-weekly-bar")).toHaveCount(12);
		// The user sent seven messages. The fixture also wrote seven assistant
		// replies and twenty-eight billing rows; neither is the user talking.
		await expect(page.getByTestId("home-weekly-count")).toHaveText(
			"7 messages this week",
		);
	});

	test("keeps the same greeting across a reload", async ({ page }) => {
		// The greeting used to be re-rolled on every load, so it changed while
		// you were reading it. It is now drawn from a weighted pool keyed on
		// (user, day, time-of-day slot) — which means reloading has to give the
		// same line back, and this is the assertion that says so end to end.
		const userId = await adminUserId();
		await clearHomeFixtures(userId);
		await seedRecent(userId);
		await seedWeeklyTurns(userId, 7);
		await gotoHome(page);

		const greeting = page.getByTestId("home-greeting");
		await expect(greeting).toContainText("Admin User");
		// The visible span only — the phone-width form is in the DOM too.
		const first = await page.locator(".home-greeting-full").textContent();
		expect(first?.trim()).not.toBe("");

		for (let attempt = 0; attempt < 3; attempt += 1) {
			await page.reload({ waitUntil: "domcontentloaded" });
			await page.getByTestId("home-board").waitFor({ timeout: 15000 });
			await expect(page.locator(".home-greeting-full")).toHaveText(
				(first ?? "").trim(),
			);
		}

		// And whatever was picked, it is a finished sentence inside the length
		// cap the column was measured for. A recent conversation is seeded, and
		// its title must NOT turn up in the greeting: a model-written title
		// pasted into the line is what used to blow past the cap.
		expect(first).not.toContain("{");
		for (const title of [SEEDED.atlasConversation, SEEDED.plainConversation]) {
			expect(first).not.toContain(title.split(" ").slice(0, 2).join(" "));
		}
		expect((first ?? "").trim().length).toBeLessThanOrEqual(
			GREETING_MAX_LINE_CHARS,
		);
	});

	test("leaves air above the greeting without pushing the composer off a phone", async ({
		page,
	}) => {
		const userId = await adminUserId();
		await clearHomeFixtures(userId);
		await seedRecent(userId);
		await seedWeeklyTurns(userId, 3);
		await gotoHome(page);

		const band = page.locator(".home-band");
		const desktopPad = await band.evaluate((node) =>
			Number.parseFloat(getComputedStyle(node).paddingTop),
		);
		expect(desktopPad).toBeGreaterThanOrEqual(36);

		// And it is real air on the screen, not padding a flex parent eats.
		const stageBox = await page.locator(".chat-stage").boundingBox();
		const greetingBox = await page.getByTestId("home-greeting").boundingBox();
		expect((greetingBox?.y ?? 0) - (stageBox?.y ?? 0)).toBeGreaterThanOrEqual(
			36,
		);

		// 390x844: less air, and the composer still above the fold.
		await page.setViewportSize({ width: 390, height: 844 });
		await page.reload({ waitUntil: "domcontentloaded" });
		await page.getByTestId("home-board").waitFor({ timeout: 15000 });

		const phonePad = await band.evaluate((node) =>
			Number.parseFloat(getComputedStyle(node).paddingTop),
		);
		expect(phonePad).toBeGreaterThanOrEqual(20);
		expect(phonePad).toBeLessThan(desktopPad);

		await expect(page.getByTestId("home-greeting")).toBeVisible();
		const composerBox = await page.getByTestId("message-input").boundingBox();
		expect(composerBox).not.toBeNull();
		expect(composerBox?.y ?? 0).toBeGreaterThanOrEqual(0);
		expect(
			(composerBox?.y ?? 0) + (composerBox?.height ?? 0),
		).toBeLessThanOrEqual(844);
		await expect(page.getByTestId("message-input")).toBeInViewport();
	});

	test("gives a recent line the app's rounded, animated row hover", async ({
		page,
	}) => {
		const userId = await adminUserId();
		await clearHomeFixtures(userId);
		await seedRecent(userId);
		await gotoHome(page);

		const line = page.getByTestId("home-recent-line").first();
		await expect(line).toBeVisible();

		const idle = await line.evaluate((node) => {
			const style = getComputedStyle(node);
			return {
				radius: style.borderTopLeftRadius,
				transition: style.transitionProperty,
				duration: style.transitionDuration,
				background: style.backgroundColor,
			};
		});
		// Rounded, and on the app's row radius rather than a square wash.
		expect(Number.parseFloat(idle.radius)).toBeGreaterThan(0);
		expect(idle.transition).toContain("background-color");
		expect(Number.parseFloat(idle.duration)).toBeGreaterThan(0);

		await line.hover();
		const hovered = await line.evaluate(
			(node) => getComputedStyle(node).backgroundColor,
		);
		expect(hovered).not.toBe(idle.background);

		// The chips answer the pointer the same way.
		const chip = page.getByTestId("home-suggestion-chip").first();
		const chipTransition = await chip.evaluate((node) => {
			const style = getComputedStyle(node);
			return {
				property: style.transitionProperty,
				duration: style.transitionDuration,
			};
		});
		expect(chipTransition.property).toContain("background-color");
		expect(Number.parseFloat(chipTransition.duration)).toBeGreaterThan(0);
	});

	test("puts the chip row under the composer, not inside it", async ({
		page,
	}) => {
		const userId = await adminUserId();
		await clearHomeFixtures(userId);
		await seedRecent(userId);
		await gotoHome(page);

		const rail = page.getByTestId("home-suggestion-rail");
		await expect(rail).toBeVisible();

		// The owner's change: the rail is a sibling BELOW the composer, and no
		// chip lives inside the composer's own box.
		const composerBox = await page.getByTestId("message-input").boundingBox();
		const railBox = await rail.boundingBox();
		expect(composerBox).not.toBeNull();
		expect(railBox).not.toBeNull();
		expect(railBox?.y ?? 0).toBeGreaterThan(composerBox?.y ?? 0);
		expect(
			await page
				.getByTestId("message-input")
				.locator('[data-testid="home-suggestion-chip"]')
				.count(),
		).toBe(0);
	});

	test("clicking a chip sends its text as the first message", async ({
		page,
	}) => {
		const userId = await adminUserId();
		await clearHomeFixtures(userId);
		await seedRecent(userId);
		await gotoHome(page);

		const chip = page.getByTestId("home-suggestion-chip").first();
		await expect(chip).toBeVisible();
		const candidateKey = await chip.getAttribute("data-candidate-key");
		expect(candidateKey).toBeTruthy();

		// The source is the ranking field, and it lives on hover, not on the row.
		await expect(chip).toHaveAttribute("title", /^Source: .+/);

		const eventPosted = page.waitForRequest(
			(request) =>
				request.url().includes("/api/home/summary") &&
				request.method() === "POST",
		);
		await chip.click();
		await eventPosted;

		// The chip's text becomes the conversation's first message.
		await page.waitForURL(/\/chat\/[0-9a-f-]+/, { timeout: 20000 });
		await expect(page.getByTestId("message-input")).toBeVisible({
			timeout: 15000,
		});
	});

	test('"another" rotates the rail without reloading', async ({ page }) => {
		const userId = await adminUserId();
		await clearHomeFixtures(userId);
		await seedRecent(userId);
		// Enough distinct conversations that the pool exceeds the three shown.
		for (const title of ["Invoice questions", "Trip planning", "Tax notes"]) {
			const conversation = await createServerConversation(userId, title);
			await createMessage(conversation.id, "user", "hi");
		}
		await gotoHome(page);

		const another = page.getByTestId("home-suggestion-another");
		await expect(another).toBeVisible();

		const before = await page
			.getByTestId("home-suggestion-chip")
			.evaluateAll((nodes) =>
				nodes.map((node) => node.getAttribute("data-candidate-key")),
			);
		await another.click();
		await expect
			.poll(async () =>
				page
					.getByTestId("home-suggestion-chip")
					.evaluateAll((nodes) =>
						nodes.map((node) => node.getAttribute("data-candidate-key")),
					),
			)
			.not.toEqual(before);
	});

	test("lets the chips use the whole row on a desktop", async ({ page }) => {
		// The rail used to cap every label at 22ch around chips that could not
		// shrink: on a 780px row the third chip was cut short beside a long
		// stretch of empty track. The track owns everything left of "another",
		// and a chip is only truncated when the texts together do not fit.
		await page.setViewportSize({ width: 1440, height: 900 });
		const userId = await adminUserId();
		await clearHomeFixtures(userId);
		// Short titles first and long ones last: the rail leads with the most
		// recent, so the three chips drawn are the three long ones, and the
		// short ones are only there to make the pool deep enough for "another".
		for (const title of [
			"Invoice questions",
			"Trip planning",
			"Quarterly board meeting notes",
			"Summer holiday packing list",
			"Kitchen renovation budget",
		]) {
			const conversation = await createServerConversation(userId, title);
			await createMessage(conversation.id, "user", "hi");
		}
		await gotoHome(page);

		const another = page.getByTestId("home-suggestion-another");
		await expect(another).toBeVisible();

		const geometry = await page
			.getByTestId("home-suggestion-rail")
			.evaluate((rail) => {
				const track = rail.querySelector(".home-rail-track");
				const ghost = rail.querySelector(
					'[data-testid="home-suggestion-another"]',
				);
				if (!track || !ghost) throw new Error("rail is missing a part");
				const trackRect = track.getBoundingClientRect();
				return {
					railGap: Number.parseFloat(window.getComputedStyle(rail).columnGap),
					trackRight: trackRect.right,
					trackOverflow: track.scrollWidth - track.clientWidth,
					anotherLeft: ghost.getBoundingClientRect().left,
					labels: Array.from(
						rail.querySelectorAll(
							'[data-testid="home-suggestion-chip"] .home-chip-label',
						),
					).map((label) => ({
						text: label.textContent ?? "",
						scrollWidth: label.scrollWidth,
						clientWidth: label.clientWidth,
					})),
				};
			});

		// The track's right edge meets "another", one rail gap short of it.
		expect(geometry.railGap).toBeGreaterThan(0);
		expect(
			Math.abs(geometry.anotherLeft - geometry.trackRight - geometry.railGap),
		).toBeLessThanOrEqual(1);

		// Three seeded titles fit a 780px row with room to spare, so none of
		// them is cut — including the ones longer than the old 22ch cap.
		expect(geometry.labels).toHaveLength(3);
		expect(geometry.trackOverflow).toBeLessThanOrEqual(0);
		for (const label of geometry.labels) {
			expect(
				label.scrollWidth,
				`"${label.text}" is truncated`,
			).toBeLessThanOrEqual(label.clientWidth);
		}
		expect(geometry.labels.some((label) => label.text.length > 22)).toBe(true);

		// And when the three texts together do NOT fit, the chips share the row:
		// they shrink with an ellipsis until the last one ends exactly where the
		// track does, rather than scrolling the row or leaving part of it empty.
		// The first five go an hour into the past so the new three lead the rail.
		await db
			.update(conversations)
			.set({ updatedAt: new Date(Date.now() - 3_600_000) })
			.where(eq(conversations.userId, userId));
		for (const title of [
			"Reconciling the quarterly revenue figures again",
			"Rewriting the onboarding email sequence draft",
			"Comparing heat pump quotes for the old house",
		]) {
			const conversation = await createServerConversation(userId, title);
			await createMessage(conversation.id, "user", "hi");
		}
		await gotoHome(page);
		const crowded = await page
			.getByTestId("home-suggestion-rail")
			.evaluate((rail) => {
				const track = rail.querySelector(".home-rail-track");
				const chips = Array.from(
					rail.querySelectorAll('[data-testid="home-suggestion-chip"]'),
				);
				const last = chips[chips.length - 1];
				if (!track || !last) throw new Error("rail is missing a part");
				return {
					trackRight: track.getBoundingClientRect().right,
					lastChipRight: last.getBoundingClientRect().right,
					trackOverflow: track.scrollWidth - track.clientWidth,
					truncated: chips.filter((chip) => {
						const label = chip.querySelector(".home-chip-label");
						return label ? label.scrollWidth > label.clientWidth : false;
					}).length,
				};
			});
		expect(crowded.truncated).toBeGreaterThan(0);
		expect(crowded.trackOverflow).toBeLessThanOrEqual(0);
		expect(
			Math.abs(crowded.trackRight - crowded.lastChipRight),
		).toBeLessThanOrEqual(1);
	});

	test("lists three recent lines with one mark each", async ({ page }) => {
		const userId = await adminUserId();
		await clearHomeFixtures(userId);
		const { atlasConversationId } = await seedRecent(userId);
		await gotoHome(page);

		const lines = page.getByTestId("home-recent-line");
		await expect(lines.first()).toBeVisible();
		expect(await lines.count()).toBeLessThanOrEqual(3);

		const atlasLine = page.locator(
			`[data-testid="home-recent-line"][href="/chat/${atlasConversationId}"]`,
		);
		await expect(atlasLine).toContainText(SEEDED.atlasConversation);
		// A conversation whose Atlas report landed shows the badge INSTEAD of a
		// message count, never both.
		await expect(atlasLine.getByTestId("home-atlas-badge")).toBeVisible();

		const plainLine = page
			.getByTestId("home-recent-line")
			.filter({ hasText: SEEDED.plainConversation });
		await expect(plainLine).toContainText("2");
		await expect(plainLine.getByTestId("home-atlas-badge")).toHaveCount(0);
	});

	test("shows the running line only while a job is in flight", async ({
		page,
	}) => {
		const userId = await adminUserId();
		await clearHomeFixtures(userId);
		await seedRecent(userId);
		await gotoHome(page);
		await expect(page.getByTestId("home-running-line")).toHaveCount(0);

		await seedRunningJob(userId);
		await page.reload({ waitUntil: "domcontentloaded" });
		await page.getByTestId("home-board").waitFor({ timeout: 15000 });

		const running = page.getByTestId("home-running-line");
		await expect(running).toBeVisible();
		await expect(running).toContainText(SEEDED.runningJob);
		// The stage comes from progress details ("write" -> Writing), NOT from
		// the raw stage column, which still says curate.
		await expect(page.getByTestId("home-running-stage")).toContainText(
			"Writing",
		);
		await expect(page.getByTestId("home-running-stage")).not.toContainText(
			"Curating",
		);
		await expect(running.getByRole("progressbar")).toHaveAttribute(
			"aria-valuenow",
			"58",
		);
		await expect(running).toContainText("min");
	});

	test("keeps the tool-health strip admin-only and last", async ({ page }) => {
		const userId = await adminUserId();
		await clearHomeFixtures(userId);
		await seedRecent(userId);
		await gotoHome(page);

		const board = page.getByTestId("home-board");
		const strip = board.getByTestId("degraded-capabilities-banner");
		// The strip only renders during an actual outage; either way it must
		// never appear ABOVE Recent, and it must never be a bordered card here.
		if ((await strip.count()) > 0) {
			const stripBox = await strip.boundingBox();
			const recentBox = await page.getByTestId("home-recent").boundingBox();
			expect(stripBox?.y ?? 0).toBeGreaterThan(recentBox?.y ?? 0);
			await expect(
				strip.getByTestId("degraded-capabilities-admin-link"),
			).toBeVisible();
		}
		// The old card slot above the composer is gone in every state.
		const composerBox = await page.getByTestId("message-input").boundingBox();
		const boardBox = await board.boundingBox();
		expect(boardBox?.y ?? 0).toBeGreaterThan(composerBox?.y ?? 0);
	});

	test("degrades to a greeting and a composer when the summary is empty", async ({
		page,
	}) => {
		const userId = await adminUserId();
		await clearHomeFixtures(userId);
		await gotoHome(page);

		await expect(page.getByTestId("home-greeting")).toBeVisible();
		await expect(page.getByTestId("message-input")).toBeVisible();
		await expect(page.getByTestId("home-recent")).toHaveCount(0);
		await expect(page.getByTestId("home-weekly-mark")).toHaveCount(0);
	});

	test("scrolls the board on a short window, keeping the composer whole", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 460 });
		const userId = await adminUserId();
		await clearHomeFixtures(userId);
		await seedRecent(userId);
		await seedWeeklyTurns(userId, 4);
		await gotoHome(page);

		const stageBox = await page.locator(".chat-stage").boundingBox();
		const composerBox = await page.getByTestId("message-input").boundingBox();
		const boardBox = await page.getByTestId("home-board").boundingBox();
		expect(stageBox).not.toBeNull();
		expect(composerBox).not.toBeNull();
		expect(boardBox).not.toBeNull();
		const stageBottom = (stageBox?.y ?? 0) + (stageBox?.height ?? 0);

		// The composer is whole: a short window takes its height off Recent,
		// never off the box you came here to type in.
		expect(composerBox?.y ?? 0).toBeGreaterThanOrEqual((stageBox?.y ?? 0) - 1);
		expect(
			(composerBox?.y ?? 0) + (composerBox?.height ?? 0),
		).toBeLessThanOrEqual(stageBottom + 1);
		// And the board ends inside the stage rather than running off it.
		expect((boardBox?.y ?? 0) + (boardBox?.height ?? 0)).toBeLessThanOrEqual(
			stageBottom + 1,
		);

		// Whatever did not fit is reachable by scrolling the board itself.
		const lastLine = page.getByTestId("home-recent-line").last();
		await lastLine.scrollIntoViewIfNeeded();
		await expect(lastLine).toBeInViewport();

		// The scroll belongs to the board and NOT to the column. A scroll
		// container around the composer clips everything the composer opens
		// upwards out of its own footer — the "+" menu, the accounts popover,
		// the model picker — which is how the menu went unclickable on this
		// page. (That the menu itself still works here is what
		// composer-direction-b.spec.ts asserts, on the landing page.)
		expect(
			await page
				.locator(".home-column")
				.evaluate((node) => getComputedStyle(node).overflowY),
		).toBe("visible");
		expect(
			await page
				.getByTestId("home-board")
				.evaluate((node) => getComputedStyle(node).overflowY),
		).toBe("auto");
	});

	test("a chip sends through the composer, carrying what it holds", async ({
		page,
	}) => {
		const userId = await adminUserId();
		await clearHomeFixtures(userId);
		await seedRecent(userId);
		await gotoHome(page);

		// Pick a state that only the composer knows about: an AI style from
		// the plus menu. A chip that built its own payload would send without
		// it. (The Web search switch this test used to flip left the menu
		// on 2026-09-11; `/web` is the only way to force a search now.)
		await page.getByTestId("composer-tools-trigger").click();
		await page.getByTestId("composer-menu-style").click();
		// "Default" is the selected option on a fresh account; any unselected
		// one is a real profile with an id.
		const styleOption = page.getByRole("option", { selected: false }).first();
		await expect(styleOption).toBeVisible();
		await styleOption.click();
		await expect(page.getByTestId("composer-tools-menu")).toBeHidden();

		const chip = page.getByTestId("home-suggestion-chip").first();
		const chipText = await chip.getAttribute("title");
		expect(chipText).toBeTruthy();

		const turnRequest = page.waitForRequest(
			(request) =>
				request.url().includes("/api/chat/stream") &&
				request.method() === "POST",
			{ timeout: 25000 },
		);
		await chip.click();
		const body = (await turnRequest).postDataJSON() as {
			personalityProfileId?: string | null;
			message?: string;
		};
		expect(typeof body.personalityProfileId).toBe("string");
		expect(body.personalityProfileId?.length ?? 0).toBeGreaterThan(0);
		expect((body.message ?? "").length).toBeGreaterThan(0);
	});

	test("gives every chip a 44px hit area on a phone", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		const userId = await adminUserId();
		await clearHomeFixtures(userId);
		await seedRecent(userId);
		await gotoHome(page);

		const chip = page.getByTestId("home-suggestion-chip").first();
		await expect(chip).toBeVisible();
		const hit = await chip.evaluate((node) => {
			const after = window.getComputedStyle(node, "::after");
			const rect = node.getBoundingClientRect();
			const inset = Math.abs(Number.parseFloat(after.top || "0"));
			return { height: rect.height + inset * 2 };
		});
		expect(hit.height).toBeGreaterThanOrEqual(44);
	});
});
