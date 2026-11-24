# Kitchen Budget

A small web app for two people to share a shopping list, compare prices between shops, scan barcodes, cost recipes, plan meals for the week and keep groceries inside a monthly budget.

Plain PHP 8.2 + MySQL, no framework, no build step, no Composer.

## Install on cPanel (about 10 minutes)

1. **Create the database.** cPanel → *MySQL® Databases*:
   - Create a database, e.g. `kitchen`, which cPanel names `cpaneluser_kitchen`.
   - Create a user with a strong password.
   - Add the user to the database with **All Privileges**.
2. **Upload the files.** cPanel → *File Manager*. Upload the zip to where the app should live and extract it there. Either:
   - a subdomain, e.g. `kitchen.yourdomain.co.za` (cleanest), or
   - a folder, e.g. `public_html/kitchen`.
3. **Configure.** In `app/`, copy `config.sample.php` to `config.php` and fill in the database name, user and password from step 1.
4. **HTTPS.** Make sure the domain or subdomain has a certificate (cPanel → *SSL/TLS Status* → Run AutoSSL). **The camera, and with it barcode scanning, only works over HTTPS.** The included `.htaccess` redirects HTTP to HTTPS.
5. **PHP version.** cPanel → *MultiPHP Manager*: set PHP 8.2 for that domain. It needs the `pdo_mysql`, `curl` and `mbstring` extensions, which are on by default on almost every host.
6. **Run setup.** Open `https://your-site/setup.php`. Create both logins, set the monthly grocery budget and list your shops (e.g. `Checkers, Shoprite, Pick n Pay`).
7. **Delete `setup.php`** from the server.
8. **Add it to your phones.**
   - iPhone: open it in Safari → Share → *Add to Home Screen*.
   - Android: Chrome → ⋮ → *Install app*.

## How it works

- **Products** are the base of everything. Each has a pack size and unit (e.g. 2000 g, 1 kg, 18 each), an optional barcode and a price **per pack, per shop**. Every time either of you enters a price it is saved to the price history, so the app learns current prices.
- **Scanning.** Tap 📷 on the List or Products tab.
  - A barcode it already knows: you update the price at the shop you're in and add it to the list.
  - A new barcode: it checks Open Food Facts for the name, pack size and nutrition, then asks you to confirm and add a price. Open Food Facts coverage of South African products is patchy, so expect to type some products in yourself.
  - If the camera doesn't work, type the barcode in.
- **List.** Pick the shop you're in at the top. Prices shown are for that shop. If an item has no price there, it shows the price from another shop with an orange tag, and a green tag tells you when another shop is cheaper.
  - *Compare shops* totals the whole list per shop.
  - Tap a price to change it. That teaches the product its price at the current shop.
  - Tick items as they go into the trolley, then **Finish shop**: enter the till-slip total and it is logged against the month's budget.
- **Recipes.** Ingredients are products plus an amount in the product's unit (e.g. 800 g chicken, 0.5 kg rice, 3 eggs). The app works out cost per recipe and per serving using the cheapest known prices, plus nutrition per serving where products have it.
- **Plan.** Tap a day in the strip to see and edit its meals. The *Prep for this week* card adds up everything the week's recipes need, so you know what to cook on prep day.
- Add recipes to days and meals with a number of servings. The week shows total cost against your weekly share of the budget.
  - **Shop for this week** replaces the plan items on the list with the packs the week needs, rounded up to whole packs.
  - **Repeat next week** copies the plan forward.
- **Budget.** Monthly budget, spent, what's left and a per-day / per-week allowance. You can also log spend that didn't come from the list (e.g. a bread-and-milk run).

## Nutrition

Stored per 100 g / 100 ml, or per item for products with unit `each`. Fill it in from Open Food Facts using the button in the product editor (needs a barcode), or type it from the label. Products without nutrition are flagged on recipes rather than counted as zero.

## Updating

Replace all files **except** `app/config.php`. Your data lives in MySQL, so nothing else needs to be kept.

## Files

```
index.php            login + app shell
api.php              JSON API (all actions are POST with a CSRF header)
setup.php            one-time installer. Delete after use
app/bootstrap.php    DB, sessions, remember-me, helpers
app/schema.sql       tables
app/config.php       your DB details (not in the zip)
assets/app.js        the whole front end (vanilla JS)
assets/app.css       styles ("Night kitchen" dark theme)
assets/fonts/        Inter + Space Grotesk (SIL OFL), self-hosted
assets/zxing-browser.min.js   barcode scanner library (MIT), served locally
```

## Security notes

- Passwords are hashed with `password_hash`.
- Sessions use secure, HTTP-only cookies.
- "Keep me logged in" uses a 60-day hashed token, revoked on log out or password change.
- Every API call needs the session's CSRF token.
- All SQL uses prepared statements.
- `app/` is blocked from the web by its own `.htaccess`.
- A strict Content-Security-Policy blocks inline scripts.
