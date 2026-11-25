<?php
// Copy this file to config.php and fill in the MySQL details from cPanel → MySQL Databases.
return [
    'db_host' => 'localhost',
    'db_name' => 'cpaneluser_budget',
    'db_user' => 'cpaneluser_budget',
    'db_pass' => 'change-me',
    'timezone' => 'Africa/Johannesburg',
    'currency' => 'R',
    // Optional: read nutrition labels from photos with Claude (about a cent per label).
    // Create a key at console.anthropic.com and paste it here. Leave empty to keep it off.
    'anthropic_key' => '',
];
