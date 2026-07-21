import { join, sep } from 'path';

/**
 * Resolve a tool-provided path against the project cwd, tolerating cases
 * where the model re-sends the full absolute cwd (or a prefix of it) as
 * part of the path instead of a relative path. Returns null if the
 * resolved path escapes the project directory.
 */
export function resolveToolPath(cwd: string, inputPath: string): string | null {
  const normalized = inputPath.replace(/\\/g, '/');
  const relativePart =
    normalized === cwd || normalized.startsWith(`${cwd}/`)
      ? normalized.slice(cwd.length).replace(/^\/+/, '') || '.'
      : normalized.replace(/^\/+/, '');

  const resolved = join(cwd, relativePart);

  if (resolved !== cwd && !resolved.startsWith(cwd + sep)) {
    return null;
  }

  return resolved;
}
