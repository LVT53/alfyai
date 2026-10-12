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

function metadataOf(artifactId: string): Record<string, unknown> {
	const json = memory.db
		.select({ metadataJson: schema.artifacts.metadataJson })
		.from(schema.artifacts)
		.where(eq(schema.artifacts.id, artifactId))
		.get()?.metadataJson;
	return json ? (JSON.parse(json) as Record<string, unknown>) : {};
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

	// RV-V M-10: the versions route took any limit (nine digits). A page is never more
	// than History's own page maximum.
	it("never lists more than a page's maximum, however many it is asked for", async () => {
		const artifact = await createDocument();
		for (let n = 2; n <= 130; n += 1) {
			await edit(artifact.id, `body ${n}`, `Edit ${n}`);
		}
		const all = await listVersions({
			userId: OWNER,
			artifactId: artifact.id,
			limit: 999_999_999,
		});
		expect(all).toHaveLength(100);
		expect(all[0].versionNumber).toBe(130);
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
			kind: "restore",
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

		// RC-V M-1: the reader's own saves coalesce into their latest version, so the
		// newest version can hold new words under the SAME number. The number alone
		// cannot say "it changed while you were looking"; the newest body's hash can.
		it("refuses a restore over a save that coalesced into the newest version (same number, new words), and goes through on the hash the reader saw", async () => {
			const { artifact, ids } = await setup();
			const seen = hashArtifactBody("v2 body");

			// The reader's late save lands after History loaded.
			const late = await updateArtifactBody({
				userId: OWNER,
				artifactId: artifact.id,
				body: "v2 body, and a late line",
				author: "user",
				summary: "Edited",
				coalesceUserEdits: true,
			});
			expect(late).toMatchObject({ ok: true, versionNumber: 2 });

			await expect(
				restoreVersion({
					userId: OWNER,
					artifactId: artifact.id,
					versionId: ids.get(1) as string,
					expectVersion: 2,
					expectHash: seen,
				}),
			).resolves.toEqual({ ok: false, reason: "version_conflict" });
			expect(contentOf(artifact.id)).toBe("v2 body, and a late line");
			expect(
				(await listVersions({ userId: OWNER, artifactId: artifact.id })).length,
			).toBe(2);

			await expect(
				restoreVersion({
					userId: OWNER,
					artifactId: artifact.id,
					versionId: ids.get(1) as string,
					expectVersion: 2,
					expectHash: hashArtifactBody("v2 body, and a late line"),
				}),
			).resolves.toMatchObject({ ok: true, versionNumber: 3 });
			expect(contentOf(artifact.id)).toBe("v1 body");
		});

		it("is optional: a caller that quotes no hash is guarded by the number alone, as before", async () => {
			const { artifact, ids } = await setup();
			await updateArtifactBody({
				userId: OWNER,
				artifactId: artifact.id,
				body: "v2 body, and a late line",
				author: "user",
				summary: "Edited",
				coalesceUserEdits: true,
			});
			await expect(
				restoreVersion({
					userId: OWNER,
					artifactId: artifact.id,
					versionId: ids.get(1) as string,
					expectVersion: 2,
				}),
			).resolves.toMatchObject({ ok: true, versionNumber: 3 });
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

		// RV-V M-8: the server says what kind of row it wrote, so a client that announces
		// the new version (the header's "Edited by you" until a refetch) never has to
		// guess whether an Undo took back a restore or Alfy's change.
		it("says which kind of row it wrote: a restore, the Undo of one, or the Undo of Alfy's change", async () => {
			const { artifact, ids } = await setup();
			const restored = await restoreVersion({
				userId: OWNER,
				artifactId: artifact.id,
				versionId: ids.get(1) as string,
			});
			expect(restored).toMatchObject({ ok: true, kind: "restore" });
			const undoneRestore = await restoreVersion({
				userId: OWNER,
				artifactId: artifact.id,
				versionId: ids.get(2) as string,
				undoOf: 3,
			});
			expect(undoneRestore).toMatchObject({ ok: true, kind: "undo_restore" });

			const rebuilt = await createDocument();
			await updateArtifactBody({
				userId: OWNER,
				artifactId: rebuilt.id,
				body: "alfy body",
				author: "alfy",
				summary: "Alfy regenerated the app: x",
			});
			const first = (
				await listVersions({ userId: OWNER, artifactId: rebuilt.id })
			).find((version) => version.versionNumber === 1);
			await expect(
				restoreVersion({
					userId: OWNER,
					artifactId: rebuilt.id,
					versionId: first?.id as string,
					undoOf: 2,
				}),
			).resolves.toMatchObject({ ok: true, kind: "undo_alfy_change" });
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

// Ruling 58 (RV-V I-2): a restore puts an old body back as the LIVE one, and the
// live frame runs it with the writing bridge and today's saved data. A version the
// current audit calls a violation (it sends its own document away, or opens a
// WebRTC channel) is one the product does not run: History's preview serves it as
// Code only, and a restore must not hand it the live frame one click later.
describe("restoreVersion of an App", () => {
	const CLEAN_APP =
		"<!doctype html><html><head><title>Trip</title></head><body><p id='t'>total</p><script>alfy.storage.get('t');</script></body></html>";
	const NAVIGATING_APP =
		'<!doctype html><html><body><script>setTimeout(function () { window.location.href = "/login"; }, 800);</script></body></html>';
	const WEBRTC_APP =
		"<!doctype html><html><body><script>const peer = new RTCPeerConnection();</script></body></html>";

	async function createApp(bodies: string[], conversationId = CONVERSATION) {
		const [first, ...rest] = bodies;
		const created = await createArtifact({
			userId: OWNER,
			conversationId,
			kind: "app",
			title: "Trip budget",
			body: first,
			author: "alfy",
			versionSummary: "Alfy built the app: a trip budget",
		});
		if (!created.ok) throw new Error(created.reason);
		for (const body of rest) {
			const result = await updateArtifactBody({
				userId: OWNER,
				artifactId: created.artifact.id,
				body,
				author: "alfy",
				summary: "Alfy regenerated the app: again",
			});
			if (!result.ok) throw new Error(result.reason);
		}
		const versions = await listVersions({
			userId: OWNER,
			artifactId: created.artifact.id,
		});
		return {
			artifactId: created.artifact.id,
			idOf: (n: number) =>
				versions.find((version) => version.versionNumber === n)?.id as string,
		};
	}

	it("refuses a version the current audit calls a violation, and writes nothing", async () => {
		for (const violating of [NAVIGATING_APP, WEBRTC_APP]) {
			const { artifactId, idOf } = await createApp([
				CLEAN_APP,
				violating,
				CLEAN_APP.replace("total", "third"),
			]);

			await expect(
				restoreVersion({
					userId: OWNER,
					artifactId,
					versionId: idOf(2),
					expectVersion: 3,
				}),
			).resolves.toEqual({ ok: false, reason: "not_runnable" });

			expect(contentOf(artifactId)).toContain("third");
			expect(
				(await listVersions({ userId: OWNER, artifactId })).map(
					(version) => version.versionNumber,
				),
			).toEqual([3, 2, 1]);
		}
	});

	it("restores a version that runs, as before", async () => {
		const { artifactId, idOf } = await createApp([
			CLEAN_APP,
			CLEAN_APP.replace("total", "second"),
		]);

		await expect(
			restoreVersion({ userId: OWNER, artifactId, versionId: idOf(1) }),
		).resolves.toMatchObject({ ok: true, versionNumber: 3 });
		expect(contentOf(artifactId)).toBe(CLEAN_APP);
	});

	// FX-V's note: the metadata is the artifact's, written with the version that
	// was live, so a restore left the verdict and the glitch hints of the version it
	// replaced on the App it brought back.
	describe("what the App's metadata says after a restore", () => {
		const NETWORK_APP =
			"<!doctype html><html><body><script>fetch('/api/x');</script></body></html>";
		const LIVE_VERDICT = {
			checked: true,
			verdict: "repaired",
			reason: null,
		};

		async function rebuild(
			artifactId: string,
			body: string,
			metadataPatch: Record<string, unknown>,
		) {
			const result = await updateArtifactBody({
				userId: OWNER,
				artifactId,
				body,
				author: "alfy",
				summary: "Alfy regenerated the app: again",
				metadataPatch,
			});
			if (!result.ok) throw new Error(result.reason);
		}

		it("describes the restored version: today's audit of its body, and no verdict about the version it replaced", async () => {
			// v1 is clean; v2 is a rebuild that fetches (a glitch) and was checked.
			const { artifactId, idOf } = await createApp([CLEAN_APP]);
			await rebuild(artifactId, NETWORK_APP, {
				glitchRuleIds: ["no-network-api"],
				verification: LIVE_VERDICT,
			});
			expect(metadataOf(artifactId)).toMatchObject({
				glitchRuleIds: ["no-network-api"],
				verification: LIVE_VERDICT,
			});

			await expect(
				restoreVersion({
					userId: OWNER,
					artifactId,
					versionId: idOf(1),
					expectVersion: 2,
				}),
			).resolves.toMatchObject({ ok: true, versionNumber: 3 });

			const metadata = metadataOf(artifactId);
			// The restored body is clean: no glitch hint about the fetch that is gone.
			expect(metadata.glitchRuleIds).toEqual([]);
			// Nobody has checked this version since it came back: no verdict is claimed.
			expect(metadata.verification ?? null).toBeNull();
			// Nothing else of the artifact's identity moved.
			expect(metadata.artifactType).toBe("app");
		});

		it("names the glitches of the version it brings back, as the audit finds them", async () => {
			// v1 fetches; v2 is a clean rebuild whose metadata says so.
			const { artifactId, idOf } = await createApp([NETWORK_APP]);
			await rebuild(artifactId, CLEAN_APP, {
				glitchRuleIds: [],
				verification: { checked: true, verdict: "clean", reason: null },
			});

			await restoreVersion({
				userId: OWNER,
				artifactId,
				versionId: idOf(1),
				expectVersion: 2,
			});

			const metadata = metadataOf(artifactId);
			expect(metadata.glitchRuleIds).toEqual(["no-network-api"]);
			expect(metadata.verification ?? null).toBeNull();
		});

		it("is the same for an App rebuild's Undo, which also brings an earlier body back", async () => {
			const { artifactId, idOf } = await createApp([CLEAN_APP]);
			await rebuild(artifactId, NETWORK_APP, {
				glitchRuleIds: ["no-network-api"],
				verification: LIVE_VERDICT,
			});

			await expect(
				restoreVersion({
					userId: OWNER,
					artifactId,
					versionId: idOf(1),
					undoOf: 2,
				}),
			).resolves.toMatchObject({ ok: true, kind: "undo_alfy_change" });

			expect(metadataOf(artifactId).glitchRuleIds).toEqual([]);
			expect(metadataOf(artifactId).verification ?? null).toBeNull();
		});

		it("is an App's rule alone: a Document's restore writes no App metadata", async () => {
			const result = await createArtifact({
				userId: OWNER,
				conversationId: CONVERSATION,
				kind: "document",
				title: "Notes",
				body: "First.",
				author: "alfy",
				versionSummary: "Alfy wrote the first draft",
			});
			if (!result.ok) throw new Error(result.reason);
			await edit(result.artifact.id, "Second.", "Edited");
			const [, first] = await listVersions({
				userId: OWNER,
				artifactId: result.artifact.id,
			});
			await restoreVersion({
				userId: OWNER,
				artifactId: result.artifact.id,
				versionId: first.id,
			});
			const metadata = metadataOf(result.artifact.id);
			expect(metadata).not.toHaveProperty("glitchRuleIds");
			expect(metadata).not.toHaveProperty("verification");
		});
	});

	it("holds an App's rebuild Undo to the same line: the version it would bring back must run", async () => {
		// v1 predates the rules (it navigates); v2 is Alfy's rebuild; the toast's Undo
		// would put v1 back as the live App.
		const { artifactId, idOf } = await createApp([NAVIGATING_APP, CLEAN_APP]);

		await expect(
			restoreVersion({
				userId: OWNER,
				artifactId,
				versionId: idOf(1),
				undoOf: 2,
			}),
		).resolves.toEqual({ ok: false, reason: "not_runnable" });
		expect(contentOf(artifactId)).toBe(CLEAN_APP);
	});

	it("is an App's rule alone: a Document whose text says the same restores", async () => {
		const result = await createArtifact({
			userId: OWNER,
			conversationId: CONVERSATION,
			kind: "document",
			title: "Notes on the sandbox",
			body: "Apps must never run window.location.href = x or new RTCPeerConnection().",
			author: "alfy",
			versionSummary: "Alfy wrote the first draft",
		});
		if (!result.ok) throw new Error(result.reason);
		await edit(result.artifact.id, "Shorter.", "Edited");
		const [, first] = await listVersions({
			userId: OWNER,
			artifactId: result.artifact.id,
		});

		await expect(
			restoreVersion({
				userId: OWNER,
				artifactId: result.artifact.id,
				versionId: first.id,
			}),
		).resolves.toMatchObject({ ok: true, versionNumber: 3 });
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
