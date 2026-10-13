import { randomUUID } from "node:crypto";
import {
	type APIRequestContext,
	expect,
	type Page,
	test,
} from "@playwright/test";
import bcrypt from "bcryptjs";
import { db } from "../../src/lib/server/db";
import { users } from "../../src/lib/server/db/schema";
import { adminApi } from "./artifact-tours-helpers";
import {
	buildAiSdkUiStreamBody,
	ensureSidebarExpanded,
	login,
	waitForAssistantResponse,
} from "./helpers";

// Who is shown which announcement, and when (owner, 2026-10-13: after archiving
// the old welcome and publishing the new one, "I do not see the 2.2 campaign
// slides", and then "the 2.2 slides just appeared when I sent a new message").
//
//   - A first-run welcome is for an account that has never been through one.
//     A new revision, or an old one archived, never reaches an account that
//     finished or skipped a welcome.
//   - A release update is for every account that was here when it was
//     published and has not seen it. Finishing a welcome never consumes it. An
//     account made after it was published is not handed it: the welcome was its
//     introduction. The sidebar badge opens it for anyone.
//   - A card shows when the reader ARRIVES at the app, never because they sent a
//     message: the landing page sends the first message with a full document
//     navigation, and that load used to ask for a card as if the reader had just
//     opened the app.
//
// Everything a reader does is real input: sign in, click through the card,
// type, press Send, click the badge. The arrangement an admin makes (publish,
// archive) and the accounts' ages go through the app's own admin routes and the
// database, as the tours' specs do.

const REPLY = "Rendben, mindjárt elintézem ezt a kérést.";
const HOUR = 3_600_000;

type Reader = { id: string; email: string; password: string };

/**
 * An account of its own. `existing` is an account that was here before anything
 * below was published (ten days old); otherwise it is made now, which is after
 * whatever the test has already published.
 */
async function createReader(existing: boolean): Promise<Reader> {
	const id = randomUUID();
	const suffix = id.slice(0, 8);
	const reader = {
		id,
		email: `audience-${suffix}@local`,
		password: `audience-${suffix}-password`,
	};
	await db.insert(users).values({
		id,
		email: reader.email,
		passwordHash: bcrypt.hashSync(reader.password, 4),
		name: `Audience reader ${suffix}`,
		role: "user",
		uiLanguage: "en",
		createdAt: existing ? new Date(Date.now() - 240 * HOUR) : new Date(),
	});
	return reader;
}

/** The slide titles of one published welcome or release, by its label. */
const WELCOME_TITLES = (label: string) => [
	`${label}: set it up`,
	`${label}: what Alfy makes`,
	`${label}: your data`,
];
const RELEASE_TITLE = (label: string) => `${label}: what changed`;

function localized(text: string) {
	return { en: text, hu: `${text} (hu)` };
}

function welcomeSlides(label: string) {
	const [setup, makes, data] = WELCOME_TITLES(label);
	return [
		{
			layoutType: "setup",
			sortOrder: 1,
			title: localized(setup),
			body: localized("Pick the defaults."),
			setupControls: ["ui_language", "theme", "model_default", "ai_style"],
		},
		{
			layoutType: "standard",
			sortOrder: 2,
			title: localized(makes),
			body: localized("A Document, an App or a board opens beside the chat."),
		},
		{
			layoutType: "standard",
			semanticRole: "data_disclosure",
			sortOrder: 3,
			title: localized(data),
			body: localized("Messages may go to the providers you configured."),
		},
	];
}

function releaseSlides(label: string) {
	return [
		{
			layoutType: "standard",
			sortOrder: 1,
			title: localized(RELEASE_TITLE(label)),
			body: localized("Here is what is new."),
		},
	];
}

test.describe("Who is shown which announcement, and when", () => {
	let api: APIRequestContext;
	/** Every campaign the test has published and not yet archived. */
	let live: string[] = [];

	test.beforeEach(async ({ request }) => {
		api = await adminApi(request);
		live = [];
	});

	// What a test publishes is taken back out the way an admin does it, so a
	// later spec on this database never meets a card nobody asked for.
	test.afterEach(async () => {
		for (const id of live) {
			await api.post(`/api/admin/campaigns/${id}/archive`);
		}
	});

	async function publish(
		body: { type: string; name: string; releaseVersion?: string },
		slides: unknown[],
	): Promise<string> {
		const created = await api.post("/api/admin/campaigns", { data: body });
		expect(created.status(), "creating the draft").toBe(201);
		const id = ((await created.json()) as { campaign: { id: string } }).campaign
			.id;
		const filled = await api.patch(`/api/admin/campaigns/${id}`, {
			data: { slides },
		});
		expect(filled.ok(), "filling the draft").toBe(true);
		const published = await api.post(`/api/admin/campaigns/${id}/publish`);
		expect(published.ok(), `publishing: ${await published.text()}`).toBe(true);
		live.push(id);
		return id;
	}

	const publishWelcome = (label: string) =>
		publish(
			{ type: "first_run_onboarding", name: `${label} welcome` },
			welcomeSlides(label),
		);
	// A version below the package's, so the sidebar badge keeps the version it has.
	const publishRelease = (label: string) =>
		publish(
			{
				type: "release_update",
				name: `${label} release`,
				releaseVersion: "0.0.1",
			},
			releaseSlides(label),
		);

	async function archive(id: string) {
		const archived = await api.post(`/api/admin/campaigns/${id}/archive`);
		expect(archived.ok(), "archiving").toBe(true);
		live = live.filter((other) => other !== id);
	}

	const card = (page: Page) =>
		page.getByRole("dialog", { name: "Campaign announcement" });
	const cardHeading = (page: Page, title: string) =>
		card(page).getByRole("heading", { name: title });
	// A fresh account's sidebar is the narrow rail, which has no badge: open it
	// the way a reader does, then press the badge next to the title.
	async function pressVersionBadge(page: Page) {
		await ensureSidebarExpanded(page);
		await page.getByRole("button", { name: /^App version/ }).click();
	}

	/**
	 * A real load of the app at `path`, resolved once the server has said what it
	 * offers this reader and the page has gone quiet, so "no card" is an answer
	 * and not a race with a request still on its way.
	 */
	async function arrive(page: Page, path = "/") {
		const answered = page.waitForResponse(
			(response) =>
				new URL(response.url()).pathname === "/api/campaigns/eligible",
		);
		await page.goto(path, { waitUntil: "domcontentloaded" });
		const offered = (await (await answered).json()) as {
			campaign: { id: string; type: string } | null;
		};
		await page.waitForLoadState("networkidle");
		return offered.campaign;
	}

	/** Next to the last slide, then Finish, with the mouse. */
	async function finishCard(page: Page, slides: number) {
		const dialog = card(page);
		for (let step = 1; step < slides; step++) {
			await dialog.getByRole("button", { name: "Next", exact: true }).click();
		}
		await dialog.getByRole("button", { name: "Finish", exact: true }).click();
		await expect(dialog).toHaveCount(0);
	}

	async function skipCard(page: Page) {
		await card(page).getByRole("button", { name: "Skip", exact: true }).click();
		await expect(card(page)).toHaveCount(0);
	}

	async function expectNoCard(page: Page) {
		await expect(card(page)).toHaveCount(0);
	}

	test("an account that finished the old welcome goes straight to the new release, not to the new welcome", async ({
		page,
	}) => {
		const oldWelcome = await publishWelcome("Old");
		const reader = await createReader(true);
		await login(page, reader.email, reader.password);

		// Never been through a welcome: it is shown, and finished like a reader does.
		await expect(cardHeading(page, WELCOME_TITLES("Old")[0])).toBeVisible();
		await finishCard(page, 3);
		expect(await arrive(page)).toBeNull();
		await expectNoCard(page);

		// The owner's move: the old welcome archived, a new one published, and the release.
		await archive(oldWelcome);
		await publishWelcome("New");
		await publishRelease("New");

		const offered = await arrive(page);
		expect(offered?.type, "what the server offered").toBe("release_update");
		await expect(cardHeading(page, RELEASE_TITLE("New"))).toBeVisible();
		await expect(cardHeading(page, WELCOME_TITLES("New")[0])).toHaveCount(0);

		// Once it is finished, nothing more: the new welcome is never offered.
		await finishCard(page, 1);
		expect(await arrive(page)).toBeNull();
		await expectNoCard(page);
	});

	for (const leave of ["finishes", "skips"] as const) {
		test(`an account that was here before the release still gets it after it ${leave} the welcome`, async ({
			page,
		}) => {
			await publishWelcome("Welcome");
			await publishRelease("Release");
			const reader = await createReader(true);
			await login(page, reader.email, reader.password);

			await expect(
				cardHeading(page, WELCOME_TITLES("Welcome")[0]),
			).toBeVisible();
			if (leave === "finishes") await finishCard(page, 3);
			else await skipCard(page);

			// The next arrival, not the same load: one card at a time, no queue.
			const offered = await arrive(page);
			expect(offered?.type, "what the server offered").toBe("release_update");
			await expect(cardHeading(page, RELEASE_TITLE("Release"))).toBeVisible();
			await finishCard(page, 1);

			expect(await arrive(page)).toBeNull();
			await expectNoCard(page);
		});
	}

	test("a brand-new account is welcomed once, is not handed the release it was never here for, and finds it behind the version badge", async ({
		page,
	}) => {
		await publishWelcome("Welcome");
		await publishRelease("Release");
		const reader = await createReader(false);
		await login(page, reader.email, reader.password);

		await expect(cardHeading(page, WELCOME_TITLES("Welcome")[0])).toBeVisible();
		await finishCard(page, 3);

		// The welcome was its introduction: no release card now, or on any later load.
		expect(await arrive(page)).toBeNull();
		await expectNoCard(page);

		// It is one click away, and looking at it again changes nothing.
		await pressVersionBadge(page);
		await expect(cardHeading(page, RELEASE_TITLE("Release"))).toBeVisible();
		await card(page)
			.getByRole("button", { name: "Finish", exact: true })
			.click();
		await expectNoCard(page);
		expect(await arrive(page)).toBeNull();
		await expectNoCard(page);
	});

	test("the version badge opens the release, even when the welcome was published after it", async ({
		page,
	}) => {
		await publishRelease("Release");
		// `published_at` has a resolution of a second: the welcome is plainly the newer.
		await page.waitForTimeout(1100);
		await publishWelcome("Welcome");
		const reader = await createReader(true);
		await login(page, reader.email, reader.password);

		await expect(cardHeading(page, WELCOME_TITLES("Welcome")[0])).toBeVisible();
		await skipCard(page);
		await arrive(page);
		await expect(cardHeading(page, RELEASE_TITLE("Release"))).toBeVisible();
		await finishCard(page, 1);

		await pressVersionBadge(page);
		await expect(cardHeading(page, RELEASE_TITLE("Release"))).toBeVisible();
		await expect(cardHeading(page, WELCOME_TITLES("Welcome")[0])).toHaveCount(
			0,
		);
	});

	// The shell is mounted once: moving around inside it is no arrival. (Nothing
	// refetches on a navigation, and this holds it so.)
	test("moving around the app never raises a newly published release", async ({
		page,
	}) => {
		const reader = await createReader(true);
		await login(page, reader.email, reader.password);
		await expectNoCard(page);

		await publishRelease("Moving");

		await page.getByRole("button", { name: "Open knowledge base" }).click();
		await expect(page).toHaveURL(/\/knowledge/);
		await page.waitForLoadState("networkidle");
		await expectNoCard(page);
		await page.getByTestId("new-conversation").click();
		await expect(page).toHaveURL("/");
		await page.waitForLoadState("networkidle");
		await expectNoCard(page);

		// An arrival does.
		await arrive(page);
		await expect(cardHeading(page, RELEASE_TITLE("Moving"))).toBeVisible();
	});

	// The owner's second report. The landing page sends the first message with a
	// full document navigation, which loads the whole app shell again; the shell
	// used to take that load for an arrival and open whatever was newly
	// available over the turn it had just started.
	for (const announcement of ["release", "welcome"] as const) {
		test(`sending a message never raises a newly published ${announcement}, and the next arrival does`, async ({
			page,
		}) => {
			// A reader with nothing waiting: made before anything is published, so the
			// release is theirs to get; or, for the welcome, a new account.
			const reader = await createReader(announcement === "release");
			await login(page, reader.email, reader.password);
			await expectNoCard(page);

			await page.route("**/api/chat/stream", async (route) => {
				await route.fulfill({
					status: 200,
					headers: {
						"Content-Type": "text/event-stream",
						"Cache-Control": "no-cache",
						Connection: "keep-alive",
					},
					body: buildAiSdkUiStreamBody(REPLY),
				});
			});

			// It comes out while the reader is on the landing page, composing.
			const title =
				announcement === "release"
					? RELEASE_TITLE("Fresh")
					: WELCOME_TITLES("Fresh")[0];
			if (announcement === "release") await publishRelease("Fresh");
			else await publishWelcome("Fresh");

			await page
				.getByTestId("message-input")
				.fill("Szia! Két mesebeli kérdésem lenne.");
			await page.getByTestId("send-button").click();
			await page.waitForURL(/\/chat\//, { timeout: 20_000 });
			await waitForAssistantResponse(page);
			await expect(page.getByText(REPLY)).toBeVisible();

			// The turn ran start to end with nothing over it.
			await page.waitForLoadState("networkidle");
			await expectNoCard(page);

			// An arrival is the moment: the same load, now that nothing is being sent.
			const chatUrl = page.url();
			await arrive(page, chatUrl);
			await expect(cardHeading(page, title)).toBeVisible();
		});
	}
});
