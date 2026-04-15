import { showToast, Toast, closeMainWindow } from "@raycast/api";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { YABAI } from "./models";

const execAsync = promisify(exec);

export default async function Command() {
  await showToast({ style: Toast.Style.Animated, title: "Loading scripting addition..." });

  try {
    await execAsync(`osascript -e 'do shell script "${YABAI} --load-sa" with administrator privileges'`, {
      timeout: 30000,
    });
    await showToast({ style: Toast.Style.Success, title: "Scripting addition loaded" });
    await closeMainWindow();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    if (message.includes("User canceled") || message.includes("-128")) {
      await showToast({ style: Toast.Style.Failure, title: "Operation cancelled" });
    } else {
      await showToast({ style: Toast.Style.Failure, title: "Failed to load scripting addition", message });
    }
  }
}
