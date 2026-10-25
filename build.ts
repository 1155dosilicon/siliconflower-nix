import { existsSync, mkdirSync, rmSync, readdirSync, renameSync, statSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Build script: produces a standalone siliconflower binary via `bun build --compile`.
 *
 * Usage:
 *   bun run build                # -> dist/siliconflower[.exe] for the current platform
 *
 * Notes:
 *  - `react-devtools-core` is an optional peer of `ink`. It is only used by Ink
 *    when `DEV=true`, but Bun statically resolves its top-level import and would
 *    either fail the build ("Could not resolve") or fail at runtime inside the
 *    compiled binary ("Cannot find package"). We shim it to a no-op module so the
 *    bundle resolves cleanly without pulling in the real (heavy) devtools package.
 *  - `bun build --compile` embeds the Bun runtime + all JS into a single binary.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = here;
const outDir = join(root, "dist");

function resolveBunTarget(): { target: string; binName: string; binExt: string } {
  const platform = process.platform;
  const arch = process.arch;
  const archMap: Record<string, string> = {
    x64: "x64",
    arm64: "arm64",
    ia32: "ia32",
    arm: "arm",
  };
  const bunArch = archMap[arch] ?? arch;

  if (platform === "win32") {
    return { target: `bun-windows-${bunArch}`, binName: "siliconflower", binExt: ".exe" };
  }
  if (platform === "darwin") {
    return { target: `bun-darwin-${bunArch}`, binName: "siliconflower", binExt: "" };
  }
  return { target: `bun-linux-${bunArch}`, binName: "siliconflower", binExt: "" };
}

const { target: bunTarget, binName, binExt } = resolveBunTarget();
const finalBin = `${binName}${binExt}`;

const REACT_DEVTOOLS_SHIM = `
const devtools = { connectToDevTools() {} };
export default devtools;
export function connectToDevTools() {}
`;

const STAINLESS_SHIMS = `
export const auto = false;
export const kind = "bun";
export const fetch = globalThis.fetch;
export const Request = globalThis.Request;
export const Response = globalThis.Response;
export const Headers = globalThis.Headers;
export const FormData = globalThis.FormData;
export const Blob = globalThis.Blob;
export const File = globalThis.File;
export const ReadableStream = globalThis.ReadableStream;
export const getMultipartRequestOptions = async (form, opts) => ({ ...opts, body: form });
export const getDefaultAgent = (url) => undefined;
export const fileFromPath = () => { throw new Error("fileFromPath not supported"); };
export const isFsReadStream = (val) => false;
export function setShims() {}
export function init() {}
export function getRuntime() {
  return {
    kind,
    fetch,
    Request,
    Response,
    Headers,
    FormData,
    Blob,
    File,
    ReadableStream,
    getMultipartRequestOptions,
    getDefaultAgent,
    fileFromPath,
    isFsReadStream,
  };
}
export default {
  auto,
  kind,
  fetch,
  Request,
  Response,
  Headers,
  FormData,
  Blob,
  File,
  ReadableStream,
  getMultipartRequestOptions,
  getDefaultAgent,
  fileFromPath,
  isFsReadStream,
  setShims,
  init,
  getRuntime,
};
`;

const shimPlugin = {
  name: "optional-deps-shim",
  setup(build: import("bun").PluginBuilder) {
    // react-devtools-core -> no-op shim
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: "react-devtools-core",
      namespace: "sf-shim",
    }));
    build.onLoad({ filter: /.*/, namespace: "sf-shim" }, (args) => {
      if (args.path === "react-devtools-core") {
        return { contents: REACT_DEVTOOLS_SHIM, loader: "js" };
      }
      return undefined;
    });

    // Stainless shims (openai) -> static Bun shims (prevents minified mutable live binding bug)
    build.onResolve({ filter: /(?:openai\/_shims|_shims\/(?:index|registry|auto\/runtime))/ }, () => ({
      path: "stainless-shims",
      namespace: "sf-stainless-shims",
    }));
    build.onLoad({ filter: /.*/, namespace: "sf-stainless-shims" }, () => ({
      contents: STAINLESS_SHIMS,
      loader: "js",
    }));
  },
};

// Clean previous output
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// Skills are embedded in the binary via EMBEDDED_SKILLS in skills.ts
// No need to copy skills/ directory to dist/

const result = await Bun.build({
  entrypoints: [join(root, "src", "index.tsx")],
  outdir: outDir,
  compile: true,
  target: bunTarget as "bun-windows-x64",
  minify: {
    whitespace: true,
    syntax: true,
    identifiers: false,
  },
  plugins: [shimPlugin],
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

// `bun build --compile` names the binary after the entrypoint (e.g. `src.exe`
// for `src/index.tsx`). We rename it to the canonical `siliconflower[.exe]`.
const produced = readdirSync(outDir)
  .filter((f) => (binExt ? f.endsWith(binExt) : !f.includes(".")) || f === finalBin)
  .map((f) => {
    const p = join(outDir, f);
    return { f, p, size: statSync(p).size };
  })
  .sort((a, b) => b.size - a.size)[0];

if (!produced) {
  console.error(`Nenhum binário '${finalBin}' foi gerado em:`, outDir);
  console.error("Conteúdo:", readdirSync(outDir));
  process.exit(1);
}

if (produced.f !== finalBin) {
  const target = join(outDir, finalBin);
  rmSync(target, { force: true });
  renameSync(produced.p, target);
}

const finalPath = join(outDir, finalBin);
if (!existsSync(finalPath)) {
  console.error("Binário final não encontrado:", finalPath);
  process.exit(1);
}

const sizeMB = (statSync(finalPath).size / (1024 * 1024)).toFixed(1);
console.log(`\n[ok] binário gerado: ${finalPath} (${sizeMB} MB) [${bunTarget}]`);
