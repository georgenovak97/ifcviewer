<?php

declare(strict_types=1);

namespace OCA\Ifcviewer\Service;

use OCA\Ifcviewer\AppInfo\Application;
use OCA\Ifcviewer\BackgroundJob\ConvertIfcJob;
use OCA\Ifcviewer\Exception\ConvertingException;
use OCA\Ifcviewer\Exception\FileTooLargeException;
use OCP\BackgroundJob\IJobList;
use OCP\Files\File;
use OCP\Files\NotFoundException as FilesNotFoundException;
use OCP\Files\IAppData;
use OCP\Files\NotFoundException;
use OCP\Files\SimpleFS\ISimpleFile;
use OCP\Files\SimpleFS\ISimpleFolder;
use Psr\Log\LoggerInterface;
use RuntimeException;

class ConvertService {
    /** Same practical limit as OpenProject BIM 10.6 (500 MB IFC). */
    public const MAX_IFC_FILE_BYTES = 500 * 1024 * 1024;
    /** Soft warning for large Revit coordination models. */
    private const WARN_IFC_FILE_BYTES = 300 * 1024 * 1024;
    private const CONVERTER_VERSION = 'fast10';
    private const ERROR_COOLDOWN_SECONDS = 300;
    private const MIN_ESTIMATE_SECONDS = 30;
    private const STALE_CONVERSION_BASE_SECONDS = 600;
    /** @var array<string, array<string, mixed>> */
    private array $metadataIndexCache = [];
    /** @var array<string, array<string, mixed>> */
    private array $metadataShardCache = [];
    /** @var list<string> */
    private const REVIT_PROPERTY_SET_ORDER = [
        'Materials and Finishes',
        'Materials',
        'Constraints',
        'Dimensions',
        'Identity Data',
        'Other',
        'Phasing',
        'Structural',
        'Rebar Set',
        'Text',
        'Graphics',
        'Construction',
        'Analytical Properties',
        'Analytical',
        'Electrical',
        'Energy Analysis',
        'Mechanical',
        'Plumbing',
        'Fire Protection',
        'Vertical Circulation',
        'Data',
        'Overall Legend',
    ];

    public function __construct(
        private IAppData $appData,
        private IJobList $jobList,
        private FileService $fileService,
        private LoggerInterface $logger,
    ) {
    }

    public function getCacheName(File $file): string {
        return $file->getId() . '_' . md5($file->getEtag()) . '_' . self::CONVERTER_VERSION . '.xkt';
    }

    public function getMetadataCacheName(File $file): string {
        return $this->getLegacyMetadataCacheName($file);
    }

    public function getLegacyMetadataCacheName(File $file): string {
        return $file->getId() . '_' . md5($file->getEtag()) . '_' . self::CONVERTER_VERSION . '.metadata.json.gz';
    }

    public function getMetadataIndexCacheName(File $file): string {
        return $file->getId() . '_' . md5($file->getEtag()) . '_' . self::CONVERTER_VERSION . '.metadata.index.json.gz';
    }

    public function getMetadataShardCacheName(File $file, string $shard): string {
        return $file->getId() . '_' . md5($file->getEtag()) . '_' . self::CONVERTER_VERSION
            . '.metadata.ps.' . $this->sanitizeMetadataShard($shard) . '.json.gz';
    }

    public function getCacheBaseName(File $file): string {
        return pathinfo($this->getCacheName($file), PATHINFO_FILENAME);
    }

    public function getMaxIfcFileBytes(): int {
        return self::MAX_IFC_FILE_BYTES;
    }

    public function validateFileForViewing(File $file): ?string {
        $error = $this->getFileSizeError($file);
        return $error['message'] ?? null;
    }

    public function isCached(File $file): bool {
        return $this->isCacheBundleComplete($file);
    }

    private function isCacheBundleComplete(File $file): bool {
        if (!$this->hasXktCache($file)) {
            return false;
        }

        try {
            $xkt = $this->getCacheFolder()->getFile($this->getCacheName($file));
            if ($xkt->getSize() <= 0) {
                return false;
            }
        } catch (NotFoundException) {
            return false;
        }

        return $this->hasExternalMetadata($file);
    }

    public function repairIncompleteCache(File $file): bool {
        $hasXkt = $this->hasXktCache($file);
        $hasMeta = $this->hasMetadataIndex($file) || $this->hasLegacyMetadata($file);

        if ($this->isCacheBundleComplete($file)) {
            return false;
        }

        if (!$hasXkt && !$hasMeta) {
            return false;
        }

        $this->logger->warning('Removing incomplete IFC cache bundle', [
            'fileId' => $file->getId(),
            'hasXkt' => $hasXkt,
            'hasMetadata' => $hasMeta,
        ]);
        $this->deleteCurrentCacheBundle($file);
        $this->clearStatus($this->getCacheBaseName($file));
        return true;
    }

    public function hasExternalMetadata(File $file): bool {
        if (!$this->hasXktCache($file)) {
            return false;
        }

        return $this->hasMetadataIndex($file) || $this->hasLegacyMetadata($file);
    }

    private function hasXktCache(File $file): bool {
        try {
            $this->getCacheFolder()->getFile($this->getCacheName($file));
            return true;
        } catch (NotFoundException) {
            return false;
        }
    }

    private function hasMetadataIndex(File $file): bool {
        try {
            $this->getCacheFolder()->getFile($this->getMetadataIndexCacheName($file));
            return true;
        } catch (NotFoundException) {
            return false;
        }
    }

    private function hasLegacyMetadata(File $file): bool {
        try {
            $this->getCacheFolder()->getFile($this->getLegacyMetadataCacheName($file));
            return true;
        } catch (NotFoundException) {
            return false;
        }
    }

    /**
     * @return array{state: string, progress: int, message?: string, size?: int, startedAt?: int, externalMetadata?: bool}
     */
    public function getStatus(File $file): array {
        $this->repairIncompleteCache($file);

        if ($this->isCached($file)) {
            $result = [
                'state' => 'ready',
                'progress' => 100,
                'size' => $this->getCachedSize($file),
                'externalMetadata' => $this->hasExternalMetadata($file),
            ];
            $this->attachLargeFileWarning($file, $result);
            return $result;
        }

        $tooLarge = $this->getFileSizeError($file);
        if ($tooLarge !== null) {
            return $tooLarge;
        }

        $status = $this->readStatus($this->getCacheBaseName($file));
        if ($status !== null) {
            if (($status['state'] ?? '') === 'error') {
                return [
                    'state' => 'error',
                    'progress' => 0,
                    'message' => (string)($status['message'] ?? 'IFC conversion failed'),
                ];
            }

            if (($status['state'] ?? '') === 'converting') {
                if ($this->isStaleConversion($file, $status)) {
                    $this->clearStatus($this->getCacheBaseName($file));
                    return ['state' => 'missing', 'progress' => 0];
                }

                $startedAt = (int)($status['startedAt'] ?? time());
                $elapsed = max(0, time() - $startedAt);
                $estimated = $this->estimateSeconds($file, $status);

                $result = [
                    'state' => 'converting',
                    'progress' => $this->estimateProgress($file, $status),
                    'startedAt' => $startedAt,
                    'elapsed' => $elapsed,
                    'estimated' => $estimated,
                    'message' => $elapsed > $estimated
                        ? 'Конвертация большой модели, подождите…'
                        : null,
                ];
                $this->attachLargeFileWarning($file, $result);
                return $result;
            }

            if (($status['state'] ?? '') === 'queued') {
                $result = [
                    'state' => 'queued',
                    'progress' => 0,
                    'message' => 'Ожидание свободного слота конвертации…',
                ];
                $this->attachLargeFileWarning($file, $result);
                return $result;
            }
        }

        $result = ['state' => 'missing', 'progress' => 0];
        $this->attachLargeFileWarning($file, $result);
        return $result;
    }

    /**
     * @return array{state: string, progress: int, message?: string, size?: int, startedAt?: int, externalMetadata?: bool}
     */
    public function prepare(File $file): array {
        if ($this->isCached($file)) {
            return $this->getStatus($file);
        }

        $tooLarge = $this->getFileSizeError($file);
        if ($tooLarge !== null) {
            return $tooLarge;
        }

        $this->purgeAbandonedQueueEntries();
        $this->repairIncompleteCache($file);
        $this->clearOrphanedConversionStatus($file);

        try {
            @set_time_limit(0);
            $this->convertAndCache($file);
        } catch (ConvertingException) {
            // Another request is converting this file; return live status below.
        } catch (\Throwable $e) {
            $this->logger->error('IFC prepare failed', [
                'fileId' => $file->getId(),
                'exception' => $e,
            ]);
        }

        return $this->getStatus($file);
    }

    private function clearOrphanedConversionStatus(File $file): void {
        $baseName = $this->getCacheBaseName($file);
        $status = $this->readStatus($baseName);
        if ($status === null) {
            return;
        }

        $state = $status['state'] ?? '';
        if ($state === 'error') {
            if (!$this->isWithinErrorCooldown($baseName)) {
                $this->clearStatus($baseName);
            }
            return;
        }

        if ($state !== 'converting' && $state !== 'queued') {
            return;
        }

        $lock = $this->tryAcquireConversionLock($baseName);
        if ($lock === null) {
            return;
        }

        $this->releaseConversionLock($lock);
        $this->clearStatus($baseName);
        $this->logger->info('Cleared orphaned IFC conversion status', [
            'baseName' => $baseName,
            'state' => $state,
        ]);
    }

    private function purgeAbandonedQueueEntries(): void {
        $folder = $this->getCacheFolder();
        foreach ($folder->getDirectoryListing() as $node) {
            $name = $node->getName();
            if (!str_ends_with($name, '.status.json')) {
                continue;
            }

            $baseName = substr($name, 0, -strlen('.status.json'));
            $status = $this->readStatus($baseName);
            if ($status === null) {
                if ($folder->fileExists($name)) {
                    $this->clearStatus($baseName);
                    $this->logger->info('Removed unreadable IFC conversion status', ['baseName' => $baseName]);
                }
                continue;
            }

            $state = $status['state'] ?? '';
            if ($state === 'queued') {
                $queuedAt = (int)($status['queuedAt'] ?? 0);
                if ($queuedAt > 0 && (time() - $queuedAt) > 300) {
                    $this->clearStatus($baseName);
                    $this->logger->info('Purged abandoned IFC queue entry', ['baseName' => $baseName]);
                }
                continue;
            }

            if ($state !== 'converting') {
                continue;
            }

            if ($this->isStaleConversionStatus($status)) {
                $this->clearStaleConversionLock($baseName, $status);
            }
        }
    }

    private function isWithinErrorCooldown(string $baseName): bool {
        $status = $this->readStatus($baseName);
        if ($status === null || ($status['state'] ?? '') !== 'error') {
            return false;
        }
        $failedAt = (int)($status['failedAt'] ?? 0);
        if ($failedAt <= 0) {
            return false;
        }
        return (time() - $failedAt) < self::ERROR_COOLDOWN_SECONDS;
    }

    public function getXktFile(File $file): ISimpleFile {
        if ($this->isCached($file)) {
            return $this->getCacheFolder()->getFile($this->getCacheName($file));
        }

        $status = $this->getStatus($file);
        if ($status['state'] === 'converting') {
            throw new ConvertingException('IFC conversion in progress');
        }
        if ($status['state'] === 'error') {
            throw new RuntimeException($status['message'] ?? 'IFC conversion failed');
        }

        throw new ConvertingException('IFC conversion has not started');
    }

    /**
     * @param list<string>|null $fallbackPropertySetIds
     * @return array{propertySets: list<array{name: string, properties: list<array{name: string, value: mixed}>}>}
     */
    public function getObjectProperties(File $file, string $objectId, ?array $fallbackPropertySetIds = null): array {
        if (!$this->hasExternalMetadata($file)) {
            return ['propertySets' => []];
        }

        $metadata = $this->loadExternalMetadataIndex($file);
        $resolvedObjectId = $this->resolveObjectIdForProperties($metadata, $objectId);
        $propertySetIds = $metadata['objectPropertySets'][$resolvedObjectId] ?? [];
        if ($propertySetIds === [] && $fallbackPropertySetIds !== null && $fallbackPropertySetIds !== []) {
            $propertySetIds = $fallbackPropertySetIds;
        }
        $sources = $metadata['objectPropertySetSources'][$resolvedObjectId] ?? [];
        $propertySets = [];

        foreach ($propertySetIds as $propertySetId) {
            $raw = $this->loadExternalPropertySet($file, (string)$propertySetId);
            if (!is_array($raw)) {
                continue;
            }

            $properties = [];
            foreach ($raw['properties'] ?? [] as $property) {
                if (!is_array($property) || !isset($property['name'])) {
                    continue;
                }
                $properties[] = [
                    'name' => (string)$property['name'],
                    'value' => $property['value'] ?? '',
                ];
            }

            if ($properties === []) {
                continue;
            }

            $name = (string)($raw['propertySetName'] ?? $propertySetId);
            $source = is_string($sources[$propertySetId] ?? null) ? $sources[$propertySetId] : 'ifc-other';
            $propertySets[] = [
                'name' => $name,
                'properties' => $properties,
                'source' => $source,
            ];
        }

        $propertySets = $this->deduplicatePropertySetsForDisplay($propertySets);
        $propertySets = $this->disambiguatePropertySetDisplayNames($propertySets);

        return ['propertySets' => $this->sortPropertySetsForDisplay($propertySets)];
    }

    /**
     * @param list<array{name: string, properties: list<array{name: string, value: mixed}>, source?: string}> $propertySets
     * @return list<array{name: string, properties: list<array{name: string, value: mixed}>, source?: string}>
     */
    private function disambiguatePropertySetDisplayNames(array $propertySets): array {
        $groups = [];

        foreach ($propertySets as $index => $propertySet) {
            $baseName = $this->getPropertySetBaseName($propertySet['name']);
            $groups[$baseName][] = $index;
        }

        foreach ($groups as $indexes) {
            if (count($indexes) < 2) {
                continue;
            }

            $uniqueNames = [];
            foreach ($indexes as $index) {
                $uniqueNames[mb_strtolower(trim($propertySets[$index]['name']))] = true;
            }
            if (count($uniqueNames) === count($indexes)) {
                continue;
            }

            foreach ($indexes as $index) {
                $source = (string)($propertySets[$index]['source'] ?? 'ifc-other');
                if ($source === 'revit-type' && !$this->hasPropertySetTypeSuffix($propertySets[$index]['name'])) {
                    $propertySets[$index]['name'] = trim($propertySets[$index]['name']) . ' (Type)';
                }
            }

            $nameCounts = [];
            foreach ($indexes as $index) {
                $normalized = mb_strtolower(trim($propertySets[$index]['name']));
                $nameCounts[$normalized] = ($nameCounts[$normalized] ?? 0) + 1;
            }

            foreach ($indexes as $index) {
                $normalized = mb_strtolower(trim($propertySets[$index]['name']));
                $source = (string)($propertySets[$index]['source'] ?? 'ifc-other');
                if (($nameCounts[$normalized] ?? 0) > 1 && $source === 'revit-instance') {
                    $propertySets[$index]['name'] = trim($propertySets[$index]['name']) . ' (Instance)';
                }
            }

            $seenNames = [];
            usort($indexes, function (int $leftIndex, int $rightIndex) use ($propertySets): int {
                $leftRank = $this->getPropertySetSourceRank($propertySets[$leftIndex]);
                $rightRank = $this->getPropertySetSourceRank($propertySets[$rightIndex]);
                return $leftRank <=> $rightRank;
            });

            foreach ($indexes as $index) {
                $normalized = mb_strtolower(trim($propertySets[$index]['name']));
                if (isset($seenNames[$normalized])) {
                    if (!$this->hasPropertySetTypeSuffix($propertySets[$index]['name'])) {
                        $propertySets[$index]['name'] = trim($propertySets[$index]['name']) . ' (Type)';
                    }
                    $normalized = mb_strtolower(trim($propertySets[$index]['name']));
                }
                $seenNames[$normalized] = true;
            }
        }

        return $propertySets;
    }

    private function getPropertySetBaseName(string $name): string {
        $normalized = mb_strtolower(trim($name));
        return (string)preg_replace('/\s*\(type\)\s*$/', '', $normalized);
    }

    private function hasPropertySetTypeSuffix(string $name): bool {
        return preg_match('/\(Type\)\s*$/i', trim($name)) === 1;
    }

    /**
     * @param list<array{name: string, properties: list<array{name: string, value: mixed}>, source?: string}> $propertySets
     * @return list<array{name: string, properties: list<array{name: string, value: mixed}>, source?: string}>
     */
    private function deduplicatePropertySetsForDisplay(array $propertySets): array {
        $bestByFingerprint = [];
        $ordered = [];

        foreach ($propertySets as $propertySet) {
            $fingerprint = $this->getPropertySetFingerprint($propertySet);
            $existing = $bestByFingerprint[$fingerprint] ?? null;
            if ($existing === null) {
                $bestByFingerprint[$fingerprint] = $propertySet;
                $ordered[] = $propertySet;
                continue;
            }

            if ($this->getPropertySetSourceRank($propertySet) < $this->getPropertySetSourceRank($existing)) {
                foreach ($ordered as $index => $candidate) {
                    if ($candidate === $existing) {
                        $ordered[$index] = $propertySet;
                        break;
                    }
                }
                $bestByFingerprint[$fingerprint] = $propertySet;
            }
        }

        return $ordered;
    }

    /**
     * @param array{name: string, properties: list<array{name: string, value: mixed}>, source?: string} $propertySet
     */
    private function getPropertySetFingerprint(array $propertySet): string {
        $name = mb_strtolower(trim($propertySet['name']));
        $parts = [];
        foreach ($propertySet['properties'] as $property) {
            $parts[] = ($property['name'] ?? '') . "\0" . (string)($property['value'] ?? '');
        }
        sort($parts, SORT_STRING);
        return $name . "\2" . implode("\1", $parts);
    }

    /**
     * @param array{source?: string} $propertySet
     */
    private function getPropertySetSourceRank(array $propertySet): int {
        $source = (string)($propertySet['source'] ?? 'ifc-other');
        return match ($source) {
            'revit-instance' => 1,
            'revit-type' => 2,
            'ifc-material' => 3,
            'ifc-element' => 4,
            default => 5,
        };
    }

    /**
     * @param list<array{name: string, properties: list<array{name: string, value: mixed}>, source?: string}> $propertySets
     * @return list<array{name: string, properties: list<array{name: string, value: mixed}>}>
     */
    private function sortPropertySetsForDisplay(array $propertySets): array {
        usort($propertySets, function (array $left, array $right): int {
            $leftKey = $this->getPropertySetSortKey($left);
            $rightKey = $this->getPropertySetSortKey($right);
            return $leftKey <=> $rightKey;
        });

        return array_map(static function (array $propertySet): array {
            return [
                'name' => $propertySet['name'],
                'properties' => $propertySet['properties'],
                'source' => (string)($propertySet['source'] ?? 'ifc-other'),
            ];
        }, $propertySets);
    }

    /**
     * @param array{name: string, source?: string} $propertySet
     */
    private function getPropertySetSortKey(array $propertySet): string {
        $name = trim($propertySet['name']);
        $source = (string)($propertySet['source'] ?? 'ifc-other');
        $group = $this->getPropertySetSortGroup($name, $source);
        $groupOrder = match ($group) {
            'material' => '0',
            'instance' => '1',
            'type' => '2',
            'ifc-material' => '3',
            'ifc-element' => '4',
            default => '5',
        };
        $nameOrder = str_pad((string)$this->getRevitPropertySetOrderIndex($name, $group), 5, '0', STR_PAD_LEFT);
        return $groupOrder . ':' . $nameOrder . ':' . mb_strtolower($name);
    }

    private function getPropertySetSortGroup(string $name, string $source): string {
        if ($this->isRevitMaterialPropertySetName($name)
            && ($source === 'revit-instance' || $source === 'revit-type')) {
            return 'material';
        }
        if ($source === 'revit-instance') {
            return 'instance';
        }
        if ($source === 'revit-type') {
            return 'type';
        }
        if ($source === 'ifc-material') {
            return 'ifc-material';
        }
        if ($source === 'ifc-element' || $name === 'IFC Element') {
            return 'ifc-element';
        }
        return 'ifc-other';
    }

    private function isKnownRevitPropertySetName(string $name): bool {
        $baseName = trim((string)preg_replace('/\s*\(Type\)\s*$/i', '', $name));
        return in_array($baseName, self::REVIT_PROPERTY_SET_ORDER, true)
            || in_array($name, self::REVIT_PROPERTY_SET_ORDER, true);
    }

    private function isRevitMaterialPropertySetName(string $name): bool {
        $name = trim($name);
        if ($name === 'Materials') {
            return true;
        }
        return preg_match('/^Materials and Finishes(?:\s*\(Type\))?$/i', $name) === 1;
    }

    private function getRevitPropertySetOrderIndex(string $name, string $group): int {
        if ($group === 'material') {
            if ($name === 'Materials and Finishes') {
                return 0;
            }
            if ($name === 'Materials') {
                return 1;
            }
            if (preg_match('/\(Type\)/i', $name) === 1) {
                return 2;
            }
            return 3;
        }

        $baseName = trim((string)preg_replace('/\s*\(Type\)\s*$/i', '', $name));
        $index = array_search($baseName, self::REVIT_PROPERTY_SET_ORDER, true);
        if ($index !== false) {
            return (int)$index;
        }
        $index = array_search($name, self::REVIT_PROPERTY_SET_ORDER, true);
        if ($index !== false) {
            return (int)$index;
        }
        return 1000 + abs(crc32(mb_strtolower($name)) % 1000);
    }

    /**
     * @param array<string, mixed> $metadata
     */
    private function resolveObjectIdForProperties(array $metadata, string $objectId): string {
        $objectPropertySets = $metadata['objectPropertySets'] ?? [];
        if (!is_array($objectPropertySets)) {
            return $objectId;
        }

        $keys = array_keys($objectPropertySets);
        if (isset($objectPropertySets[$objectId])) {
            return $objectId;
        }

        foreach ($keys as $candidate) {
            if (!is_string($candidate)) {
                continue;
            }
            if (strcasecmp($candidate, $objectId) === 0) {
                return $candidate;
            }
        }

        $decoded = rawurldecode($objectId);
        if ($decoded !== $objectId && isset($objectPropertySets[$decoded])) {
            return $decoded;
        }

        if (strlen($objectId) >= 20) {
            foreach ($keys as $candidate) {
                if (!is_string($candidate) || strlen($candidate) !== 22) {
                    continue;
                }
                if (str_starts_with($candidate, substr($objectId, 0, 12))
                    && str_ends_with($candidate, substr($objectId, -4))) {
                    return $candidate;
                }
            }
        }

        return $objectId;
    }

    public function convertAndCache(File $file): ISimpleFile {
        $this->assertFileSizeAllowed($file);

        $cacheName = $this->getCacheName($file);
        $baseName = $this->getCacheBaseName($file);

        try {
            $this->getCacheFolder()->getFile($cacheName);
            if ($this->hasExternalMetadata($file)) {
                return $this->getCacheFolder()->getFile($cacheName);
            }
        } catch (NotFoundException) {
            // continue
        }

        $lockHandle = $this->tryAcquireConversionLock($baseName);
        if ($lockHandle === null) {
            for ($attempt = 0; $attempt < 120; $attempt++) {
                try {
                    return $this->getCacheFolder()->getFile($cacheName);
                } catch (NotFoundException) {
                    sleep(1);
                }
            }
            throw new ConvertingException('IFC conversion already in progress');
        }

        $this->writeStatus($baseName, 'converting', [
            'startedAt' => time(),
            'fileSize' => $file->getSize(),
        ]);

        try {
            $cached = $this->convertAndCacheSync($file, $cacheName);
            $this->purgeStaleCachesForFile($file);
            $this->clearStatus($baseName);
            return $cached;
        } catch (\Throwable $e) {
            $this->writeStatus($baseName, 'error', [
                'message' => $e->getMessage(),
                'failedAt' => time(),
            ]);
            throw $e;
        } finally {
            $this->releaseConversionLock($lockHandle);
        }
    }

    private function convertAndCacheSync(File $file, string $cacheName): ISimpleFile {
        $appRoot = \OC::$server->getAppManager()->getAppPath(Application::APP_ID);
        $nodeBin = $appRoot . '/tools/node-v20.19.2-linux-x64/bin/node';
        $convertScript = $appRoot . '/tools/convert-ifc.mjs';

        if (!is_executable($nodeBin) || !is_file($convertScript)) {
            throw new RuntimeException('IFC conversion tools are not installed on the server');
        }

        $sourcePath = $this->resolveLocalIfcPath($file);
        $tmpIfc = null;
        $tmpXkt = sys_get_temp_dir() . '/ifcviewer_' . uniqid('', true) . '.xkt';
        $tmpBase = preg_replace('/\.xkt$/', '', $tmpXkt);

        try {
            if ($sourcePath === null) {
                $extension = strtolower(pathinfo($file->getName(), PATHINFO_EXTENSION));
                if ($extension === '') {
                    $extension = 'ifc';
                }
                $tmpIfc = sys_get_temp_dir() . '/ifcviewer_' . uniqid('', true) . '.' . $extension;
                $this->copyFileToPath($file, $tmpIfc);
                $sourcePath = $tmpIfc;
            }

            $previousTimeLimit = ini_get('max_execution_time');
            set_time_limit(0);

            $heapMb = $this->getNodeHeapMb($file->getSize());
            $cmd = escapeshellarg($nodeBin)
                . ' --max-old-space-size=' . $heapMb
                . ' ' . escapeshellarg($convertScript)
                . ' -s ' . escapeshellarg($sourcePath)
                . ' -o ' . escapeshellarg($tmpXkt)
                . ' -l'
                . ' -z 5000'
                . ' -m';

            $output = [];
            $exitCode = 0;
            exec($cmd . ' 2>&1', $output, $exitCode);

            if ($previousTimeLimit !== false) {
                set_time_limit((int)$previousTimeLimit);
            }

            if ($exitCode !== 0 || !is_file($tmpXkt)) {
                $this->logger->error('IFC conversion failed', [
                    'fileId' => $file->getId(),
                    'exitCode' => $exitCode,
                    'output' => implode("\n", $output),
                ]);
                $message = $this->formatConversionError(trim(implode("\n", $output)));
                throw new RuntimeException($message !== '' ? $message : 'IFC conversion failed');
            }

            $xktSize = filesize($tmpXkt);
            if ($xktSize === false || $xktSize <= 0) {
                throw new RuntimeException('Converted XKT file is empty');
            }

            if (!$this->converterOutputHasObjects($output)) {
                throw new RuntimeException(
                    'IFC conversion produced no visible geometry. The model may contain only unsupported elements.'
                );
            }

            $folder = $this->getCacheFolder();
            return $this->publishCacheBundle($folder, $file, $tmpXkt, $tmpBase);
        } finally {
            if ($tmpIfc !== null) {
                @unlink($tmpIfc);
            }
            @unlink($tmpXkt);
            $this->cleanupTempMetadataFiles($tmpBase);
        }
    }

    private function publishCacheBundle(ISimpleFolder $folder, File $file, string $tmpXkt, string $tmpBase): ISimpleFile {
        $cacheName = $this->getCacheName($file);
        $partialXkt = $this->getPartialCacheName($cacheName);
        $partialMetaNames = [];

        try {
            $this->storeCacheFileFromPath($folder, $partialXkt, $tmpXkt);
            $partialMetaNames = $this->stageMetadataCacheFiles($folder, $file, $tmpBase);
            $this->verifyPartialCacheBundle($folder, $file, $partialXkt, $partialMetaNames);

            $promoted = [];
            try {
                $this->promotePartialFile($folder, $partialXkt, $cacheName);
                $promoted[] = $cacheName;
                foreach ($partialMetaNames as $partialName => $finalName) {
                    $this->promotePartialFile($folder, $partialName, $finalName);
                    $promoted[] = $finalName;
                }
            } catch (\Throwable $promoteError) {
                foreach ($promoted as $finalName) {
                    if ($folder->fileExists($finalName)) {
                        $folder->getFile($finalName)->delete();
                    }
                }
                throw $promoteError;
            }

            $legacyName = $this->getLegacyMetadataCacheName($file);
            if ($folder->fileExists($legacyName)) {
                $folder->getFile($legacyName)->delete();
            }

            return $folder->getFile($cacheName);
        } catch (\Throwable $e) {
            $this->deletePartialCacheFiles($folder, $partialXkt, $partialMetaNames);
            throw $e;
        }
    }

    private function getPartialCacheName(string $finalName): string {
        return $finalName . '.partial';
    }

    /**
     * @param array<string, string> $partialMetaNames
     */
    private function verifyPartialCacheBundle(
        ISimpleFolder $folder,
        File $file,
        string $partialXkt,
        array $partialMetaNames,
    ): void {
        if (!$folder->fileExists($partialXkt)) {
            throw new RuntimeException('Partial XKT cache is missing');
        }

        $xktSize = $folder->getFile($partialXkt)->getSize();
        if ($xktSize <= 0) {
            throw new RuntimeException('Partial XKT cache is empty');
        }

        $indexFinal = $this->getMetadataIndexCacheName($file);
        $indexPartial = $this->getPartialCacheName($indexFinal);
        if (!array_key_exists($indexPartial, $partialMetaNames) || !$folder->fileExists($indexPartial)) {
            throw new RuntimeException('Partial metadata index cache is missing');
        }

        $shardCount = 0;
        foreach ($partialMetaNames as $partialName => $finalName) {
            if ($finalName === $indexFinal) {
                continue;
            }
            if (!$folder->fileExists($partialName)) {
                throw new RuntimeException('Partial metadata shard cache is missing');
            }
            $shardCount++;
        }

        if ($shardCount === 0) {
            throw new RuntimeException('Partial metadata property shards are missing');
        }
    }

    /**
     * @param array<string, string> $partialMetaNames
     */
    private function deletePartialCacheFiles(
        ISimpleFolder $folder,
        string $partialXkt,
        array $partialMetaNames,
    ): void {
        foreach ([$partialXkt, ...array_keys($partialMetaNames)] as $name) {
            if ($name === '' || !$folder->fileExists($name)) {
                continue;
            }
            try {
                $folder->getFile($name)->delete();
            } catch (\Throwable $e) {
                $this->logger->warning('Failed to delete partial IFC cache file', [
                    'cacheName' => $name,
                    'exception' => $e,
                ]);
            }
        }
    }

    private function promotePartialFile(ISimpleFolder $folder, string $partialName, string $finalName): void {
        if (!$folder->fileExists($partialName)) {
            throw new RuntimeException('Partial cache file is missing: ' . $partialName);
        }

        $partial = $folder->getFile($partialName);
        $read = $partial->read();
        if ($read === false) {
            throw new RuntimeException('Failed to read partial cache file');
        }

        try {
            if ($folder->fileExists($finalName)) {
                $folder->getFile($finalName)->delete();
            }

            $final = $folder->newFile($finalName);
            $final->putContent($read);
        } finally {
            if (is_resource($read)) {
                fclose($read);
            }
            $partial->delete();
        }
    }

    /**
     * @return array<string, string> partial name => final name
     */
    private function stageMetadataCacheFiles(ISimpleFolder $folder, File $file, string $tmpBase): array {
        $indexPath = $tmpBase . '.metadata.index.json.gz';
        if (!is_file($indexPath)) {
            $this->logger->error('IFC conversion produced XKT without metadata index', [
                'fileId' => $file->getId(),
            ]);
            throw new RuntimeException('IFC conversion produced no metadata cache');
        }

        $partialMetaNames = [];
        $indexFinal = $this->getMetadataIndexCacheName($file);
        $indexPartial = $this->getPartialCacheName($indexFinal);
        $this->storeCacheFileFromPath($folder, $indexPartial, $indexPath);
        $partialMetaNames[$indexPartial] = $indexFinal;

        $shardCount = 0;
        foreach (glob($tmpBase . '.metadata.ps.*.json.gz') ?: [] as $shardPath) {
            if (!is_file($shardPath)) {
                continue;
            }
            $basename = basename($shardPath);
            if (!preg_match('/\.metadata\.ps\.([^.]+)\.json\.gz$/', $basename, $matches)) {
                continue;
            }
            $finalName = $this->getMetadataShardCacheName($file, $matches[1]);
            $partialName = $this->getPartialCacheName($finalName);
            $this->storeCacheFileFromPath($folder, $partialName, $shardPath);
            $partialMetaNames[$partialName] = $finalName;
            $shardCount++;
        }

        if ($shardCount === 0) {
            $this->logger->error('IFC conversion produced metadata index without property shards', [
                'fileId' => $file->getId(),
            ]);
            throw new RuntimeException('IFC conversion produced no metadata property shards');
        }

        return $partialMetaNames;
    }

    private function deleteCurrentCacheBundle(File $file): void {
        $folder = $this->getCacheFolder();
        $cacheName = $this->getCacheName($file);
        if ($folder->fileExists($cacheName)) {
            $folder->getFile($cacheName)->delete();
        }

        $partialXkt = $this->getPartialCacheName($cacheName);
        if ($folder->fileExists($partialXkt)) {
            $folder->getFile($partialXkt)->delete();
        }

        $this->deleteMetadataCacheFiles($folder, $file);

        $prefix = $file->getId() . '_' . md5($file->getEtag()) . '_';
        foreach ($folder->getDirectoryListing() as $node) {
            $name = $node->getName();
            if (!str_starts_with($name, $prefix)) {
                continue;
            }
            try {
                $node->delete();
            } catch (\Throwable $e) {
                $this->logger->warning('Failed to delete IFC cache file', [
                    'fileId' => $file->getId(),
                    'cacheName' => $name,
                    'exception' => $e,
                ]);
            }
        }
    }

    private function deleteMetadataCacheFiles(ISimpleFolder $folder, File $file): void {
        $names = [$this->getMetadataIndexCacheName($file), $this->getLegacyMetadataCacheName($file)];
        foreach ($names as $name) {
            if ($folder->fileExists($name)) {
                $folder->getFile($name)->delete();
            }
        }

        $prefix = $file->getId() . '_' . md5($file->getEtag()) . '_' . self::CONVERTER_VERSION . '.metadata.ps.';
        foreach ($folder->getDirectoryListing() as $node) {
            if (!str_starts_with($node->getName(), $prefix)) {
                continue;
            }
            $node->delete();
        }
    }

    private function cleanupTempMetadataFiles(string $tmpBase): void {
        @unlink($tmpBase . '.metadata.index.json.gz');
        @unlink($tmpBase . '.metadata.json.gz');
        foreach (glob($tmpBase . '.metadata.ps.*.json.gz') ?: [] as $shardPath) {
            @unlink($shardPath);
        }
    }

    private function sanitizeMetadataShard(string $shard): string {
        $safe = preg_replace('/[^A-Za-z0-9_$-]/', '_', $shard) ?? '';
        return $safe !== '' ? $safe : 'xx';
    }

    private function metadataShardKey(string $propertySetId): string {
        return $this->sanitizeMetadataShard(substr($propertySetId, 0, 2));
    }

    /**
     * @return array<string, mixed>
     */
    private function loadExternalMetadataIndex(File $file): array {
        $cacheKey = $this->getCacheBaseName($file);
        if (isset($this->metadataIndexCache[$cacheKey])) {
            return $this->metadataIndexCache[$cacheKey];
        }

        if ($this->hasMetadataIndex($file)) {
            $raw = $this->getCacheFolder()->getFile($this->getMetadataIndexCacheName($file))->getContent();
            $decoded = gzdecode($raw);
            if ($decoded === false) {
                throw new RuntimeException('Failed to decompress metadata index cache');
            }

            $metadata = json_decode($decoded, true);
            if (!is_array($metadata)) {
                throw new RuntimeException('Invalid metadata index cache format');
            }

            return $this->metadataIndexCache[$cacheKey] = $metadata;
        }

        if ($this->hasLegacyMetadata($file)) {
            throw new RuntimeException(
                'Metadata cache must be split before properties can be loaded. Reconvert the IFC file.'
            );
        }

        throw new RuntimeException('Metadata cache is missing');
    }

    /**
     * @return array<string, mixed>|null
     */
    private function loadExternalPropertySet(File $file, string $propertySetId): ?array {
        $shard = $this->metadataShardKey($propertySetId);
        $shardData = $this->loadExternalMetadataShard($file, $shard);
        $raw = $shardData[$propertySetId] ?? null;

        return is_array($raw) ? $raw : null;
    }

    /**
     * @return array<string, mixed>
     */
    private function loadExternalMetadataShard(File $file, string $shard): array {
        $cacheKey = $this->getCacheBaseName($file) . ':' . $shard;
        if (isset($this->metadataShardCache[$cacheKey])) {
            return $this->metadataShardCache[$cacheKey];
        }

        try {
            $raw = $this->getCacheFolder()->getFile($this->getMetadataShardCacheName($file, $shard))->getContent();
        } catch (NotFoundException) {
            return $this->metadataShardCache[$cacheKey] = [];
        }

        $decoded = gzdecode($raw);
        if ($decoded === false) {
            throw new RuntimeException('Failed to decompress metadata shard cache');
        }

        $metadata = json_decode($decoded, true);
        if (!is_array($metadata)) {
            throw new RuntimeException('Invalid metadata shard cache format');
        }

        return $this->metadataShardCache[$cacheKey] = $metadata;
    }

    private function getNodeHeapMb(int $fileSizeBytes): int {
        $availableKb = 0;
        $memInfo = @file_get_contents('/proc/meminfo');
        if (is_string($memInfo) && preg_match('/MemAvailable:\s+(\d+)/', $memInfo, $matches)) {
            $availableKb = (int)$matches[1];
        }

        $fileSizeMb = max(1, $fileSizeBytes / (1024 * 1024));
        $wantedMb = (int)min(6144, max(2048, 2048 + $fileSizeMb * 3));

        if ($availableKb > 0) {
            $availableMb = (int)floor($availableKb / 1024 * 0.7);
            return max(2048, min($wantedMb, $availableMb));
        }

        return min($wantedMb, 4096);
    }

    /**
     * @return array{state: string, progress: int, message: string, code: string}|null
     */
    private function getFileSizeError(File $file): ?array {
        if ($file->getSize() <= self::MAX_IFC_FILE_BYTES) {
            return null;
        }

        return [
            'state' => 'error',
            'progress' => 0,
            'message' => $this->formatFileTooLargeMessage($file),
            'code' => 'file_too_large',
        ];
    }

    private function assertFileSizeAllowed(File $file): void {
        if ($file->getSize() > self::MAX_IFC_FILE_BYTES) {
            throw new FileTooLargeException($this->formatFileTooLargeMessage($file));
        }
    }

    private function formatFileTooLargeMessage(File $file): string {
        return sprintf(
            'Файл слишком большой (%s). Максимальный поддерживаемый размер IFC: %s.',
            $this->formatBytes($file->getSize()),
            $this->formatBytes(self::MAX_IFC_FILE_BYTES),
        );
    }

    private function formatBytes(int $bytes): string {
        if ($bytes >= 1024 * 1024 * 1024) {
            return sprintf('%.1f ГБ', $bytes / (1024 * 1024 * 1024));
        }
        if ($bytes >= 1024 * 1024) {
            return sprintf('%.0f МБ', $bytes / (1024 * 1024));
        }
        if ($bytes >= 1024) {
            return sprintf('%.0f КБ', $bytes / 1024);
        }
        return $bytes . ' Б';
    }

    /**
     * @param list<string> $output
     */
    private function converterOutputHasObjects(array $output): bool {
        foreach ($output as $line) {
            if (preg_match('/Converted drawable objects:\s+(\d+)/', $line, $matches)) {
                return (int)$matches[1] > 0;
            }
        }
        return true;
    }

    private function formatConversionError(string $raw): string {
        if ($raw === '') {
            return 'IFC conversion failed';
        }
        if (stripos($raw, 'Aborted') !== false || stripos($raw, 'TriangulateBounds') !== false) {
            return 'Конвертация IFC прервана: слишком сложная или повреждённая геометрия. '
                . 'Проверьте экспорт из Revit (IFC2x3 CV 2.0, LOD 0.3, UseOnlyTriangulation=true, без помещений).';
        }
        if (stripos($raw, 'ISO-10303-21') !== false) {
            return 'Файл не является корректным IFC (ожидается заголовок ISO-10303-21).';
        }
        if (stripos($raw, 'no visible geometry') !== false || stripos($raw, 'No drawable objects') !== false) {
            return 'В IFC нет отображаемой геометрии. Проверьте, что в Revit экспортированы 3D-элементы '
                . 'и отключены ExportRoomsInView / Export2DElements.';
        }
        if (stripos($raw, '[convert-ifc] ERROR:') !== false) {
            $raw = trim((string)preg_replace('/^\[convert-ifc\]\s*ERROR:\s*/', '', $raw));
        }
        return $this->truncateStatusMessage($raw);
    }

    private function truncateStatusMessage(string $message): string {
        $maxBytes = 2000;
        if (strlen($message) <= $maxBytes) {
            return $message;
        }
        return substr($message, 0, $maxBytes) . '…';
    }

    /**
     * @param array<string, mixed> $payload
     */
    private function attachLargeFileWarning(File $file, array &$payload): void {
        if ($file->getSize() >= self::WARN_IFC_FILE_BYTES && $file->getSize() <= self::MAX_IFC_FILE_BYTES) {
            $payload['warning'] = sprintf(
                'Большая модель (%s). Первая конвертация может занять несколько минут.',
                $this->formatBytes($file->getSize()),
            );
        }
    }

    private function storeCacheFileFromPath(ISimpleFolder $folder, string $name, string $path): ISimpleFile {
        if (!is_readable($path)) {
            throw new RuntimeException('Failed to read converted cache file');
        }

        if ($folder->fileExists($name)) {
            $folder->getFile($name)->delete();
        }

        $read = fopen($path, 'rb');
        if ($read === false) {
            throw new RuntimeException('Failed to open converted cache file');
        }

        try {
            $cached = $folder->newFile($name);
            $cached->putContent($read);
            return $cached;
        } finally {
            if (is_resource($read)) {
                fclose($read);
            }
        }
    }

    /**
     * @return resource|null
     */
    private function tryAcquireConversionLock(string $baseName) {
        $lockPath = sys_get_temp_dir() . '/ifcviewer_lock_' . md5($baseName) . '.lock';
        $handle = fopen($lockPath, 'c');
        if ($handle === false) {
            return null;
        }
        if (!flock($handle, LOCK_EX | LOCK_NB)) {
            fclose($handle);
            return null;
        }
        return $handle;
    }

    /**
     * @param resource $handle
     */
    private function releaseConversionLock($handle): void {
        flock($handle, LOCK_UN);
        fclose($handle);
    }

    private function resolveLocalIfcPath(File $file): ?string {
        $storage = $file->getStorage();
        if (!method_exists($storage, 'getLocalFile')) {
            return null;
        }

        $localPath = $storage->getLocalFile($file->getInternalPath());
        if (!is_string($localPath) || $localPath === '' || !is_readable($localPath)) {
            return null;
        }

        return $localPath;
    }

    public function runQueuedConversion(int $fileId, string $userId): void {
        try {
            $file = $this->fileService->getUserFile($userId, $fileId);
        } catch (FilesNotFoundException $e) {
            $this->logger->warning('IFC conversion job: file not found', [
                'fileId' => $fileId,
                'userId' => $userId,
            ]);
            return;
        }

        if ($this->isCached($file)) {
            $this->clearStatus($this->getCacheBaseName($file));
            $this->scheduleNextQueuedConversion();
            return;
        }

        $baseName = $this->getCacheBaseName($file);
        if ($this->isWithinErrorCooldown($baseName)) {
            return;
        }

        if (!$this->isGlobalConversionSlotAvailable($baseName)) {
            $status = $this->readStatus($baseName);
            if (($status['state'] ?? '') !== 'queued') {
                $this->writeStatus($baseName, 'queued', [
                    'queuedAt' => time(),
                    'fileSize' => $file->getSize(),
                    'fileId' => $file->getId(),
                    'userId' => $userId,
                ]);
            }
            return;
        }

        try {
            $this->convertAndCache($file);
        } catch (\Throwable $e) {
            $this->logger->error('IFC conversion job failed', [
                'fileId' => $fileId,
                'userId' => $userId,
                'exception' => $e,
            ]);
        } finally {
            $this->scheduleNextQueuedConversion();
        }
    }

    private function scheduleNextQueuedConversion(): void {
        if (!$this->isGlobalConversionSlotAvailable()) {
            return;
        }

        $folder = $this->getCacheFolder();
        $candidate = null;
        $candidateQueuedAt = PHP_INT_MAX;

        foreach ($folder->getDirectoryListing() as $node) {
            $name = $node->getName();
            if (!str_ends_with($name, '.status.json')) {
                continue;
            }

            $baseName = substr($name, 0, -strlen('.status.json'));
            $status = $this->readStatus($baseName);
            if (($status['state'] ?? '') !== 'queued') {
                continue;
            }

            $queuedAt = (int)($status['queuedAt'] ?? PHP_INT_MAX);
            if ($queuedAt >= $candidateQueuedAt) {
                continue;
            }

            $fileId = (int)($status['fileId'] ?? 0);
            $userId = (string)($status['userId'] ?? '');
            if ($fileId <= 0 || $userId === '') {
                continue;
            }

            $candidateQueuedAt = $queuedAt;
            $candidate = [
                'fileId' => $fileId,
                'userId' => $userId,
            ];
        }

        if ($candidate === null) {
            return;
        }

        $this->jobList->add(ConvertIfcJob::class, $candidate);
        $this->logger->info('Scheduled next queued IFC conversion', $candidate);
    }

    /**
     * @param array<string, mixed> $status
     */
    private function isStaleConversion(File $file, array $status): bool {
        return $this->isStaleConversionStatus($status, (int)($file->getSize() ?: 0));
    }

    /**
     * @param array<string, mixed> $status
     */
    private function isStaleConversionStatus(array $status, int $fallbackFileSize = 0): bool {
        $startedAt = (int)($status['startedAt'] ?? 0);
        if ($startedAt <= 0) {
            return true;
        }

        $sizeMb = max(1, ((int)($status['fileSize'] ?? $fallbackFileSize)) / (1024 * 1024));
        $secondsPerMb = $this->getSecondsPerMb($sizeMb);
        $maxSeconds = max(
            self::STALE_CONVERSION_BASE_SECONDS,
            (int)round($sizeMb * $secondsPerMb * 6),
        );

        return (time() - $startedAt) > $maxSeconds;
    }

    private function clearStaleConversionLock(string $baseName, array $status): void {
        $this->logger->warning('Clearing stale IFC conversion lock', [
            'baseName' => $baseName,
            'startedAt' => $status['startedAt'] ?? null,
            'fileSize' => $status['fileSize'] ?? null,
        ]);
        $this->clearStatus($baseName);
    }

    private function isGlobalConversionSlotAvailable(?string $excludeBaseName = null): bool {
        foreach ($this->getCacheFolder()->getDirectoryListing() as $node) {
            $name = $node->getName();
            if (!str_ends_with($name, '.status.json')) {
                continue;
            }
            $baseName = substr($name, 0, -strlen('.status.json'));
            if ($excludeBaseName !== null && $baseName === $excludeBaseName) {
                continue;
            }
            $status = $this->readStatus($baseName);
            if (($status['state'] ?? '') === 'converting') {
                if ($this->isStaleConversionStatus($status)) {
                    $this->clearStaleConversionLock($baseName, $status);
                    continue;
                }
                return false;
            }
        }
        return true;
    }

    private function purgeStaleCachesForFile(File $file): void {
        $folder = $this->getCacheFolder();
        $currentPrefix = $file->getId() . '_' . md5($file->getEtag()) . '_';
        $filePrefix = $file->getId() . '_';

        foreach ($folder->getDirectoryListing() as $node) {
            $name = $node->getName();
            if (!str_starts_with($name, $filePrefix)) {
                continue;
            }
            if (str_starts_with($name, $currentPrefix)) {
                continue;
            }
            try {
                $node->delete();
            } catch (\Throwable $e) {
                $this->logger->warning('Failed to delete stale IFC cache file', [
                    'fileId' => $file->getId(),
                    'cacheName' => $name,
                    'exception' => $e,
                ]);
            }
        }
    }

    private function getCachedSize(File $file): int {
        try {
            return $this->getCacheFolder()->getFile($this->getCacheName($file))->getSize();
        } catch (NotFoundException) {
            return 0;
        }
    }

    /**
     * @deprecated Legacy monolithic metadata loader; kept only for migration tooling.
     * @return array<string, mixed>
     */
    private function loadExternalMetadata(File $file): array {
        $raw = $this->getCacheFolder()->getFile($this->getLegacyMetadataCacheName($file))->getContent();
        $decoded = gzdecode($raw);
        if ($decoded === false) {
            throw new RuntimeException('Failed to decompress metadata cache');
        }

        $metadata = json_decode($decoded, true);
        if (!is_array($metadata)) {
            throw new RuntimeException('Invalid metadata cache format');
        }

        return $metadata;
    }

    /**
     * @param array<string, mixed> $status
     */
    private function estimateSeconds(File $file, array $status): int {
        $sizeMb = ((int)($status['fileSize'] ?? $file->getSize())) / (1024 * 1024);
        return max(self::MIN_ESTIMATE_SECONDS, (int)round($sizeMb * $this->getSecondsPerMb($sizeMb)));
    }

    /**
     * @param array<string, mixed> $status
     */
    private function estimateProgress(File $file, array $status): int {
        $startedAt = (int)($status['startedAt'] ?? time());
        $elapsed = max(0, time() - $startedAt);
        $estimated = $this->estimateSeconds($file, $status);
        $linear = (int)round($elapsed / $estimated * 90);

        if ($elapsed <= $estimated) {
            return min(90, max(5, $linear));
        }

        // After estimate: creep slowly toward 99% (+1% per 2 min), never 100 until ready.
        $overMinutes = (int)floor(($elapsed - $estimated) / 120);
        return min(99, 90 + $overMinutes);
    }

    private function getSecondsPerMb(float $sizeMb): float {
        if ($sizeMb > 300) {
            return 5.0;
        }
        if ($sizeMb > 100) {
            return 2.0;
        }
        if ($sizeMb > 50) {
            return 1.0;
        }
        return 0.15;
    }

    private function getCacheFolder(): ISimpleFolder {
        try {
            return $this->appData->getFolder('xkt');
        } catch (NotFoundException) {
            return $this->appData->newFolder('xkt');
        }
    }

    /**
     * @return array<string, mixed>|null
     */
    private function readStatus(string $baseName): ?array {
        try {
            $folder = $this->getCacheFolder();
            $file = $folder->getFile($baseName . '.status.json');
            $raw = $file->getContent();
            $decoded = json_decode($raw, true);
            return is_array($decoded) ? $decoded : null;
        } catch (NotFoundException) {
            return null;
        } catch (\Throwable $e) {
            $this->logger->warning('Failed to read IFC conversion status', [
                'baseName' => $baseName,
                'exception' => $e,
            ]);
            return null;
        }
    }

    /**
     * @param array<string, int|string|null> $extra
     */
    private function writeStatus(string $baseName, string $state, array $extra = []): void {
        if (isset($extra['message']) && is_string($extra['message'])) {
            $extra['message'] = $this->truncateStatusMessage($extra['message']);
        }
        $payload = array_merge(['state' => $state], $extra);
        $folder = $this->getCacheFolder();
        $name = $baseName . '.status.json';
        $json = json_encode($payload, JSON_THROW_ON_ERROR);

        try {
            if ($folder->fileExists($name)) {
                $folder->getFile($name)->putContent($json);
                return;
            }
            $folder->newFile($name, $json);
        } catch (\Throwable $e) {
            $this->logger->warning('Failed to write conversion status', ['exception' => $e]);
        }
    }

    private function clearStatus(string $baseName): void {
        try {
            $folder = $this->getCacheFolder();
            $name = $baseName . '.status.json';
            if ($folder->fileExists($name)) {
                $folder->getFile($name)->delete();
            }
        } catch (\Throwable) {
            // ignore
        }
    }

    private function copyFileToPath(File $file, string $path): void {
        $read = $file->fopen('r');
        if ($read === false) {
            throw new RuntimeException('Failed to read IFC file');
        }

        $write = fopen($path, 'wb');
        if ($write === false) {
            fclose($read);
            throw new RuntimeException('Failed to write temporary IFC file');
        }

		stream_copy_to_stream($read, $write);
		if (is_resource($read)) {
			fclose($read);
		}
		if (is_resource($write)) {
			fclose($write);
		}
    }
}
