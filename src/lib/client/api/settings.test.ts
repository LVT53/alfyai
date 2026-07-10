import { afterEach, describe, expect, it, vi } from "vitest";
import {
	clearMemoryAndKnowledge,
	clearWorkspaceData,
	deleteAccount,
	downloadAccountDataArchive,
	fetchAnalytics,
	fetchUserSettings,
	saveBlobAsDownload,
} from "./settings";

describe("settings client API", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("loads user settings including the resolved system default model", async () => {
		const fetchImpl = vi.fn().mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					id: "user-1",
					email: "user@example.com",
					name: "User",
					role: "admin",
					preferences: {
						preferredModel: null,
						effectiveModel: "provider:fire-pass",
						systemDefaultModel: "provider:fire-pass",
						theme: "system",
						titleLanguage: "auto",
						uiLanguage: "en",
						preferredPersonalityId: null,
					},
					profilePicture: null,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);

		await expect(fetchUserSettings(fetchImpl)).resolves.toMatchObject({
			preferences: {
				preferredModel: null,
				effectiveModel: "provider:fire-pass",
				systemDefaultModel: "provider:fire-pass",
			},
		});
		expect(fetchImpl).toHaveBeenCalledWith("/api/settings");
	});

	it("passes independent personal and system month filters to analytics", async () => {
		const fetchImpl = vi.fn().mockResolvedValueOnce(
			new Response(JSON.stringify({ personal: { byModel: [] } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetchImpl);

		await fetchAnalytics(false, "2026-03", "monthly", "2026-06");

		expect(fetchImpl).toHaveBeenCalledWith(
			"/api/analytics?month=2026-03&timeline=monthly&systemMonth=2026-06",
		);
	});

	it("requests the password-confirmed account data archive and returns a ZIP download", async () => {
		const fetchImpl = vi.fn().mockResolvedValueOnce(
			new Response("zip", {
				status: 200,
				headers: {
					"Content-Type": "application/zip",
					"Content-Disposition":
						'attachment; filename="AlfyAI Data Archive 2026-06-15.zip"',
				},
			}),
		);

		const result = await downloadAccountDataArchive("correct horse", fetchImpl);

		expect(fetchImpl).toHaveBeenCalledWith(
			"/api/settings/account/archive",
			expect.objectContaining({
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ password: "correct horse" }),
			}),
		);
		expect(result.filename).toBe("AlfyAI Data Archive 2026-06-15.zip");
		expect(result.blob.type).toBe("application/zip");
		expect(await result.blob.text()).toBe("zip");
	});

	it("triggers a browser download for an archive blob", () => {
		const blob = new Blob(["zip"], { type: "application/zip" });
		const click = vi.fn();
		const anchor = document.createElement("a");
		anchor.click = click;
		const createElement = vi
			.spyOn(document, "createElement")
			.mockReturnValueOnce(anchor);
		const append = vi.spyOn(document.body, "appendChild");
		const remove = vi.spyOn(document.body, "removeChild");
		const createObjectURL = vi
			.spyOn(URL, "createObjectURL")
			.mockReturnValueOnce("blob:archive");
		const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL");

		saveBlobAsDownload(blob, "AlfyAI Data Archive 2026-06-15.zip");

		expect(createElement).toHaveBeenCalledWith("a");
		expect(createObjectURL).toHaveBeenCalledWith(blob);
		expect(anchor.href).toBe("blob:archive");
		expect(anchor.download).toBe("AlfyAI Data Archive 2026-06-15.zip");
		expect(append).toHaveBeenCalledWith(anchor);
		expect(click).toHaveBeenCalled();
		expect(remove).toHaveBeenCalledWith(anchor);
		expect(revokeObjectURL).toHaveBeenCalledWith("blob:archive");
	});

	it("posts destructive privacy controls to their approved route contracts", async () => {
		const fetchImpl = vi.fn().mockImplementation(() =>
			Promise.resolve(
				new Response(JSON.stringify({ success: true }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			),
		);

		await clearMemoryAndKnowledge("pw", fetchImpl);
		await clearWorkspaceData("pw", fetchImpl);
		await deleteAccount("pw", fetchImpl);

		expect(fetchImpl).toHaveBeenNthCalledWith(
			1,
			"/api/settings/account/clear-memory",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ password: "pw" }),
			}),
		);
		expect(fetchImpl).toHaveBeenNthCalledWith(
			2,
			"/api/settings/account",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ password: "pw" }),
			}),
		);
		expect(fetchImpl).toHaveBeenNthCalledWith(
			3,
			"/api/settings/account",
			expect.objectContaining({
				method: "DELETE",
				body: JSON.stringify({ password: "pw" }),
			}),
		);
	});
});
