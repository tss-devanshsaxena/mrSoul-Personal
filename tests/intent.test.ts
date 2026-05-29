import {
  parseSlackIntent,
  stripSlackMarkup,
  wantsCreateIssue,
  wantsPrd,
  extractCreateIssueBody,
  extractDeveloperWorkloadQuery,
} from '../src/services/intent';

describe('parseSlackIntent', () => {
  it('routes hashtags to create_issue', () => {
    expect(parseSlackIntent('please track #order failure', { hasHashtags: true }).kind).toBe('create_issue');
  });

  it('detects developer workload questions', () => {
    const intent = parseSlackIntent("what is Akriti working on", { hasHashtags: false });
    expect(intent).toEqual({ kind: 'developer_workload', developerQuery: 'Akriti' });
  });

  it('detects github login in workload questions', () => {
    const intent = parseSlackIntent('what is tss-vishwasbellani working on', { hasHashtags: false });
    expect(intent).toEqual({ kind: 'developer_workload', developerQuery: 'tss-vishwasbellani' });
  });

  it('detects team roster', () => {
    expect(parseSlackIntent('who is working on what', { hasHashtags: false }).kind).toBe('team_roster');
  });

  it('detects task suggestion', () => {
    const intent = parseSlackIntent('who should work on size chart excel upload', { hasHashtags: false });
    expect(intent.kind).toBe('task_suggestion');
    if (intent.kind === 'task_suggestion') {
      expect(intent.taskDescription).toContain('size chart');
    }
  });

  it('strips bot mentions', () => {
    expect(stripSlackMarkup('<@U123> what is Rahul working on')).toBe('what is Rahul working on');
  });

  it('detects create issue in thread without mention', () => {
    expect(wantsCreateIssue('create issue size chart not working', false)).toBe(true);
    expect(extractCreateIssueBody('create issue size chart not working')).toBe('size chart not working');
  });

  it('classifies create issue intent', () => {
    expect(parseSlackIntent('create issue payment bug', { hasHashtags: false }).kind).toBe('create_issue');
  });

  it('extracts first name from workload question', () => {
    expect(extractDeveloperWorkloadQuery('what is Akriti working on')).toBe('Akriti');
    expect(extractDeveloperWorkloadQuery('what is Akriti is working on')).toBe('Akriti');
  });

  it('detects PRD requests', () => {
    expect(wantsPrd('@MrSoul #prd checkout revamp')).toBe(true);
    expect(wantsPrd('write a product requirements doc for refunds')).toBe(true);
    expect(wantsPrd('#payment bug')).toBe(false);
  });

  it('handles woking typo and classifies as developer workload', () => {
    const q = '@MrSoul what is Akriti is woking on ?';
    expect(extractDeveloperWorkloadQuery(q)).toBe('Akriti');
    expect(parseSlackIntent(q, { hasHashtags: false })).toEqual({
      kind: 'developer_workload',
      developerQuery: 'Akriti',
    });
  });
});
