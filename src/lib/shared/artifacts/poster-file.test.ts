import { describe, expect, it } from "vitest";
import {
	isPosterFileName,
	isPosterOfBoard,
	posterFileName,
} from "./poster-file";

// The name of a block's still image is what ties it to its board: deleting the board
// finds its posters by it (RC-3 N2), and serving tells a poster from any other file
// that hangs from no reply.
describe("a poster's file name", () => {
	const BOARD = "0d3f6c2e-9a7b-4e0a-8a55-2f5f1f7c1a11";

	it("names one block of one board, and is a poster of that board only", () => {
		const name = posterFileName(BOARD, "app-1");
		expect(name).toBe(`canvas-poster-${BOARD}-app-1.png`);
		expect(isPosterFileName(name)).toBe(true);
		expect(isPosterOfBoard(name, BOARD)).toBe(true);
		expect(isPosterOfBoard(name, "another-board")).toBe(false);
		expect(isPosterOfBoard("Weekend board.png", BOARD)).toBe(false);
		expect(isPosterOfBoard(`canvas-poster-${BOARD}-app-1.jpg`, BOARD)).toBe(
			false,
		);
	});

	it("does not take one board's id for the start of another's", () => {
		// The dash after the board's id is part of what a board's posters start with.
		expect(isPosterOfBoard(posterFileName(`${BOARD}x`, "n"), BOARD)).toBe(
			false,
		);
		expect(isPosterOfBoard(posterFileName(BOARD, "n"), `${BOARD}x`)).toBe(
			false,
		);
	});

	it("reads an id the way the name was made: nothing but letters, digits, dashes and underscores", () => {
		const name = posterFileName("board/../1", "a b");
		expect(name).toBe("canvas-poster-board-1-a-b.png");
		expect(isPosterOfBoard(name, "board/../1")).toBe(true);
	});
});
