import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { ToolExecutionError } from "./registry.js";

export async function registerScripts(registry, config, projectRoot) {
  if (!config.enabled) return;
  const scriptsDir = path.resolve(projectRoot, config.directory);
  const manifestPath = path.join(scriptsDir, "index.json");
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return;
    throw new Error(`Unable to read script manifest: ${manifestPath}`, { cause: error });
  }
  if (!Array.isArray(manifest.scripts)) throw new Error("tools script manifest must contain a scripts array");
  const names = new Set();
  for (const entry of manifest.scripts) {
    if (entry.enabled === false) continue;
    validateEntry(entry, names);
    const executable = path.resolve(scriptsDir, entry.file);
    if (!inside(scriptsDir, executable)) throw new Error(`script escapes scripts directory: ${entry.file}`);
    const realExecutable = await fs.realpath(executable);
    const realScriptsDir = await fs.realpath(scriptsDir);
    if (!inside(realScriptsDir, realExecutable)) throw new Error(`script symlink escapes scripts directory: ${entry.file}`);
    registry.register(scriptTool(entry, realExecutable, scriptsDir, config));
  }
}

function scriptTool(entry, executable, cwd, config) {
  const properties = Object.fromEntries((entry.arguments ?? []).map((argument) => [argument.name, {
    type: argument.type ?? "string",
    description: argument.description ?? "",
    maxLength: argument.maxLength ?? 200,
    ...(argument.enum ? { enum: argument.enum } : {}),
  }]));
  return {
    name: `run_${entry.name}`,
    description: entry.description,
    scopes: config.allowQqAdminPrivate ? ["local", "qq-private-admin"] : ["local"],
    parameters: {
      type: "object",
      properties,
      required: (entry.arguments ?? []).filter((item) => item.required).map((item) => item.name),
      additionalProperties: false,
    },
    execute: (args) => run(executable, cwd, entry.arguments ?? [], args, config),
  };
}

function run(executable, cwd, definitions, values, config) {
  const args = [];
  for (const definition of definitions) {
    const value = values[definition.name];
    if (value === undefined) continue;
    if (definition.type === "boolean" && definition.flag) {
      if (value) args.push(definition.flag);
      continue;
    }
    if (definition.flag) args.push(definition.flag);
    args.push(String(value));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      windowsHide: true,
      env: { PATH: config.path ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [];
    let size = 0;
    const collect = (chunk) => {
      size += chunk.length;
      if (size > config.maxOutputBytes) child.kill("SIGKILL");
      else chunks.push(chunk);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill("SIGKILL"), config.timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const output = Buffer.concat(chunks).toString("utf8").trim();
      if (size > config.maxOutputBytes) return reject(new ToolExecutionError("script_output_limit", "脚本输出超过限制"));
      if (signal) return reject(new ToolExecutionError("script_timeout", "脚本执行超时或被终止"));
      resolve({ exitCode: code, output: output || "(no output)" });
    });
  });
}

function validateEntry(entry, names) {
  if (!/^[a-z][a-z0-9_]{1,48}$/.test(entry.name ?? "")) throw new Error(`invalid script name: ${entry.name}`);
  if (names.has(entry.name)) throw new Error(`duplicate script name: ${entry.name}`);
  names.add(entry.name);
  if (!entry.file || path.isAbsolute(entry.file)) throw new Error(`invalid script file: ${entry.file}`);
  if (!entry.description) throw new Error(`script ${entry.name} requires a description`);
  for (const argument of entry.arguments ?? []) {
    if (!/^[a-z][a-zA-Z0-9_]{0,48}$/.test(argument.name ?? "")) throw new Error(`invalid argument in ${entry.name}`);
    if (!["string", "integer", "boolean"].includes(argument.type ?? "string")) throw new Error(`invalid argument type in ${entry.name}`);
  }
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
