// The four tool contracts in packages/contracts/ai-tools/ are the single definition of each tool's
// arguments and result. The API validates arguments and results against them, and the worker builds the
// model's tool list from the same files.
import { readFileSync } from "node:fs";
import { Ajv, type ValidateFunction } from "ajv";
import type { Json } from "./json.ts";

export const TOOL_NAMES = [
  "get_finding_risk",
  "list_related_findings",
  "get_dependency_occurrences",
  "lookup_advisory",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export const isToolName = (name: string): name is ToolName =>
  TOOL_NAMES.some((tool) => tool === name);

interface ToolContract {
  tool: string;
  arguments: object;
  result: object;
}

const isToolContract = new Ajv({ strict: true }).compile<ToolContract>({
  type: "object",
  required: ["tool", "arguments", "result"],
  properties: {
    tool: { type: "string" },
    arguments: { type: "object" },
    result: { type: "object" },
  },
});

export interface ToolValidators {
  arguments: ValidateFunction;
  result: ValidateFunction;
}

const CONTRACT_DIR = new URL("../../../packages/contracts/ai-tools/", import.meta.url);

function loadValidators(ajv: Ajv, dir: URL, tool: ToolName): ToolValidators {
  const contract: Json = JSON.parse(readFileSync(new URL(`${tool}.v1.json`, dir), "utf8"));

  if (!isToolContract(contract)) throw new Error(`Contract ${tool}.v1.json is malformed`);

  if (contract.tool !== tool) throw new Error(`Contract ${tool}.v1.json names ${contract.tool}`);

  return { arguments: ajv.compile(contract.arguments), result: ajv.compile(contract.result) };
}

export function loadToolValidators(dir = CONTRACT_DIR): Record<ToolName, ToolValidators> {
  const ajv = new Ajv({ strict: true });

  return {
    get_finding_risk: loadValidators(ajv, dir, "get_finding_risk"),
    list_related_findings: loadValidators(ajv, dir, "list_related_findings"),
    get_dependency_occurrences: loadValidators(ajv, dir, "get_dependency_occurrences"),
    lookup_advisory: loadValidators(ajv, dir, "lookup_advisory"),
  };
}
