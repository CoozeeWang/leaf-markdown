// Native Windows paths may contain backslashes; Markdown URLs still use '/'.
export function fileNameFromPath(path) {
  return String(path).split(/[\\/]/).pop();
}
