import { disambiguateByNameParts, matchDevelopers } from '../src/services/developerMatch';

describe('developerMatch disambiguation', () => {
  const directory = [
    {
      githubUsername: 'tss-devanshsaxena',
      displayName: 'Devansh Saxena',
      domains: [],
    },
    {
      githubUsername: 'tss-devanshuborkar',
      displayName: 'Devansh Borkar',
      domains: [],
    },
  ];

  it('prefers login with surname for full name query', () => {
    const result = matchDevelopers('Devansh Saxena', directory, l => l);
    expect(result.status).toBe('matched');
    if (result.status === 'matched') {
      expect(result.profile.githubUsername).toBe('tss-devanshsaxena');
    }
  });

  it('disambiguates by name parts', () => {
    const picked = disambiguateByNameParts('Devansh Saxena', directory);
    expect(picked?.githubUsername).toBe('tss-devanshsaxena');
  });
});
