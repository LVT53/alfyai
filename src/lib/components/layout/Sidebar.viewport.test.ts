import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { readable } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sidebarCollapsed, sidebarOpen } from "$lib/stores/ui";
import { viewportStore } from "$lib/utils/viewport.svelte";
import Sidebar from "./Sidebar.svelte";

// Unlike `Sidebar.test.ts`, this file does not replace the viewport module: the
// sidebar runs against the real `viewportStore`, which is what a page shows.

vi.mock("$app/navigation", () => ({
	goto: vi.fn(),
	invalidateAll: vi.fn(),
}));

vi.mock("$app/stores", () => ({
	navigating: readable(null),
	page: readable({ url: new URL("http://localhost/") }),
}));

// The "?" that opens the feature guide reads the page's path.
vi.mock("$app/state", () => ({
	page: { url: new URL("http://localhost/") },
}));

vi.mock("$lib/client/api/workspace-search", () => ({
	fetchWorkspaceSearch: vi.fn().mockResolvedValue({
		mode: "default",
		query: "",
		conversations: [],
		documents: [],
	}),
}));

/** `window.matchMedia` answers the pointer query the store reads: no touch screen. */
function stubMatchMedia() {
	vi.stubGlobal(
		"matchMedia",
		vi.fn((query: string) => ({
			matches: false,
			media: query,
			onchange: null,
			addListener: () => undefined,
			removeListener: () => undefined,
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
			dispatchEvent: () => false,
		})),
	);
}

const aside = () => document.querySelector("aside");

// `viewportStore` starts as the server renders it ("desktop") and says what the
// window really is only once something calls `initViewportTracking()`. The
// composer and the model selector did; a page without one, loaded directly (a
// reload of Settings, the Knowledge Base or the guide), left a phone's sidebar
// believing it was a desktop one: it drew the desktop rail, the header's button
// toggled the rail instead of opening the drawer, and the guide's Show me for
// Search and Projects found no drawer to open.
describe("Sidebar — on a page where nothing else tracks the viewport", () => {
	beforeEach(() => {
		stubMatchMedia();
		// What a page without a composer, loaded directly, starts with.
		viewportStore.tier = "desktop";
		viewportStore.touch = false;
		// A new device's preference is the rail, which a phone never shows.
		sidebarCollapsed.set(true);
		sidebarOpen.set(false);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		viewportStore.tier = "desktop";
		viewportStore.touch = false;
		sidebarCollapsed.set(false);
		sidebarOpen.set(false);
	});

	it("is the drawer on a phone-sized window, not a desktop rail that sits off to the side", async () => {
		vi.stubGlobal("innerWidth", 390);
		expect(viewportStore.tier).toBe("desktop");

		render(Sidebar, { open: false });
		await tick();

		expect(viewportStore.tier).toBe("phone");
		// The shut drawer: mounted, hidden with opacity and pointer-events.
		expect(aside()).toHaveClass("opacity-0", "pointer-events-none");
		expect(aside()).not.toHaveClass("sidebar-collapsed");
		// And it holds the full sidebar, the search pill included, not the rail.
		expect(document.querySelector(".search-pill")).not.toBeNull();
	});

	it("is the drawer on a tablet-sized window too", async () => {
		vi.stubGlobal("innerWidth", 800);

		render(Sidebar, { open: false });
		await tick();

		expect(viewportStore.tier).toBe("tablet");
		expect(aside()).toHaveClass("opacity-0", "pointer-events-none");
	});

	it("stays the desktop sidebar on a desktop-sized window", async () => {
		vi.stubGlobal("innerWidth", 1280);

		render(Sidebar, { open: true });
		await tick();

		expect(viewportStore.tier).toBe("desktop");
		expect(aside()).not.toHaveClass("opacity-0");
		expect(aside()).toHaveClass("sidebar-collapsed");
	});

	it("goes on following the window after it has mounted", async () => {
		vi.stubGlobal("innerWidth", 390);
		render(Sidebar, { open: false });
		await tick();
		expect(aside()).toHaveClass("opacity-0");

		vi.stubGlobal("innerWidth", 1280);
		window.dispatchEvent(new Event("resize"));
		await tick();

		expect(viewportStore.tier).toBe("desktop");
		expect(aside()).not.toHaveClass("opacity-0");
	});
});
