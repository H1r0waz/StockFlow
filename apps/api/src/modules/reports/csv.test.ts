import { describe, expect, it } from 'vitest';
import { csvCell, serializeCsv } from './csv.js';

describe('spreadsheet-safe CSV', () => {
  it.each([
    '=1+1',
    '+SUM(A1)',
    '-1',
    '@SUM(A1)',
    '   =1',
    '\t=1',
    '\n=1',
    '\rtext',
    '\u0000text',
  ])('neutralizes hostile prefix %j', (value) =>
    expect(csvCell(value)).toBe(`"'${value}"`),
  );
  it('preserves ordinary Unicode, exact decimals, empty values and CSV structure', () => {
    expect(
      serializeCsv(
        ['Name', 'Quantity', 'Empty'],
        [
          {
            Name: 'Café, "fine"\nflour',
            Quantity: '12345678901234.123456',
            Empty: null,
          },
        ],
      ),
    ).toBe(
      '\ufeff"Name","Quantity","Empty"\r\n"Café, ""fine""\nflour","12345678901234.123456",""\r\n',
    );
  });
  it('uses only explicitly listed columns', () => {
    expect(
      serializeCsv(['Name'], [{ Name: 'Safe', secret: 'hidden' }]),
    ).not.toContain('hidden');
  });
});
