// GET /api/artifact-tours/[type] and POST /api/artifact-tours/[type]/seen
// against a real in-memory database and real users — no mocks past the
// database. The routes are thin; what they must get right is who may call them
// (a session, 401 at the HTTP layer, ruling 39), which kinds exist (the shipped
// list, ruling 69: a 404 for anything else, Slides and File included), the
// family's answer shapes (ruling 49), and that the user is only ever the
// session's (never a query parameter or a body field).
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ARTIFACT_TOUR_CONTENT_VERSION } from "$lib/server/artifact-tour-defaults";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";
import { seedUser } from "$lib/server/services/artifacts/artifacts.test-helpers";

let memory: InMemoryDatabase;

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

const { GET } = await import("./+server");
const { POST } = await import("./seen/+server");
const { duplicateCampaignAsDraft, publishCampaign, updateCampaignDraft } =
	await import("$lib/server/services/announcement-campaigns");
const { seedArtifactTourDrafts } = await import(
	"$lib/server/services/artifact-tours"
);

const USER = "user-reader";
const OTHER = "user-other";
const DEFAULT_KEY = `default:${ARTIFACT_TOUR_CONTENT_VERSION}`;

beforeEach(() => {
	memory = createInMemoryDatabase();
	seedUser(memory, USER);
	seedUser(memory, OTHER);
});

function getEvent(params: {
	type: string;
	userId?: string | null;
	search?: string;
}) {
	const userId = params.userId === undefined ? USER : params.userId;
	return {
		params: { type: params.type },
		url: new URL(
			`http://localhost/api/artifact-tours/${params.type}${params.search ?? ""}`,
		),
		locals: { user: userId ? { id: userId, role: "user" } : undefined },
	} as never;
}

function postEvent(params: {
	type: string;
	body?: unknown;
	userId?: string | null;
}) {
	const userId = params.userId === undefined ? USER : params.userId;
	return {
		params: { type: params.type },
		url: new URL(`http://localhost/api/artifact-tours/${params.type}/seen`),
		locals: { user: userId ? { id: userId, role: "user" } : undefined },
		request: {
			json: async () => {
				if (params.body === undefined) throw new SyntaxError("no body");
				return params.body;
			},
		},
	} as never;
}

function stateRows(userId = USER) {
	return memory.db
		.select()
		.from(schema.artifactTourStates)
		.where(eq(schema.artifactTourStates.userId, userId))
		.all();
}

/** An archived `artifact_tour` campaign for a kind: its published words were taken back (ruling 71). */
function insertArchivedTour(kind: string) {
	memory.db
		.insert(schema.announcementCampaigns)
		.values({
			id: `archived-${kind}`,
			type: "artifact_tour",
			status: "archived",
			identityKey: `artifact_tour:${kind}:r1`,
			name: `${kind} tour`,
			campaignVersion: kind,
			revision: 1,
			releaseVersion: kind,
			createdByUserId: USER,
			archivedAt: new Date("2026-01-02T00:00:00Z"),
		})
		.run();
}

describe("GET /api/artifact-tours/[type]", () => {
	it("throws 401 with no authenticated user, before it reads anything (ruling 39)", async () => {
		await expect(
			GET(getEvent({ type: "document", userId: null })),
		).rejects.toMatchObject({ status: 401 });
	});

	it("answers the resolved tour and this user's state, with the family's success marker", async () => {
		const response = await GET(getEvent({ type: "canvas" }));

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({
			ok: true,
			seen: false,
			lastSlide: 0,
			tour: {
				artifactType: "canvas",
				contentKey: DEFAULT_KEY,
				source: "default",
			},
		});
		expect(body.tour.slides).toHaveLength(3);
		expect(body.tour.summary.en).toBeTruthy();
		expect(body.tour.summary.hu).toBeTruthy();
	});

	it("serves each of the three shipped kinds", async () => {
		for (const type of ["document", "app", "canvas"]) {
			const body = await (await GET(getEvent({ type }))).json();
			expect(body.ok).toBe(true);
			expect(body.tour.artifactType).toBe(type);
		}
	});

	it("is a 404 for a kind that is not a tour kind: Slides (shelved), File, and anything else", async () => {
		for (const type of [
			"slides",
			"file",
			"bogus",
			"Document",
			"toString",
			"__proto__",
		]) {
			const response = await GET(getEvent({ type }));
			expect(response.status, type).toBe(404);
			expect(await response.json(), type).toEqual({
				ok: false,
				reason: "unknown_type",
			});
		}
	});

	it("reports what this user has seen, and nothing about anybody else", async () => {
		await POST(
			postEvent({
				type: "document",
				body: { contentKey: DEFAULT_KEY, status: "dismissed", lastSlide: 1 },
			}),
		);

		const mine = await (await GET(getEvent({ type: "document" }))).json();
		expect(mine).toMatchObject({ seen: true, lastSlide: 1 });
		const theirs = await (
			await GET(getEvent({ type: "document", userId: OTHER }))
		).json();
		expect(theirs).toMatchObject({ seen: false, lastSlide: 0 });
	});

	it("answers 200 with the code copy, never a 404 and never no tour, when the kind's published tour was archived", async () => {
		insertArchivedTour("app");

		const response = await GET(getEvent({ type: "app" }));

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({ ok: true, seen: false, lastSlide: 0 });
		expect(body.tour).toMatchObject({
			artifactType: "app",
			source: "default",
			contentKey: DEFAULT_KEY,
		});
		expect(body.tour.slides).toHaveLength(3);
	});

	it("takes the user from the session only, and writes nothing", async () => {
		await POST(
			postEvent({
				type: "document",
				body: { contentKey: DEFAULT_KEY, status: "completed", lastSlide: 2 },
			}),
		);
		const before = stateRows().length;

		// A query string naming another user, a conversation and an artifact
		// changes nothing: the route has no use for any of them.
		const body = await (
			await GET(
				getEvent({
					type: "document",
					userId: OTHER,
					search: `?userId=${USER}&conversationId=conv-1&artifactId=a-1`,
				}),
			)
		).json();

		expect(body.seen).toBe(false);
		expect(stateRows().length).toBe(before);
		expect(stateRows(OTHER)).toEqual([]);
	});
});

describe("POST /api/artifact-tours/[type]/seen", () => {
	const completed = {
		contentKey: DEFAULT_KEY,
		status: "completed",
		lastSlide: 2,
	};

	it("throws 401 with no authenticated user, before it reads the body (ruling 39)", async () => {
		await expect(
			POST(postEvent({ type: "document", userId: null, body: completed })),
		).rejects.toMatchObject({ status: 401 });
		expect(stateRows()).toEqual([]);
	});

	it("is a 404 for a kind that is not a tour kind, and writes nothing", async () => {
		for (const type of ["slides", "file", "bogus", "toString"]) {
			const response = await POST(postEvent({ type, body: completed }));
			expect(response.status, type).toBe(404);
			expect(await response.json(), type).toEqual({
				ok: false,
				reason: "unknown_type",
			});
		}
		expect(stateRows()).toEqual([]);
	});

	it("records a completed tour and answers alreadyRecorded: false", async () => {
		const response = await POST(postEvent({ type: "canvas", body: completed }));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, alreadyRecorded: false });
		const [row] = stateRows();
		expect(row).toMatchObject({
			userId: USER,
			artifactType: "canvas",
			contentKey: DEFAULT_KEY,
			status: "completed",
			slideCount: 3,
			lastSlide: 2,
		});
	});

	it("is idempotent: the same write twice is one row and alreadyRecorded: true", async () => {
		await POST(postEvent({ type: "canvas", body: completed }));

		const response = await POST(postEvent({ type: "canvas", body: completed }));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, alreadyRecorded: true });
		expect(stateRows()).toHaveLength(1);
	});

	it("keeps the slide the user left on when they dismiss", async () => {
		await POST(
			postEvent({
				type: "app",
				body: { contentKey: DEFAULT_KEY, status: "dismissed", lastSlide: 1 },
			}),
		);

		expect(stateRows()[0]).toMatchObject({ status: "dismissed", lastSlide: 1 });
		const after = await (await GET(getEvent({ type: "app" }))).json();
		expect(after).toMatchObject({ seen: true, lastSlide: 1 });
	});

	it("answers 400 invalid_state naming each wrong field, and writes nothing", async () => {
		const cases: Array<[unknown, Record<string, string>]> = [
			[{ ...completed, status: "seen" }, { status: "invalid" }],
			[{ ...completed, lastSlide: 3 }, { lastSlide: "invalid" }],
			[{ ...completed, lastSlide: -1 }, { lastSlide: "invalid" }],
			[{ ...completed, lastSlide: 1.5 }, { lastSlide: "invalid" }],
			[{ ...completed, lastSlide: "1" }, { lastSlide: "invalid" }],
			[{ status: "completed", lastSlide: 0 }, { contentKey: "invalid" }],
			[{ ...completed, contentKey: "" }, { contentKey: "invalid" }],
			[{}, { contentKey: "invalid", status: "invalid", lastSlide: "invalid" }],
			[
				undefined,
				{ contentKey: "invalid", status: "invalid", lastSlide: "invalid" },
			],
		];
		for (const [body, fieldErrors] of cases) {
			const response = await POST(postEvent({ type: "document", body }));
			expect(response.status, JSON.stringify(body)).toBe(400);
			expect(await response.json(), JSON.stringify(body)).toEqual({
				ok: false,
				reason: "invalid_state",
				fieldErrors,
			});
		}
		expect(stateRows()).toEqual([]);
	});

	it("answers 409 content_changed with the current key when the copy moved on, and writes nothing", async () => {
		const response = await POST(
			postEvent({
				type: "document",
				body: { ...completed, contentKey: "snapshot:an-older-publish" },
			}),
		);

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			ok: false,
			reason: "content_changed",
			contentKey: DEFAULT_KEY,
		});
		expect(stateRows()).toEqual([]);
	});

	it("answers 409 with the code copy's key when the published tour was archived under the reader", async () => {
		insertArchivedTour("canvas");

		const response = await POST(
			postEvent({
				type: "canvas",
				body: { ...completed, contentKey: "snapshot:archived-canvas-snapshot" },
			}),
		);

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			ok: false,
			reason: "content_changed",
			contentKey: DEFAULT_KEY,
		});
		expect(stateRows()).toEqual([]);
	});

	it("writes for the session's user only, and never stores a conversation, an artifact or another user", async () => {
		const response = await POST(
			postEvent({
				type: "document",
				userId: USER,
				body: {
					...completed,
					userId: OTHER,
					conversationId: "conv-incognito",
					artifactId: "artifact-1",
				},
			}),
		);

		expect(response.status).toBe(200);
		expect(stateRows(OTHER)).toEqual([]);
		const [row] = stateRows();
		expect(row?.userId).toBe(USER);
		// Every string in the row, and so every place an id could have gone.
		const strings = Object.values(row ?? {}).filter(
			(value): value is string => typeof value === "string",
		);
		expect(strings.join(" ")).not.toMatch(/conv-incognito|artifact-1|other/);
	});
});

// The whole path an admin's words travel: the seeded draft is edited, published,
// and then is what the panel is served; a user who finished the old copy is
// shown the new one once, and a write against the copy it replaced is refused.
describe("a tour an admin published, through both routes", () => {
	const ADMIN = "user-admin";

	beforeEach(() => {
		seedUser(memory, ADMIN);
	});

	const slidesWith = (summary: string, firstSlide: string) => [
		{
			layoutType: "summary",
			sortOrder: 1,
			title: { en: summary, hu: `${summary} (hu)` },
			body: { en: "Second line.", hu: "Második sor." },
		},
		...[firstSlide, "Second slide", "Third slide"].map((title, index) => ({
			layoutType: "standard",
			sortOrder: index + 2,
			title: { en: title, hu: `${title} (hu)` },
			body: { en: `Body ${index + 1}.`, hu: `Törzs ${index + 1}.` },
		})),
	];

	async function seededCanvasDraft(): Promise<string> {
		await seedArtifactTourDrafts(ADMIN);
		const draft = memory.db
			.select()
			.from(schema.announcementCampaigns)
			.where(
				and(
					eq(schema.announcementCampaigns.type, "artifact_tour"),
					eq(schema.announcementCampaigns.releaseVersion, "canvas"),
				),
			)
			.get();
		expect(draft?.status).toBe("draft");
		return draft?.id ?? "";
	}

	async function currentCanvasTour() {
		return (await (await GET(getEvent({ type: "canvas" }))).json()).tour;
	}

	it("serves the published words for that kind only, keyed by the snapshot", async () => {
		const draftId = await seededCanvasDraft();
		// A seeded draft is not published, so what is served is still the code copy.
		expect((await currentCanvasTour()).source).toBe("default");
		await updateCampaignDraft(draftId, {
			slides: slidesWith("An edited empty-board line.", "Edited first slide"),
		});
		await publishCampaign(draftId, ADMIN);

		const canvas = await currentCanvasTour();
		expect(canvas.source).toBe("published");
		expect(canvas.contentKey).toMatch(/^snapshot:/);
		expect(canvas.summary).toEqual({
			en: "An edited empty-board line.",
			hu: "An edited empty-board line. (hu)",
		});
		expect(
			canvas.slides.map((slide: { title: { en: string } }) => slide.title.en),
		).toEqual(["Edited first slide", "Second slide", "Third slide"]);
		// The others keep the words they shipped with.
		for (const type of ["document", "app"]) {
			const other = await (await GET(getEvent({ type }))).json();
			expect(other.tour.source, type).toBe("default");
		}
	});

	it("refuses a write against the copy a publish replaced, and records the new copy", async () => {
		const before = await currentCanvasTour();
		expect(before.contentKey).toBe(DEFAULT_KEY);
		const draftId = await seededCanvasDraft();
		await updateCampaignDraft(draftId, {
			slides: slidesWith("Published summary.", "Published first slide"),
		});
		await publishCampaign(draftId, ADMIN);
		const published = await currentCanvasTour();

		// The user was reading the code copy when the admin published.
		const stale = await POST(
			postEvent({
				type: "canvas",
				body: {
					contentKey: before.contentKey,
					status: "completed",
					lastSlide: 2,
				},
			}),
		);
		expect(stale.status).toBe(409);
		expect(await stale.json()).toEqual({
			ok: false,
			reason: "content_changed",
			contentKey: published.contentKey,
		});
		expect(stateRows()).toEqual([]);

		const fresh = await POST(
			postEvent({
				type: "canvas",
				body: {
					contentKey: published.contentKey,
					status: "completed",
					lastSlide: 2,
				},
			}),
		);
		expect(await fresh.json()).toEqual({ ok: true, alreadyRecorded: false });
		const after = await (await GET(getEvent({ type: "canvas" }))).json();
		expect(after).toMatchObject({ seen: true, lastSlide: 2 });
	});

	it("shows a re-published tour once more, and the same publish never again", async () => {
		const draftId = await seededCanvasDraft();
		await updateCampaignDraft(draftId, {
			slides: slidesWith("First publish.", "First slide"),
		});
		await publishCampaign(draftId, ADMIN);
		const first = await currentCanvasTour();
		await POST(
			postEvent({
				type: "canvas",
				body: {
					contentKey: first.contentKey,
					status: "dismissed",
					lastSlide: 1,
				},
			}),
		);
		// Opened again, any number of times: still seen, still on its slide.
		for (let open = 0; open < 2; open += 1) {
			const again = await (await GET(getEvent({ type: "canvas" }))).json();
			expect(again).toMatchObject({ seen: true, lastSlide: 1 });
		}

		// The admin edits the words and publishes a new revision.
		const revision = await duplicateCampaignAsDraft(draftId, ADMIN);
		await updateCampaignDraft(revision.id, {
			slides: slidesWith("Second publish.", "Reworded first slide"),
		});
		await publishCampaign(revision.id, ADMIN);

		const second = await (await GET(getEvent({ type: "canvas" }))).json();
		expect(second.tour.contentKey).not.toBe(first.contentKey);
		expect(second.tour.summary.en).toBe("Second publish.");
		expect(second).toMatchObject({ seen: false, lastSlide: 0 });
	});
});
