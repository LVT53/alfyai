import { describe, expect, it, vi } from "vitest";
import {
	createUserSkill,
	deleteUserSkill,
	dismissSkillDraft,
	discoverSkills,
	fetchSystemSkillSummaries,
	fetchUserSkills,
	publishSkillDraft,
	saveSkillDraft,
	updateUserSkill,
} from "./skills";

describe("skills client API", () => {
	it("lists user skills from the authenticated API", async () => {
		const fetchMock = vi.fn(async () =>
			new Response(
				JSON.stringify({
					skills: [{ id: "skill-1", displayName: "Meeting critic" }],
					systemSkills: [
						{
							id: "system:interview",
							ownership: "system",
							displayName: "Interview",
							description: "Safe summary.",
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);

		await expect(fetchUserSkills(fetchMock)).resolves.toEqual([
			{ id: "skill-1", displayName: "Meeting critic" },
		]);
		expect(fetchMock).toHaveBeenCalledWith("/api/skills");
	});

	it("lists enabled System Skill summaries separately without instruction bodies", async () => {
		const fetchMock = vi.fn(async () =>
			new Response(
				JSON.stringify({
					skills: [{ id: "skill-1", displayName: "Private skill" }],
					systemSkills: [
						{
							id: "system:interview",
							ownership: "system",
							displayName: "Interview",
							description: "Safe summary.",
							instructions: "LEAKED_SYSTEM_INSTRUCTIONS",
							localizedDefaults: {
								en: {
									displayName: "Interview",
									description: "Safe summary.",
									instructions: "LEAKED_EN_INSTRUCTIONS",
								},
								hu: {
									displayName: "Interjú",
									description: "Biztonságos összefoglaló.",
									instructions: "LEAKED_HU_INSTRUCTIONS",
								},
							},
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);

		await expect(fetchSystemSkillSummaries(fetchMock)).resolves.toEqual([
			{
				id: "system:interview",
				ownership: "system",
				displayName: "Interview",
				description: "Safe summary.",
				localizedDefaults: {
					en: {
						displayName: "Interview",
						description: "Safe summary.",
					},
					hu: {
						displayName: "Interjú",
						description: "Biztonságos összefoglaló.",
					},
				},
			},
		]);
		const summaries = await fetchSystemSkillSummaries(fetchMock);
		const serializedSummaries = JSON.stringify(summaries);
		expect(serializedSummaries).not.toContain("instructions");
		expect(serializedSummaries).not.toContain("LEAKED_SYSTEM_INSTRUCTIONS");
		expect(serializedSummaries).not.toContain("LEAKED_EN_INSTRUCTIONS");
		expect(serializedSummaries).not.toContain("LEAKED_HU_INSTRUCTIONS");
	});

	it("creates, updates, and deletes user skills through JSON endpoints", async () => {
		const fetchMock = vi.fn(async () =>
			new Response(JSON.stringify({ skill: { id: "skill-1", displayName: "Updated" } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		await createUserSkill(
			{
				displayName: "Meeting critic",
				description: "",
				instructions: "Review notes.",
				activationExamples: [],
			},
			fetchMock,
		);
		await updateUserSkill("skill-1", { enabled: false, displayName: "Updated" }, fetchMock);
		await deleteUserSkill("skill-1", fetchMock);

		expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/skills", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				displayName: "Meeting critic",
				description: "",
				instructions: "Review notes.",
				activationExamples: [],
			}),
		});
		expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/skills/skill-1", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ enabled: false, displayName: "Updated" }),
		});
		expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/skills/skill-1", {
			method: "DELETE",
		});
	});

	it("discovers skills through the query endpoint and strips accidental instructions", async () => {
		const fetchMock = vi.fn(async () =>
			new Response(
				JSON.stringify({
					skills: [
						{
							id: "skill-1",
							ownership: "user",
							displayName: "Interview coach",
							description: "Practice interviews.",
							instructions: "LEAKED_USER_INSTRUCTIONS",
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);

		await expect(discoverSkills("interview prep", fetchMock)).resolves.toEqual([
			{
				id: "skill-1",
				ownership: "user",
				displayName: "Interview coach",
				description: "Practice interviews.",
			},
		]);
		expect(fetchMock).toHaveBeenCalledWith("/api/skills/discovery?q=interview+prep");
	});

	it("saves, dismisses, and publishes assistant Skill Drafts through conversation-scoped endpoints", async () => {
		const fetchMock = vi.fn(async () =>
			new Response(
				JSON.stringify({
					skill: { id: "skill-1" },
					systemSkill: { id: "system:skill-1" },
					draft: { id: "draft-1", status: "saved" },
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);

		await saveSkillDraft("conv 1", "msg/1", "draft 1", fetchMock);
		await dismissSkillDraft("conv 1", "msg/1", "draft 1", fetchMock);
		await publishSkillDraft("conv 1", "msg/1", "draft 1", "system:skill-1", fetchMock);

		expect(fetchMock).toHaveBeenNthCalledWith(
			1,
			"/api/conversations/conv%201/messages/msg%2F1/skill-drafts/draft%201/save",
			{ method: "POST" },
		);
		expect(fetchMock).toHaveBeenNthCalledWith(
			2,
			"/api/conversations/conv%201/messages/msg%2F1/skill-drafts/draft%201",
			{ method: "DELETE" },
		);
		expect(fetchMock).toHaveBeenNthCalledWith(
			3,
			"/api/conversations/conv%201/messages/msg%2F1/skill-drafts/draft%201/publish",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ systemSkillId: "system:skill-1" }),
			},
		);
	});

	it("returns the updated assistant Skill Draft from dismiss responses", async () => {
		const fetchMock = vi.fn(async () =>
			new Response(JSON.stringify({ draft: { id: "draft-1", status: "dismissed" } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		await expect(dismissSkillDraft("conv-1", "assistant-1", "draft-1", fetchMock)).resolves.toEqual({
			draft: { id: "draft-1", status: "dismissed" },
		});
	});
});
