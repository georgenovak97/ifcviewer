#!/usr/bin/env node
/**
 * Split legacy monolithic .metadata.json.gz into index + shard files.
 *
 * Usage:
 *   split-metadata.mjs /path/to/cache.metadata.json.gz
 */
import { readFileSync, unlinkSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { writeExternalMetadata } from './lib/writeExternalMetadata.mjs';

function log(msg) {
	console.log('[split-metadata] ' + msg);
}

const input = process.argv[2];
if (!input) {
	console.error('Usage: split-metadata.mjs <path.metadata.json.gz>');
	process.exit(1);
}

const decoded = gunzipSync(readFileSync(input)).toString('utf8');
const externalMetadata = JSON.parse(decoded);
const outputXktPath = input.replace(/\.metadata\.json\.gz$/i, '.xkt');

writeExternalMetadata(outputXktPath, externalMetadata, log);
unlinkSync(input);
log('Removed legacy metadata file: ' + input);
log('Done.');
