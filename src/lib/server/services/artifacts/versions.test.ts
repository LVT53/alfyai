import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";
import { NOW, seedConversation, seedUser } from "./artifacts.test-helpers";

let memory: InMemoryDatabase;

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

const {
	createArtifact,
	getVersionBody,
	hashArtifactBody,
	listVersions,
	restoreVersion,
	updateArtifactBody,
} = await import("./index");

const OWNER = "user-owner";
const STRANGER = "user-stranger";
const CONVERSATION = "conv-owner";
const INCOGNITO = "conv-incognito";

async function createDocument(conversationId = CONVERSATION) {
	const result = await createArtifact({
		userId: OWNER,
		conversationId,
		kind: "document",
		title: "Saturday plan",
		body: "v1 body",
		author: "alfy",
		versionSummary: "Alfy wrote the first draft",
	});
	if (!result.ok) throw new Error(result.reason);
	return result.artifact;
}

async function edit(artifactId: string, body: string, summary: string) {
	const result = await updateArtifactBody({
		userId: OWNER,
		artifactId,
		body,
		author: "user",
		summary,
	});
	if (!result.ok) throw new Error(result.reason);
	return result;
}

function contentOf(artifactId: string) {
	return memory.db
		.select({ contentText: schema.artifacts.contentText })
		.from(schema.artifacts)
		.where(eq(schema.artifacts.id, artifactId))
		.get()?.contentText;
}

beforeEach(() => {
	memory = createInMemoryDatabase();
	seedUser(memory, OWNER);
	seedUser(memory, STRANGER);
	seedConversation(memory, { id: CONVERSATION, userId: OWNER });
	seedConversation(memory, {
		id: INCOGNITO,
		userId: OWNER,
		memoryIncognito: true,
	});
});

afterEach(() => {
	memory.close();
});

describe("listVersions", () => {
	it("numbers versions 1..n and lists them newest first", async () => {
		const artifact = await createDocument();
		await edit(artifact.id, "v2 body", "Second");
		await edit(artifact.id, "v3 body", "Third");

		const versions = await listVersions({
			userId: OWNER,
			artifactId: artifact.id,
		});

		expect(versions.map((version) => version.versionNumber)).toEqual([3, 2, 1]);
		expect(versions[0]).toEqual({
			id: expect.any(String),
			versionNumber: 3,
			author: "user",
			summary: "Third",
			createdAt: expect.any(Number),
		});
		expect(versions[2]).toMatchObject({
			author: "alfy",
			summary: "Alfy wrote the first draft",
		});
	});

	it("defaults to the newest fifty and honours a smaller limit", async () => {
		const artifact = await createDocument();
		for (let index = 2; index <= 52; index += 1) {
			await edit(artifact.id, `v${index} body`, `Edit ${index}`);
		}

		const all = await listVersions({ userId: OWNER, artifactId: artifact.id });
		expect(all).toHaveLength(50);
		expect(all[0].versionNumber).toBe(52);
		expect(all.at(-1)?.versionNumber).toBe(3);

		const two = await listVersions({
			userId: OWNER,
			artifactId: artifact.id,
			limit: 2,
		});
		expect(two.map((version) => version.versionNumber)).toEqual([52, 51]);
	});

	it("lists nothing for another user, or for an incognito artifact outside its conversation", async () => {
		const artifact = await createDocument();
		const hidden = await createDocument(INCOGNITO);

		await expect(
			listVersions({ userId: STRANGER, artifactId: artifact.id }),
		).resolves.toEqual([]);
		await expect(
			listVersions({ userId: OWNER, artifactId: hidden.id }),
		).resolves.toEqual([]);
		await expect(
			listVersions({
				userId: OWNER,
				artifactId: hidden.id,
				conversationId: INCOGNITO,
			}),
		).resolves.toHaveLength(1);
	});
});

describe("getVersionBody", () => {
	it("returns the stored body, and null for a version of another artifact or another user", async () => {
		const artifact = await createDocument();
		const other = await createDocument();
		const [version] = await listVersions({
			userId: OWNER,
			artifactId: artifact.id,
		});

		await expect(
			getVersionBody({
				userId: OWNER,
				artifactId: artifact.id,
				versionId: version.id,
			}),
		).resolves.toBe("v1 body");
		await expect(
			getVersionBody({
				userId: OWNER,
				artifactId: other.id,
				versionId: version.id,
			}),
		).resolves.toBeNull();
		await expect(
			getVersionBody({
				userId: STRANGER,
				artifactId: artifact.id,
				versionId: version.id,
			}),
		).resolves.toBeNull();
	});
});

describe("restoreVersion", () => {
	it("writes the old body back as a new version, so nothing is lost", async () => {
		const artifact = await createDocument();
		await edit(artifact.id, "v2 body", "Shortened the Saturday paragraph");
		const first = (
			await listVersions({ userId: OWNER, artifactId: artifact.id })
		).find((version) => version.versionNumber === 1);
		if (!first) throw new Error("no first version");

		const result = await restoreVersion({
			userId: OWNER,
			artifactId: artifact.id,
			versionId: first.id,
		});

		expect(result).toEqual({ ok: true, versionId: expect.any(String) });
		expect(contentOf(artifact.id)).toBe("v1 body");
		const versions = await listVersions({
			userId: OWNER,
			artifactId: artifact.id,
		});
		expect(versions.map((version) => version.versionNumber)).toEqual([3, 2, 1]);
		expect(versions[0]).toMatchObject({
			id: result.ok ? result.versionId : null,
			author: "user",
			summary: "restored Alfy wrote the first draft",
		});
		const stored = memory.db
			.select()
			.from(schema.artifactVersions)
			.where(eq(schema.artifactVersions.id, versions[0].id))
			.get();
		expect(stored?.bodyHash).toBe(hashArtifactBody("v1 body"));
	});

	it("refuses a version with no body", async () => {
		const artifact = await createDocument();
		memory.db
			.insert(schema.artifactVersions)
			.values({
				id: "empty-version",
				artifactId: artifact.id,
				userId: OWNER,
				versionNumber: 2,
				author: "user",
				summary: "Cleared everything",
				body: "",
				bodyHash: hashArtifactBody(""),
				createdAt: NOW,
			})
			.run();

		await expect(
			restoreVersion({
				userId: OWNER,
				artifactId: artifact.id,
				versionId: "empty-version",
			}),
		).resolves.toEqual({ ok: false, reason: "no_body" });
		expect(contentOf(artifact.id)).toBe("v1 body");
	});

	it("answers not_found for a missing version and for another user's artifact", async () => {
		const artifact = await createDocument();
		const [version] = await listVersions({
			userId: OWNER,
			artifactId: artifact.id,
		});

		await expect(
			restoreVersion({
				userId: OWNER,
				artifactId: artifact.id,
				versionId: "missing",
			}),
		).resolves.toEqual({ ok: false, reason: "not_found" });
		await expect(
			restoreVersion({
				userId: STRANGER,
				artifactId: artifact.id,
				versionId: version.id,
			}),
		).resolves.toEqual({ ok: false, reason: "not_found" });
	});
});
