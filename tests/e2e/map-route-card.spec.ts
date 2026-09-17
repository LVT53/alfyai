import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import { conversations, messages, users } from "../../src/lib/server/db/schema";
import { login } from "./helpers";

/**
 * The route map card, end to end in a real browser.
 *
 * This exists because of a failure no unit test could see: MapLibre GL 6.x
 * resolves its worker script from its own chunk URL with a filename built at
 * runtime, which Vite cannot see and therefore never emitted. The browser asked
 * for `maplibre-gl-worker.mjs`, got a 404, and MapLibre swallowed it — raster
 * tiles and the two pin markers still drew, so the card LOOKED fine, but the
 * GeoJSON route line (the only thing that needs the worker) silently never
 * appeared, with nothing in the console.
 *
 * So the assertions here are deliberately about the worker and the drawn line,
 * not about the card being on screen:
 *   - every maplibre worker request must succeed (no 404, no ERR_FAILED),
 *   - the card must report rendered features on its route layer
 *     (`data-map-route-drawn`, set from `queryRenderedFeatures`), which is
 *     impossible without a working worker,
 *   - nothing may be refused by the Content-Security-Policy. Run the server
 *     with CSP_MODE=enforce to check the policy that ships on the boxes;
 *     report-only (the default) logs the same console message, so this catches
 *     a violation either way.
 */

const CONVERSATION_ID = "e2e-map-route-card";
// A 1x1 paper-coloured PNG. The tile proxy reaches out to a public OSM host,
// which has no business being in a test's critical path — MapLibre is happy to
// stretch this across every tile, and the route line reads clearly on it.
const TILE_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGN49ugGAAVSAqHeT0GYAAAAAElFTkSuQmCC",
	"base64",
);

// Cork -> Kinsale, simplified exactly the way the map_route tool persists it.
const MAP_DATA = {
	bounds: { minLat: 51.706, minLng: -8.53, maxLat: 51.897, maxLng: -8.47 },
	markers: [
		{ lat: 51.897, lng: -8.47, label: "Cork", kind: "origin" },
		{ lat: 51.706, lng: -8.53, label: "Kinsale", kind: "destination" },
	],
	polyline: [
		[51.897, -8.47],
		[51.86, -8.48],
		[51.82, -8.495],
		[51.78, -8.5],
		[51.74, -8.52],
		[51.706, -8.53],
	],
	distanceM: 27_000,
	durationS: 2040,
	mode: "drive",
	originLabel: "Cork",
	destinationLabel: "Kinsale",
	attribution: "© OpenStreetMap contributors",
};

/**
 * A conversation whose assistant turn carries a completed `map_route` call.
 * Rows go in directly (the services run a sequence-repair statement
 * better-sqlite3 refuses inside the Playwright runner) — `tool_calls` holds the
 * turn's thinking segments, which is where the map payload lives.
 */
async function seedRouteConversation(): Promise<void> {
	const [admin] = await db
		.select()
		.from(users)
		.where(eq(users.email, "admin@local"))
		.limit(1);
	expect(admin, "the e2e admin must exist").toBeTruthy();

	await db.delete(messages).where(eq(messages.conversationId, CONVERSATION_ID));
	await db.delete(conversations).where(eq(conversations.id, CONVERSATION_ID));

	const now = new Date();
	await db.insert(conversations).values({
		id: CONVERSATION_ID,
		userId: admin.id,
		title: "Cork to Kinsale",
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(messages).values([
		{
			id: `${CONVERSATION_ID}-msg-1`,
			conversationId: CONVERSATION_ID,
			messageSequence: 1,
			role: "user" as const,
			content: "How do I drive from Cork to Kinsale?",
			createdAt: now,
		},
		{
			id: `${CONVERSATION_ID}-msg-2`,
			conversationId: CONVERSATION_ID,
			messageSequence: 2,
			role: "assistant" as const,
			content: "It is about 27 km down the R600 — roughly 34 minutes.",
			toolCalls: JSON.stringify([
				{
					type: "tool_call",
					callId: "call-map-route-1",
					name: "map_route",
					input: { action: "route", from: "Cork", to: "Kinsale" },
					status: "done",
					map: MAP_DATA,
				},
			]),
			createdAt: now,
		},
	]);
}

type Watchers = {
	workerRequests: string[];
	failures: string[];
	cspMessages: string[];
};

/** Everything that would have been silent when the worker asset was missing. */
function watch(page: Page): Watchers {
	const watchers: Watchers = {
		workerRequests: [],
		failures: [],
		cspMessages: [],
	};
	const isWorker = (url: string) => /maplibre[\w.-]*worker/i.test(url);

	page.on("response", (response) => {
		const url = response.url();
		if (!isWorker(url)) return;
		watchers.workerRequests.push(`${response.status()} ${url}`);
		if (response.status() >= 400) {
			watchers.failures.push(`${response.status()} ${url}`);
		}
	});
	page.on("requestfailed", (request) => {
		const url = request.url();
		if (!isWorker(url)) return;
		watchers.failures.push(
			`${request.failure()?.errorText ?? "failed"} ${url}`,
		);
	});
	page.on("console", (message) => {
		const text = message.text();
		if (/content security policy|violates the following/i.test(text)) {
			watchers.cspMessages.push(text);
		}
	});
	return watchers;
}

// Headless Chromium reports no WebGL context unless it is told to rasterize in
// software, and the card answers a missing context by rendering its static SVG
// fallback instead of MapLibre — which would leave this spec passing while
// testing nothing. SwiftShader gives it the real WebGL path. Top-level because
// launchOptions forces its own worker and Playwright rejects it inside a
// describe group.
test.use({
	// Tall enough that the whole 180px card clears the composer, so the
	// screenshot attached below shows the drawn line rather than a slice of it.
	viewport: { width: 1280, height: 1000 },
	launchOptions: {
		args: [
			"--use-gl=angle",
			"--use-angle=swiftshader",
			"--enable-unsafe-swiftshader",
			"--ignore-gpu-blocklist",
		],
	},
});

test.describe("map route card", () => {
	test.beforeEach(async ({ page }) => {
		await page.route("**/api/map-tiles/**", (route) =>
			route.fulfill({ status: 200, contentType: "image/png", body: TILE_PNG }),
		);
		await login(page);
		await seedRouteConversation();
	});

	test("draws the route line from a worker the build actually serves", async ({
		page,
	}, testInfo) => {
		const watchers = watch(page);

		// The first goto after a cold dev server can be aborted while Vite is
		// still transforming the route; the retry is the established shape here.
		await page
			.goto(`/chat/${CONVERSATION_ID}`, { waitUntil: "domcontentloaded" })
			.catch(() =>
				page.goto(`/chat/${CONVERSATION_ID}`, {
					waitUntil: "domcontentloaded",
				}),
			);

		// The route is a "deliverable", so its activity row opens itself and the
		// map body mounts without anyone clicking.
		const canvasHost = page.getByTestId("map-route-canvas");
		await expect(canvasHost).toBeVisible({ timeout: 30_000 });
		await expect(canvasHost.locator("canvas.maplibregl-canvas")).toBeVisible({
			timeout: 30_000,
		});

		// THE assertion: MapLibre reports rendered features on the route layer.
		// With no worker this stays "false" forever while the tiles and the two
		// markers still draw — exactly how the bug hid.
		await expect(canvasHost).toHaveAttribute("data-map-route-drawn", "true", {
			timeout: 30_000,
		});

		expect(
			watchers.failures,
			"maplibre worker requests must all succeed",
		).toEqual([]);
		expect(
			watchers.workerRequests.length,
			"the page must actually load a maplibre worker",
		).toBeGreaterThan(0);
		expect(
			watchers.cspMessages,
			"the Content-Security-Policy must not refuse anything",
		).toEqual([]);

		const card = page.getByTestId("map-route-card");
		await card.scrollIntoViewIfNeeded();
		const shot = testInfo.outputPath("map-route-line.png");
		await card.screenshot({ path: shot });
		await testInfo.attach("map-route-line", {
			path: shot,
			contentType: "image/png",
		});
	});
});
