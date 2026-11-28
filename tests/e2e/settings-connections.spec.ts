import { expect, type Locator, type Page, test } from "@playwright/test";

import { E2E_GMAIL_PILOT_ID } from "./e2e-env";
import { expectTopmost, login, waitForMotionToSettle } from "./helpers";

// Connections redesign — a smoke test of the tab's four states, the connect
// wizard per provider, and the detail dialog.
//
// The connection list is stubbed rather than seeded: every state this screen
// has to render (a healthy account, one that needs signing in again, one that
// can't be reached, one that is turned off) is a SERVER condition that a real
// fixture can only produce by faking the provider anyway. Stubbing the one
// endpoint keeps the spec about what the screen does with each answer, which
// is the part that regressed before.

type StubConnection = Record<string, unknown>;

const NOW = Math.floor(Date.now() / 1000);

function connection(overrides: StubConnection = {}): StubConnection {
	return {
		id: "conn-nextcloud",
		provider: "nextcloud",
		label: "Nextcloud",
		accountIdentifier: "cloud.example.com",
		status: "connected",
		statusDetail: null,
		defaultOn: true,
		allowWrites: false,
		writeAllowlist: [],
		capabilities: ["files", "contacts"],
		grantedCapabilities: ["files", "contacts"],
		config: {},
		oauthScopes: [],
		tokenExpiresAt: null,
		hasSecret: true,
		hasWriteSecret: false,
		lastUsedAt: NOW - 720,
		statusChangedAt: null,
		createdAt: NOW - 86_400 * 30,
		updatedAt: NOW - 86_400,
		...overrides,
	};
}

async function stubConnections(
	page: Page,
	connections: StubConnection[],
	options: { status?: number } = {},
) {
	await page.route("**/api/connections", async (route) => {
		if (options.status && options.status >= 400) {
			await route.fulfill({
				status: options.status,
				contentType: "application/json",
				body: JSON.stringify({ error: "boom" }),
			});
			return;
		}
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ connections }),
		});
	});
	await page.route("**/api/connections/locality", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ localDistill: true }),
		});
	});
	// Opening a detail dialog asks the server whether that connection still
	// works. The connections themselves are stubbed, so the real route would
	// 404 on ids that were never in the database; answer with the row we
	// already handed the page so the recheck is a no-op.
	await page.route("**/api/connections/*/recheck", async (route) => {
		const id = new URL(route.request().url()).pathname.split("/").at(-2);
		const connection = connections.find((conn) => conn.id === id);
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ connection }),
		});
	});
}

async function openConnectionsTab(page: Page) {
	await page.goto("/settings?section=connections", {
		waitUntil: "domcontentloaded",
	});
	await expect(page.getByTestId("connections-locality")).toBeVisible({
		timeout: 15000,
	});
}

test.describe("settings connections tab", () => {
	test("puts the privacy control first and says what it does", async ({
		page,
	}) => {
		await login(page);
		await stubConnections(page, [connection()]);
		await openConnectionsTab(page);

		const privacy = page.getByTestId("connections-locality");
		await expect(privacy).toContainText("Keep connected data on this device");
		await expect(page.getByTestId("connections-locality-state")).toHaveText(
			/On/,
		);
	});

	// One grammar: every row is a word plus a sentence saying what happened
	// and when, whatever state it is in.
	test("renders every connection state with a word and a sentence", async ({
		page,
	}) => {
		await login(page);
		await stubConnections(page, [
			connection(),
			connection({
				id: "conn-google",
				provider: "google",
				label: "Google",
				accountIdentifier: "person@example.com",
				status: "needs_reauth",
				capabilities: ["calendar"],
				grantedCapabilities: ["calendar"],
				statusChangedAt: NOW - 86_400 * 2,
				lastUsedAt: null,
			}),
			connection({
				id: "conn-github",
				provider: "github",
				label: "GitHub",
				accountIdentifier: "octocat",
				status: "error",
				statusDetail: "401 Bad credentials",
				capabilities: ["repos"],
				grantedCapabilities: ["repos"],
				statusChangedAt: NOW - 3600,
				lastUsedAt: null,
			}),
			connection({
				id: "conn-owntracks",
				provider: "owntracks",
				label: "OwnTracks",
				accountIdentifier: "phone",
				status: "disconnected",
				capabilities: ["location"],
				grantedCapabilities: ["location"],
				statusChangedAt: NOW - 86_400 * 8,
				lastUsedAt: null,
			}),
		]);
		await openConnectionsTab(page);

		await expect(
			page.getByTestId("connection-row-conn-nextcloud"),
		).toContainText("Connected");
		await expect(
			page.getByTestId("connection-row-conn-nextcloud"),
		).toContainText("Last used");

		const google = page.getByTestId("connection-row-conn-google");
		await expect(google).toContainText("Needs sign-in again");
		await expect(google).toContainText(
			"stopped accepting the saved permission",
		);
		// A denied capability is named as denied, not silently missing.
		await expect(google).toContainText("Contacts — not allowed");
		await expect(page.getByTestId("connection-recover-conn-google")).toHaveText(
			"Sign in again",
		);

		const github = page.getByTestId("connection-row-conn-github");
		await expect(github).toContainText("Can't reach it");
		// The provider's raw error stays out of the row.
		await expect(github).not.toContainText("401 Bad credentials");
		await expect(page.getByTestId("connection-recover-conn-github")).toHaveText(
			"Fix this",
		);

		const owntracks = page.getByTestId("connection-row-conn-owntracks");
		await expect(owntracks).toContainText("Turned off");
		await expect(
			page.getByTestId("connection-recover-conn-owntracks"),
		).toHaveText("Connect again");
	});

	// A failed load used to render the same card as an empty account.
	test("tells a failed load apart from an empty account", async ({ page }) => {
		await login(page);
		await stubConnections(page, [], { status: 500 });
		await openConnectionsTab(page);

		const card = page.getByTestId("connections-load-failed");
		await expect(card).toBeVisible();
		await expect(card).toContainText("We couldn't load your connections");
		await expect(card.getByText("Try again")).toBeVisible();
		await expect(page.getByTestId("connections-empty")).toHaveCount(0);
	});

	test("shows the empty state for an account with no connections", async ({
		page,
	}) => {
		await login(page);
		await stubConnections(page, []);
		await openConnectionsTab(page);
		await expect(page.getByTestId("connections-empty")).toBeVisible();
	});

	test("offers every provider with a line saying what it brings", async ({
		page,
	}) => {
		await login(page);
		await stubConnections(page, []);
		await openConnectionsTab(page);

		const add = page.getByTestId("connections-add");
		await expect(add.getByText("Your files and contacts")).toBeVisible();
		await expect(add.getByText("Set one up yourself")).toBeVisible();
		await expect(page.getByTestId("connections-add-caldav")).toBeVisible();
	});

	test("opens the detail dialog with switches only for granted capabilities", async ({
		page,
	}) => {
		await login(page);
		await stubConnections(page, [
			connection({
				id: "conn-google",
				provider: "google",
				label: "Google",
				accountIdentifier: "person@example.com",
				capabilities: ["calendar"],
				grantedCapabilities: ["calendar"],
			}),
		]);
		await openConnectionsTab(page);

		await page.getByTestId("connection-details-conn-google").click();
		const dialog = page.getByTestId("connection-detail-conn-google");
		await expect(dialog).toBeVisible();
		await expect(dialog.getByText("What Alfy may use")).toBeVisible();
		await expect(
			dialog.getByRole("switch", { name: "Calendar" }),
		).toBeVisible();
		// Denied: a greyed line with the only action that can fix it.
		await expect(dialog.getByRole("switch", { name: "Contacts" })).toHaveCount(
			0,
		);
		await expect(
			page.getByTestId("capability-contacts-ask-again"),
		).toBeVisible();
		await expect(
			dialog.getByRole("button", { name: "Disconnect Google" }),
		).toBeVisible();
	});

	test("asking Microsoft for Calendar keeps a disabled Files switch off", async ({
		page,
	}) => {
		await login(page);
		await stubConnections(page, [
			connection({
				id: "conn-microsoft",
				provider: "onedrive",
				label: "Microsoft",
				capabilities: [],
				grantedCapabilities: ["files"],
			}),
		]);
		await openConnectionsTab(page);
		await page.getByTestId("connection-details-conn-microsoft").click();
		await page.getByTestId("capability-calendar-ask-again").click();
		await expect(
			page.getByRole("checkbox", { name: "Calendar", exact: true }),
		).toBeChecked();
		await expect(
			page.getByRole("checkbox", { name: "Files", exact: true }),
		).not.toBeChecked();
	});

	// "Let Alfy write" on an Immich account needs a write key of its own, which
	// Immich only makes for a signed-in person. The switch therefore asks for the
	// password once, makes the key, and only then turns writes on.
	test("Immich: Let Alfy write asks for the password once, makes the key, then turns writes on", async ({
		page,
	}) => {
		await login(page);
		const immich = connection({
			id: "conn-immich",
			provider: "immich",
			label: "Immich",
			accountIdentifier: "me@example.com",
			capabilities: ["photos"],
			grantedCapabilities: ["photos"],
			config: { origin: "https://photos.example.com" },
		});
		await stubConnections(page, [immich]);

		const calls: { call: string; body: unknown }[] = [];
		await page.route(
			"**/api/connections/immich/enable-writes",
			async (route) => {
				calls.push({
					call: "make the write key",
					body: route.request().postDataJSON(),
				});
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({
						connection: { ...immich, hasWriteSecret: true },
					}),
				});
			},
		);
		await page.route("**/api/connections/conn-immich", async (route) => {
			if (route.request().method() !== "PATCH") {
				await route.fallback();
				return;
			}
			calls.push({
				call: "turn writes on",
				body: route.request().postDataJSON(),
			});
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					...immich,
					hasWriteSecret: true,
					allowWrites: true,
				}),
			});
		});

		await openConnectionsTab(page);
		await page.getByTestId("connection-details-conn-immich").click();
		const dialog = page.getByTestId("connection-detail-conn-immich");
		const writesSwitch = dialog.getByRole("switch", { name: "Let Alfy write" });

		await writesSwitch.click();
		const form = dialog.getByTestId("immich-write-key");
		await expect(form).toBeVisible();
		// Nothing has been sent: the switch only asked.
		expect(calls).toEqual([]);

		await form.getByLabel("Password", { exact: true }).fill("hunter2");
		await form.getByRole("button", { name: "Turn on" }).click();

		await expect(form).toHaveCount(0);
		await expect(writesSwitch).toHaveAttribute("aria-checked", "true");
		expect(calls).toEqual([
			{
				call: "make the write key",
				body: { connectionId: "conn-immich", password: "hunter2" },
			},
			{ call: "turn writes on", body: { allowWrites: true } },
		]);
	});

	test("keeps Google Drive and Gmail as separate choices in the pilot", async ({
		page,
	}) => {
		const { db } = await import("../../src/lib/server/db");
		const { users } = await import("../../src/lib/server/db/schema");
		const { eq } = await import("drizzle-orm");
		const { hash } = await import("bcryptjs");
		const email = "gmail-pilot@local";
		const password = "synthetic-pilot-password";
		await db.insert(users).values({
			id: E2E_GMAIL_PILOT_ID,
			email,
			passwordHash: await hash(password, 4),
		});
		try {
			await login(page, email, password);
			await stubConnections(page, []);
			await openConnectionsTab(page);
			await page.getByTestId("connections-add-google").click();
			const dialog = page.getByRole("dialog");
			const gmail = dialog.getByRole("checkbox", {
				name: "Gmail",
				exact: true,
			});
			const drive = dialog.getByRole("checkbox", {
				name: "Google Drive",
				exact: true,
			});
			await expect(drive).not.toBeChecked();
			await drive.press("Space");
			const manageDrive = dialog.getByRole("checkbox", {
				name: "Request Google Drive management",
			});
			await expect(manageDrive).not.toBeChecked();
			await manageDrive.press("Space");
			await expect(gmail).not.toBeChecked();
			await gmail.press("Space");
			await dialog
				.getByRole("checkbox", { name: "Calendar", exact: true })
				.press("Space");
			await dialog
				.getByRole("checkbox", { name: "Contacts", exact: true })
				.press("Space");
			const manage = dialog.getByRole("checkbox", {
				name: "Request Gmail management",
			});
			await expect(manage).not.toBeChecked();
			await manage.press("Space");
			const endpoint = "**/api/connections/google/start";
			await page.route(endpoint, (route) =>
				route.fulfill({ json: { authUrl: "/about" } }),
			);
			const sent = page.waitForRequest(endpoint);
			await dialog.getByRole("button", { name: "Continue to Google" }).click();
			expect((await sent).postDataJSON()).toEqual({
				capabilities: ["files", "email"],
				requestGmailEditing: true,
				requestDriveEditing: true,
			});
		} finally {
			await db.delete(users).where(eq(users.id, E2E_GMAIL_PILOT_ID));
		}
	});
	test.describe("the connect wizard", () => {
		test.beforeEach(async ({ page }) => {
			await login(page);
			await stubConnections(page, []);
			await openConnectionsTab(page);
		});

		test("sets up Bosch from Connections with a copyable callback and a choice of permissions", async ({
			page,
		}) => {
			const callbackUrl = new URL(
				"/api/connections/bosch/hosted/callback",
				page.url(),
			).href;
			let start: unknown;
			let rejectCallback = true;
			await page.route("**/api/connections/bosch/hosted", (route) => {
				if (route.request().method() === "GET")
					return route.fulfill({
						json: { mode: "none", grants: [], callbackUrl },
					});
				start = route.request().postDataJSON();
				if (rejectCallback) {
					rejectCallback = false;
					return route.fulfill({
						status: 422,
						json: { error: "redirect_uri_mismatch" },
					});
				}
				return route.fulfill({
					json: {
						authUrl: new URL(
							"/settings?section=connections&connected=bosch",
							page.url(),
						).href,
					},
				});
			});
			await page.getByTestId("connections-add-bosch").click();
			const dialog = page.getByRole("dialog");
			await expect(
				dialog.getByLabel("Redirect URI", { exact: true }),
			).toHaveValue(callbackUrl);
			await expect(
				dialog.getByRole("button", { name: "Sign in with Bosch" }),
			).toBeDisabled();
			await dialog.getByLabel("Bosch client ID").fill("example-client");
			await dialog.getByLabel("Fitness measurements", { exact: true }).check();
			await dialog.getByRole("button", { name: "Sign in with Bosch" }).click();
			await expect(dialog.getByRole("alert")).toContainText(
				"Bosch rejected this Redirect URI",
			);
			await expect(
				dialog.getByLabel("Redirect URI", { exact: true }),
			).toHaveValue(callbackUrl);
			await expect(
				dialog.getByLabel("Fitness measurements", { exact: true }),
			).toBeChecked();
			await dialog.getByLabel("Bosch client ID").fill("corrected-client");
			await dialog.getByRole("button", { name: "Sign in with Bosch" }).click();
			await expect
				.poll(() => start)
				.toEqual({ clientId: "corrected-client", grants: ["fitness"] });
			await expect(dialog).not.toBeVisible();
		});
		test("pairs one personal Bosch rider service and keeps the pairing code on the setup screen", async ({
			page,
		}) => {
			await page.route("**/api/connections/bosch/hosted", (route) =>
				route.fulfill({
					json: {
						mode: "none",
						grants: [],
						callbackUrl: new URL(
							"/api/connections/bosch/hosted/callback",
							page.url(),
						).href,
					},
				}),
			);
			await page.route("**/api/connections/bosch/start", (route) =>
				route.fulfill({
					json: {
						connectionId: "synthetic-rider",
						pairingToken: "synthetic-code",
					},
				}),
			);
			await page.getByTestId("connections-add-bosch").click();
			const dialog = page.getByRole("dialog");
			await expect(dialog.getByLabel("Bosch client ID")).toBeVisible();
			await waitForMotionToSettle(page);
			const gaps = await dialog.locator(".wizard-head").evaluate((header) => {
				const title = header
					.querySelector(".wizard-title")
					?.getBoundingClientRect();
				const subtitle = header
					.querySelector(".wizard-subtitle")
					?.getBoundingClientRect();
				const instructions = header.nextElementSibling?.getBoundingClientRect();
				if (!title || !subtitle || !instructions) {
					throw new Error("Missing wizard header or instructions");
				}
				return {
					titleToSubtitle: subtitle.top - title.bottom,
					headerToInstructions:
						instructions.top - header.getBoundingClientRect().bottom,
				};
			});
			expect(gaps.titleToSubtitle).toBeGreaterThanOrEqual(7.5);
			expect(gaps.headerToInstructions).toBeGreaterThanOrEqual(15.5);
			await dialog.getByText("Run the bridge yourself").click();
			await expect(
				dialog.getByRole("link", { name: "Download the bridge" }),
			).toHaveAttribute("href", "/api/connections/bosch/runner");
			await dialog.getByRole("button", { name: "Create pairing key" }).click();
			await expect(dialog.getByLabel("AlfyAI pairing key")).toHaveValue(
				"synthetic-code",
			);
			await dialog
				.locator(".wizard-foot")
				.getByRole("button", { name: "Close" })
				.click();
			await expect(dialog).not.toBeVisible();
		});
		test("distinguishes recorder users sharing a phone name and binds the selected pair", async ({
			page,
		}) => {
			const devices = [
				{ otUser: "iris", otDevice: "phone", lastSeen: NOW },
				{ otUser: "mira", otDevice: "phone", lastSeen: NOW },
				{ otUser: "mira", otDevice: "tablet" },
			];
			await page.route("**/api/connections/owntracks/devices", (route) =>
				route.fulfill({ json: { devices } }),
			);
			const endpoint = "**/api/connections/owntracks/start";
			await page.route(endpoint, (route) =>
				route.fulfill({
					json: {
						connection: connection({
							id: "picked",
							provider: "owntracks",
							accountIdentifier: "mira/tablet",
							label: "mira / tablet",
						}),
					},
				}),
			);
			await page.getByTestId("connections-add-owntracks").click();
			await expect(
				page.getByRole("radio", { name: "iris / phone", exact: true }),
			).toHaveCount(1);
			await expect(
				page.getByRole("radio", { name: "mira / phone", exact: true }),
			).toHaveCount(1);
			const selected = page.getByRole("radio", {
				name: "mira / tablet",
				exact: true,
			});
			await selected.press("Space");
			await expect(selected).toBeChecked();
			const sent = page.waitForRequest(endpoint);
			await page.getByRole("button", { name: "Use this device" }).click();
			expect((await sent).postDataJSON()).toEqual({
				otUser: "mira",
				otDevice: "tablet",
			});
		});

		test("opens the consent chooser for an OAuth provider", async ({
			page,
		}) => {
			await page.getByTestId("connections-add-google").click();
			await expect(
				page.getByRole("checkbox", { name: "Gmail", exact: true }),
			).toHaveCount(0);
			await expect(
				page.getByRole("heading", { name: "Connect Google" }),
			).toBeVisible();
			await expect(
				page.getByText(
					"Read your events so Alfy can answer questions about your week.",
				),
			).toBeVisible();
			await expect(
				page.getByRole("button", { name: "Continue to Google" }),
			).toBeVisible();
		});

		for (const manage of [false, true]) {
			test(`requests Google Tasks ${manage ? "editing" : "reading"} only after opting in`, async ({
				page,
			}) => {
				const endpoint = "**/api/connections/google/start";
				await page.route(endpoint, (route) =>
					route.fulfill({ json: { authUrl: "/about" } }),
				);
				await page.getByTestId("connections-add-google").click();
				const dialog = page.getByRole("dialog");
				const tasks = dialog.getByRole("checkbox", {
					name: "Google Tasks",
					exact: true,
				});
				const edit = dialog.getByRole("checkbox", {
					name: "Request Google Tasks editing",
				});
				await expect(tasks).not.toBeChecked();
				await expect(edit).toHaveCount(0);
				await tasks.press("Space");
				await expect(edit).not.toBeChecked();
				if (manage) await edit.press("Space");
				const sent = page.waitForRequest(endpoint);
				await dialog
					.getByRole("button", { name: "Continue to Google" })
					.click();
				expect((await sent).postDataJSON()).toEqual({
					capabilities: ["calendar", "contacts", "tasks"],
					...(manage ? { requestTasksEditing: true } : {}),
				});
			});
		}

		test("requests Google Calendar editing only when the checkbox is selected", async ({
			page,
		}) => {
			const endpoint = "**/api/connections/google/start";
			await page.route(endpoint, (route) =>
				route.fulfill({ json: { authUrl: "/about" } }),
			);
			await page.getByTestId("connections-add-google").click();
			const editing = page.getByRole("checkbox", {
				name: "Request Google Calendar editing",
			});
			await expect(editing).not.toBeChecked();
			await editing.press("Space");
			const sent = page.waitForRequest(endpoint);
			await page.getByRole("button", { name: "Continue to Google" }).click();
			expect((await sent).postDataJSON()).toEqual({
				capabilities: expect.arrayContaining(["calendar"]),
				requestCalendarEditing: true,
			});
		});

		test("keeps Microsoft mail edits separate from sending", async ({
			page,
		}) => {
			const endpoint = "**/api/connections/onedrive/start";
			await page.route(endpoint, (route) =>
				route.fulfill({ json: { authUrl: "/about" } }),
			);
			await page.getByTestId("connections-add-onedrive").click();
			const chooser = page.getByRole("dialog");
			await chooser
				.getByRole("checkbox", { name: "Files", exact: true })
				.press("Space");
			await chooser
				.getByRole("checkbox", { name: "Email", exact: true })
				.press("Space");
			await expect(
				chooser.getByRole("checkbox", { name: "Manage email and drafts" }),
			).not.toBeChecked();
			await chooser
				.getByRole("checkbox", { name: "Send email", exact: true })
				.press("Space");
			const sent = page.waitForRequest(endpoint);
			await chooser
				.getByRole("button", { name: "Continue to Microsoft" })
				.click();
			expect((await sent).postDataJSON()).toEqual({
				capabilities: ["email"],
				writePermissions: ["send"],
			});
		});

		test("asks separately for Teams chat, channels and channel files on a work or school account", async ({
			page,
		}) => {
			const endpoint = "**/api/connections/onedrive/start";
			await page.route(endpoint, (route) =>
				route.fulfill({ status: 200, json: { authUrl: "/about" } }),
			);
			await page.getByTestId("connections-add-onedrive").click();
			const dialog = page.getByRole("dialog");
			await dialog
				.getByRole("checkbox", { name: "Files", exact: true })
				.press("Space");
			for (const name of [
				"Teams chats",
				"Teams channels",
				"Teams channel files",
			]) {
				const box = dialog.getByRole("checkbox", { name, exact: true });
				await expect(box).not.toBeChecked();
				await box.press("Space");
			}
			await dialog
				.getByRole("checkbox", { name: "Send chat messages and reactions" })
				.press("Space");
			const sent = page.waitForRequest(endpoint);
			await dialog
				.getByRole("button", { name: "Continue to Microsoft" })
				.click();
			expect((await sent).postDataJSON()).toEqual({
				capabilities: ["teams_chat", "teams_channels", "teams_files"],
				writePermissions: ["teams_chat"],
			});
		});
		test("lets a Microsoft user connect Outlook Calendar without OneDrive files", async ({
			page,
		}) => {
			const endpoint = "**/api/connections/onedrive/start";
			await page.route(endpoint, (route) =>
				route.fulfill({ status: 200, json: { authUrl: "/about" } }),
			);
			await page.getByTestId("connections-add-onedrive").click();
			const dialog = page.getByRole("dialog");
			const files = dialog.getByRole("checkbox", {
				name: "Files",
				exact: true,
			});
			const calendar = dialog.getByRole("checkbox", {
				name: "Calendar",
				exact: true,
			});
			await expect(files).toBeChecked();
			await expect(calendar).not.toBeChecked();
			await files.press("Space");
			await calendar.press("Space");
			const sent = page.waitForRequest(endpoint);
			await dialog
				.getByRole("button", { name: "Continue to Microsoft" })
				.click();
			expect((await sent).postDataJSON()).toEqual({
				capabilities: ["calendar"],
			});
		});

		test("asks where the mailbox lives, with no IMAP on the first screen", async ({
			page,
		}) => {
			await page.getByTestId("connections-add-imap").click();
			await expect(page.getByText("Where is your mailbox?")).toBeVisible();
			await expect(page.getByText("Somewhere else")).toBeVisible();
			await expect(page.getByRole("button", { name: /Gmail/ })).toHaveCount(0);
			await expect(page.getByText("Other (IMAP)")).toHaveCount(0);

			await expect(
				page.getByRole("button", { name: "iCloud Mail" }),
			).toHaveCount(0);
			await page.getByText("Somewhere else").click();
			await expect(page.getByLabel("IMAP server")).toBeVisible();
		});

		test("connects iCloud Mail from Apple without requesting Calendar or Contacts", async ({
			page,
		}) => {
			const endpoint = "**/api/connections/apple/start";
			await page.route(endpoint, (route) =>
				route.fulfill({
					json: { connection: connection({ provider: "apple" }) },
				}),
			);
			await page.getByTestId("connections-add-apple").click();
			const dialog = page.getByRole("dialog");
			await dialog.getByRole("checkbox", { name: "Calendar" }).uncheck();
			await dialog.getByRole("checkbox", { name: "Email" }).check();
			await expect(
				dialog.getByRole("checkbox", { name: "Email" }),
			).toBeChecked();
			await expect(
				dialog.getByRole("checkbox", { name: "Calendar" }),
			).not.toBeChecked();
			await expect(
				dialog.getByRole("checkbox", { name: "Contacts" }),
			).not.toBeChecked();
			await dialog
				.getByLabel("Apple ID", { exact: true })
				.fill("sample@icloud.com");
			await dialog
				.getByLabel("App-specific password", { exact: true })
				.fill("test-only");
			const request = page.waitForRequest(endpoint);
			await dialog
				.getByRole("button", { name: "Connect", exact: true })
				.click();
			expect((await request).postDataJSON()).toEqual({
				appleId: "sample@icloud.com",
				appPassword: "test-only",
				mailAddress: "sample@icloud.com",
				capabilities: ["email"],
			});
			await expect(dialog).toHaveCount(0);
		});

		test("asks for a Nextcloud address", async ({ page }) => {
			await page.getByTestId("connections-add-nextcloud").click();
			await expect(page.getByLabel("Server URL")).toBeVisible();
		});

		test("asks for a GitHub token in words a person can act on", async ({
			page,
		}) => {
			await page.getByTestId("connections-add-github").click();
			await expect(page.getByLabel("Access token")).toBeVisible();
			await expect(
				page.getByText("a long password you create on GitHub", {
					exact: false,
				}),
			).toBeVisible();
		});

		test("opens a form for every other provider it offers", async ({
			page,
		}) => {
			for (const provider of ["immich", "plex", "apple", "caldav"]) {
				await page.getByTestId(`connections-add-${provider}`).click();
				await expect(page.getByRole("dialog")).toBeVisible();
				await page.getByRole("button", { name: "Cancel" }).first().click();
				await expect(page.getByRole("dialog")).toHaveCount(0);
			}
		});
	});
});

// A dialog taller than the window. The panel of a centred dialog stopped scrolling
// once its intro had run (Svelte's transition writes the panel's saved inline
// overflow back, which clears `overflow-y`), so its bottom spilled past the panel and
// the window, out of reach: Settings above all, and on a phone on its side every
// dialog. A panel that scrolls inside itself was tried first, and it cut off what
// paints past the panel's edge (the Plan 3 fix verification: D1 the folder list,
// D2 focus under a sticky footer, D3 a help bubble, D4 a sideways scrollbar). Now the
// window behind the dialog scrolls and the panel grows with what it holds. These
// hold it on the tallest dialog with popups, Nextcloud's details with its folder box.
test.describe("the detail dialog on a short screen", () => {
	const nextcloud = connection({ allowWrites: true, writeAllowlist: [] });
	const folders = Array.from({ length: 8 }, (_, i) => ({
		path: `/Documents/Folder ${i + 1}`,
		name: `Folder ${i + 1}`,
	}));

	/** Whether every box that clips (an overflow that is not visible) holds all of it, the window too. */
	async function drawnWhole(locator: Locator): Promise<string[]> {
		return locator.evaluate((node) => {
			const box = node.getBoundingClientRect();
			const cut: string[] = [];
			const holds = (
				outer:
					| DOMRect
					| { left: number; top: number; right: number; bottom: number },
			) =>
				box.left >= outer.left - 1 &&
				box.top >= outer.top - 1 &&
				box.right <= outer.right + 1 &&
				box.bottom <= outer.bottom + 1;
			if (!holds({ left: 0, top: 0, right: innerWidth, bottom: innerHeight }))
				cut.push("the window");
			for (let up = node.parentElement; up; up = up.parentElement) {
				const style = getComputedStyle(up);
				if (style.overflowX === "visible" && style.overflowY === "visible")
					continue;
				if (!holds(up.getBoundingClientRect()))
					cut.push(`${up.localName}.${[...up.classList].join(".")}`);
			}
			return cut;
		});
	}

	for (const { where, size } of [
		{ where: "a short desktop window", size: { width: 1280, height: 600 } },
		{ where: "a phone", size: { width: 390, height: 664 } },
		{ where: "a phone on its side", size: { width: 844, height: 390 } },
	] as const) {
		test(`reaches the bottom of the dialog and cuts nothing off, on ${where}`, async ({
			page,
		}) => {
			await page.setViewportSize(size);
			await login(page);
			await stubConnections(page, [nextcloud]);
			await page.route(
				"**/api/connections/conn-nextcloud/nextcloud-folders*",
				async (route) => {
					await route.fulfill({
						status: 200,
						contentType: "application/json",
						body: JSON.stringify({ folders }),
					});
				},
			);
			await openConnectionsTab(page);
			await page.getByTestId("connection-details-conn-nextcloud").click();
			const panel = page.getByRole("dialog");
			await expect(
				panel.getByTestId("connection-detail-conn-nextcloud"),
			).toBeVisible();
			await waitForMotionToSettle(page);

			// The dialog is taller than the window, or this proves nothing.
			expect(await panel.evaluate((el) => el.scrollHeight)).toBeGreaterThan(
				size.height,
			);
			// Nothing spills past the panel's edge: a panel that does not scroll holds
			// all of what it draws.
			expect(
				await panel.evaluate((el) =>
					getComputedStyle(el).overflowY === "visible"
						? el.scrollHeight - el.clientHeight
						: 0,
				),
			).toBeLessThanOrEqual(1);

			// A wheel over the dialog brings its foot into the window.
			const box = await panel.boundingBox();
			if (!box) throw new Error("the dialog has no box");
			await page.mouse.move(
				box.x + box.width / 2,
				Math.min(box.y + 40, size.height / 2),
			);
			await page.mouse.wheel(0, 4000);
			const done = panel.getByRole("button", { name: "Done", exact: true });
			await expectTopmost(done, {
				message: "Done is in the window, on top",
				probe: "center",
			});
			const scrolled = await panel.boundingBox();
			expect(
				(scrolled?.y ?? 0) + (scrolled?.height ?? 0),
				"the panel's foot is in the window",
			).toBeLessThanOrEqual(size.height);

			// D4: no sideways scrollbar, whatever the dialog holds.
			expect(
				await panel.evaluate((el) => {
					const overlay = el.closest<HTMLElement>("[data-presentation]");
					return overlay ? overlay.scrollWidth - overlay.clientWidth : -1;
				}),
			).toBe(0);

			// D1: the folder list opens below its field, whole, and its last folder is on top.
			const field = panel.getByRole("combobox", {
				name: "Folders Alfy may write to",
			});
			await field.click();
			const list = page.getByRole("listbox");
			await expect(list.getByRole("option")).toHaveCount(folders.length);
			await list.evaluate((el) => el.scrollIntoView({ block: "nearest" }));
			expect(await drawnWhole(list), "the folder list is cut by").toEqual([]);
			const last = list.getByRole("option").last();
			await last.scrollIntoViewIfNeeded();
			await expectTopmost(last, {
				message: "the last folder is on top",
				probe: "center",
			});
			await field.blur();
			await expect(list).toHaveCount(0);

			// D3: a help bubble beside the panel's edge is drawn whole. It opens below
			// its button, so the button is brought to the middle of the window first.
			const help = panel.getByRole("button", {
				name: /^Writing is off by default\./,
			});
			await help.evaluate((el) => el.scrollIntoView({ block: "center" }));
			await help.hover();
			const bubble = page.getByRole("tooltip");
			await expect(bubble).toBeVisible();
			expect(await drawnWhole(bubble), "the help bubble is cut by").toEqual([]);
			await page.mouse.move(0, 0);
			await expect(bubble).toHaveCount(0);

			// D2: Tab from the top never leaves the focus out of the window or under
			// anything. The folder list, which opens on focus, closes 150 ms after the
			// field loses it, so each step is asked until it settles.
			await panel.evaluate((el) => {
				el.closest<HTMLElement>("[data-presentation]")?.scrollTo(0, 0);
				el.focus();
			});
			const focusShown = () =>
				page.evaluate(() => {
					const active = document.activeElement as HTMLElement | null;
					if (!active?.closest('[role="dialog"]')) return true;
					const rect = active.getBoundingClientRect();
					const top = document.elementFromPoint(
						rect.left + rect.width / 2,
						rect.top + rect.height / 2,
					);
					return !!top && (active === top || active.contains(top));
				});
			for (let step = 0; step < 40; step += 1) {
				await page.keyboard.press("Tab");
				await expect
					.poll(focusShown, {
						message: `the control Tab reached at step ${step + 1} is in sight`,
						timeout: 2000,
					})
					.toBe(true);
			}

			// A press beside the panel, at the foot of the window, still closes the dialog.
			await page.mouse.wheel(0, 4000);
			await page.mouse.click(4, size.height - 4);
			await expect(page.getByRole("dialog")).toHaveCount(0);
		});
	}

	// D1 and D3 as they were seen: with room in the window below and beside the
	// panel, the folder list and a help bubble paint past the panel's edge as they
	// open, whole, with nothing scrolled. A panel that scrolls inside itself cut both.
	test("draws the folder list and a help bubble whole past the panel's edge", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 1440 });
		await login(page);
		await stubConnections(page, [nextcloud]);
		await page.route(
			"**/api/connections/conn-nextcloud/nextcloud-folders*",
			async (route) => {
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({ folders }),
				});
			},
		);
		await openConnectionsTab(page);
		await page.getByTestId("connection-details-conn-nextcloud").click();
		const panel = page.getByRole("dialog");
		await expect(
			panel.getByTestId("connection-detail-conn-nextcloud"),
		).toBeVisible();
		await waitForMotionToSettle(page);
		const panelBox = await panel.boundingBox();
		if (!panelBox) throw new Error("the dialog has no box");
		expect(panelBox.height, "the dialog fits the window").toBeLessThan(1440);

		await panel
			.getByRole("combobox", { name: "Folders Alfy may write to" })
			.click();
		const list = page.getByRole("listbox");
		await expect(list.getByRole("option")).toHaveCount(folders.length);
		const listBox = await list.boundingBox();
		expect(
			(listBox?.y ?? 0) + (listBox?.height ?? 0),
			"the list reaches past the panel's foot",
		).toBeGreaterThan(panelBox.y + panelBox.height);
		expect(await drawnWhole(list), "the folder list is cut by").toEqual([]);
		await panel
			.getByRole("combobox", { name: "Folders Alfy may write to" })
			.blur();
		await expect(list).toHaveCount(0);

		await panel
			.getByRole("button", { name: /^Writing is off by default\./ })
			.hover();
		const bubble = page.getByRole("tooltip");
		await expect(bubble).toBeVisible();
		expect(await drawnWhole(bubble), "the help bubble is cut by").toEqual([]);
	});
});
