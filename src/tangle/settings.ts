import type { PropertyCondition, TanglePredicate } from "./predicate";
import { DEFAULT_HEADER_TEMPLATE, DEFAULT_MARKER } from "./header";

export interface TangleSettings {
	/** Auto-tangle on modify. The manual command and the sweep work regardless. */
	autoTangle: boolean;
	/** Debounce for the modify trigger, per file. */
	tangleDebounceMs: number;
	/**
	 * Eligibility: any listed tag AND every property condition. Empty predicate means
	 * NOTHING tangles — see `matchesPredicate`.
	 */
	tangleWhen: TanglePredicate;
	/**
	 * The folder artifacts land in when a block names no destination. Bare paths are
	 * vault-relative; `./generated` is relative to each note's own folder. Empty means
	 * only blocks with an explicit destination tangle.
	 */
	defaultDestination: string;
	/**
	 * Folders OUTSIDE the vault that a destination may write into (`~/…` or absolute).
	 * The vault itself is always writable; this list is the only door out of it, and an
	 * empty list keeps that door shut. Rail 2 lives on this.
	 */
	allowedOutsideRoots: string[];
	/** Prepended to every artifact. `{{note}}`, `{{uid}}`, `{{date}}`, `{{comment}}`. */
	headerTemplate: string;
	/** The stable literal rail 1 looks for. Changing it strands existing artifacts (safely). */
	marker: string;
}

export const DEFAULT_TANGLE_SETTINGS: TangleSettings = {
	autoTangle: false,
	tangleDebounceMs: 2000,
	tangleWhen: { tags: ["tangle"], properties: [] },
	// Beside each note, in a `generated` folder — safe (inside the vault) and useful
	// out of the box. Eligibility is still opt-in per note via the tag above.
	defaultDestination: "./generated",
	allowedOutsideRoots: [],
	headerTemplate: DEFAULT_HEADER_TEMPLATE,
	marker: DEFAULT_MARKER,
};

/* ------------------------------------------------------------------------- *
 * Migration from the pre-vault-root settings shape.
 *
 * Old shape: `tangleRoot` (default base AND permitted root), `additionalRoots`
 * (extra permitted roots), and `tangleWhen` as a flat condition array
 * (`{tag}` / `{property, equals?, exists?}`).
 * ------------------------------------------------------------------------- */

interface LegacyCondition {
	tag?: string;
	property?: string;
	equals?: unknown;
	exists?: boolean;
}

function migratePredicate(raw: unknown): TanglePredicate {
	if (Array.isArray(raw)) {
		const tags: string[] = [];
		const properties: PropertyCondition[] = [];
		for (const c of raw as LegacyCondition[]) {
			if (!c || typeof c !== "object") continue;
			if (typeof c.tag === "string" && c.tag.trim()) {
				// Old tag conditions were ANDed; the new tag list is any-of. A config with
				// several tag conditions therefore widens slightly — accepted, since a
				// note carrying one of several curated tags was almost certainly the
				// intent behind such a config anyway.
				tags.push(c.tag.trim());
			} else if (typeof c.property === "string" && c.property.trim()) {
				const key = c.property.trim();
				if (c.exists === false) properties.push({ key, op: "not-exists" });
				else if (c.equals !== undefined) properties.push({ key, op: "equals", value: String(c.equals) });
				else properties.push({ key, op: "exists" });
			}
		}
		return { tags, properties };
	}
	if (raw && typeof raw === "object") {
		const p = raw as Partial<TanglePredicate>;
		return {
			tags: Array.isArray(p.tags) ? p.tags.filter((t): t is string => typeof t === "string") : [],
			properties: Array.isArray(p.properties) ? p.properties.filter((c) => c && typeof c === "object") : [],
		};
	}
	return { tags: [], properties: [] };
}

/** `vault:X` → the bare vault-relative form `X`; other spellings pass through. */
function stripVaultScheme(value: string): string {
	const m = /^vault:(.*)$/i.exec(value.trim());
	return m ? m[1].replace(/^[\\/]+/, "") : value.trim();
}

/** An outside-the-vault spelling is `~…` or absolute; everything else is vault-relative. */
function isOutsideSpelling(value: string): boolean {
	const v = value.trim();
	return v.startsWith("~") || v.startsWith("/") || /^[A-Za-z]:[\\/]/.test(v) || v.startsWith("\\\\");
}

/**
 * Produce a complete, current-shape TangleSettings from whatever was saved — the
 * current shape, the legacy shape, or nothing. Legacy roots that pointed outside the
 * vault keep working by riding along into `allowedOutsideRoots`; vault-internal roots
 * need no grant anymore and are simply dropped from the permission list.
 */
export function migrateTangleSettings(saved: unknown): TangleSettings {
	const raw = (saved && typeof saved === "object" ? saved : {}) as Record<string, unknown>;
	const out: TangleSettings = {
		...DEFAULT_TANGLE_SETTINGS,
		tangleWhen: migratePredicate(raw.tangleWhen ?? DEFAULT_TANGLE_SETTINGS.tangleWhen),
	};

	if (typeof raw.autoTangle === "boolean") out.autoTangle = raw.autoTangle;
	if (typeof raw.tangleDebounceMs === "number") out.tangleDebounceMs = raw.tangleDebounceMs;
	if (typeof raw.headerTemplate === "string") out.headerTemplate = raw.headerTemplate;
	if (typeof raw.marker === "string") out.marker = raw.marker;

	const outside: string[] = Array.isArray(raw.allowedOutsideRoots)
		? (raw.allowedOutsideRoots as unknown[]).filter((r): r is string => typeof r === "string" && !!r.trim())
		: [];

	if (typeof raw.defaultDestination === "string") {
		out.defaultDestination = raw.defaultDestination.trim();
	} else if (typeof raw.tangleRoot === "string") {
		// Legacy: the root doubled as the default base. An empty root meant "tangling
		// disabled"; the closest current meaning is "no default destination".
		const root = stripVaultScheme(raw.tangleRoot);
		out.defaultDestination = root;
		if (root && isOutsideSpelling(root)) outside.push(root);
	}

	if (Array.isArray(raw.additionalRoots))
		for (const r of raw.additionalRoots as unknown[])
			if (typeof r === "string" && r.trim() && isOutsideSpelling(stripVaultScheme(r)))
				outside.push(stripVaultScheme(r));

	out.allowedOutsideRoots = [...new Set(outside)];
	return out;
}
