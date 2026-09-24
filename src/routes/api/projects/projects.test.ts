import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import { INSTRUCTIONS_MAX_CHARS } from "$lib/shared/instructions";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

let dbPath: string;

function openSeedDatabase() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	return { sqlite, db };
}

function seedProjects() {
	const { sqlite, db } = openSeedDatabase();
	const now = new Date("2026-06-02T09:00:00.000Z");

	db.insert(schema.users)
		.values([
			{
				id: "route-owner",
				email: "route-owner@example.com",
				passwordHash: "h",
			},
			{
				id: "route-other",
				email: "route-other@example.com",
				passwordHash: "h",
			},
		])
		.run();
	db.insert(schema.projects)
		.values([
			{
				id: "route-project",
				userId: "route-owner",
				name: "Owned project",
				createdAt: now,
				updatedAt: now,
			},
			{
				id: "route-other-project",
				userId: "route-other",
				name: "Someone else's",
				createdAt: now,
				updatedAt: now,
			},
		])
		.run();

	sqlite.close();
}

function readProject(projectId: string) {
	const sqlite = new Database(dbPath);
	const db = drizzle(sqlite, { schema });
	const project = db
		.select()
		.from(schema.projects)
		.where(eq(schema.projects.id, projectId))
		.get();
	sqlite.close();
	return project;
}

async function patchProject(params: {
	userId: string;
	projectId: string;
	body: unknown;
}): Promise<{ status: number; payload: unknown }> {
	const { PATCH } = await import("./[id]/+server");
	const response = await PATCH({
		params: { id: params.projectId },
		locals: { user: { id: params.userId } },
		request: new Request(`http://localhost/api/projects/${params.projectId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(params.body),
		}),
	} as unknown as Parameters<typeof PATCH>[0]);

	return { status: response.status, payload: await response.json() };
}

describe("PATCH /api/projects/[id]", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-project-route-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
	});

	afterEach(() => {
		try {
			unlinkSync(dbPath);
		} catch {
			// Temporary DB cleanup is best-effort.
		}
	});

	it("stores instructions on their own", async () => {
		seedProjects();

		const response = await patchProject({
			userId: "route-owner",
			projectId: "route-project",
			body: { instructions: "Always answer in Hungarian." },
		});

		expect(response.status).toBe(200);
		expect(response.payload).toMatchObject({ hasInstructions: true });
		expect(response.payload).not.toHaveProperty("instructions");
		expect(readProject("route-project")?.instructions).toBe(
			"Always answer in Hungarian.",
		);
	});

	it("clears the instructions when PATCHed with an empty string", async () => {
		seedProjects();

		await patchProject({
			userId: "route-owner",
			projectId: "route-project",
			body: { instructions: "Temporary guidance." },
		});
		const cleared = await patchProject({
			userId: "route-owner",
			projectId: "route-project",
			body: { instructions: "" },
		});

		expect(cleared.status).toBe(200);
		expect(cleared.payload).toMatchObject({ hasInstructions: false });
		expect(readProject("route-project")?.instructions).toBeNull();
	});

	it("rejects over-limit instructions with 400 and writes nothing", async () => {
		seedProjects();
		const tooLong = "a".repeat(INSTRUCTIONS_MAX_CHARS + 1);

		const response = await patchProject({
			userId: "route-owner",
			projectId: "route-project",
			body: { instructions: tooLong },
		});

		expect(response.status).toBe(400);
		// Never truncated: the stored row keeps the name it had and no text.
		expect(readProject("route-project")).toMatchObject({
			name: "Owned project",
			instructions: null,
		});
	});

	it("accepts text exactly at the limit", async () => {
		seedProjects();
		const atLimit = "a".repeat(INSTRUCTIONS_MAX_CHARS);

		const response = await patchProject({
			userId: "route-owner",
			projectId: "route-project",
			body: { instructions: atLimit },
		});

		expect(response.status).toBe(200);
		expect(readProject("route-project")?.instructions).toHaveLength(
			INSTRUCTIONS_MAX_CHARS,
		);
	});

	it("renames and sets instructions in one PATCH", async () => {
		seedProjects();

		const response = await patchProject({
			userId: "route-owner",
			projectId: "route-project",
			body: { name: "  Renamed project  ", instructions: "Both at once." },
		});

		expect(response.status).toBe(200);
		expect(readProject("route-project")).toMatchObject({
			name: "Renamed project",
			instructions: "Both at once.",
		});
	});

	it("rejects a PATCH with neither field with 400", async () => {
		seedProjects();

		const empty = await patchProject({
			userId: "route-owner",
			projectId: "route-project",
			body: {},
		});
		const nullBody = await patchProject({
			userId: "route-owner",
			projectId: "route-project",
			body: null,
		});

		expect(empty.status).toBe(400);
		expect(nullBody.status).toBe(400);
	});

	it("still refuses a blank name", async () => {
		seedProjects();

		const response = await patchProject({
			userId: "route-owner",
			projectId: "route-project",
			body: { name: "   " },
		});

		expect(response.status).toBe(400);
		expect(readProject("route-project")?.name).toBe("Owned project");
	});

	it("rejects a non-string instructions value", async () => {
		seedProjects();

		const response = await patchProject({
			userId: "route-owner",
			projectId: "route-project",
			body: { instructions: 42 },
		});

		expect(response.status).toBe(400);
		expect(readProject("route-project")?.instructions).toBeNull();
	});

	it("404s a project belonging to another user", async () => {
		seedProjects();

		const response = await patchProject({
			userId: "route-owner",
			projectId: "route-other-project",
			body: { instructions: "Mine now." },
		});

		expect(response.status).toBe(404);
		expect(readProject("route-other-project")?.instructions).toBeNull();
	});
});
