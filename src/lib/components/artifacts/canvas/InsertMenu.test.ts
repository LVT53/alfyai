import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasBlockData } from "$lib/shared/artifacts/canvas-blocks";
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

const EMPTY_LISTING = emptyChatBlocks();

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

describe("Search the web…, in the menu", () => {
	const WEB: Extract<CanvasBlockData, { kind: "liveweb" }> = {
		kind: "liveweb",
		query: "cork weather",
		sources: [
			{
				id: "s1",
				title: "Result",
				url: "https://example.com/r",
				provider: "parallel",
				authorityClass: "primary",
				authorityScore: 0.9,
				publishedAt: null,
				updatedAt: null,
			},
		],
		fetchedAt: 1_000,
	};

	const searchWeb = () => vi.fn(async () => ({ ok: true as const, data: WEB }));

	it("is offered where the panel can search, first among what the chat has, and not where it cannot", async () => {
		mount({
			conversationId: "conv-1",
			load: async () => LISTING,
			searchWeb: searchWeb(),
		});
		await screen.findByText("Vienna trip.pdf");
		const rows = screen.getAllByRole("menuitem");
		expect(rows[STATIC.length]).toHaveAccessibleName("Search the web…");

		document.body.innerHTML = "";
		mount({ conversationId: "conv-1", load: async () => LISTING });
		await screen.findByText("Vienna trip.pdf");
		expect(
			screen.queryByRole("menuitem", { name: "Search the web…" }),
		).toBeNull();
	});

	it("hands over the live-web row and the snapshot the search made", async () => {
		const search = searchWeb();
		const { onpick } = mount({
			conversationId: "conv-1",
			load: async () => EMPTY_LISTING,
			searchWeb: search,
		});
		await fireEvent.click(
			await screen.findByRole("menuitem", { name: "Search the web…" }),
		);
		const field = screen.getByRole("textbox", { name: "Search the web" });
		await fireEvent.input(field, { target: { value: "cork weather" } });
		await fireEvent.click(screen.getByRole("button", { name: "Search" }));

		await waitFor(() => expect(onpick).toHaveBeenCalledTimes(1));
		const [row, data] = onpick.mock.calls[0];
		expect(row).toMatchObject({ kind: "liveweb", section: "chat" });
		expect(data).toEqual(WEB);
	});

	it("leaves the keys of the field to the field: the menu's arrows, Home and End do not carry the cursor out of what is being typed", async () => {
		mount({
			conversationId: "conv-1",
			load: async () => EMPTY_LISTING,
			searchWeb: searchWeb(),
		});
		await fireEvent.click(
			await screen.findByRole("menuitem", { name: "Search the web…" }),
		);
		const field = screen.getByRole("textbox", { name: "Search the web" });
		await waitFor(() => expect(field).toHaveFocus());

		for (const key of [
			"ArrowLeft",
			"ArrowRight",
			"ArrowUp",
			"ArrowDown",
			"Home",
			"End",
		]) {
			const notPrevented = await fireEvent.keyDown(field, { key });
			expect(notPrevented, key).toBe(true);
			expect(field, key).toHaveFocus();
		}
	});

	it("still moves between the rows with the arrows from a row", async () => {
		mount({
			conversationId: "conv-1",
			load: async () => EMPTY_LISTING,
			searchWeb: searchWeb(),
		});
		const row = await screen.findByRole("menuitem", {
			name: "Search the web…",
		});
		row.focus();
		await fireEvent.keyDown(row, { key: "ArrowUp" });
		expect(screen.getByRole("menuitem", { name: "Checklist" })).toHaveFocus();
	});
});

describe("what a pick may put on the board", () => {
	const proxy = (id: string) => `/api/connections/immich/thumbnail/${id}`;
	const photos = (imageUrl: string) => ({
		...emptyChatBlocks(),
		photos: [
			{
				key: "photos:m1:c1",
				at: 1_000,
				query: "beach",
				data: { kind: "photo" as const, items: [{ id: "a", imageUrl }] },
			},
		],
	});

	it("hands over a photo block whose address is the app's own thumbnail", async () => {
		const { onpick } = mount({
			conversationId: "conv-1",
			load: async () => photos(proxy("asset-1")),
		});
		await fireEvent.click(
			await screen.findByRole("menuitem", { name: /beach/ }),
		);
		expect(onpick).toHaveBeenCalledTimes(1);
		expect(onpick.mock.calls[0][0]).toMatchObject({ kind: "photo" });
	});

	it("puts nothing on the board for a photo block whose address is not, whatever the listing said: the rule holds at insert", async () => {
		for (const imageUrl of [
			"https://evil.example/p.png",
			"//evil.example/p.png",
			"/\\evil.example/p.png",
			"/api/auth/logout",
		]) {
			document.body.innerHTML = "";
			const { onpick } = mount({
				conversationId: "conv-1",
				load: async () => photos(imageUrl),
			});
			await fireEvent.click(
				await screen.findByRole("menuitem", { name: /beach/ }),
			);
			expect(onpick, imageUrl).not.toHaveBeenCalled();
		}
	});

	it("puts nothing on the board for a live-web block with a source that is not a web address", async () => {
		const bad = {
			...emptyChatBlocks(),
			searches: [
				{
					key: "search:m1:c1",
					at: 1_000,
					data: {
						kind: "liveweb" as const,
						query: "weather",
						fetchedAt: 1_000,
						sources: [
							{
								id: "s1",
								title: "Click me",
								url: "javascript:alert(1)",
								provider: "p",
								authorityClass: "c",
								authorityScore: 1,
								publishedAt: null,
								updatedAt: null,
							},
						],
					},
				},
			],
		};
		const { onpick } = mount({
			conversationId: "conv-1",
			load: async () => bad,
		});
		await fireEvent.click(
			await screen.findByRole("menuitem", { name: /weather/ }),
		);
		expect(onpick).not.toHaveBeenCalled();
	});
});
