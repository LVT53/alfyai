import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const generateApp = vi.fn();
vi.mock("./generate", () => ({
	generateApp: (...args: unknown[]) => generateApp(...args),
}));

const verifyApp = vi.fn();
vi.mock("./verify", () => ({
	verifyApp: (...args: unknown[]) => verifyApp(...args),
}));

const { createArtifact, getKv, setKv, createComment, listComments } =
	await import("$lib/server/services/artifacts");
const { regenerateApp } = await import("./regenerate");

const OWNER = "user-owner";
const CONVERSATION = "conv-owner";

function checksWithNoGlitches() {
	return [
		{ rule: "tokens", severity: "note", passed: true, detail: null },
	] as never;
}

function cleanVerification() {
	return {
		checked: true,
		verdict: "clean" as const,
		findings: [],
		repairedHtml: null,
		usage: null,
		reason: null,
	};
}

async function createApp() {
	const result = await createArtifact({
		userId: OWNER,
		conversationId: CONVERSATION,
		kind: "app",
		title: "Habit tracker",
		body: "<!doctype html><title>Habits v1</title>",
		author: "alfy",
	});
	if (!result.ok) throw new Error(result.reason);
	return result.artifact;
}

function versionRows(artifactId: string) {
	return memory.db
		.select()
		.from(schema.artifactVersions)
		.where(eq(schema.artifactVersions.artifactId, artifactId))
		.all();
}

beforeEach(() => {
	memory = createInMemoryDatabase();
	seedUser(memory, OWNER);
	seedConversation(memory, { id: CONVERSATION, userId: OWNER });
	vi.clearAllMocks();
	generateApp.mockResolvedValue({
		ok: true,
		html: "<!doctype html><title>Habits v2</title>",
		title: "Habit tracker",
		extraction: "fence",
		fences: 1,
		checks: checksWithNoGlitches(),
		usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
		attempts: 1,
		warnings: [],
	});
	verifyApp.mockResolvedValue(cleanVerification());
});

afterEach(() => {
	memory.close();
});

describe("regenerateApp", () => {
	it("writes exactly one new version, author alfy, summary naming the request", async () => {
		const app = await createApp();

		const result = await regenerateApp({
			userId: OWNER,
			artifactId: app.id,
			conversationId: CONVERSATION,
			prompt: "add a currency switch",
			language: "en",
		});

		expect(result).toEqual({
			ok: true,
			version: 2,
			title: "Habit tracker",
			verification: { checked: true, verdict: "clean", reason: null },
		});
		const versions = versionRows(app.id).sort(
			(a, b) => a.versionNumber - b.versionNumber,
		);
		expect(versions).toHaveLength(2);
		expect(versions[1]).toMatchObject({
			author: "alfy",
			body: "<!doctype html><title>Habits v2</title>",
		});
		expect(versions[1].summary).toContain("add a currency switch");
	});

	it("the PREVIOUS version's html is unchanged and stays in the history", async () => {
		const app = await createApp();
		await regenerateApp({
			userId: OWNER,
			artifactId: app.id,
			conversationId: CONVERSATION,
			prompt: "add a currency switch",
			language: "en",
		});

		const versions = versionRows(app.id).sort(
			(a, b) => a.versionNumber - b.versionNumber,
		);
		expect(versions[0].body).toBe("<!doctype html><title>Habits v1</title>");
	});

	it("does not touch the app's kv rows", async () => {
		const app = await createApp();
		await setKv({
			userId: OWNER,
			artifactId: app.id,
			key: "streak",
			valueJson: "5",
		});

		await regenerateApp({
			userId: OWNER,
			artifactId: app.id,
			conversationId: CONVERSATION,
			prompt: "add a currency switch",
			language: "en",
		});

		await expect(
			getKv({ userId: OWNER, artifactId: app.id, key: "streak" }),
		).resolves.toBe("5");
	});

	it("does not delete the app's existing comments", async () => {
		const app = await createApp();
		await createComment({
			userId: OWNER,
			artifactId: app.id,
			anchor: { kind: "node", nodeId: "app" },
			author: "user",
			body: "This app is great!",
		});

		await regenerateApp({
			userId: OWNER,
			artifactId: app.id,
			conversationId: CONVERSATION,
			prompt: "add a currency switch",
			language: "en",
		});

		const comments = await listComments({ userId: OWNER, artifactId: app.id });
		expect(
			comments.some((comment) => comment.body === "This app is great!"),
		).toBe(true);
	});

	it("writes an Alfy comment quoting the findings when the verdict is uncertain", async () => {
		const app = await createApp();
		verifyApp.mockResolvedValue({
			checked: true,
			verdict: "uncertain",
			findings: [
				{
					claim: "Vienna is the capital of Hungary",
					problem: "could not settle without web research",
					class: "other",
					location: null,
					settled: false,
				},
			],
			repairedHtml: null,
			usage: null,
			reason: null,
		});

		await regenerateApp({
			userId: OWNER,
			artifactId: app.id,
			conversationId: CONVERSATION,
			prompt: "add a currency switch",
			language: "en",
		});

		const comments = await listComments({ userId: OWNER, artifactId: app.id });
		const alfyComment = comments.find((comment) => comment.author === "alfy");
		expect(alfyComment?.body).toContain("Vienna is the capital of Hungary");
	});

	it("returns not_found for a missing or foreign artifact", async () => {
		const result = await regenerateApp({
			userId: OWNER,
			artifactId: "does-not-exist",
			conversationId: CONVERSATION,
			prompt: "x",
			language: "en",
		});
		expect(result).toEqual({ ok: false, reason: "not_found" });
		expect(generateApp).not.toHaveBeenCalled();
	});

	it("409s version_conflict when expectVersion does not match, and writes nothing", async () => {
		const app = await createApp();

		const result = await regenerateApp({
			userId: OWNER,
			artifactId: app.id,
			conversationId: CONVERSATION,
			prompt: "add a currency switch",
			language: "en",
			expectVersion: 5,
		});

		expect(result).toEqual({
			ok: false,
			reason: "version_conflict",
			version: 1,
		});
		expect(generateApp).not.toHaveBeenCalled();
		expect(versionRows(app.id)).toHaveLength(1);
	});

	it("a failed generation leaves the current version untouched, and writes no version row", async () => {
		const app = await createApp();
		generateApp.mockResolvedValue({
			ok: false,
			reason: "no_fence",
			detail: "the answer did not contain a runnable app",
			usage: null,
			attempts: 2,
		});

		const result = await regenerateApp({
			userId: OWNER,
			artifactId: app.id,
			conversationId: CONVERSATION,
			prompt: "add a currency switch",
			language: "en",
		});

		expect(result).toEqual({
			ok: false,
			reason: "no_fence",
			detail: "the answer did not contain a runnable app",
		});
		expect(versionRows(app.id)).toHaveLength(1);
		expect(verifyApp).not.toHaveBeenCalled();
	});

	it("uses the repaired HTML as the new version's body when the verdict is repaired", async () => {
		const app = await createApp();
		const repaired = "<!doctype html><title>Habits v2 fixed</title>";
		verifyApp.mockResolvedValue({
			checked: true,
			verdict: "repaired",
			findings: [
				{
					claim: "x",
					problem: "y",
					class: "other",
					location: null,
					settled: true,
				},
			],
			repairedHtml: repaired,
			usage: null,
			reason: null,
		});

		await regenerateApp({
			userId: OWNER,
			artifactId: app.id,
			conversationId: CONVERSATION,
			prompt: "add a currency switch",
			language: "en",
		});

		const versions = versionRows(app.id).sort(
			(a, b) => a.versionNumber - b.versionNumber,
		);
		expect(versions[1].body).toBe(repaired);
	});
});
