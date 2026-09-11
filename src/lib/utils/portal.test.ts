import { beforeEach, describe, expect, it } from "vitest";
import { portalToBody } from "./portal";

function makeHost(): { host: HTMLElement; node: HTMLElement } {
	const host = document.createElement("div");
	const node = document.createElement("div");
	node.textContent = "sheet";
	host.appendChild(node);
	document.body.appendChild(host);
	return { host, node };
}

describe("portalToBody", () => {
	beforeEach(() => {
		document.body.innerHTML = "";
	});

	it("moves the node to the body so a fixed sheet means the viewport", () => {
		const { host, node } = makeHost();
		portalToBody(node);
		expect(node.parentElement).toBe(document.body);
		expect(host.contains(node)).toBe(false);
	});

	it("leaves the node alone when the condition is false", () => {
		const { host, node } = makeHost();
		portalToBody(node, false);
		expect(node.parentElement).toBe(host);
	});

	// A desktop window dragged narrow and back: the sheet becomes a popover
	// again, and a popover that stayed on the body would be anchored to
	// nothing.
	it("hands the node back to its original place, in order", () => {
		const host = document.createElement("div");
		const before = document.createElement("span");
		const node = document.createElement("div");
		const after = document.createElement("span");
		host.append(before, node, after);
		document.body.appendChild(host);

		const action = portalToBody(node, true);
		expect(node.parentElement).toBe(document.body);

		action?.update?.(false);
		expect(node.parentElement).toBe(host);
		expect(Array.from(host.children)).toEqual([before, node, after]);
	});

	// Svelte tears a block down by clearing the range between the anchors it
	// left in the ORIGINAL parent, so a reparented node is never reached.
	// Having moved it, the action owns removing it — otherwise a dismissed
	// sheet stays on screen forever.
	it("removes a moved node on destroy", () => {
		const { node } = makeHost();
		const action = portalToBody(node);
		action?.destroy?.();
		expect(node.parentElement).toBeNull();
		expect(document.body.contains(node)).toBe(false);
	});

	it("does not remove a node it never moved", () => {
		const { host, node } = makeHost();
		const action = portalToBody(node, false);
		action?.destroy?.();
		expect(node.parentElement).toBe(host);
	});
});
