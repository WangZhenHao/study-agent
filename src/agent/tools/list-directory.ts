import { relative, join } from 'path';
import { readdir, stat } from 'fs/promises';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { resolveToolPath } from './path-utils';

export function createListDirectoryTool(cwd: string) {
  return tool(
    async ({ path }) => {
      const resolved = resolveToolPath(cwd, path);

      if (!resolved) {
        return { error: 'Path is outside the project directory' };
      }

      try {
        const entries = await readdir(resolved);
        const results: { name: string; type: 'file' | 'directory' }[] = [];

        for (const entry of entries) {
          // Skip hidden files and common large directories
          if (entry.startsWith('.') || entry === 'node_modules') continue;

          try {
            const entryPath = join(resolved, entry);
            const info = await stat(entryPath);
            results.push({
              name: entry,
              type: info.isDirectory() ? 'directory' : 'file',
            });
          } catch {
            // Skip entries we can't stat
          }
        }

        results.sort((a, b) => {
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

        return {
          path: relative(cwd, resolved) || '.',
          entries: results,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { error: `Failed to list directory: ${message}` };
      }
    },
    {
      name: 'listDirectory',
      description:
        'List files and directories in a project directory. Returns names with type indicators.',
      schema: z.object({
        path: z
          .string()
          .describe(
            'Relative path to the directory to list (defaults to project root)',
          )
          .default('.'),
      }),
    },
  );
}
