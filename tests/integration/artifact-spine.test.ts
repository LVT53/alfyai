// The artifact spine's three child tables, proven against the real migrated
// database rather than trusted from their Drizzle declarations.
//
// `npm run check:migrations` compares migration files with `schema.ts` by
// TABLE NAME only (scripts/verify-migrations.ts): a unique index or a cascade
// that the Drizzle side declares and the SQL side forgets would pass it. These
// tests are where such a gap fails instead — through the same connection
// bootstrap the server uses (`$lib/server/db`, pointed at the throwaway
// migrated database the Vitest global setup provisions), so a connection that
// ever stopped turning `foreign_keys` on fails here and not in production.
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, sqlite } from "$lib/server/db";
import {
	artifactComments,
	artifactKv,
	artifacts,
	artifactVersions,
	conversations,
	users,
} from "$lib/server/db/schema";

const NOW = new Date("2026-09-25T10:00:00.000Z");

let userId: string;
let conversationId: string;

function seedArtifact(): string {
	const id = `artifact-${randomUUID()}`;
	db.insert(artifacts)
		.values({
			id,
			userId,
			conversationId,
			type: "artifact",
			name: "Saturday plan",
			contentText: "- [ ] Book tickets",
			metadataJson: JSON.stringify({
				artifactType: "document",
				title: "Saturday plan",
			}),
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	return id;
}

function seedVersion(artifactId: string, versionNumber: number): string {
	const id = `version-${randomUUID()}`;
	db.insert(artifactVersions)
		.values({
			id,
			artifactId,
			userId,
			versionNumber,
			author: "alfy",
			summary: "Alfy wrote the first draft",
			body: "- [ ] Book tickets",
			bodyHash: "hash",
			createdAt: NOW,
		})
		.run();
	return id;
}

function seedComment(artifactId: string, parentId: string | null): string {
	const id = `comment-${randomUUID()}`;
	db.insert(artifactComments)
		.values({
			id,
			artifactId,
			userId,
			parentId,
			anchorJson: parentId
				? null
				: JSON.stringify({ kind: "node", nodeId: "node-1" }),
			author: "user",
			body: "Too early?",
			createdAt: NOW,
		})
		.run();
	return id;
}

function seedKv(artifactId: string, key: string): string {
	const id = `kv-${randomUUID()}`;
	db.insert(artifactKv)
		.values({
			id,
			artifactId,
			key,
			valueJson: JSON.stringify({ spent: 42 }),
			updatedAt: NOW,
		})
		.run();
	return id;
}

function childRowCounts(artifactId: string) {
	return {
		versions: db
			.select({ id: artifactVersions.id })
			.from(artifactVersions)
			.where(eq(artifactVersions.artifactId, artifactId))
			.all().length,
		comments: db
			.select({ id: artifactComments.id })
			.from(artifactComments)
			.where(eq(artifactComments.artifactId, artifactId))
			.all().length,
		kv: db
			.select({ id: artifactKv.id })
			.from(artifactKv)
			.where(eq(artifactKv.artifactId, artifactId))
			.all().length,
	};
}

beforeEach(() => {
	userId = `user-${randomUUID()}`;
	conversationId = `conv-${randomUUID()}`;
	db.insert(users)
		.values({
			id: userId,
			email: `${userId}@example.com`,
			passwordHash: "hash",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	db.insert(conversations)
		.values({
			id: conversationId,
			userId,
			title: "Vienna trip",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
});

afterEach(() => {
	// The user row's cascade takes the conversation, the artifacts and — if
	// the tables below are wired the way this file asserts — every child row.
	db.delete(users).where(eq(users.id, userId)).run();
});

describe("the artifact spine tables", () => {
	it("runs on a connection with foreign keys on, so a deleted artifact takes its versions, comments and key-value rows with it", () => {
		expect(sqlite.pragma("foreign_keys", { simple: true })).toBe(1);

		const artifactId = seedArtifact();
		seedVersion(artifactId, 1);
		seedVersion(artifactId, 2);
		const root = seedComment(artifactId, null);
		seedComment(artifactId, root);
		seedKv(artifactId, "expenses");
		expect(childRowCounts(artifactId)).toEqual({
			versions: 2,
			comments: 2,
			kv: 1,
		});

		db.delete(artifacts).where(eq(artifacts.id, artifactId)).run();

		expect(childRowCounts(artifactId)).toEqual({
			versions: 0,
			comments: 0,
			kv: 0,
		});
	});

	it("removes a comment's replies with it", () => {
		const artifactId = seedArtifact();
		const root = seedComment(artifactId, null);
		const replies = [
			seedComment(artifactId, root),
			seedComment(artifactId, root),
		];

		db.delete(artifactComments).where(eq(artifactComments.id, root)).run();

		expect(
			db
				.select({ id: artifactComments.id })
				.from(artifactComments)
				.where(inArray(artifactComments.id, replies))
				.all(),
		).toEqual([]);
	});

	it("keeps an orphaned comment representable: anchor_json may be NULL", () => {
		const artifactId = seedArtifact();
		const id = `comment-${randomUUID()}`;
		db.insert(artifactComments)
			.values({
				id,
				artifactId,
				userId,
				anchorJson: null,
				author: "user",
				body: "Where did this go?",
			})
			.run();

		const [row] = db
			.select()
			.from(artifactComments)
			.where(eq(artifactComments.id, id))
			.all();
		expect(row.anchorJson).toBeNull();
		expect(row.status).toBe("open");
		expect(row.createdAt).toBeInstanceOf(Date);
	});

	it("refuses a second key-value row for the same key on one artifact, and allows the key on another", () => {
		const first = seedArtifact();
		const second = seedArtifact();
		seedKv(first, "expenses");

		expect(() => seedKv(first, "expenses")).toThrow(/UNIQUE/);
		// The constraint is per artifact, not global: the same key on a
		// different artifact is a different row.
		expect(() => seedKv(second, "expenses")).not.toThrow();
	});

	it("refuses a second version with the same number on one artifact, and allows the number on another", () => {
		const first = seedArtifact();
		const second = seedArtifact();
		seedVersion(first, 1);

		expect(() => seedVersion(first, 1)).toThrow(/UNIQUE/);
		expect(() => seedVersion(second, 1)).not.toThrow();
	});
});
