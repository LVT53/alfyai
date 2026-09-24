import { redirect } from "@sveltejs/kit";
import { getProjectPageData } from "$lib/server/services/projects";
import type { PageServerLoad } from "./$types";

/**
 * How many of the project's chats the page lists. The heading's count comes
 * from the service's own `chatCount`, so a capped list still tells the truth
 * about how many there are — the cap only decides how far the page scrolls.
 */
const PROJECT_PAGE_CHAT_LIMIT = 20;

/**
 * The project page's data: the project, its chats, and the two numbers the
 * heading needs. Everything else the page renders (the composer's own limits,
 * the user, the personality) arrives from the `(app)` layout.
 *
 * A project that is not the user's is a redirect home rather than a 403 or a
 * 404 page: another user's project must be indistinguishable from one that
 * does not exist, so nothing here logs the id or names the project.
 */
export const load: PageServerLoad = async (event) => {
	const user = event.locals.user;
	if (!user) {
		throw redirect(302, "/login");
	}

	const pageData = await getProjectPageData({
		userId: user.id,
		projectId: event.params.projectId,
		limit: PROJECT_PAGE_CHAT_LIMIT,
	});
	if (!pageData) {
		throw redirect(302, "/");
	}

	return pageData;
};
