import { randomUUID } from "node:crypto";
import {
	type APIRequestContext,
	expect,
	type Page,
	type Response,
	test,
} from "@playwright/test";
import bcrypt from "bcryptjs";
import type { FeatureNote } from "../../src/lib/client/api/campaigns";
import { db } from "../../src/lib/server/db";
import { users } from "../../src/lib/server/db/schema";
import { adminApi } from "./artifact-tours-helpers";
import {
	buildAiSdkUiStreamBody,
	createEmptyConversation,
	login,
	waitForAssistantResponse,
} from "./helpers";

// A feature note is the campaigns pipeline's light sibling: one short strip on
// the landing page that names a small feature and offers one way in. It never
// opens the campaign modal, never reaches the badge, and never follows a
// campaign in the same landing arrival. It stops after X (skipped), its CTA
// (completed), or four showings.
//
// Everything here is arranged the way an admin does it: the note is created,
// filled and published through the app's own admin API. Readers are accounts of
// their own (an existing one was here before the note was published, which is
// what makes it theirs), and every note this spec publishes is archived in
// `afterEach`, because a live note would meet every later spec on this
// worker's database.

const REPLY = "Rendben, mindjárt elintézem ezt a kérést.";
const HOUR = 3_600_000;
const FEATURE_NOTE_PATH = "/api/campaigns/feature-note";

type Reader = { id: string; email: string; password: string };

type Localized = { en: string; hu: string };

type NoteContent = {
	name: string;
	title: Localized;
	body: Localized;
	actionLabel?: Localized;
	actionDestination?: string;
};

type ReleaseContent = {
	name: string;
	releaseVersion: string;
	title: Localized;
	body: Localized;
};

/** An account of its own: by default one that was here before anything below was published. */
async function createReader(existing = true): Promise<Reader> {
	const id = randomUUID();
	const suffix = id.slice(0, 8);
	const reader = {
		id,
		email: `feature-note-${suffix}@local`,
		password: `feature-note-${suffix}-password`,
	};
	await db.insert(users).values({
		id,
		email: reader.email,
		passwordHash: bcrypt.hashSync(reader.password, 4),
		name: `Feature note reader ${suffix}`,
		role: "user",
		uiLanguage: "en",
		createdAt: existing ? new Date(Date.now() - 240 * HOUR) : new Date(),
	});
	return reader;
}

function suffix(): string {
	return randomUUID().slice(0, 8);
}

function noteContent(
	label: string,
	options: { actionDestination?: string; actionLabel?: string } = {},
): NoteContent {
	return {
		name: `${label} feature note`,
		title: { en: `${label}: small feature`, hu: `${label}: kis funkció` },
		body: {
			en: `${label} does one small useful thing.`,
			hu: `${label} egy kis hasznos dolgot tesz.`,
		},
		...(options.actionDestination
			? {
					actionLabel: {
						en: options.actionLabel ?? "Open settings",
						hu: `${options.actionLabel ?? "Open settings"} (HU)`,
					},
					actionDestination: options.actionDestination,
				}
			: {}),
	};
}

function releaseContent(label: string): ReleaseContent {
	return {
		name: `${label} release`,
		releaseVersion: "0.0.1",
		title: { en: `${label}: what changed`, hu: `${label}: mi változott` },
		body: { en: "Here is what is new.", hu: "Íme az újdonság." },
	};
}

test.describe("Feature notes: the landing strip", () => {
	let api: APIRequestContext;
	/** Every campaign this test published and has not yet archived. */
	let live: string[] = [];

	test.beforeEach(async ({ request }) => {
		api = await adminApi(request);
		live = [];
	});

	// What a test publishes is taken back out the way an admin does it, so a
	// later spec on this database never meets a note nobody asked for. A
	// published note is archived, never deleted.
	test.afterEach(async () => {
		for (const id of live) {
			const archived = await api.post(`/api/admin/campaigns/${id}/archive`);
			expect(archived.ok(), "archiving a published campaign").toBe(true);
		}
		live = [];
	});

	/** Creates, fills and publishes a campaign; its id is archived in `afterEach`. */
	async function publishCampaign(
		body: { type: string; name: string; releaseVersion?: string },
		slides: unknown[],
	): Promise<string> {
		const created = await api.post("/api/admin/campaigns", { data: body });
		expect(created.status(), "creating the draft").toBe(201);
		const id = ((await created.json()) as { campaign: { id: string } }).campaign
			.id;
		try {
			const filled = await api.patch(`/api/admin/campaigns/${id}`, {
				data: { slides },
			});
			expect(filled.ok(), `filling the draft: ${await filled.text()}`).toBe(
				true,
			);
			const published = await api.post(`/api/admin/campaigns/${id}/publish`);
			expect(published.ok(), `publishing: ${await published.text()}`).toBe(
				true,
			);
		} catch (error) {
			// A draft that never published reaches nobody; remove it so the admin
			// rail does not keep a half-written campaign. A published one is never
			// deleted here — it is archived.
			await api.delete(`/api/admin/campaigns/${id}`);
			throw error;
		}
		live.push(id);
		return id;
	}

	/**
	 * A feature note published through the admin API: the server seeds its one
	 * `standard`/`feature` slide, and this fills that slide with EN/HU words and
	 * an optional action before publishing.
	 */
	function publishFeatureNote(content: NoteContent): Promise<string> {
		return publishCampaign({ type: "feature_note", name: content.name }, [
			{
				layoutType: "standard",
				semanticRole: "feature",
				sortOrder: 1,
				title: content.title,
				body: content.body,
				...(content.actionDestination
					? {
							actionLabel: content.actionLabel,
							actionDestination: content.actionDestination,
						}
					: {}),
			},
		]);
	}

	function publishRelease(content: ReleaseContent): Promise<string> {
		return publishCampaign(
			{
				type: "release_update",
				name: content.name,
				releaseVersion: content.releaseVersion,
			},
			[
				{
					layoutType: "standard",
					sortOrder: 1,
					title: content.title,
					body: content.body,
				},
			],
		);
	}

	// ---- exact-path helpers (dev serves source modules under /src/lib too) ----

	function waitForFeatureNote(page: Page) {
		return page.waitForResponse(
			(response) =>
				response.request().method() === "GET" &&
				new URL(response.url()).pathname === FEATURE_NOTE_PATH,
		);
	}

	function waitForShownEvent(page: Page, campaignId: string) {
		return page.waitForResponse(
			(response) =>
				response.request().method() === "POST" &&
				new URL(response.url()).pathname ===
					`/api/campaigns/${campaignId}/events` &&
				bodyEventType(response) === "auto_shown",
		);
	}

	function waitForCompletion(
		page: Page,
		campaignId: string,
		reason: "completed" | "skipped",
	) {
		return page.waitForResponse(
			(response) =>
				response.request().method() === "POST" &&
				new URL(response.url()).pathname ===
					`/api/campaigns/${campaignId}/complete` &&
				bodyReason(response) === reason,
		);
	}

	function bodyEventType(response: Response): string | undefined {
		try {
			return (response.request().postDataJSON() as { eventType?: string })
				.eventType;
		} catch {
			return undefined;
		}
	}

	function bodyReason(response: Response): string | undefined {
		try {
			return (response.request().postDataJSON() as { reason?: string }).reason;
		} catch {
			return undefined;
		}
	}

	async function noteFrom(response: Response): Promise<FeatureNote | null> {
		return ((await response.json()) as { note: FeatureNote | null }).note;
	}

	/** Every request the page makes for the note, and how many of them are its eligibility read. */
	function watchFeatureNoteRequests(page: Page) {
		const seen: Array<{ method: string; pathname: string }> = [];
		page.on("request", (request) => {
			const { pathname } = new URL(request.url());
			if (pathname !== FEATURE_NOTE_PATH) return;
			seen.push({ method: request.method(), pathname });
		});
		return {
			all: () => [...seen],
			gets: () => seen.filter((entry) => entry.method === "GET").length,
			forget: () => {
				seen.length = 0;
			},
		};
	}

	/** One showing per accepted landing arrival, counted at the request, not the response. */
	function watchShownEvents(page: Page, campaignId: string) {
		const shown: string[] = [];
		page.on("request", (request) => {
			if (request.method() !== "POST") return;
			const { pathname } = new URL(request.url());
			if (pathname !== `/api/campaigns/${campaignId}/events`) return;
			const type = bodyEventTypeFromRequest(request);
			if (type === "auto_shown") shown.push(type);
		});
		return {
			count: () => shown.length,
		};
	}

	function bodyEventTypeFromRequest(request: {
		postDataJSON: () => unknown;
	}): string | undefined {
		try {
			return (request.postDataJSON() as { eventType?: string }).eventType;
		} catch {
			return undefined;
		}
	}

	/**
	 * A real load of the app at `path`, resolved once the server has said what it
	 * offers this reader and the page has gone quiet, so "no note" is an answer
	 * and not a race with a request still on its way.
	 */
	async function arrive(page: Page, path = "/") {
		const answered = page.waitForResponse(
			(response) =>
				response.request().method() === "GET" &&
				new URL(response.url()).pathname === "/api/campaigns/eligible",
		);
		await page.goto(path, { waitUntil: "domcontentloaded" });
		const { campaign } = (await (await answered).json()) as {
			campaign: { id: string; type: string } | null;
		};
		await page.waitForLoadState("networkidle");
		return campaign;
	}

	const card = (page: Page) =>
		page.getByRole("dialog", { name: "Campaign announcement" });
	const cardHeading = (page: Page, title: string) =>
		card(page).getByRole("heading", { name: title });
	const strip = (page: Page) => page.getByTestId("feature-note");

	/** Next to the last slide, then Finish, with the mouse; the completion is on the wire. */
	async function finishCard(page: Page, campaignId: string) {
		const completed = waitForCompletion(page, campaignId, "completed");
		await card(page)
			.getByRole("button", { name: "Finish", exact: true })
			.click();
		await completed;
		await expect(card(page)).toHaveCount(0);
	}

	// A fresh account's sidebar is the narrow rail, which has no badge: open it
	// the way a reader does, then press the badge next to the title.
	async function pressVersionBadge(page: Page) {
		await page
			.locator("aside.transitions-enabled")
			.waitFor({ state: "visible", timeout: 5000 });
		const expand = page.getByRole("button", { name: "Expand sidebar" });
		if (await expand.isVisible().catch(() => false)) await expand.click();
		await page.getByRole("button", { name: /^App version/ }).click();
	}

	async function openAdminPane(page: Page, pane: "Campaigns") {
		await page.goto("/settings");
		await page.waitForLoadState("networkidle");
		await page.getByRole("tab", { name: "Administration" }).click();
		await page.getByRole("button", { name: pane, exact: true }).click();
	}

	/** Finds the campaign the admin created by name and takes it back out of service. */
	async function archiveCampaignByName(name: string) {
		const listed = await api.get("/api/admin/campaigns");
		expect(listed.ok(), "listing campaigns").toBe(true);
		const { campaigns } = (await listed.json()) as {
			campaigns: Array<{ id: string; name: string | null; status: string }>;
		};
		for (const campaign of campaigns.filter((entry) => entry.name === name)) {
			if (campaign.status === "published") {
				const archived = await api.post(
					`/api/admin/campaigns/${campaign.id}/archive`,
				);
				expect(archived.ok(), "archiving the published note").toBe(true);
			} else if (campaign.status === "draft") {
				// A draft that never published reaches nobody; cleanup may delete it.
				await api.delete(`/api/admin/campaigns/${campaign.id}`);
			}
		}
	}

	test("shows the note's words and its way in on the landing, and never on a chat or Settings", async ({
		page,
	}) => {
		const reader = await createReader();
		await login(page, reader.email, reader.password);
		const content = noteContent(`E2E note ${suffix()}`, {
			actionDestination: "/settings",
		});
		const id = await publishFeatureNote(content);

		const requests = watchFeatureNoteRequests(page);
		const answered = waitForFeatureNote(page);
		const shown = waitForShownEvent(page, id);
		await page.goto("/", { waitUntil: "domcontentloaded" });
		const note = await noteFrom(await answered);
		expect(note?.id, "the published note is offered").toBe(id);

		const noteStrip = strip(page);
		await expect(noteStrip).toBeVisible();
		await expect(
			noteStrip.getByRole("heading", { name: content.title.en }),
		).toBeVisible();
		await expect(noteStrip).toContainText(content.body.en);
		const cta = noteStrip.getByRole("link", {
			name: content.actionLabel?.en ?? "",
		});
		await expect(cta).toBeVisible();
		await expect(cta).toHaveAttribute("href", "/settings");
		await shown;
		expect(requests.gets(), "the landing asks once").toBe(1);

		// A chat is not the landing: a full load of a conversation asks for no note.
		const conversationId = await createEmptyConversation(
			page,
			"A chat beside the note",
		);
		requests.forget();
		await page.goto(`/chat/${conversationId}`, {
			waitUntil: "domcontentloaded",
		});
		await page.waitForLoadState("networkidle");
		await expect(strip(page)).toHaveCount(0);
		expect(requests.gets(), "the chat route never asks for the note").toBe(0);

		// Neither is Settings.
		requests.forget();
		await page.goto("/settings", { waitUntil: "domcontentloaded" });
		await page.waitForLoadState("networkidle");
		await expect(strip(page)).toHaveCount(0);
		expect(requests.gets(), "Settings never asks for the note").toBe(0);
	});

	test("shows the fourth arrival and offers none on the fifth, recording one showing per accepted arrival", async ({
		page,
	}) => {
		const reader = await createReader();
		await login(page, reader.email, reader.password);
		const id = await publishFeatureNote(noteContent(`E2E cap ${suffix()}`));

		const requests = watchFeatureNoteRequests(page);
		const shown = watchShownEvents(page, id);

		for (let arrival = 1; arrival <= 4; arrival++) {
			const answered = waitForFeatureNote(page);
			const posted = waitForShownEvent(page, id);
			await page.goto("/", { waitUntil: "domcontentloaded" });
			const note = await noteFrom(await answered);
			expect(note?.id, `arrival ${arrival} is offered the note`).toBe(id);
			await expect(strip(page)).toBeVisible();
			await posted;
			// Exactly one showing per accepted arrival: none from a remount, none
			// from the campaign path, and none twice.
			expect(shown.count(), `arrival ${arrival} records one showing`).toBe(
				arrival,
			);
			expect(requests.gets(), `arrival ${arrival} asks once`).toBe(arrival);
		}

		const fifth = waitForFeatureNote(page);
		await page.goto("/", { waitUntil: "domcontentloaded" });
		expect(
			await noteFrom(await fifth),
			"the fifth arrival is offered none",
		).toBe(null);
		await expect(strip(page)).toHaveCount(0);
		expect(shown.count(), "the fifth arrival records no showing").toBe(4);
		expect(requests.gets(), "the fifth arrival still asks once").toBe(5);
	});

	test("X writes skipped, and the note is gone on the next arrival", async ({
		page,
	}) => {
		const reader = await createReader();
		await login(page, reader.email, reader.password);
		const id = await publishFeatureNote(noteContent(`E2E dismiss ${suffix()}`));

		const answered = waitForFeatureNote(page);
		const shown = waitForShownEvent(page, id);
		await page.goto("/", { waitUntil: "domcontentloaded" });
		await noteFrom(await answered);
		await expect(strip(page)).toBeVisible();
		await shown;

		const completed = waitForCompletion(page, id, "skipped");
		await strip(page)
			.getByRole("button", { name: "Dismiss", exact: true })
			.click();
		expect((await completed).ok(), "the skipped state is written").toBe(true);
		await expect(strip(page)).toHaveCount(0);

		// A new document load is a new arrival: the terminal state answers null.
		const later = waitForFeatureNote(page);
		await page.reload({ waitUntil: "domcontentloaded" });
		expect(await noteFrom(await later)).toBeNull();
		await expect(strip(page)).toHaveCount(0);
	});

	test("the CTA writes completed, follows its destination, and ends the note", async ({
		page,
	}) => {
		const reader = await createReader();
		await login(page, reader.email, reader.password);
		const content = noteContent(`E2E action ${suffix()}`, {
			actionDestination: "/settings",
			actionLabel: "Open settings",
		});
		const id = await publishFeatureNote(content);

		const answered = waitForFeatureNote(page);
		const shown = waitForShownEvent(page, id);
		await page.goto("/", { waitUntil: "domcontentloaded" });
		await noteFrom(await answered);
		await expect(strip(page)).toBeVisible();
		await shown;

		const completed = waitForCompletion(page, id, "completed");
		await strip(page)
			.getByRole("link", { name: content.actionLabel?.en ?? "" })
			.click();
		expect(
			(await completed).ok(),
			"the completed state survives the leave",
		).toBe(true);
		await page.waitForURL("**/settings");
		await page.waitForLoadState("networkidle");
		await expect(strip(page)).toHaveCount(0);

		// The destination is not the landing; the next arrival is answered null.
		const later = waitForFeatureNote(page);
		await page.goto("/", { waitUntil: "domcontentloaded" });
		expect(await noteFrom(await later)).toBeNull();
		await expect(strip(page)).toHaveCount(0);
	});

	test("a campaign wins the arrival: no note beside it, and none after it in that arrival", async ({
		page,
	}) => {
		const reader = await createReader();
		await login(page, reader.email, reader.password);
		const release = releaseContent(`E2E priority ${suffix()}`);
		const releaseId = await publishRelease(release);
		const noteId = await publishFeatureNote(
			noteContent(`E2E priority note ${suffix()}`),
		);

		const requests = watchFeatureNoteRequests(page);
		const offered = await arrive(page);
		expect(offered?.id, "the release is offered first").toBe(releaseId);
		expect(offered?.type).toBe("release_update");
		await expect(cardHeading(page, release.title.en)).toBeVisible();
		await expect(strip(page)).toHaveCount(0);
		expect(
			requests.all(),
			"a campaign arrival asks for no note at all",
		).toEqual([]);

		await finishCard(page, releaseId);
		await page.waitForLoadState("networkidle");
		// The same arrival: the campaign was dismissed here, so the note waits.
		await expect(strip(page)).toHaveCount(0);
		expect(
			requests.all(),
			"the note does not follow the campaign in the same arrival",
		).toEqual([]);

		// A new document load is a new arrival, and the campaign is consumed.
		const answered = waitForFeatureNote(page);
		const shown = waitForShownEvent(page, noteId);
		await page.goto("/", { waitUntil: "domcontentloaded" });
		expect((await noteFrom(await answered))?.id).toBe(noteId);
		await expect(strip(page)).toBeVisible();
		await shown;
	});

	test("a send hides the note at once and on the chat route, and the next arrival shows it again", async ({
		page,
	}) => {
		const reader = await createReader();
		const content = noteContent(`E2E send ${suffix()}`);
		// Published before the sign-in, so the landing the login arrives on shows it.
		const id = await publishFeatureNote(content);
		// The listener has to be in place before the arrival it counts.
		const shownBeforeSend = watchShownEvents(page, id);
		await login(page, reader.email, reader.password);
		await expect(strip(page)).toBeVisible({ timeout: 15_000 });
		expect(shownBeforeSend.count(), "the login arrival showed it once").toBe(1);

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

		await page
			.getByTestId("message-input")
			.fill("Szia! Két mesebeli kérdésem lenne.");
		await page.getByTestId("send-button").click();
		// Sending is not a dismissal, but it latches the note off the moment it starts.
		await expect(strip(page)).toHaveCount(0);

		await page.waitForURL(/\/chat\//, { timeout: 20_000 });
		await waitForAssistantResponse(page);
		await expect(page.getByText(REPLY)).toBeVisible();
		await page.waitForLoadState("networkidle");
		await expect(strip(page)).toHaveCount(0);

		// The next landing arrival is a new invitation: it is still under the cap.
		const answered = waitForFeatureNote(page);
		await page.goto("/", { waitUntil: "domcontentloaded" });
		expect((await noteFrom(await answered))?.id).toBe(id);
		await expect(strip(page)).toBeVisible();
	});

	test("a send that fails before it navigates keeps the note hidden for that arrival", async ({
		page,
	}) => {
		const reader = await createReader();
		await login(page, reader.email, reader.password);
		const content = noteContent(`E2E failed send ${suffix()}`);
		const id = await publishFeatureNote(content);

		const requests = watchFeatureNoteRequests(page);
		const answered = waitForFeatureNote(page);
		const shown = waitForShownEvent(page, id);
		await page.goto("/", { waitUntil: "domcontentloaded" });
		await noteFrom(await answered);
		await expect(strip(page)).toBeVisible();
		await shown;

		// Conversation creation is the step before the hand-off. Failing it fails
		// the send inside the landing page, so the app stays on "/".
		await page.route("**/api/conversations", async (route) => {
			if (route.request().method() !== "POST") {
				await route.continue();
				return;
			}
			await route.fulfill({
				status: 500,
				contentType: "application/json",
				body: JSON.stringify({ error: "e2e: conversation creation refused" }),
			});
		});

		await page
			.getByTestId("message-input")
			.fill("A message that cannot start a conversation.");
		await page.getByTestId("send-button").click();

		// The alert is the catch that also puts `sendStarted` back to false: the
		// send began (the latch) and then failed before any navigation.
		await expect(
			page
				.getByRole("alert")
				.filter({ hasText: "Failed to create conversation" }),
		).toBeVisible();
		await expect(page).toHaveURL("/");
		await expect(strip(page)).toHaveCount(0);
		await page.waitForLoadState("networkidle");
		expect(
			requests.gets(),
			"a failed send does not ask for the note again in this arrival",
		).toBe(1);
		await expect(strip(page)).toHaveCount(0);

		// A new document load is a new arrival: the note was never dismissed.
		const later = waitForFeatureNote(page);
		await page.goto("/", { waitUntil: "domcontentloaded" });
		expect((await noteFrom(await later))?.id).toBe(id);
		await expect(strip(page)).toBeVisible();
	});

	test("a campaign opened from the badge clears the note, and it waits for the next arrival", async ({
		page,
	}) => {
		const reader = await createReader();
		await login(page, reader.email, reader.password);
		const release = releaseContent(`E2E badge ${suffix()}`);
		const releaseId = await publishRelease(release);
		const noteId = await publishFeatureNote(
			noteContent(`E2E badge note ${suffix()}`),
		);

		// The release is the reader's to see once; finishing it consumes it.
		expect((await arrive(page))?.id).toBe(releaseId);
		await expect(cardHeading(page, release.title.en)).toBeVisible();
		await finishCard(page, releaseId);

		const requests = watchFeatureNoteRequests(page);
		const answered = waitForFeatureNote(page);
		const shown = waitForShownEvent(page, noteId);
		await page.goto("/", { waitUntil: "domcontentloaded" });
		expect((await noteFrom(await answered))?.id).toBe(noteId);
		await expect(strip(page)).toBeVisible();
		await shown;
		expect(requests.gets()).toBe(1);

		// The badge replays the release the reader has already seen. Opening it
		// over the note hands the arrival to the campaign.
		await pressVersionBadge(page);
		await expect(cardHeading(page, release.title.en)).toBeVisible();
		await expect(strip(page)).toHaveCount(0);

		// A replay is not persisted, so nothing new is completed; the note still
		// does not come back in this arrival.
		await card(page)
			.getByRole("button", { name: "Finish", exact: true })
			.click();
		await expect(card(page)).toHaveCount(0);
		await page.waitForLoadState("networkidle");
		await expect(strip(page)).toHaveCount(0);
		expect(
			requests.gets(),
			"opening the campaign does not ask for the note again",
		).toBe(1);

		// A new document load is a new arrival, and the campaign is consumed.
		const later = waitForFeatureNote(page);
		await page.goto("/", { waitUntil: "domcontentloaded" });
		expect((await noteFrom(await later))?.id).toBe(noteId);
		await expect(strip(page)).toBeVisible();
	});

	test("a client-side New chat is a landing arrival: it asks, shows, and counts one showing each time", async ({
		page,
	}) => {
		const reader = await createReader();
		await login(page, reader.email, reader.password);
		const id = await publishFeatureNote(
			noteContent(`E2E new chat ${suffix()}`),
		);

		const requests = watchFeatureNoteRequests(page);
		const shown = watchShownEvents(page, id);
		const conversationId = await createEmptyConversation(
			page,
			"A chat before the note",
		);
		await page.goto(`/chat/${conversationId}`, {
			waitUntil: "domcontentloaded",
		});
		await page.waitForLoadState("networkidle");
		expect(requests.gets(), "a chat never asks for the note").toBe(0);

		// The sidebar's New chat door is a client-side navigation back to "/".
		const first = waitForFeatureNote(page);
		const firstShown = waitForShownEvent(page, id);
		await page.getByTestId("new-conversation").click();
		await expect(page).toHaveURL("/");
		expect((await noteFrom(await first))?.id).toBe(id);
		await expect(strip(page)).toBeVisible();
		await firstShown;
		expect(shown.count(), "the arrival records one showing").toBe(1);
		expect(requests.gets(), "the arrival asks once").toBe(1);

		// Leave the landing and come back through the same door: a new arrival
		// resets the per-arrival latch and asks again.
		await page.getByRole("button", { name: "Open knowledge base" }).click();
		await expect(page).toHaveURL(/\/knowledge/);
		await page.waitForLoadState("networkidle");
		await expect(strip(page)).toHaveCount(0);

		const second = waitForFeatureNote(page);
		const secondShown = waitForShownEvent(page, id);
		await page.getByTestId("new-conversation").click();
		await expect(page).toHaveURL("/");
		expect((await noteFrom(await second))?.id).toBe(id);
		await expect(strip(page)).toBeVisible();
		await secondShown;
		expect(shown.count(), "the second arrival records one more showing").toBe(
			2,
		);
		expect(requests.gets(), "the second arrival asks once more").toBe(2);
	});

	test("a note is eligible but a direct non-landing load never asks for it", async ({
		page,
	}) => {
		const reader = await createReader();
		await login(page, reader.email, reader.password);
		const id = await publishFeatureNote(noteContent(`E2E direct ${suffix()}`));
		const requests = watchFeatureNoteRequests(page);

		await page.goto("/settings", { waitUntil: "domcontentloaded" });
		await page.waitForLoadState("networkidle");
		await expect(strip(page)).toHaveCount(0);
		expect(requests.gets(), "Settings never asks for the note").toBe(0);

		await page.goto("/knowledge", { waitUntil: "domcontentloaded" });
		await page.waitForLoadState("networkidle");
		await expect(strip(page)).toHaveCount(0);
		expect(requests.gets(), "Knowledge never asks for the note").toBe(0);

		// It was eligible all along; only the landing asks.
		const answered = waitForFeatureNote(page);
		await page.goto("/", { waitUntil: "domcontentloaded" });
		expect((await noteFrom(await answered))?.id).toBe(id);
		await expect(strip(page)).toBeVisible();
	});

	test("an admin creates, fills, previews and publishes a feature note", async ({
		page,
	}) => {
		const label = `E2E feature note ${suffix()}`;
		const title = { en: `${label} title`, hu: `${label} cím` };
		const body = {
			en: "One short line about the feature.",
			hu: "Egy rövid sor a funkcióról.",
		};
		const actionLabel = {
			en: "Open settings",
			hu: "Beállítások megnyitása",
		};

		try {
			await login(page);
			await openAdminPane(page, "Campaigns");
			await page.getByRole("button", { name: "New campaign" }).click();
			await page.locator("#campaign-dialog-name").fill(label);

			// Choosing a release asks for its version; a feature note does not.
			await page.getByRole("button", { name: "Release", exact: true }).click();
			await expect(page.locator("#campaign-dialog-release")).toBeVisible();
			await page
				.getByRole("button", { name: "Feature note", exact: true })
				.click();
			await expect(page.locator("#campaign-dialog-release")).toHaveCount(0);
			await page.getByRole("button", { name: "Create campaign" }).click();

			// The server seeded the note's one slide; the pane never asks for another.
			await expect(
				page.getByRole("heading", { name: label }).first(),
			).toBeVisible();
			const checklist = page.getByTestId("campaign-checklist");
			await expect(checklist).toBeVisible();
			await expect(checklist.getByText(/checks? failing/)).toBeVisible();
			await expect(
				page.locator('[data-testid="admin-campaign-slide-thumb"]'),
			).toHaveCount(1);
			await expect(page.getByRole("button", { name: "Add slide" })).toHaveCount(
				0,
			);
			await expect(
				page.getByRole("heading", { name: "Note", exact: true }),
			).toBeVisible();
			// A note is words and one optional action: no screenshot, no alt text.
			await expect(page.getByLabel("Alt text", { exact: true })).toHaveCount(0);
			await expect(
				page.locator('input[type="file"][accept="image/*"]'),
			).toHaveCount(0);

			await page.getByLabel("Title", { exact: true }).fill(title.en);
			await page.getByLabel("Body", { exact: true }).fill(body.en);
			await page
				.getByLabel("Action destination", { exact: true })
				.selectOption("/settings");
			await page
				.getByLabel("Action label", { exact: true })
				.fill(actionLabel.en);

			// The language pills carry the same fields in Hungarian.
			await page.getByRole("button", { name: "HU", exact: true }).click();
			await page.getByLabel("Title", { exact: true }).fill(title.hu);
			await page.getByLabel("Body", { exact: true }).fill(body.hu);
			await page
				.getByLabel("Action label", { exact: true })
				.fill(actionLabel.hu);
			await page.getByRole("button", { name: "EN", exact: true }).click();

			// The preview is the reader's own strip, drawn in the edited language.
			const preview = page.getByTestId("note-preview");
			await expect(preview.getByTestId("feature-note")).toBeVisible();
			await expect(
				preview.getByRole("heading", { name: title.en }),
			).toBeVisible();
			await expect(preview).toContainText(body.en);
			await expect(
				preview.getByRole("link", { name: actionLabel.en }),
			).toBeVisible();

			// The checklist mirrors the server and is ready; Publish is live.
			await expect(checklist.getByText(/Ready to publish/)).toBeVisible();
			await expect(
				page.getByRole("button", { name: "Publish", exact: true }),
			).toBeEnabled();
			await page.getByRole("button", { name: "Publish", exact: true }).click();
			await expect(page.getByText("Campaign published.")).toBeVisible();

			// The rail row and the editor's meta line name what it is, not "1 slide".
			const row = page
				.getByTestId("admin-campaign-row")
				.filter({ hasText: label });
			await expect(row).toContainText("Feature note · 1 note");
			await expect(page.locator(".editor-meta")).toContainText(
				"Feature note · 1 note",
			);
		} finally {
			await archiveCampaignByName(label);
		}
	});
});
