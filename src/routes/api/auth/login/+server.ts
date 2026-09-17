import { randomBytes } from "node:crypto";
import type { RequestHandler } from "@sveltejs/kit";
import { json } from "@sveltejs/kit";
import * as bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "$lib/server/db";
import { users } from "$lib/server/db/schema";
import {
	createSession,
	setSessionCookie,
	verifyPassword,
} from "$lib/server/services/auth";
import {
	guardCredentialCheck,
	type LoginRateLimitBlock,
	recordLoginFailure,
	recordLoginSuccess,
	resolveRateLimitClientAddress,
} from "$lib/server/services/login-rate-limit";

type LoginResponseMode = "json" | "redirect";

/**
 * The 429 body. `error` is the English fallback the client renders when it
 * does not recognise the key; `errorKey` is what the login page actually
 * localizes, following the pattern in src/routes/api/chat/retry/+server.ts.
 */
const TOO_MANY_ATTEMPTS_KEY = "login.tooManyAttempts";
const TOO_MANY_ATTEMPTS_MESSAGE =
	"Too many failed sign-in attempts. Please wait a moment and try again.";

function tooManyAttempts(block: LoginRateLimitBlock): Response {
	return json(
		{ error: TOO_MANY_ATTEMPTS_MESSAGE, errorKey: TOO_MANY_ATTEMPTS_KEY },
		{
			status: 429,
			headers: { "Retry-After": String(block.retryAfterSeconds) },
		},
	);
}

/**
 * A bcrypt comparison against a hash nobody holds the input to, so the
 * unknown-account path costs the same as the wrong-password path.
 *
 * Generated once, lazily, rather than being a literal in the source: the cost
 * factor then always matches whatever `bcrypt.hash(password, 12)` costs in
 * this deployment, and there is no constant here for a reader to have to
 * satisfy themselves is not a real credential.
 */
let decoyHashPromise: Promise<string> | null = null;

async function burnPasswordComparison(password: string): Promise<false> {
	if (!decoyHashPromise) {
		decoyHashPromise = bcrypt.hash(randomBytes(32).toString("hex"), 12);
	}
	await verifyPassword(password, await decoyHashPromise);
	return false;
}

// Validation schema for login request
const loginSchema = z.object({
	email: z.string().min(1, "Invalid email or password"),
	password: z.string().min(1, "Invalid email or password"),
	rememberMe: z.boolean().optional().default(false),
});

async function parseLoginRequest(request: Request): Promise<{
	body: unknown;
	responseMode: LoginResponseMode;
}> {
	const contentType = request.headers.get("content-type") ?? "";
	if (contentType.includes("application/json")) {
		return {
			body: await request.json(),
			responseMode: "json",
		};
	}

	const formData = await request.formData();
	const rememberMeValue = formData.get("rememberMe");
	return {
		body: {
			email: formData.get("email"),
			password: formData.get("password"),
			rememberMe: rememberMeValue === "on" || rememberMeValue === "true",
		},
		responseMode: "redirect",
	};
}

export const POST: RequestHandler = async ({
	request,
	cookies,
	getClientAddress,
}) => {
	try {
		const { body, responseMode } = await parseLoginRequest(request);
		const result = loginSchema.safeParse(body);

		if (!result.success) {
			return json({ error: "Invalid email or password" }, { status: 400 });
		}

		const { email, password, rememberMe } = result.data;

		// `getClientAddress` is absent from the hand-rolled events in some route
		// tests; a missing address only means the per-address budget is skipped,
		// which is the same thing that happens behind an unconfigured proxy.
		const rateLimitKeys = {
			email,
			clientAddress: resolveRateLimitClientAddress(
				getClientAddress?.() ?? null,
			),
		};

		// The whole credential check runs inside the throttle. Under budget that
		// is a plain call; over budget it waits out an escalating penalty and
		// lets only one comparison per key run at a time. A correct password is
		// still accepted while throttled — see the note at the top of
		// login-rate-limit.ts for why a hard lockout is not an option here.
		const guarded = await guardCredentialCheck(rateLimitKeys, async () => {
			const userResult = await db
				.select()
				.from(users)
				.where(eq(users.email, email))
				.limit(1);

			const found = userResult[0];

			// A bcrypt comparison runs on both paths. Returning early for an
			// unknown address would answer "does this account exist?" in about
			// 250ms of timing difference, which is the enumeration leak the
			// generic error message above is there to prevent.
			const valid = found
				? await verifyPassword(password, found.passwordHash)
				: await burnPasswordComparison(password);

			return { user: found, valid };
		});

		// Another over-budget attempt on one of these keys is mid-flight. No
		// comparison happened, so nothing is recorded either.
		if (guarded.outcome === "refused") {
			return tooManyAttempts(guarded.block);
		}

		const { user, valid: passwordValid } = guarded.value;

		if (!user || !passwordValid) {
			recordLoginFailure(rateLimitKeys);
			// A wrong answer under a penalty is reported as the throttle it is;
			// otherwise it stays the generic, enumeration-proof 401.
			if (guarded.throttled) {
				return tooManyAttempts(guarded.throttled);
			}
			return json({ error: "Invalid email or password" }, { status: 401 });
		}

		recordLoginSuccess(rateLimitKeys);

		// Create session and set cookie
		const { token, expiresAt } = await createSession(user.id, { rememberMe });
		setSessionCookie(cookies, token, expiresAt, { rememberMe });

		if (responseMode === "redirect") {
			return new Response(null, {
				status: 303,
				headers: {
					Location: "/",
				},
			});
		}

		return json({
			user: {
				id: user.id,
				email: user.email,
				displayName: user.name ?? user.email,
			},
		});
	} catch (err) {
		console.error("Login error:", err);
		return json({ error: "Internal server error" }, { status: 500 });
	}
};
