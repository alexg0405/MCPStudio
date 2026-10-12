import { p } from '@agstudio/sdk/params';

export const ID = '__PLUGIN_ID__';

export const params = {
  drive: p.float(0, 24, 6, { label: 'Drive', unit: 'dB' }),
  mix: p.float(0, 1, 1, { label: 'Mix', unit: '%' }),
};
