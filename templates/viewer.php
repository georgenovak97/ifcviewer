<?php
/** @var array $_ */
$standalone = !empty($_['standalone']);
if ($standalone) {
    $nonce = \OC::$server->getContentSecurityPolicyNonceManager()->getNonce();
    $pageTitle = $_['pageTitle'] ?? $_['fileName'] ?? 'IFC Viewer';
}
?>
<?php if ($standalone): ?>
<!DOCTYPE html>
<html lang="<?php p(str_replace('_', '-', \OC::$server->getL10N('core')->getLanguageCode())); ?>">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
    <meta name="robots" content="noindex,nofollow">
    <title><?php p($pageTitle); ?></title>
    <link rel="icon" href="<?php p(\OCA\Ifcviewer\ViewerAssets::getFaviconUrl()); ?>">
    <link rel="apple-touch-icon" href="<?php p(\OCA\Ifcviewer\ViewerAssets::getTouchIconUrl()); ?>">
    <link rel="stylesheet" href="<?php p(\OCA\Ifcviewer\ViewerAssets::getStyleUrl('fontawesome')); ?>">
    <link rel="stylesheet" href="<?php p(\OCA\Ifcviewer\ViewerAssets::getStyleUrl('xeokit-bim-viewer')); ?>">
    <link rel="stylesheet" href="<?php p(\OCA\Ifcviewer\ViewerAssets::getStyleUrl('viewer')); ?>">
</head>
<body class="ifcviewer-standalone">
<?php endif; ?>
<div id="ifcviewer-shell">
<div id="ifcviewer-app"
     class="ifcviewer-bim"
     tabindex="0"
     data-bim-api="<?php p($_['bimApiBase']); ?>"
     data-file-id="<?php p((string)$_['fileId']); ?>"
     data-share-token="<?php p($_['shareToken'] ?? ''); ?>"
     data-file-name="<?php p($_['fileName']); ?>"
     data-is-public="<?php p($_['isPublic'] ? '1' : '0'); ?>"
     data-external-metadata="<?php p(!empty($_['externalMetadata']) ? '1' : '0'); ?>"
     data-viewer-init="<?php p(\OCA\Ifcviewer\ViewerAssets::getViewerInitUrl()); ?>">

    <input type="checkbox" id="explorer_toggle" />
    <label for="explorer_toggle"
           class="xeokit-i18n explorer_toggle_label xeokit-btn fas fa-2x fa-sitemap"
           data-xeokit-i18ntip="toolbar.toggleExplorer"
           title="Toggle explorer"></label>

    <input type="checkbox" id="inspector_toggle" />
    <label id="inspector_toggle_label" for="inspector_toggle"
           class="xeokit-i18n inspector_toggle_label xeokit-btn fas fa-info-circle fa-2x"
           data-xeokit-i18ntip="toolbar.toggleProperties"
           title="Toggle properties"></label>

    <div id="ifcviewer-status" class="hidden"></div>
    <div id="myExplorer"></div>
    <div id="myInspector"></div>
    <div id="myViewer">
        <canvas id="myCanvas"></canvas>
        <canvas id="myNavCubeCanvas"></canvas>
        <div id="myToolbar"></div>
    </div>
</div>
</div>
<?php if ($standalone): ?>
<script type="module" nonce="<?php p($nonce); ?>" src="<?php p(\OCA\Ifcviewer\ViewerAssets::getViewerBootUrl()); ?>"></script>
</body>
</html>
<?php endif; ?>
