import { render, screen } from "@testing-library/svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "$lib/i18n";
import { uiLanguage } from "$lib/stores/settings";
import HomeSurface from "./HomeSurface.svelte";

/**
 * The extraction's own guard rail (Workspaces Slice D, Task D2).
 *
 * `HomeSurface` renders in two modes and the mode table in
 * `docs/plans/claude-at-home-1/slice-D.md` is short and exact: on the landing
 * page the greeting is the greeting pool, the composer's placeholder is the
 * ordinary one, and there is nothing under the composer. The project page —
 * where the greeting is the project's name, the placeholder names the project
 * and a quiet instructions line sits under the composer — is Task D3.
 *
 * This file asserts the negative half: in `home` mode none of the project
 * markers may appear. The markers are the test ids the project branch uses
 * (`project-greeting`, `project-quiet-line`, `project-instructions-button`),
 * so if the branch ever reaches the landing page — a mode comparison that
 * matches too much, a marker hoisted out of the project-only block — these
 * fail rather than shipping a landing page wearing a project's name.
 *
 * The API modules are mocked the way MessageInput.test.ts mocks them: this
 * surface mounts the real composer, which fetches on mount.
 */

const gotoMock = vi.hoisted(() => vi.fn());
const fetchAvailableModelsMock = vi.hoisted(() =>
	vi.fn(async () => ({ providers: [] })),
);
const fetchKnowledgeLibraryMock = vi.hoisted(() =>
	vi.fn(async () => ({ documents: [], results: [], workflows: [] })),
);
const fetchExtractionJobsMock = vi.hoisted(() => vi.fn(async () => []));
const discoverSkillsMock = vi.hoisted(() => vi.fn(async () => []));
const fetchActiveCapabilitiesMock = vi.hoisted(() =>
	vi.fn(async () => ({ served: [], defaultOn: [], accounts: [] })),
);
const fetchPublicPersonalityProfilesMock = vi.hoisted(() =>
	vi.fn(async () => []),
);
const fetchSystemCapabilitiesMock = vi.hoisted(() =>
	vi.fn(async () => ({ capabilities: [], degraded: [] })),
);

vi.mock("$app/navigation", () => ({ goto: gotoMock }));
vi.mock("$lib/client/api/models", () => ({
	fetchAvailableModels: fetchAvailableModelsMock,
}));
vi.mock("$lib/client/api/knowledge", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/client/api/knowledge")>()),
	fetchKnowledgeLibrary: fetchKnowledgeLibraryMock,
	fetchExtractionJobs: fetchExtractionJobsMock,
}));
vi.mock("$lib/client/api/skills", () => ({
	discoverSkills: discoverSkillsMock,
}));
vi.mock("$lib/client/api/connections", () => ({
	fetchActiveCapabilities: fetchActiveCapabilitiesMock,
}));
vi.mock("$lib/client/api/admin", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/client/api/admin")>()),
	fetchPublicPersonalityProfiles: fetchPublicPersonalityProfilesMock,
}));
vi.mock("$lib/client/api/system", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/client/api/system")>()),
	fetchSystemCapabilities: fetchSystemCapabilitiesMock,
}));
vi.mock("$lib/client/api/home", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/client/api/home")>()),
	dismissMemoryReviewNotice: vi.fn(async () => undefined),
}));

function renderHome() {
	return render(HomeSurface, { mode: { kind: "home" }, recent: [] });
}

describe("HomeSurface in home mode", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		uiLanguage.set("en");
		gotoMock.mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("composes into the ordinary chat placeholder, never a project one", () => {
		renderHome();

		const textarea = screen.getByPlaceholderText(
			get(t)("chat.messagePlaceholder"),
		);
		expect(textarea).toBeInTheDocument();
		// Exactly the landing placeholder: a project page's "Start a chat in
		// {name}…" would fail this rather than merely look different.
		expect(textarea).toHaveAttribute(
			"placeholder",
			get(t)("chat.messagePlaceholder"),
		);
	});

	it("greets with the landing heading, not a project name", () => {
		renderHome();

		expect(screen.getByTestId("home-greeting")).toBeInTheDocument();
		expect(screen.queryByTestId("project-greeting")).toBeNull();
	});

	it("renders no instructions line under the composer", () => {
		renderHome();

		// The quiet line is the project page's only affordance under the
		// composer; on the landing page there is nothing there.
		expect(screen.queryByTestId("project-quiet-line")).toBeNull();
		expect(screen.queryByTestId("project-instructions-button")).toBeNull();
	});

	it("keeps the landing greeting band's own weekly record", () => {
		// The project page replaces the weekly bars with a stats line. The
		// landing page keeps them: same component, different mode.
		const { container } = renderHome();

		expect(screen.getByTestId("home-greeting")).toBeInTheDocument();
		expect(container.querySelector("[data-testid='project-stats']")).toBeNull();
	});
});
