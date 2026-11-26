// Shared helpers for driving a throwaway Firefox instance through Marionette,
// Firefox's built-in remote control protocol. No dependencies.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function findFirefox() {
  const candidates = [
    process.env.FIREFOX_BIN,
    "C:\\Program Files\\Mozilla Firefox\\firefox.exe",
    "C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe",
    "/Applications/Firefox.app/Contents/MacOS/firefox",
    "/usr/bin/firefox",
    "/snap/bin/firefox"
  ].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error("Firefox not found. Set FIREFOX_BIN to its path.");
  return found;
}

export function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export async function waitFor(label, probe, timeoutMs = 15e3, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  for (; ; ) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${label}`);
    await sleep(intervalMs);
  }
}

export class Marionette {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.hello = new Promise((resolve) => this.onHello = resolve);
    socket.on("data", (chunk) => this.onData(chunk));
  }
  static async connect(port, timeoutMs = 6e4) {
    const deadline = Date.now() + timeoutMs;
    for (; ; ) {
      try {
        const socket = await new Promise((resolve, reject) => {
          const s = net.connect(port, "127.0.0.1");
          s.once("connect", () => resolve(s));
          s.once("error", reject);
        });
        const client = new Marionette(socket);
        await client.hello;
        return client;
      } catch (err) {
        if (Date.now() > deadline) throw new Error(`Could not reach Marionette: ${err.message}`);
        await sleep(500);
      }
    }
  }
  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (; ; ) {
      const colon = this.buffer.indexOf(0x3a);
      if (colon < 0) return;
      const length = Number(this.buffer.subarray(0, colon).toString());
      if (this.buffer.length < colon + 1 + length) return;
      const body = JSON.parse(this.buffer.subarray(colon + 1, colon + 1 + length).toString("utf8"));
      this.buffer = this.buffer.subarray(colon + 1 + length);
      if (!Array.isArray(body)) {
        this.onHello(body);
        continue;
      }
      const [, id, error, result] = body;
      const waiter = this.pending.get(id);
      if (!waiter) continue;
      this.pending.delete(id);
      if (error) waiter.reject(new Error(`${error.error}: ${error.message}`));
      else waiter.resolve(result);
    }
  }
  send(name, params = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify([0, id, name, params]);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(`${Buffer.byteLength(payload)}:${payload}`);
    });
  }
  /** Runs a script in the current page. */
  async content(script, args = []) {
    await this.send("Marionette:SetContext", { value: "content" });
    return (await this.send("WebDriver:ExecuteScript", { script, args })).value;
  }
  /** Runs a script that finishes by calling its last argument. */
  async contentAsync(script, args = []) {
    await this.send("Marionette:SetContext", { value: "content" });
    return (await this.send("WebDriver:ExecuteAsyncScript", { script, args })).value;
  }
  /** Runs a script in the browser's own privileged context. */
  async chrome(script, args = []) {
    await this.send("Marionette:SetContext", { value: "chrome" });
    try {
      return (await this.send("WebDriver:ExecuteScript", { script, args })).value;
    } finally {
      await this.send("Marionette:SetContext", { value: "content" });
    }
  }
}

const BASE_PREFS = {
  "media.autoplay.default": 0,
  "media.autoplay.blocking_policy": 0,
  "browser.shell.checkDefaultBrowser": false,
  "browser.startup.homepage_override.mstone": "ignore",
  "datareporting.policy.dataSubmissionEnabled": false,
  "toolkit.telemetry.reportingpolicy.firstRun": false,
  "app.update.auto": false,
  "app.update.enabled": false,
  "browser.aboutwelcome.enabled": false,
  "extensions.autoDisableScopes": 0
};

/**
 * Starts Firefox on a fresh temporary profile and opens a Marionette session.
 * Returns { client, version, close }. Always call close(): it quits the
 * browser and deletes the profile. Pass profileDir to use (and keep) a
 * specific profile instead, so cached downloads survive between runs.
 */
export async function launchFirefox({ headless = true, prefs = {}, profileDir = null } = {}) {
  const firefox = findFirefox();
  if (profileDir) fs.mkdirSync(profileDir, { recursive: true });
  const profile = profileDir || fs.mkdtempSync(path.join(os.tmpdir(), "rutranscribe-ff-"));
  const marionettePort = await freePort();
  const allPrefs = { ...BASE_PREFS, ...prefs, "marionette.port": marionettePort };
  fs.writeFileSync(
    path.join(profile, "user.js"),
    Object.entries(allPrefs).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join("\n")
  );
  const args = ["-marionette", "-remote-allow-system-access", "-no-remote", "-profile", profile];
  if (headless) args.push("-headless");
  const child = spawn(firefox, args, { stdio: "ignore" });
  let client = null;
  const close = async () => {
    if (client) {
      await Promise.race([client.send("Marionette:Quit", { flags: ["eForceQuit"] }).catch(() => {
      }), sleep(5e3)]);
      client.socket.destroy();
    }
    await sleep(1500);
    if (child.exitCode === null) child.kill();
    await sleep(500);
    if (!profileDir) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  };
  try {
    client = await Marionette.connect(marionettePort);
    await client.send("WebDriver:NewSession", { capabilities: { alwaysMatch: { acceptInsecureCerts: true } } });
    await client.send("WebDriver:SetTimeouts", { script: 3e4, pageLoad: 6e4 });
    const version = await client.chrome("return Services.appinfo.version;");
    return { client, version, close };
  } catch (err) {
    await close();
    throw err;
  }
}

/** Installs an unpacked extension directory or .xpi as a temporary add-on. */
export async function installExtension(client, extensionPath) {
  const addon = await client.send("Addon:Install", { path: extensionPath, temporary: true });
  const host = await client.chrome(
    `return WebExtensionPolicy.getByID(arguments[0]).mozExtensionHostname;`,
    [addon.value]
  );
  return { id: addon.value, baseUrl: `moz-extension://${host}/` };
}

const ASK_EXTENSION = `
  const done = arguments[arguments.length - 1];
  (window.wrappedJSObject || window).browser.runtime.sendMessage(arguments[0]).then(
    (r) => done(JSON.stringify(r)),
    (e) => done(JSON.stringify({ success: false, error: String(e) }))
  );`;
const SET_STORAGE = `
  const done = arguments[arguments.length - 1];
  const api = (window.wrappedJSObject || window).browser;
  const value = arguments[1] === null ? null : JSON.parse(arguments[1]);
  (value === null ? api.storage.local.remove(arguments[0]) : api.storage.local.set({ [arguments[0]]: value }))
    .then(() => done(true), () => done(false));`;

/**
 * Opens one of the extension's own pages in a second window and returns
 * helpers that message the background page from it. The first window stays
 * the current one for page scripts.
 */
export async function openExtensionChannel(client, addon) {
  const pageWindow = (await client.send("WebDriver:GetWindowHandle")).value;
  const extWindow = (await client.send("WebDriver:NewWindow", { type: "window" })).handle;
  const toPage = () => client.send("WebDriver:SwitchToWindow", { handle: pageWindow });
  const inExtension = async (script, args) => {
    await client.send("WebDriver:SwitchToWindow", { handle: extWindow });
    try {
      return await client.contentAsync(script, args);
    } finally {
      await toPage();
    }
  };
  await client.send("WebDriver:SwitchToWindow", { handle: extWindow });
  await client.send("WebDriver:Navigate", { url: `${addon.baseUrl}popup.html` });
  await toPage();
  return {
    /** Sends a runtime message to the background page and returns its answer. */
    ask: async (message) => {
      try {
        return JSON.parse(await inExtension(ASK_EXTENSION, [message]));
      } catch (err) {
        // The background page is too busy to answer in time.
        return { success: false, error: err.message };
      }
    },
    /** Writes (or with null, removes) a key in the extension's local storage. */
    setStorage: (key, value) => inExtension(SET_STORAGE, [key, value === null ? null : JSON.stringify(value)])
  };
}
