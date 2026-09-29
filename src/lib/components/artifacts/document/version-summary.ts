/**
 * A version's summary line, in the reader's language (Wave 2.5 polish G1-B;
 * rd/review-2-5.md:256-260). The server writes a few FIXED English summaries
 * of its own — the vocabulary in `$lib/shared/artifacts/version-summaries` —
 * which are translated here; an Alfy patch's own label is free-form content
 * and is shown exactly as stored. A restore names the version it came from
 * (`Restored v3`); a restore written before that wrapped whatever the restored
 * version said (`restored <summary>`), so it is translated layer by layer.
 */
import type { I18nKey } from "$lib/i18n";
import {
	parseRestoredVersion,
	VERSION_SUMMARY,
} from "$lib/shared/artifacts/version-summaries";

type Translate = (
	key: I18nKey,
	params?: Record<string, string | number>,
) => string;

const FIXED_SUMMARY_KEYS: Readonly<Record<string, I18nKey>> = {
	[VERSION_SUMMARY.edited]: "artifacts.document.versions.summaryEdited",
	[VERSION_SUMMARY.undidAlfyChange]:
		"artifacts.document.versions.summaryUndidAlfyChange",
	[VERSION_SUMMARY.alfyFirstDraft]:
		"artifacts.document.versions.summaryFirstDraft",
	[VERSION_SUMMARY.savedAsCopy]:
		"artifacts.document.versions.summarySavedAsCopy",
};

export function localizeVersionSummary(
	summary: string,
	translate: Translate,
): string {
	if (Object.hasOwn(FIXED_SUMMARY_KEYS, summary)) {
		return translate(FIXED_SUMMARY_KEYS[summary]);
	}
	const restoredFrom = parseRestoredVersion(summary);
	if (restoredFrom !== null) {
		return translate("artifacts.document.versions.summaryRestoredFrom", {
			n: restoredFrom,
		});
	}
	if (summary.startsWith(VERSION_SUMMARY.restoredPrefix)) {
		return translate("artifacts.document.versions.summaryRestored", {
			summary: localizeVersionSummary(
				summary.slice(VERSION_SUMMARY.restoredPrefix.length),
				translate,
			),
		});
	}
	return summary;
}
