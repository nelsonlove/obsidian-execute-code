import type { TangleCondition } from "./predicate";

/**
 * The text form of the eligibility predicate, as edited in settings.
 *
 * Pure and separate from the settings UI so it can be tested headlessly: this is the
 * parser standing between what a human typed and what the plugin treats as permission
 * to generate executable files, which makes its failure behavior security-relevant.
 */

export function conditionsToText(conditions: TangleCondition[]): string {
	return (conditions ?? [])
		.map((c) => {
			if ("tag" in c) return `tag: ${c.tag}`;
			if (c.equals !== undefined) return `property: ${c.property} = ${String(c.equals)}`;
			if (c.exists === false) return `property: ${c.property} absent`;
			return `property: ${c.property}`;
		})
		.join("\n");
}

/**
 * Parse the text form back to conditions.
 *
 * An unparseable line is DROPPED rather than guessed at. Dropping narrows what tangles
 * (fewer conditions would widen it — the dangerous direction), and the resulting text
 * round-trips visibly, so a typo shows up as a vanished line instead of a silently
 * mis-parsed rule.
 */
export function textToConditions(text: string): TangleCondition[] {
	const out: TangleCondition[] = [];
	for (const raw of (text ?? "").split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;

		const tag = /^tag\s*:\s*(.+)$/i.exec(line);
		if (tag) {
			const value = tag[1].trim();
			if (value) out.push({ tag: value });
			continue;
		}

		const prop = /^prop(?:erty)?\s*:\s*(.+)$/i.exec(line);
		if (!prop) continue;
		const body = prop[1].trim();

		const eq = /^([^=]+?)\s*=\s*(.*)$/.exec(body);
		if (eq) {
			const key = eq[1].trim();
			if (key) out.push({ property: key, equals: coerce(eq[2].trim()) });
			continue;
		}
		const absent = /^(.+?)\s+absent$/i.exec(body);
		if (absent) {
			out.push({ property: absent[1].trim(), exists: false });
			continue;
		}
		out.push({ property: body, exists: true });
	}
	return out;
}

function coerce(value: string): unknown {
	const v = value.replace(/^['"]|['"]$/g, "");
	if (/^true$/i.test(v)) return true;
	if (/^false$/i.test(v)) return false;
	if (v !== "" && Number.isFinite(Number(v))) return Number(v);
	return v;
}
