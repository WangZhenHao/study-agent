import { readFile } from 'fs/promises';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { resolveToolPath } from './path-utils';

const MAX_FILE_SIZE = 10_000;

export function createReadFileTool(cwd: string) {
  return tool(
    async ({ path }) => {
      const resolved = resolveToolPath(cwd, path);

      if (!resolved) {
        return { error: 'Path is outside the project directory' };
      }

      try {
        const content = await readFile(resolved, 'utf-8');
        if (content.length > MAX_FILE_SIZE) {
          return {
            content: content.slice(0, MAX_FILE_SIZE),
            truncated: true,
            totalLength: content.length,
          };
        }
        return { content };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { error: `Failed to read file: ${message}` };
      }
    },
    {
      name: 'readFile',
      description:
        'Read the contents of a file in the project. Returns the file text, truncated if very large.',
      schema: z.object({
        path: z.string().describe('Relative path to the file to read'),
      }),
    },
  );
}
