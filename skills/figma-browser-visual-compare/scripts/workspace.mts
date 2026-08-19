import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateRoot = path.join(skillRoot, "assets", "workspace-template");
const pointerPath = path.join(skillRoot, "workspace-path");
const expectedPackageName = "figma-browser-visual-compare-workspace";

const fail = (code, message, details = {}) => {
  process.stderr.write(`${JSON.stringify({ code, message, ...details })}\n`);
  process.exitCode = 2;
};

const parseArgs = (argv) => {
  const [command = "resolve", ...rest] = argv;
  const options = { command, json: false, path: undefined, skipInstall: false };

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];

    if (value === "--json") {
      options.json = true;
      continue;
    }

    if (value === "--skip-install") {
      options.skipInstall = true;
      continue;
    }

    if (value === "--path") {
      options.path = rest[index + 1];
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${value}`);
  }

  return options;
};

const getPointerTarget = async () => {
  const stat = await fs.lstat(pointerPath).catch(() => null);

  if (!stat?.isSymbolicLink()) {
    throw new Error(`Expected ${pointerPath} to be a symbolic link into external state`);
  }

  const target = await fs.readlink(pointerPath);
  return path.resolve(skillRoot, target);
};

const readWorkspacePath = async () => {
  const value = await fs.readFile(pointerPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });

  return value.trim();
};

const validateWorkspace = async (workspacePath) => {
  if (!workspacePath || !path.isAbsolute(workspacePath)) {
    return { valid: false, reason: "The pointer does not contain an absolute path." };
  }

  const packagePath = path.join(workspacePath, "package.json");
  const packageText = await fs.readFile(packagePath, "utf8").catch(() => null);

  if (!packageText) {
    return { valid: false, reason: `Missing ${packagePath}.` };
  }

  const packageJson = JSON.parse(packageText);

  if (packageJson.name !== expectedPackageName) {
    return {
      valid: false,
      reason: `Expected package name ${expectedPackageName}, received ${
        packageJson.name ?? "none"
      }.`,
    };
  }

  const gitDir = await fs.stat(path.join(workspacePath, ".git")).catch(() => null);

  if (!gitDir?.isDirectory()) {
    return { valid: false, reason: "The workspace is not an initialized Git repository." };
  }

  return { valid: true };
};

const writeWorkspacePath = async (workspacePath) => {
  const pointerTarget = await getPointerTarget();
  await fs.mkdir(path.dirname(pointerTarget), { recursive: true });
  await fs.writeFile(pointerPath, `${workspacePath}\n`, "utf8");
};

const ensureCommand = (command, args = ["--version"]) => {
  const result = spawnSync(command, args, { encoding: "utf8" });

  if (result.status !== 0) {
    throw new Error(`Required command failed: ${command} ${args.join(" ")}`);
  }
};

const run = (command, args, cwd) => {
  execFileSync(command, args, { cwd, stdio: "inherit" });
};

const ensureEmptyDestination = async (destination) => {
  const stat = await fs.stat(destination).catch(() => null);

  if (!stat) return;
  if (!stat.isDirectory()) {
    throw new Error(`Destination exists and is not a directory: ${destination}`);
  }

  const entries = await fs.readdir(destination);

  if (entries.length > 0) {
    throw new Error(`Destination must be absent or empty: ${destination}`);
  }
};

const makeInstanceWritable = async (entryPath) => {
  const stat = await fs.lstat(entryPath);

  if (stat.isSymbolicLink()) return;

  if (stat.isDirectory()) {
    await fs.chmod(entryPath, 0o755);

    const children = await fs.readdir(entryPath);

    for (const child of children) {
      await makeInstanceWritable(path.join(entryPath, child));
    }

    return;
  }

  await fs.chmod(entryPath, 0o644);
};

const initializeWorkspace = async (destination, skipInstall) => {
  if (!destination || !path.isAbsolute(destination)) {
    throw new Error("init requires --path with an absolute destination");
  }

  ensureCommand("git");
  ensureCommand("git", ["lfs", "version"]);

  if (!skipInstall) ensureCommand("pnpm");

  await ensureEmptyDestination(destination);
  await fs.mkdir(destination, { recursive: true });
  await fs.cp(templateRoot, destination, { recursive: true, force: false });
  await makeInstanceWritable(destination);
  await fs.mkdir(path.join(destination, "runs-local"), { recursive: true });
  await fs.mkdir(path.join(destination, "cache"), { recursive: true });

  run("git", ["init", "-b", "main"], destination);
  run("git", ["lfs", "install", "--local"], destination);

  if (!skipInstall) {
    run("pnpm", ["install", "--frozen-lockfile"], destination);
  }

  run("git", ["add", "."], destination);
  run(
    "git",
    [
      "-c",
      "user.name=Codex",
      "-c",
      "user.email=codex@local",
      "commit",
      "--no-gpg-sign",
      "-m",
      "chore: initialize visual compare workspace",
    ],
    destination,
  );

  await writeWorkspacePath(destination);

  return destination;
};

const bindWorkspace = async (destination) => {
  if (!destination || !path.isAbsolute(destination)) {
    throw new Error("bind requires --path with an absolute destination");
  }

  const validation = await validateWorkspace(destination);

  if (!validation.valid) {
    throw new Error(`Cannot bind workspace: ${validation.reason}`);
  }

  await writeWorkspacePath(destination);
  return destination;
};

const printResult = (payload, json) => {
  process.stdout.write(json ? `${JSON.stringify(payload)}\n` : `${payload.workspacePath}\n`);
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));

  if (options.command === "init") {
    const workspacePath = await initializeWorkspace(options.path, options.skipInstall);
    printResult({ initialized: true, workspacePath }, options.json);
    return;
  }

  if (options.command === "bind") {
    const workspacePath = await bindWorkspace(options.path);
    printResult({ bound: true, workspacePath }, options.json);
    return;
  }

  if (options.command !== "resolve") {
    throw new Error(`Unknown command: ${options.command}`);
  }

  const workspacePath = await readWorkspacePath();

  if (!workspacePath) {
    fail("WORKSPACE_NOT_CONFIGURED", "Choose an absolute destination and run the init command.");
    return;
  }

  const validation = await validateWorkspace(workspacePath);

  if (!validation.valid) {
    fail("WORKSPACE_INVALID", validation.reason, { workspacePath });
    return;
  }

  printResult({ workspacePath }, options.json);
};

main().catch((error) => {
  fail("WORKSPACE_COMMAND_FAILED", error instanceof Error ? error.message : String(error));
});
