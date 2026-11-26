// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createPersonalityProfileApi,
	deletePersonalityProfileApi,
	updatePersonalityProfileApi,
} from "./admin";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("admin personality API", () => {
	const profile = {
		id: "personality-1",
		name: "Creative",
		description: "A concise profile for experiments",
		promptText: "Please be creative",
		isBuiltIn: false,
		createdAt: "2026-06-14T10:00:00.000Z",
	};

	it("creates a personality profile", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ profile }), {
					status: 201,
					headers: { "content-type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await createPersonalityProfileApi({
			name: profile.name,
			description: profile.description,
			promptText: profile.promptText,
		});

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/admin/personalities",
			expect.objectContaining({
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: profile.name,
					description: profile.description,
					promptText: profile.promptText,
				}),
			}),
		);
		expect(result).toEqual(profile);
	});

	it("updates a personality profile", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ profile }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await updatePersonalityProfileApi(profile.id, {
			description: "Updated description",
		});

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/admin/personalities/personality-1",
			expect.objectContaining({
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ description: "Updated description" }),
			}),
		);
		expect(result).toEqual(profile);
	});

	it("deletes a personality profile", async () => {
		const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetchMock);

		await deletePersonalityProfileApi(profile.id);

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/admin/personalities/personality-1",
			expect.objectContaining({ method: "DELETE" }),
		);
	});
});
