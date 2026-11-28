import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { appGuideText } from './app-guides.js';

const DIRECTORY = fileURLToPath(new URL('../docs/skills/', import.meta.url));
const GUIDE_LINK = /\]\(\.\.\/\.\.\/([A-Z0-9-]+)\.md(#[^)\s]*)?\)/gu;
// https://modelcontextprotocol.io/extensions/skills/overview (2026-11-28): the final segment of the
// skill path must equal the frontmatter name, which follows the Agent Skills naming rules.
const SKILL_NAME = /^[\da-z]+(?:-[\da-z]+)*$/u;

type SkillFile = { uri: string; text: string; size: number; digest: string };
type Skill = {
  uri: string;
  frontmatter: { name: string; description: string };
  files: SkillFile[];
};

function skillFile(uri: string, text: string): SkillFile {
  const bytes = Buffer.from(text, 'utf8');
  return {
    uri,
    text,
    size: bytes.length,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  };
}

function frontmatter(name: string, text: string): Skill['frontmatter'] {
  const block = /^---\n([\s\S]*?)\n---\n/u.exec(text)?.[1];
  if (block === undefined) throw new Error(`Skill ${name}: SKILL.md needs frontmatter`);
  const values = new Map<string, string>();
  for (const line of block.split('\n')) {
    const field = /^(name|description): (\S.*\S|\S)$/u.exec(line);
    if (!field || /: | #|^['"[\]{}>|&*!%@`,?-]/u.test(field[2]!))
      throw new Error(`Skill ${name}: frontmatter line is not a plain name or description`);
    values.set(field[1]!, field[2]!);
  }
  const description = values.get('description');
  if (values.get('name') !== name || !SKILL_NAME.test(name) || !description)
    throw new Error(`Skill ${name}: frontmatter name must equal the folder name`);
  return { name, description };
}

let loaded: Skill[] | undefined;
function skills(): Skill[] {
  loaded ??= readdirSync(DIRECTORY, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => {
      const source = readFileSync(`${DIRECTORY}${name}/SKILL.md`, 'utf8').replaceAll('\r\n', '\n');
      const guides = [...new Set([...source.matchAll(GUIDE_LINK)].map((match) => match[1]!))];
      const text = source.replace(
        GUIDE_LINK,
        (_link, guide: string, fragment?: string) => `](guides/${guide}.md${fragment ?? ''})`
      );
      const root = `skill://${name}`;
      return {
        uri: `${root}/SKILL.md`,
        frontmatter: frontmatter(name, text),
        files: [
          skillFile(`${root}/SKILL.md`, text),
          ...guides.map((guide) => {
            const body = appGuideText(guide);
            if (body === undefined) throw new Error(`Skill ${name}: no guide ${guide}`);
            return skillFile(`${root}/guides/${guide}.md`, body);
          }),
        ],
      };
    });
  return loaded;
}

const entry = (skill: Skill) => ({
  uri: skill.uri,
  frontmatter: skill.frontmatter,
  resources: skill.files.map(({ uri, digest, size }) => ({ uri, digest, size })),
});

export const listMcpSkills = () => skills().map(entry);

export function getMcpSkill(uri: string) {
  const skill = skills().find((candidate) => candidate.uri === uri);
  return skill ? entry(skill) : undefined;
}

export const listMcpResources = () =>
  skills().flatMap((skill) =>
    skill.files.map(({ uri, size }) => ({
      uri,
      name: uri.slice('skill://'.length),
      mimeType: 'text/markdown',
      size,
    }))
  );

export function readMcpResource(uri: string) {
  const file = skills()
    .flatMap((skill) => skill.files)
    .find((candidate) => candidate.uri === uri);
  return file ? { uri: file.uri, mimeType: 'text/markdown', text: file.text } : undefined;
}
