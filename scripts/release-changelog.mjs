#!/usr/bin/env node
/**
 * Promotes the `Unreleased` section of CHANGELOG.md into a released section.
 *
 * The release workflow runs this after bumping the version, so the file on
 * `main` keeps describing what was actually published instead of accumulating
 * everything under `Unreleased` forever.
 *
 * Prints one word so the caller knows what happened:
 *   promoted — the section was moved and the compare links rewritten
 *   empty    — `Unreleased` had nothing in it, so the file was left alone
 *
 * Usage: node scripts/release-changelog.mjs <version> <YYYY-MM-DD>
 */

import { readFileSync, writeFileSync } from "node:fs";

const [version, date] = process.argv.slice(2);

if (!version || !date) {
  console.error("usage: release-changelog.mjs <version> <YYYY-MM-DD>");
  process.exit(2);
}

const FILE = "CHANGELOG.md";
const HEADING = "## [Unreleased]";

const original = readFileSync(FILE, "utf8");

const start = original.indexOf(HEADING);
if (start === -1) {
  console.error(`${FILE} has no "${HEADING}" heading.`);
  process.exit(1);
}

// The body runs from the end of the heading to the next `## ` heading. The
// link-reference block at the bottom starts with `[`, so it is never mistaken
// for a section.
const bodyStart = start + HEADING.length;
const nextHeading = original.indexOf("\n## ", bodyStart);
const bodyEnd = nextHeading === -1 ? original.length : nextHeading + 1;
const body = original.slice(bodyStart, bodyEnd);

if (body.trim() === "") {
  console.log("empty");
  process.exit(0);
}

const released = `## [${version}] - ${date}\n\n${body.trim()}\n\n`;

let updated =
  original.slice(0, start) + `${HEADING}\n\n` + released + original.slice(bodyEnd);

// Repoint `[unreleased]` at the new tag and add a compare link for this
// version, reusing whatever host and repository path the file already uses.
const unreleasedLink = /^\[unreleased\]:\s*(\S+?)\/compare\/(\S+?)\.\.\.HEAD\s*$/im;
const match = updated.match(unreleasedLink);

if (!match) {
  console.error(`${FILE} has no "[unreleased]: .../compare/<tag>...HEAD" link.`);
  process.exit(1);
}

const [, base, previousTag] = match;

updated = updated.replace(
  unreleasedLink,
  `[unreleased]: ${base}/compare/v${version}...HEAD\n` +
    `[${version}]: ${base}/compare/${previousTag}...v${version}`
);

writeFileSync(FILE, updated);
console.log("promoted");
