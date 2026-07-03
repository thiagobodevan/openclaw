export function toPosixPathSeparators(value) {
  return value.replaceAll("\\", "/");
}
