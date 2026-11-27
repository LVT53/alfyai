import { randomBytes, timingSafeEqual } from "node:crypto";
import { boschUploadUrl, demandPolling } from "./bosch-flow-demand";
import {
	beginBoschLogin,
	exchangeBoschCode,
	refreshBoschGrant,
} from "./bosch-flow-oauth";
import { runnerPage, runnerWords } from "./bosch-flow-runner-page";
import { collectBoschSnapshot, type Snapshot } from "./bosch-flow-snapshot";

const pairingPattern = /^[\w-]{1,180}\.[\w-]{1,128}\.[\w-]{43}$/;
const opaque = () => randomBytes(32).toString("base64url");
function same(a: string | null, b: string) {
	if (!a || Buffer.byteLength(a) !== Buffer.byteLength(b)) return false;
	return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
type Login = { clientId: string; clientSecret?: string };
export type BoschLocalCredential = {
	client: Login;
	pairing: string;
	refreshToken: string;
	onDemand?: boolean;
};
type Options = {
	service?: boolean;
	browserPort?: number;
	fetch?: typeof fetch;
	saved?: BoschLocalCredential | null;
	persist?: (value: BoschLocalCredential | null) => Promise<void>;
};
const safeHeaders = {
	"Content-Security-Policy":
		"default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://p9.authz.bosch.com; frame-ancestors 'none'; base-uri 'none'",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"Cache-Control": "no-store",
};
export function createBoschRunner(options: Options = {}) {
	const port = options.browserPort ?? 47831;
	if (!Number.isInteger(port) || port < 1024 || port > 65535)
		throw Error("Invalid loopback port");
	const origin = `http://127.0.0.1:${port}`;
	const callback = new URL("/callback", origin);
	const csrf = opaque(),
		browserSession = opaque();
	let launchKey: string | null = opaque();
	const launchUrl = `${origin}/?start=${launchKey}`;
	const fetcher = options.fetch ?? fetch;
	let saved = options.saved ?? null;
	let account: {
		client: Login;
		pairing: string;
		refreshToken: string | null;
		accessToken: string;
		expiresAt: number;
	} | null = saved ? { ...saved, accessToken: "", expiresAt: 0 } : null;
	let approvedReview: string | null = null;
	const stopSaved = async () => {
		if (saved?.onDemand) {
			const next = { ...saved, onDemand: false };
			await options.persist?.(next);
			saved = next;
		}
	};
	const demand = demandPolling(fetcher, {
		current: () => account,
		disable: stopSaved,
		rotate: async (r) => {
			if (
				saved &&
				saved.pairing === r.pairing &&
				r.refreshToken &&
				saved.refreshToken !== r.refreshToken
			) {
				const next = { ...saved, refreshToken: r.refreshToken };
				await options.persist?.(next);
				saved = next;
			}
		},
	});
	if (options.service && saved?.onDemand === true) demand.start();
	let pending: {
		login: ReturnType<typeof beginBoschLogin>;
		client: Login;
		pairing: string;
		remember: boolean;
		at: number;
	} | null = null;
	let prepared: { snapshot: Snapshot; review: string; pairing: string } | null =
		null;
	let busy = false,
		completed = false;
	const redirect = (url: string, extra: Record<string, string> = {}) =>
		new Response(null, {
			status: 303,
			headers: { ...safeHeaders, Location: url, ...extra },
		});
	async function handle(req: Request): Promise<Response> {
		const u = new URL(req.url);
		const hu = /^hu\b/i.test(req.headers.get("accept-language") ?? "");
		const word = runnerWords[hu ? "hu" : "en"];
		const message = (status: number, text: string) =>
			new Response(text, {
				status,
				headers: {
					...safeHeaders,
					"Content-Type": "text/plain; charset=utf-8",
				},
			});
		if (req.headers.get("host") !== callback.host || u.origin !== origin)
			return message(403, word.denied);
		if (
			req.method === "GET" &&
			u.pathname === "/" &&
			launchKey &&
			same(u.searchParams.get("start"), launchKey)
		) {
			launchKey = null;
			return redirect("/", {
				"Set-Cookie": `alfybosch=${browserSession}; Path=/; HttpOnly; SameSite=Lax`,
			});
		}
		const cookie =
			(req.headers.get("cookie") ?? "")
				.split(";")
				.map((p) => p.trim())
				.find((p) => p.startsWith("alfybosch="))
				?.slice(10) ?? null;
		if (!same(cookie, browserSession)) return message(403, word.launch);
		if (req.method === "GET" && u.pathname === "/")
			return new Response(
				runnerPage({
					hu,
					csrf,
					prepared,
					saved: !!saved,
					completed,
					canSave: !!options.persist,
					demand: demand.enabled(),
					approval: approvedReview,
					service: !!options.service,
				}),
				{
					headers: {
						...safeHeaders,
						"Content-Type": "text/html; charset=utf-8",
					},
				},
			);
		if (
			req.method !== "POST" &&
			!(req.method === "GET" && u.pathname === "/callback")
		)
			return message(404, word.denied);
		let fields = new URLSearchParams();
		if (req.method === "POST") {
			if (
				req.headers.get("origin") !== origin ||
				!req.headers
					.get("content-type")
					?.startsWith("application/x-www-form-urlencoded")
			)
				return message(403, word.denied);
			const body = await req.text();
			if (Buffer.byteLength(body) > 16384) return message(413, word.denied);
			fields = new URLSearchParams(body);
			if (!same(fields.get("csrf"), csrf)) return message(403, word.denied);
		}
		if (busy) return message(409, word.busy);
		busy = true;
		try {
			if (u.pathname === "/authorize" && req.method === "POST") {
				const clientId = fields.get("clientId")?.trim() ?? "",
					clientSecret = fields.get("clientSecret") ?? "",
					pairing = fields.get("pairing")?.trim() ?? "";
				if (
					!clientId ||
					clientId.length > 512 ||
					clientSecret.length > 4096 ||
					!pairingPattern.test(pairing)
				)
					return message(400, word.invalid);
				await demand.stopAndWait();
				await stopSaved();
				approvedReview = null;
				account = null;
				const client = { clientId, ...(clientSecret ? { clientSecret } : {}) };
				const login = beginBoschLogin(clientId, callback);
				pending = {
					login,
					client,
					pairing,
					remember: !!options.persist && fields.get("remember") === "yes",
					at: Date.now(),
				};
				prepared = null;
				completed = false;
				return redirect(login.url);
			}
			if (u.pathname === "/callback" && req.method === "GET") {
				if (
					!pending ||
					Date.now() - pending.at > 600000 ||
					!same(u.searchParams.get("state"), pending.login.state)
				)
					return message(400, word.invalid);
				const p = pending;
				pending = null;
				const code = u.searchParams.get("code");
				if (!code || code.length > 4096) return message(400, word.oauth);
				const grant = await exchangeBoschCode(
					p.client,
					code,
					p.login.verifier,
					callback,
					fetcher,
				);
				if (p.remember && grant.refreshToken && options.persist) {
					const next = {
						client: p.client,
						pairing: p.pairing,
						refreshToken: grant.refreshToken,
					};
					await options.persist(next);
					saved = next;
				}
				const snapshot = await collectBoschSnapshot(grant.accessToken, fetcher);
				account = { client: p.client, pairing: p.pairing, ...grant };
				approvedReview = opaque();
				prepared = { snapshot, review: approvedReview, pairing: p.pairing };
				completed = false;
				return redirect("/");
			}
			if (u.pathname === "/refresh" && req.method === "POST" && saved) {
				await demand.stopAndWait();
				await stopSaved();
				approvedReview = null;
				prepared = null;
				completed = false;
				const grant = await refreshBoschGrant(
					saved.client,
					saved.refreshToken,
					fetcher,
				);
				if (grant.refreshToken && grant.refreshToken !== saved.refreshToken) {
					const next = { ...saved, refreshToken: grant.refreshToken };
					await options.persist?.(next);
					saved = next;
				}
				const snapshot = await collectBoschSnapshot(grant.accessToken, fetcher);
				account = { client: saved.client, pairing: saved.pairing, ...grant };
				approvedReview = opaque();
				prepared = { snapshot, review: approvedReview, pairing: saved.pairing };
				return redirect("/");
			}
			if (u.pathname === "/enable" && req.method === "POST") {
				if (
					!account ||
					!approvedReview ||
					!same(fields.get("review"), approvedReview)
				)
					return message(409, word.stale);
				if (options.service) {
					if (!account.refreshToken || !options.persist)
						return message(400, word.noRefresh);
					const next = {
						client: account.client,
						pairing: account.pairing,
						refreshToken: account.refreshToken,
						onDemand: true,
					};
					await options.persist(next);
					saved = next;
				}
				demand.start();
				approvedReview = null;
				prepared = null;
				completed = false;
				return redirect("/");
			}
			if (u.pathname === "/stop" && req.method === "POST") {
				await demand.stopAndWait();
				await stopSaved();
				approvedReview = null;
				prepared = null;
				return redirect("/");
			}
			if (u.pathname === "/forget" && req.method === "POST") {
				await demand.stopAndWait();
				account = null;
				approvedReview = null;
				await options.persist?.(null);
				saved = null;
				pending = null;
				prepared = null;
				completed = false;
				return redirect("/");
			}
			if (u.pathname === "/discard" && req.method === "POST") {
				approvedReview = null;
				prepared = null;
				pending = null;
				completed = false;
				return redirect("/");
			}
			if (u.pathname === "/sync" && req.method === "POST") {
				if (!prepared || !same(fields.get("review"), prepared.review))
					return message(409, word.stale);
				const item = prepared;
				prepared = null;
				const result = await fetcher(boschUploadUrl, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${item.pairing}`,
						"Content-Type": "application/json",
					},
					redirect: "error",
					signal: AbortSignal.timeout(20000),
					body: JSON.stringify(item.snapshot),
				});
				if (!result.ok) {
					prepared = { ...item, review: opaque() };
					return message(
						result.status === 401 ? 401 : 502,
						result.status === 401 ? word.pairing : word.syncError,
					);
				}
				completed = true;
				return redirect("/");
			}
			return message(404, word.denied);
		} catch {
			return message(502, word.failed);
		} finally {
			busy = false;
		}
	}
	return {
		launchUrl,
		handle,
		pollOnce: demand.pollOnce,
		renewLaunchUrl() {
			launchKey = opaque();
			return `${origin}/?start=${launchKey}`;
		},
	};
}
