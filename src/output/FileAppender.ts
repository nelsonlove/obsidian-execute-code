import { App, MarkdownPostProcessorContext, Notice, TFile } from "obsidian";

/**
 * Saves the output of a code block into the note itself, in an `output` code
 * block right below the executed block (like org-babel's `#+RESULTS:`).
 *
 * Output is buffered while the block runs and written once when it finishes,
 * via `Vault.process`, so it works in reading view, live preview and for
 * `run-` prefixed blocks alike. Re-running a block replaces its previous
 * output block instead of appending a new one.
 */
export default class FileAppender {
    app: App;
    srcFile: string;
    srcCode: string;
    getSectionInfo: (() => { lineStart: number, lineEnd: number } | null) | null;
    buffer: string;
    notifiedUnsupported = false;

    /**
     * @param app The Obsidian app
     * @param srcFile Path of the note containing the code block
     * @param srcCode The original source of the code block, as rendered. Used
     * to locate the block inside the note when no section info is available.
     * @param getSectionInfo Lazy accessor for the block's section info from
     * the markdown post-processor context, or null when unavailable (e.g.
     * blocks buttonified outside a post-processing pass).
     */
    public constructor(app: App, srcFile: string, srcCode: string, getSectionInfo: (() => { lineStart: number, lineEnd: number } | null) | null) {
        this.app = app;
        this.srcFile = srcFile;
        this.srcCode = srcCode;
        this.getSectionInfo = getSectionInfo;
        this.buffer = "";
    }

    /**
     * Called when the outputter is cleared, i.e. at the start of each run and
     * from the "Clear" button. Resets the run-scoped state.
     */
    public clearOutput() {
        this.buffer = "";
        // Re-arm the not-saved notice so it shows once per run, not once per
        // rendered block.
        this.notifiedUnsupported = false;
    }

    /**
     * Buffers a segment of stdout data. No file I/O happens until `flush`.
     */
    public addOutput(output: string) {
        this.buffer += output;
    }

    /**
     * Writes the buffered output into the note, replacing the code block's
     * previous `output` block if it has one. Called once, when the code block
     * finishes running.
     */
    public async flush() {
        if (this.buffer === "") return;
        const output = this.buffer;
        this.buffer = "";

        const file = this.app.vault.getAbstractFileByPath(this.srcFile);
        if (!(file instanceof TFile)) {
            this.notifyUnsupported();
            return;
        }

        let located = true;
        await this.app.vault.process(file, (data) => {
            const blockEnd = this.findCodeBlockEnd(data);
            if (blockEnd === null) {
                located = false;
                return data;
            }

            const sanitized = output.endsWith("\n") ? output : output + "\n";
            const outputBlock = "```output\n" + sanitized + "```";

            // Replace an existing output block directly below the code block
            const existing = data.slice(blockEnd).match(/^\n{1,2}```output\n[\s\S]*?\n?```(?=\n|$)/);
            if (existing) {
                const lineBreaks = existing[0].match(/^\n+/)[0];
                return data.slice(0, blockEnd) + lineBreaks + outputBlock + data.slice(blockEnd + existing[0].length);
            }
            return data.slice(0, blockEnd) + "\n" + outputBlock + data.slice(blockEnd);
        });

        if (!located) this.notifyUnsupported();
    }

    private notifyUnsupported() {
        if (this.notifiedUnsupported) return;
        this.notifiedUnsupported = true;
        new Notice("Execute Code: couldn't locate this code block in the note — the output is only shown below the block, not saved.", 10000);
    }

    /**
     * Finds the offset just past the closing fence of this code block in the
     * note's current content: from the renderer's section info if available,
     * otherwise the first fenced block whose body matches the block's source.
     * @param data The note's current content
     * @returns the offset of the end of the closing fence, or null
     */
    private findCodeBlockEnd(data: string): number | null {
        const lines = data.split("\n");

        const section = this.getSectionInfo?.() ?? null;
        if (section) {
            const end = this.matchBlockInLines(lines, section.lineStart, Math.min(section.lineEnd, lines.length - 1));
            if (end !== null) return end;
        }
        return this.matchBlockInLines(lines, 0, lines.length - 1);
    }

    /**
     * Scans `lines[from..to]` for a fenced code block whose body equals this
     * block's source code.
     * @returns the offset just past the closing fence, or null
     */
    private matchBlockInLines(lines: string[], from: number, to: number): number | null {
        const src = this.srcCode.endsWith("\n") ? this.srcCode.slice(0, -1) : this.srcCode;
        const srcLines = src === "" ? [] : src.split("\n");

        for (let i = from; i <= to; i++) {
            const fence = lines[i].match(/^(\s*)(`{3,}|~{3,})/);
            if (!fence) continue;

            const bodyStart = i + 1;
            const bodyEnd = bodyStart + srcLines.length; // index of expected closing fence
            if (bodyEnd > to) continue;
            if (!lines[bodyEnd].trim().startsWith(fence[2].charAt(0).repeat(3))) continue;

            let matches = true;
            for (let j = 0; j < srcLines.length; j++) {
                if (lines[bodyStart + j] !== srcLines[j]) {
                    matches = false;
                    break;
                }
            }
            if (!matches) continue;

            // Offset of the end of the closing fence line
            let offset = 0;
            for (let j = 0; j < bodyEnd; j++) offset += lines[j].length + 1;
            return offset + lines[bodyEnd].length;
        }
        return null;
    }
}
