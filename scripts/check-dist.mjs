import { execSync } from "node:child_process";

const changes = execSync("git status --porcelain -- dist", { encoding: "utf8" });
if (changes.trim() !== "") {
  process.stderr.write("dist/ is out of date with src/.\n");
  process.stderr.write(changes);
  process.exit(1);
}
