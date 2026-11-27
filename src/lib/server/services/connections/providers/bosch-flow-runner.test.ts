import { expect, it, vi } from "vitest";
import { createBoschRunner } from "./bosch-flow-runner";
import { collectBoschSnapshot } from "./bosch-flow-snapshot";

const pairing = `YXV0aG9yaXplZA.id-123.${"s".repeat(43)}`;
it("collects only documented bike and ride fields, counts incomplete data, and excludes routes", async () => {
	const fetch = vi.fn<typeof globalThis.fetch>(async (u) =>
		String(u).includes("bike-profile")
			? Response.json({
					bikes: [{ id: "bike", name: "City", serial: "private" }],
				})
			: Response.json({
					activitySummaries: [
						{
							id: "ride",
							startTime: "2026-11-15T10:00:00Z",
							distance: 200,
							gps: [47, 19],
						},
						{ id: "missing-date", track: "private" },
					],
					pagination: { total: 2 },
				}),
	);
	const snapshot = await collectBoschSnapshot("token", fetch);
	expect(snapshot).toEqual({
		bikes: [{ id: "bike", name: "City" }],
		rides: [
			{
				id: "ride",
				startTime: "2026-11-15T10:00:00.000Z",
				endTime: null,
				distanceMeters: 200,
			},
		],
		complete: false,
	});
});
it("blocks foreign host/origin and requires exact consent before a summary reaches the fixed AlfyAI server", async () => {
	const fetch = vi.fn<typeof globalThis.fetch>(async (u) => {
		const url = new URL(String(u));
		if (url.pathname.endsWith("/token"))
			return Response.json({
				access_token: "private",
				refresh_token: "retain",
				token_type: "Bearer",
				expires_in: 180,
			});
		if (url.pathname.endsWith("bikes")) return Response.json({ bikes: [] });
		if (url.pathname.endsWith("activities"))
			return Response.json({ activitySummaries: [], pagination: { total: 0 } });
		return new Response(null, { status: 204 });
	});
	const session = createBoschRunner({ fetch });
	const first = await session.handle(
		new Request(session.launchUrl, { headers: { host: "127.0.0.1:47831" } }),
	);
	const cookie = first.headers.get("set-cookie")?.split(";")[0] ?? "";
	const request = (
		path: string,
		method = "GET",
		fields?: Record<string, string>,
		origin = "http://127.0.0.1:47831",
	) =>
		session.handle(
			new Request(`http://127.0.0.1:47831${path}`, {
				method,
				headers: {
					host: "127.0.0.1:47831",
					cookie,
					...(method === "POST"
						? { origin, "content-type": "application/x-www-form-urlencoded" }
						: {}),
				},
				body: fields ? new URLSearchParams(fields) : undefined,
			}),
		);
	expect(
		(
			await session.handle(
				new Request("http://foreign.test/", {
					headers: { host: "foreign.test" },
				}),
			)
		).status,
	).toBe(403);
	expect(
		(await request("/authorize", "POST", {}, "https://foreign.test")).status,
	).toBe(403);
	const home = await (await request("/")).text();
	const csrf = /name="csrf" value="([^"]+)"/.exec(home)?.[1] ?? "missing";
	expect((await request("/sync", "POST", { csrf })).status).toBe(409);
	const login = await request("/authorize", "POST", {
		csrf,
		clientId: "mine",
		pairing,
	});
	const url = new URL(login.headers.get("location") ?? "");
	expect(url.hostname).toBe("p9.authz.bosch.com");
	expect((await request("/callback?state=bogus&code=fake")).status).toBe(400);
	const callback = await request(
		`/callback?state=${url.searchParams.get("state")}&code=valid`,
	);
	expect(callback.status).toBe(303);
	const review = await (await request("/")).text();
	const decision =
		/name="review" value="([^"]+)"/.exec(review)?.[1] ?? "missing";
	expect(decision).not.toBe("missing");
	expect(review).toContain("Allow future AlfyAI cycling questions");
	expect(
		fetch.mock.calls.some(([u]) => String(u).includes("ai.alfydesign.com")),
	).toBe(false);
	expect(
		(await request("/sync", "POST", { csrf, review: "stale" })).status,
	).toBe(409);
	expect(
		(await request("/sync", "POST", { csrf, review: decision })).status,
	).toBe(303);
	const [u, init] = fetch.mock.calls.at(-1) ?? [];
	expect(String(u)).toBe(
		"https://ai.alfydesign.com/api/connections/bosch/sync",
	);
	expect(new Headers(init?.headers).get("Authorization")).toBe(
		`Bearer ${pairing}`,
	);
	expect(init?.body).not.toContain("private");
	expect(
		(await request("/sync", "POST", { csrf, review: decision })).status,
	).toBe(409);
});
it("resumes only previously authorized demand polls and reads Bosch only when a question arrives", async () => {
	let ask = false,
		rotated = false;
	const fetch = vi.fn<typeof globalThis.fetch>(async (u, init) => {
		const url = new URL(String(u));
		if (url.pathname.endsWith("/poll"))
			return Response.json({
				requestId: ask ? "question-1" : null,
				retryAfterMs: 2000,
			});
		if (url.pathname.endsWith("/token")) {
			rotated = true;
			return Response.json({
				access_token: "bosch",
				refresh_token: "new-refresh",
				expires_in: 240,
				token_type: "Bearer",
			});
		}
		if (url.pathname.endsWith("/bikes")) return Response.json({ bikes: [] });
		if (url.pathname.endsWith("/activities"))
			return Response.json({ activitySummaries: [], pagination: { total: 0 } });
		if (url.pathname.endsWith("/sync")) {
			expect(new Headers(init?.headers).get("X-Bosch-Request")).toBe(
				"question-1",
			);
			return new Response(null, { status: 204 });
		}
		throw Error("unexpected");
	});
	const persist = vi.fn(async () => {});
	const saved = {
		client: { clientId: "mine" },
		refreshToken: "old",
		pairing,
		onDemand: true,
	};
	const runner = createBoschRunner({ fetch, persist, saved, service: true });
	expect(await runner.pollOnce()).toBe(2000);
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(rotated).toBe(false);
	ask = true;
	await runner.pollOnce();
	expect(rotated).toBe(true);
	expect(persist).toHaveBeenCalledWith({
		...saved,
		refreshToken: "new-refresh",
	});
	expect(
		fetch.mock.calls.filter(([u]) => String(u).endsWith("/sync")),
	).toHaveLength(1);
	const off = createBoschRunner({
		fetch,
		persist,
		saved: { ...saved, onDemand: false },
		service: true,
	});
	fetch.mockClear();
	await off.pollOnce();
	expect(fetch).not.toHaveBeenCalled();
});
it("reports an upstream failure against the exact waiting question without uploading a stale preview", async () => {
	const fetch = vi.fn<typeof globalThis.fetch>(async (u, init) => {
		const headers = new Headers(init?.headers);
		if (headers.has("X-Bosch-Failed"))
			return new Response(null, { status: 204 });
		if (String(u).endsWith("/poll"))
			return Response.json({ requestId: "pending", retryAfterMs: 2000 });
		return Response.json({ error: "invalid_grant" }, { status: 400 });
	});
	const persist = vi.fn(async () => {});
	const saved = {
		client: { clientId: "mine" },
		refreshToken: "expired",
		pairing,
		onDemand: true,
	};
	const runner = createBoschRunner({ fetch, persist, saved, service: true });
	await runner.pollOnce();
	expect(
		fetch.mock.calls.some(
			([, i]) => new Headers(i?.headers).get("X-Bosch-Failed") === "pending",
		),
	).toBe(true);
	expect(fetch.mock.calls.some(([u]) => String(u).endsWith("/sync"))).toBe(
		false,
	);
	expect(persist).toHaveBeenCalledWith({ ...saved, onDemand: false });
});
it("refreshes once when Bosch rejects a cached access token and keeps a usable grant active", async () => {
	let refreshes = 0,
		bikes = 0;
	const fetch = vi.fn<typeof globalThis.fetch>(async (u) => {
		const url = String(u);
		if (url.endsWith("/poll")) return Response.json({ requestId: "demand" });
		if (url.endsWith("/token")) {
			refreshes++;
			return Response.json({
				access_token: "access-" + refreshes,
				refresh_token: "refresh-" + refreshes,
				expires_in: 300,
				token_type: "Bearer",
			});
		}
		if (url.endsWith("/bikes")) {
			bikes++;
			return bikes === 1
				? new Response(null, { status: 401 })
				: Response.json({ bikes: [] });
		}
		if (url.includes("/activities?"))
			return Response.json({ activitySummaries: [], pagination: { total: 0 } });
		return new Response(null, { status: 204 });
	});
	const persist = vi.fn(async () => {});
	const runner = createBoschRunner({
		service: true,
		saved: {
			client: { clientId: "id" },
			pairing,
			refreshToken: "initial",
			onDemand: true,
		},
		persist,
		fetch,
	});
	await runner.pollOnce();
	expect(refreshes).toBe(2);
	expect(
		fetch.mock.calls.filter(([u]) => String(u).endsWith("/sync")),
	).toHaveLength(1);
	expect(persist).toHaveBeenLastCalledWith(
		expect.objectContaining({ onDemand: true, refreshToken: "refresh-2" }),
	);
});
