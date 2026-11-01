import { describe, expect, it } from "vitest";
import { takeRequest } from "./testing/takes";
import { createTurnTakes } from "./turn-takes";

describe("hasTakeForCall", () => {
	it("is true only for a tool call that queued a take", () => {
		const turnTakes = createTurnTakes();
		expect(turnTakes.hasTakeForCall("call-1")).toBe(false);
		turnTakes.noteTake({
			takeId: "take-1",
			toolCallId: "call-1",
			cardId: "card-1",
			cardKey: "key",
			callKey: "call",
			seed: 1,
			request: takeRequest(),
			isRetry: false,
		});
		expect(turnTakes.hasTakeForCall("call-1")).toBe(true);
		expect(turnTakes.hasTakeForCall("call-2")).toBe(false);
	});
});
