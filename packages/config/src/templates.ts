const MIN_TEMPLATE_CHARS = 6;

/** Every reply template is non-empty, at least six characters, and unique. */
export function validateReplyTemplates(templates: readonly string[]): string[] {
  const problems: string[] = [];
  if (templates.length === 0) problems.push('no templates');
  const seen = new Set<string>();
  templates.forEach((raw, i) => {
    const text = raw.trim();
    if ([...text].length < MIN_TEMPLATE_CHARS) problems.push(`#${i} is shorter than ${MIN_TEMPLATE_CHARS} characters: "${raw}"`);
    if (seen.has(text)) problems.push(`#${i} duplicates an earlier template: "${raw}"`);
    seen.add(text);
  });
  return problems;
}
