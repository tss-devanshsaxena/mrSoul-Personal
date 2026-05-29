import { parseAccessAdminCommand, normalizeEmail } from '../src/utils/accessCommands';

describe('accessCommands', () => {
  it('parses grant and revoke', () => {
    expect(
      parseAccessAdminCommand('@MrSoul grant access jaynam.mehta@thesouledstore.com member')
    ).toEqual({
      kind: 'grant',
      email: 'jaynam.mehta@thesouledstore.com',
      role: 'member',
    });
    expect(
      parseAccessAdminCommand('revoke access saif.khan@thesouledstore.com')
    ).toEqual({
      kind: 'revoke',
      email: 'saif.khan@thesouledstore.com',
    });
  });

  it('normalizes email', () => {
    expect(normalizeEmail(' Devansh.Saxena@TheSouledStore.com ')).toBe(
      'devansh.saxena@thesouledstore.com'
    );
  });
});
