// __PLUGIN_NAME__: one voice. freq, gain and gate are played by notes (Faust's polyphony convention).
// "[1]", "[2]"… set the knobs' order (Faust sorts them by label otherwise).
import("stdfaust.lib");

freq = hslider("freq", 440, 20, 20000, 0.01);
gain = hslider("gain", 0.8, 0, 1, 0.01);
gate = button("gate");

cutoff = hslider("[1]Cutoff [unit:Hz] [scale:log] [tooltip:Brightness of the sound]", 2400, 100, 16000, 1) : si.smoo;
attack = hslider("[2]Attack [unit:s] [tooltip:Fade-in time when a note starts]", 0.005, 0.001, 2, 0.001);
release = hslider("[3]Release [unit:s] [tooltip:Fade-out time after a note ends]", 0.3, 0.01, 4, 0.01);

envelope = en.adsr(attack, 0.25, 0.7, release, gate);

// One output: AGstudio pans each note.
process = os.sawtooth(freq) * envelope * gain * 0.3 : fi.lowpass(2, cutoff);
