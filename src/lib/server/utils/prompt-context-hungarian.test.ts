import { describe, expect, it } from "vitest";
import type { Artifact } from "$lib/types";
import { serializeBudgetedAttachments } from "./prompt-context";

function makeAttachment(): Artifact {
	return {
		id: "attachment-1",
		userId: "user-1",
		type: "source_document",
		retrievalClass: "durable",
		name: "dokumentum.txt",
		mimeType: "text/plain",
		sizeBytes: 1024,
		conversationId: "conv-1",
		summary: null,
		createdAt: 1,
		updatedAt: 1,
		extension: "txt",
		storagePath: null,
		contentText: "Projekt dokumentum részlet. ".repeat(1_000),
		metadata: null,
	};
}

describe("Hungarian attachment context mode", () => {
	it("promotes Hungarian document task prompts to task context", () => {
		for (const message of [
			"Foglald össze ezt a csatolmányt.",
			"Elemezd a fájlt.",
			"Mit mond ez a fájl a felmondási időről?",
		]) {
			const serialized = serializeBudgetedAttachments({
				artifacts: [makeAttachment()],
				message,
				totalBudget: 700,
			});

			expect(serialized.body).toContain("Context mode: Task Context");
			expect(serialized.items).toEqual([
				expect.objectContaining({
					id: "attachment-1",
					inclusionLevel: "task",
				}),
			]);
		}
	});

	it("keeps generic Hungarian chat with attachments in excerpt context", () => {
		const serialized = serializeBudgetedAttachments({
			artifacts: [makeAttachment()],
			message: "Mit gondolsz?",
			totalBudget: 700,
		});

		expect(serialized.body).toContain("Context mode: Excerpt Context");
		expect(serialized.items).toEqual([
			expect.objectContaining({
				id: "attachment-1",
				inclusionLevel: "excerpt",
			}),
		]);
	});
});
