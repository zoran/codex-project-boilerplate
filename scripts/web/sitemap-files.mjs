import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";

export function verifyRealDirectory(directoryPath, label) {
  if (!existsSync(directoryPath)) throw new Error(`${label} does not exist`);
  const directoryStat = lstatSync(directoryPath);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error(`${label} must be a real directory, not a symlink`);
  }
  return realpathSync.native(directoryPath);
}

export function verifyRealFileInside({ filePath, parentPath, realParentPath, label }) {
  if (!existsSync(filePath)) throw new Error(`${label} does not exist`);
  if (!isInsidePath(parentPath, filePath)) {
    throw new Error(`${label} must stay inside its product source root`);
  }

  const fileStat = lstatSync(filePath);
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
    throw new Error(`${label} must be a real file, not a symlink path`);
  }

  const realFilePath = realpathSync.native(filePath);
  if (!isInsidePath(realParentPath, realFilePath)) {
    throw new Error(`${label} must resolve inside its product source root`);
  }

  return realFilePath;
}

export function isInsidePath(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
