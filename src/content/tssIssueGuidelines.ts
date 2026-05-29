/** TSS Product & Tech — issue creation guidelines (reference for Slack copy). */

export const TSS_PROJECT_NAME = 'TSS Product & Tech Master';

export const TSS_PROJECT_URL =
  'https://github.com/orgs/thesouledstore-tss/projects/1';

export const TSS_GUIDELINES_DOC_HINT =
  'Issue Creation Guidelines (TSS Product & Tech) — assignee, project fields, Fibonacci effort, P0–P3, squad, dates, description, parent epic.';

export const TSS_PROJECT_VIEWS = {
  roadmap: 'https://github.com/orgs/thesouledstore-tss/projects/1/views/4',
  epics: 'https://github.com/orgs/thesouledstore-tss/projects/1/views/3',
  kanban: 'https://github.com/orgs/thesouledstore-tss/projects/1/views/2',
} as const;

export const FIBONACCI_EFFORTS = [1, 2, 3, 5, 8, 13] as const;

export const SQUAD_OPTIONS = [
  'Frontend Web',
  'Frontend Mobile',
  'Backend Python',
  'Backend',
  'Data',
  'DevOps',
] as const;

export const RAISED_BY_OPTIONS = [
  'Marketing',
  'Finance',
  'Customer Experience',
  'Tech',
  'Retail',
] as const;

/** Hashtag hints shown in MrSoul guidelines */
export const ISSUE_CREATION_HASHTAGS_HELP = [
  '`#critical` / `#p0` → P0',
  '`#urgent` / `#p1` → P1',
  '`#effort-3` / `#effort-5` / `#effort-8` → Fibonacci effort on project',
  '`#squad-backend` / `#squad-frontend-web` → Squad field',
  '`#raised-tech` / `#raised-cx` → Raised By field',
  '`#q2-2026` → Target quarter',
  '`#parent-123` → link child to epic/issue #123',
] as const;
