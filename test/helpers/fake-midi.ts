/** A fake `MIDIAccess` with devices you can push messages into and whose output you can read (LEDs). */

export class FakeMidiInput extends EventTarget {
  readonly type = 'input';
  state: 'connected' | 'disconnected' = 'connected';
  /** Set by `open()`: with addEventListener a real port only delivers messages once it is open. */
  opened = false;
  constructor(
    readonly id: string,
    readonly name: string,
  ) {
    super();
  }
  open(): Promise<this> {
    this.opened = true;
    return Promise.resolve(this);
  }
  /** The controller sends a message (nothing is delivered while the port is closed, as in Chrome). */
  emit(bytes: number[]): void {
    if (!this.opened) return;
    const e = new Event('midimessage');
    Object.defineProperty(e, 'data', { value: new Uint8Array(bytes) });
    this.dispatchEvent(e);
  }
}

export class FakeMidiOutput {
  readonly type = 'output';
  state: 'connected' | 'disconnected' = 'connected';
  /** Everything sent to the device. */
  readonly sent: number[][] = [];
  constructor(
    readonly id: string,
    readonly name: string,
  ) {}
  send(data: number[] | Uint8Array): void {
    this.sent.push([...data]);
  }
  clear(): void {
    this.sent.length = 0;
  }
}

export class FakeMidiAccess {
  readonly inputs = new Map<string, FakeMidiInput>();
  readonly outputs = new Map<string, FakeMidiOutput>();
  onstatechange: (() => void) | null = null;
  readonly sysexEnabled = false;

  /** Plugs a device in (input and output with the same name, like a real controller). */
  plug(name: string, opts: { output?: boolean } = {}): { input: FakeMidiInput; output: FakeMidiOutput | null } {
    const input = new FakeMidiInput(`in-${name}`, name);
    this.inputs.set(input.id, input);
    let output: FakeMidiOutput | null = null;
    if (opts.output !== false) {
      output = new FakeMidiOutput(`out-${name}`, name);
      this.outputs.set(output.id, output);
    }
    this.onstatechange?.();
    return { input, output };
  }

  unplug(name: string): void {
    this.inputs.delete(`in-${name}`);
    this.outputs.delete(`out-${name}`);
    this.onstatechange?.();
  }

  /** As the `requestAccess` option of the controllers. */
  asAccess(): MIDIAccess {
    return this as unknown as MIDIAccess;
  }
}

/** Raw message builders. */
export const msg = {
  noteOn: (ch: number, note: number, vel = 127) => [0x90 | ch, note, vel],
  noteOff: (ch: number, note: number) => [0x80 | ch, note, 0],
  cc: (ch: number, cc: number, v: number) => [0xb0 | ch, cc, v],
};
