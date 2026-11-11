/**
 * A form, from a list of fields.
 *
 * `factor` marks the ones the API will refuse without a second factor. The
 * page does not decide that -- the route does -- and asking first is only so
 * the owner is not told "no" after filling everything in. A form marked
 * `factor` that the API happened not to gate would ask for a code it did not
 * need, which is the harmless direction of being wrong.
 */
import { useState } from 'react';
import { explain } from '../api.ts';
import {
  Alert, Button, Group, NumberInput, Select, SimpleGrid, Stack, Textarea, TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { Proof } from '../api.ts';
import { useFactor } from '../factor.tsx';
import { t } from '../i18n.ts';
import { currencyAffix, numberSeparators } from '../format.ts';

export interface Field {
  name: string;
  label: string;
  /** `money` is typed in US dollars, with the currency shown as `money` shows it. */
  /** `date` is a day, sent as YYYY-MM-DD. */
  type?: 'text' | 'number' | 'money' | 'textarea' | 'select' | 'datetime' | 'date';
  required?: boolean;
  placeholder?: string;
  description?: string;
  /** For a select: what may be chosen. */
  options?: Array<{ value: string; label: string }>;
  initial?: string | number | null;
  /** Take the whole row, whatever the grid. */
  wide?: boolean;
  /**
   * For a number: the least and the most it may be. A number outside them is said under the field in the owner's
   * language and the form is not sent, so the server's own sentence, which names its fields, is never reached
   * (STATUS 2.218); what was typed is left as it was rather than changed without a word.
   */
  min?: number;
  max?: number;
}

/** Whether a number field holds a number outside what it may be. */
function outside(field: Field, value: string): boolean {
  if (field.type !== 'number' || value === '') return false;
  const number = Number(value);
  return (field.min !== undefined && number < field.min) || (field.max !== undefined && number > field.max);
}

/** What a field's bounds are, said. */
function bounds(field: Field): string {
  if (field.min !== undefined && field.max !== undefined) return t('From {least} to {most}.', { least: field.min, most: field.max });
  return field.min !== undefined ? t('At least {least}.', { least: field.min }) : t('At most {most}.', { most: field.max ?? 0 });
}

export type Values = Record<string, string | number>;

export function ActionForm({
  fields, submit, action, factor, done, columns = 2, success, color,
}: {
  fields: Field[];
  submit: (values: Values, proof?: Proof) => Promise<unknown>;
  action?: string;
  /** What the owner is confirming, when this form needs their second factor. */
  factor?: string;
  done?: (result: unknown) => void;
  columns?: 1 | 2 | 3;
  /** What to say once it worked; nothing is said when this is absent and `done` is set. */
  success?: string;
  /** The button's colour: red for a form whose effect cannot be taken back. */
  color?: string;
}) {
  const requireFactor = useFactor();
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(
    fields.map((field) => [field.name, field.initial === undefined || field.initial === null ? '' : String(field.initial)]),
  ));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (name: string, value: string) => setValues((current) => ({ ...current, [name]: value }));

  const collect = (): Values => {
    const out: Values = {};
    for (const field of fields) {
      const raw = (values[field.name] ?? '').trim();
      if (raw === '' && !field.required) continue;
      out[field.name] = field.type === 'number' ? Number(raw) : raw;
    }
    return out;
  };

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (fields.some((field) => outside(field, values[field.name] ?? ''))) return;
    setBusy(true);
    const collected = collect();
    try {
      let result: unknown;
      if (factor) {
        const ok = await requireFactor(factor, async (proof) => { result = await submit(collected, proof); });
        if (!ok) return;
      } else {
        result = await submit(collected);
      }
      if (success || !done) notifications.show({ color: 'teal', message: success ?? t('Saved.') });
      done?.(result);
    } catch (failure) {
      setError(explain(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(event) => void onSubmit(event)}>
      <Stack gap="md">
        <SimpleGrid cols={{ base: 1, sm: columns }} spacing="md" verticalSpacing="sm">
          {fields.map((field) => {
            const common = {
              key: field.name,
              label: field.label,
              required: field.required ?? false,
              description: field.description,
              placeholder: field.placeholder,
              style: field.wide || field.type === 'textarea' ? { gridColumn: '1 / -1' } : undefined,
            };
            const value = values[field.name] ?? '';
            switch (field.type) {
              case 'textarea':
                return <Textarea {...common} autosize minRows={3} value={value} onChange={(e) => set(field.name, e.currentTarget.value)} />;
              case 'number':
                return <NumberInput {...common} value={value === '' ? '' : Number(value)} onChange={(v) => set(field.name, v === '' ? '' : String(v))} allowDecimal
                  {...(field.min !== undefined ? { min: field.min } : {})} {...(field.max !== undefined ? { max: field.max } : {})} clampBehavior="none"
                  error={outside(field, value) ? bounds(field) : undefined} />;
              case 'money':
                return <NumberInput {...common} {...currencyAffix()} value={value === '' ? '' : Number(value)} onChange={(v) => set(field.name, v === '' ? '' : String(v))} min={0} decimalScale={2} {...numberSeparators()} />;
              case 'select':
                return <Select {...common} data={field.options ?? []} value={value || null} onChange={(v) => set(field.name, v ?? '')} searchable clearable={!field.required} />;
              case 'datetime':
                return <TextInput {...common} type="datetime-local" value={value} onChange={(e) => set(field.name, e.currentTarget.value)} />;
              case 'date':
                return <TextInput {...common} type="date" value={value} onChange={(e) => set(field.name, e.currentTarget.value)} />;
              default:
                return <TextInput {...common} value={value} onChange={(e) => set(field.name, e.currentTarget.value)} />;
            }
          })}
        </SimpleGrid>
        {error && <Alert color="red" variant="light">{error}</Alert>}
        <Group>
          <Button type="submit" loading={busy} disabled={fields.some((field) => outside(field, values[field.name] ?? ''))} {...(color ? { color } : {})}>{action ?? t('Save')}</Button>
        </Group>
      </Stack>
    </form>
  );
}

/** A button that does one thing, with a second factor in front of it when asked. */
export function ActionButton({
  label, run, factor, color, variant = 'default', size = 'sm', done, leftSection,
}: {
  label: string;
  run: (proof?: Proof) => Promise<unknown>;
  factor?: string;
  color?: string;
  variant?: 'default' | 'light' | 'filled' | 'outline' | 'subtle';
  size?: 'xs' | 'sm' | 'md';
  done?: () => void;
  leftSection?: React.ReactNode;
}) {
  const requireFactor = useFactor();
  const [busy, setBusy] = useState(false);
  const press = async () => {
    setBusy(true);
    try {
      if (factor) {
        const ok = await requireFactor(factor, (proof) => run(proof));
        if (!ok) return;
      } else {
        await run();
      }
      done?.();
    } catch (failure) {
      notifications.show({ color: 'red', title: label, message: explain(failure) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      size={size}
      variant={variant}
      {...(color ? { color } : {})}
      loading={busy}
      onClick={() => void press()}
      leftSection={leftSection}
    >
      {label}
    </Button>
  );
}
