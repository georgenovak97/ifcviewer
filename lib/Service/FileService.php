<?php

declare(strict_types=1);

namespace OCA\Ifcviewer\Service;

use OCP\Constants;
use OCP\Files\File;
use OCP\Files\IRootFolder;
use OCP\Files\NotFoundException;
use OCP\Share\IManager as ShareManager;
use OCP\Share\IShare;

class FileService {
    private const IFC_MIMES = [
        'model/ifc',
        'application/ifc',
        'application/x-ifc',
    ];

    public function __construct(
        private IRootFolder $rootFolder,
        private ShareManager $shareManager,
    ) {
    }

    public static function isIfcMime(?string $mime): bool {
        if ($mime === null) {
            return false;
        }
        $mime = strtolower($mime);
        if (in_array($mime, self::IFC_MIMES, true)) {
            return true;
        }
        return str_contains($mime, 'ifc');
    }

    public function getUserFile(string $userId, int $fileId): File {
        $userFolder = $this->rootFolder->getUserFolder($userId);
        $nodes = $userFolder->getById($fileId);
        if ($nodes === []) {
            throw new NotFoundException('File not found');
        }
        $node = $nodes[0];
        if (!$node instanceof File) {
            throw new NotFoundException('Not a file');
        }
        if (!self::isIfcMime($node->getMimeType())) {
            throw new NotFoundException('Not an IFC file');
        }
        return $node;
    }

    /**
     * @return array{0: File, 1: IShare}
     */
    public function getShareFile(string $token): array {
        $share = $this->shareManager->getShareByToken($token);
        if ($share->getPassword() !== null) {
            throw new NotFoundException('Password-protected shares are not supported');
        }
        $node = $share->getNode();
        if (!$node instanceof File) {
            throw new NotFoundException('Share is not a single file');
        }
        if (!self::isIfcMime($node->getMimeType())) {
            throw new NotFoundException('Not an IFC file');
        }
        if (($share->getPermissions() & Constants::PERMISSION_READ) === 0) {
            throw new NotFoundException('No read permission');
        }
        return [$node, $share];
    }
}
