import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");
const modes = [
  "bare",
  "imports",
  "registered-empty",
  "registered-full-idle",
  "registered-full-loaded",
];

function forceGc() {
  if (typeof global.gc !== "function") {
    throw new Error("This probe requires node --expose-gc");
  }
  global.gc();
  global.gc();
}

function memoryMiB() {
  forceGc();
  const usage = process.memoryUsage();
  return {
    rssMiB: Number((usage.rss / 1024 / 1024).toFixed(1)),
    heapUsedMiB: Number((usage.heapUsed / 1024 / 1024).toFixed(1)),
  };
}

async function runChild(mode) {
  const startedAt = performance.now();
  if (mode === "bare") {
    return {
      mode,
      ...memoryMiB(),
      importMs: 0,
      registrationMs: 0,
      firstLoadMs: 0,
      elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
    };
  }

  const importStartedAt = performance.now();
  const [{ McpServer }, { registerTools }, { SearchEngine }] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/mcp.js"),
    import(pathToFileURL(join(repositoryRoot, "dist", "server.js")).href),
    import(pathToFileURL(join(repositoryRoot, "dist", "index", "search-engine.js")).href),
  ]);
  const importMs = performance.now() - importStartedAt;

  if (mode === "imports") {
    return {
      mode,
      ...memoryMiB(),
      importMs: Number(importMs.toFixed(1)),
      registrationMs: 0,
      firstLoadMs: 0,
      elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
    };
  }

  const probeRoot = mkdtempSync(join(tmpdir(), "reforger-forge-search-memory-"));
  try {
    const fullDataDir = join(repositoryRoot, "data");
    const indexDataDir = mode === "registered-empty" ? join(probeRoot, "empty-index") : fullDataDir;
    const searchEngine = new SearchEngine(indexDataDir);
    const server = new McpServer({ name: "search-memory-probe", version: "1.0.0" });
    const config = {
      workbenchPath: probeRoot,
      gamePath: probeRoot,
      dataDir: fullDataDir,
      patternsDir: join(fullDataDir, "patterns"),
      workbenchHost: "127.0.0.1",
      workbenchPort: 5775,
      observer: {
        managedRoot: join(probeRoot, "managed"),
        profileRoot: join(probeRoot, "profile"),
        evidenceRoots: [join(probeRoot, "evidence")],
        supportingLogRoots: [join(probeRoot, "logs")],
      },
    };

    const registrationStartedAt = performance.now();
    const dispose = registerTools(server, config, { searchEngine });
    const registrationMs = performance.now() - registrationStartedAt;
    let firstLoadMs = 0;
    if (mode === "registered-full-loaded") {
      const loadStartedAt = performance.now();
      searchEngine.getStats();
      firstLoadMs = performance.now() - loadStartedAt;
    }

    const measurement = {
      mode,
      ...memoryMiB(),
      importMs: Number(importMs.toFixed(1)),
      registrationMs: Number(registrationMs.toFixed(1)),
      firstLoadMs: Number(firstLoadMs.toFixed(1)),
      elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
      searchIndexLoaded: searchEngine.isLoaded(),
    };
    await dispose();
    return measurement;
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
}

function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? Number(((ordered[middle - 1] + ordered[middle]) / 2).toFixed(1))
    : ordered[middle];
}

function summarize(samples) {
  const summary = {};
  for (const mode of modes) {
    const matching = samples.filter((sample) => sample.mode === mode);
    summary[mode] = {
      rssMiB: median(matching.map((sample) => sample.rssMiB)),
      heapUsedMiB: median(matching.map((sample) => sample.heapUsedMiB)),
      importMs: median(matching.map((sample) => sample.importMs)),
      registrationMs: median(matching.map((sample) => sample.registrationMs)),
      firstLoadMs: median(matching.map((sample) => sample.firstLoadMs)),
      elapsedMs: median(matching.map((sample) => sample.elapsedMs)),
    };
  }
  return summary;
}

async function main() {
  const childIndex = process.argv.indexOf("--child");
  if (childIndex >= 0) {
    const mode = process.argv[childIndex + 1];
    if (!modes.includes(mode)) throw new Error(`Unknown child mode: ${mode}`);
    console.log(JSON.stringify(await runChild(mode)));
    return;
  }

  const runsIndex = process.argv.indexOf("--runs");
  const runs = runsIndex >= 0 ? Number(process.argv[runsIndex + 1]) : 3;
  if (!Number.isInteger(runs) || runs < 3 || runs > 20) {
    throw new Error("--runs must be an integer from 3 through 20");
  }

  const samples = [];
  for (const mode of modes) {
    for (let run = 1; run <= runs; run += 1) {
      const child = spawnSync(process.execPath, ["--expose-gc", scriptPath, "--child", mode], {
        cwd: repositoryRoot,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      });
      if (child.status !== 0) {
        throw new Error(
          `Probe ${mode} run ${run} failed (${child.status}): ${child.stderr || child.stdout}`
        );
      }
      const lastLine = child.stdout.trim().split(/\r?\n/).at(-1);
      samples.push({ run, ...JSON.parse(lastLine) });
    }
  }

  const medians = summarize(samples);
  const idleMarginMiB = Number((
    medians["registered-full-idle"].rssMiB - medians["registered-empty"].rssMiB
  ).toFixed(1));
  const idleReductionMiB = Number((
    medians["registered-full-loaded"].rssMiB - medians["registered-full-idle"].rssMiB
  ).toFixed(1));

  console.log(JSON.stringify({
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    runsPerMode: runs,
    medians,
    comparisons: {
      fullIdleMinusEmptyIdleRssMiB: idleMarginMiB,
      loadedBaselineMinusFullIdleRssMiB: idleReductionMiB,
    },
    samples,
  }, null, 2));
}

await main();
