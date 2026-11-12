import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import {
	artifactKv,
	artifacts,
	artifactVersions,
	users,
} from "../../src/lib/server/db/schema";
import {
	createEmptyConversation,
	expectTopmost,
	login,
	waitForMotionToSettle,
	waitForStableBoundingBox,
} from "./helpers";

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

/**
 * A fixture that navigates ITSELF shortly after loading — no
 * allow-top-navigation is needed for this, since a sandboxed frame without it
 * can still navigate its OWN contents (only navigating the TOP page is
 * blocked). This is exactly the phishing-flow shape ruling 58's tripwire
 * exists for: a fake "sign in again" form drawn after a self-navigation.
 */
const RUNAWAY_APP_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Runaway App</title></head>
<body>
<h1>Runaway App</h1>
<script>
setTimeout(function () { window.location.href = "/login"; }, 800);
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
	const scrollContainer = page.getByTestId("page-scroll-container");
	// The panel's open/showing state can persist across a reload
	// (sessionStorage) — the "saved state survives a reload" test below calls
	// this a second time after `page.reload()`, where the App is very likely
	// already open again by the time this runs. The count button now toggles
	// (Wave 2.5 Step 4: clicking it while the panel is open closes it
	// instead), so clicking it unconditionally here could close an
	// already-open panel rather than open one — a bounded `waitFor` (not a
	// synchronous `isVisible()`) gives the restore a brief chance to finish
	// hydrating past `networkidle`, which only covers the network leg, and
	// falls through to a fresh open within 2s when the panel is genuinely
	// closed. Mirrors artifact-document.spec.ts's own openDocumentFromPanel().
	const alreadyShowing = await scrollContainer
		.waitFor({ state: "visible", timeout: 2_000 })
		.then(() => true)
		.catch(() => false);
	if (alreadyShowing) return;

	await page.getByTestId("artifact-count-button").click();
	// Redesign §5.2 (Wave 2.5 Step 4): each row is an ArtifactCard
	// chrome="row" now — the whole row is the button (data-testid
	// "artifact-row"), never a separate "Open" affordance. Every caller
	// here seeds exactly one app, so the first row is always the right one.
	await page
		.getByTestId("artifact-panel-list")
		.getByTestId("artifact-row")
		.first()
		.click();
	await expect(scrollContainer).toBeVisible();
}

test.describe("the App kind, in the panel", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("opens and runs the app in a sandboxed frame, with the exact allow-scripts attribute", {
		tag: "@smoke",
	}, async ({ page }) => {
		const conversationId = await createEmptyConversation(
			page,
			"Make me a notes app",
		);
		await seedApp(conversationId, NOTES_APP_HTML);
		await openChatAndReload(page, conversationId);

		await openAppPanel(page);

		const iframe = page.locator("iframe.app-frame");
		await expect(iframe).toBeVisible();
		// W13 (UI wishes, 2026-11): the sandbox notice row is gone, and
		// nothing was left in its place above the frame.
		await expect(page.locator(".app-frame-sandbox-bar")).toHaveCount(0);
		await expect(page.getByText(/Runs sandboxed/)).toHaveCount(0);
		// Ruling 58: allow-forms joined allow-scripts so a generated app's
		// <form> submit event can fire; see the dedicated form test below for
		// proof the submission itself is still refused.
		await expect(iframe).toHaveAttribute(
			"sandbox",
			"allow-scripts allow-forms",
		);

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
		const conversationId = await createEmptyConversation(
			page,
			"Make me a form app",
		);
		await seedApp(conversationId, FORM_APP_HTML, "Form App");
		await openChatAndReload(page, conversationId);
		await openAppPanel(page);

		const appFrame = page.frameLocator("iframe.app-frame");
		await expect(
			appFrame.getByRole("heading", { name: "Form App" }),
		).toBeVisible();

		await appFrame.getByRole("button", { name: "Submit" }).click();

		await expect(appFrame.getByTestId("submit-marker")).toHaveText("submitted");
		// No navigation actually happened: the app's own heading is still
		// there. If form-action had been dropped along with the sandbox
		// change, this button would have navigated the frame away from it.
		await expect(
			appFrame.getByRole("heading", { name: "Form App" }),
		).toBeVisible();
	});

	// Ruling 58's tripwire, RV-2A open question 2: the CSP cannot stop a
	// sandboxed frame from navigating itself. Proves the real trigger (a real
	// `load` event firing after a real self-navigation) in a real browser,
	// where the unit suite's manually-dispatched events cannot reach.
	test("an app that navigates itself trips the tripwire: the frame is torn down and a reload notice appears", async ({
		page,
	}) => {
		const conversationId = await createEmptyConversation(
			page,
			"Make me a runaway app",
		);
		await seedApp(conversationId, RUNAWAY_APP_HTML, "Runaway App");
		await openChatAndReload(page, conversationId);
		await openAppPanel(page);

		await expect(
			page.frameLocator("iframe.app-frame").getByRole("heading", {
				name: "Runaway App",
			}),
		).toBeVisible();

		// The fixture navigates itself ~50ms after loading; the parent tears
		// the frame down and shows its own notice in its place.
		await expect(page.locator("iframe.app-frame")).toHaveCount(0);
		await expect(
			page.getByText(
				"This app tried to leave its sandbox, so Alfy stopped it.",
			),
		).toBeVisible();

		await page.getByRole("button", { name: "Reload the app" }).click();
		await expect(page.locator("iframe.app-frame")).toBeVisible();
	});

	test("saved state survives a reload — the real postMessage bridge round-tripping through the real kv route", async ({
		page,
	}) => {
		const conversationId = await createEmptyConversation(
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
		const conversationId = await createEmptyConversation(
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

	// W11 (UI wishes, 2026-11): the selected "Preview" segment's right padding
	// was covered by the sliding thumb, because the two segments sized to
	// their own text ("Preview" is wider than "Code") while the thumb assumed
	// halves. Both segments must be equal in width and inner padding, and the
	// thumb must cover the selected segment exactly in both states.
	test("the Preview/Code segments are equal in width and padding, and the selected thumb covers one exactly", async ({
		page,
	}) => {
		const conversationId = await createEmptyConversation(
			page,
			"Make me a notes app",
		);
		await seedApp(conversationId, NOTES_APP_HTML);
		await openChatAndReload(page, conversationId);
		await openAppPanel(page);

		const previewTab = page.getByRole("tab", { name: /Preview/ });
		const codeTab = page.getByRole("tab", { name: /Code/ });
		const thumb = page.locator(".app-seg-thumb");
		const control = page.locator(".app-seg");

		// The panel animates in: let its motion finish, wait for the control's
		// box, and then read the tab and thumb rects in ONE evaluate so the
		// comparison is never between two different instants.
		await waitForMotionToSettle(page);
		await waitForStableBoundingBox(control);
		const readSegments = () =>
			control.evaluate((el) => {
				const rect = (element: Element) => {
					const box = element.getBoundingClientRect();
					return {
						x: box.x,
						y: box.y,
						width: box.width,
						height: box.height,
					};
				};
				const [previewEl, codeEl] = el.querySelectorAll(".app-seg-tab");
				const thumbEl = el.querySelector(".app-seg-thumb");
				if (!previewEl || !codeEl || !thumbEl) {
					throw new Error("the segmented control is incomplete");
				}
				return {
					control: rect(el),
					preview: rect(previewEl),
					code: rect(codeEl),
					thumb: rect(thumbEl),
				};
			});
		const innerPadding = (locator: Locator) =>
			locator.evaluate((el) => {
				const style = getComputedStyle(el);
				return {
					left: Number.parseFloat(style.paddingLeft),
					right: Number.parseFloat(style.paddingRight),
				};
			});

		const before = await readSegments();
		expect(
			Math.abs(before.preview.width - before.code.width),
			"the two segments must be equal in width",
		).toBeLessThanOrEqual(1);
		expect(
			Math.abs(before.preview.height - before.code.height),
			"the two segments must be equal in height",
		).toBeLessThanOrEqual(1);
		const previewPadding = await innerPadding(previewTab);
		const codePadding = await innerPadding(codeTab);
		expect(previewPadding).toEqual(codePadding);
		expect(previewPadding.left).toBeGreaterThan(0);
		expect(previewPadding.right).toBeGreaterThan(0);

		// Preview selected: the thumb's box is the Preview segment's own box,
		// read in the same instant as that segment's box.
		expect(
			Math.abs(before.thumb.width - before.preview.width),
			"the thumb covers the selected Preview segment",
		).toBeLessThanOrEqual(1);
		expect(
			Math.abs(
				before.thumb.x +
					before.thumb.width -
					(before.preview.x + before.preview.width),
			),
			"the thumb's right edge meets Preview's right edge",
		).toBeLessThanOrEqual(1);

		// Code selected: still one exact segment, with no width shift. The thumb
		// slides, so wait for it to settle and read every box together again.
		await codeTab.click();
		await waitForMotionToSettle(page);
		await waitForStableBoundingBox(thumb);
		await waitForStableBoundingBox(control);
		const after = await readSegments();
		expect(
			Math.abs(after.control.width - before.control.width),
			"selecting the bold Code label must not widen the control",
		).toBeLessThanOrEqual(1);
		expect(
			Math.abs(after.thumb.width - after.code.width),
			"the thumb covers the selected Code segment",
		).toBeLessThanOrEqual(1);
		expect(
			Math.abs(after.thumb.x - after.code.x),
			"the selected thumb starts where the Code segment starts",
		).toBeLessThanOrEqual(1);
		expect(
			Math.abs(after.preview.width - before.preview.width),
			"switching must not resize the segments",
		).toBeLessThanOrEqual(1);
		expect(
			Math.abs(after.code.width - before.code.width),
			"switching must not resize the segments",
		).toBeLessThanOrEqual(1);
	});

	test("a network-reaching fixture shows its glitch line and still runs", async ({
		page,
	}) => {
		const conversationId = await createEmptyConversation(
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
		const conversationId = await createEmptyConversation(
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

		// Wave 2.5 Step 13: "Ask Alfy for a new version" is now "Change this
		// app…" (the trigger, opening a popover) and "Rebuild" (the popover's
		// own submit) — two distinct labels now, so no more .last() needed to
		// disambiguate them.
		await page.getByRole("button", { name: /Change this app/ }).click();
		await page
			.getByLabel("What should change?")
			.fill("Add a character counter");
		await page.getByRole("button", { name: /Rebuild/ }).click();

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
		const conversationId = await createEmptyConversation(
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

		// The header's Download is the whole choice for an App: the export starts with
		// that one press (the full delivery, to the browser's download, is
		// artifact-downloads.spec.ts).
		await page.getByRole("button", { name: /Download as \.html/ }).click();
		await expect.poll(() => requested).toBe(true);
	});

	// RV-2A. Two Apps open as tabs; switching between them through the panel
	// list (Wave 2.5 Step 13: OpenDocumentsRail is hidden for App now, so the
	// list's own breadcrumb-and-row navigation is what switches — the SAME
	// {#key src} remount in AppFrame.svelte fires either way) reuses the
	// panel's frame, and an iframe keeps ONE WindowProxy across navigations —
	// so the app being switched AWAY from is still running during the
	// navigation, and every storage message it posts passes the parent's
	// `event.source === frame.contentWindow` check. It must never be served
	// against the app being switched TO. The quiet app below never calls
	// storage at all, so any row in its kv came from the other app's document.
	test("switching apps through the list never lets the outgoing app write into the incoming app's storage", async ({
		page,
	}) => {
		const conversationId = await createEmptyConversation(
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

		// Redesign §5.2 (Wave 2.5 Step 4): each row is an ArtifactCard
		// chrome="row" now (data-testid "artifact-row", not the old
		// "artifact-card" + a separate "Open" button) — the row itself is
		// the button, named from its own title text.
		const openFromList = async (title: string) => {
			await page
				.getByTestId("artifact-panel-list")
				.getByTestId("artifact-row")
				.filter({ hasText: title })
				.click();
		};
		await page.getByTestId("artifact-count-button").click();
		await openFromList("Quiet App");
		await expect(
			page.frameLocator("iframe.app-frame").getByRole("heading", {
				name: "Quiet App",
			}),
		).toBeVisible();
		// Wave 2.5 Step 3: the old "Show list" grid-icon button only remains on
		// the legacy, non-artifact header now — an artifact-kind item (App
		// included) uses ArtifactPanelHeader's breadcrumb instead
		// (DocumentWorkspace.svelte's own `artifactHeaderActionsSnippet` header
		// comment), same control `artifact-document.spec.ts` returns to the
		// list with.
		await page
			.getByRole("button", { name: "Back to this chat's items" })
			.click();
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
			.getByRole("button", { name: "Back to this chat's items" })
			.click();
		await openFromList("Quiet App");
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
		const conversationId = await createEmptyConversation(
			page,
			"Make me a notes app",
		);
		await seedApp(conversationId, NOTES_APP_HTML);
		await openChatAndReload(page, conversationId);

		await page.getByTestId("artifact-count-button-compact").click();
		// Redesign §5.2 (Wave 2.5 Step 4): chrome="row" — the whole row is the
		// button, never a separate "Open" affordance.
		await page
			.getByTestId("artifact-panel-list-mobile")
			.getByTestId("artifact-row")
			.first()
			.click();

		await expect(page.locator("iframe.app-frame")).toBeVisible();
		const hasHorizontalOverflow = await page.evaluate(
			() =>
				document.documentElement.scrollWidth >
				document.documentElement.clientWidth,
		);
		expect(hasHorizontalOverflow).toBe(false);
	});

	test("phone: 'Change this app…' opens the regenerate sheet on top of the panel", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		const conversationId = await createEmptyConversation(
			page,
			"Make me a notes app",
		);
		await seedApp(conversationId, NOTES_APP_HTML);
		await openChatAndReload(page, conversationId);

		await page.getByTestId("artifact-count-button-compact").click();
		await page
			.getByTestId("artifact-panel-list-mobile")
			.getByTestId("artifact-row")
			.first()
			.click();

		await page.getByRole("button", { name: /Change this app/ }).click();

		const sheet = page.getByRole("dialog", { name: "What should change?" });
		await expect(sheet).toBeVisible();

		// Before the `zIndexClass="z-[150]"` fix, this sheet painted at the
		// default z-50 — BEHIND the mobile shell's own iframe/panel — so
		// `elementFromPoint` at its own centre hit the app frame instead of
		// the sheet itself, even though `toBeVisible` (a DOM/CSS check only,
		// never actual paint order) still passed. Mirrors
		// artifact-document-comments.spec.ts's own topmost regression test.
		await expectTopmost(sheet, {
			message:
				"the regenerate sheet must be the topmost element, not painted under the phone panel",
		});

		await page.keyboard.press("Escape");
		await expect(sheet).toBeHidden();
	});

	test("expanded panel: the regenerate popover paints above the panel, and Escape closes only the popover first", async ({
		page,
	}) => {
		const conversationId = await createEmptyConversation(
			page,
			"Make me a notes app",
		);
		await seedApp(conversationId, NOTES_APP_HTML);
		await openChatAndReload(page, conversationId);
		await openAppPanel(page);

		await page
			.getByRole("button", { name: /Expand document workspace/ })
			.click();
		const expandedShell = page.locator(".workspace-shell-expanded");
		await expect(expandedShell).toBeVisible();

		await page.getByRole("button", { name: /Change this app/ }).click();
		// The desktop popover's own accessible name is the trigger's label
		// ("Change this app…", `artifacts.app.action.regenerate`) — distinct
		// from the phone sheet's title ("What should change?",
		// `artifacts.app.regenerate.prompt`) used in the test above.
		const popover = page.getByRole("dialog", { name: "Change this app…" });
		await expect(popover).toBeVisible();

		// W7 (UI wishes, 2026-11): the trigger's icon and label now carry the
		// measured gap of the neighbouring Preview/Code tab in the same bar
		// (0.3rem / 4.8px), and the menu wears the family's popover shell.
		const trigger = page.getByRole("button", { name: /Change this app/ });
		const neighbouringTab = page.getByRole("tab", { name: /Preview/ });
		const gapOf = (locator: Locator) =>
			locator.evaluate((el) => Number.parseFloat(getComputedStyle(el).gap));
		expect(
			Math.abs((await gapOf(trigger)) - (await gapOf(neighbouringTab))),
		).toBeLessThanOrEqual(0.5);
		const shell = await popover.evaluate((el) => {
			const style = getComputedStyle(el);
			return {
				display: style.display,
				direction: style.flexDirection,
				overflow: style.overflow,
				radius: Number.parseFloat(style.borderTopLeftRadius),
				shadow: style.boxShadow,
				border: Number.parseFloat(style.borderTopWidth),
			};
		});
		expect(shell.display, "the family's flex column shell").toBe("flex");
		expect(shell.direction).toBe("column");
		expect(shell.overflow).toBe("hidden");
		expect(shell.radius).toBeGreaterThan(0);
		expect(shell.shadow).not.toBe("none");
		expect(shell.border).toBeGreaterThan(0);

		// Before the z-index fix, `.app-regen-popover` (z-index: 60) painted
		// UNDER `.workspace-shell-expanded` (z-index: 115) — `toBeVisible`
		// never catches that, since it checks DOM/CSS, not paint order.
		await expectTopmost(popover, {
			message:
				"the regenerate popover must paint above the expanded panel, not under it",
		});

		// One Escape closes only the innermost layer (redesign §5.4) — the
		// popover — never both at once. Before the fix, DocumentWorkspace's
		// own window keydown listener (mounted before the popover's) saw
		// this same Escape first and always collapsed the expanded panel
		// too, regardless of the popover being open.
		await page.keyboard.press("Escape");
		await expect(popover).toBeHidden();
		await expect(expandedShell).toBeVisible();

		// A second Escape, with nothing else open, closes the expanded panel
		// (back to docked) as before.
		await page.keyboard.press("Escape");
		await expect(expandedShell).toBeHidden();
	});
});
