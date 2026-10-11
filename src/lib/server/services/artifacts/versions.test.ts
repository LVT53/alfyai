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
	nameVersion,
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

	it("pages with before: the next versions below the last one seen", async () => {
		const artifact = await createDocument();
		for (let index = 2; index <= 8; index += 1) {
			await edit(artifact.id, `v${index} body`, `Edit ${index}`);
		}
		const numbers = async (before?: number) =>
			(
				await listVersions({
					userId: OWNER,
					artifactId: artifact.id,
					limit: 3,
					before,
				})
			).map((version) => version.versionNumber);

		expect(await numbers()).toEqual([8, 7, 6]);
		expect(await numbers(6)).toEqual([5, 4, 3]);
		expect(await numbers(3)).toEqual([2, 1]);
		expect(await numbers(1)).toEqual([]);
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

		expect(result).toEqual({
			ok: true,
			versionId: expect.any(String),
			versionNumber: 3,
		});
		expect(contentOf(artifact.id)).toBe("v1 body");
		const versions = await listVersions({
			userId: OWNER,
			artifactId: artifact.id,
		});
		expect(versions.map((version) => version.versionNumber)).toEqual([3, 2, 1]);
		expect(versions[0]).toMatchObject({
			id: result.ok ? result.versionId : null,
			author: "user",
			summary: "Restored v1",
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

	describe("the guard (expectVersion) and undoOf", () => {
		async function setup() {
			const artifact = await createDocument();
			await edit(artifact.id, "v2 body", "Edited");
			const ids = new Map(
				(await listVersions({ userId: OWNER, artifactId: artifact.id })).map(
					(version) => [version.versionNumber, version.id] as const,
				),
			);
			return { artifact, ids };
		}

		it("refuses a restore over a newer version, writing nothing, and goes through when the reader saw the newest", async () => {
			const { artifact, ids } = await setup();
			await edit(artifact.id, "v3 body", "Edited"); // after the reader looked

			await expect(
				restoreVersion({
					userId: OWNER,
					artifactId: artifact.id,
					versionId: ids.get(1) as string,
					expectVersion: 2,
				}),
			).resolves.toEqual({ ok: false, reason: "version_conflict" });
			expect(contentOf(artifact.id)).toBe("v3 body");
			expect(
				(await listVersions({ userId: OWNER, artifactId: artifact.id })).length,
			).toBe(3);

			await expect(
				restoreVersion({
					userId: OWNER,
					artifactId: artifact.id,
					versionId: ids.get(1) as string,
					expectVersion: 3,
				}),
			).resolves.toMatchObject({ ok: true, versionNumber: 4 });
			expect(contentOf(artifact.id)).toBe("v1 body");
		});

		it('names the restore it reverses: the toast\'s Undo writes "Undid restoring v3"', async () => {
			const { artifact, ids } = await setup();
			await restoreVersion({
				userId: OWNER,
				artifactId: artifact.id,
				versionId: ids.get(1) as string,
				expectVersion: 2,
			}); // version 3: "Restored v1"

			const undone = await restoreVersion({
				userId: OWNER,
				artifactId: artifact.id,
				versionId: ids.get(2) as string,
				expectVersion: 3,
				undoOf: 3,
			});

			expect(undone).toMatchObject({ ok: true, versionNumber: 4 });
			expect(contentOf(artifact.id)).toBe("v2 body");
			const [newest] = await listVersions({
				userId: OWNER,
				artifactId: artifact.id,
				limit: 1,
			});
			expect(newest).toMatchObject({
				author: "user",
				summary: "Undid restoring v3",
			});
		});

		it("names the Alfy change it takes back when it reverses one (an App rebuild's Undo)", async () => {
			const artifact = await createDocument();
			await updateArtifactBody({
				userId: OWNER,
				artifactId: artifact.id,
				body: "alfy body",
				author: "alfy",
				summary: "Alfy regenerated the app: x",
			});
			const first = (
				await listVersions({ userId: OWNER, artifactId: artifact.id })
			).find((version) => version.versionNumber === 1);
			await expect(
				restoreVersion({
					userId: OWNER,
					artifactId: artifact.id,
					versionId: first?.id as string,
					undoOf: 2,
				}),
			).resolves.toMatchObject({ ok: true, versionNumber: 3 });
			const [newest] = await listVersions({
				userId: OWNER,
				artifactId: artifact.id,
				limit: 1,
			});
			expect(newest.summary).toBe("Undid Alfy's change: v2");
		});

		it("refuses an undo that is not the newest row's, not its parent being restored, or not of a restore or Alfy's change", async () => {
			const { artifact, ids } = await setup();
			const before = (
				await listVersions({ userId: OWNER, artifactId: artifact.id })
			).length;
			const attempt = (overrides: {
				versionId: string;
				undoOf: number;
				expectVersion?: number;
			}) =>
				restoreVersion({
					userId: OWNER,
					artifactId: artifact.id,
					...overrides,
				});

			// Not the newest row (the artifact is at v2).
			await expect(
				attempt({ versionId: ids.get(1) as string, undoOf: 1 }),
			).resolves.toEqual({
				ok: false,
				reason: "invalid_undo",
			});
			// The newest row, but the version offered is not its parent.
			await expect(
				attempt({ versionId: ids.get(2) as string, undoOf: 2 }),
			).resolves.toEqual({
				ok: false,
				reason: "invalid_undo",
			});
			// The newest row is the reader's ordinary edit: there is nothing to reverse.
			await expect(
				attempt({ versionId: ids.get(1) as string, undoOf: 2 }),
			).resolves.toEqual({
				ok: false,
				reason: "invalid_undo",
			});
			// expectVersion and undoOf must agree.
			await expect(
				attempt({
					versionId: ids.get(1) as string,
					undoOf: 2,
					expectVersion: 1,
				}),
			).resolves.toEqual({ ok: false, reason: "invalid_undo" });
			expect(
				(await listVersions({ userId: OWNER, artifactId: artifact.id })).length,
			).toBe(before);
		});
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

// Ruling 76 (Q3): a reader's name for a version. It is a column of the row, not
// a body: naming mints no version and leaves the artifact as it was.
describe("nameVersion", () => {
	async function twoVersions() {
		const artifact = await createDocument();
		await edit(artifact.id, "v2 body", "Edited");
		const versions = await listVersions({
			userId: OWNER,
			artifactId: artifact.id,
		});
		return { artifact, newest: versions[0], first: versions[1] };
	}
	const labelOf = (versionId: string) =>
		memory.db
			.select({ label: schema.artifactVersions.label })
			.from(schema.artifactVersions)
			.where(eq(schema.artifactVersions.id, versionId))
			.get()?.label;

	it("names a version, renames it, and removes the name with blank or null", async () => {
		const { artifact, first } = await twoVersions();
		const target = {
			userId: OWNER,
			artifactId: artifact.id,
			versionId: first.id,
		};

		await expect(
			nameVersion({ ...target, label: "  Before the client call " }),
		).resolves.toEqual({
			ok: true,
			label: "Before the client call",
		});
		expect(labelOf(first.id)).toBe("Before the client call");
		await expect(nameVersion({ ...target, label: "After" })).resolves.toEqual({
			ok: true,
			label: "After",
		});
		await expect(nameVersion({ ...target, label: "  " })).resolves.toEqual({
			ok: true,
			label: null,
		});
		expect(labelOf(first.id)).toBeNull();
		await expect(
			nameVersion({ ...target, label: "Again" }),
		).resolves.toMatchObject({ ok: true });
		await expect(nameVersion({ ...target, label: null })).resolves.toEqual({
			ok: true,
			label: null,
		});
		expect(labelOf(first.id)).toBeNull();
	});

	it("mints no version and changes neither the body nor when the artifact was last changed", async () => {
		const { artifact, newest } = await twoVersions();
		const before = memory.db
			.select()
			.from(schema.artifacts)
			.where(eq(schema.artifacts.id, artifact.id))
			.get();
		await nameVersion({
			userId: OWNER,
			artifactId: artifact.id,
			versionId: newest.id,
			label: "Keep this one",
		});
		const after = memory.db
			.select()
			.from(schema.artifacts)
			.where(eq(schema.artifacts.id, artifact.id))
			.get();
		expect(after?.contentText).toBe(before?.contentText);
		expect(after?.updatedAt).toEqual(before?.updatedAt);
		expect(
			(await listVersions({ userId: OWNER, artifactId: artifact.id })).map(
				(v) => v.versionNumber,
			),
		).toEqual([2, 1]);
	});

	it("refuses a name that is too long or not text, and says not_found for a version that is not the caller's to name", async () => {
		const { artifact, first } = await twoVersions();
		const target = {
			userId: OWNER,
			artifactId: artifact.id,
			versionId: first.id,
		};
		await expect(
			nameVersion({ ...target, label: "x".repeat(61) }),
		).resolves.toEqual({
			ok: false,
			reason: "invalid_label",
		});
		await expect(
			nameVersion({ ...target, label: 5 as unknown as string }),
		).resolves.toEqual({ ok: false, reason: "invalid_label" });
		expect(labelOf(first.id)).toBeNull();

		const notFound = { ok: false, reason: "not_found" };
		await expect(
			nameVersion({ ...target, versionId: "missing", label: "x" }),
		).resolves.toEqual(notFound);
		await expect(
			nameVersion({ ...target, userId: STRANGER, label: "x" }),
		).resolves.toEqual(notFound);
		// A version of another artifact is not this artifact's to name.
		const other = await createDocument();
		await expect(
			nameVersion({
				userId: OWNER,
				artifactId: other.id,
				versionId: first.id,
				label: "x",
			}),
		).resolves.toEqual(notFound);
		expect(labelOf(first.id)).toBeNull();
	});

	it("stays inside an incognito conversation's scope", async () => {
		const artifact = await createDocument(INCOGNITO);
		const [version] = await listVersions({
			userId: OWNER,
			artifactId: artifact.id,
			conversationId: INCOGNITO,
		});
		await expect(
			nameVersion({
				userId: OWNER,
				artifactId: artifact.id,
				versionId: version.id,
				label: "x",
			}),
		).resolves.toEqual({ ok: false, reason: "not_found" });
		await expect(
			nameVersion({
				userId: OWNER,
				artifactId: artifact.id,
				versionId: version.id,
				label: "x",
				conversationId: INCOGNITO,
			}),
		).resolves.toEqual({ ok: true, label: "x" });
	});

	it("stops the next edit from coalescing into the named version", async () => {
		const artifact = await createDocument();
		const typing = (body: string) =>
			updateArtifactBody({
				userId: OWNER,
				artifactId: artifact.id,
				body,
				author: "user",
				summary: "Edited",
				coalesceUserEdits: true,
			});
		const first = await typing("one");
		if (!first.ok) throw new Error(first.reason);
		await nameVersion({
			userId: OWNER,
			artifactId: artifact.id,
			versionId: first.versionId,
			label: "One",
		});
		const next = await typing("two");
		expect(next.ok && next.versionNumber).toBe(3);
		expect(
			await getVersionBody({
				userId: OWNER,
				artifactId: artifact.id,
				versionId: first.versionId,
			}),
		).toBe("one");
	});
});
