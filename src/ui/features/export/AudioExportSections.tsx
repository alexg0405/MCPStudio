import { MP3_BITRATES, type AudioExportSettings } from '@app/export/audio-export';
import type { PrefsState } from '@app/stores/prefs';
import type { StemPlan } from '@core/query/stems';
import styles from './ExportDialog.module.css';
import { CODECS, codecInfo, mp3BitrateLabel, WAV_DEPTHS, type RangeChoice, type RangeOption } from './audio-options';

/** Writes some of the export settings (they live in the prefs). */
type SetPrefs = (patch: Partial<PrefsState>) => void;

interface RangeSectionProps {
  options: readonly RangeOption[];
  choice: RangeChoice;
  onChoose(choice: RangeChoice): void;
  /** True while an export runs: the choices lock. */
  isLocked: boolean;
}

/** The Range fieldset: which part of the song to export, each with how long it is. */
export function RangeSection({ options, choice, onChoose, isLocked }: RangeSectionProps) {
  return (
    <fieldset className={styles.group} disabled={isLocked}>
      <legend>Range</legend>
      {options.map((option) => (
        <label
          key={option.value}
          className={`${styles.option} ${option.info ? '' : styles.optionOff}`}
          data-hint={option.info ? `${option.hint} (${option.info})` : `${option.hint}: not available`}
        >
          <input type="radio" name="range" checked={choice === option.value} disabled={!option.info} onChange={() => onChoose(option.value)} />
          <span>{option.label}</span>
          <span className={styles.meta}>{option.info ?? 'not available'}</span>
        </label>
      ))}
    </fieldset>
  );
}

interface StemsSectionProps {
  settings: AudioExportSettings;
  /** The tracks that would become stem files (empty when nothing plays). */
  stems: readonly StemPlan[];
  set: SetPrefs;
  isLocked: boolean;
}

/** The "What to export" fieldset: the mix as one file, or one file per mixer track. */
export function StemsSection({ settings, stems, set, isLocked }: StemsSectionProps) {
  const hasStems = stems.length > 0;
  return (
    <fieldset className={styles.group} disabled={isLocked}>
      <legend>What to export</legend>
      <label className={styles.option} data-hint="Everything you hear, mixed into one file">
        <input type="radio" name="what" checked={!settings.stems} onChange={() => set({ exportStems: false })} />
        <span>The mix (one file)</span>
      </label>
      <label
        className={`${styles.option} ${hasStems ? '' : styles.optionOff}`}
        data-hint="One file per mixer track that plays something, all the same length, so they line up in another app"
      >
        <input type="radio" name="what" checked={settings.stems} disabled={!hasStems} onChange={() => set({ exportStems: true })} />
        <span>Stems: one file per mixer track</span>
        <span className={styles.meta}>{hasStems ? `${stems.length} track${stems.length === 1 ? '' : 's'}` : 'nothing plays'}</span>
      </label>
      {settings.stems && <StemOptions settings={settings} stems={stems} set={set} />}
    </fieldset>
  );
}

/** What is only shown while stems are chosen: the track list, the master chain switch and where the files go. */
function StemOptions({ settings, stems, set }: { settings: AudioExportSettings; stems: readonly StemPlan[]; set: SetPrefs }) {
  const masterChainNote = settings.masterChain
    ? 'Each stem sounds like it does in the mix. With master effects such as a compressor, stems played together can differ slightly from the mix.'
    : 'Raw stems: they add up exactly to the mix before the master. Best when you mix or master in another app (use 32-bit float WAV if they are loud).';
  return (
    <div className={styles.sub}>
      <p className={styles.note}>{stems.map((s) => s.name).join(' · ')}</p>
      <label
        className={styles.option}
        data-hint="On: each stem goes through the master's effects and volume, like the mix. Off: raw stems that add up exactly to the master's input"
      >
        <input type="checkbox" checked={settings.masterChain} onChange={(e) => set({ exportMasterChain: e.target.checked })} />
        <span>Through the master track (its effects and volume)</span>
      </label>
      <p className={styles.note}>{masterChainNote}</p>
      <div className={styles.row} data-hint="Where the stem files go">
        <label className={styles.option}>
          <input type="radio" name="to" checked={settings.stemsTo === 'folder'} onChange={() => set({ exportStemsTo: 'folder' })} />
          <span>Into a folder</span>
        </label>
        <label className={styles.option}>
          <input type="radio" name="to" checked={settings.stemsTo === 'zip'} onChange={() => set({ exportStemsTo: 'zip' })} />
          <span>As one .zip file</span>
        </label>
      </div>
    </div>
  );
}

interface FormatSectionProps {
  settings: AudioExportSettings;
  /** The WAV bit depth as the prefs store it ('pcm16', 'pcm24', 'float32'). */
  wavDepth: PrefsState['exportFormat'];
  /** The sample rates to offer, and the one in effect (Hz). */
  sampleRates: readonly number[];
  sampleRate: number;
  set: SetPrefs;
  isLocked: boolean;
}

/** The "File format" fieldset: WAV, FLAC or MP3, the quality choice that goes with it, the sample rate and normalize. */
export function FormatSection({ settings, wavDepth, sampleRates, sampleRate, set, isLocked }: FormatSectionProps) {
  const codec = codecInfo(settings.codec);
  return (
    <fieldset className={styles.group} disabled={isLocked}>
      <legend>File format</legend>
      <div className={styles.segmented} role="radiogroup" aria-label="File format">
        {CODECS.map((c) => (
          <button
            key={c.value}
            type="button"
            role="radio"
            aria-checked={settings.codec === c.value}
            className={`${styles.segment} ${settings.codec === c.value ? styles.segmentOn : ''}`}
            onClick={() => set({ exportCodec: c.value })}
            data-hint={`${c.label}: ${c.note}`}
          >
            {c.label}
          </button>
        ))}
      </div>
      <p className={styles.note}>{codec.note}</p>
      <div className={styles.row}>
        {settings.codec === 'wav' && (
          <label className={styles.field} data-hint="Bits per sample: more bits keep more detail in quiet passages">
            Bit depth
            <select value={wavDepth} onChange={(e) => set({ exportFormat: e.target.value as PrefsState['exportFormat'] })}>
              {WAV_DEPTHS.map((d) => (
                <option key={d.value} value={d.value} title={d.hint}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {settings.codec === 'flac' && (
          <label className={styles.field} data-hint="Bits per sample: 16-bit is CD quality (dithered), 24-bit keeps more detail">
            Bit depth
            <select value={settings.flacBits} onChange={(e) => set({ exportFlacBits: Number(e.target.value) })}>
              <option value={16}>16-bit</option>
              <option value={24}>24-bit</option>
            </select>
          </label>
        )}
        {settings.codec === 'mp3' && (
          <label className={styles.field} data-hint="Bit rate in kbps (kilobits per second): higher sounds better and makes bigger files">
            Quality
            <select value={settings.mp3Kbps} onChange={(e) => set({ exportMp3Kbps: Number(e.target.value) })}>
              {MP3_BITRATES.map((kbps) => (
                <option key={kbps} value={kbps}>
                  {mp3BitrateLabel(kbps)}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className={styles.field} data-hint="Samples per second in kHz: 44.1 for music sites and CDs, 48 for video">
          Sample rate
          <select value={sampleRate} onChange={(e) => set({ exportSampleRate: Number(e.target.value) })}>
            {sampleRates.map((hz) => (
              <option key={hz} value={hz}>
                {hz / 1000} kHz
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className={styles.option} data-hint="Turns the whole export up (or down) so its loudest moment peaks at −0.3 dBFS, just under the maximum">
        <input type="checkbox" checked={settings.normalize} onChange={(e) => set({ exportNormalize: e.target.checked })} />
        <span>Normalize: make the loudest moment peak at −0.3 dB</span>
      </label>
      {settings.normalize && settings.stems && <p className={styles.note}>Stems are raised together, by the same amount, so they still add up to the mix.</p>}
    </fieldset>
  );
}
