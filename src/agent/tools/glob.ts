import { readdir } from 'fs/promises';
import { matchesGlob, relative, resolve } from 'path';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { resolveToolPath } from './path-utils';

const MAX_RESULTS = 200;

export function createGlobTool(cwd: string) {
  return tool(
    async ({ pattern, path }) => {
      const resolved = resolveToolPath(cwd, path);

      if (!resolved) {
        return { error: 'Path is outside the project directory' };
      }

      try {
        const files: string[] = [];
        let truncated = false;
        const directories = [resolved];

        while (directories.length > 0) {
          const currentDir = directories.pop();
          if (!currentDir) {
            continue;
          }

          const entries = await readdir(currentDir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules') {
              continue;
            }

            const absolutePath = resolve(currentDir, entry.name);
            if (entry.isDirectory()) {
              directories.push(absolutePath);
              continue;
            }

            const relativeToSearchRoot = relative(
              resolved,
              absolutePath,
            ).replace(/\\/g, '/');

            if (!matchesGlob(relativeToSearchRoot, pattern)) {
              continue;
            }

            files.push(relative(cwd, absolutePath));

            if (files.length >= MAX_RESULTS) {
              truncated = true;
              break;
            }
          }

          if (truncated) {
            break;
          }
        }

        files.sort();

        return {
          files,
          ...(truncated ? { truncated: true } : {}),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { error: `Failed to execute command: ${message}` };
      }
    },
    {
      name: 'glob',
      description:
        'Find files matching a glob pattern. Returns file paths relative to the project root. Skips node_modules and hidden directories.',
      schema: z.object({
        pattern: z
          .string()
          .describe("Glob pattern to match (e.g. '**/*.ts', 'src/**/*.tsx')"),
        path: z
          .string()
          .describe('Relative directory to search in (defaults to project root)')
          .default('.'),
      }),
    },
  );
}
