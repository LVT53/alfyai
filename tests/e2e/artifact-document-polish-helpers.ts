import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import { users } from "../../src/lib/server/db/schema";
import {
	applyDocumentPatch,
	createDocumentArtifact,
	readDocumentForAlfy,
} from "../../src/lib/server/services/artifacts";

// Shared seeding and measuring for the Document polish specs (G2-B:
// phone touch targets, prose details, the review bar at laptop widths). The
// Document is seeded through the real services; every number those specs
// assert is measured in a real browser because none of it exists in jsdom
// (there is no layout engine there).

export async function testUserId(): Promise<string> {
	const [user] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, "admin@local"))
		.limit(1);
	expect(user, "the e2e admin must exist").toBeTruthy();
	return user.id;
}

export async function setUiLanguage(language: "en" | "hu"): Promise<void> {
	await db
		.update(users)
		.set({ uiLanguage: language })
		.where(eq(users.email, "admin@local"));
}

/** A checklist written the way the editor stores one (a blank line between items: one block, and so one list, each) and as one tight list, plus status chips in running text and in a table. */
export const PROSE_MARKDOWN = [
	"## Trip",
	"",
	'Hotel: [chip kind="status" value="Paid"] Flight: [chip kind="status" value="To book"]',
	"",
	"### Packing",
	"",
	"- [x] Passport",
	"",
	"- [ ] Adapter",
	"",
	"- [ ] Sperl booking",
	"",
	"### Tight list",
	"",
	"- [ ] First",
	"- [ ] Second",
	"- [ ] Third",
	"",
	"| Item | Status |",
	"| --- | --- |",
	'| Hotel | [chip kind="status" value="Booked"] |',
	'| Concert | [chip kind="status" value="Cancelled"] |',
].join("\n");

export async function seedDocument(
	conversationId: string,
	options: {
		markdown: string;
		title?: string;
		/** How many of the first blocks Alfy rewrites (pending review state). */
		pendingOps?: number;
	},
): Promise<string> {
	const userId = await testUserId();
	const artifact = await createDocumentArtifact({
		userId,
		conversationId,
		title: options.title ?? "Trip notes",
		markdown: options.markdown,
		author: "user",
		summary: "Seeded for E2E",
	});
	const pendingOps = options.pendingOps ?? 0;
	if (pendingOps > 0) {
		const read = await readDocumentForAlfy({
			userId,
			artifactId: artifact.id,
			conversationId,
		});
		const targets = read.blocks
			.filter((block) => block.text.trim().length > 0)
			.slice(0, pendingOps);
		expect(targets.length).toBe(pendingOps);
		const result = await applyDocumentPatch({
			userId,
			artifactId: artifact.id,
			conversationId,
			patch: {
				patchId: randomUUID(),
				label: "Alfy edit",
				ops: targets.map((block, i) => ({
					opId: randomUUID(),
					kind: "replaceBlock" as const,
					blockId: block.blockId,
					baseHash: block.hash,
					blockLabel: block.label,
					text: `${block.text} (Alfy edit ${i})`,
				})),
			},
		});
		expect(result.ok, "the seed patch must apply").toBe(true);
	}
	return artifact.id;
}

export async function openDocument(
	page: Page,
	conversationId: string,
): Promise<Locator> {
	await page.evaluate((id) => {
		window.sessionStorage.removeItem(`pending-chat-message:${id}`);
	}, conversationId);
	await page.goto(`/chat/${conversationId}`);
	await page.reload({ waitUntil: "networkidle" });
	const isMobile = (page.viewportSize()?.width ?? 1440) < 768;
	await page
		.getByTestId(
			isMobile ? "artifact-count-button-compact" : "artifact-count-button",
		)
		.click();
	await page
		.getByTestId(
			isMobile ? "artifact-panel-list-mobile" : "artifact-panel-list",
		)
		.getByTestId("artifact-row")
		.first()
		.click({ timeout: 30_000 });
	// The desktop shell's accessible name is localized, so the class picks it.
	const shell = isMobile
		? page.getByTestId("document-workspace-mobile-shell")
		: page.locator("aside.workspace-shell-desktop");
	await expect(shell).toBeVisible({ timeout: 30_000 });
	await expect(shell.locator(".document-editor-host .ProseMirror")).toBeVisible(
		{ timeout: 30_000 },
	);
	return shell;
}

export type Box = { x: number; y: number; width: number; height: number };

export async function box(locator: Locator): Promise<Box> {
	const b = await locator.boundingBox();
	expect(b, "the element must have a bounding box").not.toBeNull();
	return b as Box;
}

/** The control's tappable area: its own box grown by its invisible `::after` hit area, when it has one. */
export async function tapArea(
	control: Locator,
): Promise<{ width: number; height: number }> {
	return control.evaluate((el) => {
		const rect = el.getBoundingClientRect();
		let left = rect.left;
		let right = rect.right;
		let top = rect.top;
		let bottom = rect.bottom;
		const after = getComputedStyle(el, "::after");
		if (after.content !== "none" && after.position === "absolute") {
			const offsetTop = Number.parseFloat(after.top);
			const offsetLeft = Number.parseFloat(after.left);
			const height = Number.parseFloat(after.height);
			const width = Number.parseFloat(after.width);
			if (![offsetTop, offsetLeft, height, width].some(Number.isNaN)) {
				top = Math.min(top, rect.top + offsetTop);
				left = Math.min(left, rect.left + offsetLeft);
				bottom = Math.max(bottom, rect.top + offsetTop + height);
				right = Math.max(right, rect.left + offsetLeft + width);
			}
		}
		return { width: right - left, height: bottom - top };
	});
}
