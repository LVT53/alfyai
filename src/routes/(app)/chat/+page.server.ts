import type { ServerLoad } from "@sveltejs/kit";
import { redirect } from "@sveltejs/kit";

export const load: ServerLoad = async () => {
	throw redirect(302, "/");
};
