// __PLUGIN_NAME__: each control becomes a knob (label, range, [unit:…], [scale:log], [tooltip:…]).
// "[1]", "[2]"… set the knobs' order (Faust sorts them by label otherwise).
import("stdfaust.lib");

cutoff = hslider("[1]Cutoff [unit:Hz] [scale:log] [tooltip:Frequencies above this are cut]", 2000, 40, 18000, 1) : si.smoo;
resonance = hslider("[2]Resonance [tooltip:How much the cutoff rings]", 1, 0.5, 12, 0.01) : si.smoo;
mix = hslider("[3]Mix [tooltip:0 = dry, 1 = only the filter]", 1, 0, 1, 0.01) : si.smoo;

filter = fi.resonlp(cutoff, resonance, 1);
channel = _ <: filter * mix, _ * (1 - mix) :> _;

// Two inputs, two outputs: a stereo effect.
process = channel, channel;
