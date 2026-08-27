import type { ModuleAction } from "./types";

const MAX_TEXT_PARAM_LENGTH = 256;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

function numberParam(
  value: unknown,
  param: ModuleAction["params"][number],
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${param.label} must be a number.`);
  if (
    param.min !== undefined
    && param.max !== undefined
    && (parsed < param.min || parsed > param.max || (param.step !== undefined && Number.isInteger(param.step) && !Number.isInteger(parsed)))
  ) {
    throw new Error(`${param.label} must be between ${param.min} and ${param.max}.`);
  }
  if (param.min !== undefined && parsed < param.min) {
    throw new Error(`${param.label} cannot be below ${param.min}.`);
  }
  if (param.max !== undefined && parsed > param.max) {
    throw new Error(`${param.label} cannot be above ${param.max}.`);
  }
  if (param.step !== undefined && Number.isInteger(param.step) && !Number.isInteger(parsed)) {
    throw new Error(`${param.label} must be a whole number.`);
  }
  return parsed;
}

function textParam(
  value: unknown,
  param: ModuleAction["params"][number],
): string {
  if (typeof value !== "string") throw new Error(`${param.label} is required.`);
  const parsed = value.trim();
  if (!parsed) throw new Error(`${param.label} is required.`);
  if (parsed.length > MAX_TEXT_PARAM_LENGTH) throw new Error(`${param.label} is too long.`);
  if (CONTROL_CHARACTER.test(parsed)) throw new Error(`${param.label} contains unsupported control characters.`);
  return parsed;
}

export function normalizeActionParams(
  action: ModuleAction,
  input: Record<string, unknown>,
): Record<string, number | boolean | string> {
  const params: Record<string, number | boolean | string> = {};
  for (const param of action.params) {
    const value = input[param.id] ?? param.default;
    switch (param.type) {
      case "number":
        params[param.id] = numberParam(value, param);
        break;
      case "boolean":
        if (typeof value !== "boolean") throw new Error(`${param.label} must be on or off.`);
        params[param.id] = value;
        break;
      case "select": {
        const selected = textParam(value, param);
        if (!param.options?.some((option) => option.value === selected)) {
          throw new Error(`Choose a valid ${param.label.toLowerCase()}.`);
        }
        params[param.id] = selected;
        break;
      }
      case "string":
        params[param.id] = textParam(value, param);
        break;
      default: {
        const exhaustive: never = param.type;
        throw new Error(`Unsupported action parameter: ${exhaustive}`);
      }
    }
  }
  return params;
}

export function findAndNormalizeAction(
  actions: ModuleAction[],
  actionId: string,
  input: Record<string, unknown>,
): { action: ModuleAction; params: Record<string, number | boolean | string> } {
  const action = actions.find((candidate) => candidate.id === actionId);
  if (!action) throw new Error("This action is not available for the selected device.");
  return { action, params: normalizeActionParams(action, input) };
}
