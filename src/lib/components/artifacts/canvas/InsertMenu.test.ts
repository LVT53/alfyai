import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CanvasChatBlocks,
	emptyChatBlocks,
} from "$lib/shared/artifacts/chat-blocks";
import { uiLanguage } from "$lib/stores/settings";
import type { CanvasChatContext } from "./_lib/chat-context";
import WithChat from "./_test/WithChat.svelte";
import InsertMenu from "./InsertMenu.svelte";

// The Insert menu: the rows a reader writes, then "From this chat". One menu,
// one tab stop, arrow keys between every row — the ones that are there from the
// start and the ones that arrive when the chat has been read.

vi.mock("@xyflow/svelte", async () =>
	(await import("./_test/xyflow-mock")).xyflowMock(),
);

const LISTING: CanvasChatBlocks = {
	files: [
		{
			key: "file:f1",
			at: 5_000,
			origin: "produced",
			version: null,
			data: {
				kind: "file",
				fileId: "f1",
				name: "Vienna trip.pdf",
				mime: "application/pdf",
				bytes: 2048,
				label: "PDF",
			},
		},
	],
	apps: [
		{
			key: "app:app-1",
			at: 3_000,
			versionNumber: 2,
			data: { kind: "app", artifactId: "app-1", title: "Tip calculator" },
		},
	],
	maps: [],
	charts: [],
	photos: [],
	searches: [],
};

function mount(chat: CanvasChatContext, onpick = vi.fn()) {
	const view = render(WithChat, {
		props: {
			component: InsertMenu,
			componentProps: { onpick },
			context: {
				readonly: false,
				requestEdit() {},
				takeEditRequest: () => false,
				dropTargetId: null,
			},
			chat,
		},
	});
	return { ...view, onpick };
}

beforeEach(() => {
	uiLanguage.set("en");
});

const STATIC = ["Sticky note", "Text", "Frame", "Chart", "Checklist"];

describe("the Insert menu's rows", () => {
	it("lists the five things a reader writes, and none of the blocks that are picked from the chat", () => {
		mount({ conversationId: "conv-1" });
		const rows = screen.getAllByRole("menuitem");
		expect(rows.map((row) => row.textContent?.trim())).toEqual(STATIC);
		expect(screen.queryByTestId("canvas-insert-file")).toBeNull();
		expect(screen.queryByTestId("canvas-insert-app")).toBeNull();
		expect(screen.queryByTestId("canvas-insert-map")).toBeNull();
	});

	it("offers no From this chat where there is no chat to read", () => {
		mount({ conversationId: null });
		expect(screen.queryByRole("group", { name: "From this chat" })).toBeNull();
	});

	it("hands over the row alone when a written kind is picked", async () => {
		const { onpick } = mount({ conversationId: "conv-1" });
		await fireEvent.click(screen.getByTestId("canvas-insert-sticky"));
		expect(onpick).toHaveBeenCalledTimes(1);
		expect(onpick.mock.calls[0][0]).toMatchObject({ kind: "sticky" });
		expect(onpick.mock.calls[0][1]).toBeUndefined();
	});
});

describe("From this chat, in the menu", () => {
	it("reads the chat when the menu opens and lists what it found after the written rows", async () => {
		const load = vi.fn(async () => LISTING);
		mount({ conversationId: "conv-1", load });

		expect(await screen.findByText("Vienna trip.pdf")).toBeInTheDocument();
		expect(load).toHaveBeenCalledTimes(1);
		const rows = screen.getAllByRole("menuitem");
		expect(rows).toHaveLength(STATIC.length + 2);
		expect(rows[STATIC.length]).toHaveTextContent("Vienna trip.pdf");
		expect(rows[STATIC.length + 1]).toHaveTextContent("Tip calculator");
	});

	it("hands over the block's row and the data that was picked", async () => {
		const load = vi.fn(async () => LISTING);
		const { onpick } = mount({ conversationId: "conv-1", load });
		await fireEvent.click(
			await screen.findByRole("menuitem", { name: /Tip calculator/ }),
		);

		expect(onpick).toHaveBeenCalledTimes(1);
		const [row, data] = onpick.mock.calls[0];
		expect(row).toMatchObject({ kind: "app", section: "chat" });
		expect(data).toEqual(LISTING.apps[0].data);
	});

	it("moves between all the rows with the arrow keys, written ones and chat ones alike, and wraps", async () => {
		mount({ conversationId: "conv-1", load: async () => LISTING });
		await screen.findByText("Vienna trip.pdf");
		const rows = screen.getAllByRole("menuitem");

		rows[0].focus();
		await fireEvent.keyDown(rows[0], { key: "End" });
		expect(rows.at(-1)).toHaveFocus();

		await fireEvent.keyDown(rows.at(-1) as HTMLElement, { key: "ArrowDown" });
		expect(rows[0]).toHaveFocus();

		await fireEvent.keyDown(rows[0], { key: "ArrowUp" });
		expect(rows.at(-1)).toHaveFocus();

		// Down from the last written row goes into the chat's rows.
		rows[STATIC.length - 1].focus();
		await fireEvent.keyDown(rows[STATIC.length - 1], { key: "ArrowDown" });
		expect(rows[STATIC.length]).toHaveFocus();

		await fireEvent.keyDown(rows[STATIC.length], { key: "Home" });
		expect(rows[0]).toHaveFocus();
	});

	it("keeps one tab stop for the whole menu, and it is never a chat row", async () => {
		mount({ conversationId: "conv-1", load: async () => LISTING });
		await screen.findByText("Vienna trip.pdf");
		const rows = screen.getAllByRole("menuitem");
		const stops = rows.filter((row) => row.getAttribute("tabindex") === "0");
		expect(stops).toHaveLength(1);
		expect(rows.indexOf(stops[0])).toBeLessThan(STATIC.length);
	});

	it("says the chat has nothing, quietly, and still offers every written row", async () => {
		mount({
			conversationId: "conv-1",
			load: async () => emptyChatBlocks(),
		});
		expect(
			await screen.findByText("Nothing from this chat to insert yet."),
		).toBeInTheDocument();
		expect(screen.getAllByRole("menuitem")).toHaveLength(STATIC.length);
	});

	it("keeps the written rows working while the chat is being read and after it fails", async () => {
		const { onpick } = mount({
			conversationId: "conv-1",
			load: () => Promise.reject(new Error("offline")),
		});
		await waitFor(() =>
			expect(
				screen.getByText("Couldn't look through this chat."),
			).toBeInTheDocument(),
		);
		await fireEvent.click(screen.getByTestId("canvas-insert-text"));
		expect(onpick).toHaveBeenCalledTimes(1);
	});
});
