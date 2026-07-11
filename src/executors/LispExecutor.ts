import {ChildProcessWithoutNullStreams} from "child_process";
import {ExecutorSettings} from "src/settings/Settings";
import ReplExecutor from "./ReplExecutor.js";

export default class LispExecutor extends ReplExecutor {

	process: ChildProcessWithoutNullStreams

	constructor(settings: ExecutorSettings, file: string) {
		// A minimal read-eval-print loop replaces SBCL's own REPL: no prompts,
		// values printed one per line, and errors are printed to stderr and
		// return to the loop instead of invoking the interactive debugger
		// (which would hang the session waiting for input).
		const replLoop =
			'(progn' +
			' (setf *debugger-hook* (lambda (c h) (declare (ignore h)) (format *error-output* "~&~a~%" c) (sb-ext:exit :code 70 :abort t)))' +
			' (loop' +
			'  (let ((form (handler-case (read *standard-input* nil :+eof+)' +
			'               (serious-condition (c) (format *error-output* "~&read error: ~a~%" c) (clear-input *standard-input*) (quote (values))))))' +
			'   (when (eq form :+eof+) (sb-ext:exit))' +
			'   (let ((vals (multiple-value-list (handler-case (eval form)' +
			'                (serious-condition (c) (format *error-output* "~&~a~%" c) (values))))))' +
			'    (dolist (v vals) (format t "~&~s~%" v))' +
			'    (finish-output)' +
			'    (finish-output *error-output*)))))';

		// Note: the non-interactive args setting (usually "--script") is
		// intentionally not reused here; it would prevent the session loop
		// from running.
		super(settings, settings.lispPath, ["--noinform", "--eval", replLoop], file, "lisp");
	}

	/**
	 * Nothing to do: the eval loop passed via --eval is already reading stdin.
	 */
	async setup() { /* Do nothing */ }

	wrapCode(code: string, finishSigil: string): string {
		// (values) so the loop prints nothing for the sigil form itself
		return `${code}\n(progn (finish-output) (format t "${finishSigil}") (values))\n`;
	}

	removePrompts(output: string, source: "stdout" | "stderr"): string {
		return output;
	}

}
