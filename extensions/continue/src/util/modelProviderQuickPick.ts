/**
 * Agents-window QuickInput flow for adding / modifying Mobius model providers.
 * Does not rely on Continue webview navigation (which is invisible from native Agents).
 */
import * as vscode from "vscode";
import {
  deleteModelEnv,
  loadModelEnvProfiles,
  PROVIDER_PRESETS,
  PROVIDER_IDS,
  saveModelEnv,
  type ModelEnvProfile,
} from "./physicalAiModelEnv";

const PROFILE_ID_RE = /^[a-zA-Z][a-zA-Z0-9_.-]*$/;

async function workspaceRoot(): Promise<string> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return folder ?? "";
}

function suggestNewProfileId(existing: readonly ModelEnvProfile[]): string {
  const base = "custom";
  if (!existing.some((p) => p.id === base)) {
    return base;
  }
  let i = 2;
  while (existing.some((p) => p.id === `${base}${i}`)) {
    i += 1;
  }
  return `${base}${i}`;
}

async function pickProviderId(
  current?: string,
  title = "Model Provider",
): Promise<string | undefined> {
  const items = PROVIDER_IDS.map((id) => ({
    label: PROVIDER_PRESETS[id]?.label ?? id,
    description: id,
    picked: id === current,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title,
    placeHolder: "Select API provider type (press 'Escape' to close)",
    ignoreFocusOut: true,
  });
  return picked?.description;
}

async function promptField(
  title: string,
  prompt: string,
  value: string,
  password = false,
): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title,
    prompt: `${prompt} (press 'Escape' to close)`,
    value,
    ignoreFocusOut: true,
    password,
    validateInput: (v) => (v.trim() ? undefined : "Required"),
  });
}

async function collectAndSaveProfile(
  mode: "add" | "modify",
  seed: ModelEnvProfile,
  existingIds: ReadonlySet<string>,
): Promise<boolean> {
  const root = await workspaceRoot();

  let profileId = seed.id;
  if (mode === "add") {
    const entered = await vscode.window.showInputBox({
      title: "Add Provider",
      prompt:
        "Profile id (shown in Agents model picker; press 'Escape' to close)",
      value: profileId,
      ignoreFocusOut: true,
      validateInput: (v) => {
        const id = v.trim();
        if (!PROFILE_ID_RE.test(id)) {
          return "Must start with a letter; use letters, digits, _, ., -";
        }
        if (existingIds.has(id.toLowerCase())) {
          return `Profile "${id}" already exists`;
        }
        return undefined;
      },
    });
    if (entered === undefined) {
      return false;
    }
    profileId = entered.trim();
  }

  const provider = await pickProviderId(
    seed.provider,
    mode === "add" ? "Add Provider" : `Modify ${profileId}`,
  );
  if (!provider) {
    return false;
  }
  const preset = PROVIDER_PRESETS[provider];

  const baseUrl = await promptField(
    mode === "add" ? "Add Provider" : `Modify ${profileId}`,
    "Base URL",
    seed.baseUrl || preset?.baseUrl || "",
  );
  if (baseUrl === undefined) {
    return false;
  }

  const apiKey = await promptField(
    mode === "add" ? "Add Provider" : `Modify ${profileId}`,
    "API Key",
    seed.apiKey || preset?.defaultApiKey || "",
    true,
  );
  if (apiKey === undefined) {
    return false;
  }

  const model = await promptField(
    mode === "add" ? "Add Provider" : `Modify ${profileId}`,
    "Model name",
    seed.model || preset?.defaultModel || "",
  );
  if (model === undefined) {
    return false;
  }

  try {
    const { warning } = saveModelEnv(
      root,
      {
        provider,
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        model: model.trim(),
        profileId,
      },
      "local",
    );
    await vscode.commands.executeCommand(
      "workbench.action.continue.reloadLanguageModels",
    );
    if (warning) {
      void vscode.window.showWarningMessage(warning);
    }
    void vscode.window.showInformationMessage(
      mode === "add"
        ? `Provider "${profileId}" added. It appears in the Agents model picker.`
        : `Provider "${profileId}" updated.`,
    );
    return true;
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Failed to save provider: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/** Multi-step QuickInput to create a new [profile] in ~/.continue/.env. */
export async function addModelProviderViaQuickPick(): Promise<void> {
  const root = await workspaceRoot();
  const parsed = loadModelEnvProfiles(root);
  const existingIds = new Set(parsed.profiles.map((p) => p.id.toLowerCase()));
  const newId = suggestNewProfileId(parsed.profiles);
  const preset = PROVIDER_PRESETS.openai;
  await collectAndSaveProfile(
    "add",
    {
      id: newId,
      profileId: newId,
      provider: "openai",
      baseUrl: preset?.baseUrl ?? "",
      apiKey: "",
      model: preset?.defaultModel ?? "",
    },
    existingIds,
  );
}

/** Pick an existing profile, then edit credentials via QuickInput. */
export async function modifyModelProviderViaQuickPick(): Promise<void> {
  const root = await workspaceRoot();
  let parsed = loadModelEnvProfiles(root);
  if (!parsed.profiles.length) {
    void vscode.window.showWarningMessage(
      "No providers configured yet. Use Add Provider first.",
    );
    return;
  }

  // Re-read + rebuild the QuickPick whenever profiles change (e.g. after delete).
  let quickPick: vscode.QuickPick<
    vscode.QuickPickItem & { profile: ModelEnvProfile }
  >;
  let disposed = false;
  let currentProfiles: readonly ModelEnvProfile[] = parsed.profiles;

  const buildItems = () =>
    currentProfiles.map((p) => ({
      label: p.id,
      description: `${p.provider} · ${p.model}`,
      detail: p.baseUrl,
      profile: p,
      buttons: [
        {
          iconPath: new vscode.ThemeIcon("trash"),
          tooltip: `Delete provider "${p.id}"`,
        },
      ],
    }));

  quickPick = vscode.window.createQuickPick<
    vscode.QuickPickItem & { profile: ModelEnvProfile }
  >();
  quickPick.title = "Modify Provider";
  quickPick.placeholder =
    "Select a provider profile to edit, or click the trash icon to delete (press 'Escape' to close)";
  quickPick.ignoreFocusOut = true;
  quickPick.items = buildItems();

  const result = new Promise<ModelEnvProfile | undefined>((resolve) => {
    quickPick.onDidChangeSelection((sel) => {
      if (sel[0]) {
        resolve(sel[0].profile);
        quickPick.hide();
      }
    });
    quickPick.onDidHide(() => {
      if (!disposed) {
        resolve(undefined);
      }
    });
    quickPick.onDidTriggerItemButton(async (e) => {
      const profile = (e.item as { profile: ModelEnvProfile }).profile;
      quickPick.busy = true;
      const confirm = await vscode.window.showWarningMessage(
        `Delete provider "${profile.id}"? This removes it from the model picker and cannot be undone.`,
        { modal: true },
        "Delete",
      );
      if (confirm !== "Delete") {
        quickPick.busy = false;
        return;
      }
      try {
        const { removed } = deleteModelEnv(root, profile.id);
        if (!removed) {
          quickPick.busy = false;
          return;
        }
        await vscode.commands.executeCommand(
          "workbench.action.continue.reloadLanguageModels",
        );
        parsed = loadModelEnvProfiles(root);
        currentProfiles = parsed.profiles;
        if (currentProfiles.length === 0) {
          disposed = true;
          quickPick.hide();
          quickPick.dispose();
          void vscode.window.showInformationMessage(
            `Provider "${profile.id}" deleted. No providers remain — use Add Provider to create one.`,
          );
          resolve(undefined);
          return;
        }
        quickPick.items = buildItems();
        quickPick.busy = false;
        void vscode.window.showInformationMessage(
          `Provider "${profile.id}" deleted.`,
        );
      } catch (err) {
        quickPick.busy = false;
        void vscode.window.showErrorMessage(
          `Failed to delete provider: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  });

  quickPick.show();
  const picked = await result;
  if (!disposed) {
    quickPick.dispose();
  }
  if (!picked) {
    return;
  }

  await collectAndSaveProfile(
    "modify",
    picked,
    new Set(currentProfiles.map((p) => p.id.toLowerCase())),
  );
}

/** Standalone flow: pick an existing provider profile and delete it. */
export async function deleteModelProviderViaQuickPick(): Promise<void> {
  const root = await workspaceRoot();
  const parsed = loadModelEnvProfiles(root);
  if (!parsed.profiles.length) {
    void vscode.window.showWarningMessage(
      "No providers configured yet. Use Add Provider first.",
    );
    return;
  }

  const picked = await vscode.window.showQuickPick(
    parsed.profiles.map((p) => ({
      label: p.id,
      description: `${p.provider} · ${p.model}`,
      detail: p.baseUrl,
      profile: p,
    })),
    {
      title: "Delete Provider",
      placeHolder:
        "Select a provider profile to delete (press 'Escape' to close)",
      ignoreFocusOut: true,
    },
  );
  if (!picked) {
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Delete provider "${picked.profile.id}"? This removes it from the model picker and cannot be undone.`,
    { modal: true },
    "Delete",
  );
  if (confirm !== "Delete") {
    return;
  }

  try {
    const { removed } = deleteModelEnv(root, picked.profile.id);
    if (!removed) {
      return;
    }
    await vscode.commands.executeCommand(
      "workbench.action.continue.reloadLanguageModels",
    );
    void vscode.window.showInformationMessage(
      `Provider "${picked.profile.id}" deleted.`,
    );
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Failed to delete provider: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
