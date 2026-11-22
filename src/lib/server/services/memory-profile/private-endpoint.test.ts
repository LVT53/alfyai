import type { LookupAddress } from "node:dns";
import { expect, it, vi } from "vitest";
import { fetchPrivateMemory } from "./private-endpoint";

const { lookup } = vi.hoisted(() => ({
	lookup: vi.fn<() => Promise<LookupAddress[]>>(),
}));
vi.mock("node:dns/promises", () => ({ default: { lookup }, lookup }));

it("pins the Docker gateway address per request and never transmits to a changed public result", async () => {
	lookup
		.mockResolvedValueOnce([{ address: "172.17.0.1", family: 4 }])
		.mockResolvedValueOnce([
			{ address: "172.17.0.1", family: 4 },
			{ address: "8.8.8.8", family: 4 },
		]);
	const capture = vi.fn<typeof fetch>(async () => new Response("{}"));
	const url = "http://host.docker.internal:8888/ext/alfyai/capabilities";
	const init = { headers: { authorization: "Bearer synthetic" } };
	await fetchPrivateMemory(url, init, capture);
	expect(capture).toHaveBeenCalledOnce();
	const [target, options] = capture.mock.calls[0];
	expect(target).toBe("http://172.17.0.1:8888/ext/alfyai/capabilities");
	expect(new Headers(options?.headers).get("host")).toBe(
		"host.docker.internal:8888",
	);
	expect(options?.redirect).toBe("error");
	await expect(fetchPrivateMemory(url, init, capture)).rejects.toThrow(
		"deployment's private endpoints",
	);
	expect(capture).toHaveBeenCalledOnce();
});
