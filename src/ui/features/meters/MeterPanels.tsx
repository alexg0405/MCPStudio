/** The three panels of the Meters window: loudness, stereo, and spectrum with spectrogram. The controller draws into their canvases and fills their readouts. */
import styles from './Meters.module.css';

/** One number in the loudness panel (the controller writes its value). */
function Readout({ name, label, hint, unit }: { name: string; label: string; hint: string; unit: string }) {
  return (
    <div className={styles.readout} data-hint={hint}>
      <span className={styles.readoutLabel}>{label}</span>
      <b className={styles.readoutValue} data-meter={name} data-state="none">
        −∞
      </b>
      <span className={styles.readoutUnit}>{unit}</span>
    </div>
  );
}

/** Momentary, short-term and integrated loudness, range and true peak, with the loudness history graph. */
export function LoudnessPanel() {
  return (
    <section className={styles.panel}>
      <h3 className={styles.heading}>Loudness</h3>
      <div className={styles.readouts}>
        <Readout name="momentary" label="Momentary" unit="LUFS" hint="Loudness of the last 0.4 seconds (LUFS, EBU R128). Jumps with every beat" />
        <Readout name="shortTerm" label="Short-term" unit="LUFS" hint="Loudness of the last 3 seconds (LUFS): the number to watch while mixing" />
        <Readout name="integrated" label="Integrated" unit="LUFS" hint="Loudness of everything since the song started playing (LUFS, gated): what streaming services measure" />
        <Readout name="range" label="Range" unit="LU" hint="Loudness range (LU): how far the loud and quiet parts are apart. Under 4 is squashed, over 12 is very dynamic" />
        <Readout name="truePeak" label="True peak" unit="dBTP" hint="The highest level between the samples (4× oversampled), since the song started playing. Keep it under −1 dBTP" />
      </div>
      <p className={styles.target} data-meter="target" data-hint="The dashed line on the graph: where your loudness should end up. Change it with Target above" />
      <div className={styles.moreReadouts}>
        <span data-hint="True peak of the left channel, held (dBTP)">
          L peak <b data-meter="peakL" data-state="none">−∞</b>
        </span>
        <span data-hint="True peak of the right channel, held (dBTP)">
          R peak <b data-meter="peakR" data-state="none">−∞</b>
        </span>
        <span data-hint="The loudest momentary (0.4 s) loudness since the song started playing (LUFS)">
          Max momentary <b data-meter="maxMomentary">−∞</b>
        </span>
        <span data-hint="The loudest short-term (3 s) loudness since the song started playing (LUFS)">
          Max short-term <b data-meter="maxShortTerm">−∞</b>
        </span>
      </div>
      <div className={styles.canvasBox} data-hint="Loudness over time: bold line short-term, thin line momentary (LUFS); the dashed line is the target">
        <canvas className={styles.canvas} data-canvas="history" />
        <div className={styles.idle} data-meter="idle">
          Press play: the loudness is measured from the moment the song starts, and drawn here.
        </div>
        <div className={styles.idle} data-meter="unavailable" hidden>
          The meters need the audio engine and cross-origin isolation: run AGstudio from its own server and click the page once.
        </div>
      </div>
    </section>
  );
}

/** The goniometer, correlation and band widths. */
export function StereoPanel() {
  return (
    <section className={styles.panel}>
      <h3 className={styles.heading}>Stereo</h3>
      <div className={styles.stereo}>
        <div className={styles.gonioBox} data-hint="Goniometer: a straight vertical line is mono, a wide cloud is stereo, a horizontal line is out of phase (it will vanish in mono)">
          <canvas className={styles.canvas} data-canvas="gonio" />
        </div>
        <div className={styles.barsBox} data-hint="Correlation: +1 mono, 0 unrelated channels, −1 out of phase. Width: how much of each band (low under 150 Hz, mid, high over 2 kHz) is side signal, 0 to 100 %">
          <canvas className={styles.canvas} data-canvas="bars" />
        </div>
      </div>
      <p className={styles.warning} data-meter="warning" hidden />
    </section>
  );
}

/** The spectrum with its peak hold and the reference's tone line, and the spectrogram below it. */
export function SpectrumPanel() {
  return (
    <section className={styles.panel}>
      <h3 className={styles.heading}>Spectrum</h3>
      <div className={styles.canvasBox} data-hint="Spectrum in 1/6-octave bands (dB; 0 dB is a full-scale tone): low notes left, highs right. The thin line is the peak hold; a dashed line is your reference song's tone">
        <canvas className={styles.canvas} data-canvas="spectrum" />
      </div>
      <p className={styles.note} data-meter="referenceNote" hidden>
        Dashed line: the tonal balance of your reference song, at the level you are playing.
      </p>
      <h3 className={styles.heading}>Spectrogram</h3>
      <div className={styles.canvasBox} data-hint="The spectrum over time: the newest moment is on the right, highs are up, brighter is louder">
        <canvas className={styles.canvas} data-canvas="spectrogram" />
      </div>
    </section>
  );
}
