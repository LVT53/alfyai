import { expect, type Locator, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import { users } from "../../src/lib/server/db/schema";
import {
	applyDocumentPatch,
	createDocumentArtifact,
	readDocumentForAlfy,
} from "../../src/lib/server/services/artifacts";
import { createConversation, login, waitForStableBoundingBox } from "./helpers";

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
		: page.getByRole("complementary", { name: "Document workspace" });
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

		const bar = page.getByRole("status", { name: "Changes from Alfy" });
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
