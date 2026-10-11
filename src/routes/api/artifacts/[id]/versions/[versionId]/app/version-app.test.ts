// GET /api/artifacts/[id]/versions/[versionId]/app — a saved App version served
// to History's preview frame (ruling 76, Q7). The security review reads THIS
// file: against a real database and two real users it pins that the route
// sends exactly the App route's sandbox headers, splices in only the read-only
// bridge, answers one 404 for everything that is not the caller's App version,
// and will not serve a version the current contract audit calls a violation.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
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
const { APP_READONLY_BOOTSTRAP_SCRIPT, APP_BOOTSTRAP_SCRIPT } = await import(
	"$lib/server/services/artifacts/app/bootstrap"
);
const { APP_SANDBOX_HEADERS } = await import(
	"$lib/server/services/artifacts/app/sandbox-response"
);
const { GET: getVersionApp } = await import("./+server");
const { GET: getCurrentApp } = await import("../../../app/+server");

const OWNER = "user-owner";
const STRANGER = "user-stranger";
const CONVERSATION = "conv-owner";
const OTHER = "conv-owner-other";
const INCOGNITO = "conv-incognito";
const NOT_FOUND = { ok: false, reason: "not_found" };

type Who = { userId?: string | null; conversationId?: string | null };

function event(path: string, params: Record<string, string>, who: Who = {}) {
	const userId = who.userId === undefined ? OWNER : who.userId;
	const query = new URLSearchParams();
	if (who.conversationId) query.set("conversationId", who.conversationId);
	const queryString = query.toString();
	return {
		params,
		url: new URL(
			`http://localhost/api/artifacts/${path}${queryString ? `?${queryString}` : ""}`,
		),
		locals: { user: userId ? { id: userId, role: "user" } : undefined },
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
	summary: string,
	conversationId?: string,
) {
	const result = await updateArtifactBody({
		userId: OWNER,
		artifactId,
		body,
		author: "alfy",
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

describe("GET /api/artifacts/[id]/versions/[versionId]/app — an old App version, in the App's own sandbox (ruling 58)", () => {
	const APP_V1 =
		"<!doctype html><html><head><title>Tips</title></head><body><p>version one</p><script>window.alfy.storage.set('k', 1)</script></body></html>";
	const APP_V2 =
		"<!doctype html><html><head><title>Tips</title></head><body><p>version two</p></body></html>";

	async function appWithTwoVersions(conversationId = CONVERSATION) {
		const id = await makeArtifact("app", APP_V1, conversationId);
		await write(id, APP_V2, "Alfy regenerated the app: blue", conversationId);
		return { id, ids: await versionIds(id, conversationId) };
	}
	const get = (id: string, versionId: string, who: Who = {}) =>
		getVersionApp(
			event(`${id}/versions/${versionId}/app`, { id, versionId }, who),
		);

	it("serves that version's source with exactly the App route's sandbox headers", async () => {
		const { id, ids } = await appWithTwoVersions();

		const old = await get(id, ids.get(1) as string);
		const current = await getCurrentApp(event(`${id}/app`, { id }));

		expect(old.status).toBe(200);
		const html = await old.text();
		expect(html).toContain("version one");
		expect(html).not.toContain("version two");
		// The very headers object the App route sends: same CSP string, same everything.
		for (const [name, value] of Object.entries(APP_SANDBOX_HEADERS)) {
			expect(old.headers.get(name), name).toBe(value);
			expect(current.headers.get(name), name).toBe(value);
		}
		expect(old.headers.get("content-security-policy")).toContain(
			"sandbox allow-scripts allow-forms",
		);
		expect(old.headers.get("content-security-policy")).toContain(
			"connect-src 'none'",
		);
		expect(old.headers.get("cache-control")).toBe("no-store");
	});

	it("splices in the READ-ONLY bridge, never the writing one", async () => {
		const { id, ids } = await appWithTwoVersions();
		const html = await (await get(id, ids.get(1) as string)).text();
		expect(html).toContain(APP_READONLY_BOOTSTRAP_SCRIPT);
		expect(html).not.toContain(APP_BOOTSTRAP_SCRIPT);
		// It is the first script in the document, before the App's own.
		expect(html.indexOf(APP_READONLY_BOOTSTRAP_SCRIPT)).toBeLessThan(
			html.indexOf("version one"),
		);
		// And the current version's route still gets the writing bridge.
		const current = await (
			await getCurrentApp(event(`${id}/app`, { id }))
		).text();
		expect(current).toContain(APP_BOOTSTRAP_SCRIPT);
		expect(current).not.toContain(APP_READONLY_BOOTSTRAP_SCRIPT);
	});

	it("serves the current version too, through the same read-only route", async () => {
		const { id, ids } = await appWithTwoVersions();
		const html = await (await get(id, ids.get(2) as string)).text();
		expect(html).toContain("version two");
		expect(html).toContain(APP_READONLY_BOOTSTRAP_SCRIPT);
	});

	it("is the same 404 for a missing version, another artifact's version, another user's, a Document's, a produced file and an incognito item from outside", async () => {
		const { id, ids } = await appWithTwoVersions();
		const otherApp = await makeArtifact("app", APP_V2);
		const otherIds = await versionIds(otherApp);
		const document = await makeArtifact("document", doc(["p1", "text"]));
		const documentIds = await versionIds(document);
		const secret = await appWithTwoVersions(INCOGNITO);
		seedProducedFile(memory, {
			userId: OWNER,
			conversationId: CONVERSATION,
			artifactId: "produced-1",
			filename: "plan.pdf",
		});

		const responses = [
			await get(id, "missing"),
			await get("missing", ids.get(1) as string),
			// A version of another artifact does not pass for this one's.
			await get(id, otherIds.get(1) as string),
			await get(id, ids.get(1) as string, { userId: STRANGER }),
			await get(document, documentIds.get(1) as string),
			await get("produced-1", ids.get(1) as string),
			await get(secret.id, secret.ids.get(1) as string),
			await get(secret.id, secret.ids.get(1) as string, {
				conversationId: OTHER,
			}),
			await get(secret.id, secret.ids.get(1) as string, {
				userId: STRANGER,
				conversationId: INCOGNITO,
			}),
		];
		for (const response of responses) {
			expect(response.status).toBe(404);
			expect(await response.json()).toEqual(NOT_FOUND);
			// A refusal is JSON, never the App's document and never the sandbox's.
			expect(response.headers.get("content-security-policy")).toBeNull();
		}
		const own = await get(secret.id, secret.ids.get(1) as string, {
			conversationId: INCOGNITO,
		});
		expect(own.status).toBe(200);
	});

	it("will not run a version the current audit would refuse: a violation is not served, and Code still shows it", async () => {
		const id = await makeArtifact("app", APP_V2);
		await write(
			id,
			"<!doctype html><html><head></head><body><script>window.location = 'https://example.com'</script></body></html>",
			"Alfy regenerated the app: x",
		);
		const ids = await versionIds(id);

		const refused = await get(id, ids.get(2) as string);
		expect(refused.status).toBe(422);
		expect(await refused.json()).toEqual({ ok: false, reason: "not_runnable" });
		expect(refused.headers.get("content-security-policy")).toBeNull();
		// The clean version beside it runs.
		expect((await get(id, ids.get(1) as string)).status).toBe(200);
	});

	it("answers 401 without a signed-in user", async () => {
		await expect(
			getVersionApp(
				event(
					"x/versions/y/app",
					{ id: "x", versionId: "y" },
					{ userId: null },
				),
			),
		).rejects.toMatchObject({ status: 401 });
	});
});
