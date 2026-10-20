/** What the Convert to MIDI commands and the dialog do: run the conversion and say what happened as a toast. */
import type { Services } from '@app/services';
import { convertToMidi, TranscribeError, type ConvertResult, type ConvertSpec } from '@app/transcribe/convert';
import { TranscribeJobError } from '@app/transcribe/jobs';
import { TranscribePlanError } from '@core/audio/transcribe';

/** The words of a failed conversion: plain, for a toast. */
export function problemText(e: unknown): string {
  if (e instanceof TranscribeError || e instanceof TranscribePlanError || e instanceof TranscribeJobError || e instanceof Error) return e.message;
  return String(e);
}

/** Converts with a toast for the start and for the result (or the problem). Resolves with what was made, or null when it failed. */
export async function runConvert(s: Services, spec: ConvertSpec): Promise<ConvertResult | null> {
  const session = s.session.getState();
  session.toast('Listening to the audio and writing the notes…');
  try {
    const result = await convertToMidi(s, spec);
    session.toast(result.message);
    return result;
  } catch (e) {
    session.toast(problemText(e), 'error');
    return null;
  }
}
