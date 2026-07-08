#!/usr/bin/env tsx
// Captures release-campaign screenshots (desktop + mobile) of 9 UI areas for
// the campaign-preview@local user. Run scripts/seed-campaign-data.ts first.
//
// Usage: npx tsx scripts/campaign-shots.ts
// Env: CAMPAIGN_BASE_URL (default http://localhost:4173)
//      CAMPAIGN_OUT_DIR  (default scratchpad path passed by the caller)

import { mkdirSync } from "node:fs";
import { type Browser, chromium, type Page } from "playwright";

const BASE_URL = process.env.CAMPAIGN_BASE_URL || "http://localhost:4173";
const OUT_DIR =
	process.env.CAMPAIGN_OUT_DIR ||
	"/tmp/claude-1000/-home-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/6e169346-aef7-4a20-b2f4-685cfcde81c1/scratchpad/campaign";

const EMAIL = "campaign-preview@local";
const PASSWORD = "preview123";

const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 375, height: 812 };

mkdirSync(OUT_DIR, { recursive: true });

async function login(page: Page) {
	await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded" });
	const result = await page.evaluate(
		async ({ email, password }) => {
			const response = await fetch("/api/auth/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email, password }),
			});
			return { ok: response.ok, status: response.status };
		},
		{ email: EMAIL, password: PASSWORD },
	);
	if (!result.ok) {
		throw new Error(`Login failed with status ${result.status}`);
	}
	await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
	await page
		.getByTestId("message-input")
		.waitFor({ state: "visible", timeout: 15000 });
}

async function findConversationId(page: Page, title: string): Promise<string> {
	const result = await page.evaluate(async (title) => {
		const res = await fetch("/api/conversations");
		if (!res.ok) return null;
		const data = await res.json();
		const list = Array.isArray(data)
			? data
			: (data.conversations ?? data.items ?? []);
		const match = list.find((c: { title?: string }) => c.title === title);
		return match?.id ?? null;
	}, title);
	if (!result) throw new Error(`Conversation not found: ${title}`);
	return result;
}

async function shot(page: Page, name: string) {
	const path = `${OUT_DIR}/${name}.png`;
	await page.screenshot({ path });
	console.log(`Saved ${path}`);
}

// The app shell scrolls an inner `.main-content` div (`overflow-y-auto`)
// rather than the document body (`.knowledge-page` is `overflow: hidden`), so
// neither `page.screenshot({ fullPage: true })` nor a plain element
// screenshot captures more than one viewport's worth: the scroll container's
// own layout box is clamped to the viewport regardless of its content height.
// Temporarily force every ancestor in that overflow chain to lay out at full
// content height (no page navigation happens after, so there's nothing to
// restore) and then screenshot the now fully-expanded element.
async function shotScrollableFull(page: Page, selector: string, name: string) {
	await page.evaluate((sel) => {
		let el = document.querySelector<HTMLElement>(sel);
		while (el) {
			el.style.overflow = "visible";
			el.style.height = "auto";
			el.style.maxHeight = "none";
			el = el.parentElement;
		}
	}, selector);
	const path = `${OUT_DIR}/${name}.png`;
	await page.locator(selector).first().screenshot({ path });
	console.log(`Saved ${path}`);
}

type Mode = "desktop" | "mobile";

async function capturePass(
	page: Page,
	mode: Mode,
	mainConvoId: string,
	incognitoConvoId: string,
) {
	const suffix = mode;
	const isDesktop = mode === "desktop";

	async function gotoMainChat() {
		await page.goto(`${BASE_URL}/chat/${mainConvoId}`, {
			waitUntil: "domcontentloaded",
		});
		await page
			.getByTestId("message-input")
			.waitFor({ state: "visible", timeout: 15000 });
		await page
			.getByTestId("assistant-message")
			.first()
			.waitFor({ state: "visible", timeout: 15000 });
		// The ContextUsageRing (and a few other widgets) hydrate their data a
		// beat after mount; interacting too early can land on a DOM node Svelte
		// is about to replace, silently dropping clicks. Give it a moment.
		await page.waitForTimeout(900);
	}

	await gotoMainChat();

	// Shot 1: jump-rail. Desktop only by design — MessageArea/ConversationJumpRail
	// hides it under the phone-tier breakpoint (<640px). Mobile capture is the
	// plain chat view as a documented best-effort fallback.
	if (isDesktop) {
		await page
			.getByTestId("conversation-jump-rail")
			.waitFor({ state: "visible", timeout: 10000 })
			.catch(() => {});
	}
	await shot(page, `01-chat-jump-rail-${suffix}`);

	// Shot 2: top bar with title + project breadcrumb. Desktop only
	// (`.chat-title-bar` is `hidden lg:flex`) — mobile capture is the mobile
	// header (title only, no breadcrumb) as a documented best-effort fallback.
	if (isDesktop) {
		await page
			.locator(".chat-title-bar")
			.waitFor({ state: "visible", timeout: 5000 })
			.catch(() => {});
	} else {
		await page
			.locator("header")
			.first()
			.waitFor({ state: "visible", timeout: 5000 })
			.catch(() => {});
	}
	await shot(page, `02-chat-topbar-breadcrumb-${suffix}`);

	// Shot 8: ContextUsageRing popover with cost + tokens.
	const ringButton = page.locator(".ring-root .ring-button");
	await ringButton.waitFor({ state: "visible", timeout: 10000 });
	await ringButton.click({ force: true });
	await page
		.locator(".ring-popover--open, .ring-popover--mobile-visible")
		.first()
		.waitFor({ state: "visible", timeout: 5000 });
	await page
		.locator(".popover-cost-hero")
		.waitFor({ state: "visible", timeout: 5000 })
		.catch(() => {});
	await page.waitForTimeout(400); // let the opacity/translateY entrance transition finish
	await shot(page, `08-context-usage-ring-popover-${suffix}`);
	await page.keyboard.press("Escape").catch(() => {});
	await page.mouse.click(5, 5).catch(() => {});

	// Shot 9: compaction marker, expanded.
	await gotoMainChat();
	const compactionMarker = page
		.locator('[data-testid^="context-compression-marker-"]')
		.first();
	await compactionMarker
		.waitFor({ state: "visible", timeout: 10000 })
		.catch(() => {});
	const expandToggle = compactionMarker
		.locator(".context-compression-action--icon-only")
		.first();
	if (await expandToggle.isVisible().catch(() => false)) {
		await expandToggle.click({ force: true });
		await page.waitForTimeout(300);
	}
	await compactionMarker.scrollIntoViewIfNeeded().catch(() => {});
	await shot(page, `09-compaction-marker-${suffix}`);

	// Shot 7: Sources tab on the assistant message with evidence.
	await gotoMainChat();
	const evidenceToggle = page.locator(".evidence-toggle").first();
	await evidenceToggle
		.waitFor({ state: "visible", timeout: 10000 })
		.catch(() => {});
	if (await evidenceToggle.isVisible().catch(() => false)) {
		await evidenceToggle.scrollIntoViewIfNeeded();
		await evidenceToggle.click({ force: true });
		await page
			.locator(".evidence-groups")
			.waitFor({ state: "visible", timeout: 5000 })
			.catch(() => {});
	}
	await shot(page, `07-sources-tab-${suffix}`);

	// Shot 3: incognito composer.
	await page.goto(`${BASE_URL}/chat/${incognitoConvoId}`, {
		waitUntil: "domcontentloaded",
	});
	await page
		.getByTestId("message-input")
		.waitFor({ state: "visible", timeout: 15000 });
	await page
		.locator(".composer-incognito-notice")
		.waitFor({ state: "visible", timeout: 5000 })
		.catch(() => {});
	await shot(page, `03-incognito-mode-${suffix}`);

	// Shot 5: sidebar (projects, chats, pinning affordances).
	await gotoMainChat();
	if (isDesktop) {
		// The rail starts collapsed to icon-only; expand it so the project +
		// conversation list is visible.
		await page
			.locator("aside.sidebar-panel")
			.waitFor({ state: "visible", timeout: 5000 });
		const expandSidebarBtn = page.getByRole("button", {
			name: "Expand sidebar",
		});
		if (await expandSidebarBtn.isVisible().catch(() => false)) {
			await expandSidebarBtn.click();
			await page
				.getByRole("button", { name: "Collapse sidebar" })
				.waitFor({ state: "visible", timeout: 5000 });
		}
		// Reveal the per-row pin affordance (hidden until hover/menu-open) on the
		// active conversation row by hovering it, then opening its options menu.
		const activeConvoItem = page
			.locator('[data-testid="conversation-item"]')
			.first();
		await activeConvoItem
			.waitFor({ state: "visible", timeout: 5000 })
			.catch(() => {});
		await activeConvoItem.hover().catch(() => {});
		const convoOptionsBtn = activeConvoItem.getByRole("button", {
			name: "Conversation options",
		});
		if (await convoOptionsBtn.isVisible().catch(() => false)) {
			await convoOptionsBtn.click({ force: true });
			await page
				.locator('[data-testid="pin-option"]')
				.waitFor({ state: "visible", timeout: 3000 })
				.catch(() => {});
		}
	} else {
		// Mobile sidebar is a drawer opened via the hamburger toggle.
		const mobileToggle = page.locator(".mobile-sidebar-toggle");
		await mobileToggle.waitFor({ state: "visible", timeout: 10000 });
		await mobileToggle.click();
		await page
			.locator("aside.sidebar-panel")
			.waitFor({ state: "visible", timeout: 5000 });
		await page.waitForTimeout(300);
	}
	await shot(page, `05-sidebar-${suffix}`);
	await page.keyboard.press("Escape").catch(() => {});

	// Shot 6: settings profile tab (default tab on load).
	await page.goto(`${BASE_URL}/settings`, { waitUntil: "domcontentloaded" });
	await page
		.locator("#profile-tab")
		.waitFor({ state: "visible", timeout: 10000 })
		.catch(() => {});
	await page.waitForTimeout(500);
	await shot(page, `06-settings-profile-${suffix}`);

	// Shot 4: full memory Knowledge page — persona summary + info tooltip, the
	// 4 category cards, and the timeline expanded to show a merge/supersede
	// target line.
	await page.goto(`${BASE_URL}/knowledge`, { waitUntil: "domcontentloaded" });
	await page
		.getByRole("heading", { name: "Knowledge Base" })
		.waitFor({ state: "visible", timeout: 10000 });
	// SSR renders the heading before client hydration attaches interactive
	// handlers (the timeline's expand-on-click and the tooltip's
	// hover-to-open are both post-hydration behavior); give hydration a beat
	// before interacting, same as the chat page's ContextUsageRing.
	await page.waitForTimeout(700);
	const timelineSummary = page.locator(".memory-timeline-row summary").first();
	if (await timelineSummary.isVisible().catch(() => false)) {
		await timelineSummary.click({ force: true });
		await page
			.locator(".memory-timeline-actions")
			.first()
			.waitFor({ state: "visible", timeout: 5000 })
			.catch(() => {});
	}
	if (isDesktop) {
		// Hover-to-open tooltip only makes sense with a real pointer (desktop).
		const infoTrigger = page.locator(".info-tooltip-trigger").first();
		if (await infoTrigger.isVisible().catch(() => false)) {
			await infoTrigger.hover();
			await page
				.locator(".info-tooltip-bubble")
				.waitFor({ state: "visible", timeout: 3000 })
				.catch(() => {});
		}
	}
	await shotScrollableFull(
		page,
		".knowledge-page .main-content",
		`04-memory-knowledge-${suffix}`,
	);
}

async function run() {
	const browser: Browser = await chromium.launch();

	// `reducedMotion: "reduce"` triggers the app's global prefers-reduced-motion
	// CSS override (src/app.css), collapsing all transitions/animations to
	// ~0ms. That avoids racing screenshots against fade-in transitions (e.g.
	// the ContextUsageRing popover's opacity/translateY entrance).
	const desktopContext = await browser.newContext({
		colorScheme: "dark",
		reducedMotion: "reduce",
		viewport: DESKTOP,
	});
	const desktopPage = await desktopContext.newPage();
	await login(desktopPage);

	const mainConvoId = await findConversationId(
		desktopPage,
		"Q3 Revenue Deep-Dive",
	);
	const incognitoConvoId = await findConversationId(
		desktopPage,
		"Weekend trip planning",
	);
	console.log("Main conversation:", mainConvoId);
	console.log("Incognito conversation:", incognitoConvoId);

	await capturePass(desktopPage, "desktop", mainConvoId, incognitoConvoId);

	// Mobile needs its own context with real touch/mobile emulation
	// (`isMobile` + `hasTouch`), not just a resized viewport on the desktop
	// page: several components (e.g. ContextUsageRing) branch their layout on
	// `matchMedia("(pointer: coarse)")`, which only reports true under real
	// touch emulation. Reuse the desktop session's cookies via storageState so
	// there's only one login.
	const storageState = await desktopContext.storageState();
	const mobileContext = await browser.newContext({
		colorScheme: "dark",
		reducedMotion: "reduce",
		viewport: MOBILE,
		isMobile: true,
		hasTouch: true,
		storageState,
	});
	const mobilePage = await mobileContext.newPage();
	await capturePass(mobilePage, "mobile", mainConvoId, incognitoConvoId);

	await browser.close();
	console.log("\nAll shots captured.");
}

run().catch((err) => {
	console.error(err);
	process.exit(1);
});
