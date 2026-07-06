import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectExplicitMemoryRequest } from "./runner";

describe("detectExplicitMemoryRequest", () => {
	const yes = [
		"Remember that I hate jargon",
		"Please remember this: I use fish shell",
		"remember this for later",
		"Jegyezd meg, hogy vegán vagyok",
		"Emlékezz rá, hogy Limerickben lakom",
	];
	const no = [
		"I can't remember his name",
		"Do you remember what we discussed?",
		"remembering my childhood",
		"How does memory work in LLMs?",
		"Emlékszel még arra a filmre?",
	];
	for (const t of yes) {
		it(`yes: ${t}`, () => expect(detectExplicitMemoryRequest(t)).toBe(true));
	}
	for (const t of no) {
		it(`no: ${t}`, () => expect(detectExplicitMemoryRequest(t)).toBe(false));
	}
});

describe("scheduleConversationJudge", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.doUnmock("./index");
		vi.doUnmock("$lib/server/config-store");
	});

	it("debounces: reschedule resets the timer; fires runMemoryJudgeOnSegment once", async () => {
		const runSpy = vi.fn(async () => ({ status: "ran" as const }));
		vi.doMock("./index", () => ({ runMemoryJudgeOnSegment: runSpy }));
		vi.doMock("$lib/server/config-store", () => ({
			getConfig: () => ({ memoryJudgeIdleMinutes: 5 }),
		}));

		const { scheduleConversationJudge, stopMemoryJudgeRunner } = await import(
			"./runner"
		);

		scheduleConversationJudge({ userId: "u1", conversationId: "c1" });
		// Advance partway, then reschedule — should reset the timer.
		await vi.advanceTimersByTimeAsync(2 * 60_000);
		scheduleConversationJudge({ userId: "u1", conversationId: "c1" });
		// Partway again — first schedule would have fired by now if not reset.
		await vi.advanceTimersByTimeAsync(4 * 60_000);
		expect(runSpy).not.toHaveBeenCalled();
		// Complete the (reset) window.
		await vi.advanceTimersByTimeAsync(60_000);

		expect(runSpy).toHaveBeenCalledTimes(1);
		expect(runSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "u1",
				conversationId: "c1",
				trigger: "idle",
			}),
		);

		stopMemoryJudgeRunner();
	});
});
