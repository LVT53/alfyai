import { describe, expect, it } from "vitest";
import { judgeServerBoard } from "./server-board";

// What the editor does when the server's board is not the version it knows:
// most of the time it is Alfy's change and is drawn, but it can also be the
// reader's own last save arriving by another road, or a change the reader's
// unsaved steps cannot be merged into. Getting the second wrong stops the reader's
// saves; getting the third wrong loses their work.

const base = {
	serverVersion: 3,
	knownVersion: 2 as number | null,
	serverJson: "server",
	latestJson: "mine",
	savedJson: "mine",
};

describe("judgeServerBoard", () => {
	it("leaves alone a board at the version the editor already knows", () => {
		expect(judgeServerBoard({ ...base, serverVersion: 2 })).toBe("unchanged");
	});

	it("draws what Alfy changed when the reader has nothing the server has not seen", () => {
		expect(judgeServerBoard(base)).toBe("land");
	});

	it("reports a conflict, and does not draw, when the reader has steps the server has not seen", () => {
		expect(judgeServerBoard({ ...base, latestJson: "mine, and more" })).toBe(
			"conflict",
		);
	});

	it("knows the reader's own save when it arrives before its answer does: the server holds exactly what the reader has", () => {
		// The save has landed on the server, but its acknowledgement has not been handled yet, so the
		// editor still thinks the latest board is unsaved. That is not a conflict.
		expect(
			judgeServerBoard({
				...base,
				serverJson: "mine, and more",
				latestJson: "mine, and more",
				savedJson: "mine",
			}),
		).toBe("ours");
	});

	it("takes a version it has never seen as new, whatever the number", () => {
		expect(judgeServerBoard({ ...base, knownVersion: null })).toBe("land");
		expect(judgeServerBoard({ ...base, serverVersion: 1 })).toBe("land");
	});
});
