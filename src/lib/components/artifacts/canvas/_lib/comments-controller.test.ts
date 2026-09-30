import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ArtifactComment,
	ArtifactDetail,
} from "$lib/server/services/artifacts/types";
import type { CanvasNode } from "$lib/shared/artifacts/canvas";
import { uiLanguage } from "$lib/stores/settings";

const api = vi.hoisted(() => ({
	createArtifactComment: vi.fn(),
	resolveArtifactComment: vi.fn(),
	askAlfyInComment: vi.fn(),
	fetchArtifact: vi.fn(),
}));
vi.mock("$lib/client/api/artifacts", () => api);

import {
	CanvasCommentsController,
	catcherProps,
	pinsProps,
	selectionPillProps,
	toggleComments,
} from "./comments-controller.svelte";

// The comment list's state and what it does over the network, without a board
// or a browser: a controller is handed the thread list, and answers with what
// the list, the pins and the editor read. The client API is faked; what is
// asserted is the order of the calls (the reader's board is saved BEFORE Alfy
// reads it) and what each outcome leaves in state.

const NODE: { kind: "node"; nodeId: string } = {
	kind: "node",
	nodeId: "note-1",
};

function thread(
	id: string,
	status: "open" | "resolved" = "open",
): ArtifactComment {
	return {
		id,
		artifactId: "board-1",
		parentId: null,
		anchor: NODE,
		author: "user",
		body: `comment ${id}`,
		status,
		createdAt: 1,
		replies: [],
	};
}

function detail(comments: ArtifactComment[], version = 3) {
	return {
		artifact: { versionNumber: version, body: "{}" } as ArtifactDetail,
		versions: [],
		comments,
	};
}

function make(threads: ArtifactComment[] = []) {
	const deps = {
		artifactId: "board-1",
		conversationId: "conv-1" as string | null,
		beforeAsk: vi.fn().mockResolvedValue(undefined),
		onserver: vi.fn(),
	};
	return {
		controller: new CanvasCommentsController({ ...deps, threads }),
		deps,
	};
}

beforeEach(() => {
	uiLanguage.set("en");
	for (const fn of Object.values(api)) fn.mockReset();
	api.fetchArtifact.mockResolvedValue(detail([]));
});

describe("what the list shows", () => {
	it("counts the open threads, which is the number on the header's button", () => {
		const { controller } = make([
			thread("a"),
			thread("b", "resolved"),
			thread("c"),
		]);
		expect(controller.openCount).toBe(2);
	});

	it("shows Open threads to begin with, and folds nothing open", () => {
		const { controller } = make();
		expect(controller.filter).toBe("open");
		expect(controller.orphanedOpen).toBe(false);
		expect(controller.open).toBe(false);
	});

	it("prefers the thread the pointer is on to the one that was picked", () => {
		const { controller } = make([thread("a"), thread("b")]);
		controller.select("a");
		expect(controller.activeId).toBe("a");
		controller.hover("b");
		expect(controller.activeId).toBe("b");
		controller.hover(null);
		expect(controller.activeId).toBe("a");
	});
});

describe("opening and placing", () => {
	it("opens the list and asks it to bring a thread into view when its pin is pressed", () => {
		const { controller } = make([thread("a")]);
		controller.select("a");
		expect(controller.open).toBe(true);
		expect(controller.focus).toMatchObject({ commentId: "a" });
		const first = controller.focus?.token ?? 0;
		controller.select("a");
		expect(controller.focus?.token).toBeGreaterThan(first);
	});

	it("starts a comment where the tool placed it: the composer opens with the list", () => {
		const { controller } = make([thread("a")]);
		controller.select("a");
		controller.place({ kind: "point", x: 4, y: 9 });
		expect(controller.draft).toEqual({ kind: "point", x: 4, y: 9 });
		expect(controller.open).toBe(true);
		expect(controller.selectedId).toBeNull();
	});

	it("throws a started comment away, on Cancel and on closing the list, so no pin outlives its composer", () => {
		const { controller } = make();
		controller.place({ kind: "point", x: 1, y: 1 });
		controller.cancelDraft();
		expect(controller.draft).toBeNull();
		controller.place({ kind: "point", x: 1, y: 1 });
		toggleComments(controller);
		expect(controller.open).toBe(false);
		expect(controller.draft).toBeNull();
	});

	it("takes the camera to a thread's pin once per request", () => {
		const { controller } = make([thread("a")]);
		controller.goToThread("a");
		const first = controller.goto;
		expect(first).toMatchObject({ commentId: "a" });
		controller.goToThread("a");
		expect(controller.goto?.token).toBeGreaterThan(first?.token ?? 0);
	});
});

describe("asking Alfy about blocks, or the board", () => {
	const MUSEUM: CanvasNode = {
		id: "note-museum",
		type: "sticky",
		position: { x: 0, y: 0 },
		data: { kind: "sticky", text: "Museum, 14:00", tone: "yellow" },
	};
	const LUNCH: CanvasNode = {
		id: "note-lunch",
		type: "sticky",
		position: { x: 0, y: 100 },
		data: { kind: "sticky", text: "Lunch at the market", tone: "yellow" },
	};

	function withBlocks() {
		const made = make();
		made.controller.setNodes([MUSEUM, LUNCH]);
		return made;
	}

	it("starts a comment on the first selected block, with the list open and the words to begin with Alfy's name", () => {
		const { controller } = withBlocks();
		controller.placeOnBlocks(["note-museum"], { ask: true });
		expect(controller.draft).toEqual({ kind: "node", nodeId: "note-museum" });
		expect(controller.draftAsk).toBe(true);
		expect(controller.draftScope).toEqual([]);
		expect(controller.open).toBe(true);
	});

	it("keeps the other selected blocks with the request, and starts a fresh composer each time", () => {
		const { controller } = withBlocks();
		controller.placeOnBlocks(["note-museum", "note-lunch"], { ask: false });
		expect(controller.draft).toEqual({ kind: "node", nodeId: "note-museum" });
		expect(controller.draftScope).toEqual(["note-lunch"]);
		expect(controller.draftAsk).toBe(false);
		const first = controller.draftToken;
		controller.placeOnBlocks(["note-museum"], { ask: true });
		expect(controller.draftToken).toBeGreaterThan(first);
	});

	it("names every selected block in what is posted, so the request says which blocks it is about", async () => {
		api.createArtifactComment.mockResolvedValue(thread("new"));
		api.fetchArtifact.mockResolvedValue(detail([thread("new")]));
		api.askAlfyInComment.mockResolvedValue({
			outcome: "answered",
			applied: 0,
			refused: 0,
			version: 3,
			reply: thread("reply"),
		});
		const { controller } = withBlocks();
		controller.placeOnBlocks(["note-museum", "note-lunch"], { ask: true });
		await controller.post(
			{ kind: "node", nodeId: "note-museum" },
			"@Alfy put these in order",
		);
		const body = api.createArtifactComment.mock.calls[0][2] as string;
		expect(body.startsWith("@Alfy put these in order")).toBe(true);
		expect(body).toContain("“Museum, 14:00”");
		expect(body).toContain("“Lunch at the market”");
		// It was posted: nothing of the request is left to leak into the next one.
		expect(controller.draftScope).toEqual([]);
		expect(controller.draftAsk).toBe(false);
	});

	it("adds nothing to a comment on one block", async () => {
		api.createArtifactComment.mockResolvedValue(thread("new"));
		api.fetchArtifact.mockResolvedValue(detail([thread("new")]));
		const { controller } = withBlocks();
		controller.placeOnBlocks(["note-museum"], { ask: false });
		await controller.post(
			{ kind: "node", nodeId: "note-museum" },
			"Is this right?",
		);
		expect(api.createArtifactComment.mock.calls[0][2]).toBe("Is this right?");
	});

	it("starts a request about the whole board where the reader is looking, which is what the thread's pin will sit on", () => {
		const { controller } = withBlocks();
		controller.placeOnBoard({ x: 320, y: 200 });
		expect(controller.draft).toEqual({ kind: "point", x: 320, y: 200 });
		expect(controller.draftWhole).toBe(true);
		expect(controller.draftAsk).toBe(true);
		expect(controller.open).toBe(true);
	});

	it("goes back to a plain comment when the tool places the next one", () => {
		const { controller } = withBlocks();
		controller.placeOnBoard({ x: 1, y: 1 });
		controller.place({ kind: "point", x: 5, y: 5 });
		expect(controller.draftAsk).toBe(false);
		expect(controller.draftWhole).toBe(false);
		expect(controller.draftScope).toEqual([]);
	});

	it("forgets the request when it is cancelled", () => {
		const { controller } = withBlocks();
		controller.placeOnBlocks(["note-museum", "note-lunch"], { ask: true });
		controller.cancelDraft();
		expect(controller.draft).toBeNull();
		expect(controller.draftScope).toEqual([]);
		expect(controller.draftAsk).toBe(false);
	});

	it("does not start a request about blocks that are not there", () => {
		const { controller } = withBlocks();
		controller.placeOnBlocks(["gone"], { ask: true });
		expect(controller.draft).toBeNull();
	});
});

describe("posting", () => {
	it("posts a new thread on its anchor, refreshes the list, and selects the new card", async () => {
		const posted = thread("new");
		api.createArtifactComment.mockResolvedValue(posted);
		api.fetchArtifact.mockResolvedValue(detail([thread("a"), posted]));
		const { controller, deps } = make([thread("a")]);
		controller.place(NODE);

		await controller.post(NODE, "Is this still right?");

		expect(api.createArtifactComment).toHaveBeenCalledWith(
			"board-1",
			NODE,
			"Is this still right?",
			undefined,
			"conv-1",
		);
		expect(controller.draft).toBeNull();
		expect(controller.threads.map((item) => item.id)).toEqual(["a", "new"]);
		expect(controller.selectedId).toBe("new");
		expect(api.askAlfyInComment).not.toHaveBeenCalled();
		expect(deps.beforeAsk).not.toHaveBeenCalled();
	});

	it("keeps the started comment when the post fails, and says so by throwing", async () => {
		api.createArtifactComment.mockRejectedValue(new Error("offline"));
		const { controller } = make();
		controller.place(NODE);
		await expect(controller.post(NODE, "hello")).rejects.toThrow("offline");
		expect(controller.draft).toEqual(NODE);
	});

	it("posts a reply on its thread", async () => {
		api.createArtifactComment.mockResolvedValue(thread("r"));
		const { controller } = make([thread("a")]);
		await controller.reply("a", "Thanks");
		expect(api.createArtifactComment).toHaveBeenCalledWith(
			"board-1",
			null,
			"Thanks",
			"a",
			"conv-1",
		);
		expect(api.askAlfyInComment).not.toHaveBeenCalled();
	});

	it("resolves and reopens a thread, then reads the list again", async () => {
		api.fetchArtifact.mockResolvedValue(detail([thread("a", "resolved")]));
		const { controller } = make([thread("a")]);
		await controller.resolve("a", true);
		expect(api.resolveArtifactComment).toHaveBeenCalledWith(
			"board-1",
			"a",
			true,
			"conv-1",
		);
		expect(controller.threads[0].status).toBe("resolved");
	});
});

describe("asking Alfy", () => {
	it("saves the reader's board first, then asks, then reads what Alfy did", async () => {
		const order: string[] = [];
		const posted = thread("new");
		api.createArtifactComment.mockResolvedValue(posted);
		api.askAlfyInComment.mockImplementation(async () => {
			order.push("ask");
			return {
				outcome: "applied",
				applied: 2,
				refused: 0,
				version: 4,
				reply: thread("x"),
			};
		});
		const fresh = detail([posted], 4);
		api.fetchArtifact.mockImplementation(async () => {
			order.push("fetch");
			return fresh;
		});
		const { controller, deps } = make();
		deps.beforeAsk.mockImplementation(async () => {
			order.push("save");
		});

		await controller.post(NODE, "@Alfy make this a checklist");

		// The plain refresh after the post comes first; what matters is that the
		// board is saved before the ask, and read again after it.
		expect(order.indexOf("save")).toBeLessThan(order.indexOf("ask"));
		expect(order.lastIndexOf("fetch")).toBeGreaterThan(order.indexOf("ask"));
		expect(api.askAlfyInComment).toHaveBeenCalledWith(
			"board-1",
			"new",
			"conv-1",
		);
		expect(deps.onserver).toHaveBeenLastCalledWith(fresh);
		expect(controller.asking).toBeNull();
	});

	it("shows Alfy working on the thread while it works, and not after", async () => {
		api.createArtifactComment.mockResolvedValue(thread("new"));
		let during: string | null = null;
		const { controller } = make();
		api.askAlfyInComment.mockImplementation(async () => {
			during = controller.asking;
			return {
				outcome: "answered",
				applied: 0,
				refused: 0,
				version: 3,
				reply: thread("x"),
			};
		});
		await controller.post(NODE, "@alfy what is this?");
		expect(during).toBe("new");
		expect(controller.asking).toBeNull();
	});

	it("asks for a reply that mentions Alfy, naming the reply, not the thread", async () => {
		api.createArtifactComment.mockResolvedValue(thread("reply-9"));
		api.askAlfyInComment.mockResolvedValue({
			outcome: "answered",
			applied: 0,
			refused: 0,
			version: 3,
			reply: thread("x"),
		});
		const { controller } = make([thread("a")]);
		await controller.reply("a", "@Alfy and now?");
		expect(api.askAlfyInComment).toHaveBeenCalledWith(
			"board-1",
			"reply-9",
			"conv-1",
		);
	});

	it("leaves the posted comment, and says Alfy could not answer, when the ask fails", async () => {
		api.createArtifactComment.mockResolvedValue(thread("new"));
		api.askAlfyInComment.mockRejectedValue(new Error("504"));
		api.fetchArtifact.mockResolvedValue(detail([thread("new")]));
		const { controller } = make();
		await controller.post(NODE, "@Alfy tidy up");
		expect(controller.notice).toBe(
			"Alfy could not answer just now. Your comment is posted.",
		);
		expect(controller.asking).toBeNull();
		expect(controller.threads.map((item) => item.id)).toEqual(["new"]);
	});

	it("does not ask Alfy about a comment that does not mention it", async () => {
		api.createArtifactComment.mockResolvedValue(thread("new"));
		const { controller } = make();
		await controller.post(NODE, "ask alfy? no.");
		expect(api.askAlfyInComment).not.toHaveBeenCalled();
	});
});

describe("reading the board again", () => {
	it("hands every read to the editor, which decides whether a board Alfy changed must be drawn", async () => {
		const read = detail([thread("a")], 9);
		api.fetchArtifact.mockResolvedValue(read);
		const { controller, deps } = make();
		await controller.refresh();
		expect(api.fetchArtifact).toHaveBeenCalledWith("board-1", "conv-1");
		expect(deps.onserver).toHaveBeenCalledWith(read);
		expect(controller.threads).toEqual([thread("a")]);
	});

	it("keeps what it has when the read fails: a stale list beats a broken one", async () => {
		api.fetchArtifact.mockRejectedValue(new Error("offline"));
		const { controller } = make([thread("a")]);
		await controller.refresh();
		expect(controller.threads.map((item) => item.id)).toEqual(["a"]);
	});
});

describe("what the pins and the catcher are given", () => {
	const api = {
		nodes: [],
		viewport: { x: 4, y: 5, zoom: 0.5 },
		tool: "comment" as const,
		setTool: vi.fn(),
		toBoard: (point: { x: number; y: number }) => point,
		centerOn: vi.fn(),
		announce: vi.fn(),
		size: { width: 800, height: 600 },
		readonly: false,
	};

	it("hands the pins the threads, the selection, the placed comment and the board's own camera", () => {
		const { controller } = make([thread("a"), thread("b")]);
		controller.select("b");
		controller.filter = "all";
		controller.place({ kind: "point", x: 1, y: 2 });
		controller.goToThread("a");
		const props = pinsProps(controller, api);
		expect(props.threads.map((item) => item.id)).toEqual(["a", "b"]);
		expect(props.viewport).toEqual(api.viewport);
		expect(props.draft).toEqual({ kind: "point", x: 1, y: 2 });
		expect(props.showResolved).toBe(true);
		expect(props.goto).toMatchObject({ commentId: "a" });
		expect(props.oncenter).toBe(api.centerOn);
	});

	it("turns a pressed pin into the list's selection", () => {
		const { controller } = make([thread("a")]);
		pinsProps(controller, api).onselect("a");
		expect(controller.selectedId).toBe("a");
		expect(controller.open).toBe(true);
	});

	it("turns the selection pill's two buttons into a request to Alfy and a plain comment, and steps the pill aside while the composer is open", () => {
		const { controller } = make();
		controller.setNodes([
			{
				id: "note-1",
				type: "sticky",
				position: { x: 0, y: 0 },
				data: { kind: "sticky", text: "One", tone: "yellow" },
			},
		]);
		const props = selectionPillProps(controller, api, false);
		expect(props.size).toEqual(api.size);
		expect(props.hidden).toBe(false);
		props.onask(["note-1"]);
		expect(controller.draftAsk).toBe(true);
		expect(selectionPillProps(controller, api, false).hidden).toBe(true);
		controller.cancelDraft();
		props.oncomment(["note-1"]);
		expect(controller.draftAsk).toBe(false);
		expect(controller.draft).toEqual({ kind: "node", nodeId: "note-1" });
	});

	it("tells the pill that Alfy is arranging, so Ask waits", () => {
		const { controller } = make();
		expect(selectionPillProps(controller, api, true).askBusy).toBe(true);
	});

	it("turns a click the catcher placed into a comment waiting for its words", () => {
		const { controller } = make();
		const props = catcherProps(controller, api);
		props.ondraft({ kind: "node", nodeId: "note-1" });
		expect(controller.draft).toEqual({ kind: "node", nodeId: "note-1" });
		expect(props.tool).toBe("comment");
		expect(props.ontoolchange).toBe(api.setTool);
		expect(props.onannounce).toBe(api.announce);
	});
});
