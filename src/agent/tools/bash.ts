import { spawn } from 'child_process';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

const MAX_OUTPUT = 20_000;
const DEFAULT_TIMEOUT = 30_000;

const BLACKLIST_PATTERNS = [
  /\bun\s+run\s+dev\b/i,
  /\bnpm\s+run\s+dev\b/i,
  /\bnpx\s+next\s+dev\b/i,
  /\bset\b/i,
  /\bprintenv\b/i,
  /\becho\b/i,
  /\benv\b/i,
  /\bexport\b/i,
];

function isBlacklisted(command: string) {
  return BLACKLIST_PATTERNS.some((pattern) => pattern.test(command));
}

export function createBashTool(cwd: string) {
  return tool(
    async ({ command, timeout }) => {
      if (isBlacklisted(command)) {
        return {
          stdout: '',
          stderr: 'Forbidden for security reasons',
          exitCode: 1,
        };
      }

      try {
        const proc = spawn(command, {
          cwd,
          env: { ...process.env, TERM: 'dumb' },
          shell: true,
        });

        const truncate = (s: string) =>
          s.length > MAX_OUTPUT
            ? s.slice(0, MAX_OUTPUT) +
              `\n... (truncated, ${s.length} total chars)`
            : s;

        const result = await new Promise<{
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

          const timer = setTimeout(() => {
            proc.kill();
          }, timeout);

          proc.once('close', (exitCode) => {
            clearTimeout(timer);
            resolve({ stdout, stderr, exitCode });
          });
        });

        return {
          stdout: truncate(result.stdout),
          stderr: truncate(result.stderr),
          exitCode: result.exitCode,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { error: `Failed to execute command: ${message}` };
      }
    },
    {
      name: 'bash',
      description: `Execute a shell command in the project directory. Use this for running tests, builds, git operations, package installs, and any other shell commands.`,
      schema: z.object({
        command: z.string().describe('The shell command to execute'),
        timeout: z
          .number()
          .describe('Timeout in milliseconds (default: 30000)')
          .default(DEFAULT_TIMEOUT),
      }),
    },
  );
}
