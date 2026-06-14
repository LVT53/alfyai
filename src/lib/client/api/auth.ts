import { requestJson } from "./http";

interface LoginResponse {
	user?: {
		id: string;
		email: string;
		displayName: string;
	};
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

export async function logout(): Promise<void> {
	await requestJson<{ success?: boolean }>(
		"/api/auth/logout",
		{
			method: "POST",
		},
		"Logout failed",
	);
}
