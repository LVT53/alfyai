import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { get } from "svelte/store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
import { clearToasts, toasts } from "$lib/stores/toast";
import AppBody from "./AppBody.svelte";

// The dictionary itself is not exported by $lib/i18n (only the `t` store and
// the `I18nKey` type are) — these are copied from the artifacts.app.* table
// this slice added (i18n/artifacts.ts) rather than re-deriving them from a
// private module.
const en = {
	verifyClean: "Alfy checked the facts in this app.",
	verifyRepaired: "Alfy checked the facts and fixed one thing.",
	verifyUncertain: "Alfy was not sure about one detail — see the note.",
	verifyUnavailable: "Alfy could not check the facts in this app.",
	glitchNetwork:
		"This app tried to reach the network. Everything still works offline.",
	glitchStorage:
		"This app used browser storage instead of Alfy's. Your data may not be kept.",
	glitchExternal:
		"This app was built to load something from outside. It runs, but parts may be missing.",
	downloadUnavailable:
		"This app is not in a chat, so it cannot be saved as a file.",
	regeneratePrompt: "What should change?",
};
const hu = {
	verifyUncertain: "Alfy egy részletben nem volt biztos — lásd a megjegyzést.",
};

const fetchArtifact = vi.fn();
const downloadAppAsHtml = vi.fn();
const regenerateApp = vi.fn();
const restoreArtifactVersion = vi.fn();
vi.mock("$lib/client/api/artifacts", () => ({
	fetchArtifact: (...args: unknown[]) => fetchArtifact(...args),
	downloadAppAsHtml: (...args: unknown[]) => downloadAppAsHtml(...args),
	regenerateApp: (...args: unknown[]) => regenerateApp(...args),
	restoreArtifactVersion: (...args: unknown[]) =>
		restoreArtifactVersion(...args),
}));

// Ruling 58: the Code tab loads its highlighter ON DEMAND when it opens,
// through the existing async Shiki path (renderHighlightedText, which
// ensures the highlighter AND the "html" grammar are loaded before calling
// the synchronous renderCodeBlock) — not the bare synchronous renderCodeBlock,
// which silently falls back to escaped plain text unless something ELSE
// already initialised Shiki first.
const renderHighlightedText = vi.fn(
	async (content: string) =>
		`<pre data-testid="highlighted"><code>${content}</code></pre>`,
);
vi.mock("$lib/services/markdown", () => ({
	renderHighlightedText: (...args: unknown[]) =>
		(renderHighlightedText as (...a: unknown[]) => Promise<string>)(...args),
}));

const APP_HTML =
	"<!doctype html><html><body><h1>Habit tracker</h1></body></html>";

function baseDetail(overrides: Record<string, unknown> = {}) {
	return {
		artifact: {
			id: "app-1",
			kind: "app",
			title: "Habit tracker",
			conversationId: "conv-1",
			versionNumber: 2,
			commentCount: 0,
			updatedAt: 1,
			body: APP_HTML,
			bodyHash: "hash",
			metadata: { artifactType: "app", title: "Habit tracker" },
			...overrides,
		},
		versions: [],
		comments: [],
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	uiLanguage.set("en");
	clearToasts();
	fetchArtifact.mockResolvedValue(baseDetail());
	restoreArtifactVersion.mockResolvedValue(4);
	// jsdom has no matchMedia; $lib/stores/theme's `isDark` (system mode) reads
	// it. Stubbed here rather than globally — this is the first artifact test
	// to read the theme store reactively.
	vi.stubGlobal(
		"matchMedia",
		vi.fn().mockReturnValue({
			matches: false,
			media: "",
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn(),
			onchange: null,
		}),
	);
});

describe("AppBody — loading and tabs", () => {
	it("shows Preview by default, with Code available but inactive", async () => {
		render(AppBody, {
			artifactId: "app-1",
			kind: "app",
			title: "Habit tracker",
			body: null,
		});

		const previewTab = await screen.findByRole("tab", { name: /Preview/ });
		const codeTab = screen.getByRole("tab", { name: /Code/ });
		expect(previewTab.getAttribute("aria-selected")).toBe("true");
		expect(codeTab.getAttribute("aria-selected")).toBe("false");
	});

	// Ruling 58: the highlighter loads ON DEMAND when the Code tab opens, not
	// eagerly on mount — the chat's own Shiki init (or lack of it) must not
	// decide whether this card's Code tab is highlighted.
	it("does not load the highlighter while showing Preview", async () => {
		render(AppBody, {
			artifactId: "app-1",
			kind: "app",
			title: "Habit tracker",
			body: null,
		});
		await screen.findByRole("tab", { name: /Preview/ });

		expect(renderHighlightedText).not.toHaveBeenCalled();
	});

	it("switches to Code on click and renders the stored HTML read-only, through the existing Shiki path", async () => {
		render(AppBody, {
			artifactId: "app-1",
			kind: "app",
			title: "Habit tracker",
			body: null,
		});
		const codeTab = await screen.findByRole("tab", { name: /Code/ });

		await fireEvent.click(codeTab);

		await waitFor(() => expect(renderHighlightedText).toHaveBeenCalled());
		expect(renderHighlightedText).toHaveBeenCalledWith(
			APP_HTML,
			"html",
			expect.any(Boolean),
		);
	});

	it("the code tab has no editing control: no textarea, no contenteditable, in the code panel", async () => {
		const { container } = render(AppBody, {
			artifactId: "app-1",
			kind: "app",
			title: "Habit tracker",
			body: null,
		});
		const codeTab = await screen.findByRole("tab", { name: /Code/ });
		await fireEvent.click(codeTab);
		await waitFor(() => expect(renderHighlightedText).toHaveBeenCalled());

		const codePanel = container.querySelector(".app-body-code");
		expect(codePanel?.querySelector("textarea")).toBeNull();
		expect(codePanel?.querySelector("[contenteditable='true']")).toBeNull();
	});
});

describe("AppBody — conversation scoping (ruling 51)", () => {
	it("passes the panel's conversationId prop to fetchArtifact, not the artifact's own conversation", async () => {
		fetchArtifact.mockResolvedValue(
			baseDetail({ conversationId: "owner-conv" }),
		);
		render(AppBody, {
			artifactId: "app-1",
			kind: "app",
			title: "x",
			body: null,
			conversationId: "panel-conv",
		});

		await waitFor(() =>
			expect(fetchArtifact).toHaveBeenCalledWith("app-1", "panel-conv"),
		);
	});

	it("passes the panel's conversationId prop to the running frame's src, not the artifact's own conversation", async () => {
		fetchArtifact.mockResolvedValue(
			baseDetail({ conversationId: "owner-conv" }),
		);
		const { container } = render(AppBody, {
			artifactId: "app-1",
			kind: "app",
			title: "x",
			body: null,
			conversationId: "panel-conv",
		});

		const iframe = await waitFor(() => {
			const el = container.querySelector("iframe");
			if (!el) throw new Error("no iframe yet");
			return el;
		});
		expect(iframe.getAttribute("src")).toContain("conversationId=panel-conv");
		expect(iframe.getAttribute("src")).not.toContain("owner-conv");
	});

	it("omits conversationId from fetchArtifact and the frame src when the panel has none", async () => {
		fetchArtifact.mockResolvedValue(
			baseDetail({ conversationId: "owner-conv" }),
		);
		const { container } = render(AppBody, {
			artifactId: "app-1",
			kind: "app",
			title: "x",
			body: null,
		});

		await waitFor(() =>
			expect(fetchArtifact).toHaveBeenCalledWith("app-1", null),
		);
		const iframe = await waitFor(() => {
			const el = container.querySelector("iframe");
			if (!el) throw new Error("no iframe yet");
			return el;
		});
		expect(iframe.getAttribute("src")).not.toContain("conversationId=");
	});
});

// RV-2A. The panel reuses this body when its open-documents rail switches
// from one App to another (same kind, same loader), so `artifactId` changes
// under a live component. The card's trust lines and its Code tab must follow
// the App whose frame is showing, never the one the panel just left.
describe("AppBody — switching Apps in the same panel", () => {
	function detailFor(id: string, verdict: "clean" | "unavailable") {
		return {
			...baseDetail({
				id,
				body: `<!doctype html><title>${id}</title>`,
				metadata: {
					artifactType: "app",
					title: id,
					verification: { checked: true, verdict, reason: null },
				},
			}),
		};
	}

	function deferred<T>() {
		let resolve: (value: T) => void = () => {};
		const promise = new Promise<T>((settle) => {
			resolve = settle;
		});
		return { promise, resolve };
	}

	it("does not show the previous App's verification line under the next App's frame while it loads", async () => {
		const nextDetail = deferred<ReturnType<typeof detailFor>>();
		fetchArtifact.mockResolvedValueOnce(detailFor("app-a", "clean"));
		fetchArtifact.mockReturnValueOnce(nextDetail.promise);
		const { rerender } = render(AppBody, {
			artifactId: "app-a",
			kind: "app",
			title: "A",
			body: null,
		});
		await screen.findByText(en.verifyClean);

		await rerender({
			artifactId: "app-b",
			kind: "app",
			title: "B",
			body: null,
		});

		expect(screen.queryByText(en.verifyClean)).toBeNull();
		nextDetail.resolve(detailFor("app-b", "unavailable"));
		await screen.findByText(en.verifyUnavailable);
	});

	it("a slow answer for the previous App never replaces the current App's detail", async () => {
		const slowA = deferred<ReturnType<typeof detailFor>>();
		fetchArtifact.mockReturnValueOnce(slowA.promise);
		fetchArtifact.mockResolvedValueOnce(detailFor("app-b", "unavailable"));
		const { rerender } = render(AppBody, {
			artifactId: "app-a",
			kind: "app",
			title: "A",
			body: null,
		});

		await rerender({
			artifactId: "app-b",
			kind: "app",
			title: "B",
			body: null,
		});
		await screen.findByText(en.verifyUnavailable);
		slowA.resolve(detailFor("app-a", "clean"));
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(screen.queryByText(en.verifyClean)).toBeNull();
		expect(screen.getByText(en.verifyUnavailable)).toBeInTheDocument();
	});
});

describe("AppBody — verification line", () => {
	it("shows nothing when checked is false", async () => {
		fetchArtifact.mockResolvedValue(
			baseDetail({
				metadata: {
					artifactType: "app",
					title: "x",
					verification: { checked: false },
				},
			}),
		);
		render(AppBody, {
			artifactId: "app-1",
			kind: "app",
			title: "x",
			body: null,
		});

		await screen.findByRole("tab", { name: /Preview/ });
		expect(screen.queryByText(en.verifyClean)).toBeNull();
	});

	it("shows the clean line for a clean verdict, with no note block", async () => {
		fetchArtifact.mockResolvedValue(
			baseDetail({
				metadata: {
					artifactType: "app",
					title: "x",
					verification: { checked: true, verdict: "clean", reason: null },
				},
			}),
		);
		render(AppBody, {
			artifactId: "app-1",
			kind: "app",
			title: "x",
			body: null,
		});

		await screen.findByText(en.verifyClean);
		expect(screen.queryByTestId("app-verify-note")).toBeNull();
	});

	it("shows the note block for repaired, with the Alfy comment's text", async () => {
		fetchArtifact.mockResolvedValue(
			baseDetail({
				metadata: {
					artifactType: "app",
					title: "x",
					verification: { checked: true, verdict: "repaired", reason: null },
				},
			}),
		);
		fetchArtifact.mockResolvedValueOnce({
			...baseDetail({
				metadata: {
					artifactType: "app",
					title: "x",
					verification: { checked: true, verdict: "repaired", reason: null },
				},
			}),
			comments: [
				{
					id: "c1",
					artifactId: "app-1",
					parentId: null,
					anchor: null,
					author: "alfy",
					body: "The total did not match the sum of the rows; fixed to 950.",
					status: "open",
					createdAt: 1,
					replies: [],
				},
			],
		});

		render(AppBody, {
			artifactId: "app-1",
			kind: "app",
			title: "x",
			body: null,
		});

		await screen.findByText(en.verifyRepaired);
		expect(
			await screen.findByText(/did not match the sum of the rows/),
		).toBeInTheDocument();
	});

	// Wave 2.5 Step 13: "Read Alfy's note" toggles the note open/closed —
	// collapsed by default (redesign §6.2), never shown expanded on load.
	it("collapses Alfy's note by default and expands it on 'Read Alfy's note'", async () => {
		fetchArtifact.mockResolvedValue({
			...baseDetail({
				metadata: {
					artifactType: "app",
					title: "x",
					verification: { checked: true, verdict: "repaired", reason: null },
				},
			}),
			comments: [
				{
					id: "c1",
					artifactId: "app-1",
					parentId: null,
					anchor: null,
					author: "alfy",
					body: "Fixed a rounding slip.",
					status: "open",
					createdAt: 1,
					replies: [],
				},
			],
		});
		render(AppBody, {
			artifactId: "app-1",
			kind: "app",
			title: "x",
			body: null,
		});

		const toggle = await screen.findByRole("button", {
			name: /Read Alfy's note/,
		});
		expect(toggle).toHaveAttribute("aria-expanded", "false");

		await fireEvent.click(toggle);
		expect(toggle).toHaveAttribute("aria-expanded", "true");
	});

	it("shows no note block for uncertain when there is no Alfy comment yet", async () => {
		fetchArtifact.mockResolvedValue(
			baseDetail({
				metadata: {
					artifactType: "app",
					title: "x",
					verification: { checked: true, verdict: "uncertain", reason: null },
				},
			}),
		);
		render(AppBody, {
			artifactId: "app-1",
			kind: "app",
			title: "x",
			body: null,
		});

		await screen.findByText(en.verifyUncertain);
		expect(screen.queryByTestId("app-verify-note")).toBeNull();
	});

	it("shows the unavailable line and no note block", async () => {
		fetchArtifact.mockResolvedValue(
			baseDetail({
				metadata: {
					artifactType: "app",
					title: "x",
					verification: {
						checked: true,
						verdict: "unavailable",
						reason: "no key",
					},
				},
			}),
		);
		render(AppBody, {
			artifactId: "app-1",
			kind: "app",
			title: "x",
			body: null,
		});

		await screen.findByText(en.verifyUnavailable);
		expect(screen.queryByTestId("app-verify-note")).toBeNull();
	});
});

describe("AppBody — glitches", () => {
	it("shows the network glitch line for no-network-api, and no note-only rule ever renders", async () => {
		fetchArtifact.mockResolvedValue(
			baseDetail({
				metadata: {
					artifactType: "app",
					title: "x",
					glitchRuleIds: ["no-network-api"],
				},
			}),
		);
		render(AppBody, {
			artifactId: "app-1",
			kind: "app",
			title: "x",
			body: null,
		});

		await screen.findByText(en.glitchNetwork);
		expect(screen.queryByText(en.glitchStorage)).toBeNull();
	});

	it("collapses the three external-resource rules into ONE glitch.external line, not three", async () => {
		fetchArtifact.mockResolvedValue(
			baseDetail({
				metadata: {
					artifactType: "app",
					title: "x",
					glitchRuleIds: ["no-script-src", "no-link-href", "no-remote-img"],
				},
			}),
		);
		render(AppBody, {
			artifactId: "app-1",
			kind: "app",
			title: "x",
			body: null,
		});

		const matches = await screen.findAllByText(en.glitchExternal);
		expect(matches).toHaveLength(1);
	});

	it("shows no glitch line when glitchRuleIds is absent", async () => {
		render(AppBody, {
			artifactId: "app-1",
			kind: "app",
			title: "Habit tracker",
			body: null,
		});
		await screen.findByRole("tab", { name: /Preview/ });
		expect(screen.queryByText(en.glitchNetwork)).toBeNull();
	});
});

// Wave 2.5 Step 13: Download moved into the shared panel header
// (`registerPanelActions`, per redesign §6.2's "Download is the header
// icon") — AppBody itself never renders a Download button any more. These
// tests drive the SAME registered trigger the header's own button would
// call, capturing it through the `registerPanelActions` prop exactly the
// way `DocumentWorkspace.svelte` does.
describe("AppBody — download (registered with the panel header)", () => {
	function captureActions() {
		const calls: { openDownload?: () => void }[] = [];
		const registerPanelActions = (actions: { openDownload?: () => void }) => {
			calls.push(actions);
		};
		return { registerPanelActions, latest: () => calls.at(-1) };
	}

	it("registers no download trigger, and shows the unavailable copy, for a project-linked App (no conversation)", async () => {
		fetchArtifact.mockResolvedValue(baseDetail({ conversationId: null }));
		const { registerPanelActions, latest } = captureActions();
		render(AppBody, {
			artifactId: "app-1",
			kind: "app",
			title: "x",
			body: null,
			registerPanelActions,
		});

		await screen.findByTestId("app-download-unavailable-hint");
		await waitFor(() => expect(latest()?.openDownload).toBeUndefined());
		expect(screen.getByText(en.downloadUnavailable)).toBeInTheDocument();
	});

	it("requests a download with the artifact id and the PANEL's conversation id, not the artifact's own", async () => {
		fetchArtifact.mockResolvedValue(
			baseDetail({ conversationId: "owner-conv" }),
		);
		downloadAppAsHtml.mockResolvedValue({
			ok: true,
			job: { id: "job-1" },
			reused: false,
		});
		const { registerPanelActions, latest } = captureActions();
		render(AppBody, {
			artifactId: "app-1",
			kind: "app",
			title: "x",
			body: null,
			conversationId: "panel-conv",
			registerPanelActions,
		});

		await waitFor(() => expect(latest()?.openDownload).toBeTypeOf("function"));
		latest()?.openDownload?.();

		await waitFor(() =>
			expect(downloadAppAsHtml).toHaveBeenCalledWith("app-1", "panel-conv"),
		);
	});

	it("still registers a download trigger with no panel conversation, as long as the artifact has its own — and sends null", async () => {
		fetchArtifact.mockResolvedValue(
			baseDetail({ conversationId: "owner-conv" }),
		);
		downloadAppAsHtml.mockResolvedValue({
			ok: true,
			job: { id: "job-1" },
			reused: false,
		});
		const { registerPanelActions, latest } = captureActions();
		render(AppBody, {
			artifactId: "app-1",
			kind: "app",
			title: "x",
			body: null,
			registerPanelActions,
		});

		await waitFor(() => expect(latest()?.openDownload).toBeTypeOf("function"));
		latest()?.openDownload?.();

		await waitFor(() =>
			expect(downloadAppAsHtml).toHaveBeenCalledWith("app-1", null),
		);
	});

	// Ruling 58: the download error must be a localized sentence, never a raw
	// reason code or intake error code shown straight to the user.
	it("shows a localized message for an unrecognised reason code, never the raw code", async () => {
		fetchArtifact.mockResolvedValue(
			baseDetail({ conversationId: "owner-conv" }),
		);
		downloadAppAsHtml.mockResolvedValue({ ok: false, reason: "rate_limited" });
		const { registerPanelActions, latest } = captureActions();
		render(AppBody, {
			artifactId: "app-1",
			kind: "app",
			title: "x",
			body: null,
			registerPanelActions,
		});

		await waitFor(() => expect(latest()?.openDownload).toBeTypeOf("function"));
		latest()?.openDownload?.();

		await waitFor(() =>
			expect(screen.queryByText("rate_limited")).not.toBeInTheDocument(),
		);
		expect(
			screen.getByText("Could not prepare this app for download."),
		).toBeInTheDocument();
	});

	it("reuses the download-unavailable copy for the server's conversation_required backstop", async () => {
		fetchArtifact.mockResolvedValue(
			baseDetail({ conversationId: "owner-conv" }),
		);
		downloadAppAsHtml.mockResolvedValue({
			ok: false,
			reason: "conversation_required",
		});
		const { registerPanelActions, latest } = captureActions();
		render(AppBody, {
			artifactId: "app-1",
			kind: "app",
			title: "x",
			body: null,
			registerPanelActions,
		});

		await waitFor(() => expect(latest()?.openDownload).toBeTypeOf("function"));
		latest()?.openDownload?.();

		await waitFor(() =>
			expect(screen.getByText(en.downloadUnavailable)).toBeInTheDocument(),
		);
	});

	it("shows the same localized message, never the word 'failed', when the request itself throws", async () => {
		fetchArtifact.mockResolvedValue(
			baseDetail({ conversationId: "owner-conv" }),
		);
		downloadAppAsHtml.mockRejectedValue(new Error("network down"));
		const { registerPanelActions, latest } = captureActions();
		render(AppBody, {
			artifactId: "app-1",
			kind: "app",
			title: "x",
			body: null,
			registerPanelActions,
		});

		await waitFor(() => expect(latest()?.openDownload).toBeTypeOf("function"));
		latest()?.openDownload?.();

		await waitFor(() =>
			expect(
				screen.getByText("Could not prepare this app for download."),
			).toBeInTheDocument(),
		);
		expect(screen.queryByText("failed")).not.toBeInTheDocument();
	});
});

// Wave 2.5 Step 13: "Ask Alfy for a new version" is now "Change this app…",
// and it opens a popover (not a modal) whose own submit reads "Make v2" —
// see redesign §6.2/§6.3.
describe("AppBody — regenerate", () => {
	it("opens a popover, sends { prompt, expectVersion } and reloads the detail on success, with a v2 toast offering Undo", async () => {
		// A real App always has at least its own current version to restore —
		// this is what the toast's Undo needs (see AppBody.svelte's own note on
		// `restoreVersionId`).
		fetchArtifact.mockResolvedValue({
			...baseDetail(),
			versions: [
				{
					id: "v1-id",
					versionNumber: 1,
					author: "alfy",
					summary: "",
					createdAt: 1,
				},
			],
		});
		regenerateApp.mockResolvedValue({
			ok: true,
			version: 3,
			title: "Habit tracker",
			verification: { checked: false },
		});
		render(AppBody, {
			artifactId: "app-1",
			kind: "app",
			title: "x",
			body: null,
		});

		const regenerateButton = await screen.findByRole("button", {
			name: /Change this app/,
		});
		await fireEvent.click(regenerateButton);

		const textarea = await screen.findByLabelText(en.regeneratePrompt);
		await fireEvent.input(textarea, {
			target: { value: "add a currency switch" },
		});

		const submit = screen.getByRole("button", { name: /Make v2/ });
		await fireEvent.click(submit);

		await waitFor(() =>
			expect(regenerateApp).toHaveBeenCalledWith(
				"app-1",
				"add a currency switch",
				2,
				null,
			),
		);
		// A successful regeneration re-fetches the detail (the new version).
		await waitFor(() => expect(fetchArtifact).toHaveBeenCalledTimes(2));

		const entries = get(toasts);
		expect(entries.at(-1)).toMatchObject({
			type: "success",
			message: "Now showing v2",
			actionLabel: "Undo",
		});
	});

	// RV-2A (ruling 51): an incognito conversation's App is readable only when
	// the request names that conversation, and the regenerate route reads it
	// from the body — so a regenerate that drops the panel's conversationId is
	// a 404 for every App in an incognito chat.
	it("passes the panel's conversationId to regenerateApp, so an incognito conversation's own App can be regenerated", async () => {
		fetchArtifact.mockResolvedValue(
			baseDetail({ conversationId: "owner-conv" }),
		);
		regenerateApp.mockResolvedValue({
			ok: true,
			version: 3,
			title: "Habit tracker",
			verification: { checked: false },
		});
		render(AppBody, {
			artifactId: "app-1",
			kind: "app",
			title: "x",
			body: null,
			conversationId: "panel-conv",
		});

		await fireEvent.click(
			await screen.findByRole("button", { name: /Change this app/ }),
		);
		await fireEvent.input(await screen.findByLabelText(en.regeneratePrompt), {
			target: { value: "add a currency switch" },
		});
		await fireEvent.click(screen.getByRole("button", { name: /Make v2/ }));

		await waitFor(() =>
			expect(regenerateApp).toHaveBeenCalledWith(
				"app-1",
				"add a currency switch",
				2,
				"panel-conv",
			),
		);
	});

	// Redesign §6.3: "failed (…) + Try again, in the status row" — the popover
	// closes, the status row explains it, and Try again reopens the popover
	// WITHOUT discarding the prompt the user already wrote.
	it("a 409 version_conflict closes the popover, shows the status row's failed message, and Try again keeps the prompt text", async () => {
		regenerateApp.mockResolvedValue({
			ok: false,
			reason: "version_conflict",
			version: 5,
		});
		render(AppBody, {
			artifactId: "app-1",
			kind: "app",
			title: "x",
			body: null,
		});

		await fireEvent.click(
			await screen.findByRole("button", { name: /Change this app/ }),
		);
		const textarea = await screen.findByLabelText(en.regeneratePrompt);
		await fireEvent.input(textarea, { target: { value: "make it prettier" } });
		await fireEvent.click(screen.getByRole("button", { name: /Make v2/ }));

		await waitFor(() => expect(regenerateApp).toHaveBeenCalled());
		await screen.findByText("Alfy couldn't make v2. v1 is unchanged.");
		expect(
			screen.queryByLabelText(en.regeneratePrompt),
		).not.toBeInTheDocument();

		await fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
		const reopenedTextarea = await screen.findByLabelText(en.regeneratePrompt);
		expect((reopenedTextarea as HTMLTextAreaElement).value).toBe(
			"make it prettier",
		);
	});

	// Redesign §6.2/§6.4: "while v2 is built, v1 stays visible... under a
	// small veil" and "the frame is inert while dimmed".
	it("shows the busy veil and makes the frame inert while v2 is building, then clears both once it lands", async () => {
		let resolveRegenerate: (value: unknown) => void = () => {};
		regenerateApp.mockReturnValue(
			new Promise((resolve) => {
				resolveRegenerate = resolve;
			}),
		);
		render(AppBody, {
			artifactId: "app-1",
			kind: "app",
			title: "x",
			body: null,
		});

		await fireEvent.click(
			await screen.findByRole("button", { name: /Change this app/ }),
		);
		await fireEvent.input(await screen.findByLabelText(en.regeneratePrompt), {
			target: { value: "add tax" },
		});
		await fireEvent.click(screen.getByRole("button", { name: /Make v2/ }));

		await screen.findByTestId("app-busy-veil");
		const frameWrap = document.getElementById("app-panel-preview-app-1") as
			| (HTMLElement & { inert: boolean })
			| null;
		expect(frameWrap).not.toBeNull();
		// jsdom has no native `inert` reflection between the IDL property and the
		// content attribute (unlike a real browser), so this reads the property
		// Svelte actually sets rather than `hasAttribute`, which jsdom never
		// populates for this one attribute regardless of what Svelte does.
		expect(frameWrap?.inert).toBe(true);

		resolveRegenerate({
			ok: true,
			version: 3,
			title: "x",
			verification: { checked: false },
		});

		await waitFor(() =>
			expect(screen.queryByTestId("app-busy-veil")).not.toBeInTheDocument(),
		);
		expect(
			(
				document.getElementById("app-panel-preview-app-1") as
					| (HTMLElement & { inert: boolean })
					| null
			)?.inert,
		).toBeFalsy();
	});

	// The v2 toast's Undo is a REAL restore (versions.ts's own restoreVersion,
	// through restoreArtifactVersion), never a fabricated affordance — see
	// AppBody.svelte's own note on `restoreVersionId`.
	it("the v2 toast's Undo restores the version that was current before the regenerate, then reloads", async () => {
		fetchArtifact.mockResolvedValue({
			...baseDetail(),
			versions: [
				{
					id: "v1-id",
					versionNumber: 1,
					author: "alfy",
					summary: "",
					createdAt: 1,
				},
			],
		});
		regenerateApp.mockResolvedValue({
			ok: true,
			version: 3,
			title: "Habit tracker",
			verification: { checked: false },
		});
		render(AppBody, {
			artifactId: "app-1",
			kind: "app",
			title: "x",
			body: null,
			conversationId: "panel-conv",
		});

		await fireEvent.click(
			await screen.findByRole("button", { name: /Change this app/ }),
		);
		await fireEvent.input(await screen.findByLabelText(en.regeneratePrompt), {
			target: { value: "add tax" },
		});
		await fireEvent.click(screen.getByRole("button", { name: /Make v2/ }));
		await waitFor(() => expect(fetchArtifact).toHaveBeenCalledTimes(2));

		const toastEntry = get(toasts).at(-1);
		toastEntry?.onAction?.();

		await waitFor(() =>
			expect(restoreArtifactVersion).toHaveBeenCalledWith(
				"app-1",
				"v1-id",
				"panel-conv",
			),
		);
		await waitFor(() => expect(fetchArtifact).toHaveBeenCalledTimes(3));
	});
});

describe("AppBody — i18n and naming", () => {
	it("no rendered string in either locale contains the word 'artifact'", async () => {
		fetchArtifact.mockResolvedValue(
			baseDetail({
				metadata: {
					artifactType: "app",
					title: "x",
					verification: { checked: true, verdict: "uncertain", reason: "x" },
					glitchRuleIds: ["no-network-api"],
				},
			}),
		);
		const { container, unmount } = render(AppBody, {
			artifactId: "app-1",
			kind: "app",
			title: "x",
			body: null,
		});
		await screen.findByText(en.verifyUncertain);
		expect(container.textContent ?? "").not.toMatch(/artifact/i);
		unmount();

		uiLanguage.set("hu");
		fetchArtifact.mockResolvedValue(
			baseDetail({
				metadata: {
					artifactType: "app",
					title: "x",
					verification: { checked: true, verdict: "uncertain", reason: "x" },
					glitchRuleIds: ["no-network-api"],
				},
			}),
		);
		const { container: huContainer } = render(AppBody, {
			artifactId: "app-1",
			kind: "app",
			title: "x",
			body: null,
		});
		await screen.findByText(hu.verifyUncertain);
		expect(huContainer.textContent ?? "").not.toMatch(/artifact/i);
	});
});
