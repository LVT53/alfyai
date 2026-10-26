import { afterEach, describe, expect, it, vi } from "vitest";
import { isKeyboardFocused } from "./focus-visible";

describe("isKeyboardFocused", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		document.body.replaceChildren();
	});

	function button(): HTMLButtonElement {
		const element = document.createElement("button");
		document.body.append(element);
		return element;
	}

	// What the engine answers for `:focus-visible`, whatever it has seen.
	function stubFocusVisible(answer: boolean | "throws") {
		const matches = Element.prototype.matches;
		return vi.spyOn(Element.prototype, "matches").mockImplementation(function (
			this: Element,
			selector: string,
		) {
			if (selector !== ":focus-visible") return matches.call(this, selector);
			if (answer === "throws") {
				throw new SyntaxError(`'${selector}' is not a valid selector`);
			}
			return answer;
		});
	}

	it("is true for a focused element that the browser shows as keyboard focus", () => {
		// jsdom follows focus from the first time it evaluates the selector, and
		// answers from what it has seen of the focus and the keys since.
		document.body.matches(":focus-visible");
		const element = button();
		element.focus();

		expect(isKeyboardFocused(element)).toBe(true);
	});

	it("is false for an element that is not focused", () => {
		const element = button();
		button().focus();

		expect(isKeyboardFocused(element)).toBe(false);
	});

	it("takes the browser's answer: yes", () => {
		stubFocusVisible(true);

		expect(isKeyboardFocused(button())).toBe(true);
	});

	it("takes the browser's answer: no, as when a mouse press focused it", () => {
		const element = button();
		element.focus();
		stubFocusVisible(false);

		expect(isKeyboardFocused(element)).toBe(false);
	});

	it("is false for nothing", () => {
		expect(isKeyboardFocused(null)).toBe(false);
		expect(isKeyboardFocused(undefined)).toBe(false);
	});

	it("is false in an engine that cannot evaluate :focus-visible", () => {
		const element = button();
		element.focus();
		stubFocusVisible("throws");

		expect(isKeyboardFocused(element)).toBe(false);
	});
});
