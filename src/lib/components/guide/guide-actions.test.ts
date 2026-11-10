import { get } from "svelte/store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { consumeHomeComposerSeed } from "$lib/client/conversation-session";
import { spotlightRequest } from "$lib/stores/spotlight";
import { showGuidePlace, tryGuideExample } from "./guide-actions";

// `goto` is the one thing these actions need from SvelteKit: the test reads
// what the page it would open would find waiting, at the moment it is called.
const goto = vi.hoisted(() => vi.fn());
vi.mock("$app/navigation", () => ({ goto }));

const EXAMPLE =
	"How do I get from Keleti station to the airport by public transport?";

beforeEach(() => {
	goto.mockReset();
	sessionStorage.clear();
	spotlightRequest.set(null);
});

describe("Try it", () => {
	it("hands the example to Home and goes there", async () => {
		await tryGuideExample(EXAMPLE);

		expect(consumeHomeComposerSeed()).toBe(EXAMPLE);
		expect(goto).toHaveBeenCalledWith("/");
	});

	it("leaves the example waiting before it navigates, so Home finds it on arrival", async () => {
		let waitingWhenNavigating: string | null = null;
		goto.mockImplementation(async () => {
			waitingWhenNavigating = consumeHomeComposerSeed();
		});

		await tryGuideExample(EXAMPLE);

		expect(waitingWhenNavigating).toBe(EXAMPLE);
	});
});

describe("Show me", () => {
	it("asks for the control and goes to its place", async () => {
		await showGuidePlace({
			kind: "showMe",
			place: "settings",
			spotlight: "settings.twoStep",
		});

		expect(get(spotlightRequest)?.spotlight).toBe("settings.twoStep");
		expect(goto).toHaveBeenCalledWith("/settings");
	});

	it("goes to Knowledge's Memory tab for the memory entry", async () => {
		await showGuidePlace({
			kind: "showMe",
			place: "knowledgeMemory",
			spotlight: "knowledge.memory",
		});

		expect(goto).toHaveBeenCalledWith("/knowledge?tab=memory");
	});

	it("for a sidebar control stays on the page", async () => {
		await showGuidePlace({
			kind: "showMe",
			place: null,
			spotlight: "sidebar.search",
		});

		expect(get(spotlightRequest)?.spotlight).toBe("sidebar.search");
		expect(goto).not.toHaveBeenCalled();
	});

	it("asks before it navigates, so the page it opens finds the request waiting", async () => {
		let waitingWhenNavigating: string | null = null;
		goto.mockImplementation(async () => {
			waitingWhenNavigating = get(spotlightRequest)?.spotlight ?? null;
		});

		await showGuidePlace({
			kind: "showMe",
			place: "knowledge",
			spotlight: "knowledge.library",
		});

		expect(waitingWhenNavigating).toBe("knowledge.library");
	});
});
