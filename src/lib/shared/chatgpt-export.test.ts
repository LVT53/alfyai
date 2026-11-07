import { describe, expect, it } from "vitest";
import { exportedConversationId } from "./chatgpt-export";

describe("exportedConversationId", () => {
	it("names a conversation by its conversation_id", () => {
		expect(
			exportedConversationId({ id: "internal", conversation_id: "exported" }),
		).toBe("exported");
	});

	it("falls back to id when conversation_id is empty or missing", () => {
		expect(exportedConversationId({ id: "only-id", conversation_id: "" })).toBe(
			"only-id",
		);
		expect(exportedConversationId({ id: "only-id" })).toBe("only-id");
	});

	it("names nothing when the entry carries neither", () => {
		expect(exportedConversationId({ title: "No ids" })).toBeNull();
		expect(exportedConversationId({ id: 7, conversation_id: null })).toBeNull();
		expect(exportedConversationId({ id: "", conversation_id: "" })).toBeNull();
	});

	it("names nothing for an entry that is not an object", () => {
		expect(exportedConversationId(null)).toBeNull();
		expect(exportedConversationId(undefined)).toBeNull();
		expect(exportedConversationId("a-string")).toBeNull();
		expect(exportedConversationId(["conv-1"])).toBeNull();
	});
});
