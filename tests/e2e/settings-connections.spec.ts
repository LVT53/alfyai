import { expect, type Page, test } from "@playwright/test";

import { login } from "./helpers";

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

	test.describe("the connect wizard", () => {
		test.beforeEach(async ({ page }) => {
			await login(page);
			await stubConnections(page, []);
			await openConnectionsTab(page);
		});

		test("opens the consent chooser for an OAuth provider", async ({
			page,
		}) => {
			await page.getByTestId("connections-add-google").click();
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

		test("asks where the mailbox lives, with no IMAP on the first screen", async ({
			page,
		}) => {
			await page.getByTestId("connections-add-imap").click();
			await expect(page.getByText("Where is your mailbox?")).toBeVisible();
			await expect(page.getByText("Somewhere else")).toBeVisible();
			await expect(page.getByText("Other (IMAP)")).toHaveCount(0);

			await page.getByText("Somewhere else").click();
			await expect(page.getByLabel("IMAP server")).toBeVisible();
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
