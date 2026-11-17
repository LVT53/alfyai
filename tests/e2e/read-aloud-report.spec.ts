// Read aloud on a standard report (an Atlas-style report), end to end, on the
// production build, against the fake speech service (read-aloud-documents, spec
// §4.13). The report is made by the real pipeline (the produce route, the
// standard-report renderer), hangs from a reply, and opens in the side panel from
// its card, framed by its own preview address in the opaque frame its preview has
// always had (scripts and popups, never same origin). That response carries the
// report's own policy, which the report runs under, and read aloud's bridge, which
// the server adds. The page reads its own inert copy; the bridge in the frame draws
// the marks and reports a selection as a place; the page shows its own Read from
// here, and only a press on it starts a reading. Most tests run with the page's
// whole policy enforced, as on the production boxes (CSP_MODE=enforce), which a
// frame loaded by address does not inherit; the first runs under the e2e servers'
// report-only default.
// The session route's refusals are held by
// `src/routes/api/read-aloud/sessions/sessions.report.test.ts`.
import { randomUUID } from "node:crypto";
import {
	expect,
	type Frame,
	type Locator,
	type Page,
	test,
} from "@playwright/test";
import {
	expectTopmost,
	login,
	waitForHydration,
	waitForMotionToSettle,
	waitForStableBoundingBox,
	workspacePanel,
} from "./helpers";
import {
	deleteReadAloudChat,
	type FakeSpeechService,
	hasRun,
	readAloudUi,
	seedReadAloudChat,
	spokenTokens,
	startFakeSpeechForSpec,
	stopFakeSpeechForSpec,
} from "./read-aloud-helpers";

let fake: FakeSpeechService;
let chatId: string | null = null;

test.beforeEach(async ({ page }) => {
	await login(page);
	fake = await startFakeSpeechForSpec(page, { secondsPerChar: 0.02 });
});

test.afterEach(async ({ page }) => {
	try {
		if (chatId) await deleteReadAloudChat(page, chatId);
	} finally {
		chatId = null;
		await stopFakeSpeechForSpec(page, fake);
	}
});

const TITLE = "Weekend report";

/**
 * A standard report as Atlas writes one: headings, paragraphs with their sources
 * and a basis marker (a button with a tooltip), a list and the final Sources.
 * Each paragraph is over fifty characters, so the script reads it as a sentence
 * of its own (short-sentences.ts).
 */
const REPORT_SOURCE = {
	version: 1,
	template: "alfyai_standard_report",
	title: TITLE,
	blocks: [
		{ type: "heading", level: 2, text: "Getting there by train" },
		{
			type: "paragraph",
			text: "The train leaves at nine in the morning from the main station in the town.",
			sources: [
				{
					title: "Rail timetable",
					url: "https://example.com/timetable",
					reasoning: "The timetable lists the morning train.",
				},
			],
			basisMarkers: [
				{
					type: "basisMarker",
					id: "basis-train",
					support: "supported",
					anchorText: "The train leaves at nine",
					rationale: "The timetable lists the nine o'clock train.",
				},
			],
		},
		{
			type: "paragraph",
			text: "Book the hotel by Friday, and ask for a quiet room at the back of the house.",
		},
		{ type: "heading", level: 2, text: "What to pack for the hills" },
		{
			type: "paragraph",
			text: "Pack the warm coats, because the nights up in the hills are cold in autumn.",
		},
		{
			type: "paragraph",
			text: "Take the long scarves as well, and the thick woollen socks for the evenings.",
		},
		{
			type: "paragraph",
			text: "Pay the deposit before the end of the week, by card or in cash at the desk.",
		},
		{ type: "heading", level: 2, text: "Sources" },
		{
			type: "sourceChips",
			title: "Web Sources",
			sources: [
				{
					title: "Rail timetable",
					url: "https://example.com/timetable",
					reasoning: "The timetable lists the morning train.",
				},
			],
		},
	],
};

/** Three sections of fifteen paragraphs, each under a heading of its own: 49 sentences with the title. */
function longReportSource() {
	const section = (title: string) => [
		{ type: "heading", level: 2, text: title },
		...Array.from({ length: 15 }, (_, i) => ({
			type: "paragraph",
			text: `Paragraph ${i + 1} of this section is written here, and it is long enough to stand alone.`,
		})),
	];
	return {
		version: 1,
		template: "alfyai_standard_report",
		title: "A long weekend report",
		blocks: [
			...section("Getting there by train"),
			...section("Where we will stay"),
			...section("What to pack for the hills"),
		],
	};
}

/**
 * The page's whole policy, enforced, as the production boxes send it: the e2e
 * servers send it report-only (with only `frame-src` enforced), so the chat page's
 * response is given it as `Content-Security-Policy`, the way
 * `images-viewer.spec.ts` does. These are the real headers `security-headers.ts`
 * made, nonce and all; only their name changes.
 */
async function enforceWholePolicy(page: Page, conversationId: string) {
	await page.route(
		new RegExp(`/chat/${conversationId}(?:\\?.*)?$`),
		async (route) => {
			const response = await route.fetch();
			const headers = { ...response.headers() };
			const whole =
				headers["content-security-policy-report-only"] ??
				headers["content-security-policy"];
			expect(whole, "the chat page carries a policy").toContain("'nonce-");
			delete headers["content-security-policy-report-only"];
			headers["content-security-policy"] = whole;
			await route.fulfill({ response, headers });
		},
	);
}

/**
 * A chat of the e2e admin whose reply made the report (the produce route, a
 * `document_source` job with an HTML output), opened, and the report opened in
 * the side panel from the reply's card. Resolves with the panel, the report's
 * frame and that frame's page.
 */
async function openReport(
	page: Page,
	options: { enforce: boolean; source?: object; title?: string },
): Promise<{ shell: Locator; frame: Locator; report: Frame }> {
	const title = options.title ?? TITLE;
	const id = `read-aloud-report-${randomUUID()}`;
	chatId = id;
	const [replyId] = await seedReadAloudChat(id, [
		"Here is the weekend report you asked for, with the trains, the stay and what to pack.",
	]);
	const produced = await page.request.post("/api/chat/files/produce", {
		data: {
			conversationId: id,
			assistantMessageId: replyId,
			idempotencyKey: randomUUID(),
			requestTitle: title,
			sourceMode: "document_source",
			documentSource: options.source ?? REPORT_SOURCE,
			requestedOutputs: [{ type: "html" }],
		},
	});
	expect(produced.status(), await produced.text()).toBe(202);
	const { job } = (await produced.json()) as { job: { id: string } };
	await expect
		.poll(
			async () => {
				const read = await page.request.get(`/api/chat/files/jobs/${job.id}`);
				const body = (await read.json()) as { job: { status: string } };
				return body.job.status;
			},
			{ timeout: 30_000 },
		)
		.toBe("succeeded");

	if (options.enforce) await enforceWholePolicy(page, id);
	await page.goto(`/chat/${id}`, { waitUntil: "domcontentloaded" });
	await waitForHydration(page);
	await page
		.getByTestId("file-production-card")
		.getByRole("button", { name: /^Preview .*\.html$/ })
		.click({ timeout: 30_000 });
	const phone = (page.viewportSize()?.width ?? 1440) < 768;
	const shell = phone
		? page.getByTestId("document-workspace-mobile-shell")
		: workspacePanel(page);
	await expect(shell).toBeVisible({ timeout: 30_000 });
	const frame = shell.locator("iframe.html-preview-frame");
	await expect(frame).toBeVisible({ timeout: 30_000 });
	await expect(
		page
			.frameLocator("iframe.html-preview-frame")
			.getByRole("heading", { level: 1, name: title }),
	).toBeVisible({ timeout: 30_000 });
	const report = await (await frame.elementHandle())?.contentFrame();
	if (!report) throw new Error("the report's frame has no page");
	return { shell, frame, report };
}

/** The text of a read-aloud highlight the bridge drew in the report, or "" when there is none. */
function marked(report: Frame, name: string): Promise<string> {
	return report.evaluate(
		(highlight) =>
			[
				...((
					CSS as unknown as {
						highlights?: Map<string, Iterable<AbstractRange>>;
					}
				).highlights?.get(highlight) ?? []),
			]
				.map((range) => (range as Range).toString())
				.join(" ")
				.trim(),
		name,
	);
}

/** Whether the sentence the bridge marks is inside what the report's scroller shows. */
function markInView(report: Frame): Promise<boolean> {
	return report.evaluate(() => {
		const highlight = (
			CSS as unknown as { highlights?: Map<string, Iterable<AbstractRange>> }
		).highlights?.get("alfy-read-aloud-sentence");
		const range = highlight ? ([...highlight][0] as Range | undefined) : null;
		const scroller = document.getElementById("report-content");
		if (!range || !scroller) return false;
		const rect = range.getBoundingClientRect();
		const box = scroller.getBoundingClientRect();
		return rect.height > 0 && rect.top >= box.top && rect.bottom <= box.bottom;
	});
}

/**
 * Selects `needle` in the report's content, in the frame, the way a reader's
 * mouse would end up: brought into view, then an exact range, which fires the
 * frame's own `selectionchange`.
 */
async function selectInReport(report: Frame, needle: string) {
	await report.evaluate((text) => {
		const root = document.getElementById("report-content");
		if (!root) throw new Error("no report content");
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			const at = node.textContent?.indexOf(text) ?? -1;
			if (at < 0) continue;
			// A reader selects what they can see.
			node.parentElement?.scrollIntoView({
				block: "center",
				behavior: "instant",
			});
			const range = document.createRange();
			range.setStart(node, at);
			range.setEnd(node, at + text.length);
			const selection = document.getSelection();
			selection?.removeAllRanges();
			selection?.addRange(range);
			return;
		}
		throw new Error(`no text "${text}" in the report`);
	}, needle);
}

test("@smoke the speaker in a report's header reads it, and the mark in the report follows the reading", async ({
	page,
}) => {
	const { shell, report } = await openReport(page, { enforce: false });
	const ui = readAloudUi(page);
	const speaker = shell.getByTestId("read-aloud-speaker-header");
	await expect(speaker).toHaveAttribute("aria-label", "Read aloud");
	await speaker.click();
	await expect(ui.player).toBeVisible();

	// What is read is the report's text, from the page's own copy: not its chrome.
	await expect.poll(() => fake.sessions.length, { timeout: 15_000 }).toBe(1);
	const tokens = spokenTokens(fake);
	expect(hasRun(tokens, ["The", "train", "leaves", "at", "nine"])).toBe(true);
	expect(hasRun(tokens, ["Pack", "the", "warm", "coats"])).toBe(true);
	for (const chrome of ["timetable", "Supported", "Rail", "Sources", "Web"])
		expect(tokens, `${chrome} is not read`).not.toContain(chrome);

	// The bridge draws the sentence and the word inside the report, and they move on.
	await expect
		.poll(() => marked(report, "alfy-read-aloud-sentence"), { timeout: 15_000 })
		.not.toBe("");
	const first = await marked(report, "alfy-read-aloud-sentence");
	await expect
		.poll(() => marked(report, "alfy-read-aloud-sentence"), { timeout: 20_000 })
		.not.toBe(first);
	await expect
		.poll(() => marked(report, "alfy-read-aloud-word"), { timeout: 10_000 })
		.not.toBe("");
	expect(await marked(report, "alfy-read-aloud-sentence")).not.toContain(
		"Supported",
	);

	await ui.button("Stop reading").click();
	await expect
		.poll(() => marked(report, "alfy-read-aloud-sentence"), { timeout: 10_000 })
		.toBe("");
	await expect(speaker).toHaveAttribute("aria-label", "Read aloud");
});

test.describe("under the policy the production boxes enforce", () => {
	test("the report runs under its own response's policy, not the page's: its own scripts work, and so does the bridge", async ({
		page,
	}) => {
		const refused: string[] = [];
		page.on("console", (message) => {
			const text = message.text();
			// Chromium says "Refused to execute inline script…", or in newer versions
			// "Executing inline script violates…".
			if (/(?:Refused to execute|Executing) inline script/.test(text))
				refused.push(text);
		});
		const { shell, report } = await openReport(page, { enforce: true });
		expect(report.url()).toMatch(/\/api\/chat\/files\/[^/]+\/preview$/);
		// The report's own section menu marks the section in view: its script ran.
		await expect
			.poll(
				() =>
					report.evaluate(
						() => document.querySelectorAll(".report-nav a.active").length,
					),
				{ timeout: 10_000 },
			)
			.toBeGreaterThan(0);
		await shell.getByTestId("read-aloud-speaker-header").click();
		await expect
			.poll(() => marked(report, "alfy-read-aloud-sentence"), {
				timeout: 15_000,
			})
			.not.toBe("");
		expect(refused).toEqual([]);
	});

	test("the report never moves the panel's frame: its links open a new tab, a page it opens in place is taken down until Reload, and it cannot leave the app", async ({
		page,
	}) => {
		await page.context().route("https://example.com/**", (route) =>
			route.fulfill({
				status: 200,
				contentType: "text/html",
				body: "<title>Rail timetable</title>The morning train.",
			}),
		);
		const { shell, frame, report } = await openReport(page, { enforce: true });
		const address = report.url();
		const tripwire = shell.locator(".html-preview-tripwire");

		// A source's link opens a new tab; the report stays where it is.
		const [tab] = await Promise.all([
			page.context().waitForEvent("page"),
			report.getByRole("link", { name: "Rail timetable" }).last().click(),
		]);
		await tab.waitForLoadState();
		expect(tab.url()).toBe("https://example.com/timetable");
		await tab.close();
		expect(report.url()).toBe(address);
		await expect(tripwire).toHaveCount(0);

		// A page of this app that the report opens in its own frame: the load the panel
		// did not ask for takes the frame down, and Reload frames the report again.
		await report.evaluate(() => {
			setTimeout(() => {
				window.location.href = "/api/health";
			}, 0);
		});
		await expect(tripwire).toContainText(
			"This report tried to open another page in the panel, so Alfy stopped it.",
		);
		await expect(frame).toHaveCount(0);
		await tripwire.getByRole("button", { name: "Reload the report" }).click();
		await expect(
			page
				.frameLocator("iframe.html-preview-frame")
				.getByRole("heading", { level: 1, name: TITLE }),
		).toBeVisible({ timeout: 15_000 });

		// An address outside the app: the page's own frame-src stops it before any
		// request leaves (the browser says so in the console).
		const reached: string[] = [];
		await page
			.context()
			.route("https://elsewhere.invalid/**", async (route) => {
				reached.push(route.request().url());
				await route.fulfill({ status: 200, body: "no" });
			});
		const blocked = page.waitForEvent("console", (message) =>
			message.text().includes("elsewhere.invalid"),
		);
		const again = await (await frame.elementHandle())?.contentFrame();
		if (!again) throw new Error("the report's frame has no page");
		await again.evaluate(() => {
			setTimeout(() => {
				window.location.href = "https://elsewhere.invalid/away";
			}, 0);
		});
		expect((await blocked).text()).toMatch(/frame-src/);
		expect(reached).toEqual([]);
	});

	test("a selection in the report shows the page's own Read from here, and only a press on it reads, from there", async ({
		page,
	}) => {
		const { shell, frame, report } = await openReport(page, { enforce: true });
		await selectInReport(report, "Pack the warm coats");
		const pill = shell.getByTestId("report-read-from-here");
		await expect(pill).toBeVisible();
		await expect(pill).toHaveAccessibleName("Read from here");
		// Where the frame said: over the report, above the selection.
		await waitForStableBoundingBox(pill);
		const box = await pill.boundingBox();
		const area = await frame.boundingBox();
		const selected = await report.evaluate(() => {
			const rect = document
				.getSelection()
				?.getRangeAt(0)
				.getBoundingClientRect();
			return rect ? { top: rect.top, left: rect.left } : null;
		});
		expect(box && area && selected).toBeTruthy();
		if (box && area && selected) {
			expect(box.y).toBeGreaterThanOrEqual(area.y);
			expect(box.y + box.height).toBeLessThanOrEqual(area.y + area.height);
			expect(box.y + box.height).toBeLessThanOrEqual(area.y + selected.top);
		}
		// A selection alone starts nothing: the control is up, and no reading opened.
		expect(fake.sessions).toHaveLength(0);

		await pill.click();
		await expect.poll(() => fake.sessions.length, { timeout: 15_000 }).toBe(1);
		const sentence = fake.sessions[0]?.body.sentences[0]?.tokens ?? [];
		expect(sentence.slice(0, 4)).toEqual(["Pack", "the", "warm", "coats,"]);
		await expect(pill).toBeHidden();
		await expect(
			shell.getByTestId("read-aloud-speaker-header"),
		).toHaveAttribute("aria-label", "Pause reading");
		await expect
			.poll(() => marked(report, "alfy-read-aloud-sentence"), {
				timeout: 15_000,
			})
			.toContain("Pack the warm coats");
	});

	test("a long report notches its headings, Read from here on a heading starts that section, and ⌖ scrolls the report", async ({
		page,
	}) => {
		const { shell, report } = await openReport(page, {
			enforce: true,
			source: longReportSource(),
			title: "A long weekend report",
		});
		const ui = readAloudUi(page);
		await shell.getByTestId("read-aloud-speaker-header").click();
		await expect(ui.player).toBeVisible();
		// 49 sentences: the title, three headings and 45 paragraphs. Past 40 the
		// scrubber marks where each section starts instead of every sentence.
		await expect(ui.slider).toHaveAttribute("aria-valuemax", "49");
		await expect(ui.player.locator(".read-aloud-notch")).toHaveCount(4);

		await selectInReport(report, "Where we will stay");
		await shell.getByTestId("report-read-from-here").click();
		await expect.poll(() => fake.sessions.length, { timeout: 15_000 }).toBe(2);
		expect(fake.sessions[1]?.body.sentences[0]?.tokens).toEqual([
			"Where",
			"we",
			"will",
			"stay.",
		]);
		await expect(ui.slider).toHaveAttribute(
			"aria-valuetext",
			/^Sentence 18 of 49$/,
		);
		await expect.poll(() => markInView(report), { timeout: 10_000 }).toBe(true);

		// The report scrolled away from the reading: ⌖ brings it back, in the report.
		await report.evaluate(() => {
			const scroller = document.getElementById("report-content");
			if (scroller) scroller.scrollTop = scroller.scrollHeight;
		});
		await expect
			.poll(() => markInView(report), { timeout: 10_000 })
			.toBe(false);
		await ui.button("Go to where it's reading").click();
		await expect.poll(() => markInView(report), { timeout: 10_000 }).toBe(true);
	});

	test("a message posted from another window is ignored", async ({ page }) => {
		const { shell, report } = await openReport(page, { enforce: true });
		const forged = {
			v: 1,
			kind: "alfy.readAloud",
			type: "selection",
			block: 0,
			offset: 0,
			x: 40,
			y: 40,
			width: 120,
			height: 20,
		};
		// From the page itself.
		await page.evaluate((data) => window.postMessage(data, "*"), forged);
		// From another frame of the page: a same-origin blank one, its message sent
		// from inside it, so its source is that frame's window.
		await page.evaluate(() => {
			const other = document.createElement("iframe");
			other.name = "read-aloud-forger";
			other.style.display = "none";
			document.body.append(other);
		});
		const forger = page.frame({ name: "read-aloud-forger" });
		if (!forger) throw new Error("no forging frame");
		await forger.evaluate((data) => {
			window.parent.postMessage(
				{ v: 1, kind: "alfy.readAloud", type: "ready", blocks: 1, chars: 1 },
				"*",
			);
			window.parent.postMessage(data, "*");
		}, forged);
		// Messages are handled in the order they were posted: once the page has heard
		// one of its own posted after the forged ones, it has heard those too.
		await page.evaluate(
			() =>
				new Promise<void>((resolve) => {
					const heard = (event: MessageEvent) => {
						if (event.data !== "read-aloud-report-sentinel") return;
						window.removeEventListener("message", heard);
						resolve();
					};
					window.addEventListener("message", heard);
					window.postMessage("read-aloud-report-sentinel", "*");
				}),
		);
		await expect(shell.getByTestId("report-read-from-here")).toHaveCount(0);
		expect(fake.sessions).toHaveLength(0);

		// The report's own frame is still heard: the forged ready changed nothing.
		await selectInReport(report, "Book the hotel");
		await expect(shell.getByTestId("report-read-from-here")).toBeVisible();
		expect(fake.sessions).toHaveLength(0);
	});

	test("on a phone the panel covers the chat: its header reads the report, its player is at its foot, and Read from here works in the report", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		const { shell, report } = await openReport(page, { enforce: true });
		const ui = readAloudUi(page);
		await shell.getByTestId("read-aloud-speaker-header").click();

		const player = shell
			.getByTestId("workspace-read-aloud-player")
			.getByLabel("Read aloud player");
		await expect(player).toBeVisible();
		// Not the composer's: that one stays down behind the panel.
		await expect(
			page.locator(".composer-layer").getByLabel("Read aloud player"),
		).toBeHidden();
		await expect
			.poll(() => marked(report, "alfy-read-aloud-sentence"), {
				timeout: 15_000,
			})
			.not.toBe("");
		await waitForMotionToSettle(page);
		await expectTopmost(player, {
			message: "nothing of the page paints over the panel's player",
			probe: "center",
		});

		await selectInReport(report, "Pay the deposit");
		const pill = shell.getByTestId("report-read-from-here");
		await expect(pill).toBeVisible();
		await waitForStableBoundingBox(pill);
		const box = await pill.boundingBox();
		expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
		expect((box?.x ?? 0) + (box?.width ?? 999)).toBeLessThanOrEqual(390);
		await expectTopmost(pill, {
			message: "the report's frame and the player never cover Read from here",
			probe: "center",
		});
		await pill.click();
		await expect.poll(() => fake.sessions.length, { timeout: 15_000 }).toBe(2);
		expect(fake.sessions[1]?.body.sentences[0]?.tokens.slice(0, 3)).toEqual([
			"Pay",
			"the",
			"deposit",
		]);

		await ui.button("Stop reading").click();
		await expect(player).toBeHidden();
	});
});
