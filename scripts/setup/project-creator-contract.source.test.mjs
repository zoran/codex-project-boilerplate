import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { hasContradictoryStopHookIndexContract } from "../context/portable-context-contract.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const projectCreatorSkill = `.agents/skills/create-project-from-${["boiler", "plate"].join("")}/SKILL.md`;
const content = readFileSync(path.join(root, projectCreatorSkill), "utf8");

test("the source-only project creator keeps the Stop-hook mutation contract", () => {
  assert.equal(hasContradictoryStopHookIndexContract(content), false);
  assert.equal(
    hasContradictoryStopHookIndexContract(
      `${content}\nProject hooks never update the context index.\n`,
    ),
    true,
  );
});
