/** Saving and opening controller mapping files (JSON) from the Controllers window. */
import { downloadBytes, uploadFile } from '@platform/fs-access';

/** Downloads a mapping as "<device>.agcontroller.json". */
export function saveMappingFile(deviceName: string, json: string): void {
  const safe = deviceName.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'controller';
  downloadBytes(`${safe}.agcontroller.json`, new TextEncoder().encode(json), 'application/json');
}

/** Asks for a mapping file; its text, or null if cancelled. */
export async function pickMappingFile(): Promise<string | null> {
  const file = await uploadFile('.json,application/json');
  return file ? await file.text() : null;
}
