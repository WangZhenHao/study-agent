import { spawn } from 'child_process';
import { relative } from 'path';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { resolveToolPath } from './path-utils';

const MAX_MATCHES = 50;

export function createGrepTool(cwd: string) {
  return tool(
    async ({ pattern, path, include }) => {
      const resolved = resolveToolPath(cwd, path);

      if (!resolved) {
        return { error: 'Path is outside the project directory' };
      }

      try {
        const args = [
          '-rn',
          '--color=never',
          '--exclude-dir=node_modules',
          '--exclude-dir=.git',
          '-E',
        ];

        if (include) {
          args.push(`--include=${include}`);
        }

        args.push(pattern, resolved);

        const proc = spawn('grep', args, { cwd });
        const { stdout, stderr, exitCode } = await new Promise<{
          stdout: string;
          stderr: string;
          exitCode: number | null;
        }>((resolve, reject) => {
          let stdout = '';
          let stderr = '';

          proc.stdout?.on('data', (chunk: Buffer | string) => {
            stdout += chunk.toString();
          });

          proc.stderr?.on('data', (chunk: Buffer | string) => {
            stderr += chunk.toString();
          });

          proc.once('error', reject);
          proc.once('close', (code) => {
            resolve({ stdout, stderr, exitCode: code });
          });
        });

        // grep exits with 1 when no matches are found, which is not an error.
        if (exitCode !== 0 && exitCode !== 1) {
          return { error: `grep failed: ${stderr.trim()}` };
        }

        if (!stdout.trim()) {
          return { matches: [], message: 'No matches found' };
        }

        const lines = stdout.trim().split('\n');
        const matches: { file: string; line: number; content: string }[] = [];
        let truncated = false;

        for (const line of lines) {
          if (matches.length >= MAX_MATCHES) {
            truncated = true;
            break;
          }

          const match = line.match(/^(.+?):(\d+):(.*)$/);
          if (match) {
            matches.push({
              file: relative(cwd, match[1]),
              line: parseInt(match[2], 10),
              content: match[3],
            });
          }
        }

        return {
          matches,
          ...(truncated ? { truncated: true, totalMatches: lines.length } : {}),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { error: `Failed to execute command: ${message}` };
      }
    },
    {
      name: 'grep',
      description:
        'Search file contents using a regex pattern. Returns matching lines with file paths and line numbers. Skips hidden directories, node_modules, and binary files.',
      schema: z.object({
        pattern: z.string().describe('Regex pattern to search for'),
        path: z
          .string()
          .describe('Relative directory to search in (defaults to project root)')
          .default('.'),
        include: z
          .string()
          .describe("Glob pattern to filter files (e.g. '*.ts', '*.tsx')")
          .optional(),
      }),
    },
  );
}
