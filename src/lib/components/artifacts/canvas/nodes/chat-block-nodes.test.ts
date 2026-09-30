import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import type { Component } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "$lib/client/api/http";
import { APP_IFRAME_SANDBOX } from "$lib/server/services/artifacts/app/sandbox-response";
import { uiLanguage } from "$lib/stores/settings";
import type { CanvasBoardContext } from "../_lib/board-context";
import type { CanvasChatContext } from "../_lib/chat-context";
import WithChat from "../_test/WithChat.svelte";
import AppNode from "./AppNode.svelte";
import FileNode from "./FileNode.svelte";
import MapNode from "./MapNode.svelte";

// The blocks made from the chat, drawn against a stand-in for the flow library
// and for the chat's map card (MapLibre needs a WebGL context jsdom lacks). What
// is measured is what each block PROMISES: the chat's own components with the
// chat's own props, the App's own sandbox and storage, and the board's gestures
// kept off them.

vi.mock("@xyflow/svelte", async () =>
	(await import("../_test/xyflow-mock")).xyflowMock(),
);
vi.mock("$lib/components/chat/MapRouteCard.svelte", async () => ({
	default: (await import("../_test/StubMapRouteCard.svelte")).default,
}));

const fetchArtifact = vi.fn();
const subscribeArtifactChanges = vi.fn();
const readAppValue = vi.fn();
const writeAppValue = vi.fn();
vi.mock("$lib/client/api/artifacts", () => ({
	fetchArtifact: (...args: unknown[]) => fetchArtifact(...args),
	subscribeArtifactChanges: (...args: unknown[]) =>
		subscribeArtifactChanges(...args),
	readAppValue: (...args: unknown[]) => readAppValue(...args),
	writeAppValue: (...args: unknown[]) => writeAppValue(...args),
}));

function board(): CanvasBoardContext {
	return {
		readonly: false,
		requestEdit() {},
		takeEditRequest: () => false,
		dropTargetId: null,
	};
}

function chatContext(
	overrides: Partial<CanvasChatContext> = {},
): CanvasChatContext {
	return { conversationId: "conv-1", ...overrides };
}

function mount(
	// biome-ignore lint/suspicious/noExplicitAny: any node component, whatever its props
	component: Component<any>,
	componentProps: Record<string, unknown>,
	chat: CanvasChatContext = chatContext(),
) {
	return render(WithChat, {
		props: { component, componentProps, context: board(), chat },
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	uiLanguage.set("en");
	subscribeArtifactChanges.mockReturnValue(() => {});
	fetchArtifact.mockResolvedValue({
		artifact: { id: "app-7", kind: "app", versionNumber: 3 },
		versions: [],
		comments: [],
	});
});

// ── File ────────────────────────────────────────────────────────────────────

const fileProps = (
	data: Record<string, unknown> = {},
	extra: Record<string, unknown> = {},
) => ({
	id: "file-1",
	selected: false,
	data: {
		kind: "file",
		fileId: "chat-file-1",
		name: "Vienna trip.pdf",
		mime: "application/pdf",
		bytes: 2048,
		label: "PDF",
		...data,
	},
	...extra,
});

describe("a file block", () => {
	it("is one compact row: the file's icon, its name, its type and its size", () => {
		const { container } = mount(FileNode, fileProps());
		const row = screen.getByTestId("canvas-file");
		expect(row).toHaveTextContent("Vienna trip.pdf");
		expect(row).toHaveTextContent("PDF");
		expect(row).toHaveTextContent("2.0 KB");
		expect(
			container.querySelector('[data-testid="canvas-file"] svg'),
		).not.toBeNull();
	});

	it("shows just the name for a file with no type and no size", () => {
		mount(FileNode, fileProps({ label: "", bytes: 0 }));
		const row = screen.getByTestId("canvas-file");
		expect(row).toHaveTextContent("Vienna trip.pdf");
		expect(row.textContent).not.toMatch(/\b0 B\b/);
	});

	it("opens a produced file in the panel's viewer, as the chat's own card opens it", async () => {
		const openItem = vi.fn();
		mount(FileNode, fileProps(), chatContext({ openItem }));

		await fireEvent.click(
			screen.getByRole("button", { name: /Open Vienna trip\.pdf/ }),
		);

		expect(openItem).toHaveBeenCalledTimes(1);
		expect(openItem).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "chat-file-1",
				source: "chat_generated_file",
				filename: "Vienna trip.pdf",
				title: "Vienna trip.pdf",
				mimeType: "application/pdf",
				previewUrl: "/api/chat/files/chat-file-1/preview",
				downloadUrl: "/api/chat/files/chat-file-1/download",
				sourceChatFileId: "chat-file-1",
			}),
		);
	});

	it("opens an attached file the way the library opens one: by its own id", async () => {
		const openItem = vi.fn();
		mount(
			FileNode,
			fileProps({ fileId: "artifact:art-1", name: "budget.xlsx", mime: "" }),
			chatContext({ openItem }),
		);

		await fireEvent.click(
			screen.getByRole("button", { name: /Open budget\.xlsx/ }),
		);

		expect(openItem).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "artifact:art-1",
				source: "knowledge_artifact",
				artifactId: "art-1",
				filename: "budget.xlsx",
				title: "budget.xlsx",
				mimeType: null,
			}),
		);
	});

	it("does not open anything for a file whose id names no file", async () => {
		const openItem = vi.fn();
		mount(
			FileNode,
			fileProps({ fileId: "artifact:" }),
			chatContext({ openItem }),
		);
		await fireEvent.click(screen.getByTestId("canvas-file"));
		expect(openItem).not.toHaveBeenCalled();
	});

	it("is a real button that takes the keyboard, and does not stop the block being dragged", () => {
		mount(FileNode, fileProps(), chatContext({ openItem: vi.fn() }));
		const button = screen.getByRole("button", {
			name: /Open Vienna trip\.pdf/,
		});
		expect(button.tagName).toBe("BUTTON");
		expect(button.getAttribute("type")).toBe("button");
		expect(button.getAttribute("tabindex")).not.toBe("-1");
		// A click opens the file and a drag moves the block, so the row must not
		// opt out of the board's drag.
		expect(button.className).not.toContain("nodrag");
	});

	it("opens on Enter while the block itself has focus, like a note opens for editing", async () => {
		const openItem = vi.fn();
		mount(FileNode, fileProps(), chatContext({ openItem }));
		await fireEvent.keyDown(screen.getByTestId("node-wrapper"), {
			key: "Enter",
		});
		expect(openItem).toHaveBeenCalledTimes(1);
	});

	it("is a plain row, not a button, where the panel cannot open a file", () => {
		mount(FileNode, fileProps(), chatContext({ openItem: undefined }));
		expect(screen.queryByRole("button", { name: /Open/ })).toBeNull();
		expect(screen.getByTestId("canvas-file")).toHaveTextContent(
			"Vienna trip.pdf",
		);
	});

	it("names the node for a screen reader from the file's name, and its kind", () => {
		mount(FileNode, fileProps());
		const wrapper = screen.getByTestId("node-wrapper");
		expect(wrapper.getAttribute("aria-roledescription")).toBe("File");
		expect(wrapper.getAttribute("aria-label")).toBe("File: Vienna trip.pdf");
	});

	it("says it in Hungarian in Hungarian", () => {
		uiLanguage.set("hu");
		mount(FileNode, fileProps(), chatContext({ openItem: vi.fn() }));
		expect(
			screen.getByTestId("node-wrapper").getAttribute("aria-roledescription"),
		).toBe("Fájl");
		expect(
			screen.getByRole("button", { name: /Vienna trip\.pdf megnyitása/ }),
		).toBeInTheDocument();
	});
});

// ── Map ─────────────────────────────────────────────────────────────────────

const MAP = {
	bounds: { minLat: 51.7, minLng: -8.5, maxLat: 51.9, maxLng: -8.4 },
	originLabel: "Cork",
	destinationLabel: "Kinsale",
	attribution: "© OpenStreetMap contributors",
};

const mapProps = (data: Record<string, unknown> = {}) => ({
	id: "map-1",
	selected: false,
	data: {
		kind: "map",
		route: "Cork → Kinsale",
		meta: "27.0 km · 34 min",
		map: MAP,
		...data,
	},
});

describe("a map block", () => {
	it("hands the chat's own map card the map the chat hands it, and no prop the chat does not have", async () => {
		mount(MapNode, mapProps());
		const stub = await screen.findByTestId("map-card-stub");
		const names = JSON.parse(stub.dataset.propNames ?? "[]") as string[];
		expect(names).toContain("map");
		for (const name of names) {
			expect(["map", "highlightRange", "focusRange"]).toContain(name);
		}
		expect(JSON.parse(stub.dataset.route ?? "null")).toBe("Cork");
	});

	it("reads the route and its summary off the card's header, as the chat's row reads them", async () => {
		mount(MapNode, mapProps());
		await screen.findByTestId("map-card-stub");
		expect(screen.getByText("Cork → Kinsale")).toBeInTheDocument();
		expect(screen.getByText("27.0 km · 34 min")).toBeInTheDocument();
	});

	it("titles a route with no name after the kind", async () => {
		mount(MapNode, mapProps({ route: "", meta: undefined }));
		await screen.findByTestId("map-card-stub");
		expect(screen.getByText("Map")).toBeInTheDocument();
	});

	it("keeps the map's own gestures: dragging or scrolling on it moves the map, not the board", async () => {
		mount(MapNode, mapProps());
		await screen.findByTestId("map-card-stub");
		const surface = screen.getByTestId("canvas-map");
		for (const name of ["nodrag", "nowheel", "nopan"]) {
			expect(surface.classList.contains(name), name).toBe(true);
		}
	});

	it("names the node after the route", () => {
		mount(MapNode, mapProps());
		const wrapper = screen.getByTestId("node-wrapper");
		expect(wrapper.getAttribute("aria-roledescription")).toBe("Map");
		expect(wrapper.getAttribute("aria-label")).toBe("Map: Cork → Kinsale");
	});
});

// ── App ─────────────────────────────────────────────────────────────────────

const appProps = (data: Record<string, unknown> = {}) => ({
	id: "node-app-1",
	selected: false,
	data: { kind: "app", artifactId: "app-7", title: "Tip calculator", ...data },
});

const frame = (container: HTMLElement) =>
	container.querySelector("iframe") as HTMLIFrameElement | null;

describe("an App block", () => {
	it("asks for the App by its own id in the panel's conversation, and draws no frame until it is answered", async () => {
		let answer: (value: unknown) => void = () => {};
		fetchArtifact.mockReturnValue(new Promise((resolve) => (answer = resolve)));
		const { container } = mount(AppNode, appProps());

		expect(fetchArtifact).toHaveBeenCalledWith("app-7", "conv-1");
		expect(frame(container)).toBeNull();
		expect(screen.getByText("Opening the App…")).toBeInTheDocument();

		answer({ artifact: { id: "app-7", kind: "app", versionNumber: 3 } });
		await waitFor(() => expect(frame(container)).not.toBeNull());
	});

	it("runs the App in the panel's own frame: exactly the sandbox the panel's frame has, at the App's own route", async () => {
		const { container } = mount(AppNode, appProps());
		await waitFor(() => expect(frame(container)).not.toBeNull());
		const iframe = frame(container) as HTMLIFrameElement;

		expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
		// Pinned to the one constant the served route's CSP also reads.
		expect(iframe.getAttribute("sandbox")).toBe(APP_IFRAME_SANDBOX);
		expect(iframe.getAttribute("sandbox")?.split(/\s+/)).toEqual([
			"allow-scripts",
			"allow-forms",
		]);
		expect(iframe.getAttribute("src")).toBe(
			"/api/artifacts/app-7/app?v=3&conversationId=conv-1",
		);
		expect(iframe.getAttribute("title")).toContain("Tip calculator");
	});

	it("keeps the board's gestures off the App: dragging, scrolling and panning on it belong to the App", async () => {
		const { container } = mount(AppNode, appProps());
		await waitFor(() => expect(frame(container)).not.toBeNull());
		const stage = screen.getByTestId("canvas-app");
		for (const name of ["nodrag", "nowheel", "nopan"]) {
			expect(stage.classList.contains(name), name).toBe(true);
		}
		expect(stage.contains(frame(container))).toBe(true);
	});

	it("saves the App's storage under the App's own id, never the block's and never the board's", async () => {
		writeAppValue.mockResolvedValue({ ok: true });
		const { container } = mount(AppNode, appProps());
		await waitFor(() => expect(frame(container)).not.toBeNull());
		const iframe = frame(container) as HTMLIFrameElement;

		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					v: 1,
					kind: "alfy.storage",
					method: "set",
					id: 1,
					args: ["notes", "hello"],
				},
				source: iframe.contentWindow as Window,
				origin: "null",
			}),
		);

		await waitFor(() => expect(writeAppValue).toHaveBeenCalledTimes(1));
		expect(writeAppValue).toHaveBeenCalledWith(
			"app-7",
			"notes",
			"hello",
			"conv-1",
		);
	});

	it("keeps two Apps' storage apart when both are on one board", async () => {
		writeAppValue.mockResolvedValue({ ok: true });
		fetchArtifact.mockImplementation(async (id: string) => ({
			artifact: { id, kind: "app", versionNumber: 1 },
			versions: [],
			comments: [],
		}));
		const first = mount(
			AppNode,
			appProps({ artifactId: "app-a", title: "First" }),
		);
		const second = mount(
			AppNode,
			appProps({ artifactId: "app-b", title: "Second" }),
		);
		await waitFor(() => {
			expect(frame(first.container)).not.toBeNull();
			expect(frame(second.container)).not.toBeNull();
		});
		const send = (from: HTMLIFrameElement, value: string) =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						v: 1,
						kind: "alfy.storage",
						method: "set",
						id: 1,
						args: ["k", value],
					},
					source: from.contentWindow as Window,
					origin: "null",
				}),
			);

		send(frame(first.container) as HTMLIFrameElement, "from the first");
		await waitFor(() => expect(writeAppValue).toHaveBeenCalledTimes(1));
		send(frame(second.container) as HTMLIFrameElement, "from the second");
		await waitFor(() => expect(writeAppValue).toHaveBeenCalledTimes(2));

		expect(writeAppValue.mock.calls[0].slice(0, 3)).toEqual([
			"app-a",
			"k",
			"from the first",
		]);
		expect(writeAppValue.mock.calls[1].slice(0, 3)).toEqual([
			"app-b",
			"k",
			"from the second",
		]);
	});

	it("says the App is no longer available when it cannot be read (deleted, or out of reach), and draws no frame", async () => {
		fetchArtifact.mockRejectedValue(new ApiError("gone", { status: 404 }));
		const { container } = mount(AppNode, appProps());
		expect(
			await screen.findByText("This App is no longer available."),
		).toBeInTheDocument();
		expect(frame(container)).toBeNull();
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
	});

	it("draws no frame for an id that is not an App any more (a block rewritten to point at something else)", async () => {
		fetchArtifact.mockResolvedValue({
			artifact: { id: "app-7", kind: "document", versionNumber: 2 },
			versions: [],
			comments: [],
		});
		const { container } = mount(AppNode, appProps());
		expect(
			await screen.findByText("This App is no longer available."),
		).toBeInTheDocument();
		expect(frame(container)).toBeNull();
	});

	it("offers a retry when the read failed for another reason, and draws the App once it works", async () => {
		fetchArtifact.mockRejectedValueOnce(new ApiError("boom", { status: 500 }));
		const { container } = mount(AppNode, appProps());
		expect(
			await screen.findByText("Couldn't open this App."),
		).toBeInTheDocument();

		await fireEvent.click(screen.getByRole("button", { name: "Try again" }));

		await waitFor(() => expect(frame(container)).not.toBeNull());
		expect(fetchArtifact).toHaveBeenCalledTimes(2);
	});

	it("follows the App: a newer version reloads the frame, a deletion ends it, another App's news is not its own", async () => {
		let listener: (change: unknown) => void = () => {};
		subscribeArtifactChanges.mockImplementation(
			(next: (change: unknown) => void) => {
				listener = next;
				return () => {};
			},
		);
		const { container } = mount(AppNode, appProps());
		await waitFor(() => expect(frame(container)).not.toBeNull());

		listener({
			type: "version",
			artifactId: "some-other-app",
			version: 9,
			updatedAt: null,
		});
		expect(frame(container)?.getAttribute("src")).toContain("v=3");

		listener({
			type: "version",
			artifactId: "app-7",
			version: 4,
			updatedAt: null,
		});
		await waitFor(() =>
			expect(frame(container)?.getAttribute("src")).toContain("v=4"),
		);

		listener({
			type: "version",
			artifactId: "app-7",
			version: 2,
			updatedAt: null,
		});
		expect(frame(container)?.getAttribute("src")).toContain("v=4");

		listener({ type: "deleted", artifactId: "app-7" });
		expect(
			await screen.findByText("This App is no longer available."),
		).toBeInTheDocument();
		expect(frame(container)).toBeNull();
	});

	it("titles the card after the App and names the node for a screen reader", async () => {
		mount(AppNode, appProps());
		expect(screen.getByText("Tip calculator")).toBeInTheDocument();
		const wrapper = screen.getByTestId("node-wrapper");
		expect(wrapper.getAttribute("aria-roledescription")).toBe("App");
		expect(wrapper.getAttribute("aria-label")).toBe("App: Tip calculator");
	});

	it("says its states in Hungarian in Hungarian", async () => {
		uiLanguage.set("hu");
		fetchArtifact.mockRejectedValue(new ApiError("gone", { status: 404 }));
		mount(AppNode, appProps());
		expect(
			await screen.findByText("Ez az alkalmazás már nem érhető el."),
		).toBeInTheDocument();
		expect(
			screen.getByTestId("node-wrapper").getAttribute("aria-roledescription"),
		).toBe("Alkalmazás");
	});
});
