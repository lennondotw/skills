import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const skillsRoot = path.join(root, "skills");
const evalsRoot = path.join(root, "evals");
const errors = [];
const skillNames = new Set();

const exists = async (target) => {
  try {
    await readFile(target);
    return true;
  } catch {
    return false;
  }
};

const readDirectories = async (target) => {
  try {
    return (await readdir(target, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
};

for (const directory of await readDirectories(skillsRoot)) {
  const skillFile = path.join(skillsRoot, directory, "SKILL.md");
  if (!(await exists(skillFile))) {
    errors.push(`skills/${directory} does not contain SKILL.md`);
    continue;
  }

  const contents = await readFile(skillFile, "utf8");
  const frontmatter = contents.match(/^---\n([\s\S]*?)\n---\n/);
  if (!frontmatter) {
    errors.push(`skills/${directory}/SKILL.md has no YAML frontmatter`);
    continue;
  }

  const name = frontmatter[1].match(/^name:\s*([^\n]+)$/m)?.[1]?.trim();
  if (!name) {
    errors.push(`skills/${directory}/SKILL.md has no name`);
  } else {
    if (name !== directory) errors.push(`skills/${directory} declares name ${name}`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
      errors.push(`skills/${directory} has an invalid name`);
    }
    skillNames.add(name);
  }

  if (!/^description:\s*(?:\S|[>|])?/m.test(frontmatter[1])) {
    errors.push(`skills/${directory}/SKILL.md has no description`);
  }
}

for (const directory of await readDirectories(evalsRoot)) {
  if (!skillNames.has(directory)) errors.push(`evals/${directory} has no matching public skill`);
  const files = await readdir(path.join(evalsRoot, directory), { withFileTypes: true });
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith(".json")) continue;
    try {
      JSON.parse(await readFile(path.join(evalsRoot, directory, file.name), "utf8"));
    } catch {
      errors.push(`evals/${directory}/${file.name} is not valid JSON`);
    }
  }
}

if (skillNames.size === 0) errors.push("no skills found under skills/<name>/SKILL.md");

if (errors.length > 0) {
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Validated ${skillNames.size} public skills.`);
