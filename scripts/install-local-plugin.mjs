import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.join(os.homedir(), ".cursor", "plugins", "local", "blackbox");
const names = [".cursor-plugin", "hooks", "commands", "dist", "package.json", "README.md"];

if (fs.existsSync(destination)) {
  const stat = fs.lstatSync(destination);
  if (stat.isSymbolicLink()) fs.unlinkSync(destination);
  else fs.rmSync(destination, { recursive: true, force: true });
}

fs.mkdirSync(destination, { recursive: true });
for (const name of names) {
  fs.cpSync(path.join(root, name), path.join(destination, name), { recursive: true });
}

process.stdout.write(`Copied the Blackbox plugin to ${destination}\n`);
