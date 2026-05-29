import { parseSlackMessage } from '../src/utils/messageParser';
import {
  deriveIssueGuidelines,
  domainRoutingHashtags,
  isMetadataHashtag,
  validateIssueCreation,
} from '../src/services/issueGuidelines';

jest.mock('../src/services/routing', () => ({
  routingService: {
    getTagRoutingStatus: jest.fn(async (tag: string) => {
      if (tag === '#refund') return 'active';
      if (tag === '#payment') return 'inactive';
      return 'missing';
    }),
  },
}));

describe('issueGuidelines', () => {
  const assignment = {
    primaryOwnerId: 'U_REAL',
    primaryOwnerName: 'Akriti',
    secondaryOwnerIds: [],
    githubUsername: 'tss-akritiraj',
    resolvedFromTags: [],
  };

  it('maps priority hashtags to P0–P3', () => {
    const msg = parseSlackMessage(
      'Prod checkout down #critical #p0',
      '1',
      'C',
      'ch',
      'U',
      'User',
      'T'
    );
    const g = deriveIssueGuidelines(msg);
    expect(g.priority).toBe('P0');
  });

  it('treats TSS field hashtags as metadata, not routing', () => {
    expect(isMetadataHashtag('#effort-5')).toBe(true);
    expect(isMetadataHashtag('#squad-backend')).toBe(true);
    expect(isMetadataHashtag('#payment')).toBe(false);

    const msg = parseSlackMessage(
      'Payment timeout on checkout #payment #effort-5 #squad-backend',
      '1',
      'C',
      'ch',
      'U',
      'User',
      'T'
    );
    expect(domainRoutingHashtags(msg)).toEqual(['#payment']);
  });

  it('parses effort and squad hashtags', () => {
    const msg = parseSlackMessage(
      'Refund API failing for partial orders need fix and tests #refund #effort-8 #squad-backend #raised-cx #q2-2026',
      '1',
      'C',
      'ch',
      'U',
      'User',
      'T'
    );
    const g = deriveIssueGuidelines(msg);
    expect(g.effort).toBe(8);
    expect(g.squad).toBe('Backend');
    expect(g.raisedBy).toBe('Customer Experience');
    expect(g.targetQuarter).toBe('Q2 2026');
  });

  it('rejects effort 21 and caps at 13', () => {
    const msg = parseSlackMessage(
      'Huge migration project across all services #effort-21',
      '1',
      'C',
      'ch',
      'U',
      'User',
      'T'
    );
    const g = deriveIssueGuidelines(msg);
    expect(g.effort).toBe(13);
    expect(g.warnings.some(w => w.includes('21'))).toBe(true);
  });

  it('parses parent epic hashtag', () => {
    const msg = parseSlackMessage(
      'Add retry for payment gateway timeout handling in checkout service #parent-99',
      '1',
      'C',
      'ch',
      'U',
      'User',
      'T'
    );
    expect(deriveIssueGuidelines(msg).parentIssueNumber).toBe(99);
  });

  it('fails validation without assignee', async () => {
    const msg = parseSlackMessage(
      'Something broke on the payment page for international cards',
      '1',
      'C',
      'ch',
      'U',
      'User',
      'T'
    );
    const g = deriveIssueGuidelines(msg);
    const v = await validateIssueCreation(msg, { ...assignment, githubUsername: '' }, g);
    expect(v.ok).toBe(false);
  });

  it('fails validation on vague description', async () => {
    const msg = parseSlackMessage('fix bug', '1', 'C', 'ch', 'U', 'User', 'T');
    const g = deriveIssueGuidelines(msg);
    const v = await validateIssueCreation(msg, assignment, g);
    expect(v.ok).toBe(false);
  });

  it('passes validation for substantive message', async () => {
    const msg = parseSlackMessage(
      'Refund API returns 500 when partial refund is requested on POS #refund #effort-3',
      '1',
      'C',
      'ch',
      'U',
      'User',
      'T'
    );
    const g = deriveIssueGuidelines(msg);
    const v = await validateIssueCreation(msg, assignment, g);
    expect(v.ok).toBe(true);
  });
});
