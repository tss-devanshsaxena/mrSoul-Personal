import {
  parseRaiseTicketAssignee,
  isTicketApproval,
  isTicketRejection,
  normalizeRaiseTicketText,
} from '../src/utils/ticketFlowParser';

describe('ticketFlowParser', () => {
  it('parses good to go raise ticket', () => {
    expect(
      parseRaiseTicketAssignee('Good to go raise this ticket to: Akriti')
    ).toBe('Akriti');
    expect(parseRaiseTicketAssignee('raise ticket to tss-vishwasbellani')).toBe(
      'tss-vishwasbellani'
    );
  });

  it('handles typos and missing colon', () => {
    expect(
      parseRaiseTicketAssignee('Good to go riase this ticket to tss-devanshsaxena')
    ).toBe('tss-devanshsaxena');
    expect(
      parseRaiseTicketAssignee('Good to go raise this ticket to Devansh Saxena')
    ).toBe('Devansh Saxena');
  });

  it('does not treat raise message as approval', () => {
    expect(isTicketApproval('Good to go raise this ticket to: Devansh')).toBe(false);
  });

  it('detects approval and rejection', () => {
    expect(isTicketApproval('approve')).toBe(true);
    expect(isTicketApproval('Looks good, approve')).toBe(true);
    expect(isTicketRejection('reject')).toBe(true);
    expect(isTicketRejection('cancel please')).toBe(true);
  });

  it('normalizes riase typo', () => {
    expect(normalizeRaiseTicketText('Good to go riase this ticket')).toContain('raise');
  });
});
