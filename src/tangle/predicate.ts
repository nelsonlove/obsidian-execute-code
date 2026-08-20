/**
 * Eligibility — "may this note tangle?" — as DATA, not as built-in modes.
 *
 * The plugin evaluates a list of conditions and tangles only when every one holds.
 * It knows nothing about what the conditions MEAN: `acceptance-status: accepted`
 * is just a frontmatter comparison here, and the fact that some other plugin makes
 * that field unforgeable is the vault's business, not this module's. That is the
 * whole point — a general tangler must not hardcode one vault's governance model.
 */

export type TangleCondition =
	/** The note carries this tag (with or without a leading `#`; nested tags match exactly). */
	| { tag: string }
	/** Frontmatter test: `equals` compares the value, `exists` only asserts presence. */
	| { property: string; equals?: unknown; exists?: boolean };

export interface NoteFacts {
	/** Every tag on the note — frontmatter and inline — WITHOUT a leading `#`. */
	tags: string[];
	frontmatter: Record<string, unknown>;
}

/** `#Foo/Bar` and `foo/bar` are the same tag. Obsidian tags are case-insensitive. */
export function normalizeTag(tag: string): string {
	return tag.trim().replace(/^#+/, "").toLowerCase();
}

/**
 * Compare a frontmatter value to a configured one.
 *
 * Loose on SHAPE (a single value matches a one-element list, because YAML authors
 * write both for the same intent) and loose on string case, but never loose about
 * absence: `undefined` and `null` match nothing, so a missing property can never
 * satisfy an `equals` condition.
 */
function valueMatches(actual: unknown, expected: unknown): boolean {
	if (actual === undefined || actual === null) return false;
	if (Array.isArray(actual)) return actual.some((v) => valueMatches(v, expected));
	if (typeof actual === "string" && typeof expected === "string")
		return actual.trim().toLowerCase() === expected.trim().toLowerCase();
	return actual === expected;
}

export function conditionHolds(condition: TangleCondition, facts: NoteFacts): boolean {
	if ("tag" in condition) {
		const want = normalizeTag(condition.tag);
		if (!want) return false; // an empty tag condition matches nothing, never everything
		return facts.tags.some((t) => normalizeTag(t) === want);
	}
	const key = condition.property?.trim();
	if (!key) return false;
	const actual = facts.frontmatter?.[key];
	if (condition.exists !== undefined)
		return condition.exists ? actual !== undefined && actual !== null : actual === undefined || actual === null;
	if (condition.equals !== undefined) return valueMatches(actual, condition.equals);
	// A bare {property} with neither `equals` nor `exists` reads as "must be present".
	return actual !== undefined && actual !== null;
}

/**
 * Every condition must hold (AND).
 *
 * FAILS CLOSED on an empty list. An empty predicate reads naturally as "no
 * constraints", which for a vacuous AND would mean EVERY note tangles — turning a
 * misconfiguration into a vault-wide code-generation event. There is no legitimate
 * "tangle everything" setting, so the empty list means "tangle nothing".
 */
export function matchesConditions(conditions: TangleCondition[], facts: NoteFacts): boolean {
	if (!conditions || conditions.length === 0) return false;
	return conditions.every((c) => conditionHolds(c, facts));
}
