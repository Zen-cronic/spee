// Writes the hand-written v2 examples (src/hub/contractExamples.ts) to fixtures/contract-v2/*.json
// and refreshes the fixture blocks in docs/CONTRACT.md. test/contract-v2.test.ts fails when the
// files or the doc drift from the typed examples.
//   npm run contract:fixtures
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contractV2Fixtures, fixtureJson, fixtureRefs, syncFixtureBlocks } from "../src/hub/contractExamples.js";

const dir = "fixtures/contract-v2";
mkdirSync(dir, { recursive: true });
const files = contractV2Fixtures();
for (const [name, v] of Object.entries(files)) writeFileSync(join(dir, name), fixtureJson(v));
const docPath = "docs/CONTRACT.md";
const doc = readFileSync(docPath, "utf8");
writeFileSync(docPath, syncFixtureBlocks(doc, files));
console.log(`Wrote ${Object.keys(files).length} fixtures to ${dir}/ and refreshed ${fixtureRefs(doc).length} blocks in ${docPath}.`);
