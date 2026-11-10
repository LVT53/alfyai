import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import { users } from "../../src/lib/server/db/schema";
import { describeLocalMoment } from "../../src/lib/shared/time-zone";
import {
	AI_SMOKE_API_KEY,
	AI_SMOKE_MODEL_ID,
	AI_SMOKE_STREAM_TEXT,
} from "../fixtures/ai/openai-compatible-scenarios";
import {
	type CapturedOpenAICompatibleRequest,
	createOpenAICompatibleProviderHarness,
} from "../mocks/ai-provider/openai-compatible-provider";
import {
	deleteProvidersWithPrefix,
	login,
	openConversationComposer,
	sendMessage,
	TEST_EMAIL,
	waitForHydration,
} from "./helpers";

// The person's own clock (the first slice of the timers and scheduled tasks
// to come), end to end: the browser says which zone it is in and the server
// keeps it without asking; Settings shows it and lets the person pick another;
// and the model is told it, in English, as the time it is for that person.
//
// The browser is made to be in Budapest whatever the machine's zone is
// (`timezoneId`), so what it reports is the same on every machine. The model
// is the fake OpenAI-compatible provider, whose `requests()` hold every body
// the app sent it: the only place the clock the model was given can be read.

test.use({ timezoneId: "Europe/Budapest" });

const fakeProvider = createOpenAICompatibleProviderHarness();

const PROVIDER_PREFIX = "tz_e2e_";
const BROWSER_ZONE = "Europe/Budapest";
const CHOSEN_ZONE = "Asia/Tokyo";

// --- the person's rows -------------------------------------------------------

/**
 * The stored zone, set straight in the worker's database: the route will not
 * clear one (a zone is replaced, never cleared), and a worker keeps its database
 * from one spec file to the next, so this spec puts the zone back to none.
 */
async function storeTimeZone(timeZone: string | null): Promise<void> {
	await db.update(users).set({ timeZone }).where(eq(users.email, TEST_EMAIL));
}

type Preferences = {
	timeZone: string | null;
	uiLanguage: "en" | "hu";
	preferredModel: string | null;
};

async function readPreferences(page: Page): Promise<Preferences> {
	const response = await page.request.get("/api/settings");
	expect(response.ok(), `settings read -> ${response.status()}`).toBe(true);
	const { preferences } = (await response.json()) as {
		preferences: Preferences;
	};
	return preferences;
}

async function writePreferences(
	page: Page,
	data: Partial<Preferences>,
): Promise<void> {
	const response = await page.request.patch("/api/settings/preferences", {
		data,
	});
	expect(response.ok(), `preference write -> ${response.status()}`).toBe(true);
}

/** Waits until the server holds `zone`: the browser saves it a moment after the page loads. */
async function waitForStoredZone(page: Page, zone: string): Promise<void> {
	await expect
		.poll(async () => (await readPreferences(page)).timeZone, {
			message: `the server holds ${zone}`,
			timeout: 15_000,
		})
		.toBe(zone);
}

/** The preference PATCHes a page sends while it loads, to tell a save from a silence. */
function watchPreferenceWrites(page: Page): () => string[] {
	const bodies: string[] = [];
	page.on("request", (request) => {
		if (
			request.method() === "PATCH" &&
			request.url().endsWith("/api/settings/preferences")
		) {
			bodies.push(request.postData() ?? "");
		}
	});
	return () => [...bodies];
}

async function openSettings(page: Page): Promise<void> {
	await page.goto("/settings", { waitUntil: "domcontentloaded" });
	await waitForHydration(page);
	await expect(page.getByTestId("settings-time-zone-select")).toBeVisible();
}

// --- the temporary model -----------------------------------------------------

/** A provider and a model on the fake provider, made the way the admin API makes them. */
async function createTemporaryModel(page: Page): Promise<string> {
	const unique = randomUUID().slice(0, 8);
	const createdProvider = await page.request.post("/api/admin/providers", {
		data: {
			name: `${PROVIDER_PREFIX}${unique}`,
			displayName: `Time zone E2E ${unique}`,
			baseUrl: fakeProvider.baseURL,
			apiKey: AI_SMOKE_API_KEY,
		},
	});
	expect(
		createdProvider.ok(),
		`provider create -> ${createdProvider.status()}`,
	).toBe(true);
	const { provider } = (await createdProvider.json()) as {
		provider: { id: string };
	};
	const createdModels = await page.request.post(
		`/api/admin/providers/${provider.id}/models/batch`,
		{
			data: {
				models: [
					{
						name: AI_SMOKE_MODEL_ID,
						displayName: `Time zone E2E Model ${unique}`,
						contextLength: 8192,
						supportsChat: true,
						supportsTools: true,
					},
				],
			},
		},
	);
	expect(createdModels.ok(), `model create -> ${createdModels.status()}`).toBe(
		true,
	);
	const { models } = (await createdModels.json()) as {
		models: Array<{ id: string }>;
	};
	return `provider:${provider.id}:${models[0].id}`;
}

// --- what the fake model was sent --------------------------------------------

type ChatPart = { type: string; text?: string };
type ChatMessage = { role: string; content: string | ChatPart[] };

function textOf(message: ChatMessage | undefined): string {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	return message.content.map((part) => part.text ?? "").join("\n");
}

/**
 * The streamed chat request of the turn whose message is `text`, found by the
 * text itself (it is unique to this run).
 */
function turnRequest(text: string): {
	system: string;
	lastUser: string;
	clock: string;
} {
	const request: CapturedOpenAICompatibleRequest | undefined = fakeProvider
		.requests()
		.find(
			(candidate) =>
				candidate.path === "/v1/chat/completions" &&
				(candidate.body as { stream?: boolean } | undefined)?.stream === true &&
				JSON.stringify(candidate.body).includes(text),
		);
	if (!request) {
		throw new Error(`the model was never sent a chat turn holding "${text}"`);
	}
	const messages = ((request.body as { messages?: ChatMessage[] }).messages ??
		[]) as ChatMessage[];
	const lastUser = textOf(messages.filter((m) => m.role === "user").at(-1));
	const clock =
		lastUser
			.split("\n")
			.find((line) => line.startsWith("[SYSTEM TIME CONTEXT:")) ?? "";
	return {
		system: messages
			.filter((message) => message.role === "system")
			.map(textOf)
			.join("\n"),
		lastUser,
		clock,
	};
}

/**
 * The clock lines the app can have written for `zone` at some moment between two
 * instants: one per minute, since the line carries minutes. What the model was
 * told must be one of them, whichever minute the turn was prepared in.
 */
function clockLinesBetween(zone: string, from: number, to: number): string[] {
	const lines: string[] = [];
	for (let at = from - (from % 60_000); at <= to; at += 60_000) {
		const moment = describeLocalMoment(new Date(at), zone);
		if (moment) {
			lines.push(`${moment.date}, ${moment.time} (${zone}, ${moment.offset})`);
		}
	}
	return lines;
}

/** What the model was told must be a reading of the clock in `zone` from the turn's own window. */
function expectClockWithin(
	clock: string,
	zone: string,
	from: number,
	to: number,
): void {
	const lines = clockLinesBetween(zone, from, to);
	expect(
		lines.some((line) => clock.includes(line)),
		`${clock} holds one of ${lines.join(" | ")}`,
	).toBe(true);
}

/** One message from the landing page: a new chat, the model's answer on screen. */
async function askOnce(page: Page, text: string): Promise<void> {
	await page.goto("/", { waitUntil: "domcontentloaded" });
	await openConversationComposer(page);
	await sendMessage(page, text);
	await expect(page).toHaveURL(/\/chat\//, { timeout: 15_000 });
	await expect(page.getByTestId("assistant-message").first()).toContainText(
		AI_SMOKE_STREAM_TEXT,
		{ timeout: 30_000 },
	);
}

// --- the spec ----------------------------------------------------------------

test.describe("the person's time zone", () => {
	let previous: Preferences | undefined;

	test.beforeAll(async () => {
		await fakeProvider.start();
	});

	test.afterAll(async () => {
		await fakeProvider.stop();
	});

	test.beforeEach(async ({ page }) => {
		await fakeProvider.reset();
		previous = undefined;
		// Nothing stored: a person no browser has saved a zone for yet.
		await storeTimeZone(null);
		await login(page);
		previous = await readPreferences(page);
	});

	test.afterEach(async ({ page }) => {
		// The choice of model first: the provider it names goes next.
		if (previous) {
			await writePreferences(page, {
				uiLanguage: previous.uiLanguage,
				preferredModel: previous.preferredModel,
			});
		}
		await deleteProvidersWithPrefix(page, PROVIDER_PREFIX);
		await storeTimeZone(null);
	});

	test("the browser saves its own zone without a prompt", async ({ page }) => {
		// `login` landed on the home page and this test has touched nothing since:
		// the layout told the server the zone the browser is in, and nobody was
		// asked.
		await waitForStoredZone(page, BROWSER_ZONE);
		// And it remembers what it saw, which is how a later load tells a browser
		// that moved from one that is only back.
		await expect
			.poll(() => page.evaluate(() => localStorage.getItem("detectedTimeZone")))
			.toBe(BROWSER_ZONE);
	});

	test("Settings shows the zone, a pick is saved, and the browser does not take it back", async ({
		page,
	}) => {
		await waitForStoredZone(page, BROWSER_ZONE);
		await expect
			.poll(() => page.evaluate(() => localStorage.getItem("detectedTimeZone")))
			.toBe(BROWSER_ZONE);

		await openSettings(page);
		const select = page.getByTestId("settings-time-zone-select");
		const preferences = page.locator("#settings-section-preferences");
		await expect(
			preferences.getByTestId("settings-time-zone-select"),
		).toBeVisible();
		await expect(
			page.getByRole("combobox", { name: "Time zone" }),
		).toBeVisible();
		await expect(
			page.getByText("Lets AlfyAI know your local date and time."),
		).toBeVisible();
		await expect(select).toHaveValue(BROWSER_ZONE);
		// A few zones; the one this browser is in sits alone under its own heading,
		// with the offset in force, so the closed select can show it whole.
		const options = await select
			.locator("option")
			.evaluateAll((nodes) =>
				nodes.map((node) => (node as HTMLOptionElement).value),
			);
		expect(options.length).toBeGreaterThan(5);
		expect(options.length).toBeLessThan(25);
		expect(options).toContain(CHOSEN_ZONE);
		// (Playwright's role queries do not see an optgroup, so these are CSS.)
		const device = select.locator('optgroup[label="This device"] > option');
		await expect(device).toHaveCount(1);
		await expect(device).toHaveText(/^Europe\/Budapest \(UTC\+0[12]:00\)$/);
		await expect(select.locator('optgroup[label="Other zones"]')).toHaveCount(
			1,
		);

		// A pick goes to the server.
		const saved = page.waitForResponse(
			(response) =>
				response.request().method() === "PATCH" &&
				response.url().endsWith("/api/settings/preferences"),
		);
		await select.selectOption(CHOSEN_ZONE);
		expect((await saved).ok()).toBe(true);
		expect((await readPreferences(page)).timeZone).toBe(CHOSEN_ZONE);

		// A reload keeps it: the browser still says Budapest, as it did the last
		// time it looked, so it has nothing to take back.
		const writes = watchPreferenceWrites(page);
		await openSettings(page);
		await expect(page.getByTestId("settings-time-zone-select")).toHaveValue(
			CHOSEN_ZONE,
		);
		expect(writes(), "the reload wrote no preference").toEqual([]);
		expect((await readPreferences(page)).timeZone).toBe(CHOSEN_ZONE);
	});

	test("Settings says it in Hungarian, and the row fits a phone", async ({
		page,
	}) => {
		await waitForStoredZone(page, BROWSER_ZONE);
		await writePreferences(page, { uiLanguage: "hu" });
		await page.setViewportSize({ width: 360, height: 800 });

		await openSettings(page);

		const select = page.getByTestId("settings-time-zone-select");
		await expect(page.getByRole("combobox", { name: "Időzóna" })).toBeVisible();
		await expect(
			page.getByText("Ebből tudja az AlfyAI, mennyi az idő nálad."),
		).toBeVisible();
		await expect(page.getByText("Time zone")).toHaveCount(0);
		await expect(select).toHaveValue(BROWSER_ZONE);
		await expect(
			select.locator('optgroup[label="Ez az eszköz"] > option'),
		).toHaveText(/^Europe\/Budapest \(UTC\+0[12]:00\)$/);
		await expect(select.locator('optgroup[label="Más időzónák"]')).toHaveCount(
			1,
		);

		// The row stays inside the phone: the control is not wider than the screen
		// and the row does not scroll sideways.
		const box = await select.boundingBox();
		expect(box).not.toBeNull();
		expect((box?.x ?? -1) >= 0).toBe(true);
		expect((box?.x ?? 0) + (box?.width ?? 999)).toBeLessThanOrEqual(360);
		const row = page.locator(".settings-row", { has: select });
		expect(
			await row.evaluate((node) => node.scrollWidth <= node.clientWidth),
		).toBe(true);
	});

	test("a chat turn reaches the model with the stored zone as the person's clock, in English", async ({
		page,
	}) => {
		const model = await createTemporaryModel(page);
		// The person chose Tokyo while their browser is in Budapest: the model is
		// told what the server holds, not what the browser says. And Hungarian is
		// the interface: the line is English all the same.
		await waitForStoredZone(page, BROWSER_ZONE);
		await writePreferences(page, {
			preferredModel: model,
			uiLanguage: "hu",
			timeZone: CHOSEN_ZONE,
		});

		const run = randomUUID().slice(0, 8);
		const first = `tz-e2e-${run}-first What day is it?`;
		const before = Date.now();
		await askOnce(page, first);
		const after = Date.now();

		const firstTurn = turnRequest(first);
		expectClockWithin(firstTurn.clock, CHOSEN_ZONE, before, after);
		expect(firstTurn.clock).toContain(CHOSEN_ZONE);
		expect(firstTurn.clock).toContain("UTC+09:00");
		expect(firstTurn.clock).toContain("This line is the current time");
		expect(firstTurn.clock).not.toContain("tool");
		expect(firstTurn.clock).toMatch(/^[ -~]+$/);
		// After the person's message, with the rest of the turn's guidance; never
		// in the system message that stays the same from turn to turn.
		expect(firstTurn.lastUser.indexOf(first)).toBeLessThan(
			firstTurn.lastUser.indexOf("## Turn Guidance"),
		);
		expect(firstTurn.lastUser.indexOf("## Turn Guidance")).toBeLessThan(
			firstTurn.lastUser.indexOf("[SYSTEM TIME CONTEXT:"),
		);
		expect(firstTurn.system).not.toContain(CHOSEN_ZONE);
		expect(firstTurn.system).not.toContain("SYSTEM TIME CONTEXT");

		// A zone changed in Settings is the next turn's clock.
		await writePreferences(page, { timeZone: BROWSER_ZONE });
		const second = `tz-e2e-${run}-second And now?`;
		const beforeSecond = Date.now();
		await askOnce(page, second);
		const afterSecond = Date.now();

		const secondTurn = turnRequest(second);
		expect(secondTurn.clock).toContain(BROWSER_ZONE);
		expect(secondTurn.clock).not.toContain(CHOSEN_ZONE);
		expectClockWithin(
			secondTurn.clock,
			BROWSER_ZONE,
			beforeSecond,
			afterSecond,
		);
	});
});
