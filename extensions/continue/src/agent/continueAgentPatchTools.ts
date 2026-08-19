import { DiffLine, IDE } from "core";
import { deterministicApplyLazyEdit } from "core/edit/lazy/deterministic";
import {
  applyUnifiedDiff,
  isUnifiedDiffFormat,
} from "core/edit/lazy/unifiedDiffApply";
import { validateSingleEdit } from "core/edit/searchAndReplace/findAndReplaceUtils";
import { validateMultiEdit } from "core/edit/searchAndReplace/multiEditValidation";
import {
  executeFindAndReplace,
  executeMultiFindAndReplace,
} from "core/edit/searchAndReplace/performReplace";
import { validateSearchAndReplaceFilepath } from "core/edit/searchAndReplace/validateArgs";
import { BuiltInToolNames } from "core/tools/builtIn";
import { ContinueError } from "core/util/errors";
import { resolveInputPath } from "core/util/pathResolver";

export type ClientEditToolResult = {
  ok: boolean;
  text: string;
  errorMessage?: string;
  fileUri?: string;
  fileEditKind?: "create" | "edit";
  usedFallback?: boolean;
  suggestFallback?: boolean;
};

function materializeFromDiffLines(diffLines: DiffLine[]): string {
  return diffLines
    .filter((line) => line.type !== "old")
    .map((line) => line.line)
    .join("\n");
}

async function writeFileWithRetry(
  ide: IDE,
  filepath: string,
  contents: string,
): Promise<void> {
  try {
    await ide.writeFile(filepath, contents);
  } catch (firstError) {
    try {
      await ide.writeFile(filepath, contents);
    } catch {
      throw firstError;
    }
  }
}

async function resolveEditFilepath(
  filepath: unknown,
  ide: IDE,
): Promise<string> {
  if (!filepath || typeof filepath !== "string") {
    throw new Error("filepath (string) is required");
  }

  let normalized = filepath;
  if (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }

  const resolvedPath = await resolveInputPath(ide, normalized);
  if (resolvedPath && (await ide.fileExists(resolvedPath.uri))) {
    return resolvedPath.uri;
  }

  // Fallback: match against open editors by path suffix.
  const openFiles = await ide.getOpenFiles();
  const normalizedSlash = normalized.replace(/\\/g, "/");
  for (const uri of openFiles) {
    if (uri.endsWith(normalized) || uri.endsWith(normalizedSlash)) {
      return uri;
    }
  }

  throw new Error(`${filepath} does not exist`);
}

async function applyFullFileFallback(
  ide: IDE,
  filepath: string,
  fallbackContents: string,
): Promise<ClientEditToolResult> {
  await writeFileWithRetry(ide, filepath, fallbackContents);
  return {
    ok: true,
    usedFallback: true,
    fileUri: filepath,
    fileEditKind: "edit",
    text: `Patch failed; wrote full file via fallback_contents (${fallbackContents.length} chars)`,
  };
}

function patchFailureResult(message: string): ClientEditToolResult {
  return {
    ok: false,
    suggestFallback: true,
    errorMessage: message,
    text: `${message} Use write_file with full contents, or retry with fallback_contents.`,
  };
}

async function readFileForEdit(ide: IDE, filepath: string): Promise<string> {
  const oldContents = await ide.readFile(filepath);
  // VsCodeIde.readFile returns "" for missing FS provider OR files over the
  // hard size cap. Refuse to patch an "empty" read when the file is non-empty —
  // otherwise a failed/oversized read would wipe the file on write-back.
  if (oldContents.length === 0) {
    const stats = await ide.getFileStats([filepath]);
    const size = stats[filepath]?.size ?? 0;
    if (size > 0) {
      throw new Error(
        `Refusing to patch ${filepath}: file is ${size} bytes but readFile returned empty (likely over the IDE read size limit). Split the edit or use write_file carefully.`,
      );
    }
  }
  return oldContents;
}

async function applySingleFindAndReplace(
  args: Record<string, unknown>,
  ide: IDE,
): Promise<ClientEditToolResult> {
  const { oldString, newString, replaceAll } = validateSingleEdit(
    args.old_string,
    args.new_string,
    args.replace_all,
  );
  const filepath = await validateSearchAndReplaceFilepath(args.filepath, ide);
  const oldContents = await readFileForEdit(ide, filepath);
  const newContents = executeFindAndReplace(
    oldContents,
    oldString,
    newString,
    replaceAll ?? false,
    0,
  );
  await writeFileWithRetry(ide, filepath, newContents);
  return {
    ok: true,
    fileUri: filepath,
    fileEditKind: "edit",
    text: `Patched ${filepath} (${newContents.length} chars)`,
  };
}

async function applyMultiEdit(
  args: Record<string, unknown>,
  ide: IDE,
): Promise<ClientEditToolResult> {
  const { edits } = validateMultiEdit(args);
  const filepath = await validateSearchAndReplaceFilepath(args.filepath, ide);
  const oldContents = await readFileForEdit(ide, filepath);
  const newContents = executeMultiFindAndReplace(oldContents, edits);
  await writeFileWithRetry(ide, filepath, newContents);
  return {
    ok: true,
    fileUri: filepath,
    fileEditKind: "edit",
    text: `Applied ${edits.length} edit(s) to ${filepath}`,
  };
}

async function applyEditExistingFile(
  args: Record<string, unknown>,
  ide: IDE,
): Promise<ClientEditToolResult> {
  if (!args.changes || typeof args.changes !== "string") {
    throw new Error("changes (string) is required for edit_existing_file");
  }

  const filepath = await resolveEditFilepath(args.filepath, ide);
  const oldFile = await readFileForEdit(ide, filepath);
  const changes = args.changes;

  let diffLines: DiffLine[] | undefined;
  if (isUnifiedDiffFormat(changes)) {
    try {
      diffLines = applyUnifiedDiff(oldFile, changes);
    } catch {
      diffLines = undefined;
    }
  }

  if (!diffLines) {
    diffLines = await deterministicApplyLazyEdit({
      oldFile,
      newLazyFile: changes,
      filename: filepath,
    });
  }

  if (!diffLines) {
    return patchFailureResult(
      "Could not apply edit_existing_file changes deterministically.",
    );
  }

  const newContents = materializeFromDiffLines(diffLines);
  await writeFileWithRetry(ide, filepath, newContents);
  return {
    ok: true,
    fileUri: filepath,
    fileEditKind: "edit",
    text: `Applied edit_existing_file to ${filepath}`,
  };
}

export async function applyClientEditTool(
  toolName: string,
  args: Record<string, unknown>,
  ide: IDE,
): Promise<ClientEditToolResult> {
  const fallbackContents =
    typeof args.fallback_contents === "string"
      ? args.fallback_contents
      : undefined;
  const fallbackPath =
    typeof args.filepath === "string"
      ? args.filepath
      : typeof args.path === "string"
        ? args.path
        : undefined;

  try {
    switch (toolName) {
      case BuiltInToolNames.SingleFindAndReplace:
        return await applySingleFindAndReplace(args, ide);
      case BuiltInToolNames.MultiEdit:
        return await applyMultiEdit(args, ide);
      case BuiltInToolNames.EditExistingFile:
        return await applyEditExistingFile(args, ide);
      default:
        return {
          ok: false,
          text: `Unsupported client edit tool: ${toolName}`,
        };
    }
  } catch (error) {
    const message =
      error instanceof ContinueError || error instanceof Error
        ? error.message
        : String(error);

    if (fallbackContents !== undefined && fallbackPath) {
      try {
        const resolved = await resolveEditFilepath(fallbackPath, ide);
        return await applyFullFileFallback(ide, resolved, fallbackContents);
      } catch (fallbackError) {
        const fallbackMessage =
          fallbackError instanceof Error
            ? fallbackError.message
            : String(fallbackError);
        return {
          ok: false,
          suggestFallback: true,
          errorMessage: `${message}; fallback write failed: ${fallbackMessage}`,
          text: `${message}; fallback write failed: ${fallbackMessage}. Use write_file with full contents.`,
        };
      }
    }

    return patchFailureResult(message);
  }
}
