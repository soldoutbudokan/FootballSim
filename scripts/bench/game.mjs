// Which copy of the game the bench drives: dist/js by default, or the
// directory named by BENCH_SIM (bench.mjs --sim sets it, and its workers
// inherit it). Pointing it at a copy of an older commit compares two
// versions of the defense with the same seeds.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export const dir = process.env.BENCH_SIM
  ? pathToFileURL(resolve(process.env.BENCH_SIM) + '/')
  : new URL('../../dist/js/', import.meta.url);
export const core = await import(new URL('sim.js', dir));
export const plays = await import(new URL('plays.js', dir));
export const STEP = core.STEP ?? 1 / 120;
