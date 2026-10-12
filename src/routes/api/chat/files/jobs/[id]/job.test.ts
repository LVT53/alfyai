import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/file-production", () => ({
	getFileProductionJobForUser: vi.fn(),
}));

import { getFileProductionJobForUser } from "$lib/server/services/file-production";
import { GET } from "./+server";

const mockGetJob = getFileProductionJobForUser as ReturnType<typeof vi.fn>;
type JobEvent = Parameters<typeof GET>[0];

function makeEvent(
	user: { id: string } | null = { id: "user-1" },
	id = "job-1",
): JobEvent {
	return {
		request: new Request(`http://localhost/api/chat/files/jobs/${id}`),
		locals: { user },
		params: { id },
		url: new URL(`http://localhost/api/chat/files/jobs/${id}`),
		route: { id: "/api/chat/files/jobs/[id]" },
	} as JobEvent;
}

// GET /api/chat/files/jobs/[id]: what a Download polls. A JSON route (ruling 39):
// a call without a session is a 401 from the route itself, never a redirect to
// the login page that a `fetch` would follow and choke on.
describe("GET /api/chat/files/jobs/[id]", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetJob.mockResolvedValue({ id: "job-1", status: "succeeded" });
	});

	it("answers a call without a session with a 401, not a redirect", async () => {
		await expect(GET(makeEvent(null))).rejects.toMatchObject({ status: 401 });
		expect(mockGetJob).not.toHaveBeenCalled();
	});

	it("hands the signed-in user their own job", async () => {
		const response = await GET(makeEvent());

		expect(response.status).toBe(200);
		expect(mockGetJob).toHaveBeenCalledWith({
			userId: "user-1",
			jobId: "job-1",
		});
		expect(await response.json()).toEqual({
			job: { id: "job-1", status: "succeeded" },
		});
	});

	it("answers a job that is not theirs and one that does not exist with the same 404", async () => {
		mockGetJob.mockResolvedValue(null);
		const missing = await GET(makeEvent({ id: "user-1" }, "nope"));
		const foreign = await GET(makeEvent({ id: "user-2" }, "job-1"));

		expect(missing.status).toBe(404);
		expect(foreign.status).toBe(404);
		expect(await missing.text()).toBe(await foreign.text());
	});
});
