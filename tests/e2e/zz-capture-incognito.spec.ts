// Screenshot capture for the incognito redesign. It asserts nothing anyone
// needs CI to assert — it drives the real app so every state can be
// photographed in both themes at a desktop and a phone width, and writes PNGs
// to a scratch directory that only exists on the machine that made them.
//
// So it SKIPS unless INCOGNITO_CAPTURE=1 is set. It stays a .spec.ts in
// tests/e2e/ so it keeps compiling against the same helpers and gets
// type-checked with everything else.
//
//   INCOGNITO_CAPTURE=1 npx playwright test tests/e2e/zz-capture-incognito.spec.ts
import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import {
	conversationForks,
	conversations,
	messages,
	users,
} from "../../src/lib/server/db/schema";
import { ensureSidebarExpanded, login } from "./helpers";

test.skip(
	process.env.INCOGNITO_CAPTURE !== "1",
	"screenshot capture helper — set INCOGNITO_CAPTURE=1 to run it",
);

const OUT =
	"/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/dc2da4d4-d513-4098-9b2b-8b6c426191eb/scratchpad/incognito/impl";

const INCOGNITO_ID = "capture-incognito-on";
const FORK_ID = "capture-incognito-fork";
const PLAIN_ID = "capture-incognito-plain";

const VIEWPORTS = {
	desktop: { width: 1280, height: 800 },
	phone: { width: 390, height: 844 },
} as const;

// The theme store lets the SERVER preference win over localStorage, so the
// preference has to be written through the API for a reload to keep it.
async function setTheme(page: Page, theme: "light" | "dark") {
	const ok = await page.evaluate(async (next) => {
		const response = await fetch("/api/settings/preferences", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ theme: next }),
		});
		localStorage.setItem("theme", next);
		return response.ok;
	}, theme);
	expect(ok, `setting the ${theme} theme failed`).toBe(true);
}

async function adminId(): Promise<string> {
	const [admin] = await db
		.select()
		.from(users)
		.where(eq(users.email, "admin@local"))
		.limit(1);
	expect(admin, "the e2e admin must exist").toBeTruthy();
	return admin.id;
}

async function seedConversation(
	userId: string,
	id: string,
	title: string,
	memoryIncognito: boolean,
	updatedAt: Date,
) {
	await db.delete(messages).where(eq(messages.conversationId, id));
	await db.delete(conversations).where(eq(conversations.id, id));
	await db.insert(conversations).values({
		id,
		userId,
		title,
		memoryIncognito,
		createdAt: updatedAt,
		updatedAt,
	});
	await db.insert(messages).values([
		{
			id: `${id}-msg-1`,
			conversationId: id,
			messageSequence: 1,
			role: "user" as const,
			content: "What are the rules for storing lithium batteries at home?",
			createdAt: updatedAt,
		},
		{
			id: `${id}-msg-2`,
			conversationId: id,
			messageSequence: 2,
			role: "assistant" as const,
			content:
				"Keep them cool and dry, away from anything flammable, and store them at a partial charge rather than full or empty.",
			createdAt: updatedAt,
		},
	]);
}

/** Three rows: the incognito chat (active), a fork-marked chat, a plain one. */
async function seed() {
	const userId = await adminId();
	const now = Date.now();
	await seedConversation(
		userId,
		INCOGNITO_ID,
		"Battery storage rules",
		true,
		new Date(now),
	);
	await seedConversation(
		userId,
		FORK_ID,
		"Battery storage rules — alt",
		false,
		new Date(now - 60_000),
	);
	await seedConversation(
		userId,
		PLAIN_ID,
		"Weekend plans",
		false,
		new Date(now - 120_000),
	);
	await db
		.delete(conversationForks)
		.where(eq(conversationForks.forkConversationId, FORK_ID));
	await db.insert(conversationForks).values({
		id: `${FORK_ID}-fork`,
		forkConversationId: FORK_ID,
		userId,
		sourceConversationId: INCOGNITO_ID,
		sourceConversationIdSnapshot: INCOGNITO_ID,
		sourceAssistantMessageId: `${INCOGNITO_ID}-msg-2`,
		sourceAssistantMessageIdSnapshot: `${INCOGNITO_ID}-msg-2`,
		copiedForkPointMessageId: `${FORK_ID}-msg-2`,
		sourceTitle: "Battery storage rules",
		forkSequence: 1,
		createdAt: new Date(now - 60_000),
	});
}

async function openChat(page: Page, id: string) {
	await page.goto(`/chat/${id}`, { waitUntil: "domcontentloaded" });
	await expect(page.getByTestId("message-input")).toBeVisible({
		timeout: 20000,
	});
	await expect(page.getByTestId("incognito-face")).toBeVisible();
	await page.waitForTimeout(400);
}

for (const theme of ["light", "dark"] as const) {
	for (const [name, viewport] of Object.entries(VIEWPORTS)) {
		test.describe(`incognito screenshots (${name}, ${theme})`, () => {
			test.use({
				viewport,
				...(name === "phone" ? { hasTouch: true, isMobile: true } : {}),
			});

			test(`resting, typing, card and sidebar (${name}, ${theme})`, async ({
				page,
			}) => {
				await seed();
				await login(page);
				await setTheme(page, theme);
				await openChat(page, INCOGNITO_ID);
				const tag = `${name}-${theme}`;

				// 1. Resting: the mask face and the placeholder.
				await page.screenshot({ path: `${OUT}/01-resting-${tag}.png` });

				// 2. Typing: the placeholder gives way; the face stays.
				const textarea = page.getByTestId("message-input");
				await textarea.fill(
					"Draft a short note on storing the spare batteries",
				);
				await page.waitForTimeout(200);
				await page.screenshot({ path: `${OUT}/02-typing-${tag}.png` });
				await textarea.fill("");

				// 3. The card, opened from the face.
				await page.getByTestId("incognito-face").click();
				await expect(page.getByTestId("incognito-popover")).toBeVisible();
				await page.waitForTimeout(350);
				await page.screenshot({ path: `${OUT}/03-popover-${tag}.png` });
				await page.keyboard.press("Escape");
				await expect(page.getByTestId("incognito-popover")).toBeHidden();

				// 4. The sidebar: the incognito row (active, so its three dots
				//    show) next to a fork-marked row, and the fork row hovered so
				//    its dots show too.
				if (name === "phone") {
					await page.locator('button[aria-label="Toggle sidebar"]').click();
					await page.waitForTimeout(400);
				} else {
					await ensureSidebarExpanded(page);
				}
				const incognitoRow = page.locator(
					`[data-testid="conversation-item"][data-conversation-id="${INCOGNITO_ID}"]`,
				);
				await expect(
					incognitoRow.getByTestId("conversation-incognito-mark"),
				).toBeVisible();
				const forkRow = page.locator(
					`[data-testid="conversation-item"][data-conversation-id="${FORK_ID}"]`,
				);
				await forkRow.hover();
				await page.waitForTimeout(250);
				await page.screenshot({ path: `${OUT}/04-sidebar-${tag}.png` });
				const aside = page.locator("aside").first();
				await aside.screenshot({ path: `${OUT}/04-sidebar-crop-${tag}.png` });

				// 5. The mark's tooltip.
				await incognitoRow.getByTestId("conversation-incognito-mark").hover();
				await page.waitForTimeout(250);
				await aside.screenshot({
					path: `${OUT}/05-sidebar-tooltip-${tag}.png`,
				});
			});
		});
	}
}
