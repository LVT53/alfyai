import { describe, expect, it } from "vitest";
import {
	buildChatSourceMessageHref,
	buildKnowledgeWorkspaceHref,
	clearChatFocusMessageParam,
	clearKnowledgeWorkspaceParams,
	getChatFocusMessageIdFromUrl,
	getKnowledgeWorkspaceDocumentFromUrl,
} from "./document-workspace-navigation";

describe("document workspace navigation", () => {
	it("builds a chat source-message href with the expected params", () => {
		expect(
			buildChatSourceMessageHref({
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
			}),
		).toBe("/chat/conv-1?focus_message=assistant-1");
	});

	it("reads and clears chat source-message params", () => {
		const url = new URL(
			"http://localhost/chat/conv-1?focus_message=assistant-1&tab=keep",
		);

		expect(getChatFocusMessageIdFromUrl(url)).toBe("assistant-1");
		expect(
			clearChatFocusMessageParam(url).pathname +
				clearChatFocusMessageParam(url).search,
		).toBe("/chat/conv-1?tab=keep");
	});

	it("builds a knowledge workspace href with the expected params", () => {
		expect(
			buildKnowledgeWorkspaceHref({
				artifactId: "normalized-1",
				filename: "Research brief.txt",
				mimeType: "text/plain",
			}),
		).toBe(
			"/knowledge?open_artifact=normalized-1&open_filename=Research+brief.txt&open_mime=text%2Fplain",
		);
	});

	it("derives a workspace document from a knowledge handoff url", () => {
		const document = getKnowledgeWorkspaceDocumentFromUrl(
			new URL(
				"http://localhost/knowledge?open_artifact=normalized-1&open_filename=Research+brief.txt&open_mime=text%2Fplain",
			),
		);

		expect(document).toEqual({
			id: "artifact:normalized-1",
			source: "knowledge_artifact",
			filename: "Research brief.txt",
			title: "Research brief.txt",
			mimeType: "text/plain",
			artifactId: "normalized-1",
		});
	});

	it("clears workspace handoff params after consumption", () => {
		const url = clearKnowledgeWorkspaceParams(
			new URL(
				"http://localhost/knowledge?open_artifact=normalized-1&open_filename=Research+brief.txt&open_mime=text%2Fplain&tab=library",
			),
		);

		expect(url.pathname + url.search).toBe("/knowledge?tab=library");
	});
});
