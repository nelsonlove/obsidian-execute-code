import { App, Component, MarkdownRenderer, MarkdownView, Notice, Plugin, TFile, } from 'obsidian';

import type { ExecutorSettings } from "./settings/Settings";
import { DEFAULT_SETTINGS } from "./settings/Settings";
import { migrateTangleSettings } from "./tangle/settings";
import { SettingsTab } from "./settings/SettingsTab";
import { applyLatexBodyClasses } from "./transforms/LatexTransformer"

import ExecutorContainer from './ExecutorContainer';
import ExecutorManagerView, {
	EXECUTOR_MANAGER_OPEN_VIEW_COMMAND_ID,
	EXECUTOR_MANAGER_VIEW_ID
} from './ExecutorManagerView';

import runAllCodeBlocks from './runAllCodeBlocks';
import runBlockUnderCursor from './runBlockUnderCursor';
import tangleCurrentNote, { isEligible, summarize, tangleAll, tangleNote } from './tangle';
import { ReleaseNoteModel } from "./ReleaseNoteModal";
import * as runButton from './RunButton';

export const languageAliases = ["javascript", "typescript", "bash", "csharp", "wolfram", "nb", "wl", "hs", "py", "tex"] as const;
export const canonicalLanguages = ["js", "ts", "cs", "latex", "lean", "lua", "python", "cpp", "prolog", "shell", "groovy", "r",
	"go", "rust", "java", "powershell", "kotlin", "mathematica", "haskell", "scala", "swift", "racket", "fsharp", "c", "dart",
	"ruby", "batch", "sql", "octave", "maxima", "applescript", "zig", "ocaml", "php", "lisp", "obsidianjs"] as const;
export const supportedLanguages = [...languageAliases, ...canonicalLanguages] as const;
export type LanguageId = typeof canonicalLanguages[number];

export interface PluginContext {
	app: App;
	settings: ExecutorSettings;
	executors: ExecutorContainer;
}

export default class ExecuteCodePlugin extends Plugin {
	settings: ExecutorSettings;
	executors: ExecutorContainer;
	/** Per-file debounce timers for the auto-tangle trigger (see wireAutoTangle). */
	private tangleTimers = new Map<string, ReturnType<typeof setTimeout>>();

	/**
	 * Preparations for the plugin (adding buttons, html elements and event listeners).
	 */
	async onload() {
		await this.loadSettings();
		this.addSettingTab(new SettingsTab(this.app, this));

		this.executors = new ExecutorContainer(this);

		const context: PluginContext = {
			app: this.app,
			settings: this.settings,
			executors: this.executors,
		}
		runButton.addInOpenFiles(context);
		this.registerMarkdownPostProcessor((element, _context) => {
			runButton.addToAllCodeBlocks(element, _context.sourcePath, this.app.workspace.getActiveViewOfType(MarkdownView), context, _context);
		});

		// live preview renderers
		supportedLanguages.forEach(l => {
			console.debug(`Registering renderer for ${l}.`)
			this.registerMarkdownCodeBlockProcessor(`run-${l}`, async (src, el, _ctx) => {
				await MarkdownRenderer.render(this.app, '```' + l + '\n' + src + (src.endsWith('\n') ? '' : '\n') + '```', el, _ctx.sourcePath, new Component());
			});
		});

		//executor manager

		this.registerView(
			EXECUTOR_MANAGER_VIEW_ID, (leaf) => new ExecutorManagerView(leaf, this.executors)
		);
		this.addCommand({
			id: EXECUTOR_MANAGER_OPEN_VIEW_COMMAND_ID,
			name: "Open Code Runtime Management",
			callback: () => ExecutorManagerView.activate(this.app.workspace)
		});

		this.addCommand({
			id: "run-all-code-blocks-in-file",
			name: "Run all Code Blocks in Current File",
			callback: () => runAllCodeBlocks(this.app.workspace)
		})

		this.addCommand({
			id: "tangle-current-note",
			name: "Tangle code blocks in current note",
			callback: () => tangleCurrentNote(this.app, this.settings.tangle)
		})

		this.addCommand({
			id: "tangle-all-notes",
			name: "Tangle all eligible notes (and report orphans)",
			callback: async () => {
				const { reports, orphans } = await tangleAll(this.app, this.settings.tangle);
				const written = reports.reduce(
					(n, r) => n + r.outcomes.filter(o => o.status === "written").length, 0);
				const problems = reports.flatMap(r => [
					...r.refused.map(x => `${x.destination}: ${x.reason}`),
					...r.outcomes.filter(o => o.status === "error" || o.status === "refused-foreign")
						.map(o => `${o.destination}: ${o.detail}`),
				]);
				let msg = `Execute Code: tangled ${written} file(s) from ${reports.length} note(s).`;
				// Orphans are REPORTED, never removed (rail 3) — deleting an artifact whose
				// note stopped tangling is a human decision, not a sweep's.
				if (orphans.length) msg += ` ${orphans.length} orphaned artifact(s) left in place: ${orphans.join(", ")}.`;
				if (problems.length) msg += ` Refused: ${problems.join("; ")}.`;
				new Notice(msg, problems.length || orphans.length ? 15000 : 6000);
				console.info("Execute Code: tangle sweep", { written, notes: reports.length, orphans, problems });
			}
		})

		this.addCommand({
			id: "run-block-under-cursor",
			name: "Run code block under cursor",
			editorCallback: (editor, ctx) => {
				if (ctx instanceof MarkdownView)
					runBlockUnderCursor(context, editor, ctx);
			}
		})

		if (!this.settings.releaseNote2_1_0wasShowed) {
			this.app.workspace.onLayoutReady(() => {
				new ReleaseNoteModel(this.app).open();
			})

			// Set to true to prevent the release note from showing again
			this.settings.releaseNote2_1_0wasShowed = true;
			this.saveSettings();
		}

		applyLatexBodyClasses(this.app, this.settings);
		this.wireAutoTangle();
	}

	/**
	 * Auto-tangle on modify and on create, debounced PER FILE.
	 *
	 * Per file rather than globally on purpose: one shared timer means editing note B
	 * cancels note A's pending tangle, and A silently never lands.
	 *
	 * The two events are NOT symmetric, and both asymmetries are load-bearing:
	 *
	 *  - Obsidian fires `create` for EVERY file while it builds its initial index, so an
	 *    ungated create handler would tangle the entire vault on every launch. It is
	 *    gated on `onLayoutReady`, which runs after that pass. (`onLayoutReady` takes a
	 *    plain callback and returns no EventRef, so it cannot be unregistered — setting a
	 *    boolean is safe to leave dangling, which is why the flag is all it does.)
	 *
	 *  - Eligibility is read from the metadata cache, which is NOT yet populated when
	 *    `create` fires for a brand-new note. So the create path skips the pre-check and
	 *    lets the debounced `tangleNote` decide — it re-checks internally and returns
	 *    `eligible: false` harmlessly. Checking early here would make every new note fail
	 *    the test and silently never tangle, which is exactly the bug this handler exists
	 *    to fix.
	 */
	private wireAutoTangle() {
		let indexReady = false;
		this.app.workspace.onLayoutReady(() => { indexReady = true; });

		const schedule = (file: unknown, fromCreate: boolean) => {
			if (!this.settings.tangle.autoTangle) return;
			if (fromCreate && !indexReady) return;
			if (!(file instanceof TFile) || file.extension !== "md") return;
			// On modify the cache is warm, so pre-checking avoids arming a timer for every
			// keystroke in every note. On create it is not — see the header.
			if (!fromCreate && !isEligible(this.app, file, this.settings.tangle)) return;

			const pending = this.tangleTimers.get(file.path);
			if (pending) clearTimeout(pending);
			this.tangleTimers.set(file.path, setTimeout(async () => {
				this.tangleTimers.delete(file.path);
				try {
					const report = await tangleNote(this.app, file, this.settings.tangle);
					const problems = report.refused.length ||
						report.outcomes.some(o => o.status === "error" || o.status === "refused-foreign");
					// Quiet on success — an automatic trigger that notifies on every save is
					// noise. Anything REFUSED is surfaced, because a silent refusal reads as
					// a successful tangle and the stale artifact keeps being required.
					if (problems) new Notice(`Execute Code: ${summarize(report)}.`, 12000);
					else if (report.outcomes.some(o => o.status === "written"))
						console.debug(`Execute Code: auto-tangled ${file.path} — ${summarize(report)}`);
				} catch (e) {
					new Notice(`Execute Code: auto-tangle of '${file.basename}' failed: ${e.message}`, 12000);
				}
			}, Math.max(250, this.settings.tangle.tangleDebounceMs)));
		};

		this.registerEvent(this.app.vault.on("modify", (file) => schedule(file, false)));
		this.registerEvent(this.app.vault.on("create", (file) => schedule(file, true)));

		// A pending tangle must not fire into a torn-down plugin.
		this.register(() => {
			for (const t of this.tangleTimers.values()) clearTimeout(t);
			this.tangleTimers.clear();
		});
	}

	/**
	 *  Remove all generated html elements (run & clear buttons, output elements) when the plugin is disabled.
	 */
	onunload() {
		document
			.querySelectorAll("pre > code")
			.forEach((codeBlock: HTMLElement) => {
				const pre = codeBlock.parentElement as HTMLPreElement;
				const parent = pre.parentElement as HTMLDivElement;

				if (parent.hasClass(runButton.codeBlockHasButtonClass)) {
					parent.removeClass(runButton.codeBlockHasButtonClass);
				}
			});

		document
			.querySelectorAll("." + runButton.buttonClass)
			.forEach((button: HTMLButtonElement) => button.remove());

		document
			.querySelectorAll("." + runButton.disabledClass)
			.forEach((button: HTMLButtonElement) => button.remove());

		document
			.querySelectorAll(".clear-button")
			.forEach((button: HTMLButtonElement) => button.remove());

		document
			.querySelectorAll(".language-output")
			.forEach((out: HTMLElement) => out.remove());

		for (const executor of this.executors) {
			executor.stop().then(_ => { /* do nothing */
			});
		}

		console.log("Unloaded plugin: Execute Code");
	}

	/**
	 * Loads the settings for this plugin from the corresponding save file and stores them in {@link settings}.
	 */
	async loadSettings() {
		const saved = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
		// `tangle` is the one nested settings object, so the shallow merge above would
		// replace it wholesale — a config saved by an older version would then be missing
		// every key added since, including the rails' own settings (an absent `marker`
		// disables the overwrite check). Migration fills defaults AND converts the legacy
		// tangle-root shape, so both jobs live in one tested function.
		this.settings.tangle = migrateTangleSettings(saved?.tangle);
		if (process.platform !== "win32") {
			this.settings.wslMode = false;
		}
	}

	/**
	 * Saves the settings in {@link settings} to the corresponding save file.
	 */
	async saveSettings() {
		await this.saveData(this.settings);
	}
}