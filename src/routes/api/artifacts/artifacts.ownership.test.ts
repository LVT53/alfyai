// Real-database coverage for the client review's fix 1: an incognito chat
// must be able to open its own artifact. `GET /api/artifacts/[id]` used to
// call the service with the default (strict) ownership scope, which hides
// every incognito conversation — so the panel listed the row but opening it
// always 404'd. This file proves the fix with two real users in an in-memory
// database, not mocks: naming the artifact's own incognito conversation
// widens the read for its owner, and for nobody and nothing else.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
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
const { GET: getArtifactDetail } = await import("./[id]/+server");
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
