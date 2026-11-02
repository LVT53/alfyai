import { expect, type Locator, test } from "@playwright/test";
import {
	createComment,
	createDocumentArtifact,
	updateArtifactBody,
} from "../../src/lib/server/services/artifacts";
import { parseDocument } from "../../src/lib/shared/artifact-document/blocks";
import {
	openDocument,
	PROSE_MARKDOWN,
	testUserId,
} from "./artifact-document-polish-helpers";
import { createEmptyConversation, login } from "./helpers";

// The app's type: only a page's own top title wears the serif (the Home and
// project greeting, and the titles of Settings, Knowledge, the login page and the
// error page). Everything else is Nimbus Sans L, the Document, its panel and a
// Version preview included. Changing the family changed no size. The column is
// 70ch, because `ch` follows the font: that is the line 62ch of the serif was,
// about 79 characters of Hungarian.
//
// The family is read from the browser's computed style: the first name of the
// list is the one it tries first, and the serif is the one the @font-face rules
// call "Libre Baskerville".

const SANS = "Nimbus Sans L";
const SERIF = "Libre Baskerville";

const DOCUMENT_MARKDOWN = [
	"# Balatoni hétvége",
	"",
	"Október végén a Balaton északi partja csendes, a szállások olcsóbbak, és a kilátás ugyanolyan szép, mint nyáron.",
	"",
	PROSE_MARKDOWN,
].join("\n");

/** The first family of the list, quotes off: what the browser tries first. */
function firstFamily(locator: Locator): Promise<string> {
	return locator.first().evaluate((el) =>
		getComputedStyle(el)
			.fontFamily.split(",")[0]
			.trim()
			.replace(/^["']|["']$/g, ""),
	);
}

/** Every element at or below `root` whose font list names the serif, as `tag.class`. */
function serifInside(root: Locator): Promise<string[]> {
	return root.evaluate((top, serif) => {
		const found: string[] = [];
		for (const el of [top, ...top.querySelectorAll("*")]) {
			if (getComputedStyle(el).fontFamily.includes(serif)) {
				const classes = (el.getAttribute("class") ?? "")
					.split(/\s+/)
					.filter(Boolean)
					.slice(0, 2)
					.join(".");
				found.push(`${el.tagName.toLowerCase()}.${classes}`);
			}
		}
		return found;
	}, SERIF);
}

test.describe("Document type", () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await login(page);
	});

	test("the body, headings, checklist, table, comment and panel title are sans, and nothing in the panel is the serif", async ({
		page,
	}) => {
		const conversationId = await createEmptyConversation(page, "Document type");
		const userId = await testUserId();
		const artifact = await createDocumentArtifact({
			userId,
			conversationId,
			title: "Balatoni hétvége",
			markdown: DOCUMENT_MARKDOWN,
			author: "user",
			summary: "Seeded for E2E",
		});
		const block = parseDocument(artifact.body ?? "", {
			mint: false,
		}).blocks.find((candidate) => candidate.markdown.includes("kilátás"));
		if (!block) throw new Error("the paragraph to comment on must be seeded");
		const at = block.markdown.indexOf("kilátás");
		const thread = await createComment({
			userId,
			artifactId: artifact.id,
			anchor: {
				kind: "text",
				blockId: block.id,
				quote: "kilátás",
				prefix: block.markdown.slice(0, at),
				suffix: block.markdown.slice(at + "kilátás".length),
			},
			author: "user",
			body: "Nézzük meg, hogy van-e kilátás a tóra.",
		});
		expect(thread, "the seeded comment must be created").toBeTruthy();

		const shell = await openDocument(page, conversationId);
		const content = shell.locator(".document-editor-host .document-content");
		await expect(content).toContainText("Október végén");
		await expect(shell.locator(".comment-thread-quote").first()).toBeVisible();
		await page.evaluate(() => document.fonts.ready);

		const sans: Array<[string, Locator]> = [
			["the panel's title", shell.getByTestId("artifact-panel-title")],
			["the body", content],
			["a paragraph", content.locator("p").first()],
			["a heading 1", content.locator("h1").first()],
			["a heading 2", content.locator("h2").first()],
			["a heading 3", content.locator("h3").first()],
			["a task list", content.locator("ul[data-type='taskList']").first()],
			[
				"a task item's text",
				content.locator("li[data-checked] > div > p").first(),
			],
			["a table cell", content.locator("td").first()],
			["a comment's quote", shell.locator(".comment-thread-quote").first()],
		];
		for (const [what, locator] of sans) {
			expect(await firstFamily(locator), what).toBe(SANS);
		}
		expect(
			await serifInside(shell),
			"nothing inside the Document panel may be set in the serif",
		).toEqual([]);

		// The family changed and nothing else: the same 16px at 1.72, and a column
		// of 70 of its own font's zeros, not a width in pixels (a zero is measured
		// in 1/64 px steps, so 70 of them agree to about a pixel).
		const column = await content.evaluate((el) => {
			const probe = document.createElement("span");
			probe.style.cssText =
				"position:absolute;visibility:hidden;width:1ch;height:1px";
			el.appendChild(probe);
			const zero = probe.getBoundingClientRect().width;
			probe.remove();
			const style = getComputedStyle(el);
			return {
				fontSize: style.fontSize,
				lineHeight: style.lineHeight,
				maxWidth: Number.parseFloat(style.maxWidth),
				zero,
			};
		});
		expect(column.fontSize).toBe("16px");
		expect(column.lineHeight).toBe("27.52px");
		expect(Math.abs(column.maxWidth - column.zero * 70)).toBeLessThan(1.5);
	});

	test("a list shows its markers, and a checklist its boxes", async ({
		page,
	}) => {
		const conversationId = await createEmptyConversation(
			page,
			"Document lists",
		);
		await createDocumentArtifact({
			userId: await testUserId(),
			conversationId,
			title: "Document lists",
			markdown: [
				"Csomagolás:",
				"",
				"- Útlevél",
				"- Töltő",
				"",
				"1. Foglalás",
				"2. Fizetés",
				"",
				"- [ ] Esőkabát",
			].join("\n"),
			author: "user",
			summary: "Seeded for E2E",
		});

		const shell = await openDocument(page, conversationId);
		const content = shell.locator(".document-editor-host .document-content");
		await expect(content).toContainText("Fizetés");
		const marker = (locator: Locator) =>
			locator.first().evaluate((el) => getComputedStyle(el).listStyleType);

		expect(await marker(content.locator("ul:not([data-type])"))).toBe("disc");
		expect(await marker(content.locator("ol"))).toBe("decimal");
		expect(await marker(content.locator("ul[data-type='taskList']"))).toBe(
			"none",
		);
	});

	test("a Version preview is sans too", async ({ page }) => {
		const conversationId = await createEmptyConversation(page, "Version type");
		const userId = await testUserId();
		const artifact = await createDocumentArtifact({
			userId,
			conversationId,
			title: "Version type",
			markdown: "## Friday\n\nArrive and walk.\n\n- Lunch by the lake",
			author: "alfy",
			summary: "Alfy wrote the first draft",
		});
		await updateArtifactBody({
			userId,
			artifactId: artifact.id,
			conversationId,
			body: "## Friday\n\nArrive and walk by the lake.\n\n- Lunch by the lake",
			author: "user",
			summary: "Edited",
		});
		await openDocument(page, conversationId);
		await page
			.locator('[data-testid="artifact-history-button"]:visible')
			.first()
			.click();
		const preview = page.getByTestId("history-preview");
		await expect(preview).toContainText("Arrive and walk by the lake.");
		await page.evaluate(() => document.fonts.ready);

		expect(await firstFamily(preview.locator(".page")), "the page").toBe(SANS);
		expect(await firstFamily(preview.locator("h2").first()), "a heading").toBe(
			SANS,
		);
		expect(
			await serifInside(preview),
			"nothing in the Version preview may be set in the serif",
		).toEqual([]);
	});
});

test.describe("Login type", () => {
	// A page's own title is the one place the serif stays; the fields under it are sans.
	test("the title wears the serif and the fields are sans", async ({
		page,
	}) => {
		await page.goto("/login");
		const heading = page.getByRole("heading", { name: "Sign In" });
		await expect(heading).toBeVisible();
		await page.evaluate(() => document.fonts.ready);
		expect(await firstFamily(heading), "the page title").toBe(SERIF);
		expect(await firstFamily(page.locator('[name="email"]')), "email").toBe(
			SANS,
		);
		expect(
			await firstFamily(page.locator('[name="password"]')),
			"password",
		).toBe(SANS);
	});
});
