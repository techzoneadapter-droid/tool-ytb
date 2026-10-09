import path from "node:path";
/** Executable code lives in the installation; media/configuration live in the workspace. */
export function codePath(...parts: string[]) {
  return path.resolve(
    process.env.STORYFLOW_CODE_ROOT || process.cwd(),
    ...parts,
  );
}
