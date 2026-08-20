import type { TangleCondition } from "./predicate";
import { DEFAULT_HEADER_TEMPLATE, DEFAULT_MARKER } from "./header";

export interface TangleSettings {
	/** Auto-tangle on modify. The manual command and the sweep work regardless. */
	autoTangle: boolean;
	/** Debounce for the modify trigger, per file. */
	tangleDebounceMs: number;
	/**
	 * Eligibility, ANDed. Empty means NOTHING tangles — see `matchesConditions`.
	 * Default is the single tag condition; a vault wanting more (for example
	 * `acceptance-status: accepted`) adds it here rather than in code.
	 */
	tangleWhen: TangleCondition[];
	/** Where artifacts land when a note names no destination. Also a permitted root. */
	tangleRoot: string;
	/** Extra roots an explicit `{tangle="…"}` may write into. Rail 2 denies everything else. */
	additionalRoots: string[];
	/** Prepended to every artifact. `{{note}}`, `{{uid}}`, `{{date}}`, `{{comment}}`. */
	headerTemplate: string;
	/** The stable literal rail 1 looks for. Changing it strands existing artifacts (safely). */
	marker: string;
}

export const DEFAULT_TANGLE_SETTINGS: TangleSettings = {
	autoTangle: false,
	tangleDebounceMs: 2000,
	tangleWhen: [{ tag: "tangle" }],
	// Empty by default, which — with rail 2's empty-list-denies rule — means a fresh
	// install writes NOTHING until someone deliberately names a root. Opt in, never out.
	tangleRoot: "",
	additionalRoots: [],
	headerTemplate: DEFAULT_HEADER_TEMPLATE,
	marker: DEFAULT_MARKER,
};
