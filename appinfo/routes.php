<?php

declare(strict_types=1);

return [
    'routes' => [
        ['name' => 'viewer#index', 'url' => '/{fileId}', 'verb' => 'GET', 'requirements' => ['fileId' => '\d+']],
        ['name' => 'viewer#publicPage', 'url' => '/s/{token}', 'verb' => 'GET'],
        ['name' => 'api#file', 'url' => '/api/file/{fileId}', 'verb' => 'GET', 'requirements' => ['fileId' => '\d+']],
        ['name' => 'api#publicFile', 'url' => '/api/s/{token}/file', 'verb' => 'GET'],
        ['name' => 'bimApi#projects', 'url' => '/api/bim/{fileId}/projects', 'verb' => 'GET', 'requirements' => ['fileId' => '\d+']],
        ['name' => 'bimApi#project', 'url' => '/api/bim/{fileId}/project', 'verb' => 'GET', 'requirements' => ['fileId' => '\d+']],
        ['name' => 'bimApi#status', 'url' => '/api/bim/{fileId}/status', 'verb' => 'GET', 'requirements' => ['fileId' => '\d+']],
        ['name' => 'bimApi#prepare', 'url' => '/api/bim/{fileId}/prepare', 'verb' => 'POST', 'requirements' => ['fileId' => '\d+']],
        ['name' => 'bimApi#geometry', 'url' => '/api/bim/{fileId}/geometry', 'verb' => 'GET', 'requirements' => ['fileId' => '\d+']],
        ['name' => 'bimApi#propertiesQuery', 'url' => '/api/bim/{fileId}/properties', 'verb' => 'GET', 'requirements' => ['fileId' => '\d+']],
        ['name' => 'bimApi#properties', 'url' => '/api/bim/{fileId}/properties/{objectId}', 'verb' => 'GET', 'requirements' => ['fileId' => '\d+']],
        ['name' => 'bimApi#publicProjects', 'url' => '/api/bim/s/{token}/projects', 'verb' => 'GET'],
        ['name' => 'bimApi#publicProject', 'url' => '/api/bim/s/{token}/project', 'verb' => 'GET'],
        ['name' => 'bimApi#publicStatus', 'url' => '/api/bim/s/{token}/status', 'verb' => 'GET'],
        ['name' => 'bimApi#publicPrepare', 'url' => '/api/bim/s/{token}/prepare', 'verb' => 'POST'],
        ['name' => 'bimApi#publicGeometry', 'url' => '/api/bim/s/{token}/geometry', 'verb' => 'GET'],
        ['name' => 'bimApi#publicPropertiesQuery', 'url' => '/api/bim/s/{token}/properties', 'verb' => 'GET'],
        ['name' => 'bimApi#publicProperties', 'url' => '/api/bim/s/{token}/properties/{objectId}', 'verb' => 'GET'],
    ],
];
