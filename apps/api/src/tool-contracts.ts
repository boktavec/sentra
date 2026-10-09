// The four tool contracts in packages/contracts/ai-tools/ are the single definition of each tool's
// arguments and result. The API validates arguments and results against them, and the worker builds the
// model's tool list from the same files.
import { readFileSync } from "node:fs";
import { Ajv, type ValidateFunction } from "ajv";

export const TOOL_NAMES = [
  "get_finding_risk",
  "list_related_findings",
  "get_dependency_occurrences",
  "lookup_advisory",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const isToolName = (name: string): name is ToolName =>
  (TOOL_NAMES as readonly string[]).includes(name);

interface ToolContract {
  tool: ToolName;
  version: number;
  description: string;
  arguments: object;
  result: object;
}

export interface ToolValidators {
  arguments: ValidateFunction;
  result: ValidateFunction;
}

const CONTRACT_DIR = new URL("../../../packages/contracts/ai-tools/", import.meta.url);

export function loadToolValidators(dir = CONTRACT_DIR): Record<ToolName, ToolValidators> {
  const ajv = new Ajv({ strict: true });
  const validators = {} as Record<ToolName, ToolValidators>;
  for (const tool of TOOL_NAMES) {
    const contract = JSON.parse(
      readFileSync(new URL(`${tool}.v1.json`, dir), "utf8"),
    ) as ToolContract;
    if (contract.tool !== tool) throw new Error(`Contract ${tool}.v1.json names ${contract.tool}`);
    validators[tool] = {
      arguments: ajv.compile(contract.arguments),
      result: ajv.compile(contract.result),
    };
  }
  return validators;
}
