import { json } from "@sveltejs/kit";
import { requireAdmin } from "$lib/server/auth/hooks";
import { getCampaignAssetMetadata } from "$lib/server/services/campaign-assets";
import type { RequestHandler } from "./$types";

/**
 * Metadata for one campaign asset — filename, size, dimensions and, for a
 * crop, the source it was cut from. The slide editor uses it to name the
 * attached screenshot ("atlas-report-desk.webp · 148 KB") and to offer
 * Re-crop on a draft loaded from the server, which only carries crop ids.
 *
 * Additive: the bytes are still served by /api/campaign-assets/[id]/content.
 */
export const GET: RequestHandler = async (event) => {
	requireAdmin(event);

	const asset = await getCampaignAssetMetadata(event.params.id);
	if (!asset) {
		return json({ error: "Campaign asset not found" }, { status: 404 });
	}

	return json({
		asset: {
			id: asset.id,
			assetKind: asset.assetKind,
			variant: asset.variant,
			status: asset.status,
			sourceAssetId: asset.sourceAssetId,
			originalFilename: asset.originalFilename,
			mimeType: asset.mimeType,
			sizeBytes: asset.sizeBytes,
			width: asset.width,
			height: asset.height,
		},
	});
};
