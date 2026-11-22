// An agent's questions arrive as an ACP form: a small JSON Schema of fields. Arcex shows them as a question card and
// turns the user's picks back into the values the schema asks for. Claude pairs each question with a "<id>_custom"
// text field for typing your own answer; that pairing is shown as one question with an "Other" box.
import type * as acp from "@agentclientprotocol/sdk";
import type { Question } from "@arcex/contracts";

type Property = { type?: string; title?: string | null; description?: string | null; enum?: unknown[]; oneOf?: unknown[]; anyOf?: unknown[]; items?: Property };
type Schema = { properties?: Record<string, Property> };

const MAX_FIELDS = 20;
const MAX_OPTIONS = 30;
const MAX_TEXT = 4000;

const clip = (value: unknown, length: number) => (typeof value === "string" && value.trim() ? value.trim().slice(0, length) : undefined);

/** A field's choices, from `oneOf`/`anyOf` ({const, title, description}) or a plain `enum`. */
function optionsOf(property: Property): Question["options"] {
  const titled = property.oneOf ?? property.anyOf;
  if (Array.isArray(titled)) {
    return titled
      .map((entry) => entry as { const?: unknown; title?: unknown; description?: unknown })
      .filter((entry) => typeof entry.const === "string")
      .slice(0, MAX_OPTIONS)
      .map((entry) => ({ value: entry.const as string, label: clip(entry.title, 200) ?? (entry.const as string), ...(clip(entry.description, 400) ? { description: clip(entry.description, 400) } : {}) }));
  }
  if (Array.isArray(property.enum)) {
    return property.enum.filter((value): value is string => typeof value === "string").slice(0, MAX_OPTIONS).map((value) => ({ value, label: value }));
  }
  return [];
}

export function questionsOf(schema: Schema): Question[] {
  const entries = Object.entries(schema.properties ?? {}).slice(0, MAX_FIELDS);
  const questions: Question[] = [];
  for (const [id, property] of entries) {
    if (!/^[\w.-]{1,80}$/.test(id) || !property || typeof property !== "object") continue;
    const base = { id, ...(clip(property.title, 80) ? { header: clip(property.title, 80) } : {}), ...(clip(property.description, 1000) ? { text: clip(property.description, 1000) } : {}) };
    if (property.type === "array") {
      const options = optionsOf(property.items ?? {});
      if (options.length) questions.push({ ...base, kind: "many", options });
    } else if (property.type === "boolean") {
      questions.push({ ...base, kind: "one", options: [{ value: "true", label: "Yes" }, { value: "false", label: "No" }] });
    } else {
      const options = property.type === "string" ? optionsOf(property) : [];
      questions.push(options.length ? { ...base, kind: "one", options } : { ...base, kind: "text", options: [] });
    }
  }
  // Fold "<id>_custom" text fields into the question they belong to.
  return questions.filter((question) => {
    const owner = question.kind === "text" && question.id.endsWith("_custom") ? questions.find((other) => other.id === question.id.slice(0, -"_custom".length) && other.kind !== "text") : undefined;
    if (owner) owner.otherId = question.id;
    return !owner;
  });
}

/** The user's answers as the form's values, checked against the schema. Unknown fields and options are dropped. */
export function contentOf(schema: Schema, answers: Record<string, unknown>): Record<string, acp.ElicitationContentValue> {
  const content: Record<string, acp.ElicitationContentValue> = {};
  for (const [id, property] of Object.entries(schema.properties ?? {}).slice(0, MAX_FIELDS)) {
    const answer = answers[id];
    if (answer === undefined || answer === null || answer === "") continue;
    if (property.type === "array") {
      const allowed = new Set(optionsOf(property.items ?? {}).map((option) => option.value));
      const picked = (Array.isArray(answer) ? answer : [answer]).filter((value): value is string => typeof value === "string" && allowed.has(value));
      if (picked.length) content[id] = picked;
    } else if (property.type === "boolean") {
      if (answer === "true" || answer === "false") content[id] = answer === "true";
    } else if (property.type === "number" || property.type === "integer") {
      const number = Number(answer);
      if (Number.isFinite(number) && (property.type === "number" || Number.isInteger(number))) content[id] = number;
    } else if (typeof answer === "string") {
      const options = optionsOf(property);
      if (!options.length) content[id] = answer.slice(0, MAX_TEXT);
      else if (options.some((option) => option.value === answer)) content[id] = answer;
    }
  }
  return content;
}

/** A short line for the answered card, such as "Postgres" or "Postgres, Redis · and a note". */
export function summaryOf(questions: Question[], content: Record<string, acp.ElicitationContentValue>): string {
  const parts: string[] = [];
  for (const question of questions) {
    const value = content[question.id];
    const labels = (Array.isArray(value) ? value : value === undefined ? [] : [String(value)])
      .map((entry) => question.options.find((option) => option.value === entry)?.label ?? entry);
    const other = question.otherId ? content[question.otherId] : undefined;
    const line = [...labels, ...(typeof other === "string" && other ? [other] : [])].join(", ");
    if (line) parts.push(line);
  }
  return parts.join(" · ").slice(0, 300) || "Answered";
}
