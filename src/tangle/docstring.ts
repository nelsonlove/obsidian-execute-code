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

/**
 * Find the configured heading in the note and return its section body — everything
 * below it until the next heading of the same or higher level. First match wins;
 * matching is case-insensitive on the heading text. Returns undefined when the heading
 * is absent or its section holds nothing but blank lines.
 *
 * Fenced code blocks are skipped while scanning: a `# comment` line inside a shell or
 * python block is code, not a heading, and must neither match nor terminate a section.
 */
export function extractDocstring(content: string, heading: string): string | undefined {
	const want = heading.trim().toLowerCase();
	if (!want) return undefined;

	const lines = content.split("\n");
	let fence = "";
	let level = 0;
	const collected: string[] = [];
	let collecting = false;

	for (const line of lines) {
		// Same open/close rules as parseNoteBlocks: an opener may carry an info string,
		// a closer may not.
		const f = /^(\s*)(`{3,}|~{3,})\s*(.*)$/.exec(line);
		if (f) {
			if (!fence) fence = f[2];
			else if (f[2].charAt(0) === fence.charAt(0) && f[3].trim() === "") fence = "";
			if (collecting) collected.push(line);
			continue;
		}
		if (fence) {
			if (collecting) collected.push(line);
			continue;
		}

		const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
		if (h) {
			if (collecting && h[1].length <= level) break;
			if (!collecting && h[2].trim().toLowerCase() === want) {
				collecting = true;
				level = h[1].length;
			}
			continue;
		}
		if (collecting) collected.push(line);
	}

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
