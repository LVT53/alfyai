import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import chatDict from "../../src/lib/i18n/chat";
import commonDict from "../../src/lib/i18n/common";
import { db } from "../../src/lib/server/db";
import { users } from "../../src/lib/server/db/schema";
import {
	buildAiSdkUiStreamBody,
	login,
	waitForAssistantResponse,
} from "./helpers";

// F5 (friction audit, ruling 77): in a Hungarian UI the first message never
// passes through an English page. The landing sends with a full document
// navigation, so the chat's first frames are server-rendered HTML: until the
// app shell applied the reader's language ("onMount") they were drawn in
// English ("Starting conversation...", "Type a message...", then the header
// "New Conversation" until the title came).
//
// Driven the way a reader does: type, press Send. The only code that is not
// input is observation: every frame's visible text (the page's text, its
// placeholders and its tab title) is recorded from the first frame of each
// document, which survives the navigation.

const FIRST_MESSAGE = "Szia! Két mesebeli kérdésem lenne a legjobb kávéházról.";
const REPLY = "Természetesen, szívesen segítek ebben a kérdésben.";
const GENERATED_TITLE = "Kávéházak története";
const UNTITLED_HU = "Új beszélgetés";

async function setUiLanguage(language: "en" | "hu") {
	await db
		.update(users)
		.set({ uiLanguage: language })
		.where(eq(users.email, "admin@local"));
}

type Frame = { url: string; text: string };

/** Records the visible text of every frame, in every document the page loads. */
async function recordFrames(page: Page): Promise<Frame[]> {
	const frames: Frame[] = [];
	await page.exposeFunction("__recordFrame", (frame: Frame) => {
		frames.push(frame);
	});
	await page.addInitScript(() => {
		let last = "";
		const visibleText = () => {
			const parts = [document.title];
			if (document.body) {
				parts.push(document.body.innerText);
				for (const field of document.body.querySelectorAll(
					"textarea[placeholder], input[placeholder]",
				)) {
					const element = field as HTMLInputElement;
					if (element.offsetParent !== null) parts.push(element.placeholder);
				}
			}
			return parts.join("\n");
		};
		const snap = () => {
			const text = visibleText();
			if (text === last) return;
			last = text;
			(
				window as unknown as { __recordFrame: (frame: Frame) => void }
			).__recordFrame({ url: location.pathname + location.search, text });
		};
		new MutationObserver(snap).observe(document, {
			subtree: true,
			childList: true,
			characterData: true,
			attributes: true,
		});
		const tick = () => {
			snap();
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	});
	return frames;
}

/** Every English sentence the app has a different Hungarian one for. */
function englishOnlyStrings(): string[] {
	const found = new Set<string>();
	for (const dictionary of [chatDict, commonDict]) {
		const english = dictionary.en as Record<string, string>;
		const hungarian = dictionary.hu as Record<string, string>;
		for (const [key, value] of Object.entries(english)) {
			if (typeof value !== "string" || value.includes("{")) continue;
			if (value.length < 10) continue;
			if (hungarian[key] === value) continue;
			found.add(value);
		}
	}
	return [...found];
}

async function holdTitle(page: Page) {
	let release: () => void = () => undefined;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/api/conversations/*/title", async (route) => {
		if (route.request().method() !== "POST") {
			await route.continue();
			return;
		}
		const conversationId = new URL(route.request().url()).pathname.split(
			"/",
		)[3];
		await held;
		const persisted = await page.request.patch(
			`/api/conversations/${conversationId}`,
			{ data: { title: GENERATED_TITLE } },
		);
		expect(persisted.ok()).toBe(true);
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ title: GENERATED_TITLE }),
		});
	});
	return release;
}

async function mockReply(page: Page) {
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
}

/** Type on the landing and press Send; resolves once the reply is on screen. */
async function sendFirstMessage(page: Page) {
	await page.getByTestId("message-input").fill(FIRST_MESSAGE);
	await page.getByTestId("send-button").click();
	await waitForAssistantResponse(page);
	await expect(page.getByText(REPLY)).toBeVisible();
}

test.describe("The first message in a Hungarian UI", () => {
	test.beforeAll(async () => {
		await setUiLanguage("hu");
	});
	test.afterAll(async () => {
		await setUiLanguage("en");
	});

	test("never shows an English frame from Send to the reply", async ({
		page,
	}) => {
		await mockReply(page);
		await login(page);
		const frames = await recordFrames(page);
		await page.goto("/", { waitUntil: "domcontentloaded" });
		await expect(page.getByTestId("message-input")).toBeEnabled();
		frames.length = 0;

		await sendFirstMessage(page);

		const chatFrames = frames.filter((frame) => frame.url.startsWith("/chat/"));
		expect(
			chatFrames.length,
			"the chat's first frames were recorded",
		).toBeGreaterThan(0);
		const forbidden = [
			"Starting conversation",
			"Type a message",
			"New Conversation",
			...englishOnlyStrings(),
		];
		const leaks = chatFrames.flatMap((frame, index) =>
			forbidden
				.filter((phrase) => frame.text.includes(phrase))
				.map(
					(phrase) =>
						`frame ${index} of ${frame.url}: ${JSON.stringify(phrase)}`,
				),
		);
		expect(leaks, "English text in a frame of the handoff").toEqual([]);
	});

	test("says Új beszélgetés until the generated title comes", async ({
		page,
	}) => {
		await mockReply(page);
		const releaseTitle = await holdTitle(page);
		await login(page);
		await page.goto("/", { waitUntil: "domcontentloaded" });
		await expect(page.getByTestId("message-input")).toBeEnabled();

		await sendFirstMessage(page);

		// The conversation is untitled until the generated title lands: the title
		// bar says so in the reader's language, not in the stored default's, and
		// so does the tab.
		const titleBar = page.locator(".chat-title-bar h1");
		await expect(titleBar).toHaveText(UNTITLED_HU);
		await expect(page).toHaveTitle(UNTITLED_HU);

		releaseTitle();
		await expect(titleBar).toHaveText(GENERATED_TITLE);
		await expect(page).toHaveTitle(GENERATED_TITLE);
	});
});
