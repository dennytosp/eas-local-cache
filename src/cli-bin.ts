#!/usr/bin/env node

import { runCli } from "./cli";

runCli(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
});
