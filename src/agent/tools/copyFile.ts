import { cpSync, existsSync, mkdirSync, statSync } from 'node:fs';

// 复制模板目录的所有内容到新项目目录
export function copyFile(newProjectPath: string, templateProjectPath: string) {
  if (!existsSync(templateProjectPath)) {
    throw new Error(`Template path does not exist: ${templateProjectPath}`);
  }

  if (!statSync(templateProjectPath).isDirectory()) {
    throw new Error(`Template path is not a directory: ${templateProjectPath}`);
  }

  mkdirSync(newProjectPath, { recursive: true });
  cpSync(templateProjectPath, newProjectPath, {
    recursive: true,
    force: true,
  });
}
