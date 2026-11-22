import { describe, expect, it, vi } from "vitest";
import { captureSettledNative } from "./delivery-runner";
import { HindsightClient } from "./hindsight-client";

const rows = [
	{
		id: "f",
		text: "green",
		fact_type: "world",
		document_id: "s",
		consolidated_at: "2026-11-18T00:00:00Z",
	},
	{
		id: "o",
		text: "green",
		fact_type: "observation",
		source_memory_ids: ["f"],
	},
];
function client(fetcher: typeof fetch) {
	return new HindsightClient({
		baseUrl: "http://native",
		apiKey: "key",
		bankId: "bank",
		fetcher,
	});
}
describe("complete native capture", () => {
	it("waits for a chained consolidation round before capture", async () => {
		let pending = true;
		const fetcher = vi.fn(async (url: RequestInfo | URL) => {
			const path = String(url);
			if (path.includes("/operations/follow-on")) {
				pending = false;
				return new Response(JSON.stringify({ status: "completed" }));
			}
			if (path.includes("/operations?"))
				return new Response(
					JSON.stringify({
						operations:
							pending && path.includes("status=pending")
								? [{ id: "follow-on", status: "pending" }]
								: [],
					}),
				);
			return new Response(JSON.stringify({ items: rows, total: 2, offset: 0 }));
		});
		expect(
			await captureSettledNative(client(fetcher), new AbortController().signal),
		).toEqual(rows);
		expect(
			fetcher.mock.calls.some(([url]) =>
				String(url).includes("/operations/follow-on"),
			),
		).toBe(true);
	});
	it("rejects native insertion between complete passes", async () => {
		let captures = 0;
		const fetcher = vi.fn(async (url: RequestInfo | URL) => {
			if (String(url).includes("/operations?"))
				return new Response(JSON.stringify({ operations: [] }));
			captures++;
			return new Response(
				JSON.stringify({
					items:
						captures === 1
							? rows
							: [
									...rows,
									{
										id: "second",
										text: "independent",
										fact_type: "observation",
										source_memory_ids: ["f"],
									},
								],
					total: captures === 1 ? 2 : 3,
					offset: 0,
				}),
			);
		});
		await expect(
			captureSettledNative(client(fetcher), new AbortController().signal),
		).rejects.toMatchObject({ code: "native_capture_unstable" });
	});
	it("rejects permanently failed or pending source consolidation", async () => {
		for (const consolidated_at of [null, "2026-11-18T00:00:00Z"]) {
			const fetcher = vi.fn(
				async (url: RequestInfo | URL) =>
					new Response(
						JSON.stringify(
							String(url).includes("/operations?")
								? { operations: [] }
								: {
										items: [
											{
												...rows[0],
												consolidated_at,
												consolidation_failed_at: "2026-11-18T01:00:00Z",
											},
										],
										total: 1,
										offset: 0,
									},
						),
					),
			);
			await expect(
				captureSettledNative(client(fetcher), new AbortController().signal),
			).rejects.toMatchObject({ code: "native_consolidation_incomplete" });
		}
	});
});
