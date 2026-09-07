import { showToast, Toast, closeMainWindow } from "@raycast/api";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ENV, YABAI } from "./models";

const execFileAsync = promisify(execFile);

export default async function Command() {
  await showToast({ style: Toast.Style.Animated, title: "Loading scripting addition..." });

  try {
    const script = `on run argv
      do shell script ((quoted form of item 1 of argv) & " --load-sa") with administrator privileges
    end run`;
    await execFileAsync("/usr/bin/osascript", ["-e", script, YABAI], {
      env: ENV,
      encoding: "utf8",
      timeout: 30_000,
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
