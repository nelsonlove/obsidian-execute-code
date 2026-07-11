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
		//
		// *execute-code-results* selects what a block reports, org-babel style:
		//   :transcript — every form's values are echoed (default)
		//   :output     — nothing but the code's own stdout
		//   :value      — stdout is discarded; the last form's values are
		//                 printed by the block's trailing sigil form
		const replLoop =
			'(progn' +
			' (defparameter cl-user::*execute-code-results* :transcript)' +
			' (defparameter cl-user::*execute-code-values* nil)' +
			' (defparameter cl-user::*execute-code-stdout* *standard-output*)' +
			' (setf *debugger-hook* (lambda (c h) (declare (ignore h)) (format *error-output* "~&~a~%" c) (sb-ext:exit :code 70 :abort t)))' +
			' (loop' +
			'  (let ((form (handler-case (read *standard-input* nil :+eof+)' +
			'               (serious-condition (c) (format *error-output* "~&read error: ~a~%" c) (clear-input *standard-input*) (quote (values))))))' +
			'   (when (eq form :+eof+) (sb-ext:exit))' +
			'   (let ((vals (multiple-value-list (handler-case' +
			'                 (if (eq cl-user::*execute-code-results* :value)' +
			'                     (let ((*standard-output* (make-broadcast-stream))) (eval form))' +
			'                     (eval form))' +
			'                (serious-condition (c) (format *error-output* "~&~a~%" c) (values))))))' +
			'    (case cl-user::*execute-code-results*' +
			'     (:output nil)' +
			'     (:value (setf cl-user::*execute-code-values* vals))' +
			'     (t (dolist (v vals) (format t "~&~s~%" v))))' +
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

	wrapCode(code: string, finishSigil: string, resultsMode?: "value" | "output"): string {
		// The mode-setting forms end in (values) so the loop echoes nothing
		// for them; the sigil form restores :transcript for the next block.
		if (resultsMode === "output") {
			return `(progn (setf cl-user::*execute-code-results* :output) (values))\n${code}\n` +
				`(progn (setf cl-user::*execute-code-results* :transcript) (finish-output) (format t "${finishSigil}") (values))\n`;
		}
		if (resultsMode === "value") {
			// The closing form is evaluated while stdout is still bound to the
			// discard stream, so it rebinds to the session's real stdout to
			// report the last form's values and the sigil.
			return `(progn (setf cl-user::*execute-code-results* :value) (values))\n${code}\n` +
				`(let ((*standard-output* cl-user::*execute-code-stdout*))` +
				` (setf cl-user::*execute-code-results* :transcript)` +
				` (dolist (v cl-user::*execute-code-values*) (format t "~&~s~%" v))` +
				` (setf cl-user::*execute-code-values* nil)` +
				` (finish-output) (format t "${finishSigil}") (values))\n`;
		}
		// (values) so the loop prints nothing for the sigil form itself
		return `${code}\n(progn (finish-output) (format t "${finishSigil}") (values))\n`;
	}

	removePrompts(output: string, source: "stdout" | "stderr"): string {
		return output;
	}

}
