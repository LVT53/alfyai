// Ruling 76: the versioning routes against a real database and two real users,
// not mocks — what each one answers, what it refuses, and that an id that is
// missing, someone else's, or an incognito chat's own read from outside is
// the same 404. (The old-App route, the security-sensitive one, has its own
// file beside it: `[id]/versions/[versionId]/app/version-app.test.ts`.)
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";
import {
	seedConversation,
	seedProducedFile,
	seedUser,
} from "$lib/server/services/artifacts/artifacts.test-helpers";

let memory: InMemoryDatabase;

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

const { createArtifact, listVersions, updateArtifactBody } = await import(
	"$lib/server/services/artifacts"
);
const { GET: getHistory } = await import("./[id]/history/+server");
const { PATCH: patchVersion } = await import(
	"./[id]/versions/[versionId]/+server"
);
const { POST: restore } = await import(
	"./[id]/versions/[versionId]/restore/+server"
);

const OWNER = "user-owner";
const STRANGER = "user-stranger";
const CONVERSATION = "conv-owner";
const OTHER = "conv-owner-other";
const INCOGNITO = "conv-incognito";

type Who = { userId?: string | null; conversationId?: string | null };

function event(
	path: string,
	params: Record<string, string>,
	who: Who = {},
	extra: { search?: string; body?: unknown; method?: string } = {},
) {
	const userId = who.userId === undefined ? OWNER : who.userId;
	const query = new URLSearchParams(extra.search ?? "");
	if (who.conversationId) query.set("conversationId", who.conversationId);
	const queryString = query.toString();
	return {
		params,
		url: new URL(
			`http://localhost/api/artifacts/${path}${queryString ? `?${queryString}` : ""}`,
		),
		locals: { user: userId ? { id: userId, role: "user" } : undefined },
		request: {
			json: async () => {
				if (extra.body === undefined) throw new Error("no body");
				return extra.body;
			},
		},
	} as never;
}

const doc = (...blocks: Array<[string, string]>) =>
	blocks.map(([id, text]) => `<!--b:${id}-->\n${text}`).join("\n\n");

async function makeArtifact(
	kind: "document" | "app",
	body: string,
	conversationId = CONVERSATION,
) {
	const created = await createArtifact({
		userId: OWNER,
		conversationId,
		kind,
		title: "Item",
		body,
		author: "alfy",
		versionSummary:
			kind === "app"
				? "Alfy made the app: a tip calculator"
				: "Alfy wrote the first draft",
	});
	if (!created.ok) throw new Error(created.reason);
	return created.artifact.id;
}

async function write(
	artifactId: string,
	body: string,
	author: "user" | "alfy" = "user",
	summary = "Edited",
	conversationId?: string,
) {
	const result = await updateArtifactBody({
		userId: OWNER,
		artifactId,
		body,
		author,
		summary,
		conversationId,
	});
	if (!result.ok) throw new Error(result.reason);
}

async function versionIds(artifactId: string, conversationId?: string) {
	const versions = await listVersions({
		userId: OWNER,
		artifactId,
		conversationId,
	});
	return new Map(versions.map((v) => [v.versionNumber, v.id]));
}

beforeEach(() => {
	memory = createInMemoryDatabase();
	seedUser(memory, OWNER);
	seedUser(memory, STRANGER);
	seedConversation(memory, { id: CONVERSATION, userId: OWNER });
	seedConversation(memory, { id: OTHER, userId: OWNER });
	seedConversation(memory, {
		id: INCOGNITO,
		userId: OWNER,
		memoryIncognito: true,
	});
});

const NOT_FOUND = { ok: false, reason: "not_found" };

describe("GET /api/artifacts/[id]/history", () => {
	it("answers the moments, newest first, in the ruling-49 envelope", async () => {
		const id = await makeArtifact("document", doc(["p1", "Saturday"]));
		await write(id, doc(["p1", "Saturday!"]));

		const response = await getHistory(event(`${id}/history`, { id }));

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({
			ok: true,
			artifactKind: "document",
			older: false,
			nextBefore: null,
			newestVersion: 2,
		});
		expect(body.moments.map((m: { kind: string }) => m.kind)).toEqual([
			"user_edit",
			"first_draft",
		]);
	});

	it("pages with before and limit", async () => {
		const id = await makeArtifact("document", doc(["p1", "v1"]));
		for (let i = 2; i <= 9; i += 1)
			await write(
				id,
				doc(["p1", `v${i}`]),
				i % 2 ? "alfy" : "user",
				i % 2 ? `Alfy ${i}` : "Edited",
			);

		const first = await (
			await getHistory(
				event(`${id}/history`, { id }, {}, { search: "limit=3" }),
			)
		).json();
		expect(
			first.moments.map((m: { versionNumber: number }) => m.versionNumber),
		).toEqual([9, 8, 7]);
		expect(first).toMatchObject({ older: true, nextBefore: 7 });
		const second = await (
			await getHistory(
				event(`${id}/history`, { id }, {}, { search: "limit=3&before=7" }),
			)
		).json();
		expect(
			second.moments.map((m: { versionNumber: number }) => m.versionNumber),
		).toEqual([6, 5, 4]);
	});

	it("rejects a malformed before or limit before looking anything up", async () => {
		for (const search of [
			"before=abc",
			"before=0",
			"before=-2",
			"before=1.5",
			"limit=0",
			"limit=x",
		]) {
			const response = await getHistory(
				event("missing/history", { id: "missing" }, {}, { search }),
			);
			expect(response.status, search).toBe(400);
			expect(await response.json()).toEqual({
				ok: false,
				reason: "invalid_request",
			});
		}
	});

	it("is the same 404 for a missing id, another user's, a produced file, and an incognito item read from outside", async () => {
		const mine = await makeArtifact("document", doc(["p1", "mine"]));
		const secret = await makeArtifact(
			"document",
			doc(["p1", "secret"]),
			INCOGNITO,
		);
		seedProducedFile(memory, {
			userId: OWNER,
			conversationId: CONVERSATION,
			artifactId: "produced-1",
			filename: "plan.pdf",
		});

		const responses = await Promise.all([
			getHistory(event("nope/history", { id: "nope" })),
			getHistory(event(`${mine}/history`, { id: mine }, { userId: STRANGER })),
			getHistory(event("produced-1/history", { id: "produced-1" })),
			getHistory(event(`${secret}/history`, { id: secret })),
			getHistory(
				event(`${secret}/history`, { id: secret }, { conversationId: OTHER }),
			),
			getHistory(
				event(
					`${secret}/history`,
					{ id: secret },
					{ userId: STRANGER, conversationId: INCOGNITO },
				),
			),
		]);
		for (const response of responses) {
			expect(response.status).toBe(404);
			expect(await response.json()).toEqual(NOT_FOUND);
		}
		// Its own conversation reads it.
		const own = await getHistory(
			event(`${secret}/history`, { id: secret }, { conversationId: INCOGNITO }),
		);
		expect(own.status).toBe(200);
	});

	it("answers 401 without a signed-in user", async () => {
		await expect(
			getHistory(event("x/history", { id: "x" }, { userId: null })),
		).rejects.toMatchObject({ status: 401 });
	});
});

describe("PATCH /api/artifacts/[id]/versions/[versionId] — naming", () => {
	it("names a version and removes the name, minting no version", async () => {
		const id = await makeArtifact("document", doc(["p1", "Saturday"]));
		await write(id, doc(["p1", "Saturday!"]));
		const ids = await versionIds(id);
		const target = { id, versionId: ids.get(1) as string };
		const call = (label: unknown, who: Who = {}) =>
			patchVersion(
				event(`${id}/versions/${target.versionId}`, target, who, {
					body: { label },
				}),
			);

		const named = await call("  Before the client call ");
		expect(named.status).toBe(200);
		expect(await named.json()).toEqual({
			ok: true,
			label: "Before the client call",
		});
		const history = await (
			await getHistory(event(`${id}/history`, { id }))
		).json();
		expect(
			history.moments.find(
				(m: { versionNumber: number }) => m.versionNumber === 1,
			).label,
		).toBe("Before the client call");
		expect(history.newestVersion).toBe(2);

		expect(await (await call(null)).json()).toEqual({ ok: true, label: null });
		expect(
			memory.db
				.select({ label: schema.artifactVersions.label })
				.from(schema.artifactVersions)
				.where(eq(schema.artifactVersions.id, target.versionId))
				.get()?.label,
		).toBeNull();
	});

	it("refuses a body that is not a name with 400, and a foreign or missing version with the same 404", async () => {
		const id = await makeArtifact("document", doc(["p1", "Saturday"]));
		const ids = await versionIds(id);
		const versionId = ids.get(1) as string;
		const patch = (who: Who, body: unknown, vid = versionId, aid = id) =>
			patchVersion(
				event(`${aid}/versions/${vid}`, { id: aid, versionId: vid }, who, {
					body,
				}),
			);

		for (const body of [
			{},
			{ label: 5 },
			{ label: "x".repeat(61) },
			null,
			"label",
		]) {
			const response = await patch({}, body);
			expect(response.status).toBe(400);
			expect((await response.json()).ok).toBe(false);
		}
		for (const response of [
			await patch({ userId: STRANGER }, { label: "x" }),
			await patch({}, { label: "x" }, "missing"),
			await patch({}, { label: "x" }, versionId, "missing"),
		]) {
			expect(response.status).toBe(404);
			expect(await response.json()).toEqual(NOT_FOUND);
		}
		// Even an invalid name from a stranger is just a 404.
		const stranger = await patch({ userId: STRANGER }, { label: 5 });
		expect(stranger.status).toBe(404);
	});

	it("names an incognito item's version only from its own conversation", async () => {
		const id = await makeArtifact("document", doc(["p1", "secret"]), INCOGNITO);
		const ids = await versionIds(id, INCOGNITO);
		const versionId = ids.get(1) as string;
		const patch = (who: Who) =>
			patchVersion(
				event(`${id}/versions/${versionId}`, { id, versionId }, who, {
					body: { label: "x" },
				}),
			);
		expect((await patch({})).status).toBe(404);
		expect((await patch({ conversationId: OTHER })).status).toBe(404);
		expect((await patch({ conversationId: INCOGNITO })).status).toBe(200);
	});
});

describe("POST /api/artifacts/[id]/versions/[versionId]/restore — the guard", () => {
	async function twoVersions() {
		const id = await makeArtifact("document", doc(["p1", "one"]));
		await write(id, doc(["p1", "two"]));
		return { id, ids: await versionIds(id) };
	}
	const post = (id: string, versionId: string, body?: unknown, who: Who = {}) =>
		restore(
			event(`${id}/versions/${versionId}/restore`, { id, versionId }, who, {
				body,
			}),
		);

	it("restores with no body at all, as it always did, answering the new version's number and id", async () => {
		const { id, ids } = await twoVersions();
		const response = await post(id, ids.get(1) as string);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			ok: true,
			version: 3,
			versionId: expect.any(String),
		});
	});

	it("answers 409 version_conflict when something was written after the History page, and writes nothing", async () => {
		const { id, ids } = await twoVersions();
		await write(id, doc(["p1", "three"]), "alfy", "Alfy changed it");

		const stale = await post(id, ids.get(1) as string, { expectVersion: 2 });
		expect(stale.status).toBe(409);
		expect(await stale.json()).toEqual({
			ok: false,
			reason: "version_conflict",
		});
		expect((await versionIds(id)).size).toBe(3);

		const fresh = await post(id, ids.get(1) as string, { expectVersion: 3 });
		expect(fresh.status).toBe(200);
	});

	it("takes undoOf for the restore toast's Undo", async () => {
		const { id, ids } = await twoVersions();
		await post(id, ids.get(1) as string, { expectVersion: 2 });
		const undone = await post(id, ids.get(2) as string, {
			expectVersion: 3,
			undoOf: 3,
		});
		expect(undone.status).toBe(200);
		const history = await (
			await getHistory(event(`${id}/history`, { id }))
		).json();
		expect(history.moments[0]).toMatchObject({
			kind: "restore",
			fold: "restore_undone",
			quiet: true,
		});
	});

	it("refuses a bad undoOf with 400 and a malformed field with 400", async () => {
		const { id, ids } = await twoVersions();
		const bad = await post(id, ids.get(1) as string, { undoOf: 2 });
		expect(bad.status).toBe(400);
		expect(await bad.json()).toEqual({ ok: false, reason: "invalid_undo" });
		for (const body of [
			{ expectVersion: "2" },
			{ undoOf: 0 },
			{ expectVersion: 1.5 },
			{ undoOf: -1 },
		]) {
			const response = await post(id, ids.get(1) as string, body);
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({
				ok: false,
				reason: "invalid_request",
			});
		}
		expect((await versionIds(id)).size).toBe(2);
	});

	it("is the same 404 for another user's artifact and an incognito item read from outside", async () => {
		const { id, ids } = await twoVersions();
		const secret = await makeArtifact(
			"document",
			doc(["p1", "secret"]),
			INCOGNITO,
		);
		const secretIds = await versionIds(secret, INCOGNITO);
		for (const response of [
			await post(
				id,
				ids.get(1) as string,
				{ expectVersion: 2 },
				{ userId: STRANGER },
			),
			await post(secret, secretIds.get(1) as string),
			await post(secret, secretIds.get(1) as string, undefined, {
				conversationId: OTHER,
			}),
		]) {
			expect(response.status).toBe(404);
			expect(await response.json()).toEqual(NOT_FOUND);
		}
		expect(
			(
				await post(secret, secretIds.get(1) as string, undefined, {
					conversationId: INCOGNITO,
				})
			).status,
		).toBe(200);
	});
});
