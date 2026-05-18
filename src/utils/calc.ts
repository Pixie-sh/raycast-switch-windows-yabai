import { Parser } from "expr-eval-fork";

const CALC_PREFIX = "=";

export interface CalcMode {
  isCalcMode: boolean;
  expression: string;
}

export interface CalcResult {
  result: number | null;
  formatted: string;
  error: string | null;
}

// Singleton parser — member access and user-defined functions are disabled
// so there is no path to call arbitrary JS code.
const parser = new Parser({
  allowMemberAccess: false,
  operators: {
    assignment: false,
    fndef: false,
  },
});

/**
 * Detect whether the search text is in calculator mode (starts with "=").
 * Returns the expression after the "=" prefix.
 */
export function parseCalcMode(searchText: string): CalcMode {
  const trimmed = searchText.trim();
  if (trimmed.startsWith(CALC_PREFIX)) {
    return {
      isCalcMode: true,
      expression: trimmed.slice(CALC_PREFIX.length).trim(),
    };
  }
  return { isCalcMode: false, expression: "" };
}

/**
 * Safely evaluate a math expression string.
 * Returns the numeric result and a human-readable formatted string,
 * or an error message if the expression is invalid.
 *
 * Supported: standard arithmetic (+, -, *, /, %, ^ for power),
 * parentheses, and functions/constants exposed by expr-eval-fork
 * (sqrt, abs, sin, cos, tan, log, floor, ceil, round, min, max, pi, e, …).
 */
export function evaluateExpression(expression: string): CalcResult {
  const trimmed = expression.trim();

  if (!trimmed) {
    return { result: null, formatted: "", error: null };
  }

  try {
    const result = parser.evaluate(trimmed);

    if (typeof result !== "number") {
      return { result: null, formatted: "", error: "Result is not a number" };
    }

    if (isNaN(result)) {
      return { result: null, formatted: "NaN", error: "Result is NaN" };
    }

    if (!isFinite(result)) {
      const label = result > 0 ? "∞" : "-∞";
      return { result: null, formatted: label, error: `Result is ${label}` };
    }

    // Format: integers without decimals; floats stripped of trailing zeros
    const formatted = Number.isInteger(result) ? String(result) : parseFloat(result.toPrecision(10)).toString();

    return { result, formatted, error: null };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Invalid expression";
    return { result: null, formatted: "", error: message };
  }
}
