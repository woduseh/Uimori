export function copyTitle(title: string, suffix: string, limit: number): string {
  const characters = Array.from(title);
  while (characters.length && characters.join('').trimEnd().length + suffix.length > limit)
    characters.pop();
  return characters.join('').trimEnd() + suffix;
}
