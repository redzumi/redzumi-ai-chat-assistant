import { copyFile, mkdir } from "node:fs/promises";

const distDir = "dist";
const releaseFiles = ["main.js", "manifest.json", "styles.css"];

await mkdir(distDir, { recursive: true });

for (const file of releaseFiles) {
  await copyFile(file, `${distDir}/${file}`);
}

console.log(`Copied release files to ${distDir}/`);
