/**
 * The docstring — prose from the note, rendered as a comment block below the
 * generated-file header.
 *
 * Pure string functions, no `obsidian` import, same reasoning as the rest of the
 * decision layer: what ends up in an artifact must be testable without a vault.
 *
 * The rendered docstring is emitted as part of the artifact BODY, never the header.
 * That placement is load-bearing: the unchanged-check strips only the header (up to
 * the first blank line), so a docstring edit changes the compared body and re-tangles
 * the file. Rendered into the header instead, a docstring edit would be invisible and
 * the artifact would go stale.
 */

/** Line range of the docstring section: `[start, end)` in split-line indices. */
export interface DocstringRange {
	/** First line AFTER the matched heading. */
	start: number;
	/** Exclusive end — the terminating heading's line, or one past the last line. */
	end: number;
}

/**
 * Locate the configured heading and the extent of its section — everything below it
 * until the next heading of the same or higher level. First match wins; matching is
 * case-insensitive on the heading text.
 *
 * Fenced code blocks are skipped while scanning: a `# comment` line inside a shell or
 * python block is code, not a heading, and must neither match nor terminate a section.
 * The range is shared by two consumers that MUST agree on it — extraction (what the
 * docstring says) and the tangle plan (which fences are examples, not code) — which is
 * why it exists as its own function rather than being folded into either.
 */
export function docstringRange(content: string, heading: string): DocstringRange | undefined {
	const want = heading.trim().toLowerCase();
	if (!want) return undefined;

	const lines = content.split("\n");
	let fence = "";
	let level = 0;
	let start = -1;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		// Same open/close rules as parseNoteBlocks: an opener may carry an info string,
		// a closer may not.
		const f = /^(\s*)(`{3,}|~{3,})\s*(.*)$/.exec(line);
		if (f) {
			if (!fence) fence = f[2];
			else if (f[2].charAt(0) === fence.charAt(0) && f[3].trim() === "") fence = "";
			continue;
		}
		if (fence) continue;

		const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
		if (!h) continue;
		if (start !== -1) {
			if (h[1].length <= level) return { start, end: i };
			continue; // a DEEPER heading is part of the section, not its end
		}
		if (h[2].trim().toLowerCase() === want) {
			start = i + 1;
			level = h[1].length;
		}
	}
	return start === -1 ? undefined : { start, end: lines.length };
}

/**
 * The docstring text: the section's lines verbatim — sub-headings included, they are
 * structure the author wrote — trimmed of blank edges. Undefined when the heading is
 * absent or its section holds nothing but blank lines.
 */
export function extractDocstring(content: string, heading: string): string | undefined {
	const range = docstringRange(content, heading);
	if (!range) return undefined;
	const collected = content.split("\n").slice(range.start, range.end);
	while (collected.length && !collected[0].trim()) collected.shift();
	while (collected.length && !collected[collected.length - 1].trim()) collected.pop();
	return collected.length ? collected.join("\n") : undefined;
}

/**
 * Comment-wrap the docstring, one token per line. Blank lines get the bare token so
 * the docstring reads as one uninterrupted block — an EMPTY line inside it would be
 * mistaken for the header/body boundary by eyes, and by any tool that copies our own
 * first-blank-line convention.
 */
export function renderDocstring(text: string, commentToken: string): string {
	return text
		.split("\n")
		.map((line) => (line.trim() ? `${commentToken} ${line}` : commentToken))
		.join("\n") + "\n";
}
