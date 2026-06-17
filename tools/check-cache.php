<?php
require '/var/www/nextcloud/lib/base.php';

$user = \OC::$server->getUserManager()->get('admin');
\OC::$server->getUserSession()->setUser($user);
$folder = \OC::$server->getUserFolder('admin');
$nodes = $folder->getById(33015);
$file = $nodes[0];

$name = $file->getId() . '_' . md5($file->getEtag()) . '_fast2.xkt';
echo 'file=' . $file->getName() . PHP_EOL;
echo 'cache=' . $name . PHP_EOL;

$appData = \OC::$server->getAppDataFolder('ifcviewer');
$xkt = $appData->getFolder('xkt');
echo 'exists=' . ($xkt->fileExists($name) ? 'yes' : 'no') . PHP_EOL;
if ($xkt->fileExists($name)) {
    $cached = $xkt->getFile($name);
    echo 'size=' . $cached->getSize() . PHP_EOL;
}
