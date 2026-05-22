import type { ExecCommandSegment } from "../infra/exec-approvals-analysis.js";
import { extractShellWrapperInlineCommand } from "../infra/exec-wrapper-resolution.js";
import { resolveMutableFileOperandSnapshotSync } from "../node-host/invoke-system-run-plan.js";

export function commandRequiresMutableScriptApproval(params: {
  command: string;
  cwd: string | undefined;
  segments: Array<Pick<ExecCommandSegment, "argv" | "raw">>;
}): boolean {
  return params.segments.some((segment) => {
    const shellCommand = extractShellWrapperInlineCommand(segment.argv);
    const snapshot = resolveMutableFileOperandSnapshotSync({
      argv: segment.argv,
      cwd: params.cwd,
      shellCommand,
    });
    if (!snapshot.ok) {
      return shellCommand !== null;
    }
    return snapshot.snapshot !== null;
  });
}
