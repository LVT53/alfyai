import { error } from "@sveltejs/kit";

// Auth seam for JSON API routes (`/api/**`).
//
// requireAuth (src/lib/server/auth/hooks.ts) 302-redirects to /login when the
// caller is unauthenticated. That is correct for page loads a browser follows,
// but WRONG for a `fetch` to a JSON endpoint: the client gets an opaque
// redirect to an HTML login page instead of a machine-readable 401.
//
// requireApiUser is the API sibling: same "assert there is a user" job, but on
// failure it throws a 401 (SvelteKit renders a thrown `error()` from a +server
// endpoint as a JSON body, never a redirect). Returns the authenticated user so
// the caller can read `.id` without re-narrowing `event.locals.user`.
export function requireApiUser<T extends { locals: App.Locals }>(
	event: T,
): NonNullable<App.Locals["user"]> {
	const user = event.locals.user;
	if (!user) {
		throw error(401, "Unauthorized");
	}
	return user;
}
