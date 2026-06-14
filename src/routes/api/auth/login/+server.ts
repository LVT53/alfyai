import type { RequestHandler } from "@sveltejs/kit";
import { json } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "$lib/server/db";
import { users } from "$lib/server/db/schema";
import {
	createSession,
	setSessionCookie,
	verifyPassword,
} from "$lib/server/services/auth";

type LoginResponseMode = "json" | "redirect";

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

export const POST: RequestHandler = async ({ request, cookies }) => {
	try {
		const { body, responseMode } = await parseLoginRequest(request);
		const result = loginSchema.safeParse(body);

		if (!result.success) {
			return json({ error: "Invalid email or password" }, { status: 400 });
		}

		const { email, password, rememberMe } = result.data;

		// Find user by email
		const userResult = await db
			.select()
			.from(users)
			.where(eq(users.email, email))
			.limit(1);

		if (userResult.length === 0) {
			// Return generic error to prevent email enumeration
			return json({ error: "Invalid email or password" }, { status: 401 });
		}

		const user = userResult[0];

		// Verify password
		const passwordValid = await verifyPassword(password, user.passwordHash);

		if (!passwordValid) {
			return json({ error: "Invalid email or password" }, { status: 401 });
		}

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
