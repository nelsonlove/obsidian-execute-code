import { Editor, MarkdownView, Notice } from "obsidian";
import type { PluginContext } from "./main";
import { CodeBlockContext, handleExecution } from "./RunButton";
import { Outputter } from "./output/Outputter";
import { getLanguageAlias } from "./transforms/TransformCode";

/**
 * Runs the fenced code block containing the editor cursor (like org-babel's
 * C-c C-c) and saves its output into the note below the block. Works entirely
 * from the editor state — no rendered run button is needed — so it functions
 * in source mode and live preview, even with the cursor inside the block.
 */
export default async function runBlockUnderCursor(plugin: PluginContext, editor: Editor, view: MarkdownView) {
	if (!plugin.settings.persistentOuput) {
		new Notice("Execute Code: \"Run code block under cursor\" writes its output into the note — enable Persistent Output in the plugin settings to use it.");
		return;
	}

	const cursorLine = editor.getCursor().line;

	// Track fence state from the top of the note to the cursor to find the
	// block the cursor is inside (a fence line while a block is open closes
	// it, except on the cursor's own line, which still counts as inside).
	let openLine = -1;
	let info = "";
	for (let i = 0; i <= cursorLine; i++) {
		const m = editor.getLine(i).match(/^\s*(`{3,}|~{3,})\s*(.*)$/);
		if (!m) continue;
		if (openLine === -1) {
			openLine = i;
			info = m[2].trim();
		} else if (i < cursorLine) {
			openLine = -1;
			info = "";
		}
	}
	if (openLine === -1) {
		new Notice("Execute Code: no code block under the cursor.");
		return;
	}

	// Find the closing fence
	let endLine = -1;
	for (let i = Math.max(cursorLine, openLine) + 1; i < editor.lineCount(); i++) {
		if (editor.getLine(i).match(/^\s*(`{3,}|~{3,})\s*$/)) {
			endLine = i;
			break;
		}
	}
	if (endLine === -1) {
		new Notice("Execute Code: the code block under the cursor has no closing fence.");
		return;
	}

	// Resolve the language from the fence info string, e.g. `lisp`,
	// `run-python`, or `js {label="x"}`
	let langToken = info.split(/[\s{]/)[0];
	if (langToken.startsWith("run-")) langToken = langToken.substring("run-".length);
	const language = getLanguageAlias(langToken);
	if (language === undefined) {
		new Notice(`Execute Code: "${langToken || "(none)"}" is not an executable code block language.`);
		return;
	}

	const lines: string[] = [];
	for (let i = openLine + 1; i < endLine; i++)
		lines.push(editor.getLine(i));
	const srcCode = lines.join("\n") + "\n";

	// The outputter normally streams into an element under the block's
	// rendered <pre>; when running from the editor there may be none (the
	// cursor being inside the block unrenders it in live preview), so stream
	// into a detached element and rely on the persistent output in the note.
	const container = document.createElement("div");
	const pre = container.appendChild(document.createElement("pre"));
	const codeElem = pre.appendChild(document.createElement("code"));
	const outputter = new Outputter(codeElem, plugin.settings, view, plugin.app, view.file.path, srcCode, null);

	const block: CodeBlockContext = {
		srcCode: srcCode,
		language: language,
		markdownFile: view.file.path,
		button: document.createElement("button"),
		outputter: outputter,
		executors: plugin.executors,
	};

	await handleExecution(block);
}
