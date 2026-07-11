import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	arbitrateStreamStart,
	type StreamStartArbiterDeps,
} from "./stream-reconnect-arbiter";

function createDeps(
	overrides: Partial<StreamStartArbiterDeps> = {},
): StreamStartArbiterDeps {
	return {
		streamId: "client-stream",
		userId: "u1",
		conversationId: "c1",
		controller: new AbortController(),
		userMessage: "Hello",
		reasoningDepth: "auto",
		getOrphanedStream: vi.fn(() => null),
		isStreamActive: vi.fn(() => false),
		registerActiveChatStream: vi.fn(() => true),
		clearStreamBuffer: vi.fn(),
		getOrCreateStreamBuffer: vi.fn(),
		...overrides,
	};
}

describe("arbitrateStreamStart", () => {
	beforeEach(() => {
		vi.spyOn(console, "info").mockImplementation(() => undefined);
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		vi.spyOn(console, "error").mockImplementation(() => undefined);
	});

	it("closes when getOrphanedStream throws", () => {
		const deps = createDeps({
			getOrphanedStream: vi.fn(() => {
				throw new Error("boom");
			}),
		});
		expect(arbitrateStreamStart(deps)).toEqual({ action: "close" });
		expect(deps.registerActiveChatStream).not.toHaveBeenCalled();
	});

	it("reconnects to the same stream when the orphan matches the client stream id", () => {
		const deps = createDeps({
			getOrphanedStream: vi.fn(() => "client-stream"),
		});
		expect(arbitrateStreamStart(deps)).toEqual({
			action: "reconnect",
			targetStreamId: "client-stream",
		});
		expect(deps.registerActiveChatStream).not.toHaveBeenCalled();
	});

	it("reconnects to the client stream when it is concurrently active", () => {
		const deps = createDeps({
			getOrphanedStream: vi.fn(() => "orphan-stream"),
			isStreamActive: vi.fn(
				(p) => p.streamId === "client-stream",
			) as StreamStartArbiterDeps["isStreamActive"],
		});
		expect(arbitrateStreamStart(deps)).toEqual({
			action: "reconnect",
			targetStreamId: "client-stream",
		});
	});

	it("reconnects to the active orphan when the client stream id is stale", () => {
		const deps = createDeps({
			getOrphanedStream: vi.fn(() => "orphan-stream"),
			isStreamActive: vi.fn(
				(p) => p.streamId === "orphan-stream",
			) as StreamStartArbiterDeps["isStreamActive"],
		});
		expect(arbitrateStreamStart(deps)).toEqual({
			action: "reconnect",
			targetStreamId: "orphan-stream",
		});
	});

	it("clears a stale orphan buffer then registers and starts a main stream", () => {
		const deps = createDeps({
			getOrphanedStream: vi.fn(() => "orphan-stream"),
			isStreamActive: vi.fn(() => false),
		});
		expect(arbitrateStreamStart(deps)).toEqual({ action: "start-main" });
		expect(deps.clearStreamBuffer).toHaveBeenCalledWith("orphan-stream");
		expect(deps.registerActiveChatStream).toHaveBeenCalled();
		expect(deps.getOrCreateStreamBuffer).toHaveBeenCalledWith(
			expect.objectContaining({
				streamId: "client-stream",
				userMessage: "Hello",
				reasoningDepth: "auto",
			}),
		);
	});

	it("starts a main stream directly when there is no orphan", () => {
		const deps = createDeps();
		expect(arbitrateStreamStart(deps)).toEqual({ action: "start-main" });
		expect(deps.clearStreamBuffer).not.toHaveBeenCalled();
		expect(deps.getOrCreateStreamBuffer).toHaveBeenCalled();
	});

	it("reconnects when registration fails but a current stream is active", () => {
		const getOrphanedStream = vi
			.fn()
			.mockReturnValueOnce(null)
			.mockReturnValueOnce("winner-stream");
		const deps = createDeps({
			getOrphanedStream,
			registerActiveChatStream: vi.fn(() => false),
			isStreamActive: vi.fn(
				(p) => p.streamId === "winner-stream",
			) as StreamStartArbiterDeps["isStreamActive"],
		});
		expect(arbitrateStreamStart(deps)).toEqual({
			action: "reconnect",
			targetStreamId: "winner-stream",
		});
		expect(deps.getOrCreateStreamBuffer).not.toHaveBeenCalled();
	});

	it("closes when registration fails with no active owner", () => {
		const deps = createDeps({
			getOrphanedStream: vi.fn(() => null),
			registerActiveChatStream: vi.fn(() => false),
			isStreamActive: vi.fn(() => false),
		});
		expect(arbitrateStreamStart(deps)).toEqual({ action: "close" });
		expect(deps.getOrCreateStreamBuffer).not.toHaveBeenCalled();
	});
});
