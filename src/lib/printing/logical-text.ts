/** Human-readable layout only. Never encode user-entered text as printer commands. */
export function wrapPrintText(value: string, columns = 32): string[] {
  let characters = Array.from(value.normalize("NFC").replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim());
  const lines: string[] = [];
  while (characters.length > columns) {
    const space = characters.slice(0, columns + 1).lastIndexOf(" ");
    const end = space > 0 ? space : columns;
    lines.push(characters.slice(0, end).join(""));
    characters = characters.slice(end);
    if (characters[0] === " ") characters.shift();
  }
  if (characters.length) lines.push(characters.join(""));
  return lines;
}
