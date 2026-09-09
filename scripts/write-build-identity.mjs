import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const directory = new URL("../dist/src/", import.meta.url);
const names = readdirSync(directory).filter(name => name.endsWith(".js") && name !== "build-identity.js").sort();
const hash = createHash("sha256");
for (const name of names) {
  const bytes = readFileSync(new URL(name, directory));
  hash.update(`${name}\0${bytes.length}\0`);
  hash.update(bytes);
}
const identity = {
  status: "available",
  source: "build_time_sha256_of_sorted_dist_src_js_excluding_build_identity",
  sha256: hash.digest("hex"),
};
writeFileSync(new URL("build-identity.js", directory), `export const BUILD_IDENTITY = ${JSON.stringify(identity)};\n`);
