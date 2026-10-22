import { afterEach, expect, test, vi } from "vitest";
import {
  caFileExample,
  computerNoun,
  dataBesideProgram,
  keyringText,
  platform,
  programText,
  setPlatformForTests,
  sqliteFileExample,
  thisComputer,
  yourComputer,
} from "./platform";

afterEach(() => {
  setPlatformForTests(null);
  vi.unstubAllGlobals();
});

test("parity_P11_38_platform_is_read_from_the_webview_once", () => {
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/130.0", platform: "Win32" });
  setPlatformForTests(null);
  expect(platform()).toBe("windows");
  // Read once: a later change of the user agent does not move it.
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15", platform: "Linux x86_64" });
  expect(platform()).toBe("windows");
  setPlatformForTests(null);
  expect(platform()).toBe("linux");
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15", platform: "MacIntel" });
  setPlatformForTests(null);
  expect(platform()).toBe("mac");
});

test("parity_P11_38_platform_words", () => {
  setPlatformForTests("windows");
  expect(keyringText()).toBe("the OS keyring (Windows Credential Manager)");
  expect(programText()).toBe("Contura.exe");
  expect(thisComputer()).toBe("this PC");
  setPlatformForTests("linux");
  expect(keyringText()).toBe("the OS keyring (the Secret Service)");
  expect(programText()).toBe("the Contura program");
  expect(thisComputer()).toBe("this computer");
});

test("the_machine_noun_and_where_the_data_folder_is", () => {
  setPlatformForTests("windows");
  expect(computerNoun()).toBe("PC");
  expect(dataBesideProgram()).toBe(true);
  setPlatformForTests("mac");
  expect(computerNoun()).toBe("computer");
  expect(dataBesideProgram()).toBe(true);
  // A .deb install keeps it in ~/.local/share/contura; an AppImage in a writable folder keeps it beside the file.
  setPlatformForTests("linux");
  expect(computerNoun()).toBe("computer");
  expect(dataBesideProgram()).toBe(false);
  setPlatformForTests(null);
});

test("parity_P11_1_sqlite_file_example_follows_the_platform", () => {
  setPlatformForTests("windows");
  expect(sqliteFileExample()).toBe("C:\\data\\shop.db");
  setPlatformForTests("linux");
  expect(sqliteFileExample()).toBe("/home/you/data/shop.db");
  setPlatformForTests("mac");
  expect(sqliteFileExample()).toBe("/home/you/data/shop.db");
});

test("parity_P11_38_ca_file_example_and_your_computer_follow_the_platform", () => {
  setPlatformForTests("windows");
  expect(caFileExample()).toBe("C:\\certs\\ca.pem");
  expect(yourComputer()).toBe("your PC");
  setPlatformForTests("linux");
  expect(caFileExample()).toBe("/etc/ssl/certs/ca.pem");
  expect(yourComputer()).toBe("your computer");
  setPlatformForTests("mac");
  expect(caFileExample()).toBe("/etc/ssl/cert.pem");
});
