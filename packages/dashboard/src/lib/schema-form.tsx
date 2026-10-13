import { useId } from 'react';
import { z } from 'zod';
import { Button } from '../ui/Button.js';
import { Checkbox, Field, Input } from '../ui/Field.js';
import { RadioGroup } from '../ui/RadioGroup.js';
import { Select } from '../ui/Select.js';

const humanize = (key: string) => {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};
function unwrap(schema: z.ZodTypeAny): { schema: z.ZodTypeAny; optional: boolean } {
  let current = schema;
  let optional = false;
  while (current instanceof z.ZodOptional || current instanceof z.ZodDefault) {
    optional = true;
    current = (
      current instanceof z.ZodOptional ? current.unwrap() : current.removeDefault()
    ) as z.ZodTypeAny;
  }
  return { schema: current, optional };
}
function supported(schema: z.ZodTypeAny): boolean {
  return (
    schema instanceof z.ZodNumber ||
    schema instanceof z.ZodBoolean ||
    schema instanceof z.ZodEnum ||
    schema instanceof z.ZodString ||
    (schema instanceof z.ZodArray && schema.element instanceof z.ZodString)
  );
}
/** Inspect only direct object keys. Effects/refinements remain an honest JSON fallback. */
export function inspectSchema(schema: z.ZodTypeAny | undefined) {
  if (!(schema instanceof z.ZodObject)) return { fields: [], unsupported: true };
  const fields = Object.entries(schema.shape as Record<string, z.ZodTypeAny>).map(
    ([key, field]) => ({ key, ...unwrap(field) }),
  );
  return { fields, unsupported: fields.some((field) => !supported(field.schema)) };
}
/** Editing preserves unrepresented keys and does not run parse(), apply defaults or strip data. */
export function SchemaForm({
  schema,
  value,
  onChange,
  errors = {},
  labels = {},
  emptyMessage = 'This rule has no settings.',
}: {
  readonly emptyMessage?: string;
  readonly schema: z.ZodTypeAny;
  readonly value: Record<string, unknown>;
  readonly onChange: (value: Record<string, unknown>) => void;
  readonly errors?: Readonly<Record<string, string>>;
  readonly labels?: Readonly<Record<string, string>> | undefined;
}) {
  const prefix = useId();
  const { fields } = inspectSchema(schema);
  const set = (key: string, next: unknown) => onChange({ ...value, [key]: next });
  const clear = (key: string) => {
    const next = { ...value };
    delete next[key];
    onChange(next);
  };
  if (schema instanceof z.ZodObject && fields.length === 0) return <p>{emptyMessage}</p>;
  return (
    <div className="flex flex-col gap-4">
      {fields.map(({ key, schema: field, optional }) => {
        if (!supported(field)) return null;
        const label = labels[key] ?? humanize(key);
        const id = `${prefix}-${key}`;
        const errorProps = errors[key] === undefined ? {} : { error: errors[key] };
        let control;
        if (field instanceof z.ZodBoolean) {
          control = (
            <div>
              <Checkbox
                id={id}
                label={`${label}${optional ? ' (optional)' : ''}`}
                checked={value[key] === true}
                aria-invalid={errors[key] !== undefined}
                aria-describedby={errors[key] === undefined ? undefined : `${id}-error`}
                onChange={(event) => set(key, event.target.checked)}
              />
              {errors[key] !== undefined && (
                <p id={`${id}-error`} role="alert">
                  {errors[key]}
                </p>
              )}
            </div>
          );
        } else if (field instanceof z.ZodEnum) {
          const options = (field.options as string[]).map((option) => ({
            value: option,
            label: option,
          }));
          control =
            options.length <= 5 ? (
              <div>
                <RadioGroup
                  legend={`${label}${optional ? ' (optional)' : ''}`}
                  name={id}
                  value={typeof value[key] === 'string' ? value[key] : undefined}
                  onChange={(next) => set(key, next)}
                  options={options}
                />
                {errors[key] !== undefined && <p role="alert">{errors[key]}</p>}
              </div>
            ) : (
              <Field label={label} optional={optional} htmlFor={id} {...errorProps}>
                <Select
                  value={typeof value[key] === 'string' ? value[key] : undefined}
                  onValueChange={(next) => set(key, next)}
                  options={options}
                />
              </Field>
            );
        } else if (field instanceof z.ZodArray) {
          const rows =
            Array.isArray(value[key]) && value[key].every((row: unknown) => typeof row === 'string')
              ? value[key]
              : [];
          control = (
            <fieldset className="flex min-w-0 flex-col gap-2">
              <legend>
                {label}
                {optional ? ' (optional)' : ''}
              </legend>
              {errors[key] !== undefined && <p role="alert">{errors[key]}</p>}
              {rows.map((row, index) => (
                <div key={index} className="flex min-w-0 items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <Field
                      label={`${label} ${index + 1}`}
                      htmlFor={`${id}-${index}`}
                      {...(errors[`${key}.${index}`] === undefined
                        ? {}
                        : { error: errors[`${key}.${index}`] })}
                    >
                      <Input
                        value={row}
                        onChange={(event) =>
                          set(
                            key,
                            rows.map((entry, at) => (at === index ? event.target.value : entry)),
                          )
                        }
                      />
                    </Field>
                  </div>
                  <Button
                    onClick={() =>
                      set(
                        key,
                        rows.filter((_, at) => at !== index),
                      )
                    }
                  >
                    Remove {label.toLowerCase()} {index + 1}
                  </Button>
                </div>
              ))}
              <Button onClick={() => set(key, [...rows, ''])}>Add {label.toLowerCase()}</Button>
            </fieldset>
          );
        } else {
          const number = field instanceof z.ZodNumber;
          const min = number ? field._def.checks.find((check) => check.kind === 'min') : undefined;
          const max = number ? field._def.checks.find((check) => check.kind === 'max') : undefined;
          control = (
            <Field label={label} optional={optional} htmlFor={id} {...errorProps}>
              <Input
                type={number ? 'number' : 'text'}
                min={min?.kind === 'min' ? min.value : undefined}
                max={max?.kind === 'max' ? max.value : undefined}
                step={number && field.isInt ? 1 : number ? 'any' : undefined}
                value={
                  typeof value[key] === 'number' || typeof value[key] === 'string' ? value[key] : ''
                }
                onChange={(event) => {
                  const text = event.target.value;
                  set(
                    key,
                    number && text !== '' && Number.isFinite(Number(text)) ? Number(text) : text,
                  );
                }}
              />
            </Field>
          );
        }
        return (
          <div key={key}>
            {control}
            {optional && (
              <Button size="sm" onClick={() => clear(key)}>
                Clear {label.toLowerCase()}
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}
