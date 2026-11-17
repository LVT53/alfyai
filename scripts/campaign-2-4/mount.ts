// What `render.ts` loads into its page on the dev server (`vite.config.js` here):
// it draws one campaign picture, or one card of the campaign window, with the
// app's own CSS, fonts, icons and words.
//
// Nothing in the app imports this file; `render.ts` asks the browser for it.

import "../../src/app.css";
import { mount } from "svelte";
import type { Campaign, CampaignLocale } from "$lib/client/api/campaigns";
import CampaignModal from "$lib/components/campaigns/CampaignModal.svelte";
import { uiLanguage } from "$lib/stores/settings";
import { PICTURES } from "./pictures";
import { PICTURE_WIDTH, type PictureName, type Variant } from "./sizes";

function drawPicture(
	target: HTMLElement,
	name: PictureName,
	variant: Variant,
	language: CampaignLocale,
) {
	uiLanguage.set(language);
	target.style.width = `${PICTURE_WIDTH[variant]}px`;
	mount(PICTURES[name], { target, props: { variant } });
}

function drawCard(
	target: HTMLElement,
	campaign: Campaign,
	slideIndex: number,
	language: CampaignLocale,
) {
	uiLanguage.set(language);
	mount(CampaignModal, {
		target,
		props: { campaign, locale: language, slideIndex },
	});
}

declare global {
	interface Window {
		campaignPictures: {
			drawPicture: typeof drawPicture;
			drawCard: typeof drawCard;
		};
	}
}

window.campaignPictures = { drawPicture, drawCard };
