import { requestJson } from "./http";

interface LoginResponse {
	user?: {
		id: string;
		email: string;
		displayName: string;
	};
	/**
	 * The account has a confirmed second factor: the password opened a
	 * five-minute attempt, no session exists yet, and the card must ask for a
	 * code. `user` is absent in this answer.
	 */
	twoStep?: boolean;
}

export interface TwoStepSignInResult {
	ok: true;
	usedBackupCode: boolean;
	backupCodesLeft: number;
}

export async function login(
	email: string,
	password: string,
	rememberMe = false,
): Promise<LoginResponse> {
	return requestJson<LoginResponse>(
		"/api/auth/login",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ email, password, rememberMe }),
		},
		"Login failed. Please check your credentials.",
	);
}

/**
 * The second step of a two-step sign-in: a six-digit authenticator code, or
 * one of the backup codes. The attempt lives in an httpOnly cookie the server
 * set at the password step; success sets the session cookie in this response.
 * A wrong code carries its `errorKey` and `details.triesLeft`, which the card
 * localizes; its count is also the sign-in limiter's.
 */
export async function verifyTwoStepSignIn(input: {
	code?: string;
	backupCode?: string;
}): Promise<TwoStepSignInResult> {
	return requestJson<TwoStepSignInResult>(
		"/api/auth/login/two-step",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		},
		"That code didn't work. Please try again.",
	);
}

export async function logout(): Promise<void> {
	await requestJson<{ success?: boolean }>(
		"/api/auth/logout",
		{
			method: "POST",
		},
		"Logout failed",
	);
}
