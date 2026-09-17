import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/conversations", () => ({
	getConversation: vi.fn(),
}));

vi.mock("$lib/server/services/connections/pending-writes", () => ({
	listPendingWritesForConversation: vi.fn(),
	// The TTL predicate is NOT mocked: the endpoint's whole job here is to
	// give a past-its-TTL row the same answer the confirm chokepoint would,
	// and a stubbed predicate would let the two drift apart in exactly the
	// way this projection exists to prevent. Kept in step with
	// pending-writes.ts's own definition (the real module cannot be imported
	// here — it pulls in the DB).
	isPendingWriteExpired: (expiresAt: number | null, now = Date.now()) =>
		expiresAt !== null && expiresAt * 1000 <= now,
}));

import { requireAuth } from "$lib/server/auth/hooks";
import { listPendingWritesForConversation } from "$lib/server/services/connections/pending-writes";
import { getConversation } from "$lib/server/services/conversations";
import { GET } from "./+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockGetConversation = getConversation as ReturnType<typeof vi.fn>;
const mockList = listPendingWritesForConversation as ReturnType<typeof vi.fn>;

type PendingWritesEvent = Parameters<typeof GET>[0];

function makeEvent(
	user = { id: "user-1" },
	conversationId = "conv-1",
): PendingWritesEvent {
	return {
		request: new Request(
			`http://localhost/api/conversations/${conversationId}/pending-writes`,
		),
		locals: { user },
		params: { id: conversationId },
		url: new URL(
			`http://localhost/api/conversations/${conversationId}/pending-writes`,
		),
		route: { id: "/api/conversations/[id]/pending-writes" },
	} as PendingWritesEvent;
}

const PREVIEW = {
	title: "Save note.txt",
	detail: "files.put — /AlfyAI/note.txt",
	reversible: true,
	destructive: false,
	withinAllowlist: true,
	warnings: [],
};

describe("GET /api/conversations/[id]/pending-writes", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		mockGetConversation.mockResolvedValue({ id: "conv-1" });
	});

	it("returns 404 when the conversation doesn't belong to the caller", async () => {
		mockGetConversation.mockResolvedValue(null);

		const response = await GET(makeEvent());
		expect(response.status).toBe(404);
		expect(mockList).not.toHaveBeenCalled();
	});

	it("returns the safe projection: id/assistantMessageId/status/preview/provider/createdAt — no secrets", async () => {
		mockList.mockResolvedValue([
			{
				id: "pw-1",
				userId: "user-1",
				connectionId: "conn-1",
				provider: "nextcloud",
				op: { provider: "nextcloud", connectionId: "conn-1" },
				content: "raw file content that must never reach the client",
				idempotencyKey: "key-1",
				status: "pending",
				preview: PREVIEW,
				etag: null,
				conversationId: "conv-1",
				assistantMessageId: null,
				createdAt: 1700000000,
			},
		]);

		const response = await GET(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.pendingWrites).toEqual([
			{
				id: "pw-1",
				assistantMessageId: null,
				conversationId: "conv-1",
				status: "pending",
				preview: PREVIEW,
				provider: "nextcloud",
				// Converted from PendingWriteRecord's UNIX-seconds createdAt to
				// epoch ms, matching every other client-facing timestamp.
				createdAt: 1700000000_000,
			},
		]);
		// The raw op/content/idempotencyKey never leak into the response.
		const raw = JSON.stringify(data);
		expect(raw).not.toContain("raw file content");
		expect(raw).not.toContain("idempotencyKey");
	});

	it("calls listPendingWritesForConversation scoped to the caller and this conversation", async () => {
		mockList.mockResolvedValue([]);

		await GET(makeEvent({ id: "user-42" }, "conv-99"));

		expect(mockList).toHaveBeenCalledWith("user-42", "conv-99");
	});

	// Nothing sweeps connection_pending_writes: a proposal that outlived its
	// 30-minute TTL sits in the table as "pending" until a confirm walks into
	// it and is refused. Reported raw, that row came back to the client as a
	// live proposal, so the card offered Confirm and Cancel that the server
	// was guaranteed to refuse — a dead card. The endpoint projects the TTL
	// verdict instead.
	describe("TTL projection", () => {
		function record(overrides: Record<string, unknown> = {}) {
			return {
				id: "pw-1",
				userId: "user-1",
				connectionId: "conn-1",
				provider: "nextcloud",
				op: { provider: "nextcloud", connectionId: "conn-1" },
				content: "raw file content",
				idempotencyKey: "key-1",
				status: "pending",
				preview: PREVIEW,
				etag: null,
				conversationId: "conv-1",
				assistantMessageId: null,
				createdAt: 1700000000,
				expiresAt: null,
				...overrides,
			};
		}

		async function statusOf(overrides: Record<string, unknown>) {
			mockList.mockResolvedValue([record(overrides)]);
			const data = await (await GET(makeEvent())).json();
			return data.pendingWrites[0].status;
		}

		const nowSeconds = () => Math.floor(Date.now() / 1000);

		it("reports a pending row past its expiry as expired", async () => {
			expect(await statusOf({ expiresAt: nowSeconds() - 60 })).toBe("expired");
		});

		it("leaves a pending row inside its window pending", async () => {
			expect(await statusOf({ expiresAt: nowSeconds() + 600 })).toBe("pending");
		});

		it("never expires a legacy row whose expiresAt is NULL", async () => {
			// Rows written before the column existed migrated in as NULL, and
			// confirmPendingWrite treats NULL as "no expiry" — the read side
			// has to agree or the card would refuse a write the server allows.
			expect(await statusOf({ expiresAt: null })).toBe("pending");
		});

		it("does not touch a row that already reached a terminal status", async () => {
			// A write that executed an hour ago is past its expiry too. Its
			// status is a fact about what happened, not a deadline.
			expect(
				await statusOf({ status: "executed", expiresAt: nowSeconds() - 3600 }),
			).toBe("executed");
			expect(
				await statusOf({ status: "cancelled", expiresAt: nowSeconds() - 3600 }),
			).toBe("cancelled");
			expect(
				await statusOf({ status: "executing", expiresAt: nowSeconds() - 3600 }),
			).toBe("executing");
		});

		it("passes an already-swept expired row straight through", async () => {
			// Once a refused confirm has moved the row, the stored status IS
			// "expired" and the projection is a no-op.
			expect(
				await statusOf({ status: "expired", expiresAt: nowSeconds() - 60 }),
			).toBe("expired");
		});
	});
});
