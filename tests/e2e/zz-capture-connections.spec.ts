// Screenshot capture for the Connections redesign. It asserts nothing anyone
// needs CI to assert — it drives the real app with a stubbed connections list
// so every state can be photographed in both themes, and writes PNGs to a
// scratch directory that only exists on the machine that made them.
//
// So it SKIPS unless CONNECTIONS_CAPTURE=1 is set. It stays a .spec.ts in
// tests/e2e/ (rather than moving somewhere Playwright's testDir cannot see)
// so it keeps compiling against the same helpers and gets type-checked with
// everything else; a CI run reports it as skipped rather than trying to write
// to a path it does not have.
//
//   CONNECTIONS_CAPTURE=1 npx playwright test tests/e2e/zz-capture-connections.spec.ts
import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import {
	connectionPendingWrites,
	conversations,
	messages,
	providerModels,
	providers,
	users,
} from "../../src/lib/server/db/schema";

import { login } from "./helpers";

test.skip(
	process.env.CONNECTIONS_CAPTURE !== "1",
	"screenshot capture helper — set CONNECTIONS_CAPTURE=1 to run it",
);

const OUT =
	"/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/dc2da4d4-d513-4098-9b2b-8b6c426191eb/scratchpad/admin-redesign/impl-connections";

const NOW = Math.floor(Date.now() / 1000);

type Stub = Record<string, unknown>;

function connection(overrides: Stub = {}): Stub {
	return {
		id: "conn-nextcloud",
		provider: "nextcloud",
		label: "Nextcloud",
		accountIdentifier: "cloud.alfy.hu",
		status: "connected",
		statusDetail: null,
		defaultOn: true,
		allowWrites: true,
		writeAllowlist: ["/AlfyAI", "/Documents/Reports"],
		capabilities: ["files", "contacts"],
		grantedCapabilities: ["files", "contacts"],
		config: {},
		oauthScopes: [],
		tokenExpiresAt: null,
		hasSecret: true,
		hasWriteSecret: false,
		lastUsedAt: NOW - 720,
		statusChangedAt: null,
		createdAt: NOW - 86_400 * 40,
		updatedAt: NOW - 86_400,
		...overrides,
	};
}

const FULL_SET: Stub[] = [
	connection(),
	connection({
		id: "conn-google",
		provider: "google",
		label: "Google",
		accountIdentifier: "levente@gmail.com",
		status: "needs_reauth",
		allowWrites: false,
		writeAllowlist: [],
		capabilities: ["calendar"],
		grantedCapabilities: ["calendar"],
		statusChangedAt: NOW - 86_400 * 2,
		lastUsedAt: null,
	}),
	connection({
		id: "conn-email",
		provider: "imap",
		label: "Email",
		accountIdentifier: "levente@alfy.hu",
		capabilities: ["email"],
		grantedCapabilities: ["email"],
		allowWrites: true,
		writeAllowlist: [],
		lastUsedAt: NOW - 86_400,
	}),
	connection({
		id: "conn-immich",
		provider: "immich",
		label: "Immich",
		accountIdentifier: "photos.alfy.hu",
		capabilities: ["photos"],
		grantedCapabilities: ["photos"],
		allowWrites: false,
		writeAllowlist: [],
		lastUsedAt: NOW - 86_400 * 3,
	}),
	connection({
		id: "conn-github",
		provider: "github",
		label: "GitHub",
		accountIdentifier: "LVT53",
		status: "error",
		statusDetail: "401 Bad credentials (token rejected by api.github.com)",
		capabilities: ["repos"],
		grantedCapabilities: ["repos"],
		allowWrites: false,
		writeAllowlist: [],
		statusChangedAt: NOW - 3600 * 5,
		lastUsedAt: null,
	}),
	connection({
		id: "conn-owntracks",
		provider: "owntracks",
		label: "OwnTracks",
		accountIdentifier: "phone-lvt",
		status: "disconnected",
		capabilities: ["location"],
		grantedCapabilities: ["location"],
		allowWrites: false,
		writeAllowlist: [],
		config: { homeLat: 47.4979, homeLon: 19.0402 },
		statusChangedAt: NOW - 86_400 * 8,
		lastUsedAt: null,
	}),
];

async function stub(page: Page, connections: Stub[], status = 200) {
	await page.route("**/api/connections", async (route) => {
		if (status >= 400) {
			await route.fulfill({
				status,
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
	await page.route("**/api/connections/*/recheck", async (route) => {
		const id = new URL(route.request().url()).pathname.split("/").at(-2);
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				connection: connections.find((conn) => conn.id === id),
			}),
		});
	});
	await page.route("**/api/connections/*/nextcloud-folders", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ folders: [] }),
		});
	});
	await page.route("**/api/connections/owntracks/devices", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				devices: [
					{ otUser: "lvt", otDevice: "phone-lvt", lastSeen: NOW - 240 },
					{
						otUser: "lvt",
						otDevice: "tablet-home",
						lastSeen: NOW - 86_400 * 6,
					},
					{ otUser: "anna", otDevice: "phone-anna", lastSeen: NOW - 660 },
				],
			}),
		});
	});
	await page.route("**/api/connections/google/start", async (route) => {
		await route.fulfill({
			status: 501,
			contentType: "application/json",
			body: JSON.stringify({ error: "not configured" }),
		});
	});
	await page.route("**/api/connections/onedrive/start", async (route) => {
		await route.fulfill({
			status: 501,
			contentType: "application/json",
			body: JSON.stringify({ error: "not configured" }),
		});
	});
}

// The theme store lets the SERVER preference win over localStorage, so the
// preference has to be written through the API for a reload to keep it.
async function setTheme(page: Page, theme: "light" | "dark") {
	const ok = await page.evaluate(async (next) => {
		const response = await fetch("/api/settings/preferences", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ theme: next }),
		});
		localStorage.setItem("theme", next);
		return response.ok;
	}, theme);
	expect(ok, `setting the ${theme} theme failed`).toBe(true);
}

// Escape can be swallowed by whichever layer owns it, so close deterministically
// and wait until nothing is left over the page.
async function closeDialogs(page: Page) {
	for (let i = 0; i < 4; i += 1) {
		if ((await page.getByRole("dialog").count()) === 0) break;
		await page.keyboard.press("Escape");
		await page.waitForTimeout(250);
	}
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await page.waitForTimeout(150);
}

// Rows are inserted directly rather than through the conversation/message
// services: those run a sequence-repair statement that better-sqlite3 refuses
// inside the Playwright RUNNER process, and nothing here needs the services'
// behaviour — only the rows.
async function adminId(): Promise<string> {
	const [admin] = await db
		.select()
		.from(users)
		.where(eq(users.email, "admin@local"))
		.limit(1);
	expect(admin, "the e2e admin must exist").toBeTruthy();
	return admin.id;
}

async function seedConversation(userId: string, id: string, title: string) {
	const now = new Date();
	await db
		.insert(conversations)
		.values({ id, userId, title, createdAt: now, updatedAt: now });
	return id;
}

async function openTab(page: Page) {
	await page.goto("/settings?section=connections", {
		waitUntil: "domcontentloaded",
	});
	await expect(page.getByTestId("connections-locality")).toBeVisible({
		timeout: 20000,
	});
	await page.waitForTimeout(400);
}

for (const theme of ["light", "dark"] as const) {
	test.describe(`connections screenshots (${theme})`, () => {
		test.use({ viewport: { width: 1280, height: 1100 } });

		test(`tab, dialogs and wizards (${theme})`, async ({ page }) => {
			await login(page);
			await setTheme(page, theme);
			await stub(page, FULL_SET);
			await openTab(page);

			await page.screenshot({
				path: `${OUT}/01-tab-${theme}.png`,
				fullPage: true,
			});

			// Detail dialog — Nextcloud (write folders).
			await page.getByTestId("connection-details-conn-nextcloud").click();
			await expect(
				page.getByTestId("connection-detail-conn-nextcloud"),
			).toBeVisible();
			await page.waitForTimeout(300);
			await page.screenshot({
				path: `${OUT}/02-detail-nextcloud-${theme}.png`,
			});

			// Disconnect confirmation.
			await page.getByTestId("connection-disconnect").click();
			await page.waitForTimeout(300);
			await page.screenshot({ path: `${OUT}/03-disconnect-${theme}.png` });
			await page.getByRole("button", { name: "Cancel" }).click();
			await page.waitForTimeout(250);
			await closeDialogs(page);

			// Detail dialog — Google, with a denied capability and a sign-in banner.
			await page.getByTestId("connection-details-conn-google").click();
			await expect(
				page.getByTestId("connection-detail-conn-google"),
			).toBeVisible();
			await page.waitForTimeout(300);
			await page.screenshot({ path: `${OUT}/04-detail-google-${theme}.png` });
			await closeDialogs(page);

			// Detail dialog — GitHub, error state with the technical detail open.
			await page.getByTestId("connection-details-conn-github").click();
			await page.getByTestId("connection-detail-technical").click();
			await page.waitForTimeout(350);
			await page.screenshot({ path: `${OUT}/05-detail-error-${theme}.png` });
			await closeDialogs(page);

			// Detail dialog — OwnTracks, home location.
			await page.getByTestId("connection-details-conn-owntracks").click();
			await expect(
				page.getByTestId("connection-detail-conn-owntracks"),
			).toBeVisible();
			await page.waitForTimeout(300);
			await page.screenshot({
				path: `${OUT}/06-detail-owntracks-${theme}.png`,
			});
			await closeDialogs(page);

			// Wizard — OAuth consent chooser.
			await page.getByTestId("connections-add-google").click();
			await page.waitForTimeout(300);
			await page.screenshot({ path: `${OUT}/07-wizard-google-${theme}.png` });

			// Wizard — the "not set up on this server" state.
			await page.getByRole("button", { name: "Continue to Google" }).click();
			await expect(page.getByTestId("wizard-not-set-up")).toBeVisible();
			await page.waitForTimeout(300);
			await page.screenshot({
				path: `${OUT}/08-wizard-not-set-up-${theme}.png`,
			});
			await closeDialogs(page);

			// Wizard — OneDrive, whose keys live on a DIFFERENT Administration
			// page than Google's. The notice has to name the right one.
			await page.getByTestId("connections-add-onedrive").click();
			await page.waitForTimeout(250);
			await page.getByRole("button", { name: /Continue to OneDrive/ }).click();
			await expect(page.getByTestId("wizard-not-set-up")).toBeVisible();
			await page.waitForTimeout(300);
			await page.screenshot({
				path: `${OUT}/08b-wizard-onedrive-not-set-up-${theme}.png`,
			});
			await closeDialogs(page);

			// Wizard — mail path chooser.
			await page.getByTestId("connections-add-imap").click();
			await page.waitForTimeout(300);
			await page.screenshot({ path: `${OUT}/09-wizard-mail-${theme}.png` });
			await closeDialogs(page);

			// Wizard — GitHub, with the custom-server disclosure open.
			await page.getByTestId("connections-add-github").click();
			await page.getByTestId("wizard-github-advanced").click();
			await page.waitForTimeout(350);
			await page.screenshot({ path: `${OUT}/10-wizard-github-${theme}.png` });
			await closeDialogs(page);

			// Wizard — OwnTracks device picker.
			await page.getByTestId("connections-add-owntracks").click();
			await expect(page.getByLabel("phone-lvt")).toBeVisible();
			await page.waitForTimeout(300);
			await page.screenshot({
				path: `${OUT}/11-wizard-owntracks-${theme}.png`,
			});
			await closeDialogs(page);

			// Wizard — Nextcloud form.
			await page.getByTestId("connections-add-nextcloud").click();
			await page.waitForTimeout(300);
			await page.screenshot({
				path: `${OUT}/12-wizard-nextcloud-${theme}.png`,
			});
			await closeDialogs(page);
		});

		test(`failed load and empty account (${theme})`, async ({ page }) => {
			await login(page);
			await setTheme(page, theme);
			await stub(page, [], 500);
			await openTab(page);
			await page.screenshot({ path: `${OUT}/13-load-failed-${theme}.png` });

			await page.unroute("**/api/connections");
			await stub(page, []);
			await page.getByText("Try again").click();
			await expect(page.getByTestId("connections-empty")).toBeVisible();
			await page.waitForTimeout(300);
			await page.screenshot({ path: `${OUT}/14-empty-${theme}.png` });
		});

		test(`a change that did not save (${theme})`, async ({ page }) => {
			await login(page);
			await setTheme(page, theme);
			await stub(page, FULL_SET);
			await page.route("**/api/connections/locality", async (route) => {
				if (route.request().method() === "PATCH") {
					await route.fulfill({
						status: 500,
						contentType: "application/json",
						body: JSON.stringify({ error: "boom" }),
					});
					return;
				}
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({ localDistill: true }),
				});
			});
			await openTab(page);
			await page
				.getByRole("switch", { name: "Keep connected data on this device" })
				.click();
			await expect(page.getByTestId("connections-change-failed")).toBeVisible();
			await page.waitForTimeout(300);
			await page.screenshot({ path: `${OUT}/15-change-failed-${theme}.png` });
		});

		test(`a partial OAuth grant (${theme})`, async ({ page }) => {
			await login(page);
			await setTheme(page, theme);
			await stub(page, FULL_SET);
			await page.addInitScript(() => {
				sessionStorage.setItem(
					"alfyai:connections:requested:google",
					JSON.stringify(["calendar", "contacts"]),
				);
			});
			await openTab(page);
			await expect(page.getByTestId("connections-partial-grant")).toBeVisible();
			await page.waitForTimeout(300);
			await page.screenshot({ path: `${OUT}/16-partial-grant-${theme}.png` });
		});

		test(`the composer's account list (${theme})`, async ({ page }) => {
			await login(page);
			await setTheme(page, theme);
			await page.route(
				"**/api/connections/active-capabilities",
				async (route) => {
					await route.fulfill({
						status: 200,
						contentType: "application/json",
						body: JSON.stringify({
							served: ["files", "contacts", "email", "photos", "calendar"],
							defaultOn: ["files", "contacts", "email", "photos"],
							accounts: [],
							connections: [
								{
									id: "nc",
									label: "Nextcloud",
									provider: "nextcloud",
									accountIdentifier: "cloud.alfy.hu",
									status: "connected",
									defaultOn: true,
									capabilities: ["files", "contacts"],
								},
								{
									id: "mail",
									label: "Email",
									provider: "imap",
									accountIdentifier: "levente@alfy.hu",
									status: "connected",
									defaultOn: true,
									capabilities: ["email"],
								},
								{
									id: "immich",
									label: "Immich",
									provider: "immich",
									accountIdentifier: "photos.alfy.hu",
									status: "connected",
									defaultOn: true,
									capabilities: ["photos"],
								},
								{
									id: "google",
									label: "Google",
									provider: "google",
									accountIdentifier: "levente@gmail.com",
									status: "connected",
									defaultOn: false,
									capabilities: ["calendar"],
								},
								{
									id: "gh",
									label: "GitHub",
									provider: "github",
									accountIdentifier: "LVT53",
									status: "needs_reauth",
									defaultOn: true,
									capabilities: [],
								},
								{
									id: "plex",
									label: "Plex",
									provider: "plex",
									accountIdentifier: "plex.alfy.hu",
									status: "disconnected",
									defaultOn: false,
									capabilities: [],
								},
							],
						}),
					});
				},
			);
			await page.goto("/", { waitUntil: "domcontentloaded" });
			await expect(page.getByTestId("connections-toggle")).toBeEnabled({
				timeout: 20000,
			});
			await page.getByTestId("connections-toggle").click();
			await expect(page.getByTestId("connections-popover")).toBeVisible();
			await page.waitForTimeout(300);
			await page.screenshot({
				path: `${OUT}/17-composer-connections-${theme}.png`,
				clip: { x: 0, y: 420, width: 1280, height: 680 },
			});
		});

		// The write-confirm cards render from real rows: a pending write is
		// created by a write tool mid-turn and backfilled with the assistant
		// message id when the turn finalizes, so there is no client-side way to
		// fabricate one. Seeding the database is how the rest of this suite
		// stages server state (see playwright.config.ts's note about the runner
		// sharing the e2e database).
		test(`write confirmations in the reply (${theme})`, async ({ page }) => {
			await login(page);
			await setTheme(page, theme);

			const userId = await adminId();
			const conversationId = await seedConversation(
				userId,
				`conv-writes-${theme}`,
				`Write confirmations (${theme})`,
			);
			const assistantId = `msg-assistant-${theme}`;
			const now = new Date();
			await db.insert(messages).values([
				{
					id: `msg-user-${theme}`,
					conversationId,
					messageSequence: 1,
					role: "user",
					content: "Save the Atlas report to Nextcloud and clear those photos.",
					createdAt: now,
				},
				{
					id: assistantId,
					conversationId,
					messageSequence: 2,
					role: "assistant",
					content: "Two things need your OK first.",
					createdAt: now,
				},
			]);

			// One reversible write and one destructive one, so the badges can be
			// seen to appear only when they are true.
			await db.insert(connectionPendingWrites).values([
				{
					id: `pw-save-${theme}`,
					userId,
					connectionId: "conn-nextcloud",
					provider: "nextcloud",
					opJson: JSON.stringify({ kind: "put" }),
					idempotencyKey: `idem-save-${theme}`,
					status: "pending",
					previewJson: JSON.stringify({
						title: "Save this report to Nextcloud?",
						detail: "/AlfyAI/Reports/atlas-2026-09.pdf — new file, 148 KB.",
						reversible: true,
						destructive: false,
						withinAllowlist: true,
						warnings: [],
					}),
					conversationId,
					assistantMessageId: assistantId,
				},
				{
					id: `pw-delete-${theme}`,
					userId,
					connectionId: "conn-immich",
					provider: "immich",
					opJson: JSON.stringify({ kind: "delete" }),
					idempotencyKey: `idem-delete-${theme}`,
					status: "pending",
					previewJson: JSON.stringify({
						title: "Delete 3 photos from Immich?",
						detail: "IMG_2291, IMG_2292 and IMG_2294, taken 4 August.",
						reversible: false,
						destructive: true,
						withinAllowlist: null,
						warnings: [],
					}),
					conversationId,
					assistantMessageId: assistantId,
				},
			]);

			await page.goto(`/chat/${conversationId}`, {
				waitUntil: "domcontentloaded",
			});
			await expect(
				page.getByText("Save this report to Nextcloud?"),
			).toBeVisible({ timeout: 20000 });
			await expect(
				page.getByText("Delete 3 photos from Immich?"),
			).toBeVisible();
			await page.waitForTimeout(400);
			await page.screenshot({
				path: `${OUT}/18-write-confirm-${theme}.png`,
				fullPage: true,
			});
		});

		test(`the cloud-model warning (${theme})`, async ({ page }) => {
			await login(page);
			await setTheme(page, theme);

			// The gate needs (a) at least one active connector capability and
			// (b) a CLOUD model selected. The preference endpoint only accepts a
			// model that actually exists, so a throwaway provider is seeded and
			// removed again — this database is shared with the rest of the
			// suite, and a stray cloud provider would change what other specs
			// see in the model picker.
			const providerId = `prov-capture-${theme}`;
			const modelRowId = `model-capture-${theme}`;
			const modelId = `provider:${providerId}:${modelRowId}`;
			const seededAt = new Date();
			await db.insert(providers).values({
				id: providerId,
				name: `capture-${theme}`,
				displayName: "Anthropic",
				baseUrl: "https://api.anthropic.invalid",
				apiKeyEncrypted: "unused",
				apiKeyIv: "unused",
				createdAt: seededAt,
				updatedAt: seededAt,
			});
			await db.insert(providerModels).values({
				id: modelRowId,
				providerId,
				name: "claude-capture",
				displayName: "Claude",
				createdAt: seededAt,
				updatedAt: seededAt,
			});
			await page.route(
				"**/api/connections/active-capabilities",
				async (route) => {
					await route.fulfill({
						status: 200,
						contentType: "application/json",
						body: JSON.stringify({
							served: ["files", "calendar", "email"],
							defaultOn: ["files", "calendar", "email"],
							accounts: [],
							connections: [
								{
									id: "nc",
									label: "Nextcloud",
									provider: "nextcloud",
									accountIdentifier: "cloud.alfy.hu",
									status: "connected",
									defaultOn: true,
									capabilities: ["files"],
								},
							],
						}),
					});
				},
			);
			await page.route("**/api/connections/cloud-warning", async (route) => {
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({ shouldWarn: true }),
				});
			});

			const conversationId = await seedConversation(
				await adminId(),
				`conv-cloud-${theme}`,
				`Cloud warning (${theme})`,
			);

			try {
				const picked = await page.evaluate(async (id) => {
					const response = await fetch("/api/settings/preferences", {
						method: "PATCH",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ preferredModel: id }),
					});
					return response.ok;
				}, modelId);
				expect(picked, "the seeded cloud model must be selectable").toBe(true);

				await page.goto(`/chat/${conversationId}`, {
					waitUntil: "domcontentloaded",
				});
				const input = page.getByTestId("message-input");
				await expect(input).toBeEnabled({ timeout: 20000 });
				await input.fill("What did I promise Anna about the report?");
				const send = page.getByTestId("send-button");
				await expect(send).toBeEnabled({ timeout: 10000 });
				await send.click();

				await expect(page.getByTestId("cloud-connector-warning")).toBeVisible({
					timeout: 15000,
				});
				await page.waitForTimeout(300);
				await page.screenshot({ path: `${OUT}/19-cloud-warning-${theme}.png` });
			} finally {
				// Put the account and the model list back the way the rest of the
				// suite expects to find them.
				await page.evaluate(async () => {
					await fetch("/api/settings/preferences", {
						method: "PATCH",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ preferredModel: null }),
					});
				});
				await db
					.delete(providerModels)
					.where(eq(providerModels.id, modelRowId));
				await db.delete(providers).where(eq(providers.id, providerId));
			}
		});
	});
}
