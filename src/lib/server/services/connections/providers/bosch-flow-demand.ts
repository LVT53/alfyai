type Account = {
	pairing: string;
	client: { clientId: string; clientSecret?: string };
	refreshToken: string | null;
	accessToken: string;
	expiresAt: number;
};
type State = {
	current: () => Account | null;
	rotate: (r: Account) => Promise<void>;
	disable: () => Promise<void>;
};

import { refreshBoschGrant } from "./bosch-flow-oauth";
import { collectBoschSnapshot } from "./bosch-flow-snapshot";
export const boschUploadUrl =
	"https://ai.alfydesign.com/api/connections/bosch/sync";
const pollUrl = "https://ai.alfydesign.com/api/connections/bosch/poll";
export function demandPolling(fetcher: typeof fetch, state: State) {
	let control: AbortController | null = null;
	let running: Promise<number> | undefined;
	let cache: { requestId: string; body: string } | null = null;
	const stop = () => {
		control?.abort();
		control = null;
		cache = null;
	};
	async function pollOnce() {
		const ctx = control,
			rider = state.current();
		if (!ctx || !rider) return 2000;
		let requestId: string | null = null;
		const call = (endpoint: string, extra: RequestInit = {}) =>
			fetcher(endpoint, {
				method: "POST",
				redirect: "error",
				...extra,
				headers: { Authorization: `Bearer ${rider.pairing}`, ...extra.headers },
				signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(15000)]),
			});
		const boschFetch: typeof fetch = (url, o = {}) =>
			fetcher(url, {
				...o,
				signal: AbortSignal.any([
					ctx.signal,
					...(o.signal ? [o.signal] : []),
					AbortSignal.timeout(15000),
				]),
			});
		const disable = async () => {
			if (ctx === control) {
				stop();
				await state.disable();
			}
		};
		try {
			const poll = await call(pollUrl);
			if (poll.status === 401 || poll.status === 403) {
				await disable();
				return 2000;
			}
			if (!poll.ok) return 10000;
			const data = await poll.json();
			const delay = Number.isSafeInteger(data?.retryAfterMs)
				? Math.min(30000, Math.max(1000, data.retryAfterMs))
				: 2000;
			if (data?.requestId === null) {
				cache = null;
				return delay;
			}
			if (
				typeof data?.requestId !== "string" ||
				!/^[A-Za-z0-9_-]{1,150}$/.test(data.requestId)
			)
				return 5000;
			requestId = data.requestId;
			if (!requestId || ctx.signal.aborted) return delay;
			if (cache?.requestId !== requestId) {
				const renew = async () => {
					if (!rider.refreshToken)
						throw Object.assign(new Error("expired"), { code: "expired" });
					const grant = await refreshBoschGrant(
						rider.client,
						rider.refreshToken,
						boschFetch,
					);
					if (ctx.signal.aborted) throw Error("Stopped");
					Object.assign(rider, grant);
				};
				if (rider.expiresAt <= Date.now() + 30000) await renew();
				await state.rotate(rider);
				let summary: Awaited<ReturnType<typeof collectBoschSnapshot>>;
				try {
					summary = await collectBoschSnapshot(rider.accessToken, boschFetch);
				} catch (error) {
					if (
						!error ||
						typeof error !== "object" ||
						!("code" in error) ||
						error.code !== "expired" ||
						!rider.refreshToken ||
						ctx.signal.aborted
					)
						throw error;
					await renew();
					await state.rotate(rider);
					summary = await collectBoschSnapshot(rider.accessToken, boschFetch);
				}
				const body = JSON.stringify(summary);
				if (ctx.signal.aborted) return delay;
				cache = { requestId, body };
			}
			const sent = await call(boschUploadUrl, {
				headers: {
					"X-Bosch-Request": requestId,
					"Content-Type": "application/json",
				},
				body: cache.body,
			});
			if (sent.status === 401 || sent.status === 403) await disable();
			return sent.ok ? delay : 5000;
		} catch (e) {
			if (requestId && !ctx.signal.aborted && cache?.requestId !== requestId) {
				await call(pollUrl, { headers: { "X-Bosch-Failed": requestId } }).catch(
					() => undefined,
				);
				const code = typeof e === "object" && e && "code" in e ? e.code : "";
				if (
					["authorization_failed", "access_denied", "expired"].includes(
						String(code),
					)
				)
					await disable();
			}
			return 5000;
		}
	}
	return {
		start() {
			stop();
			control = new AbortController();
		},
		async stopAndWait() {
			stop();
			await running?.catch(() => undefined);
		},
		pollOnce() {
			if (!running)
				running = pollOnce().finally(() => {
					running = undefined;
				});
			return running;
		},
		enabled: () => !!control,
	};
}
