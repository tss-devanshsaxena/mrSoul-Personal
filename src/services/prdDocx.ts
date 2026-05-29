import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
} from 'docx';
import type { AdkPrd } from '../agents/schemas';

function bulletParagraphs(items: string[]): Paragraph[] {
  return items.map(
    item =>
      new Paragraph({
        text: item,
        bullet: { level: 0 },
        spacing: { after: 120 },
      })
  );
}

function sectionHeading(text: string): Paragraph {
  return new Paragraph({
    text,
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 280, after: 160 },
  });
}

/** Build a Word document buffer from a structured PRD. */
export async function buildPrdDocxBuffer(prd: AdkPrd): Promise<Buffer> {
  const children: Paragraph[] = [
    new Paragraph({
      children: [
        new TextRun({
          text: `PRD: ${prd.title}`,
          bold: true,
          size: 32,
        }),
      ],
      alignment: AlignmentType.LEFT,
      spacing: { after: 240 },
    }),
    new Paragraph({
      children: [
        new TextRun({
          text: `Generated ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`,
          italics: true,
          size: 20,
          color: '666666',
        }),
      ],
      spacing: { after: 320 },
    }),
    sectionHeading('Problem statement'),
    new Paragraph({ text: prd.problemStatement, spacing: { after: 200 } }),
    sectionHeading('Goals'),
    ...bulletParagraphs(prd.goals),
    sectionHeading('User stories'),
    ...bulletParagraphs(prd.userStories),
    sectionHeading('Functional requirements'),
    ...bulletParagraphs(prd.functionalRequirements),
    sectionHeading('Acceptance criteria'),
    ...bulletParagraphs(prd.acceptanceCriteria),
  ];

  if (prd.outOfScope?.length) {
    children.push(sectionHeading('Out of scope'), ...bulletParagraphs(prd.outOfScope));
  }
  if (prd.openQuestions?.length) {
    children.push(sectionHeading('Open questions'), ...bulletParagraphs(prd.openQuestions));
  }

  const doc = new Document({
    sections: [{ children }],
  });

  return Packer.toBuffer(doc);
}

export function prdDocxFilename(prd: AdkPrd): string {
  const slug = prd.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return `PRD-${slug || 'draft'}.docx`;
}
