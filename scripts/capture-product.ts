import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { access, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, type Browser } from "@playwright/test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const web = resolve(root, "web");
const output = resolve(web, "public/product");
const require = createRequire(resolve(web, "package.json"));
const args = process.argv.slice(2);
const urlIndex = args.indexOf("--url");
const suppliedUrl = urlIndex === -1 ? undefined : args[urlIndex + 1];
if (urlIndex !== -1 && !suppliedUrl) throw new Error("--url requires the URL of a running Leash app");

type Preview = { server: ChildProcess; url: string };

async function startPreview(): Promise<Preview> {
  const server = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "dev", "--port", "0"], {
    cwd: web,
    env: { ...process.env, NEXT_PUBLIC_E2E: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const { promise, resolve: resolveUrl, reject } = Promise.withResolvers<string>();
    let logs = "";
    const deadline = setTimeout(() => reject(new Error(`Preview did not start: ${logs}`)), 90_000);
    const onData = (chunk: Buffer) => {
      logs = (logs + chunk.toString()).slice(-8000);
      const address = /Local:\s+(http:\/\/localhost:\d+)/.exec(logs)?.[1];
      if (address && /Ready in/.test(logs)) resolveUrl(address);
    };
    server.stdout!.on("data", onData);
    server.stderr!.on("data", onData);
    server.once("error", reject);
    server.once("exit", code => reject(new Error(`Preview exited (${code}): ${logs}`)));
    try {
      return { server, url: await promise };
    } finally {
      clearTimeout(deadline);
    }
  } catch (error) {
    await stopPreview(server);
    throw error;
  }
}

async function stopPreview(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null || server.signalCode !== null) return;
  const exited = once(server, "exit");
  server.kill("SIGTERM");
  const deadline = setTimeout(() => server.kill("SIGKILL"), 10_000);
  try { await exited; } finally { clearTimeout(deadline); }
}

async function capture(): Promise<void> {
  const files = ["prudent-desktop.jpg", "prudent-mobile.jpg"];
  if (args.includes("--if-missing") && (await Promise.all(files.map(file => access(resolve(output, file)).then(() => true, () => false)))).every(Boolean)) {
    console.log("Product snapshots already present. Run pnpm capture:product to refresh them.");
    return;
  }
  if (!await access(chromium.executablePath()).then(() => true, () => false)) {
    const installer = spawn("pnpm", ["exec", "playwright", "install", "chromium"], { cwd: root, stdio: "inherit" });
    const [code] = await once(installer, "exit");
    if (code !== 0) throw new Error("Chromium installation failed");
  }
  let preview: Preview | undefined;
  let browser: Browser | undefined;
  try {
    const baseUrl = suppliedUrl ?? (preview = await startPreview()).url;
    browser = await chromium.launch();
    await mkdir(output, { recursive: true });
    for (const viewport of [{ width: 1440, height: 1200 }, { width: 390, height: 1800 }]) {
      const page = await browser.newPage({ viewport, deviceScaleFactor: 1, reducedMotion: "reduce" });
      await page.goto(new URL("/agents/prudent", baseUrl).href);
      await expect(page.getByTestId("deposit-amount")).toBeVisible({ timeout: 90_000 });
      await expect(page.getByRole("heading", { name: "Positions by protocol" })).toBeVisible();
      await page.evaluate("document.fonts.ready");
      await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
      const main = await page.locator("main").boundingBox();
      if (!main) throw new Error("Vault main content is missing");
      await page.screenshot({
        path: resolve(output, viewport.width === 1440 ? files[0]! : files[1]!),
        type: "jpeg", quality: 90,
        clip: { x: main.x, y: main.y, width: main.width, height: Math.min(main.height, viewport.width === 1440 ? 800 : 1400) },
      });
      await page.close();
    }
    console.log(`Captured Prudent from Stellar testnet at ${new Date().toISOString()}`);
  } finally {
    await browser?.close();
    if (preview) await stopPreview(preview.server);
  }
}

await capture();
