import { afterEach, describe, expect, it, vi } from "vitest";
import {
	clearMemoryAndKnowledge,
	clearWorkspaceData,
	deleteAccount,
	downloadAccountDataArchive,
	fetchAnalytics,
	fetchUserSettings,
	saveBlobAsDownload,
	updatePassword,
	updateProfile,
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

	it("reports how many other devices a password change signed out", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({ success: true, signedOutOtherDevices: 2 }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			);
		vi.stubGlobal("fetch", fetchImpl);

		await expect(
			updatePassword({ currentPassword: "old-one", newPassword: "new-one-1" }),
		).resolves.toEqual({ signedOutOtherDevices: 2 });

		expect(fetchImpl).toHaveBeenCalledWith(
			"/api/settings/password",
			expect.objectContaining({
				method: "PATCH",
				body: JSON.stringify({
					currentPassword: "old-one",
					newPassword: "new-one-1",
				}),
			}),
		);
	});

	it("sends the account password with a profile change that carries one, and only then", async () => {
		const fetchImpl = vi.fn().mockImplementation(
			async () =>
				new Response(
					JSON.stringify({ name: "Ada", email: "ada@example.com" }),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
		);
		vi.stubGlobal("fetch", fetchImpl);

		await updateProfile({
			name: "Ada",
			email: "ada@example.com",
			currentPassword: "old-one",
		});
		await updateProfile({ name: "Ada", email: "ada@example.com" });

		expect(fetchImpl).toHaveBeenNthCalledWith(
			1,
			"/api/settings/profile",
			expect.objectContaining({
				method: "PATCH",
				body: JSON.stringify({
					name: "Ada",
					email: "ada@example.com",
					currentPassword: "old-one",
				}),
			}),
		);
		expect(fetchImpl).toHaveBeenNthCalledWith(
			2,
			"/api/settings/profile",
			expect.objectContaining({
				body: JSON.stringify({ name: "Ada", email: "ada@example.com" }),
			}),
		);
	});

	// The server trims the name and lowercases the address, and keeps the stored
	// address when only its letters changed: what the card shows after a save is
	// what the server answered, not what was typed.
	it("hands back the name and address the server answered, not the ones sent", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({ name: "Ada", email: "ada@example.com" }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			);
		vi.stubGlobal("fetch", fetchImpl);

		await expect(
			updateProfile({ name: "  Ada ", email: "ADA@Example.com" }),
		).resolves.toEqual({ name: "Ada", email: "ada@example.com" });
	});

	it("reads an answer without a count as no other device signed out", async () => {
		const fetchImpl = vi.fn().mockResolvedValueOnce(
			new Response(JSON.stringify({ success: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetchImpl);

		await expect(
			updatePassword({ currentPassword: "old-one", newPassword: "new-one-1" }),
		).resolves.toEqual({ signedOutOtherDevices: 0 });
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

	// Analytics overhaul (frontend half) — admin-only userId/modelId/providerId
	// narrowing filters over the system/tools/commandsAndSkills/
	// latencyByPromptBucket sections.
	it("passes the admin userId/modelId/providerId filters to analytics", async () => {
		const fetchImpl = vi.fn().mockResolvedValueOnce(
			new Response(JSON.stringify({ personal: { byModel: [] } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetchImpl);

		await fetchAnalytics(false, undefined, undefined, "2026-06", {
			userId: "user-2",
			modelId: "model-a",
			providerId: "provider-openai",
		});

		expect(fetchImpl).toHaveBeenCalledWith(
			"/api/analytics?systemMonth=2026-06&userId=user-2&modelId=model-a&providerId=provider-openai",
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
