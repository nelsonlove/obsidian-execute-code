import { AbstractInputSuggest, App } from "obsidian";

/**
 * Type-ahead over a fixed string source, for the tangle settings — tag names and
 * frontmatter keys. Thin on purpose: the interesting part is the two source functions
 * below, which read what actually exists in the vault instead of asking the user to
 * remember it.
 */
export class StringSuggest extends AbstractInputSuggest<string> {
	constructor(
		app: App,
		private readonly el: HTMLInputElement,
		private readonly source: () => string[],
	) {
		super(app, el);
	}

	getSuggestions(query: string): string[] {
		const q = query.toLowerCase();
		return this.source().filter((s) => s.toLowerCase().includes(q));
	}

	renderSuggestion(value: string, el: HTMLElement): void {
		el.setText(value);
	}

	selectSuggestion(value: string): void {
		this.setValue(value);
		// `setValue` writes the DOM value without firing events, so the TextComponent's
		// onChange — where the setting is saved — would never see the pick without this.
		this.el.trigger("input");
		this.close();
	}
}

/** Every tag in the vault, without the leading `#`. */
export function vaultTags(app: App): string[] {
	// `getTags` exists on the desktop metadata cache but is not in the public typings.
	const cache = app.metadataCache as unknown as { getTags?: () => Record<string, number> };
	return Object.keys(cache.getTags?.() ?? {})
		.map((t) => t.replace(/^#/, ""))
		.sort((a, b) => a.localeCompare(b));
}

/** Every frontmatter key used anywhere in the vault. */
export function vaultPropertyKeys(app: App): string[] {
	const keys = new Set<string>();
	for (const f of app.vault.getMarkdownFiles()) {
		const fm = app.metadataCache.getFileCache(f)?.frontmatter;
		if (fm) for (const k of Object.keys(fm)) keys.add(k);
	}
	return [...keys].sort((a, b) => a.localeCompare(b));
}
