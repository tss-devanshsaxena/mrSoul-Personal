import { AdvisorService } from '../src/services/advisor';
import { matchDevelopers, parseExplicitGithubLogin } from '../src/services/developerMatch';

describe('matchDevelopers', () => {
  const displayFromGithub = (login: string) =>
    login.replace(/^tss-/, '').replace(/^./, c => c.toUpperCase());

  const directory = [
    {
      githubUsername: 'tss-akritiraj',
      displayName: 'Akriti',
      domains: ['inventory'],
    },
    {
      githubUsername: 'tss-devanshsaxena',
      displayName: 'Devansh',
      domains: ['order'],
    },
  ];

  it('matches first name to tss-akritiraj login', () => {
    const r = matchDevelopers('Akriti', directory, displayFromGithub);
    expect(r.status).toBe('matched');
    if (r.status === 'matched') expect(r.profile.githubUsername).toBe('tss-akritiraj');
  });

  it('matches github login fragment', () => {
    const r = matchDevelopers('akritiraj', directory, displayFromGithub);
    expect(r.status).toBe('matched');
    if (r.status === 'matched') expect(r.profile.githubUsername).toBe('tss-akritiraj');
  });

  it('returns not_found for unknown', () => {
    expect(matchDevelopers('zzzzunknown', directory, displayFromGithub).status).toBe('not_found');
  });

  it('ambiguous when multiple rahuls match', () => {
    const many = [
      ...directory,
      { githubUsername: 'tss-rahuljaisheel', displayName: 'Rahul Jaisheel', domains: [] },
      { githubUsername: 'tss-rahuljha', displayName: 'Rahul Jha', domains: [] },
    ];
    const r = matchDevelopers('rahul', many, displayFromGithub);
    expect(r.status).toBe('ambiguous');
  });

  it('accepts explicit tss- login without directory entry', () => {
    const r = matchDevelopers('tss-vishwasbellani', [], displayFromGithub);
    expect(r.status).toBe('matched');
    if (r.status === 'matched') expect(r.profile.githubUsername).toBe('tss-vishwasbellani');
  });

  it('parses embedded github login', () => {
    expect(parseExplicitGithubLogin('what about tss-vishwasbellani')).toBe('tss-vishwasbellani');
  });
});
