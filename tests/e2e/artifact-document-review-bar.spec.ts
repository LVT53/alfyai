import { expect, type Locator, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import { users } from "../../src/lib/server/db/schema";
import {
	applyDocumentPatch,
	createComment,
	createDocumentArtifact,
	readDocumentForAlfy,
} from "../../src/lib/server/services/artifacts";
import {
	box,
	openDocument,
	seedDocument,
	setUiLanguage,
} from "./artifact-document-polish-helpers";
import {
	createConversation,
	login,
	waitForStableBoundingBox,
	workspacePanel,
} from "./helpers";

// Review 2.5 findings on the review bar (rd/review-2-5.md:45-56, 98-108): a
// phone-width bar that balloons to ~390px and covers half the document, and
// (once scrolling is involved) a bar that scrolls away with the text,
// spanning both grid columns, with no bottom padding to keep the last lines
// reachable. Seeded through the real services (`readDocumentForAlfy` +
// `applyDocumentPatch`, exactly like the review's own throwaway capture spec)
// rather than a live model call — a pending Alfy change is server state, not
// a UI concern, so seeding it directly is both faster and no less real than
// driving the fake provider end to end (already covered elsewhere, T8 live).

async function testUserId(): Promise<string> {
	const [user] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, "admin@local"))
		.limit(1);
	expect(user, "the e2e admin must exist").toBeTruthy();
	return user.id;
}

/**
 * Seeds a Document with N paragraphs, then applies one Alfy patch that
 * rewrites the first `pendingOps` of them — real pending-review state
 * (`getDocumentReviewState`'s own computation), so `ReviewBar` mounts with a
 * real `pendingCount` exactly as it would after a live `edit_artifact` call.
 * `pendingOps: 2` is the minimum for the prev/next buttons to be enabled
 * (`ReviewBar.svelte`: `disabled={pendingCount < 2}`).
 */
async function seedPendingChanges(
	conversationId: string,
	paragraphs: string[],
	pendingOps: number,
): Promise<string> {
	const userId = await testUserId();
	const artifact = await createDocumentArtifact({
		userId,
		conversationId,
		title: "Review bar regression",
		markdown: paragraphs.join("\n\n"),
		author: "user",
		summary: "Seeded for E2E",
	});
	const read = await readDocumentForAlfy({
		userId,
		artifactId: artifact.id,
		conversationId,
	});
	const targets = read.blocks.slice(0, pendingOps);
	expect(
		targets.length,
		"the seeded document must have enough blocks for the requested pending ops",
	).toBe(pendingOps);
	const result = await applyDocumentPatch({
		userId,
		artifactId: artifact.id,
		conversationId,
		patch: {
			patchId: "review-bar-e2e-patch",
			label: "Alfy edit",
			ops: targets.map((block, i) => ({
				opId: `review-bar-e2e-op-${i}`,
				kind: "replaceBlock" as const,
				blockId: block.blockId,
				baseHash: block.hash,
				blockLabel: block.label,
				text: `${block.text} (Alfy edit ${i})`,
			})),
		},
	});
	expect(result.ok, "the seed patch must apply").toBe(true);
	return artifact.id;
}

async function openChatAndReload(page: Page, conversationId: string) {
	await page.evaluate((id) => {
		window.sessionStorage.removeItem(`pending-chat-message:${id}`);
	}, conversationId);
	await page.goto(`/chat/${conversationId}`);
	await page.reload({ waitUntil: "networkidle" });
}

/** Mirrors artifact-document.spec.ts's own helper (file-local there, not exported). */
async function openDocumentFromPanel(page: Page): Promise<Locator> {
	const isMobile = (page.viewportSize()?.width ?? 1440) < 768;
	const countButton = page.getByTestId(
		isMobile ? "artifact-count-button-compact" : "artifact-count-button",
	);
	await countButton.click();
	const list = page.getByTestId(
		isMobile ? "artifact-panel-list-mobile" : "artifact-panel-list",
	);
	await list.getByTestId("artifact-row").first().click({ timeout: 30_000 });
	const shell = isMobile
		? page.getByTestId("document-workspace-mobile-shell")
		: workspacePanel(page);
	await expect(shell).toBeVisible({ timeout: 30_000 });
	return shell;
}

test.describe("Review bar on phone (Wave 2.5 review fix, Critical)", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("stays compact at 390x844 instead of ballooning over the document, with 44px prev/next", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		const conversationId = await createConversation(page, "Review bar phone");
		await seedPendingChanges(
			conversationId,
			["Book the flight to Vienna.", "Reserve the hotel near the river."],
			2,
		);
		await openChatAndReload(page, conversationId);
		await openDocumentFromPanel(page);

		const bar = page.getByRole("region", { name: "Changes from Alfy" });
		await expect(bar).toBeVisible();
		await waitForStableBoundingBox(bar);

		const barBox = await bar.boundingBox();
		expect(barBox, "the review bar must have a bounding box").not.toBeNull();
		// The reported regression put the bar at ~390px tall (half the
		// screen). A compact phone bar (message row wraps, nav row, a stacked
		// pair of 44px action buttons) comfortably fits under 200px.
		expect((barBox as { height: number }).height).toBeLessThan(200);

		const prevButton = bar.getByRole("button", { name: "Previous change" });
		const nextButton = bar.getByRole("button", { name: "Next change" });
		await expect(prevButton).toBeEnabled();
		await expect(nextButton).toBeEnabled();
		const prevBox = await prevButton.boundingBox();
		const nextBox = await nextButton.boundingBox();
		expect(prevBox, "prev must have a bounding box").not.toBeNull();
		expect(nextBox, "next must have a bounding box").not.toBeNull();
		// WCAG 2.5.8 / redesign §4.4: 44px minimum touch target.
		expect((prevBox as { height: number }).height).toBeGreaterThanOrEqual(44);
		expect((prevBox as { width: number }).width).toBeGreaterThanOrEqual(44);
		expect((nextBox as { height: number }).height).toBeGreaterThanOrEqual(44);
		expect((nextBox as { width: number }).width).toBeGreaterThanOrEqual(44);

		// The change pill and the surrounding text must not be hidden behind
		// an oversized bar — both paragraphs stay reachable above it.
		const shell = page.getByTestId("document-workspace-mobile-shell");
		await expect(
			shell.getByText("Book the flight to Vienna.", { exact: false }),
		).toBeVisible();
	});
});

// Review 2.5 Important finding (rd/review-2-5.md:98-108): `position: absolute`
// on a direct child of the scroller scrolled away WITH the text (an
// absolutely positioned element's containing block is its nearest positioned
// ancestor's box, which was the scroller itself here — not "pinned" at all),
// spanned both columns (covering the rail's last rows), and left no room for
// the last paragraph to clear it. The text column is the scroller now
// (`.document-content-text`), the comment column is its sibling, and the bar
// is `position: sticky` in a flow column inside the scroller — sticky can
// only travel within its parent's box, so a scroller that was ITS OWN parent
// let the bar scroll away with the text (found by this very test's sibling
// screenshot, not by any role/text query).
test.describe("Review bar positioning while scrolling (Wave 2.5 review fix, Important)", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("stays visible, confined to the text column, and never covers the last paragraph at 1440x900", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		const conversationId = await createConversation(page, "Review bar scroll");
		const filler = Array.from(
			{ length: 40 },
			(_, i) =>
				`Filler paragraph number ${i} pads out the document with enough sentences of ordinary text that the panel's own scroll container has real height to scroll through before reaching the end.`,
		);
		const lastParagraphText =
			"The very last paragraph in the whole document, which must stay fully readable even while a change is pending.";
		const paragraphs = [
			"Book the flight to Vienna.",
			"Reserve the hotel near the river.",
			...filler,
			lastParagraphText,
		];
		const pageErrors: string[] = [];
		page.on("pageerror", (error) => pageErrors.push(error.message));

		await seedPendingChanges(conversationId, paragraphs, 2);
		await openChatAndReload(page, conversationId);
		const shell = await openDocumentFromPanel(page);

		const bar = shell.getByRole("region", { name: "Changes from Alfy" });
		await expect(bar).toBeVisible();

		// Wait for the document to actually finish rendering (a generous
		// timeout absorbs the dev server's one-time compile of the Document
		// editor's module graph on the very first Document ever opened in a
		// test run) before scrolling — otherwise the scroll below moves an
		// empty/mid-layout container.
		const lastParagraph = shell
			.locator(".document-editor-host")
			.getByText(lastParagraphText, { exact: false });
		await expect(lastParagraph).toBeAttached({ timeout: 30_000 });

		const outerScroller = shell.locator(".document-content-text");
		await outerScroller.evaluate((el) => {
			el.scrollTop = el.scrollHeight;
		});
		await waitForStableBoundingBox(bar);

		// Still visible — not scrolled away with the text, and within the
		// scroller's own visible box (sticky to the bottom, not floating
		// outside it).
		await expect(bar).toBeVisible();
		const barBox = await bar.boundingBox();
		const outerBox = await outerScroller.boundingBox();
		expect(barBox, "the review bar must have a bounding box").not.toBeNull();
		expect(outerBox, "the scroller must have a bounding box").not.toBeNull();
		const bar_ = barBox as {
			x: number;
			y: number;
			width: number;
			height: number;
		};
		const outer_ = outerBox as {
			x: number;
			y: number;
			width: number;
			height: number;
		};
		expect(bar_.y).toBeGreaterThanOrEqual(outer_.y - 1);
		expect(bar_.y + bar_.height).toBeLessThanOrEqual(
			outer_.y + outer_.height + 2,
		);

		// Confined to the text column — never extends into the rail (the
		// bug: it used to span both grid columns).
		const railBox = await shell.locator(".document-content-rail").boundingBox();
		expect(railBox, "the rail must have a bounding box").not.toBeNull();
		const rail_ = railBox as { x: number };
		expect(bar_.x + bar_.width).toBeLessThanOrEqual(rail_.x + 2);

		// The last paragraph's own text is fully visible and not hidden
		// behind the bar (the bug: no bottom padding, so the bar covered it).
		await expect(lastParagraph).toBeVisible();
		const lastParaBox = await lastParagraph.boundingBox();
		expect(
			lastParaBox,
			"the last paragraph must have a bounding box",
		).not.toBeNull();
		const lastPara_ = lastParaBox as { y: number; height: number };
		expect(lastPara_.y + lastPara_.height).toBeLessThanOrEqual(bar_.y + 2);

		// `elementFromPoint` at the last paragraph's own centre confirms the
		// paragraph, not the bar, is what actually paints there — the same
		// technique used elsewhere in this suite to catch "visible per the
		// DOM but painted under something" bugs.
		const isParagraphOnTop = await lastParagraph.evaluate((node) => {
			const rect = node.getBoundingClientRect();
			const top = document.elementFromPoint(
				rect.x + rect.width / 2,
				rect.y + rect.height / 2,
			);
			return !!top && node.contains(top);
		});
		expect(
			isParagraphOnTop,
			"the last paragraph must be the topmost element at its own centre, not painted under the review bar",
		).toBe(true);

		expect(pageErrors, `no page errors, got: ${pageErrors.join("; ")}`).toEqual(
			[],
		);
	});
});

// The drawer (a panel too narrow for the comment column) covers the right edge
// of the text — where the review bar's Keep all / Undo all live. Someone
// reading a comment about Alfy's change wants exactly those next, so the
// drawer stops above the bar instead of hiding it.
test.describe("Comments drawer and the review bar (owner walk-through)", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("at a narrow panel the drawer stops above the review bar, and Keep all stays reachable", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1024, height: 768 });
		const conversationId = await createConversation(
			page,
			"Drawer above the review bar",
		);
		const paragraphs = [
			"Book the flight to Vienna.",
			"Reserve the hotel near the river.",
			...Array.from(
				{ length: 12 },
				(_, i) =>
					`Filler paragraph number ${i} pads out the document with enough sentences of ordinary text to have some height.`,
			),
		];
		const artifactId = await seedPendingChanges(conversationId, paragraphs, 2);
		const userId = await testUserId();
		const read = await readDocumentForAlfy({
			userId,
			artifactId,
			conversationId,
		});
		const target = read.blocks[3];
		expect(target, "a filler block to comment on").toBeTruthy();
		await createComment({
			userId,
			artifactId,
			anchor: {
				kind: "text",
				blockId: target.blockId,
				quote: "Filler",
				prefix: "",
				suffix: target.text.slice("Filler".length),
			},
			author: "user",
			body: "A comment the drawer shows",
		});

		await openChatAndReload(page, conversationId);
		const shell = await openDocumentFromPanel(page);
		const bar = shell.getByRole("region", { name: "Changes from Alfy" });
		await expect(bar).toBeVisible({ timeout: 30_000 });
		await shell.getByTestId("artifact-comments-button").click();
		const drawer = shell.getByTestId("comments-drawer");
		await expect(drawer).toBeVisible();
		await expect(drawer.getByText("A comment the drawer shows")).toBeVisible();
		await waitForStableBoundingBox(drawer);
		await waitForStableBoundingBox(bar);

		const drawerBox = await drawer.boundingBox();
		const barBox = await bar.boundingBox();
		expect(drawerBox && barBox).toBeTruthy();
		expect((drawerBox?.y ?? 0) + (drawerBox?.height ?? 0)).toBeLessThanOrEqual(
			(barBox?.y ?? 0) + 1,
		);

		const keepAll = bar.getByRole("button", { name: /Keep all/i });
		await expect(keepAll).toBeVisible();
		const reachable = await keepAll.evaluate((node) => {
			const rect = node.getBoundingClientRect();
			const top = document.elementFromPoint(
				rect.x + rect.width / 2,
				rect.y + rect.height / 2,
			);
			return !!top && node.contains(top);
		});
		expect(reachable, "Keep all must not be covered by the drawer").toBe(true);
	});
});

// G1-A's laptop screenshots (Hungarian UI, the comment column beside the text):
// the bar wrapped to two rows (96px) at 1280-1512 wide and floated a strip
// above the text's bottom edge with text showing under it. It stays one row at
// every width the text column can have (480px and up) and is flush with the
// bottom of the text, with nothing showing under or beside it. The phone layout
// (above) is untouched.
test.describe("Review bar at laptop widths, in Hungarian (G1-A screenshots)", () => {
	test.beforeEach(async ({ page }) => {
		await setUiLanguage("hu");
		await login(page);
	});
	test.afterEach(async () => {
		await setUiLanguage("en");
	});

	const filler = Array.from(
		{ length: 40 },
		(_, i) =>
			`Töltelék bekezdés ${i}: elég hosszú szöveg ahhoz, hogy a görgethető oszlop a review sáv alá is érjen, és lássuk, mi látszik alatta.`,
	);

	for (const [width, height, pendingOps] of [
		[1280, 800, 1],
		[1366, 768, 1],
		[1440, 900, 1],
		[1512, 982, 1],
		[1110, 800, 1],
		[1280, 800, 2],
		[1110, 800, 2],
	] as const) {
		test(`one row, flush with the bottom of the text, nothing showing under it (${width}x${height}, ${pendingOps} pending)`, async ({
			page,
		}) => {
			await page.setViewportSize({ width, height });
			const conversationId = await createConversation(page, "Review bar HU");
			await seedDocument(conversationId, {
				markdown: [
					"Első bekezdés a szállodáról.",
					"Második bekezdés a repülőről.",
					...filler,
				].join("\n\n"),
				title: "Bécsi utazás",
				pendingOps,
			});
			const shell = await openDocument(page, conversationId);
			const bar = shell.getByRole("region", { name: "Alfy módosításai" });
			await expect(bar).toBeVisible({ timeout: 30_000 });
			await waitForStableBoundingBox(bar);
			const scroller = shell.locator(".document-content-text");
			const barBox = await box(bar);
			const scrollerBox = await box(scroller);

			// The narrowest inline column (a 720px panel) leaves the text 480px.
			expect(scrollerBox.width).toBeGreaterThanOrEqual(479);

			// One row of controls: a 28-30px button plus the bar's padding; the
			// message may take a second line, never a second row of buttons.
			expect(barBox.height, "the bar's height").toBeLessThanOrEqual(72);
			const spans: { top: number; bottom: number }[] = [];
			for (const selector of [".review-bar-nav", ".review-bar-actions"]) {
				const part = bar.locator(selector);
				if (!(await part.isVisible())) continue;
				const b = await box(part);
				spans.push({ top: b.y, bottom: b.y + b.height });
			}
			const message = await box(bar.locator(".review-bar-msg"));
			spans.push({ top: message.y, bottom: message.y + message.height });
			for (const a of spans) {
				for (const b of spans) {
					expect(
						Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top),
						"the bar's parts share one row",
					).toBeGreaterThan(0);
				}
			}

			// Flush with the bottom of the text column...
			const scrollerBottom = scrollerBox.y + scrollerBox.height;
			expect(
				Math.abs(barBox.y + barBox.height - scrollerBottom),
				"the bar's bottom edge vs the text column's",
			).toBeLessThanOrEqual(1);

			// ...with nothing of the text showing beneath or beside it: the bottom
			// pixel row belongs to the bar at its left, middle and right.
			for (const fraction of [0.01, 0.5, 0.99]) {
				const hit = await bar.evaluate(
					(el, args) => {
						const rect = el.getBoundingClientRect();
						const top = document.elementFromPoint(
							rect.left + rect.width * args.fraction,
							rect.bottom - 1,
						);
						return !!top && el.contains(top);
					},
					{ fraction },
				);
				expect(hit, `the bar paints the bottom row at ${fraction}`).toBe(true);
			}
		});
	}
});

// G2-B's open item: the phone still floated the bar 64px above the panel's
// bottom edge as a rounded card, with text showing under it in a long document.
// It is flush now, like the laptop bar: full width of the text, nothing showing
// under or beside it, and the last lines still scroll clear of it.
test.describe("Review bar on a phone, flush with the bottom (Hungarian)", () => {
	test.beforeEach(async ({ page }) => {
		await setUiLanguage("hu");
		await login(page);
	});
	test.afterEach(async () => {
		await setUiLanguage("en");
	});

	const filler = Array.from(
		{ length: 30 },
		(_, i) =>
			`Töltelék bekezdés ${i}: elég hosszú szöveg ahhoz, hogy a görgethető oszlop a review sáv alá is érjen, és lássuk, mi látszik alatta.`,
	);
	const lastLine =
		"Az utolsó sor a dokumentumban, amelynek a sáv fölött is teljesen olvashatónak kell maradnia.";

	for (const [width, height, pendingOps] of [
		[390, 844, 1],
		[390, 844, 2],
		[360, 740, 2],
	] as const) {
		test(`flush with the bottom of the text, full width, nothing under it, the last line reachable (${width}x${height}, ${pendingOps} pending)`, async ({
			page,
		}) => {
			await page.setViewportSize({ width, height });
			const conversationId = await createConversation(page, "Review bar phone");
			await seedDocument(conversationId, {
				markdown: [
					"Első bekezdés a szállodáról.",
					"Második bekezdés a repülőről.",
					...filler,
					lastLine,
				].join("\n\n"),
				title: "Bécsi utazás",
				pendingOps,
			});
			const shell = await openDocument(page, conversationId);
			const bar = shell.getByRole("region", { name: "Alfy módosításai" });
			await expect(bar).toBeVisible({ timeout: 30_000 });
			await waitForStableBoundingBox(bar);
			const scroller = shell.locator(".document-content-text");
			const barBox = await box(bar);
			const scrollerBox = await box(scroller);

			// Flush with the bottom of the text column, and as wide as it is (no
			// side margins showing text beside the card).
			const scrollerBottom = scrollerBox.y + scrollerBox.height;
			expect(
				Math.abs(barBox.y + barBox.height - scrollerBottom),
				"the bar's bottom edge vs the text column's",
			).toBeLessThanOrEqual(1);
			expect(
				Math.abs(barBox.x - scrollerBox.x),
				"the bar's left edge vs the text column's",
			).toBeLessThanOrEqual(1);
			expect(
				Math.abs(barBox.x + barBox.width - (scrollerBox.x + scrollerBox.width)),
				"the bar's right edge vs the text column's",
			).toBeLessThanOrEqual(1);

			// Nothing of the text shows beneath or beside it: every point of the
			// bar's bottom row and its two side columns belongs to the bar.
			for (const [fx, fy] of [
				[0.01, 0.99],
				[0.5, 0.99],
				[0.99, 0.99],
				[0.005, 0.5],
				[0.995, 0.5],
				[0.005, 0.01],
			] as const) {
				const hit = await bar.evaluate(
					(el, args) => {
						const rect = el.getBoundingClientRect();
						const top = document.elementFromPoint(
							rect.left + rect.width * args.fx,
							rect.top + rect.height * args.fy,
						);
						return !!top && el.contains(top);
					},
					{ fx, fy },
				);
				expect(hit, `the bar paints (${fx}, ${fy})`).toBe(true);
			}

			// A bar, not a card: no rounded corners, no shadow.
			const look = await bar.evaluate((el) => {
				const style = getComputedStyle(el);
				return {
					radius: style.borderTopLeftRadius,
					shadow: style.boxShadow,
				};
			});
			expect(look.radius).toBe("0px");
			expect(look.shadow).toBe("none");

			// The last line scrolls fully clear of it.
			const last = shell
				.locator(".document-editor-host")
				.getByText(lastLine, { exact: false });
			await expect(last).toBeAttached({ timeout: 30_000 });
			await scroller.evaluate((el) => {
				el.scrollTop = el.scrollHeight;
			});
			await waitForStableBoundingBox(bar);
			await waitForStableBoundingBox(last);
			const lastBox = await box(last);
			const barAfter = await box(bar);
			expect(
				lastBox.y + lastBox.height,
				"the last line ends above the bar",
			).toBeLessThanOrEqual(barAfter.y + 1);
			const onTop = await last.evaluate((node) => {
				const rect = node.getBoundingClientRect();
				const top = document.elementFromPoint(
					rect.x + rect.width / 2,
					rect.y + rect.height / 2,
				);
				return !!top && node.contains(top);
			});
			expect(onTop, "the last line paints above nothing").toBe(true);

			// The buttons keep their 44px targets.
			for (const name of [/Mindet megtartom/, /Mindet visszavonom/]) {
				const b = await box(bar.getByRole("button", { name }));
				expect(b.height, `${name}`).toBeGreaterThanOrEqual(43.5);
			}
		});
	}
});
