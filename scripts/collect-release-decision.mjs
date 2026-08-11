#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const RANKS = { skip: 0, patch: 1, minor: 2, major: 3 };
const BUMPS = ["skip", "patch", "minor", "major"];

export function classifyRelease(labels = []) {
  const names = new Set(labels.map((label) => label.name ?? label));

  if (names.has("release:skip")) return "skip";
  if (names.has("release:major")) return "major";
  if (names.has("release:minor")) return "minor";
  return "patch";
}

export function highestRelease(current, candidate) {
  return RANKS[candidate] > RANKS[current] ? candidate : current;
}

function cleanTitle(title) {
  return title.replace(/\s+/g, " ").trim();
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const baseTag = process.env.RELEASE_BASE_TAG;
  const baseBranch = process.env.RELEASE_BASE_BRANCH ?? "main";
  const outputFile = process.env.GITHUB_OUTPUT;

  if (!token || !repository || !baseTag || !outputFile) {
    throw new Error(
      "GITHUB_TOKEN, GITHUB_REPOSITORY, RELEASE_BASE_TAG, and GITHUB_OUTPUT are required."
    );
  }

  const request = async (path) => {
    const response = await fetch(`${apiUrl}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GitHub API ${response.status} for ${path}: ${body}`);
    }

    return response.json();
  };

  const commits = [];
  for (let page = 1; ; page += 1) {
    const comparison = await request(
      `/repos/${repository}/compare/${encodeURIComponent(baseTag)}...${encodeURIComponent(baseBranch)}` +
        `?per_page=100&page=${page}`
    );
    commits.push(...comparison.commits);
    if (comparison.commits.length < 100) break;
  }

  let bump = "skip";
  const sources = [];
  const seenPullRequests = new Set();

  for (const commit of commits) {
    const pulls = await request(
      `/repos/${repository}/commits/${commit.sha}/pulls`
    );
    const mergedPulls = pulls.filter(
      (pull) => pull.merged_at && pull.base?.ref === baseBranch
    );

    if (mergedPulls.length === 0) {
      bump = highestRelease(bump, "patch");
      sources.push(`- \`${commit.sha.slice(0, 7)}\` — direct commit (patch)`);
      continue;
    }

    for (const pull of mergedPulls) {
      if (seenPullRequests.has(pull.number)) continue;
      seenPullRequests.add(pull.number);

      const decision =
        pull.head?.ref === "release/next"
          ? "skip"
          : classifyRelease(pull.labels);
      bump = highestRelease(bump, decision);

      if (decision !== "skip") {
        sources.push(
          `- #${pull.number} ${cleanTitle(pull.title)} (${decision})`
        );
      }
    }
  }

  if (!BUMPS.includes(bump)) {
    throw new Error(`Unsupported release decision: ${bump}`);
  }

  const delimiter = `release_sources_${Date.now()}`;
  appendFileSync(
    outputFile,
    `bump=${bump}\n` +
      `sources<<${delimiter}\n${sources.join("\n")}\n${delimiter}\n`
  );

  console.log(
    `Compared ${commits.length} commit(s) after ${baseTag}; decision: ${bump}.`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
