import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

export function metadataShardKey(propertySetId) {
	const prefix = String(propertySetId).slice(0, 2);
	const safe = prefix.replace(/[^A-Za-z0-9_$-]/g, '_');
	return safe || 'xx';
}

/**
 * Write sharded external metadata next to the XKT output path.
 *
 * Files:
 * - {base}.metadata.index.json.gz
 * - {base}.metadata.ps.{shard}.json.gz
 */
export function writeExternalMetadata(outputXktPath, externalMetadata, log = () => {}) {
	const base = outputXktPath.replace(/\.xkt$/i, '');
	const index = {
		version: externalMetadata.version ?? 1,
		objectPropertySets: externalMetadata.objectPropertySets ?? {},
		objectPropertySetSources: externalMetadata.objectPropertySetSources ?? {},
	};
	const indexGzip = gzipSync(Buffer.from(JSON.stringify(index)));
	const indexPath = `${base}.metadata.index.json.gz`;
	writeFileSync(indexPath, indexGzip);
	log(`Metadata index size: ${(indexGzip.byteLength / 1024).toFixed(1)} kB`);
	log(`Writing metadata index: ${indexPath}`);

	const shards = new Map();
	for (const [propertySetId, propertySet] of Object.entries(externalMetadata.propertySets ?? {})) {
		const shard = metadataShardKey(propertySetId);
		if (!shards.has(shard)) {
			shards.set(shard, {});
		}
		shards.get(shard)[propertySetId] = propertySet;
	}

	let shardBytes = 0;
	for (const [shard, data] of shards) {
		const shardGzip = gzipSync(Buffer.from(JSON.stringify(data)));
		shardBytes += shardGzip.byteLength;
		const shardPath = `${base}.metadata.ps.${shard}.json.gz`;
		writeFileSync(shardPath, shardGzip);
	}
	log(`Metadata shards: ${shards.size}, total ${(shardBytes / 1024 / 1024).toFixed(2)} MB`);
}
