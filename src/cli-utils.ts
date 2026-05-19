export function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function intOption(args: string[], name: string): number | undefined {
  const value = option(args, name);
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Invalid integer for ${name}: ${value}`);
  return parsed;
}

export function required(value: string | undefined, message: string): string {
  if (!value || value.startsWith("--")) throw new Error(message);
  return value;
}
