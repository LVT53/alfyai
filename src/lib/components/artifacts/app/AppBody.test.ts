import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
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
vi.mock("$lib/client/api/artifacts", () => ({
	fetchArtifact: (...args: unknown[]) => fetchArtifact(...args),
	downloadAppAsHtml: (...args: unknown[]) => downloadAppAsHtml(...args),
	regenerateApp: (...args: unknown[]) => regenerateApp(...args),
}));

const renderCodeBlock = vi.fn(
	(content: string) =>
		`<pre data-testid="highlighted"><code>${content}</code></pre>`,
);
vi.mock("$lib/services/markdown", () => ({
	renderCodeBlock: (...args: unknown[]) =>
		(renderCodeBlock as (...a: unknown[]) => string)(...args),
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
	fetchArtifact.mockResolvedValue(baseDetail());
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

	it("switches to Code on click and renders the stored HTML read-only, through the existing Shiki path", async () => {
		render(AppBody, {
			artifactId: "app-1",
			kind: "app",
			title: "Habit tracker",
			body: null,
		});
		const codeTab = await screen.findByRole("tab", { name: /Code/ });

		await fireEvent.click(codeTab);

		await waitFor(() => expect(renderCodeBlock).toHaveBeenCalled());
		expect(renderCodeBlock).toHaveBeenCalledWith(
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
		await waitFor(() => expect(renderCodeBlock).toHaveBeenCalled());

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

describe("AppBody — download", () => {
	it("disables download and shows the unavailable copy for a project-linked App (no conversation)", async () => {
		fetchArtifact.mockResolvedValue(baseDetail({ conversationId: null }));
		render(AppBody, {
			artifactId: "app-1",
			kind: "app",
			title: "x",
			body: null,
		});

		const button = await screen.findByRole("button", { name: /Download/ });
		expect(button).toBeDisabled();
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
		render(AppBody, {
			artifactId: "app-1",
			kind: "app",
			title: "x",
			body: null,
			conversationId: "panel-conv",
		});

		const button = await screen.findByRole("button", { name: /Download/ });
		await fireEvent.click(button);

		await waitFor(() =>
			expect(downloadAppAsHtml).toHaveBeenCalledWith("app-1", "panel-conv"),
		);
	});

	it("still allows download with no panel conversation, as long as the artifact has its own — and sends null", async () => {
		fetchArtifact.mockResolvedValue(
			baseDetail({ conversationId: "owner-conv" }),
		);
		downloadAppAsHtml.mockResolvedValue({
			ok: true,
			job: { id: "job-1" },
			reused: false,
		});
		render(AppBody, {
			artifactId: "app-1",
			kind: "app",
			title: "x",
			body: null,
		});

		const button = await screen.findByRole("button", { name: /Download/ });
		expect(button).not.toBeDisabled();
		await fireEvent.click(button);

		await waitFor(() =>
			expect(downloadAppAsHtml).toHaveBeenCalledWith("app-1", null),
		);
	});
});

describe("AppBody — regenerate", () => {
	it("opens a prompt dialog, sends { prompt, expectVersion } and reloads the detail on success", async () => {
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
			name: /Ask Alfy for a new version/,
		});
		await fireEvent.click(regenerateButton);

		const textarea = await screen.findByLabelText(en.regeneratePrompt);
		await fireEvent.input(textarea, {
			target: { value: "add a currency switch" },
		});

		const submit = screen
			.getAllByRole("button", { name: /Ask Alfy for a new version/ })
			.at(-1);
		if (!submit) throw new Error("no submit button");
		await fireEvent.click(submit);

		await waitFor(() =>
			expect(regenerateApp).toHaveBeenCalledWith(
				"app-1",
				"add a currency switch",
				2,
			),
		);
		// A successful regeneration re-fetches the detail (the new version).
		await waitFor(() => expect(fetchArtifact).toHaveBeenCalledTimes(2));
	});

	it("a 409 version_conflict keeps the dialog and the prompt text, rather than discarding it", async () => {
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

		const regenerateButton = await screen.findByRole("button", {
			name: /Ask Alfy for a new version/,
		});
		await fireEvent.click(regenerateButton);
		const textarea = await screen.findByLabelText(en.regeneratePrompt);
		await fireEvent.input(textarea, { target: { value: "make it prettier" } });
		const submit = screen
			.getAllByRole("button", { name: /Ask Alfy for a new version/ })
			.at(-1);
		if (!submit) throw new Error("no submit button");
		await fireEvent.click(submit);

		await waitFor(() => expect(regenerateApp).toHaveBeenCalled());
		expect((textarea as HTMLTextAreaElement).value).toBe("make it prettier");
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
