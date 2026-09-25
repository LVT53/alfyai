import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

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

/**
 * One user, one conversation, one assistant message carrying exactly the
 * metadata the endpoint reads. Nothing else is seeded: the endpoint's whole
 * job is to project that metadata row.
 */
function seedAssistantMessage(metadata: Record<string, unknown>) {
	const { sqlite, db } = openSeedDatabase();
	const now = new Date("2026-09-25T09:00:00.000Z");

	db.insert(schema.users)
		.values({
			id: "route-owner",
			email: "route-owner@example.com",
			passwordHash: "h",
		})
		.run();
	db.insert(schema.conversations)
		.values({
			id: "route-conversation",
			userId: "route-owner",
			title: "Citation audit",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.messages)
		.values({
			id: "route-assistant",
			conversationId: "route-conversation",
			messageSequence: 2,
			role: "assistant",
			content: "A grounded answer.",
			metadataJson: JSON.stringify(metadata),
			createdAt: now,
		})
		.run();

	sqlite.close();
}

async function getEvidence(): Promise<{ status: number; body: unknown }> {
	const { GET } = await import("./+server");
	const response = await GET({
		params: { id: "route-conversation", messageId: "route-assistant" },
		locals: { user: { id: "route-owner" } },
	} as unknown as Parameters<typeof GET>[0]);

	// 204 is bodyless by contract; parsing it would throw rather than fail
	// the assertion that cares.
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

const REPAIR_SUMMARY = {
	cited: 2,
	verified: 1,
	repaired: 1,
	stripped: 0,
};

const EVIDENCE_SUMMARY = {
	structuredWebSearch: false,
	groups: [
		{
			sourceType: "web",
			label: "Web Search",
			reranked: false,
			items: [
				{
					id: "evidence-1",
					title: "Hotel Motto stay details",
					sourceType: "web",
					status: "selected",
				},
			],
		},
	],
};

/**
 * The whole evidence of a turn that read a project file with a tool and had
 * nothing selected: one Tool Outputs row, for the read itself — the shape
 * `buildAssistantEvidenceSummary` gives a finished `read_generated_file` call.
 */
const TOOL_READ_EVIDENCE_SUMMARY = {
	structuredWebSearch: false,
	groups: [
		{
			sourceType: "tool",
			label: "Tool Outputs",
			reranked: false,
			items: [
				{
					id: "read_generated_file-0",
					canonicalId: "tool:tool:read_generated_file-0",
					title: "read_generated_file",
					sourceType: "tool",
					status: "reference",
					description: 'Found "Wien itinerary.pdf" (37 chars).',
					channels: ["tool"],
				},
			],
		},
	],
};

describe("GET /api/conversations/[id]/messages/[messageId]/evidence", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-evidence-route-${randomUUID()}.db`;
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

	it("answers pending without a body while the evidence is still being composed", async () => {
		seedAssistantMessage({
			evidenceStatus: "pending",
			citationAudit: REPAIR_SUMMARY,
		});

		const response = await getEvidence();

		// A turn's citation audit is written when the message is created, so a
		// pending row already has one. Pending still means pending: the client
		// keeps polling, and the audit arrives on the settled answer below.
		expect(response).toMatchObject({
			status: 202,
			body: { status: "pending" },
		});
	});

	it("returns the citation audit alongside the evidence summary", async () => {
		seedAssistantMessage({
			evidenceStatus: "ready",
			evidenceSummary: EVIDENCE_SUMMARY,
			projectFilesRead: 2,
			citationAudit: REPAIR_SUMMARY,
		});

		const response = await getEvidence();

		expect(response.status).toBe(200);
		expect(response.body).toMatchObject({
			status: "ready",
			evidenceSummary: EVIDENCE_SUMMARY,
			projectFilesRead: 2,
			citationAudit: REPAIR_SUMMARY,
		});
	});

	// A project file the model read with a tool counts as read even though no
	// evidence selection picked it. The count only rides this answer beside a
	// non-empty summary, and such a turn's whole summary is the Tool Outputs row
	// for the read — so this is the shape the live row depends on.
	it("returns the project files count of a turn whose only evidence is a tool read", async () => {
		seedAssistantMessage({
			evidenceStatus: "ready",
			evidenceSummary: TOOL_READ_EVIDENCE_SUMMARY,
			projectFilesRead: 1,
		});

		const response = await getEvidence();

		expect(response).toMatchObject({
			status: 200,
			body: {
				status: "ready",
				evidenceSummary: TOOL_READ_EVIDENCE_SUMMARY,
				projectFilesRead: 1,
			},
		});
	});

	// The audit is NOT written with the evidence summary: it is persisted when
	// the message is created, while the summary is composed afterwards. A turn
	// whose evidence step finds nothing — or fails — therefore settles with a
	// citation audit and no summary at all, and the Info popover's "Verified
	// sources" row would have no other live channel to reach the page.
	it("returns a citation audit when the turn settled with no evidence summary", async () => {
		seedAssistantMessage({
			evidenceStatus: "none",
			citationAudit: REPAIR_SUMMARY,
		});

		const response = await getEvidence();

		expect(response).toMatchObject({
			status: 200,
			body: { status: "ready", citationAudit: REPAIR_SUMMARY },
		});
	});

	it("returns a citation audit when the evidence step failed", async () => {
		seedAssistantMessage({
			evidenceStatus: "failed",
			citationAudit: REPAIR_SUMMARY,
		});

		const response = await getEvidence();

		expect(response).toMatchObject({
			status: 200,
			body: { status: "ready", citationAudit: REPAIR_SUMMARY },
		});
	});

	it("answers 204 when there is neither evidence nor a citation audit", async () => {
		seedAssistantMessage({ evidenceStatus: "none" });

		const response = await getEvidence();

		expect(response.status).toBe(204);
		expect(response.body).toBeNull();
	});

	it("drops a malformed citation audit instead of projecting it", async () => {
		seedAssistantMessage({
			evidenceStatus: "none",
			citationAudit: { cited: "two", verified: 1 },
		});

		// A row that cannot be printed must not become a row that lies: the
		// popover prints counted sources, so a half-shaped audit is no audit.
		const response = await getEvidence();

		expect(response.status).toBe(204);
		expect(response.body).toBeNull();
	});
});
