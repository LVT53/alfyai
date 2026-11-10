import { afterEach, expect, it } from "vitest";
import * as registry from "./active-streams";

const owner = {
	streamId: "owned-stream",
	userId: "owned-user",
	conversationId: "owned-chat",
	userMessage: "synthetic",
	controller: new AbortController(),
};
afterEach(() => {
	registry.unregisterActiveChatStream(owner.streamId);
	registry.clearStreamBuffer(owner.streamId);
});
it("observe intent never acquires generation after the run finishes", () => {
	const started = registry.acquireChatStream({ ...owner, intent: "start" });
	expect(started.action).toBe("owned");
	if (started.action === "owned") started.release();
	registry.setDraining(true);
	try {
		expect(registry.acquireChatStream({ ...owner, intent: "observe" })).toEqual(
			{ action: "observe", streamId: owner.streamId },
		);
		expect(registry.isStreamActive(owner)).toBe(false);
	} finally {
		registry.setDraining(false);
	}
});
it("releases exactly once and retains completed replay until TTL", () => {
	const started = registry.acquireChatStream({ ...owner, intent: "start" });
	if (started.action !== "owned") throw new Error("not acquired");
	started.release();
	started.release();
	expect(registry.userHasActiveChatStream(owner.userId)).toBe(false);
	expect(registry.getStreamBuffer(owner)).not.toBeNull();
});
it("rolls back registration if buffer setup throws", () => {
	const broken = {
		...owner,
		intent: "start" as const,
		get userMessage(): string {
			throw new Error("setup failed");
		},
	};
	expect(() => registry.acquireChatStream(broken)).toThrow("setup failed");
	expect(registry.isStreamActive(owner)).toBe(false);
	expect(registry.userHasActiveChatStream(owner.userId)).toBe(false);
});
