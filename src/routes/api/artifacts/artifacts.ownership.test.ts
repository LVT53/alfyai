// Real-database coverage for the client review's fix 1: an incognito chat
// must be able to open its own artifact. `GET /api/artifacts/[id]` used to
// call the service with the default (strict) ownership scope, which hides
// every incognito conversation — so the panel listed the row but opening it
// always 404'd. This file proves the fix with two real users in an in-memory
// database, not mocks: naming the artifact's own incognito conversation
// widens the read for its owner, and for nobody and nothing else.
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";
import {
	seedConversation,
	seedUser,
} from "$lib/server/services/artifacts/artifacts.test-helpers";

let memory: InMemoryDatabase;

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

const { createArtifact } = await import("$lib/server/services/artifacts");
const { DELETE: deleteArtifactRoute, GET: getArtifactDetail } = await import(
	"./[id]/+server"
);
const { GET: listConversationArtifacts } = await import("./+server");

const OWNER = "user-owner";
const STRANGER = "user-stranger";
const INCOGNITO = "conv-incognito";
const OWNER_OTHER = "conv-owner-other";

function detailEvent(params: {
	artifactId: string;
	userId: string | null;
	conversationId?: string | null;
}) {
	const query = params.conversationId
		? `?conversationId=${encodeURIComponent(params.conversationId)}`
		: "";
	return {
		params: { id: params.artifactId },
		url: new URL(`http://localhost/api/artifacts/${params.artifactId}${query}`),
		locals: {
			user: params.userId ? { id: params.userId, role: "user" } : undefined,
		},
	} as never;
}

function listEvent(params: { userId: string | null; conversationId: string }) {
	return {
		url: new URL(
			`http://localhost/api/artifacts?conversationId=${encodeURIComponent(params.conversationId)}`,
		),
		locals: {
			user: params.userId ? { id: params.userId, role: "user" } : undefined,
		},
	} as never;
}

function deleteEvent(params: {
	artifactId: string;
	userId: string | null;
	conversationId?: string | null;
}) {
	const query = params.conversationId
		? `?conversationId=${encodeURIComponent(params.conversationId)}`
		: "";
	return {
		params: { id: params.artifactId },
		url: new URL(`http://localhost/api/artifacts/${params.artifactId}${query}`),
		locals: {
			user: params.userId ? { id: params.userId, role: "user" } : undefined,
		},
	} as never;
}

beforeEach(() => {
	memory = createInMemoryDatabase();
	seedUser(memory, OWNER);
	seedUser(memory, STRANGER);
	seedConversation(memory, {
		id: INCOGNITO,
		userId: OWNER,
		memoryIncognito: true,
	});
	seedConversation(memory, { id: OWNER_OTHER, userId: OWNER });
});

async function seedIncognitoDocument() {
	const result = await createArtifact({
		userId: OWNER,
		conversationId: INCOGNITO,
		kind: "document",
		title: "Severance checklist",
		body: "- [ ] Sign the agreement",
	});
	if (!result.ok) throw new Error(result.reason);
	return result.artifact.id;
}

describe("GET /api/artifacts/[id]?conversationId=… — incognito self-open", () => {
	it("lets the incognito chat open its own artifact by naming itself", async () => {
		const artifactId = await seedIncognitoDocument();

		const response = await getArtifactDetail(
			detailEvent({ artifactId, userId: OWNER, conversationId: INCOGNITO }),
		);

		expect(response.status).toBe(200);
		const body = await response.json();
		// Ruling 49: every artifact route answers { ok: true, … } on success.
		expect(body.ok).toBe(true);
		expect(body.artifact.id).toBe(artifactId);
	});

	it("still 404s for another user naming that same incognito chat", async () => {
		const artifactId = await seedIncognitoDocument();

		const response = await getArtifactDetail(
			detailEvent({ artifactId, userId: STRANGER, conversationId: INCOGNITO }),
		);

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ ok: false, reason: "not_found" });
	});

	it("still 404s for the owner naming a DIFFERENT own chat", async () => {
		const artifactId = await seedIncognitoDocument();

		const response = await getArtifactDetail(
			detailEvent({ artifactId, userId: OWNER, conversationId: OWNER_OTHER }),
		);

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ ok: false, reason: "not_found" });
	});

	it("returns byte-identical 404 bodies for a foreign id and a missing id, on both artifact routes", async () => {
		const artifactId = await seedIncognitoDocument();
		const EXPECTED = { ok: false, reason: "not_found" };

		const foreignDetail = await getArtifactDetail(
			detailEvent({ artifactId, userId: STRANGER }),
		);
		const missingDetail = await getArtifactDetail(
			detailEvent({ artifactId: "no-such-artifact", userId: OWNER }),
		);
		const foreignList = await listConversationArtifacts(
			listEvent({ userId: STRANGER, conversationId: INCOGNITO }),
		);
		const missingList = await listConversationArtifacts(
			listEvent({ userId: OWNER, conversationId: "no-such-conversation" }),
		);

		for (const response of [
			foreignDetail,
			missingDetail,
			foreignList,
			missingList,
		]) {
			expect(response.status).toBe(404);
		}
		const bodies = await Promise.all(
			[foreignDetail, missingDetail, foreignList, missingList].map((response) =>
				response.json(),
			),
		);
		for (const body of bodies) {
			expect(body).toEqual(EXPECTED);
			expect(JSON.stringify(body)).toBe(JSON.stringify(EXPECTED));
		}
	});
});

// Delete (polish G2-A): the same scope as the read, so a delete reaches exactly
// the artifacts a read does — and answers a foreign id and a missing id with
// one and the same 404, since anything else would confirm the row exists.
describe("DELETE /api/artifacts/[id]", () => {
	function stored(artifactId: string) {
		return memory.db
			.select({ id: schema.artifacts.id })
			.from(schema.artifacts)
			.where(eq(schema.artifacts.id, artifactId))
			.get();
	}

	async function seedOwnDocument() {
		const result = await createArtifact({
			userId: OWNER,
			conversationId: OWNER_OTHER,
			kind: "document",
			title: "Weekend checklist",
			body: "- [ ] Book the train",
		});
		if (!result.ok) throw new Error(result.reason);
		return result.artifact.id;
	}

	it("throws 401 with no signed-in user (requireApiUser), and deletes nothing", async () => {
		const artifactId = await seedOwnDocument();

		await expect(
			deleteArtifactRoute(deleteEvent({ artifactId, userId: null })),
		).rejects.toMatchObject({ status: 401 });
		expect(stored(artifactId)).toBeDefined();
	});

	it("removes the owner's artifact and answers { ok: true }", async () => {
		const artifactId = await seedOwnDocument();

		const response = await deleteArtifactRoute(
			deleteEvent({ artifactId, userId: OWNER }),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(stored(artifactId)).toBeUndefined();
		// Gone means gone for the read too.
		const read = await getArtifactDetail(
			detailEvent({ artifactId, userId: OWNER }),
		);
		expect(read.status).toBe(404);
	});

	it("answers the same 404 for a second delete, a foreign id and a missing id — and leaves the foreign row alone", async () => {
		const artifactId = await seedOwnDocument();
		const EXPECTED = JSON.stringify({ ok: false, reason: "not_found" });

		const foreign = await deleteArtifactRoute(
			deleteEvent({ artifactId, userId: STRANGER }),
		);
		expect(stored(artifactId)).toBeDefined();
		const missing = await deleteArtifactRoute(
			deleteEvent({ artifactId: "no-such-artifact", userId: OWNER }),
		);
		await deleteArtifactRoute(deleteEvent({ artifactId, userId: OWNER }));
		const again = await deleteArtifactRoute(
			deleteEvent({ artifactId, userId: OWNER }),
		);

		for (const response of [foreign, missing, again]) {
			expect(response.status).toBe(404);
			expect(JSON.stringify(await response.json())).toBe(EXPECTED);
		}
	});

	// The security review's L1: a fork's card can name — and its panel open —
	// the parent's Document (the parent is a normal chat the fork's owner can
	// read), but a delete from a chat's panel acts only on what THAT chat made.
	it("refuses, with its own reason, an item another of the caller's chats made — and leaves it alone", async () => {
		const artifactId = await seedOwnDocument(); // made in OWNER_OTHER
		seedConversation(memory, { id: "conv-fork", userId: OWNER });

		const fromTheFork = await deleteArtifactRoute(
			deleteEvent({ artifactId, userId: OWNER, conversationId: "conv-fork" }),
		);

		expect(fromTheFork.status).toBe(409);
		expect(await fromTheFork.json()).toEqual({
			ok: false,
			reason: "not_made_here",
		});
		expect(stored(artifactId)).toBeDefined();

		// The chat that made it can.
		const fromItsOwnChat = await deleteArtifactRoute(
			deleteEvent({ artifactId, userId: OWNER, conversationId: OWNER_OTHER }),
		);
		expect(fromItsOwnChat.status).toBe(200);
		expect(stored(artifactId)).toBeUndefined();
	});

	it("never says 'made in another chat' about a row the caller cannot reach: a stranger naming their own chat gets the plain 404", async () => {
		const artifactId = await seedOwnDocument();
		seedConversation(memory, { id: "conv-stranger-own", userId: STRANGER });

		const response = await deleteArtifactRoute(
			deleteEvent({
				artifactId,
				userId: STRANGER,
				conversationId: "conv-stranger-own",
			}),
		);

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ ok: false, reason: "not_found" });
		expect(stored(artifactId)).toBeDefined();
	});

	it("cannot reach an incognito chat's artifact without naming that chat — and then only for its owner", async () => {
		const artifactId = await seedIncognitoDocument();

		const anonymous = await deleteArtifactRoute(
			deleteEvent({ artifactId, userId: OWNER }),
		);
		const otherOwnChat = await deleteArtifactRoute(
			deleteEvent({ artifactId, userId: OWNER, conversationId: OWNER_OTHER }),
		);
		const stranger = await deleteArtifactRoute(
			deleteEvent({ artifactId, userId: STRANGER, conversationId: INCOGNITO }),
		);
		for (const response of [anonymous, otherOwnChat, stranger]) {
			expect(response.status).toBe(404);
			expect(await response.json()).toEqual({ ok: false, reason: "not_found" });
		}
		expect(stored(artifactId)).toBeDefined();

		const own = await deleteArtifactRoute(
			deleteEvent({ artifactId, userId: OWNER, conversationId: INCOGNITO }),
		);
		expect(own.status).toBe(200);
		expect(await own.json()).toEqual({ ok: true });
		expect(stored(artifactId)).toBeUndefined();
	});
});
