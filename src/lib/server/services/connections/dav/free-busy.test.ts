import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ConnectionPublic, getConnectionSecret } from "../store";
import { davFreeBusy } from "./free-busy";

vi.mock("../store", () => ({ getConnectionSecret: vi.fn() }));
const calendarUrl = "https://calendar.example/cal/work/";
const conn: ConnectionPublic = {
	id: "c",
	userId: "u",
	provider: "caldav",
	label: "Work",
	accountIdentifier: "me",
	status: "connected",
	statusDetail: null,
	defaultOn: true,
	allowWrites: false,
	writeAllowlist: [],
	capabilities: ["calendar"],
	config: { calendarUrls: [calendarUrl] },
	oauthScopes: [],
	tokenExpiresAt: null,
	hasSecret: true,
	hasWriteSecret: false,
	createdAt: 0,
	updatedAt: 0,
};
const range = {
	timeMin: "2026-07-09T08:00:00Z",
	timeMax: "2026-07-09T10:00:00Z",
};
function report(...lines: string[]) {
	return [
		"BEGIN:VCALENDAR",
		"BEGIN:VFREEBUSY",
		...lines,
		"END:VFREEBUSY",
		"END:VCALENDAR",
	].join("\r\n");
}
describe("DAV availability", () => {
	beforeEach(() =>
		vi.mocked(getConnectionSecret).mockResolvedValue("example-password"),
	);
	it("asks the discovered collection for UTC busy periods and keeps only occupied times", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					report(
						"DTSTART:20260709T080000Z",
						"DTEND:20260709T100000Z",
						"FREEBUSY;FBTYPE=FREE:20260709T080000Z/20260709T081500Z",
						"FREEBUSY;FBTYPE=BUSY-TENTATIVE:20260709T081500Z/PT15M,",
						" 20260709T090000Z/20260709T100000Z",
						"COMMENT:private",
					),
				),
		);
		const busy = await davFreeBusy(conn, range, fetchMock);
		expect(fetchMock).toHaveBeenCalledWith(
			calendarUrl,
			expect.objectContaining({
				method: "REPORT",
				redirect: "error",
				body: expect.stringContaining(
					'start="20260709T080000Z" end="20260709T100000Z"',
				),
			}),
		);
		expect(busy).toEqual([
			{
				calendarId: calendarUrl,
				busy: [
					{
						start: "2026-07-09T08:15:00.000Z",
						end: "2026-07-09T08:30:00.000Z",
					},
					{
						start: "2026-07-09T09:00:00.000Z",
						end: "2026-07-09T10:00:00.000Z",
					},
				],
			},
		]);
	});
	it.each([
		"<html>Login</html>",
		report("FREEBUSY:garbage"),
		report("DTEND:20260709T081500Z"),
	])("withholds malformed or partial responses", async (text) => {
		await expect(
			davFreeBusy(conn, range, async () => new Response(text)),
		).rejects.toMatchObject({ code: "request_failed" });
	});
	it("accepts an empty VFREEBUSY component", async () => {
		await expect(
			davFreeBusy(conn, range, async () => new Response(report())),
		).resolves.toEqual([{ calendarId: calendarUrl, busy: [] }]);
	});
	it("sends credentials only to a calendar id discovered for that connection", async () => {
		const fetchMock = vi.fn();
		await expect(
			davFreeBusy(
				conn,
				{ ...range, calendarId: "https://other.example/" },
				fetchMock,
			),
		).rejects.toMatchObject({ code: "not_found" });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
