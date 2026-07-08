import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAdmin: vi.fn(),
}));

vi.mock("$lib/server/services/price-windows", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/server/services/price-windows")
	>("$lib/server/services/price-windows");
	return {
		...actual,
		listPriceWindows: vi.fn(),
		replacePriceWindowsForModel: vi.fn(),
	};
});

import { requireAdmin } from "$lib/server/auth/hooks";
import {
	listPriceWindows,
	replacePriceWindowsForModel,
} from "$lib/server/services/price-windows";
import { GET, PUT } from "./+server";

const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;
const mockList = listPriceWindows as ReturnType<typeof vi.fn>;
const mockReplace = replacePriceWindowsForModel as ReturnType<typeof vi.fn>;

type Event = Parameters<typeof PUT>[0];

function makeEvent(method: "GET" | "PUT", body?: unknown): Event {
	const url =
		"http://localhost/api/admin/providers/provider-1/models/model-1/price-windows";
	return {
		request: new Request(url, {
			method,
			headers: { "Content-Type": "application/json" },
			body: body !== undefined ? JSON.stringify(body) : undefined,
		}),
		locals: { user: { id: "admin-1", role: "admin" } },
		params: { id: "provider-1", modelId: "model-1" },
		url: new URL(url),
		route: {
			id: "/api/admin/providers/[id]/models/[modelId]/price-windows",
		},
	} as Event;
}

describe("admin price-windows route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAdmin.mockReturnValue(undefined);
		mockList.mockResolvedValue([]);
		mockReplace.mockResolvedValue([]);
	});

	it("lists windows", async () => {
		mockList.mockResolvedValue([{ id: "w1", label: "off-peak" }]);
		const response = await GET(makeEvent("GET"));
		const data = await response.json();
		expect(response.status).toBe(200);
		expect(data.windows).toEqual([{ id: "w1", label: "off-peak" }]);
		expect(mockList).toHaveBeenCalledWith("model-1");
	});

	it("replaces windows with a validated payload", async () => {
		mockReplace.mockResolvedValue([{ id: "w2", label: "off-peak" }]);
		const response = await PUT(
			makeEvent("PUT", {
				windows: [
					{
						label: "off-peak",
						startMinute: 0,
						endMinute: 480,
						daysOfWeek: "0123456",
					},
				],
			}),
		);
		const data = await response.json();
		expect(response.status).toBe(200);
		expect(data.windows).toEqual([{ id: "w2", label: "off-peak" }]);
		expect(mockReplace).toHaveBeenCalledWith("model-1", [
			expect.objectContaining({
				label: "off-peak",
				startMinute: 0,
				endMinute: 480,
				daysOfWeek: "0123456",
			}),
		]);
	});

	it("returns 400 on validation failure", async () => {
		const response = await PUT(
			makeEvent("PUT", { windows: [{ startMinute: 0, endMinute: 60 }] }),
		);
		const data = await response.json();
		expect(response.status).toBe(400);
		expect(data.error).toContain("label");
		expect(mockReplace).not.toHaveBeenCalled();
	});

	it("returns 400 on invalid JSON", async () => {
		const event = makeEvent("PUT");
		const response = await PUT(event);
		const data = await response.json();
		expect(response.status).toBe(400);
		expect(data.error).toBe("Invalid JSON");
	});
});
