import { afterEach, describe, expect, it } from "vitest";
import { replayEarlyImageEvent } from "./early-image-event";

// A picture the server drew can finish, or fail, before the page's code runs. Svelte
// remembers that event with an inline handler and replays it when the page wakes up,
// but the policy the boxes enforce refuses inline handlers, so nothing hears it. jsdom
// fetches no picture, so each test says how the picture stands when the page wakes up.

type Standing = { complete: boolean; naturalWidth: number; decodes: boolean };

function picture(standing: Standing): HTMLImageElement {
	const img = document.createElement("img");
	img.src = "https://example.com/a.png";
	Object.defineProperty(img, "complete", { get: () => standing.complete });
	Object.defineProperty(img, "naturalWidth", {
		get: () => standing.naturalWidth,
	});
	img.decode = () =>
		standing.decodes
			? Promise.resolve()
			: Promise.reject(new DOMException("broken", "EncodingError"));
	document.body.append(img);
	return img;
}

function heard(img: HTMLImageElement): string[] {
	const events: string[] = [];
	for (const type of ["load", "error"]) {
		img.addEventListener(type, (event) => {
			events.push(`${type}${event.currentTarget === img ? "" : " elsewhere"}`);
		});
	}
	return events;
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("replayEarlyImageEvent", () => {
	afterEach(() => document.body.replaceChildren());

	it("hands a picture that came back broken before the page ran the error it missed", async () => {
		const img = picture({ complete: true, naturalWidth: 0, decodes: false });
		const events = heard(img);
		replayEarlyImageEvent(img);
		await settled();
		expect(events).toEqual(["error"]);
	});

	it("hands a picture the browser already holds the load it missed", async () => {
		const img = picture({ complete: true, naturalWidth: 32, decodes: true });
		const events = heard(img);
		replayEarlyImageEvent(img);
		await settled();
		expect(events).toEqual(["load"]);
	});

	it("takes an SVG with no size of its own for loaded, since it decodes", async () => {
		// Model icons and favicons can be SVGs with only a viewBox: no natural width.
		const img = picture({ complete: true, naturalWidth: 0, decodes: true });
		const events = heard(img);
		replayEarlyImageEvent(img);
		await settled();
		expect(events).toEqual(["load"]);
	});

	it("leaves a picture still on its way to the events it will hear itself", async () => {
		const img = picture({ complete: false, naturalWidth: 0, decodes: false });
		const events = heard(img);
		replayEarlyImageEvent(img);
		await settled();
		expect(events).toEqual([]);
	});

	it("says nothing once the element is gone, or once it shows another address", async () => {
		const gone = picture({ complete: true, naturalWidth: 0, decodes: false });
		const goneEvents = heard(gone);
		replayEarlyImageEvent(gone)?.destroy();
		const moved = picture({ complete: true, naturalWidth: 0, decodes: false });
		const movedEvents = heard(moved);
		replayEarlyImageEvent(moved);
		moved.src = "https://example.com/b.png";
		await settled();
		expect(goneEvents).toEqual([]);
		expect(movedEvents).toEqual([]);
	});
});
