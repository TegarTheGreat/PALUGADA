/**
 * Which PALUGADA this is: package.json's version, read once. Said on the
 * health page, in the metrics as `palugada_build_info`, on every span sent
 * to a collector, and at the foot of the owner's menu, so "which version is
 * running" has one answer anyone can read without a shell. What each version
 * holds is in CHANGELOG.md.
 */
import { readFileSync } from 'node:fs';

export const VERSION: string = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
