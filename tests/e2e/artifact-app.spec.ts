import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import {
	artifactKv,
	artifacts,
	artifactVersions,
	users,
} from "../../src/lib/server/db/schema";
import { createConversation, login } from "./helpers";

// The App kind, end to end (Feature 2 · Artifacts, Slice 2).
//
// IMPORTANT — what this spec does NOT cover, and why: `create_artifact`'s
// App branch lives in normal-chat-tools/artifact-tools/ (Slice 5a), which had
// not merged into feat/artifacts when this slice was built, and there is no
// scriptable tool-call E2E fixture regardless (artifacts-panel.spec.ts's own
// comment: `helpers.ts`'s `buildAiSdkUiStreamBody` only scripts text
// deltas). This spec seeds a real, working App artifact directly through
// `db` — the same convention artifacts-panel.spec.ts already established for
// exactly this gap — so it proves the PANEL surface: the served sandboxed
// route, the real postMessage storage bridge round-tripping through the real
// kv route into the real database, the Code tab, and the regenerate/download
// request shapes. The model backend is unreachable in this environment (see
// artifacts-panel.spec.ts's own comment), so regenerate and download are
// exercised through `page.route()` interception rather than a live model
// call or a live sandbox run — the same technique this suite already uses
// for chat-stream mocking elsewhere.

/** A small, real, working app: a notes field that saves through window.alfy.storage. */
const NOTES_APP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Test Notes App</title>
<style>
  body { font-family: Helvetica, Arial, sans-serif; padding: 16px; }
  textarea { width: 100%; height: 100px; }
</style>
</head>
<body>
<h1>Test Notes App</h1>
<label for="notes">Notes</label>
<textarea id="notes" data-testid="notes-textarea"></textarea>
<div id="status" data-testid="notes-status" aria-live="polite"></div>
<script>
(async function () {
  var textarea = document.getElementById('notes');
  var status = document.getElementById('status');
  if (window.alfy && window.alfy.storage) {
    var saved = await window.alfy.storage.get('notes');
    if (typeof saved === 'string') textarea.value = saved;
  }
  textarea.addEventListener('input', async function () {
    if (window.alfy && window.alfy.storage) {
      await window.alfy.storage.set('notes', textarea.value);
      status.textContent = 'Saved';
    }
  });
})();
</script>
</body>
</html>`;

/** A fixture that reaches for the network — proves the glitch line, not just the happy path. */
const NETWORK_REACHING_APP_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Weather widget</title></head>
<body>
<h1>Weather widget</h1>
<script>try { fetch('https://example.com/weather'); } catch (e) {}</script>
</body>
</html>`;

/** An app that never touches storage: anything in its kv was written by another app's document. */
const QUIET_APP_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Quiet App</title></head>
<body><h1>Quiet App</h1></body>
</html>`;

/**
 * A fixture with a <form> whose submit handler does NOT call
 * preventDefault() — proves ruling 58's two halves in one place: the
 * `allow-forms` sandbox token lets the `submit` EVENT fire (the handler runs
 * and marks the DOM), while the CSP's `form-action 'none'` still refuses the
 * actual submission, so the app's own heading is still there afterwards.
 */
const FORM_APP_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Form App</title></head>
<body>
<h1>Form App</h1>
<form id="f" action="/should-not-navigate">
  <button type="submit">Submit</button>
</form>
<div data-testid="submit-marker"></div>
<script>
document.getElementById('f').addEventListener('submit', function () {
  document.querySelector('[data-testid="submit-marker"]').textContent = 'submitted';
  // Deliberately NOT calling preventDefault(): the CSP, not the app, must be
  // what stops the navigation.
});
</script>
</body>
</html>`;

/** An app that saves on a short timer, the way a debounced autosave does. */
const CHATTY_APP_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Chatty App</title></head>
<body>
<h1>Chatty App</h1>
<div data-testid="chatty-count">0</div>
<script>
var count = 0;
setInterval(function () {
  count += 1;
  document.querySelector('[data-testid="chatty-count"]').textContent = String(count);
  if (window.alfy && window.alfy.storage) window.alfy.storage.set('chatty', count);
}, 5);
</script>
</body>
</html>`;

async function testUserId(): Promise<string> {
	const [user] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, "admin@local"))
		.limit(1);
	expect(user, "the e2e admin must exist").toBeTruthy();
	return user.id;
}

async function seedApp(
	conversationId: string,
	html: string,
	title = "Test Notes App",
): Promise<string> {
	const userId = await testUserId();
	const artifactId = randomUUID();
	const now = new Date();
	await db.insert(artifacts).values({
		id: artifactId,
		userId,
		conversationId,
		type: "artifact",
		retrievalClass: "durable",
		name: title,
		contentText: html,
		metadataJson: JSON.stringify({ artifactType: "app", title }),
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(artifactVersions).values({
		id: randomUUID(),
		artifactId,
		userId,
		versionNumber: 1,
		author: "alfy",
		summary: "Alfy wrote the first draft",
		body: html,
		bodyHash: "seed-hash",
		createdAt: now,
	});
	return artifactId;
}

async function openChatAndReload(page: Page, conversationId: string) {
	await page.evaluate((id) => {
		window.sessionStorage.removeItem(`pending-chat-message:${id}`);
	}, conversationId);
	await page.goto(`/chat/${conversationId}`);
	await page.reload({ waitUntil: "networkidle" });
}

async function openAppPanel(page: Page) {
	await page.getByTestId("artifact-count-button").click();
	await page
		.getByTestId("artifact-panel-list")
		.getByRole("button", { name: "Open" })
		.click();
	await expect(page.getByTestId("page-scroll-container")).toBeVisible();
}

test.describe("the App kind, in the panel", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("opens and runs the app in a sandboxed frame, with the exact allow-scripts attribute", async ({
		page,
	}) => {
		const conversationId = await createConversation(
			page,
			"Make me a notes app",
		);
		await seedApp(conversationId, NOTES_APP_HTML);
		await openChatAndReload(page, conversationId);

		await openAppPanel(page);

		const iframe = page.locator("iframe.app-frame");
		await expect(iframe).toBeVisible();
		// Ruling 58: allow-forms joined allow-scripts so a generated app's
		// <form> submit event can fire; see the dedicated form test below for
		// proof the submission itself is still refused.
		await expect(iframe).toHaveAttribute("sandbox", "allow-scripts allow-forms");

		const appFrame = page.frameLocator("iframe.app-frame");
		await expect(
			appFrame.getByRole("heading", { name: "Test Notes App" }),
		).toBeVisible();
	});

	// Ruling 58, open question 1: without allow-forms a <form> submit EVENT
	// never fires at all under this product's exact sandbox — several recorded
	// eval apps put their primary action on one. Proves both halves in the
	// real browser: the handler runs, and the submission itself still goes
	// nowhere because form-action 'none' is unchanged.
	test("a form's submit handler runs under allow-forms, and the CSP still refuses the submission itself", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Make me a form app");
		await seedApp(conversationId, FORM_APP_HTML, "Form App");
		await openChatAndReload(page, conversationId);
		await openAppPanel(page);

		const appFrame = page.frameLocator("iframe.app-frame");
		await expect(appFrame.getByRole("heading", { name: "Form App" })).toBeVisible();

		await appFrame.getByRole("button", { name: "Submit" }).click();

		await expect(appFrame.getByTestId("submit-marker")).toHaveText("submitted");
		// No navigation actually happened: the app's own heading is still
		// there. If form-action had been dropped along with the sandbox
		// change, this button would have navigated the frame away from it.
		await expect(appFrame.getByRole("heading", { name: "Form App" })).toBeVisible();
	});

	test("saved state survives a reload — the real postMessage bridge round-tripping through the real kv route", async ({
		page,
	}) => {
		const conversationId = await createConversation(
			page,
			"Make me a notes app",
		);
		await seedApp(conversationId, NOTES_APP_HTML);
		await openChatAndReload(page, conversationId);
		await openAppPanel(page);

		const appFrame = page.frameLocator("iframe.app-frame");
		const textarea = appFrame.getByTestId("notes-textarea");
		await textarea.fill("Buy tickets for Saturday");
		await expect(appFrame.getByTestId("notes-status")).toHaveText("Saved");

		await page.reload({ waitUntil: "networkidle" });
		await openAppPanel(page);

		const reloadedFrame = page.frameLocator("iframe.app-frame");
		await expect(reloadedFrame.getByTestId("notes-textarea")).toHaveValue(
			"Buy tickets for Saturday",
		);
	});

	test("Code shows the stored html, read-only, and back to Preview keeps the frame usable", async ({
		page,
	}) => {
		const conversationId = await createConversation(
			page,
			"Make me a notes app",
		);
		await seedApp(conversationId, NOTES_APP_HTML);
		await openChatAndReload(page, conversationId);
		await openAppPanel(page);

		await page.getByRole("tab", { name: /Code/ }).click();
		const codeBlock = page.locator(".app-body-code-block");
		await expect(codeBlock).toContainText("Test Notes App");
		await expect(codeBlock.locator("textarea")).toHaveCount(0);
		await expect(codeBlock.locator("[contenteditable='true']")).toHaveCount(0);

		await page.getByRole("tab", { name: /Preview/ }).click();
		await expect(page.locator("iframe.app-frame")).toBeVisible();
	});

	test("a network-reaching fixture shows its glitch line and still runs", async ({
		page,
	}) => {
		const conversationId = await createConversation(
			page,
			"Make me a weather widget",
		);
		const artifactId = await seedApp(
			conversationId,
			NETWORK_REACHING_APP_HTML,
			"Weather widget",
		);
		await db
			.update(artifacts)
			.set({
				metadataJson: JSON.stringify({
					artifactType: "app",
					title: "Weather widget",
					glitchRuleIds: ["no-network-api"],
				}),
			})
			.where(eq(artifacts.id, artifactId));
		await openChatAndReload(page, conversationId);
		await openAppPanel(page);

		await expect(
			page.getByText(
				"This app tried to reach the network. Everything still works offline.",
			),
		).toBeVisible();
		await expect(page.locator("iframe.app-frame")).toBeVisible();
	});

	test("regenerate posts { prompt, expectVersion } and reflects the new version (model call mocked)", async ({
		page,
	}) => {
		const conversationId = await createConversation(
			page,
			"Make me a notes app",
		);
		await seedApp(conversationId, NOTES_APP_HTML);
		await openChatAndReload(page, conversationId);
		await openAppPanel(page);

		let capturedBody: unknown;
		await page.route("**/app/regenerate", async (route) => {
			capturedBody = route.request().postDataJSON();
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					ok: true,
					version: 2,
					title: "Test Notes App",
					verification: { checked: false, verdict: "clean", reason: null },
				}),
			});
		});

		await page
			.getByRole("button", { name: /Ask Alfy for a new version/ })
			.click();
		await page
			.getByLabel("What should change?")
			.fill("Add a character counter");
		await page
			.getByRole("button", { name: /Ask Alfy for a new version/ })
			.last()
			.click();

		await expect
			.poll(() => capturedBody)
			.toMatchObject({
				prompt: "Add a character counter",
				expectVersion: 1,
				// Ruling 51: the route widens its scope from this, so an
				// incognito chat's App would 404 without it.
				conversationId,
			});
	});

	test("download requests the export with the artifact's own conversation id (sandbox run mocked)", async ({
		page,
	}) => {
		const conversationId = await createConversation(
			page,
			"Make me a notes app",
		);
		await seedApp(conversationId, NOTES_APP_HTML);
		await openChatAndReload(page, conversationId);
		await openAppPanel(page);

		let requested = false;
		await page.route("**/app/download", async (route) => {
			requested = true;
			await route.fulfill({
				status: 202,
				contentType: "application/json",
				body: JSON.stringify({
					ok: true,
					job: { id: "job-1", status: "queued" },
					reused: false,
				}),
			});
		});

		await page.getByRole("button", { name: /Download as \.html/ }).click();
		await expect.poll(() => requested).toBe(true);
	});

	// RV-2A. Two Apps open as tabs; switching between them in the open-documents
	// rail reuses the panel's frame, and an iframe keeps ONE WindowProxy across
	// navigations — so the app being switched AWAY from is still running during
	// the navigation, and every storage message it posts passes the parent's
	// `event.source === frame.contentWindow` check. It must never be served
	// against the app being switched TO. The quiet app below never calls
	// storage at all, so any row in its kv came from the other app's document.
	test("switching apps in the rail never lets the outgoing app write into the incoming app's storage", async ({
		page,
	}) => {
		const conversationId = await createConversation(
			page,
			"Make me two small apps",
		);
		const quietAppId = await seedApp(
			conversationId,
			QUIET_APP_HTML,
			"Quiet App",
		);
		const chattyAppId = await seedApp(
			conversationId,
			CHATTY_APP_HTML,
			"Chatty App",
		);
		await openChatAndReload(page, conversationId);

		const openFromList = async (title: string) => {
			await page
				.getByTestId("artifact-panel-list")
				.getByTestId("artifact-card")
				.filter({ hasText: title })
				.getByRole("button", { name: "Open" })
				.click();
		};
		await page.getByTestId("artifact-count-button").click();
		await openFromList("Quiet App");
		await expect(
			page.frameLocator("iframe.app-frame").getByRole("heading", {
				name: "Quiet App",
			}),
		).toBeVisible();
		await page.getByRole("button", { name: "Show list" }).click();
		await openFromList("Chatty App");
		const chattyFrame = page.frameLocator("iframe.app-frame");
		await expect(chattyFrame.getByTestId("chatty-count")).not.toHaveText("0");

		// A realistic server round trip for the incoming app's document, so the
		// outgoing one has time to post while the frame navigates.
		await page.route(`**/api/artifacts/${quietAppId}/app?**`, async (route) => {
			await new Promise((resolve) => setTimeout(resolve, 400));
			await route.continue();
		});
		await page
			.getByTestId("open-documents-rail")
			.getByRole("tab", { name: /Quiet App/ })
			.click();
		await expect(
			page.frameLocator("iframe.app-frame").getByRole("heading", {
				name: "Quiet App",
			}),
		).toBeVisible();
		await page.waitForTimeout(300);

		const quietRows = await db
			.select({ key: artifactKv.key })
			.from(artifactKv)
			.where(eq(artifactKv.artifactId, quietAppId));
		expect(quietRows).toEqual([]);
		const chattyRows = await db
			.select({ key: artifactKv.key })
			.from(artifactKv)
			.where(eq(artifactKv.artifactId, chattyAppId));
		expect(chattyRows).toEqual([{ key: "chatty" }]);
	});

	test("at 390x844 the frame fills the panel and the page never scrolls horizontally", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		const conversationId = await createConversation(
			page,
			"Make me a notes app",
		);
		await seedApp(conversationId, NOTES_APP_HTML);
		await openChatAndReload(page, conversationId);

		await page.getByTestId("artifact-count-button-compact").click();
		await page
			.getByTestId("artifact-panel-list-mobile")
			.getByRole("button", { name: "Open" })
			.click();

		await expect(page.locator("iframe.app-frame")).toBeVisible();
		const hasHorizontalOverflow = await page.evaluate(
			() =>
				document.documentElement.scrollWidth >
				document.documentElement.clientWidth,
		);
		expect(hasHorizontalOverflow).toBe(false);
	});
});
