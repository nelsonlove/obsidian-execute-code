import { App, Notice, TFile, getAllTags } from "obsidian";
import * as path from "path";
import * as fs from "fs";
import { matchesConditions, NoteFacts } from "./predicate";
import { commentTokenFor, ResolveContext } from "./resolve";
import { looksGenerated, renderHeader } from "./header";
import {
	allowedRoots,
	planTangle,
	summarize,
	TangleReport,
	walkFiles,
	writeArtifact,
} from "./core";
import type { TangleSettings } from "./settings";

export * from "./predicate";
export * from "./resolve";
export * from "./header";
export * from "./core";

/**
 * The Obsidian-facing half of tangling. Everything that DECIDES anything lives in
 * `core.ts` and is tested headlessly; this file only reads the vault and reports.
 */

function resolveContext(app: App, note: TFile): ResolveContext {
	// @ts-ignore — getBasePath exists on the desktop FileSystemAdapter
	const vaultBase: string = app.vault.adapter.getBasePath();
	return { vaultBase, noteFolder: note.parent?.path ?? "" };
}

export function noteFacts(app: App, note: TFile): NoteFacts {
	const cache = app.metadataCache.getFileCache(note);
	return {
		tags: (getAllTags(cache) ?? []).map((t) => t.replace(/^#/, "")),
		frontmatter: (cache?.frontmatter as Record<string, unknown>) ?? {},
	};
}

export function isEligible(app: App, note: TFile, settings: TangleSettings): boolean {
	return matchesConditions(settings.tangleWhen, noteFacts(app, note));
}

/**
 * Tangle one note. Returns a report rather than notifying, so the automatic trigger can
 * stay quiet while the manual command speaks.
 */
export async function tangleNote(app: App, note: TFile, settings: TangleSettings): Promise<TangleReport> {
	const facts = noteFacts(app, note);
	if (!matchesConditions(settings.tangleWhen, facts))
		return { note: note.path, eligible: false, outcomes: [], refused: [], missingRefs: [] };

	const content = await app.vault.cachedRead(note);
	const plan = planTangle({
		content,
		noteBasename: note.basename,
		ctx: resolveContext(app, note),
		settings,
	});

	const date = new Date().toISOString();
	const uid = typeof facts.frontmatter.uid === "string" ? facts.frontmatter.uid : undefined;
	const outcomes = plan.artifacts.map((a) => {
		const header = renderHeader(settings.headerTemplate, {
			note: note.path,
			uid,
			date,
			comment: commentTokenFor(a.language),
		});
		return writeArtifact(a.destination, header, a.chunks.join("\n"), settings.marker);
	});

	return { note: note.path, eligible: true, outcomes, refused: plan.refused, missingRefs: plan.missingRefs };
}

/** Manual command — reports every outcome, including "this note is not eligible". */
export default async function tangleCurrentNote(app: App, settings: TangleSettings) {
	const note = app.workspace.getActiveFile();
	if (!note) {
		new Notice("Execute Code: no active note to tangle.");
		return;
	}
	const report = await tangleNote(app, note, settings);
	if (!report.eligible) {
		new Notice(
			`Execute Code: '${note.basename}' does not meet the tangle conditions, so nothing was written.`,
			8000,
		);
		return;
	}
	if (!report.outcomes.length && !report.refused.length) {
		new Notice(`Execute Code: no tangleable code blocks in '${note.basename}'.`, 6000);
		return;
	}
	const problems =
		report.refused.length ||
		report.outcomes.some((o) => o.status === "error" || o.status === "refused-foreign");
	new Notice(`Execute Code: ${summarize(report)}.`, problems ? 12000 : 5000);
}

export interface SweepReport {
	reports: TangleReport[];
	/** Marker-carrying files under the roots that this sweep did not write. */
	orphans: string[];
}

/**
 * "Tangle all" — for first runs and recovery, and the only place orphans are found.
 *
 * RAIL 3: orphans are REPORTED, never removed. An artifact whose note stopped tangling
 * is still a file something may be loading; deleting it is a human act, and a sweep
 * that quietly removed files would be the one operation here that loses work.
 *
 * Orphans are found by SET DIFFERENCE — every marker-carrying file under the roots that
 * this sweep did not write — rather than by parsing the source note back out of the
 * header. That keeps the check working no matter how the header template is customized.
 */
export async function tangleAll(app: App, settings: TangleSettings): Promise<SweepReport> {
	const reports: TangleReport[] = [];
	const written = new Set<string>();
	for (const file of app.vault.getMarkdownFiles()) {
		if (!isEligible(app, file, settings)) continue;
		const report = await tangleNote(app, file, settings);
		reports.push(report);
		for (const o of report.outcomes)
			if (o.status === "written" || o.status === "unchanged") written.add(path.resolve(o.destination));
	}

	const orphans: string[] = [];
	const ctxForRoots: ResolveContext = {
		// @ts-ignore — getBasePath exists on the desktop FileSystemAdapter
		vaultBase: app.vault.adapter.getBasePath(),
		noteFolder: "",
	};
	for (const root of allowedRoots(settings, ctxForRoots)) {
		for (const file of walkFiles(root)) {
			if (written.has(path.resolve(file))) continue;
			try {
				if (looksGenerated(fs.readFileSync(file, "utf8"), settings.marker)) orphans.push(file);
			} catch {
				/* an unreadable file is not our business */
			}
		}
	}
	return { reports, orphans };
}
