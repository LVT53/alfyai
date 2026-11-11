import { describe, expect, it, vi } from "vitest";

const reply = vi.hoisted(() => ({
	value: null as { content: string; documentArtifactId: string | null } | null,
}));
const created = vi.hoisted(() => ({
	calls: [] as { title: string; markdown: string }[],
}));
vi.mock("$lib/server/services/messages", () => ({
	getReplyForDocumentKeep: async () => reply.value,
	updateMessageDocumentLink: async () => undefined,
}));
vi.mock("./document-ops", () => ({
	createDocumentArtifact: async (input: {
		title: string;
		markdown: string;
	}) => {
		created.calls.push({ title: input.title, markdown: input.markdown });
		return { id: "doc-1", title: input.title };
	},
}));
vi.mock("./record", () => ({ getArtifact: async () => null }));

import { joinReplyText } from "$lib/shared/reply-text";
import { keepMessageAsDocument } from "./keep-message";

describe("review D: Open as document after the outward-status change", () => {
	it("K1: a kept incomplete answer is titled from the status label, not from the answer", async () => {
		reply.value = {
			content: joinReplyText([
				{
					content: "Quarterly revenue grew 12 percent, driven by",
					normalChatOutput: {
						version: 1,
						events: [
							{
								version: 1,
								turnId: "t",
								segmentId: "s",
								attemptId: "a",
								stepId: "a:0",
								phase: "closing",
								sequence: 1,
								type: "completion",
								completion: {
									version: 1,
									turnId: "t",
									segmentId: "s",
									phase: "closing",
									outcome: "incomplete",
									stopCause: "length",
									workingStopCause: "tool_budget",
									closingAttempted: true,
								},
							},
						],
					},
				},
			]),
			documentArtifactId: null,
		};
		const result = await keepMessageAsDocument({
			userId: "u",
			conversationId: "c",
			conversationTitle: "Fallback chat title",
			messageId: "m",
		});
		console.log(
			"K1 result:",
			JSON.stringify(result),
			"markdown:",
			JSON.stringify(created.calls.at(-1)?.markdown),
		);
		expect(result.ok && result.title).not.toMatch(/incomplete answer/i);
	});

	it("K2: a finalization-failure marker with an empty caption lets a label-only Document be created", async () => {
		reply.value = {
			content: joinReplyText([
				{
					content: "",
					normalChatFinalization: {
						version: 1,
						status: "failed",
						cause: "file_association_failed",
						wasStopped: false,
					},
				},
			]),
			documentArtifactId: null,
		};
		const result = await keepMessageAsDocument({
			userId: "u",
			conversationId: "c",
			conversationTitle: "Fallback chat title",
			messageId: "m",
		});
		console.log(
			"K2 result:",
			JSON.stringify(result),
			"markdown:",
			JSON.stringify(created.calls.at(-1)?.markdown),
		);
		expect(result.ok).toBe(false);
	});
});
