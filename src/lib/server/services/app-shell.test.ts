import { describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/conversations", () => ({
	listConversations: vi.fn(() => Promise.resolve([])),
}));

vi.mock("$lib/server/services/projects", () => ({
	listProjects: vi.fn(() => Promise.resolve([])),
}));

vi.mock("$lib/server/services/app-version", () => ({
	getAppVersionMetadata: vi.fn(() =>
		Promise.resolve({ compact: "v1.0.1", full: "1.0.1" }),
	),
}));

vi.mock("$lib/server/config-store", () => ({
	getConfig: vi.fn(() => ({
		maxMessageLength: 12000,
		maxFileUploadSize: 104857600,
		composerCommandRegistryEnabled: true,
		atlasWorkerEnabled: true,
		parallelApiKey: "parallel-key",
		defaultNewUserModel: "model2",
		model1: { displayName: "Model 1" },
		model2: { displayName: "Model 2" },
		model2Enabled: true,
	})),
	normalizeModelSelection: vi.fn((model: string) => model),
	normalizeModelSelectionWithProviders: vi.fn(async (model: string) => model),
	getAvailableModelsWithProviders: vi.fn(() =>
		Promise.resolve([{ id: "model1", displayName: "Model 1" }]),
	),
}));

vi.mock("$lib/server/db", () => ({
	db: {
		select: vi.fn(() => ({
			from: vi.fn(() => ({
				where: vi.fn(() =>
					Promise.resolve([
						{
							preferredModel: "model2",
							theme: "system",
							titleLanguage: "auto",
							uiLanguage: "en",
							preferredPersonalityId: null,
						},
					]),
				),
			})),
		})),
	},
}));

vi.mock("$lib/server/db/schema", () => ({ users: { id: "id" } }));
vi.mock("drizzle-orm", () => ({ eq: vi.fn() }));

const mockGetUploadFormatGate = vi.fn();
vi.mock("$lib/server/services/knowledge/format-availability", () => ({
	getUploadFormatGate: mockGetUploadFormatGate,
}));

const { getAuthenticatedAppShellData } = await import("./app-shell");

const user = {
	id: "user-1",
	email: "user@example.com",
	displayName: "User",
} as Parameters<typeof getAuthenticatedAppShellData>[0];

function openGate() {
	return {
		disabledEntryIds: new Set<string>(),
		reason: null,
		backendVersion: null,
		checkedAt: new Date(0).toISOString(),
	};
}

describe("getAuthenticatedAppShellData — disabledFileTypeIds", () => {
	it("is empty when the MinerU-4 gate is open", async () => {
		mockGetUploadFormatGate.mockResolvedValueOnce(openGate());

		const data = await getAuthenticatedAppShellData(user);

		expect(data.disabledFileTypeIds).toEqual([]);
	});

	it("carries the gate's disabled entry ids when it has closed", async () => {
		mockGetUploadFormatGate.mockResolvedValueOnce({
			disabledEntryIds: new Set(["epub", "odp", "ods", "odt", "rtf"]),
			reason: "backend_version",
			backendVersion: "3.9.0",
			checkedAt: new Date(0).toISOString(),
		});

		const data = await getAuthenticatedAppShellData(user);

		expect([...data.disabledFileTypeIds].sort()).toEqual([
			"epub",
			"odp",
			"ods",
			"odt",
			"rtf",
		]);
	});

	it("is an array, never a bare Set, on the wire-shaped payload", async () => {
		mockGetUploadFormatGate.mockResolvedValueOnce({
			disabledEntryIds: new Set(["rtf"]),
			reason: "backend_version",
			backendVersion: "3.9.0",
			checkedAt: new Date(0).toISOString(),
		});

		const data = await getAuthenticatedAppShellData(user);

		expect(Array.isArray(data.disabledFileTypeIds)).toBe(true);
	});
});
