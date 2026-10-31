/**
 * Renders an analyzer's parameters from the JSON Schema the API sends.
 *
 * The rule set is the instructor's contract with the grader, so the form has to
 * accept exactly what the analyzer accepts: a number field for a bounded number,
 * a checkbox for a boolean, a select for an enum. Anything the mapper does not
 * recognise becomes a JSON textarea - visible and editable, never silently
 * dropped, because a parameter that vanishes from the form would be saved as its
 * default the next time the instructor presses Save.
 */

const humanise = (key) => key.replace(/_/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());

const hint = (schema) => {
  const parts = [];
  if (schema.minimum !== undefined) parts.push(`min ${schema.minimum}`);
  if (schema.maximum !== undefined) parts.push(`max ${schema.maximum}`);
  if (schema.integer) parts.push('integer');
  if (schema.minLength !== undefined) parts.push(`min length ${schema.minLength}`);
  if (schema.maxLength !== undefined) parts.push(`max length ${schema.maxLength}`);
  return parts.join(' · ');
};

function JsonFallback({ id, value, onChange }) {
  return (
    <textarea
      id={id}
      rows={3}
      spellCheck={false}
      defaultValue={JSON.stringify(value ?? {}, null, 2)}
      onBlur={(event) => {
        try {
          onChange(JSON.parse(event.target.value));
          event.target.setAttribute('aria-invalid', 'false');
        } catch {
          event.target.setAttribute('aria-invalid', 'true');
        }
      }}
      className="w-full rounded-lg border border-line bg-surface-2 p-2 font-mono text-[0.6875rem] text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand aria-[invalid=true]:border-danger"
    />
  );
}

function Field({ name, schema, value, onChange }) {
  const id = `param-${name}`;
  const label = humanise(name);
  const note = hint(schema);

  // Array of a fixed vocabulary: checkboxes, so the valid set is obvious.
  if (schema.type === 'array' && schema.items?.enum) {
    const selected = new Set(Array.isArray(value) ? value : []);
    return (
      <fieldset className="space-y-1.5">
        <legend className="text-xs font-medium text-fg">{label}</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {schema.items.enum.map((option) => (
            <label key={option} className="inline-flex items-center gap-1.5 text-xs text-muted">
              <input
                type="checkbox"
                checked={selected.has(option)}
                onChange={(event) => {
                  const next = new Set(selected);
                  if (event.target.checked) next.add(option);
                  else next.delete(option);
                  onChange([...next].filter((item) => schema.items.enum.includes(item)));
                }}
                className="size-3.5 rounded border-line text-brand focus-visible:ring-2 focus-visible:ring-brand"
              />
              {humanise(option)}
            </label>
          ))}
        </div>
      </fieldset>
    );
  }

  if (schema.type === 'array') {
    const text = Array.isArray(value) ? value.join(', ') : '';
    return (
      <div>
        <label htmlFor={id} className="text-xs font-medium text-fg">
          {label}
        </label>
        <input
          id={id}
          type="text"
          defaultValue={text}
          onBlur={(event) =>
            onChange(
              event.target.value
                .split(',')
                .map((item) => item.trim())
                .filter(Boolean),
            )
          }
          placeholder="comma separated"
          className="mt-1 h-8 w-full rounded-lg border border-line bg-surface-2 px-2 font-mono text-xs text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        />
      </div>
    );
  }

  if (schema.type === 'boolean') {
    return (
      <label htmlFor={id} className="flex items-center gap-2 text-xs text-fg">
        <input
          id={id}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange(event.target.checked)}
          className="size-3.5 rounded border-line text-brand focus-visible:ring-2 focus-visible:ring-brand"
        />
        {label}
      </label>
    );
  }

  if (schema.enum) {
    return (
      <div>
        <label htmlFor={id} className="text-xs font-medium text-fg">
          {label}
        </label>
        <select
          id={id}
          value={value ?? schema.enum[0]}
          onChange={(event) => onChange(event.target.value)}
          className="mt-1 h-8 w-full rounded-lg border border-line bg-surface-2 px-2 text-xs text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        >
          {schema.enum.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (schema.type === 'number') {
    return (
      <div>
        <label htmlFor={id} className="text-xs font-medium text-fg">
          {label}
        </label>
        <input
          id={id}
          type="number"
          value={value ?? ''}
          step={schema.integer ? 1 : 'any'}
          min={schema.minimum}
          max={schema.maximum}
          onChange={(event) => {
            const raw = event.target.value;
            onChange(raw === '' ? undefined : Number(raw));
          }}
          className="mt-1 h-8 w-full rounded-lg border border-line bg-surface-2 px-2 font-mono text-xs text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        />
        {note ? <p className="mt-0.5 text-[0.625rem] text-muted">{note}</p> : null}
      </div>
    );
  }

  if (schema.type === 'string') {
    return (
      <div>
        <label htmlFor={id} className="text-xs font-medium text-fg">
          {label}
        </label>
        <input
          id={id}
          type="text"
          defaultValue={value ?? ''}
          onBlur={(event) => onChange(event.target.value)}
          className="mt-1 h-8 w-full rounded-lg border border-line bg-surface-2 px-2 font-mono text-xs text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        />
        {note ? <p className="mt-0.5 text-[0.625rem] text-muted">{note}</p> : null}
      </div>
    );
  }

  return (
    <div>
      <label htmlFor={id} className="text-xs font-medium text-fg">
        {label}
      </label>
      <div className="mt-1">
        <JsonFallback id={id} value={value} onChange={onChange} />
      </div>
    </div>
  );
}

export function SchemaFields({ schema, value, onChange }) {
  const properties = schema?.properties ?? {};
  const entries = Object.entries(properties);

  if (!entries.length) {
    return <p className="text-xs text-muted">This analyzer takes no parameters.</p>;
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {entries.map(([name, fieldSchema]) => (
        <Field
          key={name}
          name={name}
          schema={fieldSchema}
          value={value?.[name]}
          onChange={(next) => onChange({ ...(value ?? {}), [name]: next })}
        />
      ))}
    </div>
  );
}
