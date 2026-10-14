import { describe, expect, it } from 'vitest';
import { formatMeter } from './Meters';

describe('plugin meters', () => {
  it('shows each kind of reading in plain units', () => {
    expect(formatMeter({ reading: 'gr', label: 'GR', kind: 'reduction' }, 3.46)).toBe('−3.5 dB');
    expect(formatMeter({ reading: 'gr', label: 'GR', kind: 'reduction' }, 0)).toBe('0 dB');
    expect(formatMeter({ reading: 'l', label: 'L', kind: 'db' }, -12.34)).toBe('−12.3 dB');
    expect(formatMeter({ reading: 'p', label: 'P', kind: 'hz' }, 220)).toBe('220.0 Hz');
    expect(formatMeter({ reading: 'p', label: 'P', kind: 'hz' }, 0)).toBe('—');
    expect(formatMeter({ reading: 't', label: 'T', kind: 'note' }, 57)).toBe('A4');
    expect(formatMeter({ reading: 't', label: 'T', kind: 'note' }, -1)).toBe('—');
    expect(formatMeter({ reading: 'c', label: 'C', kind: 'cents' }, -35.4)).toBe('−35 ct');
    expect(formatMeter({ reading: 'c', label: 'C', kind: 'cents' }, undefined)).toBe('—');
  });
});
