import * as vscode from "vscode";

/** VS Code core chat auxiliary bar view (Mobius / Copilot slot). */
export const CONTINUE_CHAT_VIEW_ID = "workbench.panel.chat.view.copilot";

/** Legacy upstream Continue sidebar view id. */
export const CONTINUE_SIDEBAR_VIEW_ID = "continue.continueGUIView";

export function focusContinueChatView(): Thenable<unknown> {
  return vscode.commands.executeCommand(`${CONTINUE_CHAT_VIEW_ID}.focus`);
}
