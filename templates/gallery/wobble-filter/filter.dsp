// Wobble Filter: a resonant low-pass filter whose cutoff is swept up and down by a slow wave.
// Each control becomes a knob (label, range, [unit:…], [scale:log], [tooltip:…]); "[1]", "[2]"… set their order.
import("stdfaust.lib");

cutoff = hslider("[1]Cutoff [unit:Hz] [scale:log] [tooltip:The middle of the sweep: frequencies above it are cut]", 900, 60, 12000, 1) : si.smoo;
resonance = hslider("[2]Resonance [tooltip:How much the filter rings at the cutoff]", 3, 0.5, 12, 0.01) : si.smoo;
rate = hslider("[3]Rate [unit:Hz] [scale:log] [tooltip:How fast the cutoff moves up and down]", 2, 0.05, 12, 0.01) : si.smoo;
depth = hslider("[4]Depth [tooltip:How far the cutoff moves, in octaves each way]", 1.5, 0, 4, 0.01) : si.smoo;
mix = hslider("[5]Mix [tooltip:0 = dry, 1 = only the filter]", 1, 0, 1, 0.01) : si.smoo;

// The wave swings the cutoff by `depth` octaves each way around the middle; the clamp keeps the filter stable.
sweep = pow(2.0, os.osc(rate) * depth);
moving = max(40, min(16000, cutoff * sweep));

channel = _ <: fi.resonlp(moving, resonance, 1) * mix, _ * (1 - mix) :> _;

// Two inputs, two outputs: a stereo effect.
process = channel, channel;
