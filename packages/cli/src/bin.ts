#!/usr/bin/env node

import {runCli} from './program/index.js';

process.exit(await runCli());
