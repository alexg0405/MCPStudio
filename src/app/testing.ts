import { FakeEngine } from '@engine/fake-engine';
import { createServices, type ServiceOptions, type Services } from './services';

/** Services with a FakeEngine (no audio) for Node tests of UI-level logic. */
export function createTestServices(
  opts: Omit<ServiceOptions, 'createEngine'> = {},
): Services & { fakeEngine: FakeEngine } {
  const engine = new FakeEngine();
  const services = createServices({ platform: 'mac', ...opts, createEngine: () => engine });
  return Object.assign(services, { fakeEngine: engine });
}
