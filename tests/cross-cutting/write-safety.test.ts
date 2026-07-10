// Issue X.2 — CONSOLIDATED, STANDING write-safety "corruption firewall" suite.
//
// "No write adapter merges without all seven." For EVERY write adapter
// (nextcloud, google-calendar, apple-caldav, imap-email, immich-album), this
// file proves:
//   1. allow_writes=false -> refused (no mutation, no pending row created by
//      the tool path).
//   2. No execution without an explicit confirm — the tool write action only
//      ever creates a PENDING row; nothing executes until confirmPendingWrite.
//   3. An unspecified destination lands in the safe default area.
//   4. An explicit destination is honored but flagged if outside the
//      allowlist (path-based providers only).
//   5. Overwrite requires If-Match/etag and refuses on mismatch.
//   6. Delete is reversible, or hard-delete still requires confirm.
//   7. Idempotent under retry.
//
// ┌────────────┬────────────┬────────────┬────────────┬────────────┬────────────┬────────────┬────────────┐
// │ adapter    │ 1 allow_wr │ 2 confirm  │ 3 default  │ 4 explicit │ 5 If-Match │ 6 delete   │ 7 idempot. │
// ├────────────┼────────────┼────────────┼────────────┼────────────┼────────────┼────────────┼────────────┤
// │ nextcloud  │ YES (tool  │ YES        │ YES        │ YES        │ YES (412)  │ YES (trash │ YES (key + │
// │ (files)    │ + executor │            │ (writeAllo │ (honored,  │            │  via plain │  claim)    │
// │            │ defense-in │            │ wlist[0])  │  flagged)  │            │  DELETE)   │            │
// │            │ -depth)    │            │            │            │            │            │            │
// ├────────────┼────────────┼────────────┼────────────┼────────────┼────────────┼────────────┼────────────┤
// │ google     │ YES (tool  │ YES        │ N/A — no   │ N/A — no   │ N/A* — see │ YES        │ YES        │
// │ (calendar) │ layer only)│            │ path concpt│ path concpt│ note below │ (Google    │ (client-   │
// │            │            │            │ (content.  │            │            │  trash, +  │  supplied  │
// │            │            │            │ calendarId │            │            │  410=al-   │  event id  │
// │            │            │            │ as given)  │            │            │  ready-del)│  + 409)    │
// ├────────────┼────────────┼────────────┼────────────┼────────────┼────────────┼────────────┼────────────┤
// │ apple      │ YES (tool  │ YES        │ N/A — no   │ N/A — no   │ YES        │ YES —      │ YES (UID + │
// │ (calendar) │ layer only)│            │ path concpt│ path concpt│ (If-Match  │  destruct- │  If-None-  │
// │            │            │            │            │            │  mandatory,│  ive+non-  │  Match:*   │
// │            │            │            │            │            │  412)      │  reversible│  + 412)    │
// │            │            │            │            │            │            │  but confir│            │
// │            │            │            │            │            │            │  m-gated   │            │
// ├────────────┼────────────┼────────────┼────────────┼────────────┼────────────┼────────────┼────────────┤
// │ imap       │ YES (tool  │ YES        │ N/A — send │ N/A        │ N/A —      │ YES (MOVE  │ YES        │
// │ (email)    │ layer only)│            │ =recipient,│            │  send is a │  to Trash, │  (deter-   │
// │            │            │            │  trash=own │            │  fresh msg;│  never     │  ministic  │
// │            │            │            │  Trash fldr│            │  trash/flag│  EXPUNGE;  │  Message-  │
// │            │            │            │            │            │  are non-  │  no_trash_ │  ID)       │
// │            │            │            │            │            │  destructiv│  folder if │            │
// │            │            │            │            │            │  moves     │  absent)   │            │
// ├────────────┼────────────┼────────────┼────────────┼────────────┼────────────┼────────────┼────────────┤
// │ immich     │ YES (tool  │ YES        │ YES —      │ N/A — no   │ N/A —      │ YES —      │ YES        │
// │ (photos)   │ layer +    │            │  content.  │  path      │  add-to-   │  NO delete │  (duplicate│
// │            │  separate  │            │  albumName │  concept   │  album is  │  path      │  -asset add│
// │            │  write-key │            │  is always │            │  purely    │  exists at │  = success)│
// │            │  provision.│            │  "AlfyAI"  │            │  additive, │  all (asse │            │
// │            │  gate)     │            │  (tool     │            │  never     │  rted below│            │
// │            │            │            │  const)    │            │  destructiv│  )         │            │
// └────────────┴────────────┴────────────┴────────────┴────────────┴────────────┴────────────┴────────────┘
//
// * Google point-5 note (STOP-and-report-adjacent, documented not silently
//   fixed): Google Calendar events DO carry a server `etag`
//   (CalendarEvent.etag), but the read adapter's own doc comment states
//   "Google events never set this" and the write executor's executeUpdate
//   issues a PATCH with NO conditional header at all — no If-Match, no
//   staleness check. This is a DELIBERATE, DOCUMENTED design choice (see
//   google-calendar.ts's CalendarEvent.etag comment and the phase-6.1 design
//   doc, which scopes Google's write safety to "idempotent create + recurring
//   guardrails", unlike 6.2's explicit "If-Match mandatory" for Apple) rather
//   than an oversight: Google's PATCH is a partial-field update (not a
//   full-resource replace like CalDAV/WebDAV), so the corruption blast radius
//   of a lost update is a single field, not a whole resource. Tests below
//   assert this AS THE CURRENT (intentional) BEHAVIOR — an update PATCH is
//   never conditioned on etag — with a prominent comment, not a silent gap.
//
// FIXED (was a real gap, previously pinned via `it.fails`): allowWrites is
// now re-checked at the confirmPendingWrite chokepoint itself (pending-
// writes.ts), not just by each provider's own executor. So flipping
// allowWrites off AFTER a write was proposed but BEFORE it is confirmed
// uniformly refuses the confirm ("writes_disabled") for every provider —
// nextcloud, google, apple, imap, and immich alike — even though only
// nextcloud's executor additionally re-checks this itself (that check is now
// redundant defense-in-depth, not the only line of defense). See the
// "point 1b" describe block below.
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import {
	buildWritePreview,
	idempotencyKey,
	resolveWriteTarget,
	type WriteOperation,
} from "$lib/server/services/connections/write-guard";

const mocks = vi.hoisted(() => ({
	googleRefreshAccessToken: vi.fn(),
}));

vi.mock("$lib/server/services/connections/providers/google", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/server/services/connections/providers/google")
	>("$lib/server/services/connections/providers/google");
	return {
		...actual,
		googleRefreshAccessToken: mocks.googleRefreshAccessToken,
	};
});

let dbPath: string;
let sqlite: Database.Database;

vi.mock("$lib/server/db", () => ({
	get db() {
		return drizzle(sqlite, { schema });
	},
}));

const USER_ID = "user-1";

function seedUser() {
	const db = drizzle(sqlite, { schema });
	const now = new Date();
	db.insert(schema.users)
		.values({
			id: USER_ID,
			email: `${USER_ID}@example.com`,
			passwordHash: "hash",
			createdAt: now,
			updatedAt: now,
		})
		.run();
}

beforeEach(() => {
	dbPath = `./data/test-cross-cutting-write-safety-${randomUUID()}.db`;
	sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	migrate(drizzle(sqlite, { schema }), { migrationsFolder: "./drizzle" });
	seedUser();
	mocks.googleRefreshAccessToken.mockReset();
	mocks.googleRefreshAccessToken.mockResolvedValue("fresh-access-token");
});

afterEach(() => {
	sqlite.close();
	try {
		unlinkSync(dbPath);
	} catch {
		// best effort
	}
});

function jsonResponse(
	status: number,
	body: unknown,
	headers?: HeadersInit,
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

async function seedConnection(params: {
	provider: "nextcloud" | "google" | "apple" | "imap" | "immich";
	allowWrites?: boolean;
	writeAllowlist?: string[];
	config?: Record<string, unknown>;
	secret?: string;
	writeSecret?: string;
}): Promise<string> {
	const { createConnection, setConnectionWriteSecret } = await import(
		"$lib/server/services/connections/store"
	);
	const conn = await createConnection({
		userId: USER_ID,
		provider: params.provider,
		label: params.provider,
		accountIdentifier: "alice",
		capabilities: [
			params.provider === "nextcloud"
				? "files"
				: params.provider === "immich"
					? "photos"
					: params.provider === "imap"
						? "email"
						: "calendar",
		],
		status: "connected",
		secret: params.secret ?? "secret-value",
		allowWrites: params.allowWrites ?? true,
		writeAllowlist: params.writeAllowlist ?? [],
		config: params.config ?? {},
	});
	if (params.writeSecret) {
		await setConnectionWriteSecret(USER_ID, conn.id, params.writeSecret);
	}
	return conn.id;
}

// Shared by point 1's allowWrites-off-at-confirm assertions and point 2's
// confirm-executes-exactly-once assertions below — both need to seed a
// pending row via the real createPendingWrite before exercising confirm.
async function createPendingRow(
	provider: string,
	connectionId: string,
	op: WriteOperation,
	content: string,
) {
	const { createPendingWrite } = await import(
		"$lib/server/services/connections/pending-writes"
	);
	return createPendingWrite(USER_ID, {
		connectionId,
		provider,
		op,
		content,
		idempotencyKey: idempotencyKey(op),
		preview: buildWritePreview(op),
	});
}

async function executorFor(provider: string) {
	// Importing pending-writes.ts runs every provider write module's
	// registerWriteExecutor side effect (mirrors production — see
	// pending-writes.ts's own doc comment on those side-effect imports).
	await import("$lib/server/services/connections/pending-writes");
	const { getWriteExecutor } = await import(
		"$lib/server/services/connections/write-executors"
	);
	const executor = getWriteExecutor(provider);
	if (!executor) throw new Error(`No "${provider}" write executor registered`);
	return executor;
}

// ---------------------------------------------------------------------------
// Point 1 — allow_writes=false -> refused, no pending row. Every tool's
// write dispatcher checks `conn.allowWrites !== true` as its FIRST gate,
// before any connector read or pending-write creation (calendar.ts:~1062,
// email.ts:~654, photos.ts:~362, files.ts:~326) — exercised here directly
// against the real store + real pending-writes table, no provider network
// mocking needed since the gate trips before any network call would happen.
// ---------------------------------------------------------------------------
describe("write-safety point 1 — allow_writes=false refuses, no pending row", () => {
	it("nextcloud (files.save): refused, no pending row", async () => {
		const connectionId = await seedConnection({
			provider: "nextcloud",
			allowWrites: false,
			config: { serverUrl: "https://cloud.example.com", loginName: "alice" },
		});
		const { runFilesTool } = await import(
			"$lib/server/services/normal-chat-tools/files"
		);
		const outcome = await runFilesTool(
			USER_ID,
			{ action: "save", path: "/AlfyAI/note.txt", content: "hi" },
			"model1",
		);
		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toMatch(/turned off/i);

		const { listPendingWritesForConversation } = await import(
			"$lib/server/services/connections/pending-writes"
		);
		expect(
			await listPendingWritesForConversation(USER_ID, connectionId),
		).toEqual([]);
	});

	it("google (calendar.create_event): refused, no pending row", async () => {
		await seedConnection({
			provider: "google",
			allowWrites: false,
			config: {},
		});
		const { runCalendarTool } = await import(
			"$lib/server/services/normal-chat-tools/calendar"
		);
		const outcome = await runCalendarTool(
			USER_ID,
			{
				action: "create_event",
				title: "Standup",
				start: "2026-07-10T09:00:00Z",
				end: "2026-07-10T09:30:00Z",
			},
			"model1",
		);
		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.pendingWriteId).toBeUndefined();
	});

	it("imap (email.send): refused, no pending row", async () => {
		await seedConnection({
			provider: "imap",
			allowWrites: false,
			config: {
				email: "alice@example.com",
				imapHost: "imap.example.com",
				imapPort: 993,
				imapSecure: true,
				smtpHost: "smtp.example.com",
				smtpPort: 587,
			},
		});
		const { runEmailTool } = await import(
			"$lib/server/services/normal-chat-tools/email"
		);
		const outcome = await runEmailTool(
			USER_ID,
			{
				action: "send",
				to: "bob@example.com",
				subject: "Hi",
				body: "Hello",
			},
			"model1",
		);
		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.pendingWriteId).toBeUndefined();
	});

	it("immich (photos.add_to_album): refused, no pending row", async () => {
		await seedConnection({
			provider: "immich",
			allowWrites: false,
			config: { origin: "https://photos.example.com" },
		});
		const { runPhotosTool } = await import(
			"$lib/server/services/normal-chat-tools/photos"
		);
		const outcome = await runPhotosTool(
			USER_ID,
			{ action: "add_to_album", assetIds: ["asset-1"] },
			"model1",
		);
		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.pendingWriteId).toBeUndefined();
	});

	it("nextcloud executor also re-checks allowWrites at execute time (defense-in-depth) — writes_disabled, no fetch", async () => {
		const connectionId = await seedConnection({
			provider: "nextcloud",
			allowWrites: false,
			config: { serverUrl: "https://cloud.example.com", loginName: "alice" },
		});
		const fetchSpy = vi.fn();
		const executor = await executorFor("nextcloud");
		const op: WriteOperation = {
			provider: "nextcloud",
			connectionId,
			action: "files.put",
			summary: "Save note.txt",
			reversible: true,
			destructive: false,
			target: { path: "/AlfyAI/note.txt" },
		};
		const result = await executor.execute(USER_ID, connectionId, op, "hi", {
			fetch: fetchSpy as unknown as typeof fetch,
		});
		expect(result).toEqual({ ok: false, reason: "writes_disabled" });
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Point 1b — the second half of point 1's invariant: allowWrites=false must
// refuse a write EVEN IF it was already proposed (a PENDING row exists) while
// allowWrites was still true. Table-driven across all five providers against
// the REAL confirmPendingWrite chokepoint (pending-writes.ts) — not the
// executor directly — because the fix lives in the chokepoint, uniform for
// every provider present and future, not duplicated per executor.
// ---------------------------------------------------------------------------
describe("write-safety point 1b — allowWrites flipped off after propose, before confirm — confirmPendingWrite refuses uniformly for every provider", () => {
	async function disableWritesAndConfirm(
		userId: string,
		connectionId: string,
		pendingId: string,
	) {
		const { setAllowWrites } = await import(
			"$lib/server/services/connections/store"
		);
		// Simulate the user flipping "allow writes" off AFTER propose but
		// BEFORE confirm.
		await setAllowWrites(userId, connectionId, false);

		const { confirmPendingWrite, getPendingWrite } = await import(
			"$lib/server/services/connections/pending-writes"
		);
		const result = await confirmPendingWrite(userId, pendingId);
		const stillPending = await getPendingWrite(userId, pendingId);
		return { result, stillPending };
	}

	it("nextcloud: writes_disabled, no fetch, row stays pending (never claimed)", async () => {
		const connectionId = await seedConnection({
			provider: "nextcloud",
			config: { serverUrl: "https://cloud.example.com", loginName: "alice" },
			writeAllowlist: ["/AlfyAI"],
		});
		const op: WriteOperation = {
			provider: "nextcloud",
			connectionId,
			action: "files.put",
			summary: "Save note.txt",
			reversible: true,
			destructive: false,
			target: { path: "/AlfyAI/note.txt" },
		};
		const fetchSpy = vi.fn(
			async () =>
				new Response(null, { status: 201, headers: { ETag: '"e1"' } }),
		);
		globalThis.fetch = fetchSpy as unknown as typeof fetch;

		const created = await createPendingRow("nextcloud", connectionId, op, "hi");
		const { result, stillPending } = await disableWritesAndConfirm(
			USER_ID,
			connectionId,
			created.id,
		);
		expect(result).toEqual({
			ok: false,
			status: 409,
			reason: "writes_disabled",
		});
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(stillPending?.status).toBe("pending");
	});

	it("google: writes_disabled, no fetch, row stays pending (never claimed)", async () => {
		const connectionId = await seedConnection({ provider: "google" });
		const op: WriteOperation = {
			provider: "google",
			connectionId,
			action: "calendar.create_event",
			summary: "Create Standup",
			reversible: true,
			destructive: false,
			target: { label: "Standup" },
		};
		const fetchSpy = vi.fn(async () => jsonResponse(200, { etag: '"e1"' }));
		globalThis.fetch = fetchSpy as unknown as typeof fetch;

		const created = await createPendingRow(
			"google",
			connectionId,
			op,
			JSON.stringify({ calendarId: "primary", event: { summary: "Standup" } }),
		);
		const { result, stillPending } = await disableWritesAndConfirm(
			USER_ID,
			connectionId,
			created.id,
		);
		expect(result).toEqual({
			ok: false,
			status: 409,
			reason: "writes_disabled",
		});
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(stillPending?.status).toBe("pending");
	});

	it("apple: writes_disabled, no fetch, row stays pending (never claimed)", async () => {
		const connectionId = await seedConnection({
			provider: "apple",
			config: { calendarUrls: ["https://caldav.icloud.com/1/cal/"] },
		});
		const op: WriteOperation = {
			provider: "apple",
			connectionId,
			action: "calendar.create_event",
			summary: "Create Standup",
			reversible: false,
			destructive: false,
			target: { label: "Standup" },
		};
		const fetchSpy = vi.fn(
			async () =>
				new Response(null, { status: 201, headers: { ETag: '"e1"' } }),
		);
		globalThis.fetch = fetchSpy as unknown as typeof fetch;

		const created = await createPendingRow(
			"apple",
			connectionId,
			op,
			JSON.stringify({
				calendarUrl: "https://caldav.icloud.com/1/cal/",
				event: { summary: "Standup" },
			}),
		);
		const { result, stillPending } = await disableWritesAndConfirm(
			USER_ID,
			connectionId,
			created.id,
		);
		expect(result).toEqual({
			ok: false,
			status: 409,
			reason: "writes_disabled",
		});
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(stillPending?.status).toBe("pending");
	});

	it("immich: writes_disabled, no fetch, row stays pending (never claimed)", async () => {
		const connectionId = await seedConnection({
			provider: "immich",
			config: { origin: "https://photos.example.com" },
			writeSecret: "write-key",
		});
		const op: WriteOperation = {
			provider: "immich",
			connectionId,
			action: "immich.add_to_album",
			summary: 'Add 1 photo to the "AlfyAI" album',
			reversible: true,
			destructive: false,
			target: { label: "AlfyAI album" },
		};
		const fetchSpy = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/api/albums") && init?.method === "GET") {
					return jsonResponse(200, []);
				}
				if (url.endsWith("/api/albums") && init?.method === "POST") {
					return jsonResponse(200, { id: "album-1" });
				}
				return jsonResponse(200, [{ id: "asset-1", success: true }]);
			},
		);
		globalThis.fetch = fetchSpy as unknown as typeof fetch;

		const created = await createPendingRow(
			"immich",
			connectionId,
			op,
			JSON.stringify({ assetIds: ["asset-1"], albumName: "AlfyAI" }),
		);
		const { result, stillPending } = await disableWritesAndConfirm(
			USER_ID,
			connectionId,
			created.id,
		);
		expect(result).toEqual({
			ok: false,
			status: 409,
			reason: "writes_disabled",
		});
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(stillPending?.status).toBe("pending");
	});

	it("imap: writes_disabled, executor's createClient never invoked, row stays pending (never claimed)", async () => {
		const connectionId = await seedConnection({
			provider: "imap",
			config: {
				email: "alice@example.com",
				imapHost: "imap.example.com",
				imapPort: 993,
				imapSecure: true,
			},
		});
		const op: WriteOperation = {
			provider: "imap",
			connectionId,
			action: "email.trash",
			summary: "Move message to Trash",
			reversible: true,
			destructive: true,
			target: { id: "42" },
		};
		const connectSpy = vi.fn();
		const createClient = () =>
			({
				connect: async () => {
					connectSpy();
				},
				logout: async () => {},
				close: async () => {},
				mailboxOpen: async () => ({}),
				list: async () => [
					{ path: "Trash", name: "Trash", specialUse: "\\Trash" },
				],
				messageMove: async () => ({ path: "Trash" }),
				messageFlagsAdd: async () => true,
				messageFlagsRemove: async () => true,
				usable: true,
				authenticated: true,
				// biome-ignore lint/suspicious/noExplicitAny: minimal fake client
			}) as any;

		const created = await createPendingRow(
			"imap",
			connectionId,
			op,
			JSON.stringify({ uid: 42 }),
		);

		const { setAllowWrites } = await import(
			"$lib/server/services/connections/store"
		);
		await setAllowWrites(USER_ID, connectionId, false);

		const { confirmPendingWrite, getPendingWrite } = await import(
			"$lib/server/services/connections/pending-writes"
		);
		const result = await confirmPendingWrite(USER_ID, created.id, {
			// @ts-expect-error — see point 2's imap test for why this widening
			// is expected (confirmPendingWrite's declared opts type is the
			// narrower shared WriteExecutor shape; imap's registered execute
			// structurally accepts this wider ImapWriteOpt).
			createClient,
		});
		expect(result).toEqual({
			ok: false,
			status: 409,
			reason: "writes_disabled",
		});
		expect(connectSpy).not.toHaveBeenCalled();
		expect((await getPendingWrite(USER_ID, created.id))?.status).toBe(
			"pending",
		);
	});
});

// ---------------------------------------------------------------------------
// Point 2 — no execution without confirm. Table-driven across all five
// providers: createPendingWrite never touches the network; only
// confirmPendingWrite (via the REAL registered executor, mocked network)
// does. Also proves the atomic once-only claim (closing the loop with point
// 7's idempotent-retry guarantee) end-to-end against a REAL provider rather
// than the fake-executor proof in pending-writes.write-executor-dispatch
// .test.ts.
// ---------------------------------------------------------------------------
describe("write-safety point 2 — pending row created, nothing executes until confirm", () => {
	it("nextcloud: pending row stays pending until confirm; confirm executes exactly once", async () => {
		const connectionId = await seedConnection({
			provider: "nextcloud",
			config: { serverUrl: "https://cloud.example.com", loginName: "alice" },
			writeAllowlist: ["/AlfyAI"],
		});
		const op: WriteOperation = {
			provider: "nextcloud",
			connectionId,
			action: "files.put",
			summary: "Save note.txt",
			reversible: true,
			destructive: false,
			target: { path: "/AlfyAI/note.txt" },
		};
		const fetchSpy = vi.fn(
			async () =>
				new Response(null, { status: 201, headers: { ETag: '"e1"' } }),
		);
		globalThis.fetch = fetchSpy as unknown as typeof fetch;

		const created = await createPendingRow("nextcloud", connectionId, op, "hi");
		expect(fetchSpy).not.toHaveBeenCalled();

		const { confirmPendingWrite, getPendingWrite } = await import(
			"$lib/server/services/connections/pending-writes"
		);
		const result = await confirmPendingWrite(USER_ID, created.id);
		expect(result.ok).toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect((await getPendingWrite(USER_ID, created.id))?.status).toBe(
			"executed",
		);

		// A second confirm short-circuits to already-executed — no second fetch.
		await confirmPendingWrite(USER_ID, created.id);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("google: pending row stays pending until confirm; a losing concurrent confirm never executes", async () => {
		const connectionId = await seedConnection({ provider: "google" });
		const op: WriteOperation = {
			provider: "google",
			connectionId,
			action: "calendar.create_event",
			summary: "Create Standup",
			reversible: true,
			destructive: false,
			target: { label: "Standup" },
		};
		const fetchSpy = vi.fn(async () => jsonResponse(200, { etag: '"e1"' }));
		globalThis.fetch = fetchSpy as unknown as typeof fetch;

		const created = await createPendingRow(
			"google",
			connectionId,
			op,
			JSON.stringify({ calendarId: "primary", event: { summary: "Standup" } }),
		);
		expect(fetchSpy).not.toHaveBeenCalled();

		const { confirmPendingWrite, claimPendingWrite } = await import(
			"$lib/server/services/connections/pending-writes"
		);
		// Simulate a race: claim the row directly (as a concurrent winner
		// would), then prove a second confirm refuses without executing.
		expect(await claimPendingWrite(USER_ID, created.id)).toBe(true);
		const losing = await confirmPendingWrite(USER_ID, created.id);
		expect(losing.ok).toBe(false);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("apple: pending row stays pending until confirm", async () => {
		const connectionId = await seedConnection({
			provider: "apple",
			config: { calendarUrls: ["https://caldav.icloud.com/1/cal/"] },
		});
		const op: WriteOperation = {
			provider: "apple",
			connectionId,
			action: "calendar.create_event",
			summary: "Create Standup",
			reversible: false,
			destructive: false,
			target: { label: "Standup" },
		};
		const fetchSpy = vi.fn(
			async () =>
				new Response(null, { status: 201, headers: { ETag: '"e1"' } }),
		);
		globalThis.fetch = fetchSpy as unknown as typeof fetch;

		const created = await createPendingRow(
			"apple",
			connectionId,
			op,
			JSON.stringify({
				calendarUrl: "https://caldav.icloud.com/1/cal/",
				event: { summary: "Standup" },
			}),
		);
		expect(fetchSpy).not.toHaveBeenCalled();

		const { confirmPendingWrite } = await import(
			"$lib/server/services/connections/pending-writes"
		);
		const result = await confirmPendingWrite(USER_ID, created.id);
		expect(result.ok).toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("immich: pending row stays pending until confirm", async () => {
		const connectionId = await seedConnection({
			provider: "immich",
			config: { origin: "https://photos.example.com" },
			writeSecret: "write-key",
		});
		const op: WriteOperation = {
			provider: "immich",
			connectionId,
			action: "immich.add_to_album",
			summary: 'Add 1 photo to the "AlfyAI" album',
			reversible: true,
			destructive: false,
			target: { label: "AlfyAI album" },
		};
		const fetchSpy = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/api/albums") && init?.method === "GET") {
					return jsonResponse(200, []);
				}
				if (url.endsWith("/api/albums") && init?.method === "POST") {
					return jsonResponse(200, { id: "album-1" });
				}
				return jsonResponse(200, [{ id: "asset-1", success: true }]);
			},
		);
		globalThis.fetch = fetchSpy as unknown as typeof fetch;

		const created = await createPendingRow(
			"immich",
			connectionId,
			op,
			JSON.stringify({ assetIds: ["asset-1"], albumName: "AlfyAI" }),
		);
		expect(fetchSpy).not.toHaveBeenCalled();

		const { confirmPendingWrite } = await import(
			"$lib/server/services/connections/pending-writes"
		);
		const result = await confirmPendingWrite(USER_ID, created.id);
		expect(result.ok).toBe(true);
		expect(fetchSpy).toHaveBeenCalled();
	});

	it("imap: pending row stays pending until confirm (email.trash)", async () => {
		const connectionId = await seedConnection({
			provider: "imap",
			config: {
				email: "alice@example.com",
				imapHost: "imap.example.com",
				imapPort: 993,
				imapSecure: true,
			},
		});
		const op: WriteOperation = {
			provider: "imap",
			connectionId,
			action: "email.trash",
			summary: "Move message to Trash",
			reversible: true,
			destructive: true,
			target: { id: "42" },
		};
		const connectSpy = vi.fn();
		const createClient = () =>
			({
				connect: async () => {
					connectSpy();
				},
				logout: async () => {},
				close: async () => {},
				mailboxOpen: async () => ({}),
				list: async () => [
					{ path: "Trash", name: "Trash", specialUse: "\\Trash" },
				],
				messageMove: async () => ({ path: "Trash" }),
				messageFlagsAdd: async () => true,
				messageFlagsRemove: async () => true,
				// Deliberately no `noop`/network methods beyond what's used.
				usable: true,
				authenticated: true,
				// biome-ignore lint/suspicious/noExplicitAny: minimal fake client
			}) as any;

		const created = await createPendingRow(
			"imap",
			connectionId,
			op,
			JSON.stringify({ uid: 42 }),
		);
		expect(connectSpy).not.toHaveBeenCalled();

		const { confirmPendingWrite } = await import(
			"$lib/server/services/connections/pending-writes"
		);
		const result = await confirmPendingWrite(USER_ID, created.id, {
			// @ts-expect-error — confirmPendingWrite's declared opts type is the
			// narrower shared WriteExecutor shape; imap's registered execute
			// structurally accepts this wider ImapWriteOpt (see imap-write.ts's
			// own test file for the same widening).
			createClient,
		});
		expect(result.ok).toBe(true);
		expect(connectSpy).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// Point 3 — unspecified destination lands in the safe default area.
// ---------------------------------------------------------------------------
describe("write-safety point 3 — unspecified destination -> safe default", () => {
	it("nextcloud: resolveWriteTarget with no requestedPath -> the connection's allowlist root", () => {
		const result = resolveWriteTarget({
			allowlist: ["/AlfyAI"],
			defaultArea: "/AlfyAI",
		});
		expect(result).toEqual({ path: "/AlfyAI", withinAllowlist: true });
	});

	it("nextcloud end-to-end: a put with no requestedPath PUTs under the allowlist root", async () => {
		const connectionId = await seedConnection({
			provider: "nextcloud",
			config: { serverUrl: "https://cloud.example.com", loginName: "alice" },
			writeAllowlist: ["/AlfyAI"],
		});
		let putUrl = "";
		const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
			putUrl = String(input);
			return new Response(null, { status: 201, headers: { ETag: '"e1"' } });
		});
		const executor = await executorFor("nextcloud");
		const op: WriteOperation = {
			provider: "nextcloud",
			connectionId,
			action: "files.put",
			summary: "Save note.txt",
			reversible: true,
			destructive: false,
		};
		const result = await executor.execute(USER_ID, connectionId, op, "hi", {
			fetch: fetchSpy as unknown as typeof fetch,
		});
		expect(result.ok).toBe(true);
		expect(putUrl).toBe(
			"https://cloud.example.com/remote.php/dav/files/alice/AlfyAI",
		);
	});

	it("immich: content.albumName is always the fixed 'AlfyAI' constant the tool supplies — never a caller-chosen area (N/A for a path allowlist)", async () => {
		const connectionId = await seedConnection({
			provider: "immich",
			config: { origin: "https://photos.example.com" },
			writeSecret: "write-key",
		});
		let createdAlbumName = "";
		const fetchSpy = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/api/albums") && init?.method === "GET") {
					return jsonResponse(200, []);
				}
				if (url.endsWith("/api/albums") && init?.method === "POST") {
					createdAlbumName = JSON.parse(String(init.body)).albumName;
					return jsonResponse(200, { id: "album-1" });
				}
				return jsonResponse(200, [{ id: "asset-1", success: true }]);
			},
		);
		const executor = await executorFor("immich");
		const op: WriteOperation = {
			provider: "immich",
			connectionId,
			action: "immich.add_to_album",
			summary: "Add to album",
			reversible: true,
			destructive: false,
		};
		await executor.execute(
			USER_ID,
			connectionId,
			op,
			JSON.stringify({ assetIds: ["asset-1"], albumName: "AlfyAI" }),
			{ fetch: fetchSpy as unknown as typeof fetch },
		);
		expect(createdAlbumName).toBe("AlfyAI");
	});

	it("google/apple/imap-send: N/A — no allowlist-area concept (asserted by inspection, not a runtime check)", () => {
		// Google: the write always targets `content.calendarId`, scoped by the
		// connection's own OAuth grant — there is no "area" a write could land
		// outside of within a single calendar id.
		// Apple: the write always targets `content.calendarUrl`, which the tool
		// only ever populates from `conn.config.calendarUrls` (the connection's
		// own stored calendar), never user input.
		// IMAP send: the "destination" is the recipient the user specified —
		// not a storage-area concept this checklist point is about.
		expect(true).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Point 4 — explicit path honored but flagged if outside allowlist
// (path-based providers only — nextcloud). N/A for google/apple/imap/immich
// (no path/destination-area concept — see point 3's N/A note).
// ---------------------------------------------------------------------------
describe("write-safety point 4 — explicit destination honored, flagged if outside allowlist (nextcloud only)", () => {
	it("resolveWriteTarget: an explicit path outside the allowlist is HONORED (not silently redirected) but reported withinAllowlist:false", () => {
		const result = resolveWriteTarget({
			allowlist: ["/AlfyAI"],
			requestedPath: "/Documents/secret.txt",
		});
		expect(result).toEqual({
			path: "/Documents/secret.txt",
			withinAllowlist: false,
		});
	});

	it("buildWritePreview surfaces an 'outside your allowed area' warning for that target", () => {
		const preview = buildWritePreview({
			provider: "nextcloud",
			connectionId: "conn-1",
			action: "files.put",
			summary: "Save secret.txt",
			reversible: true,
			destructive: false,
			target: { path: "/Documents/secret.txt", withinAllowlist: false },
		});
		expect(preview.withinAllowlist).toBe(false);
		expect(preview.warnings).toContain("Outside your allowed area");
	});

	it("end-to-end: executeNextcloudWrite PUTs to the exact explicit path even though it's outside the allowlist", async () => {
		const connectionId = await seedConnection({
			provider: "nextcloud",
			config: { serverUrl: "https://cloud.example.com", loginName: "alice" },
			writeAllowlist: ["/AlfyAI"],
		});
		let putUrl = "";
		const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
			putUrl = String(input);
			return new Response(null, { status: 201, headers: { ETag: '"e1"' } });
		});
		const executor = await executorFor("nextcloud");
		const op: WriteOperation = {
			provider: "nextcloud",
			connectionId,
			action: "files.put",
			summary: "Save secret.txt",
			reversible: true,
			destructive: false,
			target: { path: "/Documents/secret.txt" },
		};
		const result = await executor.execute(USER_ID, connectionId, op, "hi", {
			fetch: fetchSpy as unknown as typeof fetch,
		});
		expect(result.ok).toBe(true);
		expect(putUrl).toBe(
			"https://cloud.example.com/remote.php/dav/files/alice/Documents/secret.txt",
		);
	});
});

// ---------------------------------------------------------------------------
// Point 5 — overwrite requires If-Match/etag and refuses on mismatch.
// ---------------------------------------------------------------------------
describe("write-safety point 5 — conditional overwrite refuses on mismatch", () => {
	it("nextcloud: a 412 from a conditional PUT (If-Match) maps to etag_mismatch, never falls back unconditionally", async () => {
		const connectionId = await seedConnection({
			provider: "nextcloud",
			config: { serverUrl: "https://cloud.example.com", loginName: "alice" },
			writeAllowlist: ["/AlfyAI"],
		});
		const fetchSpy = vi.fn(async () => new Response(null, { status: 412 }));
		const executor = await executorFor("nextcloud");
		const op: WriteOperation = {
			provider: "nextcloud",
			connectionId,
			action: "files.put",
			summary: "Update note.txt",
			reversible: true,
			destructive: true,
			target: { path: "/AlfyAI/note.txt" },
			payloadFingerprint: "ifmatch-test",
		};
		const result = await executor.execute(USER_ID, connectionId, op, "hi", {
			fetch: fetchSpy as unknown as typeof fetch,
		});
		expect(result).toEqual({ ok: false, reason: "etag_mismatch" });
	});

	it("apple: create uses If-None-Match:*, update/delete use If-Match — a 412 on update maps to conflict_changed, never overwritten unconditionally", async () => {
		const connectionId = await seedConnection({
			provider: "apple",
			config: { calendarUrls: ["https://caldav.icloud.com/1/cal/"] },
		});
		let sawIfMatch: string | null = null;
		const fetchSpy = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				sawIfMatch =
					(init?.headers as Record<string, string> | undefined)?.["If-Match"] ??
					null;
				return new Response(null, { status: 412 });
			},
		);
		const executor = await executorFor("apple");
		const op: WriteOperation = {
			provider: "apple",
			connectionId,
			action: "calendar.update_event",
			summary: "Update Standup",
			reversible: false,
			destructive: true,
			target: { id: "evt-1", label: "Standup" },
		};
		const result = await executor.execute(
			USER_ID,
			connectionId,
			op,
			JSON.stringify({
				resourceHref: "https://caldav.icloud.com/1/cal/evt-1.ics",
				etag: '"stale-etag"',
				uid: "evt-1",
				originalIcs:
					"BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:evt-1\r\nSUMMARY:Standup\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
				event: { summary: "Standup 2" },
			}),
			{ fetch: fetchSpy as unknown as typeof fetch },
		);
		expect(result).toEqual({ ok: false, reason: "conflict_changed" });
		expect(sawIfMatch).toBe('"stale-etag"');
	});

	// See the file-header note: this is the CURRENT, DELIBERATE behavior — not
	// asserted as `it.fails`, because it correctly reflects the documented
	// design (Google's PATCH is a partial update, no conditional header is
	// sent at all) rather than a bug to pin as a gap.
	it("google (documented N/A/current-behavior): update_event PATCHes unconditionally — no If-Match header is ever sent", async () => {
		const connectionId = await seedConnection({ provider: "google" });
		let sawHeaders: Record<string, string> = {};
		const fetchSpy = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				sawHeaders = (init?.headers as Record<string, string>) ?? {};
				return jsonResponse(200, { etag: '"whatever"' });
			},
		);
		const executor = await executorFor("google");
		const op: WriteOperation = {
			provider: "google",
			connectionId,
			action: "calendar.update_event",
			summary: "Update Standup",
			reversible: true,
			destructive: true,
			target: { id: "evt-1", label: "Standup" },
		};
		const result = await executor.execute(
			USER_ID,
			connectionId,
			op,
			JSON.stringify({ calendarId: "primary", eventId: "evt-1", event: {} }),
			{ fetch: fetchSpy as unknown as typeof fetch },
		);
		expect(result.ok).toBe(true);
		expect(Object.keys(sawHeaders)).not.toContain("If-Match");
	});

	it("immich (N/A): add-to-album is purely additive, never an overwrite — a duplicate-asset entry in the response is still ok:true", async () => {
		const connectionId = await seedConnection({
			provider: "immich",
			config: { origin: "https://photos.example.com", immichUserId: "owner-1" },
			writeSecret: "write-key",
		});
		const fetchSpy = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/api/albums") && init?.method === "GET") {
					// Album must be owned by the connection's own Immich user — the
					// add-to-album path now refuses to write into a same-named album
					// owned by someone else (a shared album).
					return jsonResponse(200, [
						{ id: "album-1", albumName: "AlfyAI", ownerId: "owner-1" },
					]);
				}
				// Immich reports a per-asset {success:false, error:"duplicate"} for
				// an asset already in the album — the module treats a non-2xx status
				// as the only failure signal, so this 200 is success regardless.
				return jsonResponse(200, [
					{ id: "asset-1", success: false, error: "duplicate" },
				]);
			},
		);
		const executor = await executorFor("immich");
		const op: WriteOperation = {
			provider: "immich",
			connectionId,
			action: "immich.add_to_album",
			summary: "Add to album",
			reversible: true,
			destructive: false,
		};
		const result = await executor.execute(
			USER_ID,
			connectionId,
			op,
			JSON.stringify({ assetIds: ["asset-1"], albumName: "AlfyAI" }),
			{ fetch: fetchSpy as unknown as typeof fetch },
		);
		expect(result.ok).toBe(true);
	});

	it("imap-send (N/A): sending is a fresh message, not an overwrite of existing connector data", () => {
		expect(true).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Point 6 — delete is reversible, or hard-delete still requires confirm.
// ---------------------------------------------------------------------------
describe("write-safety point 6 — delete is reversible / hard-delete is confirm-gated", () => {
	it("imap: trash MOVES to the resolved Trash mailbox — the fake client has NO expunge method at all, so a permanent delete is structurally impossible here", async () => {
		const connectionId = await seedConnection({
			provider: "imap",
			config: {
				email: "alice@example.com",
				imapHost: "imap.example.com",
				imapPort: 993,
				imapSecure: true,
			},
		});
		const moveCalls: { range: unknown; destination: string }[] = [];
		const createClient = () =>
			({
				connect: async () => {},
				logout: async () => {},
				close: async () => {},
				mailboxOpen: async () => ({}),
				list: async () => [
					{ path: "Trash", name: "Trash", specialUse: "\\Trash" },
				],
				messageMove: async (range: unknown, destination: string) => {
					moveCalls.push({ range, destination });
					return { path: destination };
				},
				// biome-ignore lint/suspicious/noExplicitAny: minimal fake client
			}) as any;

		const executor = await executorFor("imap");
		const op: WriteOperation = {
			provider: "imap",
			connectionId,
			action: "email.trash",
			summary: "Move to Trash",
			reversible: true,
			destructive: true,
			target: { id: "42" },
		};
		const result = await executor.execute(
			USER_ID,
			connectionId,
			op,
			JSON.stringify({ uid: 42 }),
			// @ts-expect-error — see the point-2 imap test's comment.
			{ createClient },
		);
		expect(result.ok).toBe(true);
		expect(moveCalls).toEqual([{ range: [42], destination: "Trash" }]);
		expect("expunge" in createClient()).toBe(false);
	});

	it("imap: refuses (no_trash_folder) rather than falling back to a permanent delete when no Trash mailbox exists", async () => {
		const connectionId = await seedConnection({
			provider: "imap",
			config: {
				email: "alice@example.com",
				imapHost: "imap.example.com",
				imapPort: 993,
				imapSecure: true,
			},
		});
		const createClient = () =>
			({
				connect: async () => {},
				logout: async () => {},
				close: async () => {},
				mailboxOpen: async () => ({}),
				list: async () => [],
				messageMove: async () => ({ path: "x" }),
				// biome-ignore lint/suspicious/noExplicitAny: minimal fake client
			}) as any;
		const executor = await executorFor("imap");
		const op: WriteOperation = {
			provider: "imap",
			connectionId,
			action: "email.trash",
			summary: "Move to Trash",
			reversible: true,
			destructive: true,
			target: { id: "42" },
		};
		const result = await executor.execute(
			USER_ID,
			connectionId,
			op,
			JSON.stringify({ uid: 42 }),
			// @ts-expect-error — see the point-2 imap test's comment.
			{ createClient },
		);
		expect(result).toEqual({ ok: false, reason: "no_trash_folder" });
	});

	it("nextcloud: delete issues a plain WebDAV DELETE, never a permanent-purge parameter — Nextcloud's own server-side trash is the safety net", async () => {
		const connectionId = await seedConnection({
			provider: "nextcloud",
			config: { serverUrl: "https://cloud.example.com", loginName: "alice" },
			writeAllowlist: ["/AlfyAI"],
		});
		let sawMethod = "";
		let sawUrl = "";
		const fetchSpy = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				sawUrl = String(input);
				sawMethod = init?.method ?? "";
				return new Response(null, { status: 204 });
			},
		);
		const { nextcloudDeleteFile } = await import(
			"$lib/server/services/connections/providers/nextcloud-files"
		);
		const { getConnection, getConnectionSecret } = await import(
			"$lib/server/services/connections/store"
		);
		const conn = await getConnection(USER_ID, connectionId);
		const secret = await getConnectionSecret(USER_ID, connectionId);
		if (!conn || !secret) throw new Error("seed failed");
		await nextcloudDeleteFile(conn, secret, "/AlfyAI/note.txt", {
			fetch: fetchSpy as unknown as typeof fetch,
		});
		expect(sawMethod).toBe("DELETE");
		expect(sawUrl).not.toContain("permanent");
	});

	it("google: delete is reversible (Google's own trash/history) — a 410 (already gone) is idempotent success, never re-surfaced as a failure", async () => {
		const connectionId = await seedConnection({ provider: "google" });
		const fetchSpy = vi.fn(async () => new Response(null, { status: 410 }));
		const executor = await executorFor("google");
		const op: WriteOperation = {
			provider: "google",
			connectionId,
			action: "calendar.delete_event",
			summary: "Delete Standup",
			reversible: true,
			destructive: true,
			target: { id: "evt-1", label: "Standup" },
		};
		const result = await executor.execute(
			USER_ID,
			connectionId,
			op,
			JSON.stringify({ calendarId: "primary", eventId: "evt-1" }),
			{ fetch: fetchSpy as unknown as typeof fetch },
		);
		expect(result).toEqual({ ok: true, detail: "already deleted" });
	});

	it("apple: delete/update is NOT platform-reversible (no iCloud trash exposed) — the write-guard preview surfaces that plainly, and the write still can't execute without explicit confirm (point 2)", () => {
		// Mirrors calendar.ts's own op construction for Apple delete/update:
		// reversible:false, destructive:true.
		const preview = buildWritePreview({
			provider: "apple",
			connectionId: "conn-1",
			action: "calendar.delete_event",
			summary: "Delete Standup",
			reversible: false,
			destructive: true,
			target: { id: "evt-1", label: "Standup" },
		});
		expect(preview.reversible).toBe(false);
		expect(preview.warnings).toContain(
			"This will overwrite/delete and may not be recoverable",
		);
	});

	it("immich: NO delete/remove code path exists at all — any action other than immich.add_to_album is refused as unsupported_operation", async () => {
		const connectionId = await seedConnection({
			provider: "immich",
			config: { origin: "https://photos.example.com" },
			writeSecret: "write-key",
		});
		const executor = await executorFor("immich");
		for (const action of [
			"immich.delete_asset",
			"immich.remove_from_album",
			"immich.delete_album",
		]) {
			const op: WriteOperation = {
				provider: "immich",
				connectionId,
				action,
				summary: "n/a",
				reversible: true,
				destructive: true,
			};
			const result = await executor.execute(
				USER_ID,
				connectionId,
				op,
				JSON.stringify({ assetIds: ["asset-1"], albumName: "AlfyAI" }),
				{ fetch: vi.fn() as unknown as typeof fetch },
			);
			expect(result).toEqual({ ok: false, reason: "unsupported_operation" });
		}
	});
});

// ---------------------------------------------------------------------------
// Point 7 — idempotent under retry.
// ---------------------------------------------------------------------------
describe("write-safety point 7 — idempotent under retry", () => {
	it("write-guard.idempotencyKey is stable for identical ops (shared by every provider's client-derived id)", () => {
		const op: WriteOperation = {
			provider: "nextcloud",
			connectionId: "conn-1",
			action: "files.put",
			summary: "Save note.txt",
			reversible: true,
			destructive: false,
			target: { path: "/AlfyAI/note.txt" },
		};
		expect(idempotencyKey(op)).toBe(idempotencyKey({ ...op }));
	});

	it("google: re-inserting the SAME client-derived event id (409) is idempotent success, not a double-create", async () => {
		const connectionId = await seedConnection({ provider: "google" });
		const fetchSpy = vi.fn(async () => new Response(null, { status: 409 }));
		const executor = await executorFor("google");
		const op: WriteOperation = {
			provider: "google",
			connectionId,
			action: "calendar.create_event",
			summary: "Create Standup",
			reversible: true,
			destructive: false,
			target: { label: "Standup" },
			payloadFingerprint: JSON.stringify({ summary: "Standup" }),
		};
		const result = await executor.execute(
			USER_ID,
			connectionId,
			op,
			JSON.stringify({ calendarId: "primary", event: { summary: "Standup" } }),
			{ fetch: fetchSpy as unknown as typeof fetch },
		);
		expect(result).toEqual({ ok: true, detail: "already created" });
	});

	it("apple: re-PUTting the SAME client-derived UID (412 on If-None-Match:*) is idempotent success, not a double-create", async () => {
		const connectionId = await seedConnection({
			provider: "apple",
			config: { calendarUrls: ["https://caldav.icloud.com/1/cal/"] },
		});
		const fetchSpy = vi.fn(async () => new Response(null, { status: 412 }));
		const executor = await executorFor("apple");
		const op: WriteOperation = {
			provider: "apple",
			connectionId,
			action: "calendar.create_event",
			summary: "Create Standup",
			reversible: false,
			destructive: false,
			target: { label: "Standup" },
		};
		const result = await executor.execute(
			USER_ID,
			connectionId,
			op,
			JSON.stringify({
				calendarUrl: "https://caldav.icloud.com/1/cal/",
				event: { summary: "Standup" },
			}),
			{ fetch: fetchSpy as unknown as typeof fetch },
		);
		expect(result).toEqual({ ok: true, detail: "already created" });
	});

	it("imap: imapMessageIdForOp derives the SAME Message-ID for the same WriteOperation — deterministic, not random", async () => {
		const { imapMessageIdForOp } = await import(
			"$lib/server/services/connections/providers/imap-write"
		);
		const op: WriteOperation = {
			provider: "imap",
			connectionId: "conn-1",
			action: "email.send",
			summary: "Send Hello",
			reversible: false,
			destructive: false,
			target: { label: "Hello -> bob@example.com" },
		};
		expect(imapMessageIdForOp(op)).toBe(imapMessageIdForOp({ ...op }));
	});

	it("immich: adding an already-present asset (duplicate) is idempotent success — see point 5's duplicate-asset test", () => {
		// Covered end-to-end under point 5 (the same fixture doubles as the
		// idempotency proof: a duplicate-asset response is `ok:true`, so a
		// retried confirm of the same add-to-album op never surfaces as a
		// failure).
		expect(true).toBe(true);
	});

	it("confirmPendingWrite: two REAL concurrent confirms against a real registered provider (nextcloud) execute at most once", async () => {
		const connectionId = await seedConnection({
			provider: "nextcloud",
			config: { serverUrl: "https://cloud.example.com", loginName: "alice" },
			writeAllowlist: ["/AlfyAI"],
		});
		const fetchSpy = vi.fn(
			async () =>
				new Response(null, { status: 201, headers: { ETag: '"e1"' } }),
		);
		globalThis.fetch = fetchSpy as unknown as typeof fetch;

		const { createPendingWrite, confirmPendingWrite } = await import(
			"$lib/server/services/connections/pending-writes"
		);
		const op: WriteOperation = {
			provider: "nextcloud",
			connectionId,
			action: "files.put",
			summary: "Save note.txt",
			reversible: true,
			destructive: false,
			target: { path: "/AlfyAI/note.txt" },
		};
		const created = await createPendingWrite(USER_ID, {
			connectionId,
			provider: "nextcloud",
			op,
			content: "hi",
			idempotencyKey: idempotencyKey(op),
			preview: buildWritePreview(op),
		});

		const results = await Promise.all([
			confirmPendingWrite(USER_ID, created.id),
			confirmPendingWrite(USER_ID, created.id),
		]);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(results.every((r) => r.ok || r.status === 409)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// GAP A1 — nextcloud files.move / files.delete are now reachable from the
// chat tool. They must obey the SAME two write invariants the "save" (files.
// put) action already does: (1) allow_writes=false refuses with NO pending
// row created, and (2) nothing executes at proposal time — the tool only ever
// creates a PENDING row, and the real MOVE/DELETE happens exclusively through
// confirmPendingWrite. Exercised end-to-end against the real store + real
// pending-writes table + the real registered nextcloud executor.
// ---------------------------------------------------------------------------
describe("write-safety GAP A1 — files.move / files.delete honor allowWrites + confirm-gating", () => {
	it("move: allow_writes=false refuses, no pending row created", async () => {
		await seedConnection({
			provider: "nextcloud",
			allowWrites: false,
			config: { serverUrl: "https://cloud.example.com", loginName: "alice" },
			writeAllowlist: ["/AlfyAI"],
		});
		const { runFilesTool } = await import(
			"$lib/server/services/normal-chat-tools/files"
		);
		const outcome = await runFilesTool(
			USER_ID,
			{
				action: "move",
				path: "/AlfyAI/a.txt",
				destinationPath: "/AlfyAI/b.txt",
			},
			"model1",
			"conv-1",
		);
		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toMatch(/turned off/i);

		const { listPendingWritesForConversation } = await import(
			"$lib/server/services/connections/pending-writes"
		);
		expect(await listPendingWritesForConversation(USER_ID, "conv-1")).toEqual(
			[],
		);
	});

	it("delete: allow_writes=false refuses, no pending row created", async () => {
		await seedConnection({
			provider: "nextcloud",
			allowWrites: false,
			config: { serverUrl: "https://cloud.example.com", loginName: "alice" },
			writeAllowlist: ["/AlfyAI"],
		});
		const { runFilesTool } = await import(
			"$lib/server/services/normal-chat-tools/files"
		);
		const outcome = await runFilesTool(
			USER_ID,
			{ action: "delete", path: "/AlfyAI/old.txt" },
			"model1",
			"conv-1",
		);
		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toMatch(/turned off/i);

		const { listPendingWritesForConversation } = await import(
			"$lib/server/services/connections/pending-writes"
		);
		expect(await listPendingWritesForConversation(USER_ID, "conv-1")).toEqual(
			[],
		);
	});

	it("move: proposal creates a PENDING row and touches no network; confirm issues exactly one MOVE", async () => {
		await seedConnection({
			provider: "nextcloud",
			config: { serverUrl: "https://cloud.example.com", loginName: "alice" },
			writeAllowlist: ["/AlfyAI"],
		});
		const fetchSpy = vi.fn(async () => new Response(null, { status: 201 }));
		globalThis.fetch = fetchSpy as unknown as typeof fetch;

		const { runFilesTool } = await import(
			"$lib/server/services/normal-chat-tools/files"
		);
		const outcome = await runFilesTool(
			USER_ID,
			{
				action: "move",
				path: "/AlfyAI/a.txt",
				destinationPath: "/AlfyAI/b.txt",
			},
			"model1",
		);
		expect(outcome.modelPayload.success).toBe(true);
		const pendingId = outcome.modelPayload.pendingWriteId;
		expect(pendingId).toBeDefined();
		// Nothing executed at proposal time.
		expect(fetchSpy).not.toHaveBeenCalled();

		const { confirmPendingWrite, getPendingWrite } = await import(
			"$lib/server/services/connections/pending-writes"
		);
		expect((await getPendingWrite(USER_ID, pendingId as string))?.status).toBe(
			"pending",
		);

		const result = await confirmPendingWrite(USER_ID, pendingId as string);
		expect(result.ok).toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(init.method).toBe("MOVE");
		expect(String(url)).toBe(
			"https://cloud.example.com/remote.php/dav/files/alice/AlfyAI/a.txt",
		);
		expect(new Headers(init.headers).get("Destination")).toBe(
			"https://cloud.example.com/remote.php/dav/files/alice/AlfyAI/b.txt",
		);
		expect((await getPendingWrite(USER_ID, pendingId as string))?.status).toBe(
			"executed",
		);
	});

	it("delete: proposal creates a PENDING row and touches no network; confirm issues exactly one DELETE (to trash, no permanent param)", async () => {
		await seedConnection({
			provider: "nextcloud",
			config: { serverUrl: "https://cloud.example.com", loginName: "alice" },
			writeAllowlist: ["/AlfyAI"],
		});
		const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
		globalThis.fetch = fetchSpy as unknown as typeof fetch;

		const { runFilesTool } = await import(
			"$lib/server/services/normal-chat-tools/files"
		);
		const outcome = await runFilesTool(
			USER_ID,
			{ action: "delete", path: "/AlfyAI/old.txt" },
			"model1",
		);
		expect(outcome.modelPayload.success).toBe(true);
		const pendingId = outcome.modelPayload.pendingWriteId;
		expect(pendingId).toBeDefined();
		expect(fetchSpy).not.toHaveBeenCalled();

		const { confirmPendingWrite, getPendingWrite } = await import(
			"$lib/server/services/connections/pending-writes"
		);
		const result = await confirmPendingWrite(USER_ID, pendingId as string);
		expect(result.ok).toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(init.method).toBe("DELETE");
		expect(String(url)).toBe(
			"https://cloud.example.com/remote.php/dav/files/alice/AlfyAI/old.txt",
		);
		expect(String(url)).not.toContain("permanent");
		expect((await getPendingWrite(USER_ID, pendingId as string))?.status).toBe(
			"executed",
		);
	});

	it("move: allowWrites flipped off AFTER propose, BEFORE confirm — confirm refuses, row stays pending, no network", async () => {
		const connectionId = await seedConnection({
			provider: "nextcloud",
			config: { serverUrl: "https://cloud.example.com", loginName: "alice" },
			writeAllowlist: ["/AlfyAI"],
		});
		const fetchSpy = vi.fn(async () => new Response(null, { status: 201 }));
		globalThis.fetch = fetchSpy as unknown as typeof fetch;

		const { runFilesTool } = await import(
			"$lib/server/services/normal-chat-tools/files"
		);
		const outcome = await runFilesTool(
			USER_ID,
			{
				action: "move",
				path: "/AlfyAI/a.txt",
				destinationPath: "/AlfyAI/b.txt",
			},
			"model1",
		);
		const pendingId = outcome.modelPayload.pendingWriteId as string;

		const { setAllowWrites } = await import(
			"$lib/server/services/connections/store"
		);
		await setAllowWrites(USER_ID, connectionId, false);

		const { confirmPendingWrite, getPendingWrite } = await import(
			"$lib/server/services/connections/pending-writes"
		);
		const result = await confirmPendingWrite(USER_ID, pendingId);
		expect(result).toEqual({
			ok: false,
			status: 409,
			reason: "writes_disabled",
		});
		expect(fetchSpy).not.toHaveBeenCalled();
		expect((await getPendingWrite(USER_ID, pendingId))?.status).toBe("pending");
	});
});

// ---------------------------------------------------------------------------
// GAP B9 — nextcloud files.create_folder (B9a) and files.share_link (B9b) are
// now reachable from the chat tool. They must obey the SAME two write
// invariants save/move/delete already do: (1) allow_writes=false refuses with
// NO pending row created, and (2) nothing executes at proposal time — the tool
// only ever creates a PENDING row, and the real MKCOL / OCS-share POST happens
// exclusively through confirmPendingWrite. share_link additionally CREATES
// PUBLIC EXPOSURE, so its confirm preview MUST carry a public-link warning.
// Exercised end-to-end against the real store + real pending-writes table +
// the real registered nextcloud executor.
// ---------------------------------------------------------------------------
describe("write-safety GAP B9 — files.create_folder / files.share_link honor allowWrites + confirm-gating", () => {
	it("create_folder: allow_writes=false refuses, no pending row created", async () => {
		await seedConnection({
			provider: "nextcloud",
			allowWrites: false,
			config: { serverUrl: "https://cloud.example.com", loginName: "alice" },
			writeAllowlist: ["/AlfyAI"],
		});
		const { runFilesTool } = await import(
			"$lib/server/services/normal-chat-tools/files"
		);
		const outcome = await runFilesTool(
			USER_ID,
			{ action: "create_folder", path: "/AlfyAI/Reports" },
			"model1",
			"conv-1",
		);
		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toMatch(/turned off/i);

		const { listPendingWritesForConversation } = await import(
			"$lib/server/services/connections/pending-writes"
		);
		expect(await listPendingWritesForConversation(USER_ID, "conv-1")).toEqual(
			[],
		);
	});

	it("share_link: allow_writes=false refuses, no pending row created", async () => {
		await seedConnection({
			provider: "nextcloud",
			allowWrites: false,
			config: { serverUrl: "https://cloud.example.com", loginName: "alice" },
			writeAllowlist: ["/AlfyAI"],
		});
		const { runFilesTool } = await import(
			"$lib/server/services/normal-chat-tools/files"
		);
		const outcome = await runFilesTool(
			USER_ID,
			{ action: "share_link", path: "/AlfyAI/report.pdf" },
			"model1",
			"conv-1",
		);
		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toMatch(/turned off/i);

		const { listPendingWritesForConversation } = await import(
			"$lib/server/services/connections/pending-writes"
		);
		expect(await listPendingWritesForConversation(USER_ID, "conv-1")).toEqual(
			[],
		);
	});

	it("create_folder: proposal creates a PENDING row and touches no network; confirm issues exactly one MKCOL", async () => {
		await seedConnection({
			provider: "nextcloud",
			config: { serverUrl: "https://cloud.example.com", loginName: "alice" },
			writeAllowlist: ["/AlfyAI"],
		});
		const fetchSpy = vi.fn(async () => new Response(null, { status: 201 }));
		globalThis.fetch = fetchSpy as unknown as typeof fetch;

		const { runFilesTool } = await import(
			"$lib/server/services/normal-chat-tools/files"
		);
		const outcome = await runFilesTool(
			USER_ID,
			{ action: "create_folder", path: "/AlfyAI/Reports" },
			"model1",
		);
		expect(outcome.modelPayload.success).toBe(true);
		const pendingId = outcome.modelPayload.pendingWriteId;
		expect(pendingId).toBeDefined();
		expect(fetchSpy).not.toHaveBeenCalled();

		const { confirmPendingWrite, getPendingWrite } = await import(
			"$lib/server/services/connections/pending-writes"
		);
		expect((await getPendingWrite(USER_ID, pendingId as string))?.status).toBe(
			"pending",
		);

		const result = await confirmPendingWrite(USER_ID, pendingId as string);
		expect(result.ok).toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(init.method).toBe("MKCOL");
		expect(String(url)).toBe(
			"https://cloud.example.com/remote.php/dav/files/alice/AlfyAI/Reports",
		);
		expect((await getPendingWrite(USER_ID, pendingId as string))?.status).toBe(
			"executed",
		);
	});

	it("share_link: proposal creates a PENDING row (with a public-link warning in the preview) and touches no network; confirm issues exactly one OCS share POST", async () => {
		await seedConnection({
			provider: "nextcloud",
			config: { serverUrl: "https://cloud.example.com", loginName: "alice" },
			writeAllowlist: ["/AlfyAI"],
		});
		const fetchSpy = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						ocs: {
							meta: { status: "ok", statuscode: 200 },
							data: { id: "1", url: "https://cloud.example.com/s/pub123" },
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);
		globalThis.fetch = fetchSpy as unknown as typeof fetch;

		const { runFilesTool } = await import(
			"$lib/server/services/normal-chat-tools/files"
		);
		const outcome = await runFilesTool(
			USER_ID,
			{ action: "share_link", path: "/AlfyAI/report.pdf" },
			"model1",
		);
		expect(outcome.modelPayload.success).toBe(true);
		const pendingId = outcome.modelPayload.pendingWriteId;
		expect(pendingId).toBeDefined();
		// The public-exposure warning is the load-bearing invariant for this
		// sensitive write — it MUST reach the confirm preview.
		expect(
			outcome.modelPayload.preview?.warnings.some((w) =>
				w.toLowerCase().includes("public"),
			),
		).toBe(true);
		expect(fetchSpy).not.toHaveBeenCalled();

		const { confirmPendingWrite, getPendingWrite } = await import(
			"$lib/server/services/connections/pending-writes"
		);
		const result = await confirmPendingWrite(USER_ID, pendingId as string);
		expect(result.ok).toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(init.method).toBe("POST");
		expect(String(url)).toContain(
			"/ocs/v2.php/apps/files_sharing/api/v1/shares",
		);
		expect(new Headers(init.headers).get("OCS-APIRequest")).toBe("true");
		expect(new URLSearchParams(String(init.body)).get("shareType")).toBe("3");
		expect((await getPendingWrite(USER_ID, pendingId as string))?.status).toBe(
			"executed",
		);
	});

	it("create_folder: allowWrites flipped off AFTER propose, BEFORE confirm — confirm refuses, row stays pending, no network", async () => {
		const connectionId = await seedConnection({
			provider: "nextcloud",
			config: { serverUrl: "https://cloud.example.com", loginName: "alice" },
			writeAllowlist: ["/AlfyAI"],
		});
		const fetchSpy = vi.fn(async () => new Response(null, { status: 201 }));
		globalThis.fetch = fetchSpy as unknown as typeof fetch;

		const { runFilesTool } = await import(
			"$lib/server/services/normal-chat-tools/files"
		);
		const outcome = await runFilesTool(
			USER_ID,
			{ action: "create_folder", path: "/AlfyAI/Reports" },
			"model1",
		);
		const pendingId = outcome.modelPayload.pendingWriteId as string;

		const { setAllowWrites } = await import(
			"$lib/server/services/connections/store"
		);
		await setAllowWrites(USER_ID, connectionId, false);

		const { confirmPendingWrite, getPendingWrite } = await import(
			"$lib/server/services/connections/pending-writes"
		);
		const result = await confirmPendingWrite(USER_ID, pendingId);
		expect(result).toEqual({
			ok: false,
			status: 409,
			reason: "writes_disabled",
		});
		expect(fetchSpy).not.toHaveBeenCalled();
		expect((await getPendingWrite(USER_ID, pendingId))?.status).toBe("pending");
	});
});
