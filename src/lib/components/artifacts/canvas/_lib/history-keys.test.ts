// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	boardHistoryChord,
	handsHistoryToBoard,
	isTextEntry,
} from "./history-keys";

function chord(
	init: KeyboardEventInit = {},
	target?: HTMLElement,
): KeyboardEvent {
	const event = new KeyboardEvent("keydown", {
		key: "z",
		code: "KeyZ",
		ctrlKey: true,
		bubbles: true,
		cancelable: true,
		...init,
	});
	if (target) Object.defineProperty(event, "target", { value: target });
	return event;
}

function page(): {
	board: HTMLElement;
	note: HTMLElement;
	outside: HTMLElement;
} {
	document.body.innerHTML = `
		<div id="board" tabindex="-1">
			<div id="note" tabindex="0"><textarea id="words"></textarea></div>
			<input id="box" type="checkbox" />
			<input id="name" type="text" />
		</div>
		<textarea id="composer"></textarea>`;
	return {
		board: document.getElementById("board") as HTMLElement,
		note: document.getElementById("note") as HTMLElement,
		outside: document.getElementById("composer") as HTMLElement,
	};
}

afterEach(() => {
	document.body.innerHTML = "";
});

describe("isTextEntry", () => {
	it("is true for the places words go, and false for a checkbox, a button or plain ground", () => {
		page();
		const get = (id: string) => document.getElementById(id);
		expect(isTextEntry(get("words"))).toBe(true);
		expect(isTextEntry(get("name"))).toBe(true);
		expect(isTextEntry(get("composer"))).toBe(true);
		expect(isTextEntry(get("box"))).toBe(false);
		expect(isTextEntry(get("note"))).toBe(false);
		expect(isTextEntry(document.body)).toBe(false);
		expect(isTextEntry(null)).toBe(false);
	});

	it("knows an editable element, and one that says it is not", () => {
		document.body.innerHTML = `<div id="on" contenteditable="true"><b id="in">x</b></div><div id="off" contenteditable="false"></div>`;
		expect(isTextEntry(document.getElementById("in"))).toBe(true);
		expect(isTextEntry(document.getElementById("off"))).toBe(false);
	});
});

describe("boardHistoryChord", () => {
	it("is the board's with the focus on a block in it", () => {
		const { board, note } = page();
		note.focus();
		expect(boardHistoryChord(chord({}, note), board)).toBe("undo");
		expect(boardHistoryChord(chord({ shiftKey: true }, note), board)).toBe(
			"redo",
		);
	});

	it("is the board's with the focus on the board itself (a click on the empty board)", () => {
		const { board } = page();
		board.focus();
		expect(boardHistoryChord(chord({}, board), board)).toBe("undo");
	});

	it("is the board's with nothing focused: the page's body, after a block was deleted", () => {
		const { board } = page();
		(document.activeElement as HTMLElement | null)?.blur();
		expect(document.activeElement).toBe(document.body);
		expect(boardHistoryChord(chord({}, document.body), board)).toBe("undo");
	});

	it("is the board's with the focus on a checkbox in it", () => {
		const { board } = page();
		const box = document.getElementById("box") as HTMLElement;
		box.focus();
		expect(boardHistoryChord(chord({}, box), board)).toBe("undo");
	});

	it("is left to a field the reader types in", () => {
		const { board } = page();
		const words = document.getElementById("words") as HTMLElement;
		words.focus();
		expect(boardHistoryChord(chord({}, words), board)).toBeNull();
		const name = document.getElementById("name") as HTMLElement;
		name.focus();
		expect(boardHistoryChord(chord({}, name), board)).toBeNull();
	});

	it("is left alone with the focus somewhere else on the page (the chat's composer)", () => {
		const { board, outside } = page();
		outside.focus();
		expect(boardHistoryChord(chord({}, outside), board)).toBeNull();
	});

	it("needs a board that is on the page, and a key nobody has handled", () => {
		const { board } = page();
		board.focus();
		expect(boardHistoryChord(chord({}, board), null)).toBeNull();
		const handled = chord({}, board);
		handled.preventDefault();
		expect(boardHistoryChord(handled, board)).toBeNull();
		board.remove();
		expect(boardHistoryChord(chord({}, board), board)).toBeNull();
	});

	it("is not a chord with Alt held (that is Alfy's change), or another key", () => {
		const { board } = page();
		board.focus();
		expect(boardHistoryChord(chord({ altKey: true }, board), board)).toBeNull();
		expect(
			boardHistoryChord(chord({ key: "a", code: "KeyA" }, board), board),
		).toBeNull();
	});
});

describe("handsHistoryToBoard", () => {
	function field() {
		const textarea = document.createElement("textarea");
		document.body.append(textarea);
		const handOver = vi.fn();
		const leave = vi.fn();
		const detach = handsHistoryToBoard(handOver, leave)(textarea);
		return { textarea, handOver, leave, detach };
	}

	it("hands the chord over, leaving the field first, while nothing has been typed", () => {
		const { textarea, handOver, leave } = field();
		const event = chord();
		textarea.dispatchEvent(event);
		expect(handOver).toHaveBeenCalledWith("undo");
		expect(leave).toHaveBeenCalledTimes(1);
		expect(event.defaultPrevented).toBe(true);
	});

	it("hands over a redo too", () => {
		const { textarea, handOver } = field();
		textarea.dispatchEvent(chord({ shiftKey: true }));
		expect(handOver).toHaveBeenCalledWith("redo");
	});

	it("keeps the chord for the field once the reader has typed in it", () => {
		const { textarea, handOver, leave } = field();
		textarea.dispatchEvent(new Event("input", { bubbles: true }));
		const event = chord();
		textarea.dispatchEvent(event);
		expect(handOver).not.toHaveBeenCalled();
		expect(leave).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
	});

	it("ignores every other key, and stops listening when it is detached", () => {
		const { textarea, handOver, detach } = field();
		textarea.dispatchEvent(chord({ key: "a", code: "KeyA" }));
		expect(handOver).not.toHaveBeenCalled();
		detach();
		textarea.dispatchEvent(chord());
		expect(handOver).not.toHaveBeenCalled();
	});

	it("does nothing on a board that cannot take history (a block outside a board)", () => {
		const textarea = document.createElement("textarea");
		const detach = handsHistoryToBoard(undefined, () => {})(textarea);
		const event = chord();
		textarea.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(false);
		detach?.();
	});
});
