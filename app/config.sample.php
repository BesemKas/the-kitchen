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
    // Optional: add South African products people scan to Open Food Facts (each person opts in).
    // Make one account for the app at openfoodfacts.org and put its username (not email) and password here.
    // Try it on the test server first: 'off_base' => 'https://world.openfoodfacts.net', 'off_basic_auth' => 'off:off'
    // (the test server has its own accounts, so sign up there too).
    'off_user' => '',
    'off_password' => '',
    'off_contact' => 'you@example.com',   // sent in the User-Agent, as Open Food Facts asks
];
