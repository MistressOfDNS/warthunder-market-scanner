# Gaijin Market Price Watch

Small userscript for watching Gaijin market sell, buy, and auction pages for items that drop below their observed usual price.

## How It Works

- The script scans the current market view on an interval, and also reacts to market search requests made by the page.
- Each item gets local price history stored in browser `localStorage` under `gaijin-market-price-watch:v2`.
- Prices are stored as raw Gaijin price integers. Displayed GJN values are calculated as `rawPrice / 100000000`.
- The usual price baseline is the median of the saved price samples.
- The displayed average price is the arithmetic average of the saved price samples.

## Deal Detection

An item can alert when all of these are true:

- It has enough history samples, or its price is high enough to use the sample bypass.
- Its current price is at or above `Min price GJN`.
- Its current price is below the median baseline by at least `Alert if below %`.
- It is not hidden by the trophy filter.
- Its notification cooldown has expired.

## Panel Fields

- `Alert if below %`: Required discount below the median baseline.
- `Min samples`: Normal number of saved samples required before alerting.
- `Bypass samples GJN`: Items at or above this price can alert with fewer samples.
- `Min price GJN`: Ignores deals below this current price.
- `Hide trophies`: Hides trophy items and skips alerts for them.
- `Refresh sec`: Automatic scan interval.

## Alerts And Button

The panel shows the last deal that actually triggered a fresh alert. The `Open deal` button opens that same displayed deal in a new tab.

If a scan finds no new alert, the last displayed deal stays visible until another fresh alert replaces it or history is reset.

## Storage

The script keeps up to 40 samples per item. If browser storage fills up, it compacts saved history to fewer samples and retries saving so scans can continue.
