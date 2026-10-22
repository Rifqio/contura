/**
 * The OS Contura runs on, read once from the WebView, and the words that depend on it. Windows is the
 * target; Linux (and macOS) are told apart only where the copy would name something they do not have.
 */
export type Platform = "windows" | "mac" | "linux";

let cached: Platform | null = null;

/** The OS, from the WebView's user agent and platform, read the first time it is asked for. */
export function platform(): Platform {
  if (cached === null) {
    const nav = typeof navigator === "undefined" ? null : navigator;
    const s = `${nav?.userAgent ?? ""} ${nav?.platform ?? ""}`;
    cached = /Windows|Win32|Win64/i.test(s) ? "windows" : /Mac/i.test(s) ? "mac" : "linux";
  }
  return cached;
}

/** Tests only: pins the OS, or with null reads it again on the next call. */
export function setPlatformForTests(p: Platform | null): void {
  cached = p;
}

/** Where passwords and API keys are kept: "the OS keyring (Windows Credential Manager)". */
export function keyringText(): string {
  switch (platform()) {
    case "windows":
      return "the OS keyring (Windows Credential Manager)";
    case "mac":
      return "the OS keyring (the macOS Keychain)";
    case "linux":
      return "the OS keyring (the Secret Service)";
  }
}

/** What the data folder sits next to: "Contura.exe" on Windows, "the Contura program" elsewhere. */
export const programText = (): string => (platform() === "windows" ? "Contura.exe" : "the Contura program");

/** The machine as a noun: "PC" on Windows, "computer" elsewhere ("another PC"). */
export const computerNoun = (): string => (platform() === "windows" ? "PC" : "computer");

/** The machine Contura runs on, as the copy names it: "this PC" on Windows, "this computer" elsewhere. */
export const thisComputer = (): string => `this ${computerNoun()}`;

/**
 * Whether the data folder is always next to the program. On Windows and macOS it is. On Linux it is next to the
 * program only for an AppImage or a copy in a folder the user can write to; a .deb install keeps it in the XDG data
 * folder (`~/.local/share/contura`), so the copy shows the path the Core resolved instead of naming a place.
 */
export const dataBesideProgram = (): boolean => platform() !== "linux";

/** The data folder's name with the OS's separator: `data\` or `data/`. */
export const dataFolderText = (): string => (platform() === "windows" ? "data\\" : "data/");

/** An example SQLite file path for the File field's placeholder. */
export const sqliteFileExample = (): string => (platform() === "windows" ? "C:\\data\\shop.db" : "/home/you/data/shop.db");

/** The machine as "your PC" on Windows, "your computer" elsewhere ("2,314 B leave your PC"). */
export const yourComputer = (): string => `your ${computerNoun()}`;

/** An example CA certificate path for the SSL CA file field's placeholder. */
export function caFileExample(): string {
  switch (platform()) {
    case "windows":
      return "C:\\certs\\ca.pem";
    case "mac":
      return "/etc/ssl/cert.pem";
    case "linux":
      return "/etc/ssl/certs/ca.pem";
  }
}
