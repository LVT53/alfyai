// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "./http";
import { addMemoryNote } from "./memory-notes";

describe("native composer memory intent", () => {
	it("carries the authenticated source conversation and stable request identity without inventing saved text", async () => {
		const response = { operation: { id: "op", status: "queued" } };
		const fetcher = vi.fn<FetchLike>(
			async () =>
				new Response(JSON.stringify(response), {
					status: 202,
					headers: { "Content-Type": "application/json" },
				}),
		);
		expect(
			await addMemoryNote(
				"green kayak",
				{ conversationId: "project-chat", requestId: "intent" },
				fetcher,
			),
		).toEqual(response);
		expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
			text: "green kayak",
			conversationId: "project-chat",
			requestId: "intent",
		});
	});
});
