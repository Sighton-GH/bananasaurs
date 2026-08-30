#!/usr/bin/env node
import os from 'node:os';
import process from 'node:process';
import { run } from './run.js';

/**
 * The `bananasaurs` binary.
 *
 * Deliberately four lines of substance: everything decidable lives in `run.ts`
 * so it can be tested, and this is the shell that hands it the real process.
 *
 * It does not read `.env`. The daemon owns the configuration; the only thing
 * this needs is where the socket is, which comes from the environment or
 * `--socket`. A CLI that parsed `.env` would be a second reader of the bot
 * token for no reason at all.
 */

const currentUser = (): string | undefined => {
  try {
    return os.userInfo().username;
  } catch {
    // No passwd entry — a container, usually. The claim is optional, and an
    // audit row saying nothing is better than one saying something invented.
    return undefined;
  }
};

void run({
  argv: process.argv.slice(2),
  env: process.env,
  unixUser: currentUser(),
  writeOut: (text) => process.stdout.write(text),
  writeErr: (text) => process.stderr.write(text),
}).then((code) => {
  process.exitCode = code;
});
