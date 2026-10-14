import { runPythonBridge } from './bridge-runner.js';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { getManagedPythonPath } from './venv-manager.js'; // Import from the TS file

// Recreate __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Execute a Python function from the python_bridge.py script.
 * @param functionName - Name of the Python function to call.
 * @param args - Arguments to pass to the function.
 * @returns Promise resolving with the result from the Python function.
 * @throws {Error} If the Python process fails or returns an error.
 */
export async function callPythonFunction(
  functionName: string,
  args: Record<string, any> = {},
): Promise<any> {
  // Await async setup before creating the Promise (avoids async promise executor)
  const pythonExecutable = await getManagedPythonPath();

  // Path to the Python bridge script
  // Navigate from dist/lib/ up to project root, then into source lib/ directory
  // This keeps Python scripts in a single source of truth location (lib/)
  const scriptPath = path.resolve(__dirname, '..', '..', 'lib', 'python_bridge.py');

  // Validate script exists before attempting to spawn
  if (!existsSync(scriptPath)) {
    throw new Error(
      `Python bridge script not found at: ${scriptPath}\n` +
        `This usually indicates a build or installation issue.\n` +
        `Expected location: <project_root>/lib/python_bridge.py`,
    );
  }

  // Serialize arguments as JSON
  const serializedArgs = JSON.stringify(args);

  const lines = await runPythonBridge(path.basename(scriptPath), {
    pythonPath: pythonExecutable,
    scriptPath: path.dirname(scriptPath),
    args: [functionName, serializedArgs],
  });
  try {
    return JSON.parse(lines.join('\n'));
  } catch {
    throw new Error('Failed to parse Python result JSON');
  }
}
