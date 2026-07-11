import { LanguageId } from "src/main";
import { parseNoteBlocks } from "src/tangle";

/**
 * Cross-block variables, like org-babel's `:var x=block-name`.
 *
 * `{var={x="label"}}` binds `x` to the saved results of the block labelled
 * `label` — the content of the `output` block directly below it. Results are
 * bound as strings; because they're plain text, the producing block can be in
 * a different language than the consumer.
 */

const escapeDoubleQuoted = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");

/** Per-language variable assignment templates */
const FORMATTERS: Partial<Record<string, (name: string, value: string) => string>> = {
	lisp: (name, value) => `(defparameter ${name} "${escapeDoubleQuoted(value)}")`,
	python: (name, value) => `${name} = ${JSON.stringify(value)}`,
	js: (name, value) => `var ${name} = ${JSON.stringify(value)};`,
};

/**
 * Builds the assignment prelude for a block's `var` argument.
 *
 * @param vars Mapping of variable name → producing block's label
 * @param noteContent The note's full markdown
 * @param language The consuming block's canonical language
 * @param missing Collects labels with no saved results, and unsupported languages
 * @returns Source code assigning each variable, or ""
 */
export function buildVarAssignments(vars: Record<string, string>, noteContent: string, language: LanguageId, missing: Set<string>): string {
	const formatter = FORMATTERS[/[^-]*$/.exec(language)[0]];
	if (!formatter) {
		missing.add(`(the var argument isn't supported for ${language})`);
		return "";
	}

	// Collect saved results: an output block directly following a labelled block
	const blocks = parseNoteBlocks(noteContent);
	const results: Record<string, string> = {};
	for (let i = 0; i < blocks.length; i++) {
		if (blocks[i].args.label && blocks[i + 1]?.language === "output")
			results[blocks[i].args.label] = blocks[i + 1].code.replace(/\n$/, "");
	}

	let assignments = "";
	for (const [name, label] of Object.entries(vars)) {
		if (!Object.prototype.hasOwnProperty.call(results, label)) {
			missing.add(`${label} (no saved results — run that block first)`);
			continue;
		}
		assignments += formatter(name, results[label]) + "\n";
	}
	return assignments;
}
