/**
 * Eligibility — "may this note tangle?" — as DATA, not as built-in modes.
 *
 * The plugin evaluates a predicate and tangles only when it holds. It knows nothing
 * about what the conditions MEAN: `acceptance-status equals accepted` is just a
 * frontmatter comparison here, and the fact that some other plugin makes that field
 * unforgeable is the vault's business, not this module's. That is the whole point — a
 * general tangler must not hardcode one vault's governance model.
 */

/** The operators a property condition can use. Mirrors the set Bases filters offer. */
export type PropertyOp =
	| "equals"
	| "not-equals"
	| "contains"
	| "not-contains"
	| "starts-with"
	| "ends-with"
	| "exists"
	| "not-exists";

export interface PropertyCondition {
	/** Frontmatter key. */
	key: string;
	op: PropertyOp;
	/** Compared value, as typed. Ignored by `exists` / `not-exists`. */
	value?: string;
}

/**
 * The whole predicate: a note is eligible when it carries AT LEAST ONE of the listed
 * tags (any-of) AND satisfies EVERY property condition (all-of). A section left empty
 * imposes nothing — but if BOTH are empty, nothing tangles (see `matchesPredicate`).
 */
export interface TanglePredicate {
	tags: string[];
	properties: PropertyCondition[];
}

/** `#Foo/Bar` and `foo/bar` are the same tag. Obsidian tags are case-insensitive. */
export function normalizeTag(tag: string): string {
	return tag.trim().replace(/^#+/, "").toLowerCase();
}

export interface NoteFacts {
	/** Every tag on the note — frontmatter and inline — WITHOUT a leading `#`. */
	tags: string[];
	frontmatter: Record<string, unknown>;
}

/**
 * The configured value is typed as text; the frontmatter value is whatever YAML gave
 * us. `equals` coerces the text toward the actual value's type (so `3` matches the
 * number 3 and `true` matches the boolean), and string comparison is case-insensitive.
 */
function equalsValue(actual: unknown, expected: string): boolean {
	if (actual === undefined || actual === null) return false;
	if (Array.isArray(actual)) return actual.some((v) => equalsValue(v, expected));
	const want = expected.trim().replace(/^['"]|['"]$/g, "");
	if (typeof actual === "boolean") return /^(true|false)$/i.test(want) && actual === /^true$/i.test(want);
	if (typeof actual === "number") return Number.isFinite(Number(want)) && actual === Number(want);
	if (typeof actual === "string") return actual.trim().toLowerCase() === want.toLowerCase();
	return false;
}

/** Substring-family comparison: everything is compared as lowercase text. */
function textMatches(actual: unknown, expected: string, test: (a: string, e: string) => boolean): boolean {
	if (actual === undefined || actual === null) return false;
	if (Array.isArray(actual)) return actual.some((v) => textMatches(v, expected, test));
	return test(String(actual).trim().toLowerCase(), expected.trim().toLowerCase());
}

export function propertyConditionHolds(condition: PropertyCondition, facts: NoteFacts): boolean {
	const key = condition.key?.trim();
	// A half-built row (no key yet) must FAIL, not vanish: vanishing would widen what
	// tangles mid-edit, which is the dangerous direction.
	if (!key) return false;
	const actual = facts.frontmatter?.[key];
	const present = actual !== undefined && actual !== null;
	const value = condition.value ?? "";

	switch (condition.op) {
		case "exists":
			return present;
		case "not-exists":
			return !present;
		case "equals":
			return equalsValue(actual, value);
		// Absence satisfies the negative operators: a note WITHOUT the property does not
		// carry the excluded value.
		case "not-equals":
			return !equalsValue(actual, value);
		case "contains":
			return textMatches(actual, value, (a, e) => e !== "" && a.includes(e));
		case "not-contains":
			return !textMatches(actual, value, (a, e) => e !== "" && a.includes(e));
		case "starts-with":
			return textMatches(actual, value, (a, e) => e !== "" && a.startsWith(e));
		case "ends-with":
			return textMatches(actual, value, (a, e) => e !== "" && a.endsWith(e));
		default:
			// An operator this build does not know (config written by a newer version)
			// fails closed rather than matching everything.
			return false;
	}
}

/**
 * Evaluate the whole predicate.
 *
 * FAILS CLOSED on an empty predicate. "No conditions" reads naturally as "no
 * constraints", which would mean EVERY note tangles — turning a misconfiguration into a
 * vault-wide code-generation event. There is no legitimate "tangle everything" setting,
 * so an empty predicate means "tangle nothing".
 */
export function matchesPredicate(predicate: TanglePredicate | undefined, facts: NoteFacts): boolean {
	if (!predicate) return false;
	const tags = (predicate.tags ?? []).map(normalizeTag).filter(Boolean);
	const properties = (predicate.properties ?? []).filter((c) => c && typeof c === "object");
	if (tags.length === 0 && properties.length === 0) return false;

	if (tags.length > 0) {
		const noteTags = facts.tags.map(normalizeTag);
		if (!tags.some((want) => noteTags.includes(want))) return false;
	}
	return properties.every((c) => propertyConditionHolds(c, facts));
}
