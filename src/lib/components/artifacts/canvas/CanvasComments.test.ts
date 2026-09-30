import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/svelte";
import { tick } from "svelte";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import type { ArtifactComment } from "$lib/server/services/artifacts/types";
import type { CanvasNode } from "$lib/shared/artifacts/canvas";
import { uiLanguage } from "$lib/stores/settings";

const api = vi.hoisted(() => ({
	createArtifactComment: vi.fn(),
	resolveArtifactComment: vi.fn(),
	askAlfyInComment: vi.fn(),
	fetchArtifact: vi.fn(),
}));
vi.mock("$lib/client/api/artifacts", () => api);

const viewport = vi.hoisted(() => ({ phone: false }));
vi.mock("$lib/utils/viewport.svelte", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/utils/viewport.svelte")>()),
	isPhoneViewport: () => viewport.phone,
	watchPhoneViewport: () => () => {},
}));

import { CanvasCommentsController } from "./_lib/comments-controller.svelte";
import CanvasComments from "./CanvasComments.svelte";

// The comments list of a board, beside it, over it or in a sheet: which threads
// it shows and how, what the reader can do in it, and how it is shown. The state
// is a REAL controller (the list is nothing without it); only the network is
// faked. Pins and the camera are the layer's and the e2e's.

beforeAll(() => {
	Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
	uiLanguage.set("en");
	viewport.phone = false;
	for (const fn of Object.values(api)) fn.mockReset();
	api.fetchArtifact.mockResolvedValue({
		artifact: { versionNumber: 1 },
		versions: [],
		comments: [],
	});
});

afterEach(() => {
	cleanup();
});

function thread(
	id: string,
	anchor: ArtifactComment["anchor"],
	extra: Partial<ArtifactComment> = {},
): ArtifactComment {
	return {
		id,
		artifactId: "board-1",
		parentId: null,
		anchor,
		author: "user",
		body: `Comment ${id}`,
		status: "open",
		createdAt: Date.now(),
		replies: [],
		...extra,
	};
}

const NODES: CanvasNode[] = [
	{
		id: "note-museum",
		type: "sticky",
		position: { x: 0, y: 0 },
		data: { kind: "sticky", text: "Museum, 14:00", tone: "mint" },
	},
	{
		id: "frame-a",
		type: "frame",
		position: { x: 0, y: 0 },
		data: { kind: "frame", label: "Saturday", width: 300, height: 200 },
	},
];

function mount(
	threads: ArtifactComment[],
	options: { open?: boolean; panelWidth?: number } = {},
) {
	const controller = new CanvasCommentsController({
		artifactId: "board-1",
		conversationId: null,
		threads,
		beforeAsk: vi.fn().mockResolvedValue(undefined),
		onserver: vi.fn(),
	});
	controller.setNodes(NODES);
	if (options.open !== false) controller.show();
	const view = render(CanvasComments, {
		controller,
		panelWidth: options.panelWidth ?? 1000,
		currentUser: null,
	});
	return { controller, ...view };
}

const NODE_THREAD = thread("a", { kind: "node", nodeId: "note-museum" });
const SPOT_THREAD = thread("b", { kind: "point", x: 10, y: 20 });

describe("what the list shows", () => {
	it("titles itself Comments, with the open count, and lists each thread as a card", () => {
		mount([NODE_THREAD, SPOT_THREAD]);
		expect(screen.getByRole("heading", { name: "Comments" })).toBeTruthy();
		expect(screen.getAllByTestId("canvas-comment")).toHaveLength(2);
		expect(screen.getByText("Comment a")).toBeTruthy();
		expect(screen.getByText("Comment b")).toBeTruthy();
	});

	it("names a block by its own words, a spot as a spot, and numbers each like its pin", () => {
		mount([NODE_THREAD, SPOT_THREAD]);
		const [onBlock, onSpot] = screen.getAllByTestId("canvas-comment");
		expect(within(onBlock).getByText("Museum, 14:00")).toBeTruthy();
		expect(within(onBlock).getByText("1")).toBeTruthy();
		expect(within(onSpot).getByText("a spot on the board")).toBeTruthy();
		expect(within(onSpot).getByText("2")).toBeTruthy();
	});

	it("names a frame by its label", () => {
		mount([thread("f", { kind: "node", nodeId: "frame-a" })]);
		expect(screen.getByText("Saturday")).toBeTruthy();
	});

	it("shows Open threads only, with a quiet toggle to All that folds resolved ones to a line", async () => {
		const done = thread(
			"done",
			{ kind: "point", x: 1, y: 1 },
			{ status: "resolved", body: "Old news" },
		);
		mount([NODE_THREAD, done]);
		expect(screen.queryByText("Old news")).toBeNull();
		const toggle = screen.getByRole("button", { name: "1 resolved" });
		await fireEvent.click(toggle);
		expect(screen.getByRole("button", { name: "Show open only" })).toBeTruthy();
		// A resolved thread is one line until it is opened.
		expect(
			screen.getByRole("button", { name: /Show the full thread/ }),
		).toBeTruthy();
	});

	it("keeps the Open/All choice in the controller, so closing and reopening the list does not lose it", async () => {
		const done = thread(
			"done",
			{ kind: "point", x: 1, y: 1 },
			{ status: "resolved" },
		);
		const { controller } = mount([NODE_THREAD, done]);
		await fireEvent.click(screen.getByRole("button", { name: "1 resolved" }));
		expect(controller.filter).toBe("all");
	});

	it("puts a thread whose block is gone in a folded group, dimmed, saying the block is gone", async () => {
		const gone = thread("gone", { kind: "node", nodeId: "deleted" });
		mount([NODE_THREAD, gone]);
		const group = screen.getByTestId("margin-orphaned-group");
		const toggle = within(group).getByRole("button", {
			name: /1 comment on a block that was removed/,
		});
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByText("Comment gone")).toBeNull();
		await fireEvent.click(toggle);
		const card = within(group).getByTestId("canvas-comment");
		expect(card.classList.contains("is-orphaned")).toBe(true);
		expect(within(card).getByText("The block is gone.")).toBeTruthy();
		expect(within(card).getByText("Comment gone")).toBeTruthy();
	});

	it("says there is nothing yet, and how to start one", () => {
		mount([]);
		expect(
			screen.getByText(
				"No comments yet. Choose Comment, then click a block or a spot on the board.",
			),
		).toBeTruthy();
	});

	it("says every comment is resolved when they all are", () => {
		mount([thread("d", { kind: "point", x: 1, y: 1 }, { status: "resolved" })]);
		expect(screen.getByText("Every comment here is resolved.")).toBeTruthy();
	});

	it("says it all in Hungarian", () => {
		uiLanguage.set("hu");
		mount([thread("gone", { kind: "node", nodeId: "deleted" }), SPOT_THREAD]);
		expect(screen.getByRole("heading", { name: "Megjegyzések" })).toBeTruthy();
		expect(screen.getByText("egy pont a táblán")).toBeTruthy();
		expect(
			screen.getByRole("button", { name: /1 megjegyzés egy törölt blokkon/ }),
		).toBeTruthy();
	});
});

describe("writing a new comment", () => {
	it("opens a composer for a comment that was placed, under a line naming what it is on", () => {
		const { controller } = mount([]);
		controller.place({ kind: "node", nodeId: "note-museum" });
		return tick().then(() => {
			const box = screen.getByTestId("comment-composer");
			expect(
				within(box).getByText("New comment on: Museum, 14:00"),
			).toBeTruthy();
			expect(within(box).getByRole("textbox").getAttribute("placeholder")).toBe(
				"Write a comment. Use @Alfy to ask for a change.",
			);
		});
	});

	it("names a spot for a comment placed on empty board", async () => {
		const { controller } = mount([]);
		controller.place({ kind: "point", x: 3, y: 4 });
		await tick();
		expect(
			screen.getByText("New comment on: a spot on the board"),
		).toBeTruthy();
	});

	it("posts what was written on the block it was placed on, and the composer goes", async () => {
		const posted = thread("new", { kind: "node", nodeId: "note-museum" });
		api.createArtifactComment.mockResolvedValue(posted);
		api.fetchArtifact.mockResolvedValue({
			artifact: { versionNumber: 1 },
			versions: [],
			comments: [posted],
		});
		const { controller } = mount([]);
		controller.place({ kind: "node", nodeId: "note-museum" });
		await tick();
		await fireEvent.input(screen.getByRole("textbox"), {
			target: { value: "Still open?" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "Post" }));
		await vi.waitFor(() =>
			expect(screen.queryByTestId("comment-composer")).toBeNull(),
		);
		expect(api.createArtifactComment).toHaveBeenCalledWith(
			"board-1",
			{ kind: "node", nodeId: "note-museum" },
			"Still open?",
			undefined,
			null,
		);
		expect(await screen.findByText("Comment new")).toBeTruthy();
	});

	it("opens a request to Alfy with its name already in the box", async () => {
		const { controller } = mount([]);
		controller.placeOnBlocks(["note-museum"], { ask: true });
		await tick();
		const box = screen.getByTestId("comment-composer");
		expect(
			(within(box).getByRole("textbox") as HTMLTextAreaElement).value,
		).toBe("@Alfy ");
		expect(within(box).getByText("New comment on: Museum, 14:00")).toBeTruthy();
		expect(within(box).getByRole("button", { name: /Ask Alfy/ })).toBeTruthy();
	});

	it("says how many more blocks a request is about", async () => {
		const { controller } = mount([]);
		controller.placeOnBlocks(["note-museum", "frame-a"], { ask: true });
		await tick();
		expect(
			screen.getByText("New comment on: Museum, 14:00 and 1 more"),
		).toBeTruthy();
	});

	it("says a request is about the whole board", async () => {
		const { controller } = mount([]);
		controller.placeOnBoard({ x: 10, y: 10 });
		await tick();
		expect(screen.getByText("New comment on: the whole board")).toBeTruthy();
	});

	it("starts an empty box for a plain comment on a selection", async () => {
		const { controller } = mount([]);
		controller.placeOnBlocks(["note-museum"], { ask: false });
		await tick();
		expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
	});

	it("starts a new box, not the old words, for each request", async () => {
		const { controller } = mount([]);
		controller.placeOnBlocks(["note-museum"], { ask: true });
		await tick();
		await fireEvent.input(screen.getByRole("textbox"), {
			target: { value: "@Alfy something half written" },
		});
		controller.placeOnBlocks(["note-museum"], { ask: true });
		await tick();
		expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
			"@Alfy ",
		);
	});

	it("throws the placed comment away on Cancel", async () => {
		const { controller } = mount([]);
		controller.place({ kind: "point", x: 1, y: 1 });
		await tick();
		await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(controller.draft).toBeNull();
		expect(screen.queryByTestId("comment-composer")).toBeNull();
	});
});

describe("working a thread", () => {
	it("resolves a thread", async () => {
		mount([NODE_THREAD]);
		await fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
		expect(api.resolveArtifactComment).toHaveBeenCalledWith(
			"board-1",
			"a",
			true,
			null,
		);
	});

	it("replies in the thread, in the board's own words", async () => {
		api.createArtifactComment.mockResolvedValue(
			thread("r", null, { parentId: "a" }),
		);
		mount([NODE_THREAD]);
		await fireEvent.click(screen.getByRole("button", { name: "Reply" }));
		const box = screen.getByRole("textbox");
		expect(box.getAttribute("placeholder")).toBe(
			"Reply, or ask @Alfy to change the board…",
		);
		await fireEvent.input(box, { target: { value: "Thanks" } });
		await fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
		await vi.waitFor(() =>
			expect(api.createArtifactComment).toHaveBeenCalledWith(
				"board-1",
				null,
				"Thanks",
				"a",
				null,
			),
		);
	});

	it("takes the camera to a thread's pin from its quote line, and from a click on the card", async () => {
		const { controller } = mount([NODE_THREAD]);
		await fireEvent.click(
			screen.getByRole("button", { name: "Show Museum, 14:00 on the board" }),
		);
		expect(controller.goto).toMatchObject({ commentId: "a" });
		const first = controller.goto?.token ?? 0;
		await fireEvent.click(screen.getByTestId("canvas-comment"));
		expect(controller.goto?.token).toBeGreaterThan(first);
	});

	it("does not take the camera anywhere for a card whose block is gone", async () => {
		const { controller } = mount([
			thread("gone", { kind: "node", nodeId: "deleted" }),
		]);
		await fireEvent.click(
			screen.getByRole("button", {
				name: /1 comment on a block that was removed/,
			}),
		);
		await fireEvent.click(screen.getByTestId("canvas-comment"));
		expect(controller.goto).toBeNull();
	});

	it("tells the pins which card the pointer is on", async () => {
		const { controller } = mount([NODE_THREAD, SPOT_THREAD]);
		const [first] = screen.getAllByTestId("canvas-comment");
		await fireEvent.mouseEnter(first);
		expect(controller.activeId).toBe("a");
		await fireEvent.mouseLeave(first);
		expect(controller.activeId).toBeNull();
	});

	it("brings the card of a thread whose pin was pressed into view, and focuses it", async () => {
		const { controller } = mount([NODE_THREAD, SPOT_THREAD]);
		controller.select("b");
		await tick();
		await tick();
		const card = screen.getAllByTestId("canvas-comment")[1];
		expect(document.activeElement).toBe(card);
		expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
	});

	it("shows Alfy at work in the thread it is answering in", async () => {
		const { controller } = mount([NODE_THREAD, SPOT_THREAD]);
		controller.asking = "b";
		await tick();
		const [first, second] = screen.getAllByTestId("canvas-comment");
		expect(within(second).getByText("Alfy is writing…")).toBeTruthy();
		expect(within(first).queryByText("Alfy is writing…")).toBeNull();
	});
});

describe("where it is shown", () => {
	it("is a column beside the board when the panel has room for one", () => {
		mount([NODE_THREAD], { panelWidth: 1000 });
		const rail = screen.getByTestId("canvas-comments-rail");
		expect(rail.tagName).toBe("ASIDE");
		expect(rail.getAttribute("aria-label")).toBe("Comments");
		expect(screen.queryByTestId("comments-drawer")).toBeNull();
	});

	it("is a drawer over the board when the panel is too narrow to hold a column beside it", () => {
		mount([NODE_THREAD], { panelWidth: 600 });
		expect(screen.queryByTestId("canvas-comments-rail")).toBeNull();
		const drawer = screen.getByTestId("comments-drawer");
		expect(within(drawer).getByText("Comment a")).toBeTruthy();
		// The drawer carries its own way out.
		expect(within(drawer).getByRole("button", { name: "Close" })).toBeTruthy();
	});

	it("is a sheet on a phone, whatever the width", () => {
		viewport.phone = true;
		mount([NODE_THREAD], { panelWidth: 1000 });
		expect(screen.getByRole("dialog", { name: "Comments" })).toBeTruthy();
		expect(screen.queryByTestId("canvas-comments-rail")).toBeNull();
	});

	it("closes the drawer when the reader goes to a pin: the board is what they came for", async () => {
		const { controller } = mount([NODE_THREAD], { panelWidth: 600 });
		await fireEvent.click(
			screen.getByRole("button", { name: "Show Museum, 14:00 on the board" }),
		);
		expect(controller.open).toBe(false);
		expect(controller.goto).toMatchObject({ commentId: "a" });
	});

	it("leaves the column showing when the reader goes to a pin", async () => {
		const { controller } = mount([NODE_THREAD], { panelWidth: 1000 });
		await fireEvent.click(
			screen.getByRole("button", { name: "Show Museum, 14:00 on the board" }),
		);
		expect(controller.open).toBe(true);
	});

	it("draws nothing while the list is closed", () => {
		mount([NODE_THREAD], { open: false });
		expect(screen.queryByTestId("canvas-comments-rail")).toBeNull();
		expect(screen.queryByTestId("comments-drawer")).toBeNull();
	});
});
