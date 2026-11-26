// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { frameLoadTripwire } from "./frame-load-tripwire";

// jsdom never fires a frame's `load` on its own, so every load here is the test's:
// which one the page caused and which one it did not is exact. The browser's own
// loads are held by tests/e2e/artifact-app.spec.ts (an App) and
// tests/e2e/read-aloud-report.spec.ts (a standard report).

function frame(): HTMLIFrameElement {
	const iframe = document.createElement("iframe");
	document.body.append(iframe);
	return iframe;
}

const load = (iframe: HTMLIFrameElement) =>
	iframe.dispatchEvent(new Event("load"));

afterEach(() => {
	document.body.innerHTML = "";
});

describe("the frame-load tripwire", () => {
	it("lets the first load in a window go: the page asked for it", () => {
		const iframe = frame();
		const tripped = vi.fn();
		frameLoadTripwire(iframe, tripped);
		load(iframe);
		expect(tripped).not.toHaveBeenCalled();
	});

	it("trips on a further load in the same window: the document navigated itself", () => {
		const iframe = frame();
		const tripped = vi.fn();
		frameLoadTripwire(iframe, tripped);
		load(iframe);
		load(iframe);
		expect(tripped).toHaveBeenCalledTimes(1);
	});

	it("lets a load in a new window go: the page took the frame out and put it back", () => {
		const iframe = frame();
		const tripped = vi.fn();
		frameLoadTripwire(iframe, tripped);
		load(iframe);
		const first = iframe.contentWindow;
		iframe.remove();
		document.body.append(iframe);
		// A boolean, not `not.toBe`: a matcher that fails to tell two windows apart
		// walks the closed one's properties and throws.
		expect(iframe.contentWindow === first).toBe(false);
		load(iframe);
		expect(tripped).not.toHaveBeenCalled();
		load(iframe);
		expect(tripped).toHaveBeenCalledTimes(1);
	});

	it("tells the latest listener, and nobody once it is destroyed", () => {
		const iframe = frame();
		const first = vi.fn();
		const second = vi.fn();
		const action = frameLoadTripwire(iframe, first);
		action.update(second);
		load(iframe);
		load(iframe);
		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledTimes(1);
		action.destroy();
		load(iframe);
		expect(second).toHaveBeenCalledTimes(1);
	});
});
