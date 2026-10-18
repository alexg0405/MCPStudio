import { useMemo, useRef, useState, type ReactNode } from 'react';
import type { PluginUIProps } from '@agstudio/sdk';
import { Section } from '@agstudio/sdk/ui';
import {
  bandLimit,
  encodeWav,
  framesOfState,
  invertFrame,
  MAX_FRAMES,
  newFrame,
  normalizeFrame,
  removeDc,
  reverseFrame,
  smoothFrame,
  userTableState,
  type Frame,
  type UserTableState,
} from '@agstudio/sdk/dsp/wavetable-frames';
import { FrameStrip } from './frame-strip';
import { HarmonicPad } from './harmonic-pad';
import type { wavetableParams } from './params';
import { oscParam, USER_TABLE } from './params';
import {
  addFrameAfter,
  basicShapesTable,
  fillBetween,
  moveFrame,
  removeFrameAt,
  replaceFrame,
  startingFrame,
  STARTING_SHAPES,
  type StartingShape,
  type TableEdit,
} from './table-edit';
import { framesFromAudio, readTableAudio, type ImportMode } from './table-import';
import styles from './table-editor.module.css';
import { WavePad } from './wave-pad';

type Props = PluginUIProps<typeof wavetableParams, UserTableState>;

/** Band-limit choices (highest harmonic kept) and slice counts offered in the drop-downs. */
const LIMITS = [8, 16, 32, 64, 128] as const;
const SLICE_COUNTS = [4, 8, 16, 32] as const;
const FILL_COUNTS = [1, 3, 7] as const;
/** Smoothing applied by one click of the Smooth button (0–1 of the smoothing range). */
const SMOOTH_STEP = 0.35;

function Button({
  children,
  hint,
  onClick,
  disabled,
}: {
  children: ReactNode;
  hint: string;
  onClick(): void;
  disabled?: boolean;
}) {
  return (
    <button type="button" tabIndex={-1} className={styles.button} disabled={disabled} onClick={onClick} data-hint={hint}>
      {children}
    </button>
  );
}

function Pick<T extends number | string>({
  value,
  options,
  label,
  hint,
  onChange,
}: {
  value: T;
  options: readonly (readonly [T, string])[];
  label: string;
  hint: string;
  onChange(value: T): void;
}) {
  return (
    <select
      className={styles.select}
      value={String(value)}
      aria-label={label}
      data-hint={hint}
      onChange={(e) => {
        const picked = options.find(([v]) => String(v) === e.target.value);
        if (picked) onChange(picked[0]);
      }}
    >
      {options.map(([v, text]) => (
        <option key={String(v)} value={String(v)}>
          {text}
        </option>
      ))}
    </select>
  );
}

/** Saves bytes as a file through the browser's download. */
function download(bytes: Uint8Array, name: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'audio/wav' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * The editor of the Wavetable's own table ("My table"): draw frames, edit their harmonics, tidy them with the tools,
 * fill in morphs, import a single cycle or a whole table from a WAV, slice a sample into frames and export the result.
 * Every button is one undo step; the table is stored in the plugin's state and heard as soon as an oscillator's Table
 * is set to "My table".
 */
export function TableEditor({ ui }: { ui: Props }) {
  const frames = useMemo(() => framesOfState(ui.state), [ui.state]);
  const [pickedFrame, setPickedFrame] = useState(0);
  const selected = Math.max(0, Math.min(frames.length - 1, pickedFrame));
  const [note, setNote] = useState('');
  const [limit, setLimit] = useState<number>(32);
  const [sliceCount, setSliceCount] = useState<number>(8);
  const [fillCount, setFillCount] = useState<number>(3);
  const fileInput = useRef<HTMLInputElement>(null);
  const importMode = useRef<ImportMode>({ kind: 'cycles' });
  const frame = frames[selected];

  const commit = (edit: TableEdit) => {
    setPickedFrame(edit.selected);
    ui.setState(userTableState(edit.frames));
  };
  const editSelected = (change: (f: Frame) => Frame) => {
    if (frame) commit(replaceFrame(frames, selected, change(frame)));
  };

  const importFile = async (file: File, mode: ImportMode) => {
    const audio = await readTableAudio(file);
    if (!audio) {
      setNote(`“${file.name}” is not audio the browser can read (try a WAV).`);
      return;
    }
    const made = framesFromAudio(audio, mode);
    if (made.length === 0) {
      setNote(`“${file.name}” has no audio in it.`);
      return;
    }
    commit({ frames: made, selected: 0 });
    setNote(
      mode.kind === 'slices'
        ? `Sliced “${file.name}” into ${made.length} frames.`
        : `Imported “${file.name}”: ${made.length} frame${made.length === 1 ? '' : 's'}${made.length === MAX_FRAMES ? ' (the most a table holds)' : ''}.`,
    );
  };
  const chooseFile = (mode: ImportMode) => {
    importMode.current = mode;
    fileInput.current?.click();
  };

  const markers = [1, 2].flatMap((n) => {
    const id = oscParam(n);
    const isHeard = ui.values[id.table] === USER_TABLE && Number(ui.values[id.level]) > 0;
    return isHeard ? [{ position: Number(ui.values[id.position]), label: `Osc ${n}` }] : [];
  });
  const usedBy = [1, 2].filter((n) => ui.values[oscParam(n).table] === USER_TABLE);

  return (
    <Section
      title="My table: draw, import or slice your own wavetable"
      hint="Your own wavetable: key frames that the oscillator morphs through. Set an oscillator's Table to “My table” to hear it"
      wide
    >
      <input
        ref={fileInput}
        type="file"
        accept="audio/*,.wav"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void importFile(file, importMode.current);
        }}
      />
      <div className={styles.editor}>
        <p className={styles.status} data-hint="Which oscillators play this table">
          {usedBy.length === 0 ? (
            <>
              No oscillator plays this table yet.{' '}
              {[1, 2].map((n) => (
                <button
                  key={n}
                  type="button"
                  tabIndex={-1}
                  className={styles.link}
                  onClick={() => ui.setParam(oscParam(n).table, USER_TABLE)}
                  data-hint={`Set oscillator ${n}'s Table to “My table” so you hear what you draw`}
                >
                  Use it in Osc {n}
                </button>
              ))}
            </>
          ) : (
            `Playing in Osc ${usedBy.join(' and Osc ')}. Move its Position to morph through the frames.`
          )}
        </p>
        {!frame ? (
          <div className={styles.empty} data-hint="No table yet: start one with a button here">
            <p>
              No table of your own yet. Start from a sine and draw on it, from the four basic shapes, or import a WAV
              (a single cycle, a table, or a sample to slice into frames).
            </p>
            <div className={styles.row}>
              <Button hint="Start a one-frame table of a sine wave, ready to draw on" onClick={() => commit(addFrameAfter([], 0))}>
                Start with a sine
              </Button>
              <Button
                hint="Start a four-frame table: sine, triangle, saw and square, that you can reshape"
                onClick={() => commit({ frames: basicShapesTable(), selected: 0 })}
              >
                Start from basic shapes
              </Button>
              <Button hint="Import a single-cycle WAV, or a WAV made of cycles one after another" onClick={() => chooseFile({ kind: 'cycles' })}>
                Import a WAV…
              </Button>
              <Button
                hint="Cut an audio sample into equal parts and read each part as one frame, so the table morphs through the sample"
                onClick={() => chooseFile({ kind: 'slices', count: sliceCount })}
              >
                Slice a sample…
              </Button>
            </div>
          </div>
        ) : (
          <>
            <FrameStrip frames={frames} selected={selected} onSelect={setPickedFrame} markers={markers} />
            <div className={styles.row} data-hint="Add, remove and order the key frames; the oscillator morphs between neighbours">
              <Button
                hint="Add a copy of this frame after it (a table holds up to 32 frames)"
                disabled={frames.length >= MAX_FRAMES}
                onClick={() => commit(addFrameAfter(frames, selected))}
              >
                Add frame
              </Button>
              <Button hint="Remove this frame (the last one stays)" disabled={frames.length <= 1} onClick={() => commit(removeFrameAt(frames, selected))}>
                Delete frame
              </Button>
              <Button hint="Move this frame one place earlier (lower position)" disabled={selected === 0} onClick={() => commit(moveFrame(frames, selected, -1))}>
                ◀ Earlier
              </Button>
              <Button
                hint="Move this frame one place later (higher position)"
                disabled={selected >= frames.length - 1}
                onClick={() => commit(moveFrame(frames, selected, 1))}
              >
                Later ▶
              </Button>
              <Button
                hint="Insert frames between this one and the next, stepping evenly from one to the other (an exact morph you can then edit)"
                disabled={selected >= frames.length - 1 || frames.length >= MAX_FRAMES}
                onClick={() => commit(fillBetween(frames, selected, fillCount))}
              >
                Fill between
              </Button>
              <Pick<number>
                value={fillCount}
                options={FILL_COUNTS.map((n) => [n, `${n} frame${n === 1 ? '' : 's'}`] as const)}
                label="Frames to fill in"
                hint="How many in-between frames “Fill between” inserts"
                onChange={setFillCount}
              />
            </div>
            <WavePad
              frames={frames}
              selected={selected}
              onCommit={(f) => editSelected(() => f)}
              onDropFile={(file) => void importFile(file, { kind: 'cycles' })}
            />
            <div className={styles.row} data-hint="Tools for the selected frame">
              <Button hint="Soften the shape: removes the highest harmonics a little more each click" onClick={() => editSelected((f) => smoothFrame(f, SMOOTH_STEP))}>
                Smooth
              </Button>
              <Button hint="Make the frame as loud as the table allows: its highest peak becomes 1 (the synth also levels every frame)" onClick={() => editSelected((f) => normalizeFrame(f))}>
                Normalize
              </Button>
              <Button hint="Remove the DC offset: the shape then rises and falls equally around the middle line" onClick={() => editSelected(removeDc)}>
                Remove DC
              </Button>
              <Button hint="Turn the shape upside down" onClick={() => editSelected(invertFrame)}>
                Invert
              </Button>
              <Button hint="Play the shape backwards (mirror left to right)" onClick={() => editSelected(reverseFrame)}>
                Reverse
              </Button>
              <Button hint="Remove every harmonic above the number chosen, with an FFT: tames corners, clicks and hiss" onClick={() => editSelected((f) => bandLimit(f, limit))}>
                Band-limit to
              </Button>
              <Pick<number>
                value={limit}
                options={LIMITS.map((n) => [n, `${n} harmonics`] as const)}
                label="Highest harmonic to keep"
                hint="The harmonic above which “Band-limit” removes everything (the note's pitch is harmonic 1)"
                onChange={setLimit}
              />
              <Pick<StartingShape | ''>
                value=""
                options={[['', 'Replace with…'] as const, ...STARTING_SHAPES]}
                label="Replace this frame with a shape"
                hint="Throw this frame away and start it again from a sine, triangle, saw, square, pulse or random shape"
                onChange={(shape) => shape && editSelected(() => startingFrame(shape))}
              />
              <Button hint="Empty this frame (silent until you draw on it)" onClick={() => editSelected(newFrame)}>
                Clear
              </Button>
            </div>
            {frame && <HarmonicPad frame={frame} onCommit={(f) => editSelected(() => f)} />}
            <div className={styles.row} data-hint="Bring audio in, or take the table out">
              <Button
                hint="Import a single-cycle WAV (one frame), or a WAV of cycles one after another (a table, up to 32 frames). Replaces the table"
                onClick={() => chooseFile({ kind: 'cycles' })}
              >
                Import WAV…
              </Button>
              <Button
                hint="Cut an audio file into equal parts and read each as one frame, so the table morphs through the sample. Replaces the table"
                onClick={() => chooseFile({ kind: 'slices', count: sliceCount })}
              >
                Slice a sample into
              </Button>
              <Pick<number>
                value={sliceCount}
                options={SLICE_COUNTS.map((n) => [n, `${n} frames`] as const)}
                label="Frames to slice into"
                hint="How many equal parts “Slice a sample” cuts the audio into"
                onChange={setSliceCount}
              />
              <Button
                hint="Save the table as a WAV (32-bit float, 2048 samples per frame) that Serum and Vital can also load"
                onClick={() => download(encodeWav(frames), 'my-wavetable.wav')}
              >
                Export WAV
              </Button>
            </div>
          </>
        )}
        {note && (
          <p className={styles.status} role="status" data-hint="What the last import did">
            {note}
          </p>
        )}
      </div>
    </Section>
  );
}
