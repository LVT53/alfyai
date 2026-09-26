import { describe, expect, it } from "vitest";
import {
	type AnchorResolution,
	anchorStateFor,
	anchorTone,
	ORPHANED_ANCHOR_RESOLUTION,
} from "./anchor";

// The shared anchor vocabulary (ruling 11): one score→state mapping and one
// state→tone mapping, used identically by the Document's text resolver
// (`artifact-document/anchor.ts`) and, later, Slice 3's canvas resolver.
// Neither resolver may reimplement this — that is what "one comment layer,
// per-type resolvers" (ruling 11) means in practice.
describe("anchorStateFor", () => {
	it("scores of 4 or more are exact", () => {
		expect(anchorStateFor(4)).toBe("exact");
		expect(anchorStateFor(7)).toBe("exact");
	});

	it("scores above zero but below 4 are moved", () => {
		expect(anchorStateFor(1)).toBe("moved");
		expect(anchorStateFor(3)).toBe("moved");
	});

	it("a score of zero (or less) is orphaned", () => {
		expect(anchorStateFor(0)).toBe("orphaned");
		expect(anchorStateFor(-1)).toBe("orphaned");
	});
});

describe("anchorTone", () => {
	it("maps each state to its own tone, never two states to the wrong one", () => {
		expect(anchorTone("exact")).toBe("normal");
		expect(anchorTone("moved")).toBe("warning");
		expect(anchorTone("orphaned")).toBe("faint");
	});
});

describe("ORPHANED_ANCHOR_RESOLUTION", () => {
	it("is the one shared shape for 'nothing matched' (T10.8)", () => {
		const resolution: AnchorResolution = ORPHANED_ANCHOR_RESOLUTION;
		expect(resolution).toEqual({
			state: "orphaned",
			blockId: null,
			from: -1,
			to: -1,
		});
	});
});
