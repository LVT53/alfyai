import { describe, expect, it } from "vitest";
import { createBoardHistory, HISTORY_LIMIT } from "./board-history";

describe("the board's own history", () => {
	it("undoes to the state a step left, and redoes to the state it reached", () => {
		const history = createBoardHistory();
		history.push("a"); // a -> b
		history.push("b"); // b -> c
		expect(history.undoDepth).toBe(2);
		expect(history.undo("c")).toBe("b");
		expect(history.undo("b")).toBe("a");
		expect(history.undo("a")).toBeNull();
		expect(history.redo("a")).toBe("b");
		expect(history.redo("b")).toBe("c");
		expect(history.redo("c")).toBeNull();
	});

	it("forgets what was undone once a new step is taken", () => {
		const history = createBoardHistory();
		history.push("a");
		history.undo("b");
		expect(history.redoDepth).toBe(1);
		history.push("a");
		expect(history.redoDepth).toBe(0);
		expect(history.redo("b")).toBeNull();
	});

	it("does not count the same state twice in a row as a step", () => {
		const history = createBoardHistory();
		history.push("a");
		history.push("a");
		expect(history.undoDepth).toBe(1);
	});

	it("is bounded: past the limit the oldest step is forgotten, not the newest", () => {
		const history = createBoardHistory(3);
		for (const state of ["a", "b", "c", "d", "e"]) history.push(state);
		expect(history.undoDepth).toBe(3);
		expect(history.undo("f")).toBe("e");
		expect(history.undo("e")).toBe("d");
		expect(history.undo("d")).toBe("c");
		expect(history.undo("c")).toBeNull();
	});

	it("keeps fifty steps by default", () => {
		expect(HISTORY_LIMIT).toBe(50);
		const history = createBoardHistory();
		for (let i = 0; i < 80; i += 1) history.push(String(i));
		expect(history.undoDepth).toBe(50);
	});
});
