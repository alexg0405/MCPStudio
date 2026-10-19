import { current, isDraft, type Draft } from 'immer';
import type { Project } from '@core/model/types';

/**
 * The draft as plain data. The arranger's whole-song reads (what plays where, sections, the check)
 * are several times faster on plain objects than through immer's proxies; take a new one after an edit.
 */
export const plain = (d: Draft<Project>): Project => (isDraft(d) ? (current(d) as unknown as Project) : (d as unknown as Project));
