/**
 * A small Zod -> JSON-Schema converter.
 *
 * The rules editor renders one field per analyzer parameter, and the only
 * authority on what those parameters are is the analyzer's own Zod schema. A
 * hand-written field list would drift the first time someone added a parameter,
 * so the schema crosses the wire instead and the form is generated from it.
 *
 * Only the subset the analyzers actually use is handled. An unknown node falls
 * back to `{ type: 'object' }`, which the editor renders as read-only JSON - the
 * safe direction, because it never lets someone type a value the server will
 * reject without saying why.
 */
const def = (schema) => schema?._def ?? {};

const typeName = (schema) => def(schema).typeName ?? '';

const bounds = (checks = []) => {
  const out = {};
  for (const check of checks) {
    const kind = check?.kind ?? check?.type;
    if (kind === 'min') {
      out.minimum ??= check.value;
      out.minLength ??= typeof check.value === 'number' ? check.value : undefined;
    }
    if (kind === 'max') {
      out.maximum ??= check.value;
      out.maxLength ??= typeof check.value === 'number' ? check.value : undefined;
    }
    if (kind === 'int') out.integer = true;
  }
  // `minLength` is meaningless on numbers; keep the payload tidy.
  if (out.minimum !== undefined) delete out.minLength;
  if (out.maximum !== undefined) delete out.maxLength;
  return out;
};

export function zodToSchema(schema) {
  if (!schema) return { type: 'object' };
  const name = typeName(schema);
  const inner = def(schema);

  switch (name) {
    case 'ZodDefault':
      return { ...zodToSchema(inner.innerType), default: inner.defaultValue() };
    case 'ZodOptional':
    case 'ZodNullable':
      return zodToSchema(inner.innerType);
    case 'ZodEffects':
      return zodToSchema(inner.schema);
    case 'ZodString':
      return { type: 'string', ...bounds(inner.checks) };
    case 'ZodNumber':
      return { type: 'number', ...bounds(inner.checks) };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodEnum':
      return { type: 'string', enum: [...inner.values] };
    case 'ZodNativeEnum':
      return { type: 'string', enum: Object.values(inner.values ?? {}) };
    case 'ZodLiteral':
      return { type: typeof inner.value, const: inner.value };
    case 'ZodArray':
      return { type: 'array', items: zodToSchema(inner.type) };
    case 'ZodRecord':
      return { type: 'object', additionalProperties: zodToSchema(inner.valueType) };
    case 'ZodObject': {
      const shape = typeof inner.shape === 'function' ? inner.shape() : (inner.shape ?? {});
      const properties = {};
      const required = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToSchema(value);
        // A property that can be omitted is not required in the generated form.
        if (!['ZodOptional', 'ZodDefault'].includes(typeName(value))) required.push(key);
      }
      return { type: 'object', properties, required, additionalProperties: false };
    }
    default:
      return { type: 'object' };
  }
}

/** Defaults for a whole params object, taken from the schema itself. */
export function defaultsFor(schema) {
  try {
    return schema.parse({});
  } catch {
    return {};
  }
}
