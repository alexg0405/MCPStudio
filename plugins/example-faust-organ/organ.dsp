// An organ voice in Faust: three drawbars (sine partials), a soft attack, and key click.
// freq, gain and gate are played by notes; "[1]", "[2]"… set the knobs' order.
import("stdfaust.lib");

freq = hslider("freq", 440, 20, 20000, 0.01);
gain = hslider("gain", 0.8, 0, 1, 0.01);
gate = button("gate");

low = hslider("[1]Low drawbar [tooltip:The note an octave down]", 0.6, 0, 1, 0.01) : si.smoo;
mid = hslider("[2]Middle drawbar [tooltip:The note itself]", 0.8, 0, 1, 0.01) : si.smoo;
high = hslider("[3]High drawbar [tooltip:The note an octave up]", 0.4, 0, 1, 0.01) : si.smoo;
click = hslider("[4]Key click [tooltip:A short tick when a key goes down]", 0.15, 0, 1, 0.01);
release = hslider("[5]Release [unit:s] [tooltip:Fade-out after a key goes up]", 0.08, 0.01, 2, 0.01);

partials = os.osc(freq / 2) * low + os.osc(freq) * mid + os.osc(freq * 2) * high;
envelope = en.asr(0.004, 1, release, gate);
tick = no.noise * en.ar(0.0005, 0.008, gate) * click;

process = (partials * envelope + tick) * gain * 0.22;
