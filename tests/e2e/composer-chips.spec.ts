// The chips redesign, in the running app (owner-approved boards,
// 2026-09-15 — Main / ChipSystem / ComposerStates / InStream).
//
// The unit tests pin the chip's grammar in isolation. What only the real app
// can answer is whether the five per-feature lists really did collapse into
// ONE row, whether a chip really does carry exactly one control, and whether
// the row survives a loaded turn without pushing the send button out of
// reach. That is what this spec is for.
import { expect, type Page, test } from "@playwright/test";
import { login } from "./helpers";

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

// A 1x1 transparent PNG — enough for the image-attachment chip, whose crop is
// served by the preview endpoint rather than read out of these bytes.
const PNG_1X1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

const SHORT_MESSAGE_CAP = "400";
const DEFAULT_MESSAGE_CAP = "1048576";

type UploadArtifact = {
	id: string;
	name: string;
	mimeType: string;
	sizeBytes: number;
	tokenEstimate?: number;
	pageCount?: number;
	/** What `pageCount` counts. A structured parse always writes one. */
	pageCountKind?: string;
	outline?: { level: number; title: string; offset: number; preview: string }[];
};

const PDF_ARTIFACT: UploadArtifact = {
	id: "artifact-lease",
	name: "Lease agreement 2026.pdf",
	mimeType: "application/pdf",
	sizeBytes: 482_112,
	tokenEstimate: 18_400,
	pageCount: 24,
	// A real PDF row carries this, and without it the chip deliberately shows
	// no count at all: a count whose unit is unknown is not a page count.
	pageCountKind: "physical",
	outline: [
		{
			level: 2,
			title: "2.3 Break clause",
			offset: 0,
			preview: "Either party may terminate on six months' written notice",
		},
	],
};

const IMAGE_ARTIFACT: UploadArtifact = {
	id: "artifact-floorplan",
	name: "floor-plan-level-2.png",
	mimeType: "image/png",
	sizeBytes: 1_204_889,
};

async function setAdminConfig(page: Page, values: Record<string, string>) {
	const response = await page.evaluate(async (payload) => {
		const result = await fetch("/api/admin/config", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
		return { ok: result.ok, status: result.status };
	}, values);
	expect(response.ok, `admin config PUT -> ${response.status}`).toBe(true);
}

async function mockChipRoutes(page: Page) {
	const uploadQueue: UploadArtifact[] = [];

	await page.route("**/api/skills/discovery**", async (route) => {
		await route.fulfill({
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				skills: [
					{
						id: "skill-invoice-reply",
						ownership: "user",
						displayName: "Invoice reply",
						description: "Draft a reply to an overdue invoice.",
						activationExamples: ["reply to this invoice"],
						enabled: true,
						durationPolicy: "session",
						questionPolicy: "ask_when_needed",
						notesPolicy: "none",
						sourceScope: "selected_sources_only",
						creationSource: "user_created",
						version: 1,
						createdAt: 1,
						updatedAt: 1,
					},
				],
			}),
		});
	});

	await page.route("**/api/knowledge/upload/intent", async (route) => {
		await route.fulfill({
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				traceId: `trace-${Date.now()}`,
				rawUploadLimit: 50_000_000,
				requestBodyLimit: 50_000_000,
				chunkBodyLimit: 4_000_000,
			}),
		});
	});

	await page.route("**/api/knowledge/upload/raw", async (route) => {
		const artifact = uploadQueue.shift() ?? IMAGE_ARTIFACT;
		await route.fulfill({
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				artifact: {
					id: artifact.id,
					type: "source_document",
					retrievalClass: "durable",
					name: artifact.name,
					mimeType: artifact.mimeType,
					sizeBytes: artifact.sizeBytes,
					conversationId: null,
					summary: artifact.name,
					createdAt: Date.now(),
					updatedAt: Date.now(),
					...(artifact.tokenEstimate
						? { tokenEstimate: artifact.tokenEstimate }
						: {}),
					...(artifact.pageCount ? { pageCount: artifact.pageCount } : {}),
					...(artifact.pageCountKind
						? { pageCountKind: artifact.pageCountKind }
						: {}),
					...(artifact.outline ? { outline: artifact.outline } : {}),
				},
				promptReady: true,
				promptArtifactId: `prompt-${artifact.id}`,
				readinessError: null,
			}),
		});
	});

	// The image chip's crop comes from the existing authenticated preview
	// endpoint; serve it so the <img> resolves rather than falling back.
	await page.route("**/api/knowledge/*/preview", async (route) => {
		await route.fulfill({
			status: 200,
			headers: { "Content-Type": "image/png" },
			body: PNG_1X1,
		});
	});

	return {
		queueUpload(artifact: UploadArtifact) {
			uploadQueue.push(artifact);
		},
	};
}

async function bootstrap(
	page: Page,
	options: { shortMessageCap?: boolean } = {},
) {
	await login(page);
	await setAdminConfig(page, {
		COMPOSER_COMMAND_REGISTRY_ENABLED: "true",
		ATLAS_WORKER_ENABLED: "true",
		PARALLEL_API_KEY: "fake-composer-chips-key",
		MAX_MESSAGE_LENGTH: options.shortMessageCap
			? SHORT_MESSAGE_CAP
			: DEFAULT_MESSAGE_CAP,
	});
	const routes = await mockChipRoutes(page);
	const conversationId = await page.evaluate(async () => {
		const result = await fetch("/api/conversations", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Composer chips" }),
		});
		if (!result.ok) throw new Error(`create conversation ${result.status}`);
		return ((await result.json()) as { id: string }).id;
	});
	await page.goto(`/chat/${conversationId}`, { waitUntil: "domcontentloaded" });
	await expect(page.getByTestId("message-input")).toBeVisible({
		timeout: 20000,
	});
	return routes;
}

function chipRow(page: Page) {
	return page.getByRole("list", { name: "Attached to this message" });
}

async function typeCommand(page: Page, command: string) {
	const input = page.getByTestId("message-input");
	await input.fill("");
	await input.click();
	await input.pressSequentially(command);
}

async function addSkillChip(page: Page) {
	await typeCommand(page, "$invoice");
	await page.getByRole("option", { name: /Invoice reply/i }).click();
	await expect(page.getByTestId("composer-chip-skill")).toBeVisible();
	await page.getByTestId("message-input").fill("");
}

async function addWebChip(page: Page) {
	await typeCommand(page, "/web");
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("composer-chip-web")).toBeVisible();
	await page.getByTestId("message-input").fill("");
}

async function pickAtlasProfile(page: Page, label: RegExp) {
	await page.getByTestId("composer-tools-trigger").click();
	await expect(page.getByTestId("composer-tools-menu")).toBeVisible();
	await page.getByTestId("composer-menu-atlas").click();
	await page
		.getByRole("option", { name: label })
		.first()
		.click({ force: true });
	await page.keyboard.press("Escape");
}

async function attach(
	page: Page,
	queue: (artifact: UploadArtifact) => void,
	artifact: UploadArtifact,
	bytes: Buffer,
) {
	queue(artifact);
	// The composer renders server-side with its file input disabled until
	// hydration flips `isHydrated`; setInputFiles does not wait for that, and a
	// disabled input never fires `change`. Wait for it to be usable first.
	const fileInput = page.locator('input[type="file"]');
	await expect(fileInput).toBeEnabled({ timeout: 20000 });
	await fileInput.setInputFiles({
		name: artifact.name,
		mimeType: artifact.mimeType,
		buffer: bytes,
	});
	await expect(
		page.getByText(artifact.name, { exact: true }).first(),
	).toBeVisible({ timeout: 20000 });
}

test.describe("composer chips — one pill, one row", () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize(DESKTOP);
	});

	test("a skill is one accent pill with exactly one control", async ({
		page,
	}) => {
		await bootstrap(page);
		await addSkillChip(page);

		const chip = page.getByTestId("composer-chip-skill");
		await expect(chip).toHaveAttribute("data-chip-kind", "skill");
		await expect(chip).toHaveAttribute("data-chip-tint", "accent");
		await expect(chip).toContainText("Invoice reply");
		// Kind is the sparkle, not a "USER SKILL" shout.
		await expect(chip).not.toContainText("USER SKILL");
		// One control, and it is the ×.
		await expect(chip.locator("button")).toHaveCount(1);
		await expect(
			chip.getByRole("button", {
				name: "Remove pending skill Invoice reply",
			}),
		).toBeVisible();

		// 999px radius and 28px tall, as the board specifies.
		const box = await chip.boundingBox();
		expect(box?.height).toBeCloseTo(28, 0);
		const radius = await chip.evaluate(
			(element) => getComputedStyle(element).borderTopLeftRadius,
		);
		expect(Number.parseFloat(radius)).toBeGreaterThanOrEqual(14);
	});

	test("/web is a NEUTRAL pill — it is material now, not behaviour", async ({
		page,
	}) => {
		await bootstrap(page);
		await addWebChip(page);

		const chip = page.getByTestId("composer-chip-web");
		await expect(chip).toHaveAttribute("data-chip-kind", "web");
		// The owner's amendment to the board: only /web sets this now, so it
		// gets no tint.
		await expect(chip).toHaveAttribute("data-chip-tint", "neutral");
		await expect(chip).toContainText("Web search");
	});

	test("Atlas carries its profile in the meta and its bell BESIDE the pill", async ({
		page,
	}) => {
		await bootstrap(page);
		await pickAtlasProfile(page, /In-Depth/i);

		const chip = page.getByTestId("composer-chip-atlas");
		await expect(chip).toHaveAttribute("data-chip-tint", "warning");
		await expect(chip).toContainText("Atlas");
		// The profile is a muted clause after a middle dot, not a shouted label.
		await expect(chip.getByTestId("composer-chip-meta")).toContainText(
			"In-Depth",
		);
		await expect(chip).not.toContainText("ATLAS:");

		// The notify bell used to be a second button INSIDE the chip, drawn
		// identically to the × beside it. It is now a disclosure outside the
		// pill, so the chip has exactly one control.
		await expect(chip.locator("button")).toHaveCount(1);
		await expect(page.getByTestId("composer-chip-atlas-notify")).toBeVisible();
		const bell = page.getByTestId("composer-chip-atlas-notify");
		await expect(
			chip.locator('[data-testid="composer-chip-atlas-notify"]'),
		).toHaveCount(0);
		expect(await bell.getAttribute("aria-label")).toContain("notification");
	});

	// Owner decision (1): the server already ignores web search on an Atlas
	// turn, so the composer stops promising it rather than drawing a chip that
	// means nothing.
	test("the web chip steps aside when an Atlas profile is selected", async ({
		page,
	}) => {
		await bootstrap(page);
		await addWebChip(page);
		await expect(page.getByTestId("composer-chip-web")).toBeVisible();

		await pickAtlasProfile(page, /Overview/i);
		await expect(page.getByTestId("composer-chip-atlas")).toBeVisible();
		await expect(page.getByTestId("composer-chip-web")).toHaveCount(0);

		// ...and comes back when Atlas is removed, since the setting was never
		// thrown away.
		await page.getByRole("button", { name: "Remove Atlas" }).click();
		await expect(page.getByTestId("composer-chip-web")).toBeVisible();
	});

	test("an attachment shows its cost in muted meta; an image shows itself", async ({
		page,
	}) => {
		const routes = await bootstrap(page);
		await attach(
			page,
			routes.queueUpload,
			PDF_ARTIFACT,
			Buffer.from("%PDF-1.4"),
		);

		const pdf = page.getByTestId("composer-chip-attachment").first();
		await expect(pdf).toHaveAttribute("data-chip-kind", "file");
		await expect(pdf).toContainText("Lease agreement 2026.pdf");
		await expect(pdf.getByTestId("composer-chip-meta")).toContainText(
			"24 pp · 18k tok",
		);

		await attach(page, routes.queueUpload, IMAGE_ARTIFACT, PNG_1X1);
		const image = page
			.getByTestId("composer-chip-attachment")
			.filter({ hasText: "floor-plan-level-2.png" });
		await expect(image).toHaveAttribute("data-chip-kind", "image");
		// The leading mark is a crop of the real file, not a generic glyph.
		const thumb = image.locator("img.composer-chip__thumb");
		await expect(thumb).toBeVisible();
		expect(await thumb.getAttribute("src")).toContain(
			"/api/knowledge/artifact-floorplan/preview",
		);
	});

	test("five chips share ONE wrapping row, and the send button stays reachable", async ({
		page,
	}) => {
		const routes = await bootstrap(page);
		await addSkillChip(page);
		await addWebChip(page);
		await attach(
			page,
			routes.queueUpload,
			PDF_ARTIFACT,
			Buffer.from("%PDF-1.4"),
		);
		await attach(page, routes.queueUpload, IMAGE_ARTIFACT, PNG_1X1);

		// The whole point of the redesign: one list, not one per feature.
		await expect(chipRow(page)).toHaveCount(1);
		await expect(page.locator(".composer-chip-row")).toHaveCount(1);
		await expect(page.locator(".composer-chip")).toHaveCount(4);

		// Behaviour leads, material follows — a stable reading order, so the
		// same chip does not move when another is removed.
		const kinds = await page
			.locator(".composer-chip")
			.evaluateAll((nodes) =>
				nodes.map((node) => (node as HTMLElement).dataset.chipKind),
			);
		expect(kinds).toEqual(["skill", "web", "file", "image"]);

		await expect(page.getByTestId("send-button")).toBeVisible();
		const sendBox = await page.getByTestId("send-button").boundingBox();
		const viewport = page.viewportSize();
		expect(sendBox).not.toBeNull();
		expect((sendBox?.y ?? 0) + (sendBox?.height ?? 0)).toBeLessThanOrEqual(
			viewport?.height ?? 0,
		);
	});

	test("a picked outline section becomes a quote chip and expands on send", async ({
		page,
	}) => {
		const routes = await bootstrap(page);
		await attach(
			page,
			routes.queueUpload,
			PDF_ARTIFACT,
			Buffer.from("%PDF-1.4"),
		);

		// The outline is a disclosure beside the chip, not a panel under it.
		const disclosure = page.getByTestId("attachment-outline-disclosure");
		await expect(disclosure).toBeVisible();
		await expect(page.locator(".attachment-outline-row")).toHaveCount(0);

		await disclosure.click();
		await page
			.locator(".attachment-outline-row")
			.filter({ hasText: "2.3 Break clause" })
			.click();

		const quote = page.getByTestId("composer-chip-quote");
		await expect(quote).toBeVisible();
		await expect(quote).toHaveAttribute("data-chip-kind", "quote");
		await expect(quote).toContainText("2.3 Break clause");
		// The sentence the user is writing stays theirs — no pasted prose.
		await expect(page.getByTestId("message-input")).toHaveValue("");

		await page
			.getByTestId("message-input")
			.fill("Can we get out of this early?");
		await page.getByTestId("send-button").click();

		// Sending expands it into the message, exactly as the old paste did.
		const userMessage = page.getByTestId("user-message").first();
		await expect(userMessage).toBeVisible({ timeout: 20000 });
		await expect(userMessage).toContainText("Can we get out of this early?");
		// ...and the bubble draws it back as a chip rather than as prose.
		await expect(
			userMessage.getByTestId("user-bubble-quote-chip"),
		).toContainText("2.3 Break clause");
		await expect(userMessage).not.toContainText(
			"Either party may terminate on six months' written notice",
		);
	});

	test("the over-length counter sits inside the chip row", async ({ page }) => {
		await bootstrap(page, { shortMessageCap: true });
		await addSkillChip(page);

		await page
			.getByTestId("message-input")
			.fill("Please review the break clause before Friday. ".repeat(12));

		const counter = page.getByTestId("over-length-counter");
		await expect(counter).toBeVisible();
		// It moved off the page margin — where it sat outside the composer's
		// border, next to nothing — into the row the eye is already on.
		await expect(
			page.locator(".composer-chip-rail").getByTestId("over-length-counter"),
		).toBeVisible();

		const counterBox = await counter.boundingBox();
		const chipBox = await page.getByTestId("composer-chip-skill").boundingBox();
		expect(counterBox).not.toBeNull();
		expect(chipBox).not.toBeNull();
		// Same band, right-aligned against the chip.
		expect(
			Math.abs((counterBox?.y ?? 0) - (chipBox?.y ?? 0)),
		).toBeLessThanOrEqual(24);
		expect(counterBox?.x ?? 0).toBeGreaterThan(chipBox?.x ?? 0);

		await setAdminConfig(page, { MAX_MESSAGE_LENGTH: DEFAULT_MESSAGE_CAP });
	});

	test("a chip is removable by its × and by Delete from its focus stop", async ({
		page,
	}) => {
		await bootstrap(page);
		await addSkillChip(page);
		await addWebChip(page);

		await page.getByRole("button", { name: "Remove Web search" }).click();
		await expect(page.getByTestId("composer-chip-web")).toHaveCount(0);
		// Removing one chip does not disturb the other.
		await expect(page.getByTestId("composer-chip-skill")).toBeVisible();

		await page
			.getByRole("button", { name: "Remove pending skill Invoice reply" })
			.focus();
		await page.keyboard.press("Delete");
		await expect(page.getByTestId("composer-chip-skill")).toHaveCount(0);
		// With nothing attached, the row is gone entirely.
		await expect(page.locator(".composer-chip-row")).toHaveCount(0);
	});
});

test.describe("composer chips on a phone", () => {
	// A phone is a coarse pointer, not a narrow desktop: the 44px hit area is
	// gated on `@media (pointer: fine)` collapsing it to 20px, so the context
	// has to report touch for the assertion to mean anything.
	test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

	test("the row scrolls sideways, one line high, with 44px hit areas", async ({
		page,
	}) => {
		const routes = await bootstrap(page);
		await addSkillChip(page);
		await addWebChip(page);
		await attach(
			page,
			routes.queueUpload,
			PDF_ARTIFACT,
			Buffer.from("%PDF-1.4"),
		);

		const row = page.locator(".composer-chip-row");
		await expect(row).toHaveCount(1);
		await expect(row).toHaveClass(/composer-chip-row--scroll/);

		// One line high: every chip shares the first chip's top edge.
		const tops = await page
			.locator(".composer-chip")
			.evaluateAll((nodes) =>
				nodes.map((node) => Math.round(node.getBoundingClientRect().top)),
			);
		expect(new Set(tops).size).toBe(1);

		// Sideways means the chips keep their width and the OVERFLOW scrolls —
		// not that every label is squeezed to a letter and an ellipsis so the
		// row fits. The rail is wider than its box, the first chip's label is
		// still whole, and the `+N` disclosure counts what sits past the fade.
		const overflow = await row.evaluate((element) => ({
			scrollWidth: element.scrollWidth,
			clientWidth: element.clientWidth,
		}));
		expect(overflow.scrollWidth).toBeGreaterThan(overflow.clientWidth);
		const skillLabel = page
			.getByTestId("composer-chip-skill")
			.locator(".composer-chip__label");
		await expect(skillLabel).toHaveText("Invoice reply");
		const labelFit = await skillLabel.evaluate((element) => ({
			scrollWidth: element.scrollWidth,
			clientWidth: element.clientWidth,
		}));
		expect(labelFit.scrollWidth).toBeLessThanOrEqual(labelFit.clientWidth + 1);
		const more = page.getByTestId("composer-chip-row-more");
		await expect(more).toBeVisible();
		await expect(more).toHaveText(/^\+[1-9]\d*$/);

		// The remove control keeps a 44px target without growing the pill.
		const remove = page.getByRole("button", {
			name: "Remove pending skill Invoice reply",
		});
		const drawn = await remove.boundingBox();
		expect(drawn?.height).toBeLessThanOrEqual(22);
		const target = await remove.evaluate((element) => {
			const after = getComputedStyle(element, "::after");
			return {
				width: Number.parseFloat(after.width),
				height: Number.parseFloat(after.height),
			};
		});
		expect(target.width).toBeGreaterThanOrEqual(44);
		expect(target.height).toBeGreaterThanOrEqual(44);

		// The composer stays short: chips cost one row, not one row each.
		const composerBox = await page
			.locator(".message-composer")
			.first()
			.boundingBox();
		expect(composerBox?.height ?? 0).toBeLessThan(220);

		// Scrolled to the end, nothing is hidden any more: the fade and the
		// `+N` lift, and the last chip's × is under the thumb rather than under
		// the counter. (The last chip's right edge sits inside the fade's band
		// whenever the rail is at its end, so a count that only measured edges
		// would say "+1" forever and park the counter on top of that ×.)
		await row.evaluate((element) => {
			element.scrollLeft = element.scrollWidth;
		});
		await expect(more).toBeHidden();
		const lastRemove = page.getByRole("button", {
			name: `Remove ${PDF_ARTIFACT.name}`,
		});
		await expect(lastRemove).toBeVisible();
		const railBox = await row.boundingBox();
		const lastRemoveBox = await lastRemove.boundingBox();
		expect(
			(lastRemoveBox?.x ?? 0) + (lastRemoveBox?.width ?? 0),
		).toBeLessThanOrEqual((railBox?.x ?? 0) + (railBox?.width ?? 0) + 1);

		// The outline disclosure beside the attachment opens a popover that is
		// actually SEEN: the rail clips its own overflow, so the popover is
		// anchored to the viewport instead and sits above the rail.
		const disclosure = page.getByTestId("attachment-outline-disclosure");
		await disclosure.click();
		const popover = page.getByTestId("attachment-outline-popover");
		await expect(popover).toBeVisible();
		const popoverBox = await popover.boundingBox();
		const disclosureBox = await disclosure.boundingBox();
		expect(popoverBox?.width ?? 0).toBeGreaterThan(100);
		expect(popoverBox?.height ?? 0).toBeGreaterThan(30);
		expect(
			(popoverBox?.y ?? 0) + (popoverBox?.height ?? 0),
		).toBeLessThanOrEqual(disclosureBox?.y ?? 0);
		expect(popoverBox?.x ?? 0).toBeGreaterThanOrEqual(0);
		expect((popoverBox?.x ?? 0) + (popoverBox?.width ?? 0)).toBeLessThanOrEqual(
			PHONE.width,
		);
		// ...and Escape closes it, handing focus back to its button.
		await page.keyboard.press("Escape");
		await expect(popover).toBeHidden();
		await expect(
			page.getByTestId("attachment-outline-disclosure"),
		).toBeFocused();
	});
});
