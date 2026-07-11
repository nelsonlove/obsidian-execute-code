/**
 * Org-babel-style noweb reference expansion.
 *
 * A line consisting of nothing but `<<name>>` (plus optional indentation) is
 * replaced by the code of the block labelled `name`, with every expanded line
 * indented to match the reference. Expansion is recursive; circular
 * references and unknown labels are reported via the `missing` set and left
 * in place.
 */

const NOWEB_REFERENCE = /^([ \t]*)<<([^<>\s]+)>>[ \t]*$/;

export function expandNoweb(code: string, exports: Record<string, string>, missing: Set<string>, stack: string[] = []): string {
	return code.split("\n").map(line => {
		const m = line.match(NOWEB_REFERENCE);
		if (!m) return line;
		const [, indent, name] = m;
		if (!Object.prototype.hasOwnProperty.call(exports, name)) {
			missing.add(name);
			return line;
		}
		if (stack.includes(name)) {
			missing.add(`${name} (circular)`);
			return line;
		}
		const body = exports[name].replace(/\n$/, "");
		const expanded = expandNoweb(body, exports, missing, [...stack, name]);
		return expanded.split("\n").map(l => l.length ? indent + l : l).join("\n");
	}).join("\n");
}
