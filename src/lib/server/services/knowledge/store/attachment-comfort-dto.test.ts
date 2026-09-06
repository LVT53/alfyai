// "Long-document comfort" (owner-approved mockup, 2026-09-06): confirms
// listMessageAttachments — the DTO builder behind MessageBubble's chat
// history attachments — exposes tokenEstimate/pageCount/outline from the
// artifact's stored metadata, and omits them when an artifact never had
// them computed.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockOrderBy = vi.fn();

vi.mock("$lib/server/db", () => ({
	db: {
		select: vi.fn(() => ({
			from: vi.fn(() => ({
				innerJoin: vi.fn(() => ({
					where: vi.fn(() => ({
						orderBy: mockOrderBy,
					})),
				})),
			})),
		})),
	},
}));

vi.mock("$lib/server/db/schema", () => ({
	artifacts: {},
	artifactLinks: {},
}));

vi.mock("drizzle-orm", () => ({
	and: vi.fn((...conditions: unknown[]) => conditions),
	desc: vi.fn(() => "desc"),
	eq: vi.fn(),
	inArray: vi.fn(),
	isNull: vi.fn(),
	sql: vi.fn(),
}));

vi.mock("../../attachment-trace", () => ({
	hasMeaningfulAttachmentText: vi.fn(),
	logAttachmentTrace: vi.fn(),
	summarizeAttachmentTraceText: vi.fn(),
}));

const { listMessageAttachments } = await import("./attachments");

function artifactRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "artifact-1",
		name: "contract.pdf",
		type: "source_document",
		mimeType: "application/pdf",
		sizeBytes: 1024,
		conversationId: "conv-1",
		metadataJson: null,
		...overrides,
	};
}

function linkRow(messageId: string | null, createdAt = new Date()) {
	return { id: "link-1", messageId, createdAt };
}

describe("listMessageAttachments — long-document comfort DTO fields", () => {
	beforeEach(() => {
		mockOrderBy.mockReset();
	});

	it("exposes tokenEstimate, pageCount, and outline when present in metadata", async () => {
		const outline = [
			{ level: 1, title: "Contract", offset: 0, preview: "Text" },
		];
		mockOrderBy.mockResolvedValue([
			{
				link: linkRow("message-1"),
				artifact: artifactRow({
					metadataJson: JSON.stringify({
						tokenEstimate: 118_000,
						pageCount: 38,
						outline,
					}),
				}),
			},
		]);

		const result = await listMessageAttachments("conv-1");
		const attachments = result.get("message-1");

		expect(attachments).toHaveLength(1);
		expect(attachments?.[0].tokenEstimate).toBe(118_000);
		expect(attachments?.[0].pageCount).toBe(38);
		expect(attachments?.[0].outline).toEqual(outline);
	});

	it("omits the comfort fields entirely when metadata never had them", async () => {
		mockOrderBy.mockResolvedValue([
			{ link: linkRow("message-2"), artifact: artifactRow() },
		]);

		const result = await listMessageAttachments("conv-1");
		const attachment = result.get("message-2")?.[0];

		expect(attachment).toBeDefined();
		expect(attachment && "tokenEstimate" in attachment).toBe(false);
		expect(attachment && "pageCount" in attachment).toBe(false);
		expect(attachment && "outline" in attachment).toBe(false);
	});
});
