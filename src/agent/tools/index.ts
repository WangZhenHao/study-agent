import { createReadFileTool } from './read-file';
import { createListDirectoryTool } from './list-directory';
import { createWriteFileTool } from './write-file';
import { createEditFileTool } from './edit-file';
import { createGrepTool } from './grep';
import { createGlobTool } from './glob';
import { createBashTool } from './bash';
import { Mode } from '../dto';
// import type { UserMessagePart } from '../util/schemas';
// import { createReadUploadedFileTool } from './read-uploaded-file';

export function createTools(
  cwd: string,
  mode: Mode,
) {
  const readOnlyTools = {
    readFile: createReadFileTool(cwd),
    listDirectory: createListDirectoryTool(cwd),
    grep: createGrepTool(cwd),
    glob: createGlobTool(cwd),
  };

  if (mode === 'plan') {
    return readOnlyTools;
  }

  return {
    ...readOnlyTools,
    writeFile: createWriteFileTool(cwd),
    editFile: createEditFileTool(cwd),
    bash: createBashTool(cwd),
  };
}
